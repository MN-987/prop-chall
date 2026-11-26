import { anthropic } from '@ai-sdk/anthropic';
import { EntityManager } from '@mikro-orm/postgresql';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { LanguageModelMiddleware, wrapLanguageModel } from 'ai';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { costOf, DEFAULT_MODEL } from '../src/assistant/agent';
import { ASSISTANT_LANGUAGE_MODEL } from '../src/assistant/assistant.service';
import { stableId } from '../src/db/stable-id';
import { Lead, Message, Property, Task } from '../src/entities';

/**
 * The eval harness: the real API in-process, on the test database, with the REAL model. Only one thing is added: a
 * recorder around the model that logs every call (step, model, what it did, tokens, cost, time) for the cost report.
 */

export const TIME_ZONE = 'Asia/Dubai';
export const MARINA_BAY = stableId('agency', 'marina-bay');
export const DESERT_KEY = stableId('agency', 'desert-key');
export const leadId = (key: string) => stableId('lead', key);

/* ---------- Model-call recorder ---------- */

export interface ModelCall {
  caseName: string;
  step: number;
  model: string;
  did: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  durationMs: number;
  error?: string;
}

export const modelCalls: ModelCall[] = [];
let currentCase = '(none)';
const stepsByCase = new Map<string, number>();
export function setCurrentCase(name: string) {
  currentCase = name;
}

const recorder: LanguageModelMiddleware = {
  specificationVersion: 'v3',
  wrapGenerate: async ({ doGenerate, model }) => {
    const caseName = currentCase;
    const step = (stepsByCase.get(caseName) ?? 0) + 1;
    stepsByCase.set(caseName, step);
    const started = Date.now();
    try {
      const result = await doGenerate();
      const tools = result.content.filter((part) => part.type === 'tool-call').map((part) => part.toolName);
      const input = result.usage.inputTokens;
      const output = result.usage.outputTokens;
      const usage = {
        inputTokens: input.total ?? 0,
        outputTokens: output.total ?? 0,
        totalTokens: (input.total ?? 0) + (output.total ?? 0),
        inputTokenDetails: {
          noCacheTokens: input.noCache ?? undefined,
          cacheReadTokens: input.cacheRead ?? undefined,
          cacheWriteTokens: input.cacheWrite ?? undefined,
        },
        outputTokenDetails: { textTokens: output.text ?? undefined, reasoningTokens: output.reasoning ?? undefined },
      };
      modelCalls.push({
        caseName,
        step,
        model: model.modelId,
        did: tools.length ? `called ${tools.join(', ')}` : 'final answer',
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        costUsd: costOf(usage as never, model.modelId),
        durationMs: Date.now() - started,
      });
      return result;
    } catch (error) {
      modelCalls.push({
        caseName,
        step,
        model: model.modelId,
        did: 'error',
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        durationMs: Date.now() - started,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  },
};

/* ---------- App, HTTP, data ---------- */

export type Headers = Record<string, string>;
// The run as the API returns it. Loosely typed on purpose: the contract check below verifies the shape.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type RunBody = any;

export class Harness {
  app!: INestApplication<App>;
  em!: EntityManager;

  async start() {
    const model = wrapLanguageModel({ model: anthropic(DEFAULT_MODEL), middleware: recorder });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ASSISTANT_LANGUAGE_MODEL)
      .useValue(model)
      .compile();
    this.app = moduleRef.createNestApplication();
    await this.app.listen(0, '127.0.0.1');
    this.em = this.app.get(EntityManager).fork();
  }

  async stop() {
    await this.app?.close();
  }

  http() {
    return request(this.app.getHttpServer());
  }

  fresh() {
    return this.em.fork();
  }

  async login(email: string): Promise<Headers> {
    const response = await this.http().post('/auth/login').send({ email, password: 'challenge123' }).expect(200);
    return { Authorization: `Bearer ${response.body.accessToken}` };
  }

  /** The assistant button. Returns the HTTP status and the body. */
  async startRun(headers: Headers, lead: string, body: Record<string, unknown> = {}) {
    const response = await this.http().post(`/leads/${lead}/assistant/runs`).set(headers).send(body);
    return { status: response.status, body: response.body as RunBody };
  }

  /** A new lead (assigned to whoever creates it) with one inbound email message. Returns the lead id. */
  async createLead(headers: Headers, name: string, text: string, sentAt?: string): Promise<string> {
    const lead = await this.http().post('/leads').set(headers).send({ name, source: 'website' }).expect(201);
    await this.http()
      .post(`/leads/${lead.body.id}/messages`)
      .set(headers)
      .send({ direction: 'inbound', channel: 'email', body: text, ...(sentAt ? { sentAt } : {}) })
      .expect(201);
    return lead.body.id;
  }

  async messageSentAt(messageId: string): Promise<Date> {
    return (await this.fresh().findOneOrFail(Message, messageId)).sentAt;
  }

  async property(id: string) {
    return this.fresh().findOne(Property, id, { populate: ['agency'] });
  }

  async propertyByCode(reference: string, agencyId = MARINA_BAY) {
    return this.fresh().findOneOrFail(Property, { reference, agency: agencyId });
  }

  /** Everything a run must not change: the lead's tasks, the lead row, its messages, and the agency's listings. */
  async snapshot(lead: string, agencyId = MARINA_BAY) {
    const em = this.fresh();
    const leadRow = await em.findOneOrFail(Lead, lead, { populate: ['assignedAgent'] });
    const tasks = await em.find(Task, { lead }, { orderBy: { id: 'asc' } });
    const messages = await em.count(Message, { lead });
    const properties = await em.find(Property, { agency: agencyId }, { orderBy: { reference: 'asc' } });
    return {
      lead: { name: leadRow.name, status: leadRow.status, notes: leadRow.notes, agent: leadRow.assignedAgent?.id ?? null },
      tasks: tasks.map((t) => ({ id: t.id, title: t.title, status: t.status })),
      messages,
      properties: properties.map((p) => `${p.reference}:${p.status}:${p.priceAed}`),
    };
  }

  async countTasks(lead: string) {
    return this.fresh().count(Task, { lead });
  }
}

/* ---------- Checks ---------- */

export interface CheckLine {
  ok: boolean;
  text: string;
}

/** Collects every check with a plain reason, instead of stopping at the first failure. */
export class Checks {
  lines: CheckLine[] = [];

  that(ok: boolean, text: string): boolean {
    this.lines.push({ ok: Boolean(ok), text });
    return Boolean(ok);
  }

  equal(actual: unknown, expected: unknown, label: string): boolean {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    return this.that(ok, ok ? `${label} is ${JSON.stringify(expected)}` : `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }

  get failures(): string[] {
    return this.lines.filter((l) => !l.ok).map((l) => l.text);
  }
}

const OFFSET_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?([+-]\d{2}:\d{2}|Z)$/;
const EMPTY_REQUIREMENTS = {
  locations: [],
  bedrooms: null,
  budgetAed: { min: null, max: null },
  propertyType: null,
  intent: 'unknown',
  preferences: [],
};

/** TASK.md's AssistantRun shape, on every run. A failed run must have every result field empty. */
export function contractCheck(c: Checks, run: RunBody, lead: string) {
  const problems: string[] = [];
  const need = (ok: boolean, what: string) => {
    if (!ok) problems.push(what);
  };
  need(typeof run?.id === 'string', 'id');
  need(run?.leadId === lead, 'leadId');
  need(typeof run?.messageId === 'string', 'messageId');
  need(Array.isArray(run?.messageIds) && run.messageIds.includes(run.messageId), 'messageIds includes messageId');
  need(['manual', 'whatsapp'].includes(run?.trigger), 'trigger');
  need(['running', 'completed', 'failed'].includes(run?.status), 'status');
  const r = run?.requirements ?? {};
  need(Array.isArray(r.locations) && Array.isArray(r.preferences), 'requirements.locations/preferences');
  need(r.bedrooms === null || Number.isInteger(r.bedrooms), 'requirements.bedrooms');
  need(r.budgetAed && 'min' in r.budgetAed && 'max' in r.budgetAed, 'requirements.budgetAed');
  need([null, 'apartment', 'villa', 'townhouse', 'penthouse'].includes(r.propertyType), 'requirements.propertyType');
  need(['buy', 'rent', 'unknown'].includes(r.intent), 'requirements.intent');
  need(
    Array.isArray(run?.recommendations) &&
      run.recommendations.every((x: RunBody) => typeof x.propertyId === 'string' && typeof x.reason === 'string'),
    'recommendations[].propertyId/reason',
  );
  need(typeof run?.summary === 'string', 'summary is a string');
  need(Array.isArray(run?.priceChecks), 'priceChecks');
  need(Array.isArray(run?.proposedActions), 'proposedActions');
  for (const action of run?.proposedActions ?? []) {
    need(typeof action.id === 'string' && ['pending_approval', 'approved', 'rejected'].includes(action.status), 'action id/status');
    if (action.type === 'create_follow_up_task') {
      need(typeof action.task?.title === 'string', 'follow-up task.title');
      need(action.task?.dueAt === null || OFFSET_ISO.test(action.task?.dueAt), 'follow-up dueAt is null or ISO with offset');
      need('needsClarification' in action, 'follow-up needsClarification');
    }
  }
  need(
    Array.isArray(run?.trace) &&
      run.trace.every((t: RunBody) => typeof t.tool === 'string' && typeof t.durationMs === 'number' && ('output' in t || 'error' in t)),
    'trace[] tool/durationMs/output-or-error',
  );
  need(!Number.isNaN(Date.parse(run?.createdAt)), 'createdAt');
  if (run?.status === 'failed') {
    need(typeof run.error === 'string' && run.error.length > 0, 'failed run has an error');
    need(run.recommendations?.length === 0 && run.priceChecks?.length === 0 && run.proposedActions?.length === 0, 'failed run has empty results');
    need(JSON.stringify(run.requirements) === JSON.stringify(EMPTY_REQUIREMENTS), 'failed run has empty requirements');
  }
  c.that(problems.length === 0, problems.length ? `API contract: wrong or missing ${problems.join(', ')}` : 'API contract shape matches TASK.md');
}

export interface FitRules {
  areas?: string[];
  bedrooms?: number[];
  maxPriceAed?: number;
  type?: string;
  agencyId?: string;
}

/** Loads every recommended listing from the database and checks it is real, the agency's, available and fits. */
export async function checkFits(h: Harness, c: Checks, run: RunBody, rules: FitRules) {
  const agencyId = rules.agencyId ?? MARINA_BAY;
  const bad: string[] = [];
  for (const rec of run.recommendations ?? []) {
    const p = await h.property(rec.propertyId);
    if (!p) {
      bad.push(`${rec.propertyId} does not exist`);
      continue;
    }
    const why: string[] = [];
    if (p.agency.id !== agencyId) why.push('other agency');
    if (p.status !== 'available') why.push(`status ${p.status}`);
    if (rules.areas && !rules.areas.includes(p.area)) why.push(`area ${p.area}`);
    if (rules.bedrooms && !rules.bedrooms.includes(p.bedrooms)) why.push(`${p.bedrooms} beds`);
    if (rules.maxPriceAed !== undefined && p.priceAed > rules.maxPriceAed) why.push(`price ${p.priceAed}`);
    if (rules.type && p.type !== rules.type) why.push(`type ${p.type}`);
    if (why.length) bad.push(`${p.reference} (${why.join(', ')})`);
  }
  c.that(bad.length === 0, bad.length ? `recommended listings that do not fit: ${bad.join('; ')}` : 'every recommended listing exists, is the agency\'s, available and fits');
}

export async function references(h: Harness, run: RunBody): Promise<string[]> {
  const refs: string[] = [];
  for (const rec of run.recommendations ?? []) refs.push((await h.property(rec.propertyId))?.reference ?? rec.propertyId);
  return refs;
}

/* ---------- Dates, worked out independently of the product code ---------- */

/** YYYY-MM-DD of an instant in the agent's timezone. */
export function localDay(instant: Date, timeZone = TIME_ZONE): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(instant);
}

export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** 0 = Sunday ... 6 = Saturday. */
export function weekday(day: string): number {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export const followUpOf = (run: RunBody) =>
  (run?.proposedActions ?? []).find((a: RunBody) => a.type === 'create_follow_up_task');
