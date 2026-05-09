import type {
  ColumnSpec,
  AnalysisRange,
  AnalyticalDate,
  ResolvedColumnScope,
  FetchRange,
} from './types';
import {
  addDays,
  analyticalDateOfInstant,
  analyticalDayRange,
  getAnalyticalWeekday,
  isWorkday,
} from './analyticalCalendar';

// ─── Core resolution ──────────────────────────────────────────────────────────

/**
 * Resolve a ColumnSpec to its concrete eligible dates and denominator.
 *
 * Analysis-range-scoped columns (weekday-average, workday-average, weekend-average):
 *   eligible dates are a filtered subset of analysisRange.
 *
 * Anchor-relative columns (today, yesterday, rolling-average):
 *   eligible dates are computed from anchorDate only and may fall outside analysisRange.
 *   The rolling-average denominator is always windowDays (fixed), not eligible.length,
 *   because the window is always fully populated by construction.
 */
export function resolveColumnScope(
  col: ColumnSpec,
  anchorDate: Date,
  analysisRange: AnalysisRange,
): ResolvedColumnScope {
  const anchorAnalytical = analyticalDateOfInstant(anchorDate);

  switch (col.kind) {
    case 'today':
      return {
        columnId: col.id,
        scopeKind: 'anchor-relative',
        eligibleDates: [anchorAnalytical],
        denominator: 1,
      };

    case 'yesterday':
      return {
        columnId: col.id,
        scopeKind: 'anchor-relative',
        eligibleDates: [addDays(anchorAnalytical, -1)],
        denominator: 1,
      };

    case 'weekday-average': {
      const all = analyticalDayRange(analysisRange.from, analysisRange.to);
      const eligible = all.filter(d => getAnalyticalWeekday(d) === col.weekday);
      return {
        columnId: col.id,
        scopeKind: 'analysis-range',
        eligibleDates: eligible,
        // denominator = total occurrences of this weekday in the range
        // (not capped to days that have data)
        denominator: eligible.length,
      };
    }

    case 'rolling-average': {
      // Window always ends on anchorDate (analytical)
      const from = addDays(anchorAnalytical, -(col.windowDays - 1));
      const eligible = analyticalDayRange(from, anchorAnalytical);
      return {
        columnId: col.id,
        scopeKind: 'anchor-relative',
        eligibleDates: eligible,
        // Always windowDays — not days with data, not eligible.length (they're equal here)
        denominator: col.windowDays,
      };
    }

    case 'workday-average': {
      const all = analyticalDayRange(analysisRange.from, analysisRange.to);
      const eligible = all.filter(d => isWorkday(d));
      return {
        columnId: col.id,
        scopeKind: 'analysis-range',
        eligibleDates: eligible,
        denominator: eligible.length,
      };
    }

    case 'weekend-average': {
      const all = analyticalDayRange(analysisRange.from, analysisRange.to);
      const eligible = all.filter(d => {
        const wd = getAnalyticalWeekday(d);
        return wd === 0 || wd === 6;
      });
      return {
        columnId: col.id,
        scopeKind: 'analysis-range',
        eligibleDates: eligible,
        denominator: eligible.length,
      };
    }

    case 'analysis-range-average': {
      const all = analyticalDayRange(analysisRange.from, analysisRange.to);
      return {
        columnId: col.id,
        scopeKind: 'analysis-range',
        eligibleDates: all,
        denominator: all.length,
      };
    }

    case 'this-week-average': {
      // Monday–Sunday of the ISO week containing the anchor, capped at the anchor
      // (no future days). NOT intersected with analysisRange — computeFetchRange
      // will extend the fetch window to cover these dates automatically.
      const wd = getAnalyticalWeekday(anchorAnalytical); // 0=Sun..6=Sat
      const daysToMonday = wd === 0 ? -6 : 1 - wd;
      const weekStart = addDays(anchorAnalytical, daysToMonday);
      const weekEnd   = addDays(weekStart, 6);
      const to = weekEnd < anchorAnalytical ? weekEnd : anchorAnalytical;
      const eligible = analyticalDayRange(weekStart, to);
      return {
        columnId: col.id,
        scopeKind: 'anchor-relative',
        eligibleDates: eligible,
        denominator: eligible.length,
      };
    }

    case 'this-month-average': {
      // All days from the 1st of the anchor's month through the anchor itself.
      // NOT intersected with analysisRange — computeFetchRange will extend the
      // fetch window so the full month's data is loaded.
      const [y, mo] = anchorAnalytical.split('-').map(Number);
      const monthStart: AnalyticalDate = `${y}-${String(mo).padStart(2, '0')}-01`;
      const eligible = analyticalDayRange(monthStart, anchorAnalytical);
      return {
        columnId: col.id,
        scopeKind: 'anchor-relative',
        eligibleDates: eligible,
        denominator: eligible.length,
      };
    }

    default: {
      const _: never = col;
      throw new Error(`Unknown ColumnSpec kind: ${JSON.stringify(_)}`);
    }
  }
}

// ─── Fetch range computation ──────────────────────────────────────────────────

/**
 * Derive the API fetch interval from the full set of column scopes.
 *
 * Takes the union of:
 *   - all analytical dates in analysisRange (always included)
 *   - all eligible dates from every column (rolling columns may extend earlier)
 *
 * Then adds a one-day calendar buffer on each side to handle the 05:00 boundary:
 *   calendarFrom = earliest analytical date − 1 day
 *   calendarTo   = latest analytical date  + 2 days (exclusive end + post-midnight buffer)
 *
 * Note: a rolling-30 column in a 7-day analysisRange will silently cause a 30-day
 * fetch range. This is correct and intentional.
 */
export function computeFetchRange(
  analysisRange: AnalysisRange,
  columns: ColumnSpec[],
  anchorDate: Date,
): FetchRange {
  const all = new Set<AnalyticalDate>();

  // Always include the analysis range
  for (const d of analyticalDayRange(analysisRange.from, analysisRange.to)) {
    all.add(d);
  }

  // Include each column's eligible dates (may extend outside analysis range)
  for (const col of columns) {
    const scope = resolveColumnScope(col, anchorDate, analysisRange);
    for (const d of scope.eligibleDates) {
      all.add(d);
    }
  }

  if (all.size === 0) {
    const today = analyticalDateOfInstant(anchorDate);
    return { calendarFrom: addDays(today, -1), calendarTo: addDays(today, 2) };
  }

  const sorted = Array.from(all).sort() as AnalyticalDate[];
  const earliest = sorted[0];
  const latest = sorted[sorted.length - 1];

  return {
    calendarFrom: addDays(earliest, -1),
    calendarTo: addDays(latest, 2),
  };
}

// ─── Presets ──────────────────────────────────────────────────────────────────

/** All seven weekday-average columns, Mon–Sun. */
export const PRESET_WEEKDAYS: ColumnSpec[] = [
  { kind: 'weekday-average', id: 'mon', label: 'Mon', weekday: 1 },
  { kind: 'weekday-average', id: 'tue', label: 'Tue', weekday: 2 },
  { kind: 'weekday-average', id: 'wed', label: 'Wed', weekday: 3 },
  { kind: 'weekday-average', id: 'thu', label: 'Thu', weekday: 4 },
  { kind: 'weekday-average', id: 'fri', label: 'Fri', weekday: 5 },
  { kind: 'weekday-average', id: 'sat', label: 'Sat', weekday: 6 },
  { kind: 'weekday-average', id: 'sun', label: 'Sun', weekday: 0 },
];

/** Today, yesterday, 7-day rolling average, 30-day rolling average. */
export const PRESET_TODAY_WITH_ROLLING: ColumnSpec[] = [
  { kind: 'today',           id: 'today',     label: 'Today' },
  { kind: 'yesterday',       id: 'yesterday', label: 'Yesterday' },
  { kind: 'rolling-average', id: 'roll7',     label: '7d avg',  windowDays: 7  },
  { kind: 'rolling-average', id: 'roll30',    label: '30d avg', windowDays: 30 },
];

/** Workday average vs weekend average — shows structural week pattern. */
export const PRESET_WEEK_STRUCTURE: ColumnSpec[] = [
  { kind: 'workday-average', id: 'workday', label: 'Workday avg' },
  { kind: 'weekend-average', id: 'weekend', label: 'Weekend avg' },
];
