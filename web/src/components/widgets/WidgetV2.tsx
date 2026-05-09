/**
 * Widget v2 Renderers
 *
 * Consumes the `chart` payload returned by /api/v2/run-widget (or the dashboard endpoint)
 * and renders it using Recharts.  Each renderer is pure: it receives the ChartOutput
 * struct directly and has no API knowledge.
 *
 * Chart types: kpi | bar | stacked_bar | line | donut | table | hbar | ranked_list
 *
 * Optional props:
 *   presentation    — per-series format (duration/number/float) and color overrides
 *   showChartValues — when true, bar and line charts render value labels
 */

import { useMemo } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend, LabelList,
  LineChart, Line, CartesianGrid,
  PieChart, Pie, Cell,
} from 'recharts';
import { fmtValue, fmtAxis, type FormatType } from '../../utils/formatValue';
import { useSettings } from '../settings/SettingsContext';

// ─────────────────────────────────────────────────────────────
// Output types (mirror of chartMapper.ts — kept in-sync manually)
// ─────────────────────────────────────────────────────────────

export interface KpiOutput {
  type: 'kpi';
  values: { role: string; label: string; measure: string; value: number | null }[];
}

export interface BarOutput {
  type: 'bar';
  series: { x: string | null; y: number | null }[];
  yMeasure: string;
}

export interface StackedBarOutput {
  type: 'stacked_bar';
  xValues: (string | null)[];
  seriesValues: (string | null)[];
  data: { series: string | null; x: string | null; y: number | null }[];
  yMeasure: string;
}

export interface LineSeries {
  name: string;
  points: { x: string | null; y: number | null }[];
}

export interface LineOutput {
  type: 'line';
  series: LineSeries[];
}

export interface HBarOutput {
  type: 'hbar';
  bars: { category: string | null; value: number | null }[];
  valueMeasure: string;
}

export interface DonutOutput {
  type: 'donut';
  slices: { category: string | null; value: number | null }[];
  valueMeasure: string;
}

export interface RankedListRow {
  label: string | null;
  primary: number | null;
  share: number;
  secondary: { name: string; value: number | null }[];
}

export interface RankedListOutput {
  type: 'ranked_list';
  rows: RankedListRow[];
  primaryName: string;
  secondaryNames: string[];
  /** Pre-computed ungrouped aggregate — semantically correct total for derived measures */
  totalRow?: RankedListRow;
}

export interface TableOutput {
  type: 'table';
  cols: string[];
  rows: { label: string | null; values: (number | null)[] }[];
  valueMeasure: string;
}

export type ChartOutput = KpiOutput | BarOutput | StackedBarOutput | LineOutput | DonutOutput | HBarOutput | RankedListOutput | TableOutput;

/**
 * Presentation hints — mirrors ChartPresentation from chartMapper.ts.
 * format: measure name → FormatType
 * color:  measure name → CSS color string
 */
export interface ChartPresentation {
  format: Record<string, FormatType>;
  color: Record<string, string>;
  /**
   * Optional hint from the server: measures whose expression is a pure single
   * `time("X")` call, mapped to base letter X. The renderer uses this to
   * default-color the series with the user's tag color (only when no explicit
   * `color` override is set in the DSL).
   */
  measureTimeTags?: Record<string, string>;
  /**
   * Resolved color per single-letter time tag, derived from user settings by
   * the WidgetV2 dispatcher. Pure presentation, never set by the server.
   */
  tagColorByLetter?: Record<string, string>;
}

// ─────────────────────────────────────────────────────────────
// Common helpers
// ─────────────────────────────────────────────────────────────

const DEFAULT_COLORS = [
  '#3b82f6', '#10b981', '#f59e0b', '#ef4444',
  '#8b5cf6', '#06b6d4', '#f97316', '#ec4899',
  '#14b8a6', '#a855f7', '#84cc16', '#f43f5e',
];

/** Named CSS color keywords that the DSL supports */
const CSS_COLOR_KEYWORDS: Record<string, string> = {
  red:    '#ef4444',
  green:  '#10b981',
  blue:   '#3b82f6',
  yellow: '#f59e0b',
  purple: '#8b5cf6',
  cyan:   '#06b6d4',
  orange: '#f97316',
  pink:   '#ec4899',
  teal:   '#14b8a6',
  lime:   '#84cc16',
  rose:   '#f43f5e',
  gray:   '#6b7280',
};

function resolveColor(colorName: string | undefined, fallback: string): string {
  if (!colorName) return fallback;
  return CSS_COLOR_KEYWORDS[colorName.toLowerCase()] ?? colorName;
}

function getSeriesColor(
  seriesName: string,
  index: number,
  presentation: ChartPresentation | undefined,
): string {
  // Explicit DSL override always wins.
  const override = presentation?.color[seriesName];
  if (override) return resolveColor(override, DEFAULT_COLORS[index % DEFAULT_COLORS.length]);

  // Time-tag default: a series whose value is a pure `time("X")` measure picks
  // up the user's configured color for letter X.
  const tagColors = presentation?.tagColorByLetter;
  if (tagColors) {
    const measureTag = presentation?.measureTimeTags?.[seriesName];
    if (measureTag && tagColors[measureTag]) return tagColors[measureTag];
    // Bonus: when the series name itself is a single letter (e.g. donut
    // categories grouped by time-label root), use that tag's color directly.
    if (/^[a-z]$/.test(seriesName) && tagColors[seriesName]) {
      return tagColors[seriesName];
    }
  }

  return DEFAULT_COLORS[index % DEFAULT_COLORS.length];
}

function getFormat(
  seriesName: string,
  presentation: ChartPresentation | undefined,
): FormatType | undefined {
  return presentation?.format[seriesName];
}

function nullToUndefined(v: number | null): number | undefined {
  return v === null ? undefined : v;
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function mondayTicks(xValues: string[]): string[] | undefined {
  const dateLike = xValues.filter(x => ISO_DATE_RE.test(x));
  if (dateLike.length < xValues.length) return undefined;
  return dateLike.filter(x => new Date(x + 'T12:00:00').getDay() === 1);
}

// ─────────────────────────────────────────────────────────────
// KPI
// ─────────────────────────────────────────────────────────────

function KpiRenderer({ chart, presentation }: { chart: KpiOutput; presentation: ChartPresentation | undefined }) {
  const primary = chart.values[0];
  const secondary = chart.values.slice(1);

  if (!primary) {
    return <div className="widget-empty">No data</div>;
  }

  return (
    <div className="wv2-kpi">
      <div className="wv2-kpi-primary">
        <span className="wv2-kpi-value">
          {fmtValue(primary.value, getFormat(primary.measure, presentation))}
        </span>
        <span className="wv2-kpi-label">{primary.label}</span>
      </div>
      {secondary.length > 0 && (
        <div className="wv2-kpi-secondary">
          {secondary.map((s) => (
            <span key={s.measure} className="wv2-kpi-secondary-item">
              <span className="wv2-kpi-secondary-value">
                {fmtValue(s.value, getFormat(s.measure, presentation))}
              </span>
              <span className="wv2-kpi-secondary-label">{s.label}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Bar
// ─────────────────────────────────────────────────────────────

function BarRenderer({
  chart,
  presentation,
  showChartValues,
}: {
  chart: BarOutput;
  presentation: ChartPresentation | undefined;
  showChartValues: boolean;
}) {
  if (chart.series.length === 0) {
    return <div className="widget-empty">No data</div>;
  }

  const fmt = getFormat(chart.yMeasure, presentation);
  const color = getSeriesColor(chart.yMeasure, 0, presentation);

  const data = chart.series.map((s) => ({
    x: s.x ?? '(none)',
    y: nullToUndefined(s.y),
  }));

  const xValues = data.map(d => d.x);
  const ticks = data.length > 14 ? mondayTicks(xValues) : undefined;

  return (
    <div className="wv2-chart">
      <ResponsiveContainer width="100%" height={220}>
        <BarChart data={data} margin={{ top: showChartValues ? 16 : 4, right: 8, bottom: 40, left: 0 }}>
          <XAxis dataKey="x" tick={{ fontSize: 11 }} angle={-35} textAnchor="end" interval={0} ticks={ticks} />
          <YAxis
            tick={{ fontSize: 11 }}
            width={40}
            tickFormatter={(v) => fmtAxis(v, fmt)}
          />
          <Tooltip formatter={(v: number) => fmtValue(v, fmt)} />
          <Bar dataKey="y" name="value" fill={color} radius={[2, 2, 0, 0]}>
            {showChartValues && (
              <LabelList
                dataKey="y"
                position="top"
                style={{ fontSize: 10, fill: '#555' }}
                formatter={(v: number) => fmtValue(v, fmt)}
              />
            )}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Stacked Bar
// ─────────────────────────────────────────────────────────────

function StackedBarRenderer({
  chart,
  presentation,
  showChartValues,
}: {
  chart: StackedBarOutput;
  presentation: ChartPresentation | undefined;
  showChartValues: boolean;
}) {
  if (chart.xValues.length === 0) {
    return <div className="widget-empty">No data</div>;
  }

  const byX: Record<string, Record<string, number | undefined>> = {};
  for (const xVal of chart.xValues) {
    const key = xVal ?? '(none)';
    byX[key] = {};
  }
  for (const d of chart.data) {
    const xKey = d.x ?? '(none)';
    const sKey = d.series ?? '(none)';
    if (byX[xKey]) byX[xKey][sKey] = nullToUndefined(d.y);
  }
  const data = Object.entries(byX).map(([x, vals]) => ({ x, ...vals }));
  const xValues = data.map(d => d.x);
  const ticks = data.length > 14 ? mondayTicks(xValues) : undefined;

  // Stacked bar: all stacks share the same y measure; format by measure name
  const fmt = getFormat(chart.yMeasure, presentation);

  return (
    <div className="wv2-chart">
      <ResponsiveContainer width="100%" height={240}>
        <BarChart data={data} margin={{ top: showChartValues ? 16 : 4, right: 8, bottom: 40, left: 0 }}>
          <XAxis dataKey="x" tick={{ fontSize: 11 }} angle={-35} textAnchor="end" interval={0} ticks={ticks} />
          <YAxis tick={{ fontSize: 11 }} width={40} tickFormatter={(v) => fmtAxis(v, fmt)} />
          <Tooltip formatter={(v: number) => fmtValue(v, fmt)} />
          <Legend verticalAlign="top" wrapperStyle={{ fontSize: 11, paddingBottom: '4px' }} />
          {chart.seriesValues.map((s, i) => (
            <Bar
              key={s ?? '(none)'}
              dataKey={s ?? '(none)'}
              stackId="a"
              fill={getSeriesColor(s ?? '', i, presentation)}
              radius={i === chart.seriesValues.length - 1 ? [2, 2, 0, 0] : undefined}
            >
              {showChartValues && i === chart.seriesValues.length - 1 && (
                <LabelList
                  dataKey={s ?? '(none)'}
                  position="top"
                  style={{ fontSize: 10, fill: '#555' }}
                  formatter={(v: number) => fmtValue(v, fmt)}
                />
              )}
            </Bar>
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Line
// ─────────────────────────────────────────────────────────────

function LineRenderer({
  chart,
  presentation,
  showChartValues,
}: {
  chart: LineOutput;
  presentation: ChartPresentation | undefined;
  showChartValues: boolean;
}) {
  if (chart.series.length === 0 || chart.series[0].points.length === 0) {
    return <div className="widget-empty">No data</div>;
  }

  const multiSeries = chart.series.length > 1;

  const allX = chart.series[0].points.map((p) => p.x ?? '(none)');
  const data = allX.map((x, i) => {
    const row: Record<string, string | number | undefined> = { x };
    for (const s of chart.series) {
      row[s.name] = nullToUndefined(s.points[i]?.y ?? null);
    }
    return row;
  });

  const dotRadius = chart.series.length > 3 ? 2 : 3;
  const ticks = data.length > 14 ? mondayTicks(allX) : undefined;

  // Use format from the first series for axis ticks
  const firstFmt = getFormat(chart.series[0]?.name ?? '', presentation);

  return (
    <div className="wv2-chart">
      <ResponsiveContainer width="100%" height={multiSeries ? 248 : 220}>
        <LineChart data={data} margin={{ top: showChartValues ? 18 : 4, right: 8, bottom: 40, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="rgba(0,0,0,0.06)" vertical={false} />
          <XAxis dataKey="x" tick={{ fontSize: 11 }} angle={-35} textAnchor="end" interval={0} ticks={ticks} />
          <YAxis
            tick={{ fontSize: 11 }}
            width={40}
            axisLine={false}
            tickLine={false}
            tickFormatter={(v) => fmtAxis(v, firstFmt)}
          />
          <Tooltip formatter={(v: number, name: string) => fmtValue(v, getFormat(name, presentation))} />
          {multiSeries && <Legend verticalAlign="top" wrapperStyle={{ fontSize: 11, paddingBottom: '4px' }} />}
          {chart.series.map((s, i) => {
            const fmt = getFormat(s.name, presentation);
            const color = getSeriesColor(s.name, i, presentation);
            return (
              <Line
                key={s.name}
                type="linear"
                dataKey={s.name}
                stroke={color}
                strokeWidth={2}
                dot={{ r: dotRadius, fill: color, strokeWidth: 0 }}
                activeDot={{ r: 5 }}
                connectNulls={false}
              >
                {showChartValues && (
                  <LabelList
                    dataKey={s.name}
                    position="top"
                    style={{ fontSize: 10, fill: '#555' }}
                    formatter={(v: number) => fmtValue(v, fmt)}
                  />
                )}
              </Line>
            );
          })}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Horizontal Bar
// ─────────────────────────────────────────────────────────────

function HBarRenderer({ chart, presentation }: { chart: HBarOutput; presentation: ChartPresentation | undefined }) {
  const bars = chart.bars.filter((b) => b.value !== null && b.value > 0);
  if (bars.length === 0) return <div className="widget-empty">No data</div>;

  const fmt = getFormat(chart.valueMeasure, presentation);
  const total = bars.reduce((s, b) => s + (b.value ?? 0), 0);
  const max = bars[0]?.value ?? 1;

  return (
    <div className="wv2-hbar">
      <div className="wv2-hbar-total">
        <span className="wv2-hbar-total-label">Total</span>
        <span className="wv2-hbar-total-spacer" />
        <span className="wv2-hbar-total-value">{fmtValue(total, fmt)}</span>
        <span className="wv2-hbar-total-pct">100%</span>
      </div>
      {bars.map((b, i) => (
        <div key={i} className="wv2-hbar-row">
          <span className="wv2-hbar-label">{b.category ?? '—'}</span>
          <div className="wv2-hbar-track">
            <div
              className="wv2-hbar-fill"
              style={{
                width: `${((b.value ?? 0) / max) * 100}%`,
                background: getSeriesColor(b.category ?? '', i, presentation),
              }}
            />
          </div>
          <span className="wv2-hbar-value">{fmtValue(b.value, fmt)}</span>
          <span className="wv2-hbar-pct">
            {total > 0 ? `${(((b.value ?? 0) / total) * 100).toFixed(1)}%` : '—'}
          </span>
        </div>
      ))}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Donut
// ─────────────────────────────────────────────────────────────

const DONUT_THRESHOLD = 0.05;

function DonutRenderer({ chart, presentation }: { chart: DonutOutput; presentation: ChartPresentation | undefined }) {
  const raw = chart.slices.filter((s) => s.value !== null && s.value > 0);
  if (raw.length === 0) return <div className="widget-empty">No data</div>;

  const fmt = getFormat(chart.valueMeasure, presentation);
  const total = raw.reduce((sum, s) => sum + (s.value as number), 0);
  const main = raw.filter((s) => (s.value as number) / total >= DONUT_THRESHOLD);
  const others = raw.filter((s) => (s.value as number) / total < DONUT_THRESHOLD);
  const othersSum = others.reduce((sum, s) => sum + (s.value as number), 0);

  const data = [
    ...main.map((s) => ({ name: s.category ?? '(none)', value: s.value as number })),
    ...(othersSum > 0 ? [{ name: 'Others', value: othersSum }] : []),
  ];

  const renderLabel = ({ name, percent, value }: { name: string; percent: number; value: number }) => {
    if (percent < DONUT_THRESHOLD) return null;
    return `${name}  ${(percent * 100).toFixed(0)}% (${fmtValue(value, fmt)})`;
  };

  return (
    <div className="wv2-chart">
      <ResponsiveContainer width="100%" height={240}>
        <PieChart>
          <Pie
            data={data}
            cx="50%"
            cy="50%"
            innerRadius="52%"
            outerRadius="72%"
            paddingAngle={2}
            dataKey="value"
            label={renderLabel}
            labelLine={{ stroke: 'rgba(0,0,0,0.2)', strokeWidth: 1 }}
          >
            {data.map((entry, i) => (
              <Cell key={i} fill={getSeriesColor(entry.name, i, presentation)} />
            ))}
          </Pie>
          <Tooltip formatter={(v: number) => [fmtValue(v, fmt), '']} />
        </PieChart>
      </ResponsiveContainer>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Ranked List
// ─────────────────────────────────────────────────────────────

const RANKED_LIST_MAX_ROWS = 8;

function RankedListRenderer({
  chart,
  presentation,
}: {
  chart: RankedListOutput;
  presentation: ChartPresentation | undefined;
}) {
  const nonZero = chart.rows.filter((r) => r.primary !== null && r.primary > 0);
  if (nonZero.length === 0) return <div className="widget-empty">No data</div>;

  const primaryFmt = getFormat(chart.primaryName, presentation);
  const secFmts = chart.secondaryNames.map(n => getFormat(n, presentation));

  let displayRows = nonZero;
  let otherRow: RankedListRow | null = null;
  if (nonZero.length > RANKED_LIST_MAX_ROWS) {
    displayRows = nonZero.slice(0, RANKED_LIST_MAX_ROWS);
    const rest = nonZero.slice(RANKED_LIST_MAX_ROWS);
    otherRow = {
      label: 'Other',
      primary: rest.reduce((s, r) => s + (r.primary ?? 0), 0),
      share: 0,
      secondary: chart.secondaryNames.map((_, i) => ({
        name: chart.secondaryNames[i],
        value: rest.reduce((s, r) => s + (r.secondary[i]?.value ?? 0), 0),
      })),
    };
  }

  // Use the pre-computed total row when available (correct for derived measures).
  // Fall back to summing non-zero rows for legacy compatibility.
  const totRow: RankedListRow = chart.totalRow ?? {
    label: 'Total',
    primary: nonZero.reduce((s, r) => s + (r.primary ?? 0), 0),
    share: 1,
    secondary: chart.secondaryNames.map((_, i) => ({
      name: chart.secondaryNames[i],
      value: nonZero.reduce((s, r) => s + (r.secondary[i]?.value ?? 0), 0),
    })),
  };

  const allDisplayRows = otherRow ? [...displayRows, otherRow] : displayRows;
  const colTemplate = `minmax(0, 1fr) 80px${chart.secondaryNames.map(() => ' 68px').join('')}`;

  return (
    <div className="wv2-ranked" style={{ '--rl-cols': colTemplate } as React.CSSProperties}>

      {/* Totals row */}
      <div className="wv2-ranked-totals">
        <span className="wv2-ranked-totals-label">Total</span>
        <span className="wv2-ranked-totals-primary">{fmtValue(totRow.primary, primaryFmt)}</span>
        {totRow.secondary.map((v, i) => (
          <span key={i} className="wv2-ranked-totals-secondary">{fmtValue(v.value, secFmts[i])}</span>
        ))}
      </div>

      {/* Header */}
      <div className="wv2-ranked-header">
        <span />
        <span className="wv2-ranked-col-head">{chart.primaryName}</span>
        {chart.secondaryNames.map((name) => (
          <span key={name} className="wv2-ranked-col-head">{name}</span>
        ))}
      </div>

      {/* Data rows */}
      {allDisplayRows.map((row, i) => (
        <div key={i} className={`wv2-ranked-row${row.label === 'Other' ? ' wv2-ranked-row-other' : ''}`}>
          <span className="wv2-ranked-label">{row.label ?? '—'}</span>
          <span className="wv2-ranked-primary">{fmtValue(row.primary, primaryFmt)}</span>
          {row.secondary.map((s, j) => (
            <span key={s.name} className="wv2-ranked-secondary">{fmtValue(s.value, secFmts[j])}</span>
          ))}
        </div>
      ))}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Table
// ─────────────────────────────────────────────────────────────

function TableRenderer({ chart, presentation }: { chart: TableOutput; presentation: ChartPresentation | undefined }) {
  if (chart.rows.length === 0) return <div className="widget-empty">No data</div>;

  const fmt = getFormat(chart.valueMeasure, presentation);

  return (
    <div className="wv2-table-wrap">
      <table className="wv2-table">
        <thead>
          <tr>
            <th></th>
            {chart.cols.map((c) => <th key={c}>{c}</th>)}
          </tr>
        </thead>
        <tbody>
          {chart.rows.map((row, i) => (
            <tr key={i}>
              <td className="wv2-table-label">{row.label ?? '—'}</td>
              {row.values.map((v, j) => (
                <td key={j} className="wv2-table-value">{fmtValue(v, fmt)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Main dispatcher
// ─────────────────────────────────────────────────────────────

interface WidgetV2Props {
  chart: ChartOutput;
  /** Optional per-measure format and color overrides from the DSL */
  presentation?: ChartPresentation;
  /** When true, bar and line charts show value labels on each data point */
  showChartValues?: boolean;
}

export function WidgetV2({ chart, presentation, showChartValues = false }: WidgetV2Props) {
  // Inject the user's per-letter tag colors into presentation so that downstream
  // renderers can default-color series whose measure is `time("X")`.
  const { settings } = useSettings();
  const enriched = useMemo<ChartPresentation | undefined>(() => {
    const tagColorByLetter: Record<string, string> = {};
    for (const t of settings?.timeTags ?? []) {
      tagColorByLetter[t.letter] = t.color;
    }
    return {
      format: presentation?.format ?? {},
      color: presentation?.color ?? {},
      measureTimeTags: presentation?.measureTimeTags,
      tagColorByLetter,
    };
  }, [presentation, settings]);

  switch (chart.type) {
    case 'kpi':
      return <KpiRenderer chart={chart} presentation={enriched} />;
    case 'bar':
      return <BarRenderer chart={chart} presentation={enriched} showChartValues={showChartValues} />;
    case 'stacked_bar':
      return <StackedBarRenderer chart={chart} presentation={enriched} showChartValues={showChartValues} />;
    case 'line':
      return <LineRenderer chart={chart} presentation={enriched} showChartValues={showChartValues} />;
    case 'donut':
      return <DonutRenderer chart={chart} presentation={enriched} />;
    case 'hbar':
      return <HBarRenderer chart={chart} presentation={enriched} />;
    case 'ranked_list':
      return <RankedListRenderer chart={chart} presentation={enriched} />;
    case 'table':
      return <TableRenderer chart={chart} presentation={enriched} />;
    default:
      return <div className="widget-error">Unknown chart type</div>;
  }
}
