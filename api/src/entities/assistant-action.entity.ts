import { Entity, Enum, Index, ManyToOne, OptionalProps, PrimaryKey, Property } from '@mikro-orm/core';
import { randomUUID } from 'node:crypto';
import { Agent } from './agent.entity';
import { AssistantRun } from './assistant-run.entity';
import { Task } from './task.entity';

export const ASSISTANT_ACTION_TYPES = ['create_follow_up_task', 'assign_lead'] as const;
export type AssistantActionType = (typeof ASSISTANT_ACTION_TYPES)[number];

export const ASSISTANT_ACTION_STATUSES = ['pending_approval', 'approved', 'rejected'] as const;
export type AssistantActionStatus = (typeof ASSISTANT_ACTION_STATUSES)[number];

/**
 * An action a run proposes. Its status changes on its own row, so approving is one conditional update
 * (`... WHERE status = 'pending_approval'`): two clicks at once still create one task.
 */
@Entity({ tableName: 'assistant_actions' })
@Index({ properties: ['run', 'position'] })
export class AssistantAction {
  [OptionalProps]?: 'status' | 'task' | 'decidedAt' | 'decidedBy' | 'createdAt';

  @PrimaryKey({ type: 'uuid' })
  id: string = randomUUID();

  @ManyToOne({ entity: () => AssistantRun })
  run!: AssistantRun;

  /** Order within the run. */
  @Property({ type: 'integer' })
  position!: number;

  @Enum({ items: [...ASSISTANT_ACTION_TYPES] })
  type!: AssistantActionType;

  @Enum({ items: [...ASSISTANT_ACTION_STATUSES] })
  status: AssistantActionStatus = 'pending_approval';

  /**
   * The proposal. Follow-up: `{ task: { title, notes, dueAt }, needsClarification, propertyIds }`.
   * Agent suggestion: `{ agent: { id, name }, reason }`.
   */
  @Property({ type: 'json' })
  payload!: Record<string, unknown>;

  /** The task created when a follow-up was approved. */
  @ManyToOne({ entity: () => Task, nullable: true })
  task?: Task | null;

  @ManyToOne({ entity: () => Agent, nullable: true })
  decidedBy?: Agent | null;

  @Property({ type: 'datetime', columnType: 'timestamptz', nullable: true })
  decidedAt?: Date | null;

  @Property({ type: 'datetime', columnType: 'timestamptz' })
  createdAt: Date = new Date();
}
