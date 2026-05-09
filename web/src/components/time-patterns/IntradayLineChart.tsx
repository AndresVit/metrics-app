import type { CSSProperties } from 'react';
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from 'recharts';
import { buildCumulativeMatrix, buildCumulativeWeekMatrix } from '@time-patterns/cumulative';
import { resolveMetricValue } from '@time-patterns/metricSpec';
import { formatMinutes, formatRatio } from '@time-patterns/formatDuration';
import type { IntradayMatrix, TimePatternsConfig, ViewMode } from '@time-patterns/types';

// ─── Props ─────────────────────────────────────────────────────────────────────

interface Props {
  viewMode: ViewMode;
  /** Raw line-chart matrix with columns: lc-today, lc-avg-week, lc-avg-month. */
  lineMatrix: IntradayMatrix;
  /**
   * Per-weekday matrices for cumulative-week chart.
   * thisWeek  = Selected week (Mon→Sun of anchor's week).
   * thisMonth = Avg month (all days in anchor's month).
   */
  chartMatrices: {
    thisWeek:  IntradayMatrix;
    thisMonth: IntradayMatrix;
  };
  /** Enabled weekday column IDs in Mon→Sun order. */
  weekdayColumnIds: string[];
  config: TimePatternsConfig;
  /** Trim x-axis to this many stripes (matches heatmap trailing-empty trim). */
  displayStripeCount?: number;
}

// ─── Color palette ────────────────────────────────────────────────────────────

const COLORS = {
  today:    '#5B6CFF',
  avgWeek:  '#1FA971',
  avgMonth: '#D97706',
};

// ─── Regular / Cumulative chart ───────────────────────────────────────────────

type ChartRow = Record<string, string | number>;

function buildDayChartRows(matrix: IntradayMatrix, config: TimePatternsConfig, stripeCount?: number): ChartRow[] {
  const cumMatrix = buildCumulativeMatrix(matrix);
  const stripes = stripeCount !== undefined
    ? cumMatrix.stripes.slice(0, stripeCount)
    : cumMatrix.stripes;
  return stripes.map(stripe => {
    const row: ChartRow = { stripe: stripe.label };
    for (const col of cumMatrix.columns) {
      const denom = cumMatrix.columnDenominators[col.id] ?? 0;
      const cell  = cumMatrix.cells.get(`${stripe.index}:${col.id}`);
      const val   = cell ? resolveMetricValue(config.metric.source, cell, denom) : null;
      row[col.id] = val ?? 0;
    }
    return row;
  });
}

function DayLineChart({ matrix, config, displayStripeCount }: { matrix: IntradayMatrix; config: TimePatternsConfig; displayStripeCount?: number }) {
  const rows = buildDayChartRows(matrix, config, displayStripeCount);

  if (matrix.stripes.length === 0 || matrix.columns.length === 0) {
    return <p style={emptyStyle}>No data for chart.</p>;
  }

  const lineDefs: { colId: string; name: string; color: string }[] = [
    { colId: 'lc-today',     name: 'Selected day', color: COLORS.today    },
    { colId: 'lc-avg-week',  name: 'Avg week',     color: COLORS.avgWeek  },
    { colId: 'lc-avg-month', name: 'Avg month',    color: COLORS.avgMonth },
  ].filter(l => matrix.columns.some(c => c.id === l.colId));

  return (
    <div style={{ width: '100%' }}>
      <div style={chartTitleStyle}>Cumulative day · {config.metric.label}</div>
      <ResponsiveContainer width="100%" height={240}>
        <LineChart data={rows} margin={{ top: 4, right: 16, bottom: 0, left: 4 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#E9E5F1" />
          <XAxis dataKey="stripe" tick={{ fontSize: 9, fontFamily: 'monospace', fill: '#6E6680' }} interval="preserveStartEnd" />
          <YAxis tickFormatter={(v: number) => config.metric.unit === 'ratio' ? formatRatio(v) : formatMinutes(v)} width={44} tick={{ fontSize: 9, fill: '#6E6680' }} />
          <Tooltip formatter={(v: unknown) => config.metric.unit === 'ratio' ? formatRatio(Number(v)) : formatMinutes(Number(v))} contentStyle={{ fontSize: '0.76rem' }} />
          <Legend wrapperStyle={{ fontSize: '0.78rem', paddingTop: '0.25rem' }} />
          {lineDefs.map(l => (
            <Line
              key={l.colId}
              type="linear"
              dataKey={l.colId}
              name={l.name}
              stroke={l.color}
              dot={false}
              strokeWidth={2}
              isAnimationActive={false}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

// ─── Cumulative-week chart ────────────────────────────────────────────────────

/**
 * Flatten a cumulative-week matrix into a linear series of data points.
 *
 * For each enabled weekday (Mon→Sun order), for each stripe:
 *   x = "Mon 09:00", "Mon 10:00", …, "Tue 00:00", …
 *   All weekday column values are extracted for each (weekday, stripe) pair.
 */
function buildWeekChartRows(
  matrices: { thisWeek: IntradayMatrix; thisMonth: IntradayMatrix },
  weekdayColumnIds: string[],
  config: TimePatternsConfig,
  stripeCount?: number,
): ChartRow[] {
  const twCum = buildCumulativeWeekMatrix(matrices.thisWeek,  weekdayColumnIds);
  const tmCum = buildCumulativeWeekMatrix(matrices.thisMonth, weekdayColumnIds);

  const allStripes = twCum.stripes;
  const stripes = stripeCount !== undefined ? allStripes.slice(0, stripeCount) : allStripes;
  if (stripes.length === 0 || weekdayColumnIds.length === 0) return [];

  const rows: ChartRow[] = [];

  for (const wdColId of weekdayColumnIds) {
    // Derive day label from column label (e.g. 'Mon', 'Tue')
    const dayLabel =
      twCum.columns.find(c => c.id === wdColId)?.label ??
      tmCum.columns.find(c => c.id === wdColId)?.label ??
      wdColId;

    for (const stripe of stripes) {
      const xLabel = `${dayLabel} ${stripe.label}`;

      const getVal = (mat: IntradayMatrix, colId: string): number => {
        const denom = mat.columnDenominators[colId] ?? 0;
        const cell  = mat.cells.get(`${stripe.index}:${colId}`);
        return cell ? (resolveMetricValue(config.metric.source, cell, denom) ?? 0) : 0;
      };

      rows.push({
        stripe:    xLabel,
        thisWeek:  getVal(twCum, wdColId),
        thisMonth: getVal(tmCum, wdColId),
      });
    }
  }

  return rows;
}

function WeekLineChart({
  matrices,
  weekdayColumnIds,
  config,
  displayStripeCount,
}: {
  matrices: Props['chartMatrices'];
  weekdayColumnIds: string[];
  config: TimePatternsConfig;
  displayStripeCount?: number;
}) {
  const rows = buildWeekChartRows(matrices, weekdayColumnIds, config, displayStripeCount);

  if (rows.length === 0) {
    return <p style={emptyStyle}>No data for weekly chart.</p>;
  }

  // Show X axis labels only at day boundaries (first stripe per weekday)
  const stripeCount = matrices.thisWeek.stripes.length || 1;
  const interval = stripeCount - 1; // one tick per day boundary

  return (
    <div style={{ width: '100%' }}>
      <div style={chartTitleStyle}>Cumulative week · {config.metric.label}</div>
      <ResponsiveContainer width="100%" height={240}>
        <LineChart data={rows} margin={{ top: 4, right: 16, bottom: 0, left: 4 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#E9E5F1" />
          <XAxis
            dataKey="stripe"
            tick={{ fontSize: 9, fontFamily: 'monospace', fill: '#6E6680' }}
            interval={interval}
          />
          <YAxis tickFormatter={(v: number) => config.metric.unit === 'ratio' ? formatRatio(v) : formatMinutes(v)} width={44} tick={{ fontSize: 9, fill: '#6E6680' }} />
          <Tooltip formatter={(v: unknown) => config.metric.unit === 'ratio' ? formatRatio(Number(v)) : formatMinutes(Number(v))} contentStyle={{ fontSize: '0.76rem' }} />
          <Legend wrapperStyle={{ fontSize: '0.78rem', paddingTop: '0.25rem' }} />
          <Line type="linear" dataKey="thisWeek"  name="Selected week" stroke={COLORS.today}    dot={false} strokeWidth={2} isAnimationActive={false} />
          <Line type="linear" dataKey="thisMonth" name="Avg month"     stroke={COLORS.avgMonth} dot={false} strokeWidth={2} isAnimationActive={false} strokeDasharray="5 3" />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

// ─── Exported component ───────────────────────────────────────────────────────

export function IntradayLineChart({
  viewMode,
  lineMatrix,
  chartMatrices,
  weekdayColumnIds,
  config,
  displayStripeCount,
}: Props) {
  if (viewMode === 'cumulative-week') {
    return (
      <WeekLineChart
        matrices={chartMatrices}
        weekdayColumnIds={weekdayColumnIds}
        config={config}
        displayStripeCount={displayStripeCount}
      />
    );
  }

  return <DayLineChart matrix={lineMatrix} config={config} displayStripeCount={displayStripeCount} />;
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const chartTitleStyle: CSSProperties = {
  fontSize: '0.75rem',
  color: '#64748b',
  fontWeight: 600,
  letterSpacing: '0.03em',
  textTransform: 'uppercase',
  marginBottom: '0.4rem',
};

const emptyStyle: CSSProperties = {
  color: '#aaa',
  fontSize: '0.85rem',
};
