import { Entity, Enum, Index, ManyToOne, OptionalProps, PrimaryKey, Property } from '@mikro-orm/core';
import { randomUUID } from 'node:crypto';
import { Agency } from './agency.entity';
import { Lead } from './lead.entity';
import { Message } from './message.entity';

export const ASSISTANT_RUN_TRIGGERS = ['manual', 'whatsapp'] as const;
export type AssistantRunTrigger = (typeof ASSISTANT_RUN_TRIGGERS)[number];

export const ASSISTANT_RUN_STATUSES = ['running', 'completed', 'failed'] as const;
export type AssistantRunStatus = (typeof ASSISTANT_RUN_STATUSES)[number];

/**
 * One analysis of a lead's messages by the AI assistant. A run only ever writes its own row and its proposed
 * actions; nothing else changes until the agent approves an action. A lead has at most one `running` run
 * (partial unique index in the migration).
 */
@Entity({ tableName: 'assistant_runs' })
@Index({ properties: ['lead', 'createdAt'] })
// Declared here (it is created in Migration20261126111145) so a generated migration never drops it.
@Index({
  name: 'assistant_runs_one_running_per_lead',
  expression: `create unique index "assistant_runs_one_running_per_lead" on "assistant_runs" ("lead_id") where "status" = 'running'`,
})
export class AssistantRun {
  [OptionalProps]?: 'createdAt' | 'error' | 'finishedAt' | 'summary' | 'priceChecks' | 'trace' | 'usage' | 'costUsd' | 'planner';

  @PrimaryKey({ type: 'uuid' })
  id: string = randomUUID();

  @ManyToOne({ entity: () => Agency })
  agency!: Agency;

  @ManyToOne({ entity: () => Lead })
  lead!: Lead;

  /** The message that was analysed: for a WhatsApp run, the burst's latest. */
  @ManyToOne({ entity: () => Message })
  message!: Message;

  /** Every message the run read as new. */
  @Property({ type: 'json' })
  messageIds!: string[];

  @Enum({ items: [...ASSISTANT_RUN_TRIGGERS] })
  trigger!: AssistantRunTrigger;

  @Enum({ items: [...ASSISTANT_RUN_STATUSES] })
  status!: AssistantRunStatus;

  @Property({ type: 'text', nullable: true })
  error?: string | null;

  /** What the lead wants, as the model understood it (TASK.md `requirements`). */
  @Property({ type: 'json' })
  requirements!: Record<string, unknown>;

  /** Ranked, already checked by code. */
  @Property({ type: 'json' })
  recommendations!: Array<Record<string, unknown>>;

  @Property({ type: 'text', default: '' })
  summary: string = '';

  @Property({ type: 'json', default: '[]' })
  priceChecks: Array<Record<string, unknown>> = [];

  /** Every tool call, in order. */
  @Property({ type: 'json', default: '[]' })
  trace: Array<Record<string, unknown>> = [];

  /** Token usage the model reported, for cost and debugging. */
  @Property({ type: 'json', nullable: true })
  usage?: Record<string, unknown> | null;

  @Property({ type: 'decimal', precision: 12, scale: 4, default: '0' })
  costUsd: string = '0';

  @Property({ type: 'string' })
  model!: string;

  /** Which strategy chose the tools ("claude" or "jev"), what it decided, and what it cost. */
  @Property({ type: 'json', nullable: true })
  planner?: Record<string, unknown> | null;

  @Property({ type: 'datetime', columnType: 'timestamptz' })
  createdAt: Date = new Date();

  @Property({ type: 'datetime', columnType: 'timestamptz', nullable: true })
  finishedAt?: Date | null;
}
