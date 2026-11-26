import { UniqueConstraintViolationException } from '@mikro-orm/core';
import { EntityManager } from '@mikro-orm/postgresql';
import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { LanguageModel } from 'ai';
import { AuthAgent } from '../auth/decorators';
import { Agency, Agent, AssistantAction, AssistantRun, AssistantRunTrigger, Lead, Message, Task } from '../entities';
import { LeadsService } from '../leads/leads.service';
import { PropertiesService } from '../properties/properties.service';
import { DEFAULT_MODEL, runAgent } from './agent';
import { EMPTY_REQUIREMENTS, StartRunDto, toActionDto, toRunDto, toTaskDto } from './assistant.dto';
import { resolveDueDate } from './due-date';
import { loadAgencyAreas } from './tools';

/** Nest injection token for the language model. Null means the real Anthropic model; tests pass a stand-in. */
export const ASSISTANT_LANGUAGE_MODEL = Symbol('ASSISTANT_LANGUAGE_MODEL');

const MAX_RUNS_LISTED = 50;

interface RunRequest {
  lead: Lead;
  /** The message analysed: the latest of `newMessages`. */
  message: Message;
  newMessages: Message[];
  trigger: AssistantRunTrigger;
  timeZone: string;
}

@Injectable()
export class AssistantService {
  constructor(
    private readonly em: EntityManager,
    private readonly leads: LeadsService,
    private readonly properties: PropertiesService,
    @Inject(ASSISTANT_LANGUAGE_MODEL) private readonly model: LanguageModel | null,
  ) {}

  /** Sara's button: analyse one message (by default the latest inbound one), and wait for the result. */
  async startManualRun(agent: AuthAgent, leadId: string, dto: StartRunDto) {
    const lead = await this.leads.findLead(agent.agencyId, leadId);
    const message = await this.pickMessage(lead, dto.messageId);
    const me = await this.em.findOneOrFail(Agent, { id: agent.id, agency: agent.agencyId });
    const run = await this.execute({ lead, message, newMessages: [message], trigger: 'manual', timeZone: me.timezone });
    return this.runDto(run);
  }

  async listRuns(agencyId: string, leadId: string) {
    const lead = await this.leads.findLead(agencyId, leadId);
    const runs = await this.em.find(
      AssistantRun,
      { lead, agency: agencyId },
      { orderBy: { createdAt: 'desc', id: 'desc' }, limit: MAX_RUNS_LISTED, populate: ['message'] },
    );
    const actions = runs.length
      ? await this.em.find(AssistantAction, { run: { $in: runs } }, { populate: ['task'] })
      : [];
    return runs.map((run) => toRunDto(run, actions.filter((a) => a.run.id === run.id)));
  }

  async getRun(agencyId: string, leadId: string, runId: string) {
    return this.runDto(await this.findRun(agencyId, leadId, runId));
  }

  async approve(agent: AuthAgent, leadId: string, runId: string, actionId: string) {
    const action = await this.findAction(agent.agencyId, leadId, runId, actionId);
    if (action.type !== 'create_follow_up_task') {
      throw new ConflictException('This kind of action cannot be approved yet.');
    }
    return this.approveFollowUp(agent, action);
  }

  async reject(agent: AuthAgent, leadId: string, runId: string, actionId: string) {
    const action = await this.findAction(agent.agencyId, leadId, runId, actionId);
    const changed = await this.em.nativeUpdate(
      AssistantAction,
      { id: action.id, status: 'pending_approval' },
      { status: 'rejected', decidedAt: new Date(), decidedBy: this.em.getReference(Agent, agent.id) },
    );
    const fresh = await this.em.findOneOrFail(AssistantAction, action.id, { refresh: true, populate: ['task'] });
    if (!changed && fresh.status === 'approved') throw new ConflictException('This action was already approved.');
    return { action: toActionDto(fresh) };
  }

  /**
   * One conditional update decides who approves: `... WHERE status = 'pending_approval'`. Only the request that
   * changes the row creates the task, in the same transaction. A repeat (or a request that lost the race) finds the
   * action approved and returns the task already created.
   */
  private async approveFollowUp(agent: AuthAgent, action: AssistantAction) {
    await this.em.transactional(async (tx) => {
      const changed = await tx.nativeUpdate(
        AssistantAction,
        { id: action.id, status: 'pending_approval' },
        { status: 'approved', decidedAt: new Date(), decidedBy: tx.getReference(Agent, agent.id) },
      );
      if (!changed) return;
      const payload = action.payload as { task: { title: string; notes: string | null; dueAt: string | null } };
      const task = tx.create(Task, {
        agency: tx.getReference(Agency, action.run.agency.id),
        lead: tx.getReference(Lead, action.run.lead.id),
        title: payload.task.title,
        notes: payload.task.notes,
        dueAt: payload.task.dueAt ? new Date(payload.task.dueAt) : null,
        status: 'open',
        createdBy: tx.getReference(Agent, agent.id),
      });
      await tx.flush();
      await tx.nativeUpdate(AssistantAction, { id: action.id }, { task: task.id });
    });
    const fresh = await this.em.findOneOrFail(AssistantAction, action.id, {
      refresh: true,
      populate: ['task', 'task.createdBy', 'task.lead'],
    });
    if (fresh.status === 'rejected') throw new ConflictException('This action was already rejected.');
    if (!fresh.task) throw new ConflictException('This action is approved but its task is missing.');
    return { action: toActionDto(fresh), task: toTaskDto(fresh.task), warnings: [] as string[] };
  }

  /** Runs the agent and records the result. A run that fails is saved as `failed`, never as "nothing found". */
  private async execute(request: RunRequest): Promise<AssistantRun> {
    const { lead, message } = request;
    const run = this.em.create(AssistantRun, {
      agency: lead.agency,
      lead,
      message,
      messageIds: request.newMessages.map((m) => m.id),
      trigger: request.trigger,
      status: 'running',
      requirements: EMPTY_REQUIREMENTS,
      recommendations: [],
      model: DEFAULT_MODEL,
    });
    try {
      await this.em.flush();
    } catch (error) {
      if (error instanceof UniqueConstraintViolationException) {
        this.em.clear();
        throw new ConflictException('A run is already in progress for this lead.');
      }
      throw error;
    }

    try {
      // Only what had been said by the analysed message: a run on an older message does not read later ones.
      const conversation = await this.em.find(
        Message,
        { lead, sentAt: { $lte: message.sentAt } },
        { orderBy: { sentAt: 'asc', id: 'asc' } },
      );
      const result = await runAgent({
        leadName: lead.name,
        messages: conversation,
        newMessageIds: request.newMessages.map((m) => m.id),
        timeZone: request.timeZone,
        model: this.model ?? undefined,
        tools: {
          agencyId: lead.agency.id,
          areas: await loadAgencyAreas(this.em, lead.agency.id),
          em: this.em,
          properties: this.properties,
        },
      });
      run.trace = result.trace as unknown as Array<Record<string, unknown>>;
      run.usage = (result.usage as unknown as Record<string, unknown>) ?? null;
      run.costUsd = result.costUsd.toFixed(4);
      run.finishedAt = new Date();
      if (!result.ok) {
        run.status = 'failed';
        run.error = result.error;
        await this.em.flush();
        return run;
      }

      const { answer } = result;
      const due = resolveDueDate(answer.followUp.timing, answer.followUp.unclearReason, message.sentAt, request.timeZone);
      run.requirements = answer.requirements;
      run.summary = answer.summary;
      run.recommendations = result.recommendations.map((rec) => ({ ...rec }));
      this.em.create(AssistantAction, {
        run,
        position: 0,
        type: 'create_follow_up_task',
        payload: {
          task: { title: answer.followUp.title, notes: answer.followUp.notes, dueAt: due.dueAt },
          needsClarification: due.needsClarification,
          propertyIds: result.recommendations.map((rec) => rec.propertyId),
        },
      });
      run.status = 'completed';
      await this.em.flush();
      return run;
    } catch (error) {
      run.status = 'failed';
      run.error = `The run failed: ${error instanceof Error ? error.message : String(error)}`;
      run.recommendations = [];
      run.requirements = EMPTY_REQUIREMENTS;
      run.finishedAt = new Date();
      await this.em.flush();
      return run;
    }
  }

  private async runDto(run: AssistantRun) {
    const actions = await this.em.find(AssistantAction, { run }, { populate: ['task'], orderBy: { position: 'asc' } });
    return toRunDto(run, actions);
  }

  /** The message to analyse: the given one (must be this lead's), or the latest inbound one. */
  private async pickMessage(lead: Lead, messageId?: string): Promise<Message> {
    if (messageId) {
      const message = await this.em.findOne(Message, { id: messageId, lead });
      if (!message) throw new NotFoundException('Message not found');
      return message;
    }
    const latest = await this.em.findOne(
      Message,
      { lead, direction: 'inbound' },
      { orderBy: { sentAt: 'desc', id: 'desc' } },
    );
    if (!latest) throw new UnprocessableEntityException('This lead has not sent a message yet.');
    return latest;
  }

  private async findRun(agencyId: string, leadId: string, runId: string): Promise<AssistantRun> {
    const run = await this.em.findOne(AssistantRun, { id: runId, lead: leadId, agency: agencyId }, { populate: ['message'] });
    if (!run) throw new NotFoundException('Run not found');
    return run;
  }

  private async findAction(agencyId: string, leadId: string, runId: string, actionId: string): Promise<AssistantAction> {
    const action = await this.em.findOne(
      AssistantAction,
      { id: actionId, run: { id: runId, lead: leadId, agency: agencyId } },
      { populate: ['run', 'run.lead', 'run.agency'] },
    );
    if (!action) throw new NotFoundException('Action not found');
    return action;
  }
}
