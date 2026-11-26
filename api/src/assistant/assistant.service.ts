import { UniqueConstraintViolationException } from '@mikro-orm/core';
import { EntityManager } from '@mikro-orm/postgresql';
import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnApplicationBootstrap,
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
}

@Injectable()
export class AssistantService implements OnApplicationBootstrap {
  private readonly logger = new Logger(AssistantService.name);

  constructor(
    private readonly em: EntityManager,
    private readonly leads: LeadsService,
    private readonly properties: PropertiesService,
    @Inject(ASSISTANT_LANGUAGE_MODEL) private readonly model: LanguageModel | null,
  ) {}

  /**
   * At startup, a run still marked `running` was cut off by a restart or a crash: nothing will finish it, so it ends
   * `failed` with the reason. (One API instance; with several, this would need a lease per run, as qm's reaper has.)
   */
  async onApplicationBootstrap() {
    const ended = await this.em.fork().nativeUpdate(
      AssistantRun,
      { status: 'running' },
      { status: 'failed', error: 'The API restarted before this run finished.', finishedAt: new Date() },
    );
    if (ended) this.logger.warn(`Marked ${ended} interrupted assistant run(s) as failed.`);
  }

  /**
   * Sara's button: analyse one message (by default the latest inbound one). By default it waits for the result;
   * with `background` it answers as soon as the run exists, and the run's trace fills in as the agent works.
   */
  async startManualRun(agent: AuthAgent, leadId: string, dto: StartRunDto, background = false) {
    const lead = await this.leads.findLead(agent.agencyId, leadId);
    const message = await this.pickMessage(lead, dto.messageId);
    const me = await this.em.findOneOrFail(Agent, { id: agent.id, agency: agent.agencyId });
    const run = await this.createRun({ lead, message, newMessages: [message], trigger: 'manual' });
    if (background) {
      void this.completeRun(run.id, me.timezone).catch((error) => this.logger.error(`Run ${run.id} crashed`, error));
      return this.runDto(run);
    }
    await this.completeRun(run.id, me.timezone);
    return this.runDto(await this.em.findOneOrFail(AssistantRun, run.id, { refresh: true, populate: ['message'] }));
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

  /** Inserts the run as `running`. The partial unique index turns a second running run for the lead into a 409. */
  private async createRun(request: RunRequest): Promise<AssistantRun> {
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
    return run;
  }

  /**
   * Runs the agent for a `running` run and records the result, in its own entity manager so it can outlive the
   * request. A run that fails is saved as `failed`, never as "nothing found".
   */
  private async completeRun(runId: string, timeZone: string): Promise<void> {
    const em = this.em.fork();
    const run = await em.findOneOrFail(AssistantRun, runId, { populate: ['lead', 'agency', 'message'] });
    const { lead, message } = run;
    try {
      // Only what had been said by the analysed message: a run on an older message does not read later ones.
      const conversation = await em.find(
        Message,
        { lead, sentAt: { $lte: message.sentAt } },
        { orderBy: { sentAt: 'asc', id: 'asc' } },
      );
      const result = await runAgent({
        leadName: lead.name,
        messages: conversation,
        newMessageIds: run.messageIds,
        timeZone,
        model: this.model ?? undefined,
        // Saved after every tool call, so GET shows the steps so far while the run works.
        onTrace: async (trace) => {
          await em.fork().nativeUpdate(AssistantRun, { id: runId }, { trace: trace as unknown as Array<Record<string, unknown>> });
        },
        tools: {
          agencyId: run.agency.id,
          areas: await loadAgencyAreas(em, run.agency.id),
          em,
          properties: new PropertiesService(em),
        },
      });
      run.trace = result.trace as unknown as Array<Record<string, unknown>>;
      run.usage = (result.usage as unknown as Record<string, unknown>) ?? null;
      run.costUsd = result.costUsd.toFixed(4);
      run.finishedAt = new Date();
      if (!result.ok) {
        run.status = 'failed';
        run.error = result.error;
        await em.flush();
        return;
      }

      const { answer } = result;
      const due = resolveDueDate(answer.followUp.timing, answer.followUp.unclearReason, message.sentAt, timeZone);
      run.requirements = answer.requirements;
      run.summary = answer.summary;
      run.recommendations = result.recommendations.map((rec) => ({ ...rec }));
      em.create(AssistantAction, {
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
      await em.flush();
      return;
    } catch (error) {
      run.status = 'failed';
      run.error = `The run failed: ${error instanceof Error ? error.message : String(error)}`;
      run.recommendations = [];
      run.requirements = EMPTY_REQUIREMENTS;
      run.finishedAt = new Date();
      await em.flush();
      return;
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
