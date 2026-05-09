import { resolveAnalysisRange, addDays, getAnalyticalWeekday } from '@time-patterns/analyticalCalendar';
import { resolveColumnScope, computeFetchRange } from '@time-patterns/columnSpec';
import { buildStripes } from '@time-patterns/stripeEngine';
import { aggregateIntraday } from '@time-patterns/intradayAggregator';
import { aggregateDaily } from '@time-patterns/dailyAggregator';
import { adaptApiTimingsToRawTimings } from '@time-patterns/intake';
import type {
  TimePatternsConfig,
  IntradayMatrix,
  DailyMatrix,
  AnalysisRange,
  AnalyticalDate,
  ResolvedColumnScope,
  ColumnSpec,
  MetricSpec,
  MetricSource,
  LabelSelector,
} from '@time-patterns/types';

// ─── Fixed column sets ────────────────────────────────────────────────────────

/** All seven weekday-average columns in Mon–Sun order. */
export const ALL_WEEKDAY_COLS: ColumnSpec[] = [
  { kind: 'weekday-average', id: 'mon', label: 'Mon', weekday: 1 },
  { kind: 'weekday-average', id: 'tue', label: 'Tue', weekday: 2 },
  { kind: 'weekday-average', id: 'wed', label: 'Wed', weekday: 3 },
  { kind: 'weekday-average', id: 'thu', label: 'Thu', weekday: 4 },
  { kind: 'weekday-average', id: 'fri', label: 'Fri', weekday: 5 },
  { kind: 'weekday-average', id: 'sat', label: 'Sat', weekday: 6 },
  { kind: 'weekday-average', id: 'sun', label: 'Sun', weekday: 0 },
];

const AVG_WEEK_COL:  ColumnSpec = { kind: 'this-week-average',     id: 'avg-week',  label: 'Avg week'  };
const AVG_MONTH_COL: ColumnSpec = { kind: 'this-month-average',    id: 'avg-month', label: 'Avg month' };
const AVG_TOTAL_COL: ColumnSpec = { kind: 'analysis-range-average', id: 'avg-total', label: 'Avg total' };

/** Column IDs that are "average" columns (not per-weekday). */
export const AVG_COLUMN_IDS = ['avg-week', 'avg-month', 'avg-total'] as const;

/** Line-chart columns for Regular/Cumulative mode. */
const LINE_TODAY_COL:      ColumnSpec = { kind: 'today',              id: 'lc-today',      label: 'Selected day' };
const LINE_AVG_WEEK_COL:   ColumnSpec = { kind: 'this-week-average',  id: 'lc-avg-week',   label: 'Avg week'     };
const LINE_AVG_MONTH_COL:  ColumnSpec = { kind: 'this-month-average', id: 'lc-avg-month',  label: 'Avg month'    };

// ─── Metric presets (dynamic) ─────────────────────────────────────────────────

/**
 * Built-in presets that always exist regardless of user config.
 * (User-letter presets and TIM-formula presets are appended at runtime.)
 */
const BUILTIN_PRESETS: MetricSpec[] = [
  {
    id: 'duration',
    label: 'Total duration',
    source: { kind: 'duration' },
    unit: 'minutes',
  },
];

/**
 * Try to parse a TIM formula expression into a `MetricSource`.
 *
 * Supports the common ratio shapes used in productivity formulas:
 *   self.time("X") / self.duration
 *   self.time("X") / (self.time("Y") + self.time("Z") + ...)
 *   (self.time("X") + self.time("Y")) / (self.time("Z") + self.time("W"))
 *
 * Returns null if the formula uses anything outside this grammar
 * (e.g. constants, references to other metrics, subtraction).
 */
export function parseFormulaToMetricSource(formula: string): MetricSource | null {
  // Strip whitespace; keep parens.
  const expr = formula.trim();
  // Find the top-level '/'. We only support a single division at the top level.
  const div = findTopLevelOp(expr, '/');
  if (div === -1) return null;
  const num = parseSum(expr.slice(0, div));
  const denRaw = expr.slice(div + 1).trim();
  if (!num) return null;
  const den = parseSumOrDuration(denRaw);
  if (!den) return null;
  return { kind: 'label-ratio', numerator: num, denominator: den };
}

function stripOuter(s: string): string {
  let x = s.trim();
  while (x.startsWith('(') && x.endsWith(')') && balancedAtBoundary(x)) {
    x = x.slice(1, -1).trim();
  }
  return x;
}

/** Returns true if the outermost parens enclose the whole expression. */
function balancedAtBoundary(s: string): boolean {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')') {
      depth--;
      if (depth === 0 && i < s.length - 1) return false;
    }
  }
  return depth === 0;
}

/** Index of the rightmost top-level occurrence of `op`, or -1 if none. */
function findTopLevelOp(s: string, op: string): number {
  let depth = 0;
  let last = -1;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === op && depth === 0) last = i;
  }
  return last;
}

function splitTopLevelPlus(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === '+' && depth === 0) {
      parts.push(s.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(s.slice(start));
  return parts.map(p => p.trim());
}

function parseSum(s: string): LabelSelector | null {
  const stripped = stripOuter(s);
  if (!stripped) return null;
  const parts = splitTopLevelPlus(stripped);
  const labels: string[] = [];
  for (const part of parts) {
    const lbl = parseTimeCall(part);
    if (lbl === null) return null;
    labels.push(lbl);
  }
  if (labels.length === 0) return null;
  if (labels.length === 1) return { kind: 'prefix', prefix: labels[0] };
  return { kind: 'multi-prefix', prefixes: labels };
}

function parseSumOrDuration(s: string): LabelSelector | 'duration' | null {
  const stripped = stripOuter(s);
  if (/^self\.duration$/.test(stripped)) return 'duration';
  return parseSum(stripped);
}

/** Match `self.time("x")` or `self.time("x/sub")` and return the label. */
function parseTimeCall(s: string): string | null {
  const m = stripOuter(s).match(/^self\.time\("([^"]+)"\)$/);
  return m ? m[1] : null;
}

/**
 * Build the dropdown's metric presets at runtime from the user's settings
 * and the current TIM definition's formula attributes.
 *
 * Order:
 *   1. One preset per user-configured letter (label = settings name + "(letter)")
 *   2. Total duration (built-in)
 *   3. Each TIM formula attribute whose formula parses as a label-ratio
 */
export function buildMetricPresets(opts: {
  timeTags: Array<{ letter: string; name: string }>;
  timFormulaAttrs: Array<{ internalName: string; displayName: string; formula: string }>;
}): MetricSpec[] {
  const letterPresets: MetricSpec[] = opts.timeTags.map(t => ({
    id: t.letter,
    label: `${t.name || t.letter} (${t.letter})`,
    source: { kind: 'label', selector: { kind: 'prefix', prefix: t.letter } },
    unit: 'minutes',
  }));

  const formulaPresets: MetricSpec[] = [];
  for (const f of opts.timFormulaAttrs) {
    const source = parseFormulaToMetricSource(f.formula);
    if (!source) continue;
    formulaPresets.push({
      id: f.internalName,
      label: f.displayName || f.internalName,
      source,
      unit: 'ratio',
    });
  }

  return [...letterPresets, ...BUILTIN_PRESETS, ...formulaPresets];
}

/** Hardcoded fallback used until settings/schema load on first render. */
export const FALLBACK_METRIC_PRESETS: MetricSpec[] = [
  ...BUILTIN_PRESETS,
];

export const DEFAULT_METRIC_ID = 'duration';

// ─── Default config ───────────────────────────────────────────────────────────

export function buildDefaultConfig(anchorDate: Date): TimePatternsConfig {
  return {
    userId: '',  // not used client-side
    anchorDate,
    analysisRange: { kind: 'last-n-days', days: 28 },
    stripeConfig: { startMinute: 540, sizeMinutes: 60 },
    columns: ALL_WEEKDAY_COLS,   // kept for type-compat; actual columns built in loadMatrices
    metric: FALLBACK_METRIC_PRESETS.find(m => m.id === DEFAULT_METRIC_ID)!,
  };
}

// ─── Preset type ──────────────────────────────────────────────────────────────

/** Active temporal preset — drives display-only behavior (e.g. hiding avg-total). */
export type ActivePreset = 'day' | 'week' | 'month' | 'year' | 'custom';

// ─── Load result ──────────────────────────────────────────────────────────────

export interface LoadResult {
  /** Section A matrix: enabled weekday cols + avg-week + avg-month (+ avg-total when applicable). */
  matrix: IntradayMatrix;
  /** IDs of the weekday columns actually in `matrix`, in Mon→Sun order. */
  weekdayColumnIds: string[];
  /** Section B matrix: lc-today + lc-avg-week + lc-avg-month (for Regular/Cumulative chart). */
  lineMatrix: IntradayMatrix;
  /**
   * Per-weekday matrices for Cumulative-week chart lines.
   * Computed from the same rawTimings with different analysis range windows.
   * chartMatrix.thisWeek  uses `this-week`  range (Selected week).
   * chartMatrix.thisMonth uses `this-month` range (Avg month).
   */
  chartMatrices: {
    thisWeek:  IntradayMatrix;
    thisMonth: IntradayMatrix;
  };
  /** Section C matrix: daily aggregates. */
  dailyMatrix: DailyMatrix;
  /**
   * The range actually populated in dailyMatrix. Equals analysisRange for most
   * presets; expands to the full anchor calendar month for 'day' and 'week' presets
   * so section C shows a complete month grid with real data.
   */
  dailyRange: AnalysisRange;
  /** Column scopes for section A (used by DrilldownPanel). */
  columnScopes: ResolvedColumnScope[];
  analysisRange: AnalysisRange;
  fetchedCount: number;
}

// ─── Scope adjustment for weekday filter ─────────────────────────────────────

/**
 * For rolling-average and analysis-range-average columns, filter eligible dates
 * to only those weekdays in `enabledWeekdays` and adjust the denominator.
 * Weekday-average columns are skipped — their eligibleDates are already single-weekday.
 */
function applyWeekdayFilterToScopes(
  cols: ColumnSpec[],
  scopes: ResolvedColumnScope[],
  enabledWeekdays: number[],
): ResolvedColumnScope[] {
  return scopes.map((scope, i) => {
    const col = cols[i];
    if (col.kind === 'weekday-average' || col.kind === 'today' || col.kind === 'yesterday') {
      return scope;
    }
    const filtered = scope.eligibleDates.filter(d =>
      enabledWeekdays.includes(getAnalyticalWeekday(d)),
    );
    return { ...scope, eligibleDates: filtered, denominator: filtered.length };
  });
}

// ─── Main loader ──────────────────────────────────────────────────────────────

/**
 * Full pipeline: fetch one date window → adapt → aggregate 5 matrices.
 *
 * enabledWeekdays: weekday indices (0=Sun…6=Sat) that are active.
 *   null = all weekdays enabled (no filter applied).
 *
 * The weekday filter:
 *   1. Removes disabled-weekday columns from section A.
 *   2. Filters rawTimings to only include enabled-weekday timings.
 *      This affects numerators of ALL columns (avg cols only accumulate
 *      enabled-weekday data).
 *   3. Adjusts rolling/range-average column denominators to count only
 *      enabled-weekday eligible dates.
 */
export async function loadMatrices(
  config: TimePatternsConfig,
  analysisRange: AnalysisRange,
  enabledWeekdays: number[] | null,
  activePreset: ActivePreset = 'custom',
): Promise<LoadResult> {

  // ── Section A: weekday cols (filtered) + avg-week + avg-month (+ avg-total) ──
  // avg-total is redundant when the analysis range is already a single week or
  // month (it would equal avg-week / avg-month), so we hide it in those presets.
  const includeAvgTotal = activePreset !== 'week' && activePreset !== 'month';

  const enabledWdCols = enabledWeekdays === null
    ? [...ALL_WEEKDAY_COLS]
    : ALL_WEEKDAY_COLS.filter(c =>
        'weekday' in c && enabledWeekdays.includes((c as { weekday: number }).weekday),
      );

  const sectionACols: ColumnSpec[] = [
    ...enabledWdCols,
    AVG_WEEK_COL,
    AVG_MONTH_COL,
    ...(includeAvgTotal ? [AVG_TOTAL_COL] : []),
  ];

  let sectionAScopes = sectionACols.map(col =>
    resolveColumnScope(col, config.anchorDate, analysisRange),
  );
  if (enabledWeekdays) {
    sectionAScopes = applyWeekdayFilterToScopes(sectionACols, sectionAScopes, enabledWeekdays);
  }

  // ── Line chart columns (Regular/Cumulative mode) ─────────────────────────────
  const lineCols: ColumnSpec[] = [LINE_TODAY_COL, LINE_AVG_WEEK_COL, LINE_AVG_MONTH_COL];
  let lineScopes = lineCols.map(col =>
    resolveColumnScope(col, config.anchorDate, analysisRange),
  );
  if (enabledWeekdays) {
    lineScopes = applyWeekdayFilterToScopes(lineCols, lineScopes, enabledWeekdays);
  }

  // ── Determine fetch range (union of all column eligible dates) ───────────────
  const allCols: ColumnSpec[] = [...sectionACols, ...lineCols];
  const fetchRange = computeFetchRange(analysisRange, allCols, config.anchorDate);

  const params = new URLSearchParams({
    startDate: fetchRange.calendarFrom,
    endDate:   addDays(fetchRange.calendarTo, -1),
  });

  const response = await fetch(`/api/timings?${params}`);
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error ?? `HTTP ${response.status}`);
  }

  const data = await response.json() as { timings: unknown[] };
  const rawTimings = adaptApiTimingsToRawTimings(
    data.timings as Parameters<typeof adaptApiTimingsToRawTimings>[0],
  );
  const fetchedCount = rawTimings.length;

  // ── Apply weekday filter to timings for sections A and B ────────────────────
  // Section C (daily grid) always uses ALL timings so individual days are never
  // silently zeroed out by the weekday filter.
  const timingsForAB = enabledWeekdays
    ? rawTimings.filter(t => enabledWeekdays.includes(getAnalyticalWeekday(t.calendarDate)))
    : rawTimings;

  const stripes = buildStripes(config.stripeConfig);

  // ── Aggregate section A and line matrices ────────────────────────────────────
  const matrix     = aggregateIntraday(timingsForAB, stripes, sectionACols, sectionAScopes);
  const lineMatrix  = aggregateIntraday(timingsForAB, stripes, lineCols, lineScopes);

  // ── Chart matrices for cumulative-week mode (per-weekday avgs, two windows) ──
  // thisWeek  = Selected week  (Mon→Sun of anchor's week, capped at anchor)
  // thisMonth = Avg month      (1st → last day of anchor's month, capped at anchor)
  const thisWeekRange  = resolveAnalysisRange({ kind: 'this-week'  }, config.anchorDate);
  const thisMonthRange = resolveAnalysisRange({ kind: 'this-month' }, config.anchorDate);

  const makeChartScopes = (range: AnalysisRange) =>
    enabledWdCols.map(col => resolveColumnScope(col, config.anchorDate, range));

  const chartMatrices = {
    thisWeek:  aggregateIntraday(timingsForAB, stripes, enabledWdCols, makeChartScopes(thisWeekRange)),
    thisMonth: aggregateIntraday(timingsForAB, stripes, enabledWdCols, makeChartScopes(thisMonthRange)),
  };

  // ── Daily matrix for section C — always uses unfiltered timings ──────────────
  // For Day/Week presets, rawTimings already covers the full anchor month because
  // the this-month-average column forces computeFetchRange to include it. We just
  // need to aggregate over the full month instead of the narrow analysisRange.
  let dailyRange: AnalysisRange = analysisRange;
  if (activePreset === 'day' || activePreset === 'week') {
    const anchor = new Date(config.anchorDate);
    const y  = anchor.getFullYear();
    const mo = anchor.getMonth() + 1; // 1-based
    const lastDay = new Date(Date.UTC(y, mo, 0)).getUTCDate();
    dailyRange = {
      from: `${y}-${String(mo).padStart(2, '0')}-01` as AnalyticalDate,
      to:   `${y}-${String(mo).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}` as AnalyticalDate,
    };
  }
  const dailyMatrix = aggregateDaily(rawTimings, dailyRange);

  const weekdayColumnIds = enabledWdCols.map(c => c.id);

  return {
    matrix,
    weekdayColumnIds,
    lineMatrix,
    chartMatrices,
    dailyMatrix,
    dailyRange,
    columnScopes: sectionAScopes,
    analysisRange,
    fetchedCount,
  };
}
