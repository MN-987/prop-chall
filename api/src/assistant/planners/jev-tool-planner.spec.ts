import type { Questions, SystemOneRequest } from '@typesafe-ai/sdk';
import type { ConversationMessage } from '../agent';
import type { TraceEntry } from '../tools';
import { JevClient, JevToolPlanner, listingCodesIn } from './jev-tool-planner';
import type { AgentTools } from './tool-planner';

const AREAS = ['Business Bay', 'Dubai Marina', 'Jumeirah Lake Towers'];

function message(body: string, direction: 'inbound' | 'outbound' = 'inbound', id = 'm1'): ConversationMessage {
  return { id, direction, body, sentAt: new Date('2026-11-26T10:00:00Z') };
}

/** A stand-in for TypeSafe: answers yes (0.9) to the listed question ids, no (0.1) to every other yes/no question. */
function fakeJev(yesTo: string[], type = 'not_stated') {
  const requests: SystemOneRequest<Questions>[] = [];
  const client: JevClient = {
    systemOne: async (request) => {
      requests.push(request);
      const answers = Object.fromEntries(
        Object.entries(request.questions).map(([id, q]) =>
          q.type === 'choice'
            ? [id, { type: 'choice', choice: type, confidence: 0.9, probabilities: { [type]: 0.9 } }]
            : [id, { type: 'noul', noul: yesTo.includes(id) ? 0.9 : 0.1 }],
        ),
      );
      return { model: 'jev-test', answers, usage: { input_tokens: 1000, output_tokens: 0 } } as never;
    },
  };
  return { client, requests };
}

/** Stand-in tools that record what they were asked and append to the trace, as the real traced tools do. */
function fakeTools() {
  const trace: TraceEntry[] = [];
  const calls: Array<{ tool: string; input: unknown }> = [];
  const make = (tool: string) => ({
    execute: async (input: unknown) => {
      calls.push({ tool, input });
      trace.push({ tool, input, output: { ok: true }, durationMs: 1 });
      return { ok: true };
    },
  });
  const tools = { search_listings: make('search_listings'), get_listing: make('get_listing') } as unknown as AgentTools;
  return { tools, trace, calls };
}

describe('JevToolPlanner', () => {
  it("turns Jev's answers into one filtered search per chosen area, and gives Claude no tools", async () => {
    const jev = fakeJev(['looking', 'area_1', 'bedrooms_stated', 'bedrooms_2'], 'apartment');
    const { tools, trace, calls } = fakeTools();

    const prepared = await new JevToolPlanner(jev.client).prepare({
      messages: [message('2-bed apartment in the Marina, around 2M please')],
      newMessageIds: ['m1'],
      areas: AREAS,
      tools,
      trace,
    });

    expect(calls).toEqual([
      { tool: 'search_listings', input: { area: 'Dubai Marina', type: 'apartment', minBedrooms: 2, maxBedrooms: 2 } },
    ]);
    expect(prepared.toolsForModel).toBeUndefined();
    expect(prepared.preloadedResults.map((r) => r.tool)).toEqual(['search_listings']);
    expect(prepared.record).toMatchObject({ name: 'jev', costUsd: 0.000042 });
    // One yes/no question per agency area: Jev can only pick among real areas.
    const ids = Object.keys(jev.requests[0].questions);
    expect(ids.filter((id) => id.startsWith('area_'))).toEqual(['area_0', 'area_1', 'area_2']);
  });

  it('runs nothing when the lead is not looking for a property (just "Hi")', async () => {
    const jev = fakeJev([]);
    const { tools, trace, calls } = fakeTools();
    const prepared = await new JevToolPlanner(jev.client).prepare({
      messages: [message('Hi')],
      newMessageIds: ['m1'],
      areas: AREAS,
      tools,
      trace,
    });
    expect(calls).toEqual([]);
    expect(prepared.preloadedResults).toEqual([]);
  });

  it('looks up a listing code the lead asks about, and searches without an area when none is chosen', async () => {
    const jev = fakeJev(['looking', 'code_0', 'bedrooms_stated', 'bedrooms_0', 'bedrooms_1']);
    const { tools, trace, calls } = fakeTools();
    await new JevToolPlanner(jev.client).prepare({
      messages: [message('Is mbr-1016 a fair price? Or any studio or 1-bed?')],
      newMessageIds: ['m1'],
      areas: AREAS,
      tools,
      trace,
    });
    expect(calls).toEqual([
      { tool: 'search_listings', input: { minBedrooms: 0, maxBedrooms: 1 } },
      { tool: 'get_listing', input: { listing: 'MBR-1016' } },
    ]);
  });

  it('only offers listing codes the lead wrote (not the agent), without repeats', () => {
    const codes = listingCodesIn({
      messages: [message('What about MBR-1013 and mbr-1013?'), message('MBR-1001 is also nice', 'outbound', 'm2')],
    });
    expect(codes).toEqual(['MBR-1013']);
  });
});
