import { resolveDueDate, TimingIntent } from './due-date';

const DUBAI = 'Asia/Dubai';

function timing(kind: TimingIntent['kind'], extra: Partial<TimingIntent> = {}): TimingIntent {
  return { kind, days: null, weekday: null, date: null, time: null, ...extra };
}

// 2026-11-26 is a Thursday. 22:30 in Dubai is 18:30 UTC.
const THURSDAY_EVENING_DUBAI = new Date('2026-11-26T18:30:00Z');
// 23:30 UTC on Wednesday is already 03:30 Thursday in Dubai: the UTC date and the Dubai date differ.
const WEDNESDAY_LATE_UTC = new Date('2026-11-25T23:30:00Z');

describe('resolveDueDate', () => {
  it('"tomorrow" is the calendar day after the message, in the agent timezone, at 10:00 by default', () => {
    expect(resolveDueDate(timing('tomorrow'), null, THURSDAY_EVENING_DUBAI, DUBAI)).toEqual({
      dueAt: '2026-11-27T10:00:00+04:00',
      needsClarification: null,
    });
  });

  it('counts from the Dubai date, not the UTC date', () => {
    // Sent Thursday 03:30 in Dubai (Wednesday in UTC): tomorrow is Friday.
    expect(resolveDueDate(timing('tomorrow'), null, WEDNESDAY_LATE_UTC, DUBAI).dueAt).toBe('2026-11-27T10:00:00+04:00');
  });

  it('"tomorrow" can be a Saturday (the weekend is not skipped)', () => {
    const fridayMorning = new Date('2026-11-27T06:00:00Z');
    expect(resolveDueDate(timing('tomorrow'), null, fridayMorning, DUBAI).dueAt).toBe('2026-11-28T10:00:00+04:00');
  });

  it('"after the weekend" is the Monday after the next Saturday-Sunday', () => {
    expect(resolveDueDate(timing('after_weekend'), null, THURSDAY_EVENING_DUBAI, DUBAI).dueAt).toBe(
      '2026-11-30T10:00:00+04:00',
    );
    const saturday = new Date('2026-11-28T08:00:00Z');
    expect(resolveDueDate(timing('after_weekend'), null, saturday, DUBAI).dueAt).toBe('2026-11-30T10:00:00+04:00');
  });

  it('a named weekday is the next one after the message (Thursday on a Thursday is next week)', () => {
    expect(resolveDueDate(timing('weekday', { weekday: 'thursday' }), null, THURSDAY_EVENING_DUBAI, DUBAI).dueAt).toBe(
      '2026-12-03T10:00:00+04:00',
    );
    expect(resolveDueDate(timing('weekday', { weekday: 'sunday' }), null, THURSDAY_EVENING_DUBAI, DUBAI).dueAt).toBe(
      '2026-11-29T10:00:00+04:00',
    );
  });

  it('uses the time the lead gave', () => {
    expect(resolveDueDate(timing('tomorrow', { time: '15:30' }), null, THURSDAY_EVENING_DUBAI, DUBAI).dueAt).toBe(
      '2026-11-27T15:30:00+04:00',
    );
  });

  it('unclear timing has no date and says why', () => {
    expect(resolveDueDate(timing('unclear'), 'The lead said "soon".', THURSDAY_EVENING_DUBAI, DUBAI)).toEqual({
      dueAt: null,
      needsClarification: 'The lead said "soon".',
    });
    expect(resolveDueDate(timing('next_week'), null, THURSDAY_EVENING_DUBAI, DUBAI).needsClarification).toContain('next week');
  });

  it('no timing at all has no date and nothing to clarify', () => {
    expect(resolveDueDate(timing('none'), null, THURSDAY_EVENING_DUBAI, DUBAI)).toEqual({ dueAt: null, needsClarification: null });
  });

  it('rejects an explicit date in the past or an invalid one', () => {
    expect(resolveDueDate(timing('date', { date: '2026-11-01' }), null, THURSDAY_EVENING_DUBAI, DUBAI).dueAt).toBeNull();
    expect(resolveDueDate(timing('date', { date: '2026-02-30' }), null, THURSDAY_EVENING_DUBAI, DUBAI).dueAt).toBeNull();
    expect(resolveDueDate(timing('date', { date: '2026-12-15' }), null, THURSDAY_EVENING_DUBAI, DUBAI).dueAt).toBe(
      '2026-12-15T10:00:00+04:00',
    );
  });

  it('handles a timezone with daylight saving', () => {
    const londonSummer = new Date('2026-07-01T09:00:00Z');
    expect(resolveDueDate(timing('tomorrow'), null, londonSummer, 'Europe/London').dueAt).toBe('2026-07-02T10:00:00+01:00');
  });
});
