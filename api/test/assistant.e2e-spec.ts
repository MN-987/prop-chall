import { EntityManager } from '@mikro-orm/postgresql';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { MockLanguageModelV3 } from 'ai/test';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { ASSISTANT_LANGUAGE_MODEL, AssistantService } from '../src/assistant/assistant.service';
import { stableId } from '../src/db/stable-id';
import { AssistantRun, Lead, Message, Property, Task } from '../src/entities';

/**
 * The assistant's endpoints against the test database, with a scripted stand-in model: no API key, no cost, and the
 * same answer every time. What the real model does is covered by the eval suite.
 */

type Step = Awaited<ReturnType<MockLanguageModelV3['doGenerate']>>;
const usage = {
  inputTokens: { total: 1000, noCache: 1000, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 200, text: 200, reasoning: 0 },
};
let callId = 0;
const toolCall = (toolName: string, input: unknown): Step => ({
  content: [{ type: 'tool-call', toolCallId: `call-${++callId}`, toolName, input: JSON.stringify(input) }],
  finishReason: { unified: 'tool-calls', raw: 'tool_use' },
  usage,
  warnings: [],
});
const finalAnswer = (answer: unknown): Step => ({
  content: [{ type: 'text', text: JSON.stringify(answer) }],
  finishReason: { unified: 'stop', raw: 'end_turn' },
  usage,
  warnings: [],
});

/** What the next run's model calls return, in order. An Error is thrown instead. */
let script: Array<Step | Error> = [];
const model = new MockLanguageModelV3({
  doGenerate: async () => {
    const next = script.shift();
    if (!next) throw new Error('The test script has no more model responses.');
    if (next instanceof Error) throw next;
    return next;
  },
});

const KARIM = stableId('lead', 'karim');

function karimAnswer(propertyIds: string[]) {
  return {
    requirements: {
      locations: ['Dubai Marina'],
      bedrooms: 2,
      budgetAed: { min: null, max: 2_200_000 },
      propertyType: 'apartment',
      intent: 'buy',
      preferences: ['good rental yield'],
    },
    mentionedListingCodes: [],
    recommendations: propertyIds.map((propertyId) => ({ propertyId, reason: 'Fits the brief.' })),
    summary: 'Karim wants a 2-bed in Dubai Marina around AED 2M with a good yield.',
    followUp: {
      title: 'Call Karim about Marina 2-beds',
      notes: null,
      timing: { kind: 'tomorrow', days: null, weekday: null, date: null, time: null },
      unclearReason: null,
    },
  };
}

describe('AI assistant endpoints (against the test database, stand-in model)', () => {
  let app: INestApplication<App>;
  let em: EntityManager;
  let idOf: (reference: string) => Promise<string>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ASSISTANT_LANGUAGE_MODEL)
      .useValue(model)
      .compile();
    app = moduleRef.createNestApplication();
    await app.listen(0, '127.0.0.1');
    em = app.get(EntityManager).fork();
    idOf = async (reference) => (await em.findOneOrFail(Property, { reference })).id;
  });

  afterAll(async () => {
    await app.close();
  });

  const http = () => request(app.getHttpServer());
  async function auth(email: string) {
    const response = await http().post('/auth/login').send({ email, password: 'challenge123' }).expect(200);
    return { Authorization: `Bearer ${response.body.accessToken}` };
  }
  const countTasks = () => em.fork().count(Task, { lead: KARIM });

  async function startKarimRun(headers: Record<string, string>) {
    script = [
      toolCall('search_listings', { area: 'Dubai Marina', minBedrooms: 2, maxBedrooms: 2, maxPriceAed: 2_200_000 }),
      finalAnswer(karimAnswer([await idOf('MBR-1001')])),
    ];
    const response = await http().post(`/leads/${KARIM}/assistant/runs`).set(headers).send({}).expect(201);
    return response.body;
  }

  it('runs the assistant, keeps only listings code can vouch for, and saves no task', async () => {
    const sara = await auth('sara@marinabay.test');
    const tasksBefore = await countTasks();
    script = [
      toolCall('search_listings', { area: 'Dubai Marina', minBedrooms: 2, maxBedrooms: 2, maxPriceAed: 2_200_000 }),
      // MBR-1005 is sold (never returned by the search), MBR-1023 has a typo price, the third id is made up.
      finalAnswer(
        karimAnswer([await idOf('MBR-1005'), await idOf('MBR-1001'), await idOf('MBR-1023'), '00000000-0000-4000-8000-000000000001']),
      ),
    ];

    const { body: run } = await http().post(`/leads/${KARIM}/assistant/runs`).set(sara).send({}).expect(201);

    expect(run.status).toBe('completed');
    expect(run.trigger).toBe('manual');
    expect(run.messageIds).toEqual([run.messageId]);
    expect(run.recommendations.map((r: { reference: string }) => r.reference)).toEqual(['MBR-1001']);
    expect(run.trace).toHaveLength(1);
    expect(run.trace[0]).toMatchObject({ tool: 'search_listings', input: { area: 'Dubai Marina' } });
    expect(run.trace[0].output.listings.map((l: { reference: string }) => l.reference)).not.toContain('MBR-1005');
    const [followUp] = run.proposedActions;
    expect(followUp).toMatchObject({ type: 'create_follow_up_task', status: 'pending_approval', needsClarification: null });
    expect(followUp.task.dueAt).toMatch(/T10:00:00\+04:00$/);
    expect(await countTasks()).toBe(tasksBefore);

    const { body: listed } = await http().get(`/leads/${KARIM}/assistant/runs`).set(sara).expect(200);
    expect(listed[0].id).toBe(run.id);
    await http().get(`/leads/${KARIM}/assistant/runs/${run.id}`).set(sara).expect(200);
  });

  it('approving twice (even at the same moment) creates one task; rejecting it afterwards is a 409', async () => {
    const sara = await auth('sara@marinabay.test');
    const run = await startKarimRun(sara);
    const url = `/leads/${KARIM}/assistant/runs/${run.id}/actions/${run.proposedActions[0].id}`;
    const tasksBefore = await countTasks();

    const [first, second] = await Promise.all([http().post(`${url}/approve`).set(sara), http().post(`${url}/approve`).set(sara)]);
    const third = await http().post(`${url}/approve`).set(sara).expect(200);

    expect([first.status, second.status]).toEqual([200, 200]);
    expect(new Set([first.body.task.id, second.body.task.id, third.body.task.id]).size).toBe(1);
    expect(first.body.warnings).toEqual([]);
    expect(first.body.action.status).toBe('approved');
    expect(await countTasks()).toBe(tasksBefore + 1);
    const { body: tasks } = await http().get(`/leads/${KARIM}/tasks`).set(sara).expect(200);
    expect(tasks.map((t: { id: string }) => t.id)).toContain(first.body.task.id);

    await http().post(`${url}/reject`).set(sara).expect(409);
  });

  it('rejecting saves nothing, twice is fine, and approving afterwards is a 409', async () => {
    const sara = await auth('sara@marinabay.test');
    const run = await startKarimRun(sara);
    const url = `/leads/${KARIM}/assistant/runs/${run.id}/actions/${run.proposedActions[0].id}`;
    const tasksBefore = await countTasks();

    await http().post(`${url}/reject`).set(sara).expect(200);
    const again = await http().post(`${url}/reject`).set(sara).expect(200);
    expect(again.body.action.status).toBe('rejected');
    await http().post(`${url}/approve`).set(sara).expect(409);
    expect(await countTasks()).toBe(tasksBefore);
  });

  it('reports a model failure as a failed run, with every result field empty', async () => {
    const sara = await auth('sara@marinabay.test');
    script = [new Error('model overloaded')];

    const { body: run } = await http().post(`/leads/${KARIM}/assistant/runs`).set(sara).send({}).expect(201);

    expect(run.status).toBe('failed');
    expect(run.error).toContain('model overloaded');
    expect(run).toMatchObject({
      recommendations: [],
      priceChecks: [],
      proposedActions: [],
      requirements: {
        locations: [],
        bedrooms: null,
        budgetAed: { min: null, max: null },
        propertyType: null,
        intent: 'unknown',
        preferences: [],
      },
    });
  });

  it('refuses a second run while one is running (409)', async () => {
    const sara = await auth('sara@marinabay.test');
    const fork = em.fork();
    const lead = await fork.findOneOrFail(Lead, KARIM, { populate: ['agency'] });
    const message = await fork.findOneOrFail(Message, { lead, direction: 'inbound' });
    const running = fork.create(AssistantRun, {
      agency: lead.agency,
      lead,
      message,
      messageIds: [message.id],
      trigger: 'whatsapp',
      status: 'running',
      requirements: {},
      recommendations: [],
      model: 'test',
    });
    await fork.flush();
    try {
      await http().post(`/leads/${KARIM}/assistant/runs`).set(sara).send({}).expect(409);
    } finally {
      running.status = 'failed';
      await fork.flush();
    }
  });

  it('with ?async=true answers 202 at once, then the run finishes in the background with its trace', async () => {
    const sara = await auth('sara@marinabay.test');
    script = [
      toolCall('search_listings', { area: 'Dubai Marina', minBedrooms: 2, maxBedrooms: 2 }),
      finalAnswer(karimAnswer([await idOf('MBR-1001')])),
    ];

    const { body: started } = await http().post(`/leads/${KARIM}/assistant/runs?async=true`).set(sara).send({}).expect(202);
    expect(started.status).toBe('running');
    // While it runs, a second start is refused.
    await http().post(`/leads/${KARIM}/assistant/runs`).set(sara).send({}).expect(409);

    let run = started;
    for (let i = 0; i < 50 && run.status === 'running'; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      run = (await http().get(`/leads/${KARIM}/assistant/runs/${started.id}`).set(sara).expect(200)).body;
    }
    expect(run.status).toBe('completed');
    expect(run.trace.map((t: { tool: string }) => t.tool)).toEqual(['search_listings']);
    expect(run.recommendations.map((r: { reference: string }) => r.reference)).toEqual(['MBR-1001']);
  });

  it('at startup, ends runs a restart left running as failed, with the reason', async () => {
    const fork = em.fork();
    const lead = await fork.findOneOrFail(Lead, KARIM, { populate: ['agency'] });
    const message = await fork.findOneOrFail(Message, { lead, direction: 'inbound' });
    const orphan = fork.create(AssistantRun, {
      agency: lead.agency,
      lead,
      message,
      messageIds: [message.id],
      trigger: 'manual',
      status: 'running',
      requirements: {},
      recommendations: [],
      model: 'test',
    });
    await fork.flush();

    await app.get(AssistantService).onApplicationBootstrap();

    const after = await em.fork().findOneOrFail(AssistantRun, orphan.id);
    expect(after.status).toBe('failed');
    expect(after.error).toContain('restarted');
  });

  it("answers 404 for another agency's lead, run and action, and 422 for a lead that never wrote", async () => {
    const sara = await auth('sara@marinabay.test');
    const omar = await auth('omar@desertkey.test');
    const run = await startKarimRun(sara);
    const action = run.proposedActions[0].id;

    await http().post(`/leads/${KARIM}/assistant/runs`).set(omar).send({}).expect(404);
    await http().get(`/leads/${KARIM}/assistant/runs`).set(omar).expect(404);
    await http().get(`/leads/${KARIM}/assistant/runs/${run.id}`).set(omar).expect(404);
    await http().post(`/leads/${KARIM}/assistant/runs/${run.id}/actions/${action}/approve`).set(omar).expect(404);
    // Omar's own lead id in the URL does not unlock Sara's run either.
    const nadia = stableId('lead', 'nadia');
    await http().get(`/leads/${nadia}/assistant/runs/${run.id}`).set(omar).expect(404);

    await http()
      .post(`/leads/${KARIM}/assistant/runs`)
      .set(sara)
      .send({ messageId: '00000000-0000-4000-8000-000000000000' })
      .expect(404);
    const { body: silent } = await http().post('/leads').set(sara).send({ name: 'Silent lead', source: 'website' }).expect(201);
    await http().post(`/leads/${silent.id}/assistant/runs`).set(sara).send({}).expect(422);
  });
});
