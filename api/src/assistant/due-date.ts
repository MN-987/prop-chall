/**
 * Turns the model's timing intent into a due date. The model only says what the lead asked for ("tomorrow",
 * "Thursday", "after the weekend"); the calendar arithmetic happens here, in the agent's timezone, counted from
 * when the message was sent (not from when the run happens). Works the same whatever timezone the server runs in.
 */

export type TimingKind =
  | 'none'
  | 'today'
  | 'tomorrow'
  | 'in_days'
  | 'weekday'
  | 'after_weekend'
  | 'next_week'
  | 'date'
  | 'unclear';

export interface TimingIntent {
  kind: TimingKind;
  days: number | null;
  weekday: string | null;
  date: string | null;
  time: string | null;
}

export interface DueDate {
  /** ISO 8601 with the timezone's offset, e.g. "2026-11-27T10:00:00+04:00". Null when there is no date. */
  dueAt: string | null;
  /** Why the date is unclear, when it is. */
  needsClarification: string | null;
}

/** When the lead names a day but no time. */
export const DEFAULT_TIME = '10:00';

const WEEKDAY_INDEX: Record<string, number> = {
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
  sunday: 7,
};

interface LocalDate {
  year: number;
  month: number; // 1-12
  day: number;
}

/** The calendar date of `instant` in `timeZone`. */
export function localDateOf(instant: Date, timeZone: string): LocalDate {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(
    instant,
  );
  const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  return { year: get('year'), month: get('month'), day: get('day') };
}

/** Calendar arithmetic on plain dates, done in UTC so the server's own timezone never matters. */
function addDays(date: LocalDate, days: number): LocalDate {
  const d = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/** 1 = Monday ... 7 = Sunday. */
function isoWeekday(date: LocalDate): number {
  const day = new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
  return day === 0 ? 7 : day;
}

/** The next given weekday strictly after `date` (a message sent on Thursday saying "Thursday" means next week's). */
function nextWeekday(date: LocalDate, weekday: number): LocalDate {
  const ahead = ((weekday - isoWeekday(date) + 7) % 7) || 7;
  return addDays(date, ahead);
}

/** The timezone's offset from UTC at `instant`, in minutes (Asia/Dubai: +240). */
function offsetMinutes(instant: Date, timeZone: string): number {
  const name = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' })
    .formatToParts(instant)
    .find((p) => p.type === 'timeZoneName')!.value; // "GMT+04:00", or "GMT" for UTC
  const match = /GMT([+-])(\d{2}):(\d{2})/.exec(name);
  if (!match) return 0;
  const minutes = Number(match[2]) * 60 + Number(match[3]);
  return match[1] === '-' ? -minutes : minutes;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** Wall-clock `date` at `hh:mm` in `timeZone`, as ISO 8601 with that zone's offset. */
export function toZonedIso(date: LocalDate, time: string, timeZone: string): string {
  const [hh, mm] = time.split(':').map(Number);
  const wallAsUtc = Date.UTC(date.year, date.month - 1, date.day, hh, mm);
  // The offset can depend on the date (daylight saving), so take it at the resulting instant.
  let offset = offsetMinutes(new Date(wallAsUtc), timeZone);
  offset = offsetMinutes(new Date(wallAsUtc - offset * 60_000), timeZone);
  const sign = offset < 0 ? '-' : '+';
  const abs = Math.abs(offset);
  return `${date.year}-${pad(date.month)}-${pad(date.day)}T${pad(hh)}:${pad(mm)}:00${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

function parseIsoDate(value: string): LocalDate | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const date = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
  const check = addDays(date, 0);
  return check.year === date.year && check.month === date.month && check.day === date.day ? date : null;
}

function compare(a: LocalDate, b: LocalDate): number {
  return a.year - b.year || a.month - b.month || a.day - b.day;
}

const unclear = (reason: string): DueDate => ({ dueAt: null, needsClarification: reason });

export function resolveDueDate(
  timing: TimingIntent,
  unclearReason: string | null,
  sentAt: Date,
  timeZone: string,
): DueDate {
  const sentDay = localDateOf(sentAt, timeZone);
  const time = timing.time && /^([01]\d|2[0-3]):[0-5]\d$/.test(timing.time) ? timing.time : DEFAULT_TIME;
  const on = (date: LocalDate): DueDate => ({ dueAt: toZonedIso(date, time, timeZone), needsClarification: null });

  switch (timing.kind) {
    case 'none':
      return { dueAt: null, needsClarification: null };
    case 'today':
      return on(sentDay);
    case 'tomorrow':
      return on(addDays(sentDay, 1));
    case 'in_days':
      if (timing.days === null || timing.days < 0) return unclear(unclearReason ?? 'The lead gave a number of days that is not clear.');
      return on(addDays(sentDay, timing.days));
    case 'weekday': {
      const index = timing.weekday ? WEEKDAY_INDEX[timing.weekday.toLowerCase()] : undefined;
      if (!index) return unclear(unclearReason ?? 'The lead named a day that is not clear.');
      return on(nextWeekday(sentDay, index));
    }
    case 'after_weekend':
      // UAE weekend is Saturday and Sunday: the first working day after the next weekend is the next Monday.
      return on(nextWeekday(sentDay, WEEKDAY_INDEX.monday));
    case 'date': {
      const date = timing.date ? parseIsoDate(timing.date) : null;
      if (!date) return unclear(unclearReason ?? 'The lead gave a date that is not clear.');
      if (compare(date, sentDay) < 0) return unclear(unclearReason ?? `The date ${timing.date} is before the message was sent.`);
      return on(date);
    }
    case 'next_week':
      return unclear(unclearReason ?? 'The lead said "next week" without a day. Ask which day suits them.');
    case 'unclear':
      return unclear(unclearReason ?? 'The lead asked for a follow-up but the timing is not clear.');
  }
}
