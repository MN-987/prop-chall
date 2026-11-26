'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, AssistantRun, LeadDetail, PriceCheck, ProposedAction, Recommendation } from '@/lib/api';
import { formatAed, formatBedrooms, formatBudget, formatDateTime, formatVerdict } from '@/lib/format';

interface Props {
  lead: LeadDetail;
  token: string;
  timeZone: string;
  /** Called after an action is approved, so the page can reload the tasks (and the lead). */
  onChanged: () => void;
  /** Called on a 401, so the page can sign the agent out. */
  onUnauthorized: () => void;
}

const POLL_MS = 2000;

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

export function AssistantPanel({ lead, token, timeZone, onChanged, onUnauthorized }: Props) {
  const hasInbound = lead.messages.some((message) => message.direction === 'inbound');
  const [run, setRun] = useState<AssistantRun | null>(null);
  const [loading, setLoading] = useState(true);
  const [analyzing, setAnalyzing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyActionId, setBusyActionId] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<Record<string, string[]>>({});

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

  // A run started by WhatsApp shows as running: check on it until it ends.
  const runningId = run?.status === 'running' ? run.id : null;
  useEffect(() => {
    if (!runningId) return;
    let cancelled = false;
    const timer = setInterval(() => {
      api
        .getRun(token, lead.id, runningId)
        .then((next) => {
          if (!cancelled) setRun(next);
        })
        .catch((err: unknown) => {
          if (!cancelled && !isUnauthorized(err)) setError(err instanceof Error ? err.message : 'Something went wrong');
        });
    }, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [runningId, token, lead.id, isUnauthorized]);

  async function analyze() {
    setAnalyzing(true);
    setError(null);
    setWarnings({});
    try {
      setRun(await api.startRun(token, lead.id));
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

  const running = analyzing || run?.status === 'running';

  return (
    <section className="rounded-xl bg-white p-4 ring-1 ring-gray-200">
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-semibold">AI assistant</h2>
        <button
          type="button"
          onClick={analyze}
          disabled={!hasInbound || running}
          className="rounded-md bg-gray-900 px-3 py-2 text-sm text-white disabled:opacity-40"
          title={hasInbound ? undefined : 'This lead has not sent a message yet'}
        >
          Analyze latest message
        </button>
      </div>

      {analyzing && <p className="mt-3 text-sm text-gray-600">Analyzing... this takes about 15 seconds</p>}
      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
      {loading && <p className="mt-3 text-sm text-gray-500">Loading…</p>}
      {!loading && !run && !analyzing && (
        <p className="mt-3 text-sm text-gray-500">
          {hasInbound ? 'No analysis yet for this lead.' : 'This lead has not sent a message yet.'}
        </p>
      )}

      {run && !analyzing && (
        <RunView
          run={run}
          timeZone={timeZone}
          busyActionId={busyActionId}
          warnings={warnings}
          onDecide={decide}
        />
      )}
    </section>
  );
}

function RunView({
  run,
  timeZone,
  busyActionId,
  warnings,
  onDecide,
}: {
  run: AssistantRun;
  timeZone: string;
  busyActionId: string | null;
  warnings: Record<string, string[]>;
  onDecide: (action: ProposedAction, decision: 'approve' | 'reject') => void;
}) {
  const meta = `${run.trigger === 'whatsapp' ? 'Started by WhatsApp' : 'Started by hand'} · ${formatDateTime(
    run.createdAt,
    timeZone,
  )}`;

  if (run.status === 'running') {
    return (
      <div className="mt-3 text-sm">
        <p className="text-gray-600">The assistant is running on this lead&apos;s messages. This page updates when it is done.</p>
        <p className="mt-1 text-xs text-gray-400">{meta}</p>
      </div>
    );
  }
  if (run.status === 'failed') {
    return (
      <div className="mt-3 text-sm">
        <p className="text-red-600">The assistant failed: {run.error ?? 'unknown error'}</p>
        <p className="mt-1 text-xs text-gray-400">{meta}</p>
      </div>
    );
  }

  return (
    <div className="mt-3 space-y-4 text-sm">
      <p className="text-xs text-gray-400">{meta}</p>
      <Understood run={run} />

      <div>
        <h3 className="font-medium">Summary</h3>
        <p className="mt-1 text-gray-700">{run.summary}</p>
      </div>

      <div>
        <h3 className="font-medium">Recommended listings</h3>
        {run.recommendations.length === 0 ? (
          <p className="mt-1 text-gray-500">No listing fits.</p>
        ) : (
          <ol className="mt-1 space-y-2">
            {run.recommendations.map((rec, index) => (
              <RecommendationItem key={rec.propertyId} rec={rec} rank={index + 1} />
            ))}
          </ol>
        )}
      </div>

      {run.priceChecks.length > 0 && (
        <div>
          <h3 className="font-medium">Price checks</h3>
          <ul className="mt-1 space-y-1">
            {run.priceChecks.map((check) => (
              <PriceCheckItem key={check.propertyId} check={check} recommendations={run.recommendations} />
            ))}
          </ul>
        </div>
      )}

      <div>
        <h3 className="font-medium">Proposed actions</h3>
        {run.proposedActions.length === 0 ? (
          <p className="mt-1 text-gray-500">Nothing to approve.</p>
        ) : (
          <ul className="mt-1 space-y-2">
            {run.proposedActions.map((action) => (
              <ActionItem
                key={action.id}
                action={action}
                timeZone={timeZone}
                busy={busyActionId === action.id}
                warnings={warnings[action.id] ?? []}
                onDecide={onDecide}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function Understood({ run }: { run: AssistantRun }) {
  const r = run.requirements;
  const rows: Array<[string, string | null]> = [
    ['Areas', r.locations.length ? r.locations.join(', ') : null],
    ['Bedrooms', formatBedrooms(r.bedrooms)],
    ['Budget', formatBudget(r.budgetAed)],
    ['Type', r.propertyType],
    ['Buy or rent', r.intent === 'unknown' ? null : r.intent],
    ['Also wants', r.preferences.length ? r.preferences.join(', ') : null],
  ];
  return (
    <div>
      <h3 className="font-medium">What the lead wants</h3>
      <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-gray-500">{label}</dt>
            <dd className={value ? 'text-gray-900' : 'text-gray-400'}>{value ?? 'Not said'}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function RecommendationItem({ rec, rank }: { rec: Recommendation; rank: number }) {
  const facts = [
    rec.priceAed !== undefined ? formatAed(rec.priceAed) : null,
    rec.grossYieldPct !== undefined && rec.grossYieldPct !== null
      ? `${rec.grossYieldPct.toFixed(2)}% gross yield`
      : rec.grossYieldPct === null
        ? 'yield unknown'
        : null,
  ].filter(Boolean);
  return (
    <li className="rounded-md bg-gray-50 p-2 ring-1 ring-gray-200">
      <p>
        <span className="font-medium">
          {rank}. {rec.reference ?? rec.propertyId}
        </span>
        {rec.title ? ` · ${rec.title}` : ''}
      </p>
      {facts.length > 0 && <p className="text-xs text-gray-500">{facts.join(' · ')}</p>}
      <p className="mt-1 text-gray-700">{rec.reason}</p>
    </li>
  );
}

function PriceCheckItem({ check, recommendations }: { check: PriceCheck; recommendations: Recommendation[] }) {
  const reference =
    check.reference ?? recommendations.find((rec) => rec.propertyId === check.propertyId)?.reference ?? check.propertyId;
  const median = check.medianAedPerSqft === null ? 'no median' : `median AED ${check.medianAedPerSqft}/sqft`;
  return (
    <li>
      <span className="font-medium">{reference}</span>: {formatVerdict(check.verdict)}. AED {check.priceAedPerSqft}/sqft
      vs {median}, {check.comparableSales} comparable sales.
    </li>
  );
}

const STATUS_LABEL: Record<ProposedAction['status'], string> = {
  pending_approval: 'Waiting for approval',
  approved: 'Approved',
  rejected: 'Rejected',
};

function ActionItem({
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
    <li className="rounded-md bg-gray-50 p-2 ring-1 ring-gray-200">
      {action.type === 'create_follow_up_task' ? (
        <>
          <p className="font-medium">Follow-up: {action.task.title}</p>
          {action.task.notes && <p className="text-gray-700">{action.task.notes}</p>}
          <p className="text-xs text-gray-500">
            {action.task.dueAt ? `Due ${formatDateTime(action.task.dueAt, timeZone)}` : 'No due date'}
          </p>
          {action.needsClarification && (
            <p className="text-xs text-amber-700">Date unclear: {action.needsClarification}</p>
          )}
        </>
      ) : (
        <>
          <p className="font-medium">Assign to {action.agent.name}</p>
          <p className="text-gray-700">{action.reason}</p>
        </>
      )}
      <p className="mt-1 text-xs text-gray-500">{STATUS_LABEL[action.status]}</p>
      {warnings.map((warning) => (
        <p key={warning} className="mt-1 text-xs text-amber-700">
          {warning}
        </p>
      ))}
      {action.status === 'pending_approval' && (
        <div className="mt-2 flex gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => onDecide(action, 'approve')}
            className="rounded-md bg-gray-900 px-3 py-1 text-xs text-white disabled:opacity-40"
          >
            Approve
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => onDecide(action, 'reject')}
            className="rounded-md px-3 py-1 text-xs ring-1 ring-gray-300 disabled:opacity-40"
          >
            Reject
          </button>
        </div>
      )}
    </li>
  );
}
