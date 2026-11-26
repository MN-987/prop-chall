import { choice, noul, type Questions, type SystemOneRequest, type SystemOneResult } from '@typesafe-ai/sdk';
import { PROPERTY_TYPES, PropertyType } from '../../entities';
import { PlanningInput, PreparedTools, ToolPlanner } from './tool-planner';

/** The part of TypeSafe's client the planner uses, so tests can pass a stand-in. */
export interface JevClient {
  systemOne(request: SystemOneRequest<Questions>): PromiseLike<SystemOneResult<Questions>>;
}

/** Jev 1.14: USD 0.042 per million input tokens; output tokens are free (TypeSafe models page, November 2026). */
const JEV_USD_PER_INPUT_TOKEN = 0.042 / 1_000_000;
const YES = 0.5;
const MAX_BEDROOMS_ASKED = 5;
const LISTING_CODE = /\b[A-Z]{2,6}-\d{3,8}\b/gi;
const NEWEST_WINS = 'When the lead changed their mind in a later message, the later message wins.';

type SearchInput = { area?: string; type?: PropertyType; minBedrooms?: number; maxBedrooms?: number };

/**
 * Jev chooses the tool calls; code runs them. One `systemOne` request asks independent questions over the
 * conversation: is the lead looking for a property, which of the agency's areas (one yes/no per area), how many
 * bedrooms (one yes/no per size), which type, and which listing codes in the text they ask about. Jev only picks
 * among values code gives it, so it cannot invent an area or a filter. Numbers (the budget) are not asked: Jev is
 * not built for numeric extraction, so the search has no price filter and Claude plus the code check apply the
 * budget afterwards.
 */
export class JevToolPlanner implements ToolPlanner {
  readonly name = 'jev' as const;

  constructor(private readonly client: JevClient) {}

  async prepare(input: PlanningInput): Promise<PreparedTools> {
    const codes = listingCodesIn(input);
    const newIds = new Set(input.newMessageIds);
    const state = {
      conversation: input.messages.map((m) => ({
        from: m.direction === 'inbound' ? 'lead' : 'agent',
        sent: m.sentAt.toISOString(),
        newest: newIds.has(m.id),
        text: m.body,
      })),
    };

    const questions: Questions = {
      looking: noul(
        `Is the lead looking for a property: do they describe what they want, such as an area, a size, a budget or a type? ${NEWEST_WINS}`,
      ),
      bedrooms_stated: noul(`Does the lead say how many bedrooms they want (a studio counts)? ${NEWEST_WINS}`),
      type: choice(`What type of property does the lead want? ${NEWEST_WINS}`, {
        apartment: 'An apartment or a flat',
        villa: 'A villa',
        townhouse: 'A townhouse',
        penthouse: 'A penthouse',
        not_stated: 'The lead does not say',
      }),
    };
    input.areas.forEach((area, i) => {
      questions[`area_${i}`] = noul(
        `Does the lead want a property in ${area}? Count other names for it, abbreviations and other languages. ${NEWEST_WINS}`,
      );
    });
    for (let n = 0; n <= MAX_BEDROOMS_ASKED; n++) {
      questions[`bedrooms_${n}`] = noul(
        `Would the lead consider a ${n === 0 ? 'studio' : `${n}-bedroom`} property, by what they wrote? ${NEWEST_WINS}`,
      );
    }
    codes.forEach((code, i) => {
      questions[`code_${i}`] = noul(`Does the lead ask about, or want to know about, the listing with code ${code}?`);
    });

    const result = await this.client.systemOne({ state, questions });
    const answers = result.answers as Record<string, { noul?: number; choice?: string; probabilities?: Record<string, number> }>;
    const yes = (id: string) => (answers[id]?.noul ?? 0) > YES;

    const searches: SearchInput[] = [];
    if (yes('looking')) {
      const filters: Omit<SearchInput, 'area'> = {};
      const type = answers.type?.choice;
      if (type && (PROPERTY_TYPES as readonly string[]).includes(type)) filters.type = type as PropertyType;
      if (yes('bedrooms_stated')) {
        const sizes = Array.from({ length: MAX_BEDROOMS_ASKED + 1 }, (_, n) => n).filter((n) => yes(`bedrooms_${n}`));
        if (sizes.length) {
          filters.minBedrooms = Math.min(...sizes);
          filters.maxBedrooms = Math.max(...sizes) === MAX_BEDROOMS_ASKED ? 20 : Math.max(...sizes);
        }
      }
      const areas = input.areas.filter((_, i) => yes(`area_${i}`));
      if (areas.length === 0) searches.push(filters);
      for (const area of areas) searches.push({ area, ...filters });
    }
    const lookups = codes.filter((_, i) => yes(`code_${i}`));

    // Run the chosen calls through the same traced tools Claude would use: same validation, scoping and trace.
    const before = input.trace.length;
    for (const search of searches) await execute(input.tools.search_listings, search);
    for (const listing of lookups) await execute(input.tools.get_listing, { listing });

    return {
      toolsForModel: undefined,
      preloadedResults: input.trace.slice(before),
      record: {
        name: this.name,
        decisions: Object.fromEntries(
          Object.entries(answers).map(([id, a]) => [id, a.noul ?? a.probabilities ?? a.choice ?? null]),
        ),
        costUsd: Math.round((result.usage.input_tokens ?? 0) * JEV_USD_PER_INPUT_TOKEN * 1_000_000) / 1_000_000,
      },
    };
  }
}

/** Listing codes written by the lead, like MBR-1016, uppercased and without repeats. */
export function listingCodesIn(input: Pick<PlanningInput, 'messages'>): string[] {
  const codes = new Set<string>();
  for (const m of input.messages) {
    if (m.direction !== 'inbound') continue;
    for (const match of m.body.matchAll(LISTING_CODE)) codes.add(match[0].toUpperCase());
  }
  return [...codes];
}

type Executable = { execute?: (input: never, options: never) => unknown };

async function execute(tool: Executable, args: object): Promise<void> {
  if (!tool.execute) throw new Error('Tool has no execute function');
  await (tool.execute as (input: object, options: object) => Promise<unknown>)(args, {
    toolCallId: `jev-${Math.random().toString(36).slice(2, 10)}`,
    messages: [],
  });
}
