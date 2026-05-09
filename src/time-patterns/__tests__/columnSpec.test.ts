import { describe, it, expect } from 'vitest';
import { resolveColumnScope, computeFetchRange } from '../columnSpec';
import type { AnalysisRange, ColumnSpec } from '../types';

// March 21, 2026 (Saturday) at noon — clearly post-boundary
const ANCHOR = new Date(2026, 2, 21, 12, 0);

// 28-day range ending on March 21
const RANGE_28: AnalysisRange = { from: '2026-02-22', to: '2026-03-21' };

// Tight single-week range Mon 16 – Sun 22
const RANGE_WEEK: AnalysisRange = { from: '2026-03-16', to: '2026-03-22' };

describe('resolveColumnScope – today', () => {
  const col: ColumnSpec = { kind: 'today', id: 'today', label: 'Today' };

  it('resolves to analytical date of anchorDate', () => {
    const scope = resolveColumnScope(col, ANCHOR, RANGE_28);
    expect(scope.eligibleDates).toEqual(['2026-03-21']);
    expect(scope.denominator).toBe(1);
    expect(scope.scopeKind).toBe('anchor-relative');
  });

  it('anchor at 02:00 → resolves to previous analytical day', () => {
    const earlyAnchor = new Date(2026, 2, 21, 2, 0);
    const scope = resolveColumnScope(col, earlyAnchor, RANGE_28);
    expect(scope.eligibleDates).toEqual(['2026-03-20']);
  });

  it('uses anchorDate — not the real system date — when anchor is a past date', () => {
    // Use a date clearly in the past so it can never equal new Date()
    const pastAnchor = new Date(2025, 0, 15, 12, 0); // 2025-01-15 noon
    const pastRange: AnalysisRange = { from: '2024-12-19', to: '2025-01-15' };
    const scope = resolveColumnScope(col, pastAnchor, pastRange);
    expect(scope.eligibleDates).toEqual(['2025-01-15']);
    // If the implementation used new Date() instead, this would be today's date and would fail.
  });
});

describe('resolveColumnScope – yesterday', () => {
  const col: ColumnSpec = { kind: 'yesterday', id: 'yesterday', label: 'Yesterday' };

  it('resolves to analytical today − 1', () => {
    const scope = resolveColumnScope(col, ANCHOR, RANGE_28);
    expect(scope.eligibleDates).toEqual(['2026-03-20']);
    expect(scope.denominator).toBe(1);
    expect(scope.scopeKind).toBe('anchor-relative');
  });

  it('anchor at 02:00 → yesterday = two calendar days back', () => {
    const earlyAnchor = new Date(2026, 2, 21, 2, 0); // analytical = 2026-03-20
    const scope = resolveColumnScope(col, earlyAnchor, RANGE_28);
    expect(scope.eligibleDates).toEqual(['2026-03-19']);
  });

  it('uses anchorDate − 1, not new Date() − 1, when anchor is a past date', () => {
    const pastAnchor = new Date(2025, 0, 15, 12, 0); // 2025-01-15 noon
    const pastRange: AnalysisRange = { from: '2024-12-19', to: '2025-01-15' };
    const scope = resolveColumnScope(col, pastAnchor, pastRange);
    expect(scope.eligibleDates).toEqual(['2025-01-14']);
  });
});

describe('resolveColumnScope – weekday-average', () => {
  const monCol: ColumnSpec = { kind: 'weekday-average', id: 'mon', label: 'Mon', weekday: 1 };

  it('28-day range contains 4 Mondays', () => {
    // Feb 22 – Mar 21: Mondays are 2026-02-23, 2026-03-02, 2026-03-09, 2026-03-16
    const scope = resolveColumnScope(monCol, ANCHOR, RANGE_28);
    expect(scope.eligibleDates).toHaveLength(4);
    expect(scope.denominator).toBe(4);
    expect(scope.scopeKind).toBe('analysis-range');
    // All must be Mondays (weekday = 1)
    for (const d of scope.eligibleDates) {
      const wd = new Date(d + 'T12:00:00Z').getUTCDay();
      expect(wd).toBe(1);
    }
  });

  it('single-day range with no Monday → empty eligible, denominator 0', () => {
    const range: AnalysisRange = { from: '2026-03-21', to: '2026-03-21' }; // Saturday
    const scope = resolveColumnScope(monCol, ANCHOR, range);
    expect(scope.eligibleDates).toHaveLength(0);
    expect(scope.denominator).toBe(0);
  });
});

describe('resolveColumnScope – rolling-average', () => {
  const roll7: ColumnSpec = { kind: 'rolling-average', id: 'roll7', label: '7d avg', windowDays: 7 };
  const roll30: ColumnSpec = { kind: 'rolling-average', id: 'roll30', label: '30d avg', windowDays: 30 };

  it('7-day window has exactly 7 eligible dates ending on analytical anchorDate', () => {
    const scope = resolveColumnScope(roll7, ANCHOR, RANGE_WEEK);
    expect(scope.eligibleDates).toHaveLength(7);
    expect(scope.eligibleDates[scope.eligibleDates.length - 1]).toBe('2026-03-21');
    expect(scope.eligibleDates[0]).toBe('2026-03-15');
    expect(scope.denominator).toBe(7);
    expect(scope.scopeKind).toBe('anchor-relative');
  });

  it('30-day rolling extends outside the 7-day analysis range', () => {
    const scope = resolveColumnScope(roll30, ANCHOR, RANGE_WEEK);
    expect(scope.eligibleDates).toHaveLength(30);
    expect(scope.eligibleDates[0]).toBe('2026-02-20'); // 30 days before 2026-03-21
    expect(scope.denominator).toBe(30);
    // Scope starts before RANGE_WEEK.from = 2026-03-16
    expect(scope.eligibleDates[0] < RANGE_WEEK.from).toBe(true);
  });

  it('denominator is always windowDays regardless of analysis range width', () => {
    const narrowRange: AnalysisRange = { from: '2026-03-21', to: '2026-03-21' };
    const scope = resolveColumnScope(roll7, ANCHOR, narrowRange);
    expect(scope.denominator).toBe(7); // NOT 1 (the analysis range width)
  });
});

describe('resolveColumnScope – workday-average', () => {
  const col: ColumnSpec = { kind: 'workday-average', id: 'wday', label: 'Workday avg' };

  it('one-week range has 5 workdays', () => {
    const scope = resolveColumnScope(col, ANCHOR, RANGE_WEEK);
    expect(scope.eligibleDates).toHaveLength(5);
    expect(scope.denominator).toBe(5);
    expect(scope.scopeKind).toBe('analysis-range');
  });
});

describe('resolveColumnScope – weekend-average', () => {
  const col: ColumnSpec = { kind: 'weekend-average', id: 'wend', label: 'Weekend avg' };

  it('one-week range has 2 weekend days', () => {
    const scope = resolveColumnScope(col, ANCHOR, RANGE_WEEK);
    expect(scope.eligibleDates).toHaveLength(2);
    expect(scope.denominator).toBe(2);
  });
});

describe('resolveColumnScope – this-week-average', () => {
  const col: ColumnSpec = { kind: 'this-week-average', id: 'avg-week', label: 'Avg week' };

  it('anchor on Sat 2026-03-21 → Mon 2026-03-16 through Sat 2026-03-21 (6 days, capped at anchor)', () => {
    const scope = resolveColumnScope(col, ANCHOR, RANGE_28);
    expect(scope.scopeKind).toBe('anchor-relative');
    expect(scope.eligibleDates).toEqual([
      '2026-03-16', '2026-03-17', '2026-03-18', '2026-03-19', '2026-03-20', '2026-03-21',
    ]);
    expect(scope.denominator).toBe(6);
  });

  it('anchor on Sun 2026-03-22 → full Mon–Sun week (7 days)', () => {
    const sunAnchor = new Date(2026, 2, 22, 12, 0);
    const scope = resolveColumnScope(col, sunAnchor, RANGE_28);
    expect(scope.eligibleDates).toHaveLength(7);
    expect(scope.eligibleDates[0]).toBe('2026-03-16');
    expect(scope.eligibleDates[6]).toBe('2026-03-22');
  });

  it('uses full week regardless of analysisRange.from — range does not clip week start', () => {
    // Even if analysisRange starts on Wed, eligible dates still go back to Mon.
    // computeFetchRange will extend the fetch to cover those days.
    const narrowRange: AnalysisRange = { from: '2026-03-18', to: '2026-03-21' };
    const scope = resolveColumnScope(col, ANCHOR, narrowRange);
    expect(scope.eligibleDates[0]).toBe('2026-03-16'); // Mon, not Wed
    expect(scope.eligibleDates).toHaveLength(6);       // full Mon–Sat
  });
});

describe('resolveColumnScope – this-month-average', () => {
  const col: ColumnSpec = { kind: 'this-month-average', id: 'avg-month', label: 'Avg month' };

  it('anchor on Mar 21 2026 → 1–21 March (21 days, capped at anchor)', () => {
    const scope = resolveColumnScope(col, ANCHOR, RANGE_28);
    expect(scope.scopeKind).toBe('anchor-relative');
    expect(scope.eligibleDates[0]).toBe('2026-03-01');
    expect(scope.eligibleDates[scope.eligibleDates.length - 1]).toBe('2026-03-21');
    expect(scope.eligibleDates).toHaveLength(21);
    expect(scope.denominator).toBe(21);
  });

  it('anchor on last day of month → full 31-day month', () => {
    const endOfMar = new Date(2026, 2, 31, 12, 0);
    const scope = resolveColumnScope(col, endOfMar, RANGE_28);
    expect(scope.eligibleDates).toHaveLength(31);
    expect(scope.eligibleDates[0]).toBe('2026-03-01');
    expect(scope.eligibleDates[30]).toBe('2026-03-31');
  });

  it('uses full month regardless of analysisRange.from — narrow range does not clip month start', () => {
    // Even when the analysis range is just one week, month avg sees all of March up to anchor.
    const narrowRange: AnalysisRange = { from: '2026-03-16', to: '2026-03-21' };
    const scope = resolveColumnScope(col, ANCHOR, narrowRange);
    expect(scope.eligibleDates[0]).toBe('2026-03-01'); // starts at month start, not range start
    expect(scope.eligibleDates).toHaveLength(21);
  });
});

describe('computeFetchRange', () => {
  it('pure analysis range with no columns adds ±1 day buffer', () => {
    const fr = computeFetchRange(RANGE_WEEK, [], ANCHOR);
    // from: 2026-03-16 − 1 = 2026-03-15
    // to:   2026-03-22 + 2 = 2026-03-24
    expect(fr.calendarFrom).toBe('2026-03-15');
    expect(fr.calendarTo).toBe('2026-03-24');
  });

  it('rolling-30 column extends fetch range further back than analysisRange', () => {
    const roll30: ColumnSpec = { kind: 'rolling-average', id: 'r30', label: '30d', windowDays: 30 };
    const fr = computeFetchRange(RANGE_WEEK, [roll30], ANCHOR);
    // Rolling 30 needs back to 2026-02-20; calendarFrom = 2026-02-19
    expect(fr.calendarFrom).toBe('2026-02-19');
    expect(fr.calendarTo).toBe('2026-03-24'); // latest = 2026-03-22 (RANGE_WEEK.to)
  });

  it('today/yesterday columns within analysis range do not extend the range', () => {
    const cols: ColumnSpec[] = [
      { kind: 'today',     id: 't', label: 'Today' },
      { kind: 'yesterday', id: 'y', label: 'Yesterday' },
    ];
    // RANGE_28 already includes today (2026-03-21) and yesterday (2026-03-20)
    const fr = computeFetchRange(RANGE_28, cols, ANCHOR);
    expect(fr.calendarFrom).toBe(computeFetchRange(RANGE_28, [], ANCHOR).calendarFrom);
    expect(fr.calendarTo).toBe(computeFetchRange(RANGE_28, [], ANCHOR).calendarTo);
  });
});
