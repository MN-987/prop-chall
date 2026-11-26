'use client';

import { ReactNode, useCallback, useEffect, useState } from 'react';
import { api, ApiError, AssistantRun, LeadDetail, PriceCheck, ProposedAction, Recommendation, ToolPlannerName } from '@/lib/api';
import { formatAedShort, formatBedrooms, formatBudgetShort, formatDateTime, formatVerdict } from '@/lib/format';
import { buildSteps, Spinner, StepList } from './AssistantSteps';

interface Props {
  lead: LeadDetail;
  token: string;
  timeZone: string;
  /** Called after an action is approved, so the page can reload the tasks (and the lead). */
  onChanged: () => void;
  /** Called on a 401, so the page can sign the agent out. */
  onUnauthorized: () => void;
}

const POLL_MS = 1000;

/** Plain words for the errors starting a run can give. */
function runErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 409) return 'A run is already in progress for this lead.';
    if (err.status === 422) return 'This lead has not sent a message yet.';
    if (err.status === 429) return "Your agency's AI budget for this month is used up.";
  }
  return err instanceof Error ? err.message : 'Something went wrong';
}

function updateAction(run: AssistantRun, action: ProposedAction): AssistantRun {
  return { ...run, proposedActions: run.proposedActions.map((a) => (a.id === action.id ? action : a)) };
}

function runMeta(run: AssistantRun, timeZone: string): string {
  return `${run.trigger === 'whatsapp' ? 'Started by WhatsApp' : 'Started by hand'} · ${formatDateTime(
    run.createdAt,
    timeZone,
  )}`;
}

export function AssistantPanel({ lead, token, timeZone, onChanged, onUnauthorized }: Props) {
  const hasInbound = lead.messages.some((message) => message.direction === 'inbound');
  const firstName = lead.name.trim().split(/\s+/)[0] || 'the lead';
  const [run, setRun] = useState<AssistantRun | null>(null);
  const [loading, setLoading] = useState(true);
  const [analyzing, setAnalyzing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyActionId, setBusyActionId] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<Record<string, string[]>>({});
  // Who chooses the tools; remembered per browser (a convenience: the run itself records what was used).
  const [planner, setPlanner] = useState<ToolPlannerName>(() => {
    try {
      return window.localStorage.getItem(PLANNER_KEY) === 'jev' ? 'jev' : 'claude';
    } catch {
      return 'claude';
    }
  });
  function choosePlanner(next: ToolPlannerName) {
    setPlanner(next);
    try {
      window.localStorage.setItem(PLANNER_KEY, next);
    } catch {
      // Storage can be unavailable (private mode): the choice then lasts for this page only.
    }
  }
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

  /** Returns true when the error was a 401 and has been handed to the page. */
  const isUnauthorized = useCallback(
    (err: unknown) => {
      if (err instanceof ApiError && err.status === 401) {
        onUnauthorized();
        return true;
      }
      return false;
    },
    [onUnauthorized],
  );

  const loadLatest = useCallback(async () => {
    try {
      const runs = await api.listRuns(token, lead.id);
      setRun(runs[0] ?? null);
    } catch (err) {
      if (!isUnauthorized(err)) setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setLoading(false);
    }
  }, [token, lead.id, isUnauthorized]);

  useEffect(() => {
    setRun(null);
    setLoading(true);
    void loadLatest();
  }, [loadLatest]);

  // A running run (started here, or by WhatsApp) is checked every second until it ends, for its steps and result.
  const runningId = run?.status === 'running' ? run.id : null;
  useEffect(() => {
    if (!runningId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      timer = setTimeout(() => {
        api
          .getRun(token, lead.id, runningId)
          .then((next) => {
            if (cancelled) return;
            setRun(next);
            if (next.status === 'running') schedule();
          })
          .catch((err: unknown) => {
            if (cancelled || isUnauthorized(err)) return;
            setError(err instanceof Error ? err.message : 'Something went wrong');
            // The run goes on in the background: keep checking.
            schedule();
          });
      }, POLL_MS);
    };
    schedule();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [runningId, token, lead.id, isUnauthorized]);

  const running = analyzing || run?.status === 'running';

  // The seconds counter next to the header.
  useEffect(() => {
    if (!running) {
      setStartedAt(null);
      return;
    }
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);

  async function analyze() {
    setAnalyzing(true);
    setStartedAt(Date.now());
    setError(null);
    setWarnings({});
    try {
      // 202 with a running run (then polled), or 201 with a finished one.
      setRun(await api.startRun(token, lead.id, planner));
    } catch (err) {
      if (isUnauthorized(err)) return;
      setError(runErrorMessage(err));
      // A run in progress (from WhatsApp) is worth showing: it will be polled until it ends.
      if (err instanceof ApiError && err.status === 409) void loadLatest();
    } finally {
      setAnalyzing(false);
    }
  }

  async function decide(action: ProposedAction, decision: 'approve' | 'reject') {
    if (!run) return;
    setBusyActionId(action.id);
    setError(null);
    try {
      if (decision === 'approve') {
        const result = await api.approveAction(token, lead.id, run.id, action.id);
        setRun((current) => (current ? updateAction(current, result.action) : current));
        if ('warnings' in result) setWarnings((w) => ({ ...w, [action.id]: result.warnings }));
        onChanged();
      } else {
        const result = await api.rejectAction(token, lead.id, run.id, action.id);
        setRun((current) => (current ? updateAction(current, result.action) : current));
      }
    } catch (err) {
      if (isUnauthorized(err)) return;
      setError(err instanceof Error ? err.message : 'Something went wrong');
      // The action may have been decided elsewhere: show its real state.
      api
        .getRun(token, lead.id, run.id)
        .then(setRun)
        .catch(() => undefined);
    } finally {
      setBusyActionId(null);
    }
  }

  // While the start request is out, an older run on screen is not the one being worked on.
  const liveRun = analyzing ? null : run?.status === 'running' ? run : null;
  const startMs = startedAt ?? (liveRun ? Date.parse(liveRun.createdAt) : null);
  const elapsed = running && startMs !== null && !Number.isNaN(startMs) ? Math.max(0, Math.floor((now - startMs) / 1000)) : null;

  return (
    <section className="rounded-xl bg-gray-50 p-3 ring-1 ring-gray-200 sm:p-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-baseline gap-2">
          <h2 className="font-semibold">AI assistant</h2>
          {elapsed !== null && <span className="text-xs tabular-nums text-gray-500">{elapsed} s</span>}
        </div>
        <button
          type="button"
          onClick={analyze}
          disabled={!hasInbound || running}
          className="rounded-lg bg-gray-900 px-3 py-2 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-40"
          title={hasInbound ? undefined : 'This lead has not sent a message yet'}
        >
          {run ? 'Analyze again' : 'Analyze latest message'}
        </button>
      </div>
      <label className="mt-2 flex items-center justify-end gap-2 text-xs text-gray-500">
        Tools chosen by
        <select
          value={planner}
          onChange={(event) => choosePlanner(event.target.value as ToolPlannerName)}
          disabled={running}
          className="rounded-md border border-gray-300 bg-white px-2 py-1 text-xs text-gray-900"
        >
          <option value="claude">Claude</option>
          <option value="jev">Jev (TypeSafe)</option>
        </select>
      </label>

      <div className="mt-3 space-y-3">
        {error && (
          <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 ring-1 ring-red-200">{error}</p>
        )}
        {loading && <p className="text-sm text-gray-500">Loading…</p>}
        {!loading && !run && !analyzing && (
          <Card>
            <p className="text-sm text-gray-500">
              {hasInbound ? 'No analysis yet for this lead.' : 'This lead has not sent a message yet.'}
            </p>
          </Card>
        )}

        {running && (
          <Card>
            <div className="mb-3 flex items-center gap-2">
              <Spinner />
              <p className="text-sm font-semibold text-gray-900">Working on {firstName}&apos;s messages</p>
            </div>
            <StepList steps={buildSteps(liveRun?.trace ?? [], liveRun ? 'running' : 'starting')} />
            {liveRun && <p className="mt-3 text-xs text-gray-400">{runMeta(liveRun, timeZone)}</p>}
          </Card>
        )}

        {run && !running && (
          <RunView
            run={run}
            firstName={firstName}
            timeZone={timeZone}
            busyActionId={busyActionId}
            warnings={warnings}
            onDecide={decide}
          />
        )}
      </div>
    </section>
  );
}

function Card({ title, aside, children }: { title?: ReactNode; aside?: ReactNode; children: ReactNode }) {
  return (
    <div className="rounded-xl bg-white p-3.5 ring-1 ring-gray-200">
      {title && (
        <div className="mb-2 flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-gray-900">{title}</h3>
          {aside}
        </div>
      )}
      {children}
    </div>
  );
}

function SectionLabel({ children }: { children: ReactNode }) {
  return <h3 className="px-1 text-sm font-semibold text-gray-900">{children}</h3>;
}

function Pill({ tone, children }: { tone: 'green' | 'amber' | 'red' | 'gray' | 'outline'; children: ReactNode }) {
  const tones = {
    green: 'bg-green-50 text-green-700 ring-green-600/20',
    amber: 'bg-amber-50 text-amber-800 ring-amber-600/20',
    red: 'bg-red-50 text-red-700 ring-red-600/20',
    gray: 'bg-gray-100 text-gray-700 ring-gray-500/10',
    outline: 'bg-white text-gray-500 ring-gray-300',
  };
  return (
    <span className={`inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${tones[tone]}`}>
      {children}
    </span>
  );
}

function RunView({
  run,
  firstName,
  timeZone,
  busyActionId,
  warnings,
  onDecide,
}: {
  run: AssistantRun;
  firstName: string;
  timeZone: string;
  busyActionId: string | null;
  warnings: Record<string, string[]>;
  onDecide: (action: ProposedAction, decision: 'approve' | 'reject') => void;
}) {
  const meta = <p className="px-1 text-xs text-gray-400">{runMeta(run, timeZone)}</p>;

  if (run.status === 'failed') {
    return (
      <>
        {meta}
        <div className="rounded-xl bg-red-50 p-3.5 ring-1 ring-red-200">
          <p className="text-sm font-semibold text-red-800">The assistant failed</p>
          <p className="mt-1 break-words text-sm text-red-700">{run.error ?? 'Unknown error'}</p>
        </div>
        <HowItDecided run={run} />
      </>
    );
  }

  return (
    <>
      {meta}
      <Understood run={run} firstName={firstName} />

      <Card title="Summary">
        <p className="text-[15px] leading-relaxed text-gray-800">{run.summary}</p>
      </Card>

      <div className="space-y-2">
        <SectionLabel>Recommended listings</SectionLabel>
        {run.recommendations.length === 0 ? (
          <Card>
            <p className="text-sm font-medium text-gray-900">No listing fits</p>
            <p className="mt-0.5 text-xs text-gray-500">The summary above explains why.</p>
          </Card>
        ) : (
          <ol className="space-y-2">
            {run.recommendations.map((rec, index) => (
              <RecommendationCard key={rec.propertyId} rec={rec} rank={index + 1} />
            ))}
          </ol>
        )}
      </div>

      {run.priceChecks.length > 0 && (
        <Card title="Price checks">
          <ul className="divide-y divide-gray-100">
            {run.priceChecks.map((check) => (
              <PriceCheckRow key={check.propertyId} check={check} recommendations={run.recommendations} />
            ))}
          </ul>
        </Card>
      )}

      {run.proposedActions.length === 0 ? (
        <Card>
          <p className="text-sm text-gray-500">Nothing to approve.</p>
        </Card>
      ) : (
        run.proposedActions.map((action) => (
          <ActionCard
            key={action.id}
            action={action}
            timeZone={timeZone}
            busy={busyActionId === action.id}
            warnings={warnings[action.id] ?? []}
            onDecide={onDecide}
          />
        ))
      )}

      <HowItDecided run={run} />
    </>
  );
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function Understood({ run, firstName }: { run: AssistantRun; firstName: string }) {
  const r = run.requirements;
  const chips = [
    ...r.locations,
    formatBedrooms(r.bedrooms),
    formatBudgetShort(r.budgetAed),
    r.propertyType ? capitalize(r.propertyType) : null,
    r.intent === 'buy' ? 'To buy' : r.intent === 'rent' ? 'To rent' : null,
    ...r.preferences,
  ].filter((chip): chip is string => Boolean(chip));
  return (
    <Card title={`What ${firstName} wants`}>
      {chips.length === 0 ? (
        <p className="text-sm text-gray-500">Nothing specific yet</p>
      ) : (
        <ul className="flex flex-wrap gap-1.5">
          {chips.map((chip, index) => (
            <li key={`${chip}-${index}`} className="rounded-full bg-gray-100 px-2.5 py-1 text-xs font-medium text-gray-800">
              {chip}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function YieldPill({ pct }: { pct: number | null | undefined }) {
  if (pct === undefined) return null;
  if (pct === null) return <Pill tone="gray">Yield unknown</Pill>;
  const tone = pct >= 7 ? 'green' : pct >= 5 ? 'amber' : 'gray';
  return <Pill tone={tone}>{pct.toFixed(2)}% gross yield</Pill>;
}

function RecommendationCard({ rec, rank }: { rec: Recommendation; rank: number }) {
  const bedrooms = formatBedrooms(rec.bedrooms);
  return (
    <li className="rounded-xl bg-white p-3.5 ring-1 ring-gray-200">
      <div className="flex items-start gap-3">
        <span
          aria-label={`Rank ${rank}`}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-gray-900 text-xs font-semibold text-white"
        >
          {rank}
        </span>
        <div className="min-w-0 flex-1">
          <p className="break-words text-sm font-semibold text-gray-900">{rec.reference ?? rec.propertyId}</p>
          {rec.title && <p className="break-words text-sm text-gray-600">{rec.title}</p>}
          <div className="mt-2 flex flex-wrap items-center gap-x-2.5 gap-y-1.5 text-xs text-gray-600">
            {rec.priceAed !== undefined && (
              <span className="text-sm font-semibold text-gray-900">{formatAedShort(rec.priceAed)}</span>
            )}
            <YieldPill pct={rec.grossYieldPct} />
            {rec.area && <span>{rec.area}</span>}
            {bedrooms && <span>{bedrooms}</span>}
            {rec.status && rec.status !== 'available' && <Pill tone="red">Now {rec.status}</Pill>}
          </div>
          <p className="mt-2 text-xs leading-5 text-gray-500">{rec.reason}</p>
        </div>
      </div>
    </li>
  );
}

const VERDICT_TONE: Record<PriceCheck['verdict'], 'green' | 'gray' | 'red' | 'outline'> = {
  below_market: 'green',
  fair: 'gray',
  above_market: 'red',
  not_enough_data: 'outline',
};

const numberFormat = new Intl.NumberFormat('en-US');

function PriceCheckRow({ check, recommendations }: { check: PriceCheck; recommendations: Recommendation[] }) {
  const reference =
    check.reference ?? recommendations.find((rec) => rec.propertyId === check.propertyId)?.reference ?? check.propertyId;
  const median =
    check.medianAedPerSqft === null ? 'no median' : `median AED ${numberFormat.format(check.medianAedPerSqft)}/sqft`;
  return (
    <li className="py-2 first:pt-0 last:pb-0">
      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0 break-words text-sm font-medium text-gray-900">{reference}</span>
        <Pill tone={VERDICT_TONE[check.verdict]}>{formatVerdict(check.verdict)}</Pill>
      </div>
      <p className="mt-0.5 text-xs text-gray-500">
        AED {numberFormat.format(check.priceAedPerSqft)}/sqft vs {median}, {check.comparableSales} comparable{' '}
        {check.comparableSales === 1 ? 'sale' : 'sales'}
      </p>
    </li>
  );
}

const STATUS_LABEL: Record<ProposedAction['status'], string> = {
  pending_approval: 'Waiting for approval',
  approved: 'Approved',
  rejected: 'Rejected',
};

const STATUS_TONE: Record<ProposedAction['status'], 'amber' | 'green' | 'gray'> = {
  pending_approval: 'amber',
  approved: 'green',
  rejected: 'gray',
};

function CalendarGlyph() {
  return (
    <svg aria-hidden viewBox="0 0 16 16" className="h-3.5 w-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="2" y="3" width="12" height="11" rx="2" />
      <path d="M2 6.5h12M5.5 1.5v3M10.5 1.5v3" strokeLinecap="round" />
    </svg>
  );
}

function ActionCard({
  action,
  timeZone,
  busy,
  warnings,
  onDecide,
}: {
  action: ProposedAction;
  timeZone: string;
  busy: boolean;
  warnings: string[];
  onDecide: (action: ProposedAction, decision: 'approve' | 'reject') => void;
}) {
  return (
    <Card
      title={action.type === 'create_follow_up_task' ? 'Follow-up' : 'Suggested assignment'}
      aside={<Pill tone={STATUS_TONE[action.status]}>{STATUS_LABEL[action.status]}</Pill>}
    >
      {action.type === 'create_follow_up_task' ? (
        <>
          <p className="break-words text-sm font-semibold text-gray-900">{action.task.title}</p>
          <p className="mt-1 flex items-center gap-1.5 text-sm text-gray-700">
            <CalendarGlyph />
            {action.task.dueAt ? `Due ${formatDateTime(action.task.dueAt, timeZone)}` : 'No due date'}
          </p>
          {action.needsClarification && (
            <p className="mt-2 rounded-lg bg-amber-50 px-2.5 py-2 text-xs text-amber-800 ring-1 ring-amber-200">
              Date unclear: {action.needsClarification}
            </p>
          )}
          {action.task.notes && <p className="mt-2 text-sm leading-relaxed text-gray-600">{action.task.notes}</p>}
        </>
      ) : (
        <>
          <p className="text-sm font-semibold text-gray-900">Assign to {action.agent.name}</p>
          <p className="mt-1 text-sm leading-relaxed text-gray-600">{action.reason}</p>
        </>
      )}
      {warnings.map((warning) => (
        <p key={warning} className="mt-2 text-xs text-amber-700">
          {warning}
        </p>
      ))}
      {action.status === 'pending_approval' && (
        <div className="mt-3 flex gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => onDecide(action, 'approve')}
            className="flex-1 rounded-lg bg-green-600 px-3 py-2 text-sm font-semibold text-white hover:bg-green-700 disabled:opacity-40"
          >
            Approve
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => onDecide(action, 'reject')}
            className="flex-1 rounded-lg bg-white px-3 py-2 text-sm font-semibold text-gray-700 ring-1 ring-gray-300 hover:bg-gray-50 disabled:opacity-40"
          >
            Reject
          </button>
        </div>
      )}
    </Card>
  );
}

const PLANNER_KEY = 'assistant.toolPlanner';

function formatCost(usd: number): string {
  return `USD ${usd < 0.01 ? usd.toFixed(3) : usd.toFixed(2)}`;
}

function HowItDecided({ run }: { run: AssistantRun }) {
  const steps = buildSteps(run.trace, 'done', run.status === 'completed');
  const plannerLabel = run.toolPlanner?.name === 'jev' ? 'tools chosen by Jev' : run.toolPlanner ? 'tools chosen by Claude' : null;
  const usage = [run.model, plannerLabel, run.costUsd !== undefined ? formatCost(run.costUsd) : null].filter(Boolean).join(', ');
  return (
    <details className="group rounded-xl bg-white ring-1 ring-gray-200">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-3.5 py-3 text-sm font-semibold text-gray-900 [&::-webkit-details-marker]:hidden">
        How it decided
        <span className="flex items-center gap-1 text-xs font-normal text-gray-500">
          {steps.length} steps
          <svg aria-hidden viewBox="0 0 12 12" className="h-3 w-3 transition-transform group-open:rotate-180" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M3 4.5l3 3 3-3" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
      </summary>
      <div className="border-t border-gray-100 px-3.5 py-3">
        <StepList steps={steps} />
        {usage && <p className="mt-3 text-xs text-gray-400">{usage}</p>}
      </div>
    </details>
  );
}
