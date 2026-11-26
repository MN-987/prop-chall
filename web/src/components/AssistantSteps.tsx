import type { TraceStep } from '@/lib/api';
import { formatAedShort } from '@/lib/format';

type StepState = 'done' | 'error' | 'active';

interface Step {
  key: string;
  label: string;
  state: StepState;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function bedroomsLabel(min: number | undefined, max: number | undefined): string | null {
  const one = (n: number) => (n === 0 ? 'studio' : `${n} bed`);
  if (min !== undefined && max !== undefined) {
    if (min === max) return one(min);
    return min === 0 ? `studio to ${max} bed` : `${min} to ${max} bed`;
  }
  if (min !== undefined) return min === 0 ? null : `${min}+ bed`;
  if (max !== undefined) return max === 0 ? 'studio' : `up to ${max} bed`;
  return null;
}

function priceLabel(min: number | undefined, max: number | undefined): string | null {
  if (min !== undefined && max !== undefined) return `${formatAedShort(min)} to ${formatAedShort(max)}`;
  if (max !== undefined) return `up to ${formatAedShort(max)}`;
  if (min !== undefined) return `from ${formatAedShort(min)}`;
  return null;
}

/** Plain words for one tool call, from what the agent sent and what came back. */
export function describeStep(step: TraceStep): string {
  if (step.error) return `${step.tool} failed: ${step.error}`;
  const input = record(step.input);
  const output = record(step.output);

  if (step.tool === 'search_listings') {
    const type = str(input.type);
    const parts = [
      str(input.area) ?? 'all areas',
      bedroomsLabel(num(input.minBedrooms), num(input.maxBedrooms)),
      priceLabel(num(input.minPriceAed), num(input.maxPriceAed)),
      type ? `${type}s` : null,
    ].filter(Boolean);
    const total = num(output.totalMatching);
    return `Searched ${parts.join(', ')}${total === undefined ? '' : `: ${total} found`}`;
  }

  if (step.tool === 'get_listing') {
    const listing = str(input.listing) ?? str(output.reference) ?? 'a listing';
    if (output.found === false) return `Looked up ${listing}: not found`;
    const status = str(output.status);
    return `Looked up ${listing}${status ? `: ${status}` : ''}`;
  }

  return `Used ${step.tool}`;
}

/**
 * The steps of a run, in order: reading the conversation, one per tool call, then the final check.
 * `phase` is "starting" before the run exists, "running" while it works and "done" once it has ended.
 */
export function buildSteps(trace: TraceStep[], phase: 'starting' | 'running' | 'done', completed = false): Step[] {
  const steps: Step[] = [
    { key: 'read', label: 'Read the conversation', state: phase === 'starting' ? 'active' : 'done' },
  ];
  trace.forEach((entry, index) => {
    steps.push({ key: `t${index}`, label: describeStep(entry), state: entry.error ? 'error' : 'done' });
  });
  if (phase === 'running') {
    steps.push({ key: 'check', label: 'Checking the picks against the data and drafting the follow-up', state: 'active' });
  } else if (phase === 'done' && completed) {
    steps.push({ key: 'check', label: 'Checked the picks against the data and drafted the follow-up', state: 'done' });
  }
  return steps;
}

export function Spinner({ className = 'h-4 w-4' }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={`inline-block shrink-0 animate-spin rounded-full border-2 border-gray-200 border-t-gray-700 ${className}`}
    />
  );
}

function StepIcon({ state }: { state: StepState }) {
  if (state === 'active') return <Spinner className="mt-0.5 h-4 w-4" />;
  const ok = state === 'done';
  return (
    <span
      aria-hidden
      className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-white ${
        ok ? 'bg-green-600' : 'bg-red-600'
      }`}
    >
      <svg viewBox="0 0 12 12" className="h-2.5 w-2.5" fill="none" stroke="currentColor" strokeWidth="2">
        {ok ? <path d="M2.5 6.5l2.2 2.2 4.8-5" strokeLinecap="round" strokeLinejoin="round" /> : <path d="M3 3l6 6M9 3l-6 6" strokeLinecap="round" />}
      </svg>
    </span>
  );
}

export function StepList({ steps }: { steps: Step[] }) {
  return (
    <ol className="space-y-2">
      {steps.map((step) => (
        <li key={step.key} className="flex items-start gap-2.5 text-sm leading-5">
          <StepIcon state={step.state} />
          <span
            className={`min-w-0 break-words ${
              step.state === 'error' ? 'text-red-700' : step.state === 'active' ? 'text-gray-900' : 'text-gray-700'
            }`}
          >
            {step.label}
          </span>
        </li>
      ))}
    </ol>
  );
}
