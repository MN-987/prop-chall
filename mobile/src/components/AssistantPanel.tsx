import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { api, ApiError, AssistantRun, LeadDetail, ProposedAction } from '../lib/api';
import { formatAed, formatBedrooms, formatBudget, formatDateTime, formatVerdict } from '../lib/format';

interface Props {
  lead: LeadDetail;
  token: string;
  timeZone: string;
  /** Called after an action is approved, so the screen can reload the tasks (and the lead). */
  onChanged: () => void;
  /** Called on a 401, so the screen can sign the agent out. */
  onUnauthorized: () => void;
}

const POLL_MS = 2000;

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

/** The latest assistant run for the lead, with Approve and Reject on its proposed actions. */
export function AssistantPanel({ lead, token, timeZone, onChanged, onUnauthorized }: Props) {
  const hasInbound = lead.messages.some((message) => message.direction === 'inbound');
  const [run, setRun] = useState<AssistantRun | null>(null);
  const [loading, setLoading] = useState(true);
  const [analyzing, setAnalyzing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyActionId, setBusyActionId] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<Record<string, string[]>>({});

  const fail = useCallback(
    (err: unknown, message: string) => {
      if (err instanceof ApiError && err.status === 401) return onUnauthorized();
      setError(message);
    },
    [onUnauthorized],
  );

  const loadLatest = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const runs = await api.listRuns(token, lead.id);
      setRun(runs[0] ?? null);
    } catch (err) {
      fail(err, err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setLoading(false);
    }
  }, [token, lead.id, fail]);

  useEffect(() => {
    void loadLatest();
  }, [loadLatest]);

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
          if (!cancelled) fail(err, err instanceof Error ? err.message : 'Something went wrong');
        });
    }, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [runningId, token, lead.id, fail]);

  async function analyze() {
    setAnalyzing(true);
    setError(null);
    setWarnings({});
    try {
      setRun(await api.startRun(token, lead.id));
    } catch (err) {
      fail(err, runErrorMessage(err));
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
      fail(err, err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setBusyActionId(null);
    }
  }

  const busy = loading || analyzing || run?.status === 'running';

  return (
    <View style={styles.card}>
      <View style={styles.headerRow}>
        <Text style={styles.title}>AI assistant</Text>
        <View style={styles.row}>
          <Pressable onPress={loadLatest} disabled={busy} accessibilityRole="button" style={styles.linkButton}>
            <Text style={[styles.link, busy && styles.disabled]}>Refresh</Text>
          </Pressable>
          <Pressable
            onPress={analyze}
            disabled={busy || !hasInbound}
            accessibilityRole="button"
            style={[styles.button, (busy || !hasInbound) && styles.disabledButton]}
          >
            <Text style={styles.buttonText}>Run analysis</Text>
          </Pressable>
        </View>
      </View>

      {analyzing && <Text style={styles.muted}>Analyzing... this takes about 15 seconds</Text>}
      {loading && <ActivityIndicator />}
      {error && <Text style={styles.error}>{error}</Text>}
      {!loading && !analyzing && !run && (
        <Text style={styles.muted}>{hasInbound ? 'No analysis yet for this lead.' : 'This lead has not sent a message yet.'}</Text>
      )}

      {run && !analyzing && !loading && (
        <RunView run={run} timeZone={timeZone} busyActionId={busyActionId} warnings={warnings} onDecide={decide} />
      )}
    </View>
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
  const meta = `${run.trigger === 'whatsapp' ? 'Started by WhatsApp' : 'Started by hand'} · ${formatDateTime(run.createdAt, timeZone)}`;
  if (run.status === 'running') {
    return (
      <View style={styles.block}>
        <Text style={styles.body}>The assistant is running on this lead&apos;s messages.</Text>
        <Text style={styles.small}>{meta}</Text>
      </View>
    );
  }
  if (run.status === 'failed') {
    return (
      <View style={styles.block}>
        <Text style={styles.error}>The assistant failed: {run.error ?? 'unknown error'}</Text>
        <Text style={styles.small}>{meta}</Text>
      </View>
    );
  }

  const r = run.requirements;
  const wants = [
    r.locations.join(', ') || null,
    formatBedrooms(r.bedrooms),
    r.propertyType,
    r.intent === 'unknown' ? null : r.intent,
    formatBudget(r.budgetAed),
    ...r.preferences,
  ].filter(Boolean);

  return (
    <View style={styles.block}>
      <Text style={styles.small}>{meta}</Text>
      <Text style={styles.label}>What the lead wants</Text>
      <Text style={styles.body}>{wants.length ? wants.join(' · ') : 'Nothing specific yet.'}</Text>

      <Text style={styles.label}>Summary</Text>
      <Text style={styles.body}>{run.summary}</Text>

      <Text style={styles.label}>Recommended listings</Text>
      {run.recommendations.length === 0 && <Text style={styles.muted}>No listing fits.</Text>}
      {run.recommendations.map((rec, index) => {
        const facts = [
          rec.priceAed !== undefined ? formatAed(rec.priceAed) : null,
          typeof rec.grossYieldPct === 'number' ? `${rec.grossYieldPct.toFixed(2)}% gross yield` : null,
        ].filter(Boolean);
        return (
          <View key={rec.propertyId} style={styles.item}>
            <Text style={styles.itemTitle}>
              {index + 1}. {rec.reference ?? rec.propertyId}
              {rec.title ? ` · ${rec.title}` : ''}
            </Text>
            {facts.length > 0 && <Text style={styles.small}>{facts.join(' · ')}</Text>}
            <Text style={styles.body}>{rec.reason}</Text>
          </View>
        );
      })}

      {run.priceChecks.length > 0 && <Text style={styles.label}>Price checks</Text>}
      {run.priceChecks.map((check) => {
        const reference =
          check.reference ?? run.recommendations.find((rec) => rec.propertyId === check.propertyId)?.reference ?? check.propertyId;
        const median = check.medianAedPerSqft === null ? 'no median' : `median AED ${check.medianAedPerSqft}/sqft`;
        return (
          <Text key={check.propertyId} style={styles.body}>
            {reference}: {formatVerdict(check.verdict)}. AED {check.priceAedPerSqft}/sqft vs {median}, {check.comparableSales}{' '}
            comparable sales.
          </Text>
        );
      })}

      <Text style={styles.label}>Proposed actions</Text>
      {run.proposedActions.length === 0 && <Text style={styles.muted}>Nothing to approve.</Text>}
      {run.proposedActions.map((action) => (
        <View key={action.id} style={styles.item}>
          {action.type === 'create_follow_up_task' ? (
            <>
              <Text style={styles.itemTitle}>Follow-up: {action.task.title}</Text>
              {action.task.notes && <Text style={styles.body}>{action.task.notes}</Text>}
              <Text style={styles.small}>
                {action.task.dueAt ? `Due ${formatDateTime(action.task.dueAt, timeZone)}` : 'No due date'}
              </Text>
              {action.needsClarification && <Text style={styles.warning}>Date unclear: {action.needsClarification}</Text>}
            </>
          ) : (
            <>
              <Text style={styles.itemTitle}>Assign to {action.agent.name}</Text>
              <Text style={styles.body}>{action.reason}</Text>
            </>
          )}
          <Text style={styles.small}>{STATUS_LABEL[action.status]}</Text>
          {(warnings[action.id] ?? []).map((warning) => (
            <Text key={warning} style={styles.warning}>
              {warning}
            </Text>
          ))}
          {action.status === 'pending_approval' && (
            <View style={styles.row}>
              <Pressable
                onPress={() => onDecide(action, 'approve')}
                disabled={busyActionId === action.id}
                accessibilityRole="button"
                style={[styles.button, busyActionId === action.id && styles.disabledButton]}
              >
                <Text style={styles.buttonText}>Approve</Text>
              </Pressable>
              <Pressable
                onPress={() => onDecide(action, 'reject')}
                disabled={busyActionId === action.id}
                accessibilityRole="button"
                style={[styles.outlineButton, busyActionId === action.id && styles.disabledButton]}
              >
                <Text style={styles.outlineText}>Reject</Text>
              </Pressable>
            </View>
          )}
        </View>
      ))}
    </View>
  );
}

const STATUS_LABEL: Record<ProposedAction['status'], string> = {
  pending_approval: 'Waiting for approval',
  approved: 'Approved',
  rejected: 'Rejected',
};

const styles = StyleSheet.create({
  card: { borderWidth: 1, borderColor: '#e5e7eb', borderRadius: 12, backgroundColor: '#ffffff', padding: 16, gap: 8 },
  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 4 },
  title: { fontWeight: '600', fontSize: 16, color: '#111827' },
  block: { gap: 4 },
  label: { marginTop: 8, fontWeight: '600', color: '#111827' },
  body: { color: '#374151' },
  muted: { color: '#6b7280' },
  small: { color: '#6b7280', fontSize: 12 },
  error: { color: '#dc2626' },
  warning: { color: '#b45309', fontSize: 12 },
  item: { backgroundColor: '#f9fafb', borderRadius: 8, borderWidth: 1, borderColor: '#e5e7eb', padding: 8, gap: 2 },
  itemTitle: { fontWeight: '600', color: '#111827' },
  button: { backgroundColor: '#111827', borderRadius: 6, paddingHorizontal: 12, paddingVertical: 6 },
  buttonText: { color: '#ffffff', fontSize: 13 },
  outlineButton: { borderWidth: 1, borderColor: '#d1d5db', borderRadius: 6, paddingHorizontal: 12, paddingVertical: 6 },
  outlineText: { color: '#111827', fontSize: 13 },
  disabledButton: { opacity: 0.4 },
  linkButton: { paddingHorizontal: 4, paddingVertical: 6 },
  link: { color: '#2563eb', fontSize: 13 },
  disabled: { opacity: 0.4 },
});
