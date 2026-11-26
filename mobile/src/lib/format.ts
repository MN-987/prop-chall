/** Shows a time in the agent's timezone, not the phone's: "16 Oct, 10:30". */
export function formatDateTime(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso));
}

export function formatAed(amount: number): string {
  return `AED ${new Intl.NumberFormat('en-US').format(amount)}`;
}

/** 0 bedrooms is a studio. */
export function formatBedrooms(bedrooms: number | null | undefined): string | null {
  if (bedrooms === null || bedrooms === undefined) return null;
  if (bedrooms === 0) return 'Studio';
  return `${bedrooms} bed`;
}

/** "AED 1,500,000 to AED 2,000,000", "up to AED 2,000,000", or null when neither end is known. */
export function formatBudget(budget: { min: number | null; max: number | null }): string | null {
  const { min, max } = budget;
  if (min !== null && max !== null) return min === max ? formatAed(max) : `${formatAed(min)} to ${formatAed(max)}`;
  if (max !== null) return `up to ${formatAed(max)}`;
  if (min !== null) return `from ${formatAed(min)}`;
  return null;
}

export function formatVerdict(verdict: 'below_market' | 'fair' | 'above_market' | 'not_enough_data'): string {
  return {
    below_market: 'Below market',
    fair: 'Fair price',
    above_market: 'Above market',
    not_enough_data: 'Not enough data',
  }[verdict];
}
