/**
 * Widget System v2 — Chart Mapper
 *
 * Maps an IntermediateTable (the generic aggregated data from the executor)
 * to a chart-specific output format that the frontend can render directly.
 *
 * Each chart type has a dedicated mapper.  They all read from the same
 * IntermediateTable but reshape the data for the chart's needs.
 *
 * Chart-specific output types are separate from the intermediate table
 * because some charts genuinely need different shapes:
 *   - KPI is just scalar numbers, no axes
 *   - Table is a 2D grid (rows × cols)
 *   - Bar/line/donut are 1D or 2D series
 *   - Stacked bar needs both x and series
 */

import type { IntermediateTable, IntermediateRow, PlotSpec, PlotType, FormatType } from './ast';

// ─────────────────────────────────────────────────────────────
// Presentation metadata (format + color hints for the renderer)
// ─────────────────────────────────────────────────────────────

/**
 * Per-measure presentation hints derived from the plot spec's `format` and
 * `color` blocks.  Passed through to the frontend alongside ChartOutput so
 * renderers can apply consistent formatting and color overrides.
 */
export interface ChartPresentation {
  /** measure/series name → FormatType (absent = use default smart formatter) */
  format: Record<string, FormatType>;
  /** measure/series name → CSS color string (absent = use default palette) */
  color: Record<string, string>;
  /**
   * Hint: measures whose expression is a pure single `time("X")` (or `timeUnder("X")`,
   * or `time("X/sub")`) call, mapped to the base letter X. The frontend uses this
   * to default-color the series with the user's configured tag color (only when no
   * explicit `color` override is set).
   */
  measureTimeTags?: Record<string, string>;
}

// ─────────────────────────────────────────────────────────────
// Output types (consumed by the frontend)
// ─────────────────────────────────────────────────────────────

export interface KpiOutput {
  type: 'kpi';
  values: KpiValue[];
}

export interface KpiValue {
  role: string;     // e.g. "primary", "secondary", custom role name
  label: string;    // measure name — used for format/color lookup
  /** Measure name (alias). Kept explicit to decouple format lookup from label. */
  measure: string;
  value: number | null;
}

export interface BarOutput {
  type: 'bar';
  series: BarSeries[];
  /** Measure name for the y axis — used for format/color lookup */
  yMeasure: string;
}

export interface BarSeries {
  /** Value of the x dimension */
  x: string | null;
  /** Computed measure value */
  y: number | null;
}

export interface StackedBarOutput {
  type: 'stacked_bar';
  /** All unique x values, in order (null = unknown) */
  xValues: (string | null)[];
  /** All unique series values, in order (null = unknown) */
  seriesValues: (string | null)[];
  /** series → x → value */
  data: { series: string | null; x: string | null; y: number | null }[];
  /** Measure name for the stacked y axis — used for format/color lookup */
  yMeasure: string;
}

export interface LineSeries {
  /** Measure name — used as the legend label in multi-series charts */
  name: string;
  points: { x: string | null; y: number | null }[];
}

export interface LineOutput {
  type: 'line';
  series: LineSeries[];
}

export interface HBarOutput {
  type: 'hbar';
  /** Sorted descending by value */
  bars: { category: string | null; value: number | null }[];
  /** Measure name for the value — used for format/color lookup */
  valueMeasure: string;
}

export interface DonutOutput {
  type: 'donut';
  slices: { category: string | null; value: number | null }[];
  /** Measure name for the value — used for format/color lookup */
  valueMeasure: string;
}

export interface RankedListRow {
  label: string | null;
  primary: number | null;
  /** 0–1: primary / max(primary) across all rows — drives the progress bar */
  share: number;
  secondary: { name: string; value: number | null }[];
}

export interface RankedListOutput {
  type: 'ranked_list';
  /** Sorted descending by primary value */
  rows: RankedListRow[];
  /** Name of the primary measure — used as column header */
  primaryName: string;
  /** Names of the secondary measures, in order — used as column headers */
  secondaryNames: string[];
  /**
   * Pre-computed total row: ungrouped aggregate over the full dataset.
   * Undefined only if the executor did not produce a totalRow.
   */
  totalRow?: RankedListRow;
}

export interface TableOutput {
  type: 'table';
  /** Ordered column headers (dimension values for the cols dimension, or ["Value"]) */
  cols: string[];
  /** One row per distinct 'rows' dimension value */
  rows: TableOutputRow[];
  /** Measure name for cell values — used for format/color lookup (2D case) */
  valueMeasure: string;
}

export interface TableOutputRow {
  label: string | null;
  /** Values aligned to the cols array */
  values: (number | null)[];
}

export type ChartOutput =
  | KpiOutput
  | BarOutput
  | StackedBarOutput
  | LineOutput
  | DonutOutput
  | HBarOutput
  | RankedListOutput
  | TableOutput;

// ─────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────

/**
 * Map an IntermediateTable and PlotSpec to a frontend-ready ChartOutput.
 * Throws if required roles are missing or data is malformed.
 */
export function mapToChart(table: IntermediateTable, plot: PlotSpec): ChartOutput {
  switch (plot.type) {
    case 'kpi':         return mapKpi(table, plot);
    case 'bar':         return mapBar(table, plot);
    case 'stacked_bar': return mapStackedBar(table, plot);
    case 'line':        return mapLine(table, plot);
    case 'donut':       return mapDonut(table, plot);
    case 'hbar':        return mapHBar(table, plot);
    case 'ranked_list': return mapRankedList(table, plot);
    case 'table':       return mapTable(table, plot);
    default: {
      const _exhaust: never = plot.type;
      throw new Error(`Unknown plot type: ${(plot as any).type}`);
    }
  }
}

// ─────────────────────────────────────────────────────────────
// KPI
// ─────────────────────────────────────────────────────────────

function mapKpi(table: IntermediateTable, plot: PlotSpec): KpiOutput {
  // KPI is typically a scalar widget (no group dims, one row).
  // Each role in the plot spec maps to a measure (or list of measures).
  const row = table.rows[0] ?? {};

  const values: KpiValue[] = [];
  for (const [role, target] of Object.entries(plot.roles)) {
    if (Array.isArray(target)) {
      // secondary: [total, ratio] → one entry per measure, using the measure name as label
      for (const t of target) {
        values.push({ role: t, label: t, measure: t, value: toNumber(row[t]) });
      }
    } else {
      values.push({ role, label: target, measure: target, value: toNumber(row[target]) });
    }
  }

  return { type: 'kpi', values };
}

// ─────────────────────────────────────────────────────────────
// Bar
// ─────────────────────────────────────────────────────────────

function mapBar(table: IntermediateTable, plot: PlotSpec): BarOutput {
  const xRole = requireRole(plot, 'x');
  const yRole = requireRole(plot, 'y');

  const series: BarSeries[] = table.rows.map(row => ({
    x:  toString(row[xRole]),
    y:  toNumber(row[yRole]),
  }));

  return { type: 'bar', series, yMeasure: yRole };
}

// ─────────────────────────────────────────────────────────────
// Stacked Bar
// ─────────────────────────────────────────────────────────────

function mapStackedBar(table: IntermediateTable, plot: PlotSpec): StackedBarOutput {
  const xRole      = requireRole(plot, 'x');
  const seriesRole = requireRole(plot, 'series');
  const yRole      = requireRole(plot, 'y');

  const xValues = uniqueOrdered(table.rows.map(r => toString(r[xRole])));
  const seriesValues = uniqueOrdered(table.rows.map(r => toString(r[seriesRole])));

  const data = table.rows.map(row => ({
    x:      toString(row[xRole]),
    series: toString(row[seriesRole]),
    y:      toNumber(row[yRole]),
  }));

  return { type: 'stacked_bar', xValues, seriesValues, data, yMeasure: yRole };
}

// ─────────────────────────────────────────────────────────────
// Line
// ─────────────────────────────────────────────────────────────

function mapLine(table: IntermediateTable, plot: PlotSpec): LineOutput {
  const xRole = requireRole(plot, 'x');
  const yRaw = plot.roles['y'];

  if (Array.isArray(yRaw)) {
    // Multi-series: y: [measure1, measure2, ...]
    const series: LineSeries[] = yRaw.map(yRole => ({
      name: yRole,
      points: table.rows.map(row => ({
        x: toString(row[xRole]),
        y: toNumber(row[yRole]),
      })),
    }));
    return { type: 'line', series };
  }

  // Single series
  const yRole = requireRole(plot, 'y');
  return {
    type: 'line',
    series: [{
      name: yRole,
      points: table.rows.map(row => ({
        x: toString(row[xRole]),
        y: toNumber(row[yRole]),
      })),
    }],
  };
}

// ─────────────────────────────────────────────────────────────
// Donut
// ─────────────────────────────────────────────────────────────

function mapDonut(table: IntermediateTable, plot: PlotSpec): DonutOutput {
  const catRole = requireRole(plot, 'category');
  const valRole = requireRole(plot, 'value');

  const slices = table.rows.map(row => ({
    category: toString(row[catRole]),
    value:    toNumber(row[valRole]),
  }));

  return { type: 'donut', slices, valueMeasure: valRole };
}

// ─────────────────────────────────────────────────────────────
// Horizontal Bar
// ─────────────────────────────────────────────────────────────

function mapHBar(table: IntermediateTable, plot: PlotSpec): HBarOutput {
  const catRole = requireRole(plot, 'category');
  const valRole = requireRole(plot, 'value');

  const bars = table.rows
    .map(row => ({
      category: toString(row[catRole]),
      value:    toNumber(row[valRole]),
    }))
    .sort((a, b) => (b.value ?? 0) - (a.value ?? 0));

  return { type: 'hbar', bars, valueMeasure: valRole };
}

// ─────────────────────────────────────────────────────────────
// Ranked List
// ─────────────────────────────────────────────────────────────

function mapRankedList(table: IntermediateTable, plot: PlotSpec): RankedListOutput {
  const labelRole   = requireRole(plot, 'label');
  const primaryRole = requireRole(plot, 'primary');
  const secRaw      = plot.roles['secondary'];
  const secNames: string[] = Array.isArray(secRaw) ? secRaw : (secRaw ? [secRaw] : []);

  // Build rows sorted descending by primary
  const rows: RankedListRow[] = table.rows
    .map(row => ({
      label:     toString(row[labelRole]),
      primary:   toNumber(row[primaryRole]),
      share:     0,   // filled in below
      secondary: secNames.map(name => ({ name, value: toNumber(row[name]) })),
    }))
    .sort((a, b) => (b.primary ?? 0) - (a.primary ?? 0));

  // Compute share relative to the top row
  const max = rows[0]?.primary ?? 0;
  if (max > 0) {
    for (const row of rows) {
      row.share = (row.primary ?? 0) / max;
    }
  }

  // Total row: use the pre-computed ungrouped aggregate when available.
  // This ensures derived measures (ratios, etc.) are correctly re-evaluated
  // over the full dataset rather than summed across groups.
  let totalRow: RankedListRow | undefined;
  if (table.totalRow) {
    totalRow = {
      label:     'Total',
      primary:   toNumber(table.totalRow[primaryRole]),
      share:     1,
      secondary: secNames.map(name => ({ name, value: toNumber(table.totalRow![name]) })),
    };
  }

  return { type: 'ranked_list', rows, primaryName: primaryRole, secondaryNames: secNames, totalRow };
}

// ─────────────────────────────────────────────────────────────
// Table
// ─────────────────────────────────────────────────────────────

function mapTable(table: IntermediateTable, plot: PlotSpec): TableOutput {
  const rowsRole = requireRole(plot, 'rows');
  const valRole  = requireRole(plot, 'value');
  const colsRoleRaw = plot.roles['cols'];
  const colsRole = (typeof colsRoleRaw === 'string' ? colsRoleRaw : null);

  if (colsRole) {
    // 2D table: rows × cols
    const rowLabels: (string | null)[] = uniqueOrdered(table.rows.map(r => toString(r[rowsRole])));
    const colLabels: (string | null)[] = uniqueOrdered(table.rows.map(r => toString(r[colsRole])));

    // Build a lookup: rowLabel → colLabel → value
    const lookup = new Map<string, Map<string, number | null>>();
    for (const row of table.rows) {
      const rk = toString(row[rowsRole]) ?? '';
      const ck = toString(row[colsRole]) ?? '';
      if (!lookup.has(rk)) lookup.set(rk, new Map());
      lookup.get(rk)!.set(ck, toNumber(row[valRole]));
    }

    const rows: TableOutputRow[] = rowLabels.map(rl => ({
      label: rl,
      values: colLabels.map(cl => lookup.get(rl ?? '')?.get(cl ?? '') ?? null),
    }));

    return { type: 'table', cols: colLabels.map((c): string => c ?? ''), rows, valueMeasure: valRole };
  } else {
    // 1D table: rows only, single value column
    const rows: TableOutputRow[] = table.rows.map(row => ({
      label: toString(row[rowsRole]),
      values: [toNumber(row[valRole])],
    }));
    return { type: 'table', cols: [valRole], rows, valueMeasure: valRole };
  }
}

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

function requireRole(plot: PlotSpec, role: string): string {
  const target = plot.roles[role];
  if (!target || Array.isArray(target)) throw new Error(`Plot spec is missing required role '${role}'`);
  return target;
}

function toNumber(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return isNaN(v) ? null : v;
  const n = parseFloat(v);
  return isNaN(n) ? null : n;
}

function toString(v: string | number | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  return String(v);
}

function uniqueOrdered<T>(items: T[]): T[] {
  const seen = new Set<T>();
  const result: T[] = [];
  for (const item of items) {
    if (!seen.has(item)) {
      seen.add(item);
      result.push(item);
    }
  }
  return result;
}
