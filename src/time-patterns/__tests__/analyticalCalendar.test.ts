import { describe, it, expect } from 'vitest';
import {
  addDays,
  dateDiffDays,
  toAnalyticalDate,
  analyticalDateOfInstant,
  resolveAnalysisRange,
  analyticalDayRange,
  getAnalyticalWeekday,
  isWorkday,
} from '../analyticalCalendar';

describe('addDays', () => {
  it('adds positive days', () => {
    expect(addDays('2026-03-21', 1)).toBe('2026-03-22');
    expect(addDays('2026-03-21', 7)).toBe('2026-03-28');
  });

  it('adds negative days', () => {
    expect(addDays('2026-03-21', -1)).toBe('2026-03-20');
    expect(addDays('2026-03-21', -21)).toBe('2026-02-28');
  });

  it('wraps month boundaries', () => {
    expect(addDays('2026-01-31', 1)).toBe('2026-02-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });

  it('adds zero days', () => {
    expect(addDays('2026-03-21', 0)).toBe('2026-03-21');
  });

  it('crosses EU spring-forward DST boundary correctly (2026-03-29)', () => {
    // DST in EU starts 2026-03-29 at 02:00 → 03:00. Raw-ms arithmetic would
    // land on 23:00 of the previous calendar day; UTC-based addDays must not.
    expect(addDays('2026-03-23', 6)).toBe('2026-03-29');
    expect(addDays('2026-03-30', -1)).toBe('2026-03-29');
    expect(addDays('2026-03-29', -6)).toBe('2026-03-23');
  });
});

describe('dateDiffDays', () => {
  it('same date → 0', () => {
    expect(dateDiffDays('2026-03-21', '2026-03-21')).toBe(0);
  });

  it('later date is positive', () => {
    expect(dateDiffDays('2026-03-21', '2026-03-22')).toBe(1);
    expect(dateDiffDays('2026-03-21', '2026-03-28')).toBe(7);
  });

  it('earlier date is negative', () => {
    expect(dateDiffDays('2026-03-22', '2026-03-21')).toBe(-1);
  });
});

describe('toAnalyticalDate', () => {
  // Basic: same-day timings
  it('timeInit >= 300 → same calendarDate', () => {
    expect(toAnalyticalDate('2026-03-21', 300)).toBe('2026-03-21'); // exactly 05:00
    expect(toAnalyticalDate('2026-03-21', 600)).toBe('2026-03-21'); // 10:00
    expect(toAnalyticalDate('2026-03-21', 1439)).toBe('2026-03-21'); // 23:59
  });

  it('timeInit < 300 → previous calendarDate', () => {
    expect(toAnalyticalDate('2026-03-21', 0)).toBe('2026-03-20');    // 00:00
    expect(toAnalyticalDate('2026-03-21', 299)).toBe('2026-03-20');  // 04:59
    expect(toAnalyticalDate('2026-03-21', 150)).toBe('2026-03-20');  // 02:30
  });

  it('timeInit exactly at boundary 300 stays on calendarDate', () => {
    expect(toAnalyticalDate('2026-03-21', 300)).toBe('2026-03-21');
  });

  // Post-midnight timings stored with timeInit > 1440
  it('timeInit = 1470 (00:30 of calendarDate+1) shifts back to calendarDate', () => {
    // calendarDate = "2026-03-21", timeInit = 1470
    // actualCalendarDay = 2026-03-22, minuteInDay = 30 < 300 → 2026-03-21
    expect(toAnalyticalDate('2026-03-21', 1470)).toBe('2026-03-21');
  });

  it('timeInit = 1440 (00:00 of calendarDate+1) shifts back to calendarDate', () => {
    // minuteInDay = 0 < 300 → shift back from 2026-03-22 to 2026-03-21
    expect(toAnalyticalDate('2026-03-21', 1440)).toBe('2026-03-21');
  });

  it('timeInit = 1740 (05:00 of calendarDate+1) = next analyticalDate', () => {
    // minuteInDay = 300, not < 300 → stays on actualCalendarDay = 2026-03-22
    expect(toAnalyticalDate('2026-03-21', 1740)).toBe('2026-03-22');
  });
});

describe('analyticalDateOfInstant', () => {
  // These use Date constructor with local time, so getHours() returns local hours.
  // The test is timezone-agnostic in that respect.

  it('04:59 local → shifts to previous day', () => {
    const d = new Date(2026, 2, 21, 4, 59); // March 21 04:59 local
    expect(analyticalDateOfInstant(d)).toBe('2026-03-20');
  });

  it('05:00 local → stays on same day', () => {
    const d = new Date(2026, 2, 21, 5, 0); // March 21 05:00 local
    expect(analyticalDateOfInstant(d)).toBe('2026-03-21');
  });

  it('00:00 local → shifts to previous day', () => {
    const d = new Date(2026, 2, 21, 0, 0); // March 21 00:00 local
    expect(analyticalDateOfInstant(d)).toBe('2026-03-20');
  });

  it('12:00 local → same day', () => {
    const d = new Date(2026, 2, 21, 12, 0);
    expect(analyticalDateOfInstant(d)).toBe('2026-03-21');
  });

  it('23:59 local → same day', () => {
    const d = new Date(2026, 2, 21, 23, 59);
    expect(analyticalDateOfInstant(d)).toBe('2026-03-21');
  });
});

describe('resolveAnalysisRange', () => {
  // anchorDate = 2026-03-21 12:00 local (noon, clearly post-boundary)
  const anchor = new Date(2026, 2, 21, 12, 0);

  it('last-n-days', () => {
    expect(resolveAnalysisRange({ kind: 'last-n-days', days: 7 }, anchor)).toEqual({
      from: '2026-03-15',
      to:   '2026-03-21',
    });
    expect(resolveAnalysisRange({ kind: 'last-n-days', days: 1 }, anchor)).toEqual({
      from: '2026-03-21',
      to:   '2026-03-21',
    });
  });

  it('last-n-weeks spans exactly weeks*7 days ending on analytical anchor', () => {
    // 4 weeks → 28 days; same range as last-n-days with days: 28
    expect(resolveAnalysisRange({ kind: 'last-n-weeks', weeks: 4 }, anchor)).toEqual({
      from: '2026-02-22',
      to:   '2026-03-21',
    });
    // 1 week → 7 days
    expect(resolveAnalysisRange({ kind: 'last-n-weeks', weeks: 1 }, anchor)).toEqual({
      from: '2026-03-15',
      to:   '2026-03-21',
    });
  });

  it('last-n-weeks is anchor-relative: early anchor shifts the range back', () => {
    const earlyAnchor = new Date(2026, 2, 21, 2, 0); // 02:00 → analytical = 2026-03-20
    expect(resolveAnalysisRange({ kind: 'last-n-weeks', weeks: 2 }, earlyAnchor)).toEqual({
      from: '2026-03-07',
      to:   '2026-03-20',
    });
  });

  it('this-month ends at anchor, not end of month (avoids diluting with future empty days)', () => {
    // Anchor = March 21 → range is 2026-03-01 to 2026-03-21, not to 2026-03-31
    expect(resolveAnalysisRange({ kind: 'this-month' }, anchor)).toEqual({
      from: '2026-03-01',
      to:   '2026-03-21',
    });
  });

  it('this-month when anchor is first day of month → single-day range', () => {
    const firstOfMonth = new Date(2026, 2, 1, 12, 0); // March 1 noon
    expect(resolveAnalysisRange({ kind: 'this-month' }, firstOfMonth)).toEqual({
      from: '2026-03-01',
      to:   '2026-03-01',
    });
  });

  it('this-week ends at anchor, not end of week (avoids diluting with future empty days)', () => {
    // Anchor = March 21 (Saturday) → Mon 16 to Sat 21, not to Sun 22
    expect(resolveAnalysisRange({ kind: 'this-week' }, anchor)).toEqual({
      from: '2026-03-16',
      to:   '2026-03-21',
    });
  });

  it('this-week when anchor is Monday → single-day range', () => {
    const monday = new Date(2026, 2, 16, 12, 0); // March 16, 2026 = Monday
    expect(resolveAnalysisRange({ kind: 'this-week' }, monday)).toEqual({
      from: '2026-03-16',
      to:   '2026-03-16',
    });
  });

  it('this-week when anchor is Sunday → full 7-day range (Mon–Sun)', () => {
    const sunday = new Date(2026, 2, 22, 12, 0); // March 22, 2026 = Sunday
    expect(resolveAnalysisRange({ kind: 'this-week' }, sunday)).toEqual({
      from: '2026-03-16',
      to:   '2026-03-22',
    });
  });

  it('this-week across DST spring-forward (2026-03-23 → 2026-03-29)', () => {
    // Anchor = Sunday 2026-03-29 (the DST day). Week must be Mon 23 → Sun 29,
    // not Mon 23 → Sat 28 (the symptom of raw-ms date math in that week).
    const dstSunday = new Date(2026, 2, 29, 12, 0);
    expect(resolveAnalysisRange({ kind: 'this-week' }, dstSunday)).toEqual({
      from: '2026-03-23',
      to:   '2026-03-29',
    });
  });

  it('custom passes through directly', () => {
    expect(resolveAnalysisRange({ kind: 'custom', from: '2026-01-01', to: '2026-01-31' }, anchor)).toEqual({
      from: '2026-01-01',
      to:   '2026-01-31',
    });
  });

  it('anchor at 02:00 shifts reference day back', () => {
    const earlyAnchor = new Date(2026, 2, 21, 2, 0); // 02:00 → analytical = 2026-03-20
    expect(resolveAnalysisRange({ kind: 'last-n-days', days: 3 }, earlyAnchor)).toEqual({
      from: '2026-03-18',
      to:   '2026-03-20',
    });
  });
});

describe('analyticalDayRange', () => {
  it('single day', () => {
    expect(analyticalDayRange('2026-03-21', '2026-03-21')).toEqual(['2026-03-21']);
  });

  it('three days', () => {
    expect(analyticalDayRange('2026-03-19', '2026-03-21')).toEqual([
      '2026-03-19', '2026-03-20', '2026-03-21',
    ]);
  });

  it('from > to → empty array', () => {
    expect(analyticalDayRange('2026-03-21', '2026-03-20')).toEqual([]);
  });
});

describe('getAnalyticalWeekday', () => {
  // March 16, 2026 = Monday; March 21 = Saturday; March 22 = Sunday
  it('Monday = 1', () => expect(getAnalyticalWeekday('2026-03-16')).toBe(1));
  it('Saturday = 6', () => expect(getAnalyticalWeekday('2026-03-21')).toBe(6));
  it('Sunday = 0', () => expect(getAnalyticalWeekday('2026-03-22')).toBe(0));
});

describe('isWorkday', () => {
  it('Mon–Fri are workdays', () => {
    expect(isWorkday('2026-03-16')).toBe(true);  // Mon
    expect(isWorkday('2026-03-20')).toBe(true);  // Fri
  });
  it('Sat–Sun are not', () => {
    expect(isWorkday('2026-03-21')).toBe(false); // Sat
    expect(isWorkday('2026-03-22')).toBe(false); // Sun
  });
});
