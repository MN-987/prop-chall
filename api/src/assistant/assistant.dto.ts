import { IsOptional, IsUUID } from 'class-validator';
import { toTaskDto } from '../common/dto';
import type { AssistantAction, AssistantRun } from '../entities';

export class StartRunDto {
  /** Default: the lead's latest inbound message. */
  @IsOptional()
  @IsUUID()
  messageId?: string;
}

/** What a run reports when it understood nothing (failed runs, TASK.md). */
export const EMPTY_REQUIREMENTS = {
  locations: [] as string[],
  bedrooms: null,
  budgetAed: { min: null, max: null },
  propertyType: null,
  intent: 'unknown' as const,
  preferences: [] as string[],
};

export function toActionDto(action: AssistantAction) {
  const payload = action.payload as Record<string, any>;
  const base = { id: action.id, type: action.type, status: action.status };
  if (action.type === 'create_follow_up_task') {
    return {
      ...base,
      task: { title: payload.task.title, notes: payload.task.notes ?? null, dueAt: payload.task.dueAt ?? null },
      needsClarification: payload.needsClarification ?? null,
      taskId: action.task?.id ?? null,
    };
  }
  return { ...base, agent: payload.agent, reason: payload.reason };
}
export type ActionDto = ReturnType<typeof toActionDto>;

/** The AssistantRun shape of TASK.md's API contract, plus `costUsd`, `model` and `finishedAt`. */
export function toRunDto(run: AssistantRun, actions: AssistantAction[]) {
  return {
    id: run.id,
    leadId: run.lead.id,
    messageId: run.message.id,
    messageIds: run.messageIds,
    trigger: run.trigger,
    status: run.status,
    ...(run.error ? { error: run.error } : {}),
    requirements: run.status === 'completed' ? run.requirements : EMPTY_REQUIREMENTS,
    recommendations: run.recommendations,
    summary: run.summary,
    priceChecks: run.priceChecks,
    proposedActions: [...actions].sort((a, b) => a.position - b.position).map(toActionDto),
    trace: run.trace,
    costUsd: Number(run.costUsd),
    model: run.model,
    createdAt: run.createdAt.toISOString(),
    finishedAt: run.finishedAt ? run.finishedAt.toISOString() : null,
  };
}
export type RunDto = ReturnType<typeof toRunDto>;

export { toTaskDto };
