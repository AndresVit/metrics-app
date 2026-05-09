import type { CSSProperties } from 'react';
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
} from 'recharts';
import { resolveMetricValue } from '@time-patterns/metricSpec';
import { formatMinutes, formatRatio } from '@time-patterns/formatDuration';
import type { IntradayMatrix, TimePatternsConfig } from '@time-patterns/types';

// ─── Props ─────────────────────────────────────────────────────────────────────

interface Props {
  /** Raw (regular-mode) matrix — same as the heatmap input pre-cumulative-transform. */
  matrix: IntradayMatrix;
  config: TimePatternsConfig;
  /** Trim x-axis to this many stripes (matches heatmap trailing-empty trim). */
  displayStripeCount?: number;
}

// ─── Row builder ───────────────────────────────────────────────────────────────

interface BarRow {
  stripe: string;
  total: number;
}

/**
 * For each stripe, sum the resolved metric value across weekday columns only
 * (avg-* columns are aggregates of weekday data and would double-count).
 */
function buildRows(matrix: IntradayMatrix, config: TimePatternsConfig, stripeCount?: number): BarRow[] {
  const stripes = stripeCount !== undefined ? matrix.stripes.slice(0, stripeCount) : matrix.stripes;
  const weekdayCols = matrix.columns.filter(c => !c.id.startsWith('avg-'));

  return stripes.map(stripe => {
    let total = 0;
    for (const col of weekdayCols) {
      const denom = Math.max(1, matrix.columnDenominators[col.id] ?? 1);
      const cell  = matrix.cells.get(`${stripe.index}:${col.id}`);
      const v     = cell ? resolveMetricValue(config.metric.source, cell, denom) : null;
      if (v !== null) total += v;
    }
    return { stripe: stripe.label, total };
  });
}

// ─── Component ─────────────────────────────────────────────────────────────────

export function IntradayBarChart({ matrix, config, displayStripeCount }: Props) {
  const rows = buildRows(matrix, config, displayStripeCount);

  if (rows.length === 0 || rows.every(r => r.total === 0)) {
    return <p style={emptyStyle}>No data for chart.</p>;
  }

  const fmt = (v: number) => config.metric.unit === 'ratio' ? formatRatio(v) : formatMinutes(v);

  return (
    <div style={{ width: '100%' }}>
      <div style={chartTitleStyle}>Stripe totals · {config.metric.label}</div>
      <ResponsiveContainer width="100%" height={240}>
        <BarChart data={rows} margin={{ top: 4, right: 16, bottom: 0, left: 4 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#E9E5F1" />
          <XAxis
            dataKey="stripe"
            tick={{ fontSize: 9, fontFamily: 'monospace', fill: '#6E6680' }}
            interval="preserveStartEnd"
          />
          <YAxis
            tickFormatter={fmt}
            width={44}
            tick={{ fontSize: 9, fill: '#6E6680' }}
          />
          <Tooltip
            formatter={(v: unknown) => fmt(Number(v))}
            contentStyle={{ fontSize: '0.76rem' }}
          />
          <Bar dataKey="total" name="Total" fill="#7C3AED" isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
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
