// ─── Branded date aliases ─────────────────────────────────────────────────────

/**
 * Calendar date string (YYYY-MM-DD) from entries.timestamp (local time).
 * Reflects the wall-clock date on which the record was stored.
 */
export type CalendarDate = string;

/**
 * Analytical date string (YYYY-MM-DD) after applying the 05:00 day boundary.
 * A timing whose normalised start is before 05:00 shifts back one calendar day.
 * All engine logic works exclusively on AnalyticalDate.
 */
export type AnalyticalDate = string;

/** The minute-of-day at which the analytical day begins (05:00 = 300). */
export const DAY_BOUNDARY_MINUTES = 300;

// ─── Stripe configuration ─────────────────────────────────────────────────────

export interface StripeConfig {
  /** First stripe's start in minutes from midnight (use DAY_BOUNDARY_MINUTES for standard layout). */
  startMinute: number;
  /** Width of each stripe in minutes, e.g. 60, 90, 120. */
  sizeMinutes: number;
  /**
   * Number of stripes to generate.
   * Defaults to ceil(1440 / sizeMinutes) so a full 24-hour period is covered.
   */
  count?: number;
}

export interface Stripe {
  index: number;
  /** Absolute minutes from midnight of the analytical date. */
  startMinute: number;
  endMinute: number;
  /** Human-readable label for the stripe start time, e.g. "05:00". */
  label: string;
}

// ─── Analysis range ───────────────────────────────────────────────────────────

/**
 * Declarative, serialisable spec for the range the user is analysing.
 * Resolved to a concrete AnalysisRange by resolveAnalysisRange().
 */
export type AnalysisRangeSpec =
  | { kind: 'last-n-days'; days: number }
  | { kind: 'last-n-weeks'; weeks: number }
  | { kind: 'this-week' }
  | { kind: 'this-month' }
  | { kind: 'custom'; from: AnalyticalDate; to: AnalyticalDate };

/** Resolved analysis range: a concrete [from, to] inclusive pair of analytical dates. */
export interface AnalysisRange {
  from: AnalyticalDate; // inclusive
  to: AnalyticalDate;   // inclusive
}

// ─── Fetch range ──────────────────────────────────────────────────────────────

/**
 * The actual calendar-date interval for GET /api/timings.
 * Computed by computeFetchRange() — never constructed manually.
 *
 * calendarFrom is inclusive (gte); calendarTo is exclusive (lt).
 * The buffer accounts for the 05:00 analytical-day boundary:
 *   calendarFrom = (earliest required analytical date) − 1 calendar day
 *   calendarTo   = (latest required analytical date)  + 2 calendar days
 */
export interface FetchRange {
  calendarFrom: CalendarDate;
  calendarTo: CalendarDate;
}

// ─── Column specification (declarative discriminated union) ───────────────────

export type ColumnSpec =
  | TodayColumn
  | YesterdayColumn
  | WeekdayAverageColumn
  | RollingAverageColumn
  | WorkdayAverageColumn
  | WeekendAverageColumn
  | AnalysisRangeAverageColumn
  | ThisWeekAverageColumn
  | ThisMonthAverageColumn;

/** Anchor-relative. Single day = analyticalDateOfInstant(anchorDate). Denominator: 1. */
export interface TodayColumn {
  kind: 'today';
  id: string;
  label: string;
}

/** Anchor-relative. Single day = analyticalDateOfInstant(anchorDate) − 1 day. Denominator: 1. */
export interface YesterdayColumn {
  kind: 'yesterday';
  id: string;
  label: string;
}

/**
 * Analysis-range-scoped.
 * Eligible = all analytical days in analysisRange that fall on `weekday`.
 * Denominator = count of that weekday in the range (even if some have no data).
 */
export interface WeekdayAverageColumn {
  kind: 'weekday-average';
  id: string;
  label: string;
  /** 0 = Sunday, 1 = Monday, …, 6 = Saturday */
  weekday: 0 | 1 | 2 | 3 | 4 | 5 | 6;
}

/**
 * Anchor-relative.
 * Eligible = [anchorDate − windowDays + 1 … anchorDate] as analytical dates.
 * Denominator = windowDays (always fixed — never reduced for days without data).
 * May extend earlier than analysisRange.from.
 */
export interface RollingAverageColumn {
  kind: 'rolling-average';
  id: string;
  label: string;
  windowDays: number;
}

/**
 * Analysis-range-scoped. Eligible = all Mon–Fri analytical days in analysisRange.
 * Denominator = count of Mon–Fri days in the range.
 */
export interface WorkdayAverageColumn {
  kind: 'workday-average';
  id: string;
  label: string;
}

/**
 * Analysis-range-scoped. Eligible = all Sat–Sun analytical days in analysisRange.
 * Denominator = count of Sat–Sun days in the range.
 */
export interface WeekendAverageColumn {
  kind: 'weekend-average';
  id: string;
  label: string;
}

/**
 * Analysis-range-scoped. Eligible = all analytical days in analysisRange regardless of weekday.
 * Denominator = count of all days in the range (after weekday filter, if applied by the caller).
 * Used for the "avg total" column in the weekly table.
 */
export interface AnalysisRangeAverageColumn {
  kind: 'analysis-range-average';
  id: string;
  label: string;
}

/**
 * Anchor-relative.
 * Eligible = Monday…Sunday of the ISO week that contains the anchor's analytical date,
 * intersected with [analysisRange.from, analysisRange.to]. Future days beyond the anchor
 * are also excluded (those days have no data yet).
 * Denominator = eligible.length.
 *
 * Used for the "Avg week" column — the current/selected week's per-day average,
 * rather than a rolling 7-day window.
 */
export interface ThisWeekAverageColumn {
  kind: 'this-week-average';
  id: string;
  label: string;
}

/**
 * Anchor-relative.
 * Eligible = every day of the calendar month that contains the anchor's analytical date,
 * intersected with [analysisRange.from, analysisRange.to]. Future days beyond the anchor
 * are also excluded (those days have no data yet).
 * Denominator = eligible.length.
 *
 * Used for the "Avg month" column — the current/selected month's per-day average,
 * rather than a rolling 30-day window.
 */
export interface ThisMonthAverageColumn {
  kind: 'this-month-average';
  id: string;
  label: string;
}

// ─── View mode ────────────────────────────────────────────────────────────────

/**
 * Display mode for the Time Patterns view.
 *
 * 'regular'          – raw per-stripe per-day averages.
 * 'cumulative'       – per-column cumulative down stripes; no cross-column carry.
 * 'cumulative-week'  – per-column cumulative + cumulative across Mon→Sun weekday
 *                      columns; avg columns still cumulate per-column only.
 */
export type ViewMode = 'regular' | 'cumulative' | 'cumulative-week';

// ─── Resolved column scope ────────────────────────────────────────────────────

/**
 * Result of resolveColumnScope(): concrete eligible dates and denominator for one column.
 *
 * scopeKind makes the derivation explicit:
 *   'analysis-range'  – eligible dates are a filtered subset of analysisRange
 *   'anchor-relative' – eligible dates are derived from anchorDate only;
 *                       they may fall outside analysisRange
 */
export interface ResolvedColumnScope {
  columnId: string;
  scopeKind: 'analysis-range' | 'anchor-relative';
  eligibleDates: AnalyticalDate[];
  /** Denominator to use when averaging. 0 means no eligible dates. */
  denominator: number;
}

// ─── Label selector ───────────────────────────────────────────────────────────

/**
 * Selects time-label values from a timeLabels record.
 *
 * 'exact'        – matches the label key exactly (mirrors DSL time("t"))
 * 'prefix'       – matches the label or any child (mirrors DSL timeUnder("m"),
 *                  e.g. prefix "m" matches "m", "m/thk", "m/sw")
 * 'multi-prefix' – union of several prefix selectors (e.g. ["t","m"] = t + meetings)
 * 'any'          – sum of all labels in the record
 */
export type LabelSelector =
  | { kind: 'exact'; label: string }
  | { kind: 'prefix'; prefix: string }
  | { kind: 'multi-prefix'; prefixes: string[] }
  | { kind: 'any' };

// ─── Metric specification ─────────────────────────────────────────────────────

/**
 * Declares what value a metric cell should display.
 * Declarative — no extract function embedded in the type.
 * Phase 1 supports duration and label selectors only.
 */
export type MetricSource =
  | { kind: 'duration' }
  | { kind: 'label'; selector: LabelSelector }
  /**
   * Ratio of two label sums computed from the aggregated bucket — NOT divided by
   * the column's day-count denominator. Suitable for productivity ratios like
   * net_productivity = sum(t) / sum(t + m + p). Result is [0, 1].
   */
  | { kind: 'label-ratio'; numerator: LabelSelector; denominator: LabelSelector | 'duration' };

export interface MetricSpec {
  id: string;
  label: string;
  source: MetricSource;
  /** Controls value formatting. 'ratio' metrics display as percentages (0–100%). */
  unit?: 'minutes' | 'ratio';
  colorScale?: ColorScaleSpec;
}

export interface ColorScaleSpec {
  type: 'linear' | 'quantile';
  /** Fixed domain [min, max]. Defaults to [0, observed max in matrix]. */
  domain?: [number, number];
  colorFrom?: string; // CSS color, default "#ffffff"
  colorTo?: string;   // CSS color, default "#2563eb"
}

// ─── Raw timing (engine-intake shape) ────────────────────────────────────────

/**
 * A TIM entry after being fetched and processed by the intake layer.
 * The intake layer computes analyticalDate; nothing downstream touches raw timestamps.
 */
export interface RawTiming {
  id: number;
  /** Calendar date from entries.timestamp (YYYY-MM-DD, local time). */
  calendarDate: CalendarDate;
  /**
   * Analytical date after applying DAY_BOUNDARY_MINUTES.
   * Computed by toAnalyticalDate(calendarDate, timeInit).
   */
  analyticalDate: AnalyticalDate;
  /**
   * Minutes from midnight of calendarDate.
   * May exceed 1440 for post-midnight timings (e.g. 1470 = 00:30 on calendarDate+1).
   */
  timeInit: number;
  timeEnd: number;
  /**
   * Time-label values for this timing.
   * Keys mirror entries.subdivision of child attribute entries (e.g. "t", "m", "m/thk").
   * Values are minutes. Sum may be less than (timeEnd − timeInit) if time is unlabelled.
   */
  timeLabels: Record<string, number>;
}

// ─── Stripe fragment ──────────────────────────────────────────────────────────

/**
 * The portion of one RawTiming that intersects one Stripe.
 * All timeLabel values are distributed proportionally to the fragment's duration:
 *   fragmentLabel = originalLabel × (durationMinutes / timingDuration)
 */
export interface StripeFragment {
  timingId: number;
  analyticalDate: AnalyticalDate;
  stripeIndex: number;
  durationMinutes: number;
  timeLabels: Record<string, number>;
}

// ─── Aggregated results ───────────────────────────────────────────────────────

/**
 * Aggregated raw sums for one (stripeIndex, columnId) cell.
 * Never pre-divided — the denominator lives in IntradayMatrix.columnDenominators.
 */
export interface BucketAggregate {
  stripeIndex: number;
  columnId: string;
  /** Sum of fragment durations across all contributing analytical days. */
  totalDurationMinutes: number;
  /** Summed time-label minutes across all contributing fragments. */
  timeLabels: Record<string, number>;
  /** Number of StripeFragments that contributed. */
  fragmentCount: number;
}

/** Aggregated values for one analytical day. Used by Daily Grid — no stripe splitting. */
export interface DailyAggregate {
  analyticalDate: AnalyticalDate;
  totalDurationMinutes: number;
  timeLabels: Record<string, number>;
  timingCount: number;
}

// ─── Engine output ────────────────────────────────────────────────────────────

export interface IntradayMatrix {
  stripes: Stripe[];
  columns: ColumnSpec[];
  /**
   * Denominator for each column (eligible day count for that column's scope).
   * For single-day columns: 1. For weekday-average(Mon, 4-week range): 4. Etc.
   * Key: column.id
   */
  columnDenominators: Record<string, number>;
  /**
   * Key format: `${stripeIndex}:${columnId}`
   * Absent key = zero data for that cell (treat as null / 0 depending on display).
   */
  cells: Map<string, BucketAggregate>;
}

export interface DailyMatrix {
  /** All analytical dates in the requested range, ordered ascending. */
  dates: AnalyticalDate[];
  /** Dates with no timings are absent from this map. */
  byDate: Map<AnalyticalDate, DailyAggregate>;
}

// ─── Top-level view config ────────────────────────────────────────────────────

/**
 * Complete configuration for the Time Patterns view.
 * Do not construct FetchRange manually — always call computeFetchRange(config).
 */
export interface TimePatternsConfig {
  userId: string;
  anchorDate: Date;
  /** Declarative range the user is analysing. Scoped columns operate within this. */
  analysisRange: AnalysisRangeSpec;
  stripeConfig: StripeConfig;
  /** Ordered column specs. May include anchor-relative columns outside analysisRange. */
  columns: ColumnSpec[];
  metric: MetricSpec;
}
