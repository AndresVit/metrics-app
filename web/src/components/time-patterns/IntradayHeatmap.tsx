import type { CSSProperties } from 'react';
import { resolveMetricValue, extractLabelValue } from '@time-patterns/metricSpec';
import { formatMinutes, formatMinutesDense, formatRatio } from '@time-patterns/formatDuration';
import type { BucketAggregate, IntradayMatrix, TimePatternsConfig, ViewMode } from '@time-patterns/types';

// ─── Palette ──────────────────────────────────────────────────────────────────
const P = {
  pageBg:        '#F5F3FA',
  neutralCell:   '#F8F7FB',
  gridLine:      '#E5E1EE',
  groupSep:      '#CFC7DE',
  primaryText:   '#231F2E',
  secondaryText: '#6E6680',
  mutedText:     '#9B93AD',
  accent:        '#7C3AED',
  accentSoft:    '#EDE9FE',
} as const;

// ─── Table A: 2D encoding — hue from net productivity, opacity from t amount ───
//
// Hue family: discrete 5-step soft palette anchored to net productivity.
// Opacity: per-day t value normalised against maxT across all displayed cells.
//   opacity = 0.18 + (t / maxT) × 0.77   →   floor 0.18, ceiling 0.95
// This means: same quality hue, but low-t cells read lighter and high-t cells
// read stronger — giving simultaneous encoding of quality AND quantity.

const NET_PROD_RGB: Array<{ threshold: number; rgb: [number, number, number] }> = [
  { threshold: 0.25, rgb: [244, 199, 195] }, // #F4C7C3  low
  { threshold: 0.4, rgb: [242, 223, 178] }, // #F2DFB2  low-mid
  { threshold: 0.6, rgb: [232, 230, 184] }, // #E8E6B8  mid
  { threshold: 0.8, rgb: [207, 231, 190] }, // #CFE7BE  mid-high
  { threshold: 1.1, rgb: [159, 214, 148] }, // #9FD694  high
];

function netProdRgb(netP: number): [number, number, number] {
  for (const entry of NET_PROD_RGB) {
    if (netP < entry.threshold) return entry.rgb;
  }
  return NET_PROD_RGB[NET_PROD_RGB.length - 1].rgb;
}

function cellBg(netP: number, opacity: number): string {
  const [r, g, b] = netProdRgb(netP);
  return `rgba(${r}, ${g}, ${b}, ${opacity.toFixed(2)})`;
}

function fmtVal(val: number, config: TimePatternsConfig): string {
  return config.metric.unit === 'ratio' ? formatRatio(val) : formatMinutesDense(val);
}

// net_productivity = t / (t + m + p)  — exact definition per spec.
function cellNetProductivity(cell: BucketAggregate): number | null {
  const t = extractLabelValue({ kind: 'prefix', prefix: 't' }, cell.timeLabels);
  const m = extractLabelValue({ kind: 'prefix', prefix: 'm' }, cell.timeLabels);
  const p = extractLabelValue({ kind: 'prefix', prefix: 'p' }, cell.timeLabels);
  const total = t + m + p;
  return total === 0 ? null : t / total;
}

// ─── Props ─────────────────────────────────────────────────────────────────────

interface Props {
  matrix: IntradayMatrix;
  config: TimePatternsConfig;
  viewMode: ViewMode;
  displayStripeCount?: number;
  selectedCell?: { stripeIndex: number; columnId: string } | null;
  onCellClick?: (stripeIndex: number, columnId: string) => void;
}

// ─── Total row helper ─────────────────────────────────────────────────────────

function columnTotal(
  matrix: IntradayMatrix,
  displayStripes: IntradayMatrix['stripes'],
  colId: string,
  denom: number,
  config: TimePatternsConfig,
  viewMode: ViewMode,
): number | null {
  if (displayStripes.length === 0) return null;
  if (viewMode === 'regular') {
    let sum = 0; let hasAny = false;
    for (const stripe of displayStripes) {
      const cell = matrix.cells.get(`${stripe.index}:${colId}`);
      const v = cell ? resolveMetricValue(config.metric.source, cell, denom) : null;
      if (v !== null) { sum += v; hasAny = true; }
    }
    return hasAny ? sum : null;
  } else {
    const lastStripe = displayStripes[displayStripes.length - 1];
    const cell = matrix.cells.get(`${lastStripe.index}:${colId}`);
    return cell ? resolveMetricValue(config.metric.source, cell, denom) : null;
  }
}

// ─── Cell detail panel ────────────────────────────────────────────────────────

interface CellDetail {
  colLabel: string;
  stripeLabel: string;
  t: number;
  m: number;
  p: number;
  nto: number | null;
  nti: number | null;
}

function buildCellDetail(
  matrix: IntradayMatrix,
  selected: { stripeIndex: number; columnId: string },
): CellDetail | null {
  const cell   = matrix.cells.get(`${selected.stripeIndex}:${selected.columnId}`);
  if (!cell) return null;
  const denom  = Math.max(1, matrix.columnDenominators[selected.columnId] ?? 1);
  const col    = matrix.columns.find(c => c.id === selected.columnId);
  const stripe = matrix.stripes.find(s => s.index === selected.stripeIndex);
  const t   = extractLabelValue({ kind: 'prefix', prefix: 't' }, cell.timeLabels) / denom;
  const m   = extractLabelValue({ kind: 'prefix', prefix: 'm' }, cell.timeLabels) / denom;
  const p   = extractLabelValue({ kind: 'prefix', prefix: 'p' }, cell.timeLabels) / denom;
  const all = extractLabelValue({ kind: 'any' }, cell.timeLabels) / denom;
  const nto = all > 0 ? t / all : null;
  const nti = (t + m) > 0 ? t / (t + m) : null;
  return { colLabel: col?.label ?? selected.columnId, stripeLabel: stripe?.label ?? '', t, m, p, nto, nti };
}

function CellDetailPanel({ detail }: { detail: CellDetail }) {
  return (
    <div style={cellDetailPanelStyle}>
      <div style={detailHeaderStyle}>
        {detail.colLabel}
        <span style={detailSubStyle}>{detail.stripeLabel}</span>
      </div>
      <div style={detailGridStyle}>
        <span style={detailLabelStyle}>t</span>
        <span style={detailValueStyle}>{formatMinutesDense(detail.t)}</span>
        <span style={detailLabelStyle}>m</span>
        <span style={detailValueStyle}>{formatMinutesDense(detail.m)}</span>
        <span style={detailLabelStyle}>p</span>
        <span style={detailValueStyle}>{formatMinutesDense(detail.p)}</span>
      </div>
      <div style={detailDividerStyle} />
      <div style={detailRatioRowStyle}>
        <span style={detailLabelStyle}>nto</span>
        <span style={detailValueStyle}>{detail.nto !== null ? formatRatio(detail.nto) : '—'}</span>
        <span style={detailLabelStyle}>nti</span>
        <span style={detailValueStyle}>{detail.nti !== null ? formatRatio(detail.nti) : '—'}</span>
      </div>
    </div>
  );
}

// ─── Group separator helper ────────────────────────────────────────────────────

/** True for the leftmost avg-* column — marks the weekday/compound group boundary. */
function isFirstCompoundCol(colId: string, colIdx: number, cols: IntradayMatrix['columns']): boolean {
  return colId.startsWith('avg-') && (colIdx === 0 || !cols[colIdx - 1].id.startsWith('avg-'));
}

// ─── Component ────────────────────────────────────────────────────────────────

export function IntradayHeatmap({ matrix, config, viewMode, displayStripeCount, selectedCell, onCellClick }: Props) {
  const displayStripes = displayStripeCount !== undefined
    ? matrix.stripes.slice(0, displayStripeCount)
    : matrix.stripes;

  let maxVal = 0;
  let maxT   = 0;  // max per-day t across all displayed cells (for opacity normalisation)
  let totalRawMinutes = 0;
  for (const col of matrix.columns) {
    const denom = Math.max(1, matrix.columnDenominators[col.id] ?? 1);
    for (const stripe of displayStripes) {
      const cell = matrix.cells.get(`${stripe.index}:${col.id}`);
      if (!cell) continue;
      totalRawMinutes += cell.totalDurationMinutes;
      const v = resolveMetricValue(config.metric.source, cell, denom);
      if (v !== null && v > maxVal) maxVal = v;
      const t = extractLabelValue({ kind: 'prefix', prefix: 't' }, cell.timeLabels) / denom;
      if (t > maxT) maxT = t;
    }
  }

  const modeLabel =
    viewMode === 'cumulative'       ? 'Cumulative'
    : viewMode === 'cumulative-week' ? 'Cumulative week'
    : '';

  const cellDetail = selectedCell ? buildCellDetail(matrix, selectedCell) : null;

  return (
    <div style={{ display: 'flex', gap: '1.5rem', alignItems: 'flex-start' }}>
      <div style={{ overflowX: 'auto' }}>
        {modeLabel && <div style={modeLabelStyle}>{modeLabel}</div>}
        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={rowHeaderTh}>Time</th>
              {matrix.columns.map((col, colIdx) => (
                <th key={col.id} style={colHeaderThStyle(isFirstCompoundCol(col.id, colIdx, matrix.columns))}>
                  {col.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {displayStripes.map(stripe => (
              <tr key={stripe.index}>
                <td style={rowLabelTd}>{stripe.label}</td>
                {matrix.columns.map((col, colIdx) => {
                  const denom = matrix.columnDenominators[col.id] ?? 0;
                  const cell  = matrix.cells.get(`${stripe.index}:${col.id}`);
                  const val   = cell ? resolveMetricValue(config.metric.source, cell, denom) : null;
                  const sep   = isFirstCompoundCol(col.id, colIdx, matrix.columns);

                  // Table A: 2D encoding — hue from net productivity, opacity from t amount.
                  // Hue: discrete 5-step soft red→green scale based on netP.
                  // Opacity: t_perday / maxT normalised to [0.18, 0.95] so low-t cells
                  //          look lighter and high-t cells look stronger.
                  let bg: string | undefined;
                  if (val !== null && val > 0) {
                    const denom2 = Math.max(1, matrix.columnDenominators[col.id] ?? 1);
                    if (config.metric.unit === 'ratio') {
                      // For ratio metrics use ratio value as a proxy for both netP and intensity.
                      const ratio = Math.min(val, 1);
                      const opacity = 0.18 + ratio * 0.77;
                      bg = cellBg(ratio, opacity);
                    } else {
                      const netP = cell ? cellNetProductivity(cell) : null;
                      if (netP !== null) {
                        const t = cell ? extractLabelValue({ kind: 'prefix', prefix: 't' }, cell.timeLabels) / denom2 : 0;
                        const m = cell ? extractLabelValue({ kind: 'prefix', prefix: 'm' }, cell.timeLabels) / denom2 : 0;
                        const p = cell ? extractLabelValue({ kind: 'prefix', prefix: 'p' }, cell.timeLabels) / denom2 : 0;
                        const tNorm   = maxT > 0 ? Math.min(Math.max(t,m+p) / maxT, 1) : 0.5;
                        const opacity = tNorm;
                        bg = cellBg(netP, opacity);
                      }
                    }
                  }

                  const selected = selectedCell?.stripeIndex === stripe.index && selectedCell?.columnId === col.id;
                  return (
                    <td key={col.id} style={bodyCellStyle(bg, sep, selected)} onClick={() => onCellClick?.(stripe.index, col.id)}>
                      {val !== null && val > 0 ? fmtVal(val, config) : ''}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td style={totalLabelTd}>Total</td>
              {matrix.columns.map((col, colIdx) => {
                const denom = matrix.columnDenominators[col.id] ?? 0;
                const total = columnTotal(matrix, displayStripes, col.id, denom, config, viewMode);
                const sep   = isFirstCompoundCol(col.id, colIdx, matrix.columns);
                return (
                  <td key={col.id} style={totalCellTdStyle(sep)}>
                    {config.metric.unit === 'ratio' ? '—' : (total !== null && total > 0 ? formatMinutesDense(total) : '—')}
                  </td>
                );
              })}
            </tr>
          </tfoot>
        </table>

        {maxVal > 0 && config.metric.unit !== 'ratio' && (
          <p style={footerStyle}>{config.metric.label} · Max: <strong>{formatMinutes(maxVal)}</strong></p>
        )}
        {maxVal === 0 && totalRawMinutes > 0 && (
          <p style={{ ...footerStyle, color: '#b45309' }}>
            Data present ({formatMinutes(totalRawMinutes)} total) but no values for the selected metric.
          </p>
        )}
        {maxVal === 0 && totalRawMinutes === 0 && matrix.cells.size === 0 && (
          <p style={{ ...footerStyle, color: '#b45309' }}>No data in the current window.</p>
        )}
      </div>

      {cellDetail && <CellDetailPanel detail={cellDetail} />}
    </div>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const tableStyle: CSSProperties = {
  borderCollapse: 'collapse',
  fontSize: '0.78rem',
  fontFamily: 'monospace',
  whiteSpace: 'nowrap',
};

const rowHeaderTh: CSSProperties = {
  border: `1px solid ${P.gridLine}`,
  padding: '5px 12px',
  background: P.neutralCell,
  textAlign: 'left',
  fontFamily: 'system-ui, sans-serif',
  fontSize: '0.7rem',
  fontWeight: 600,
  color: P.secondaryText,
  letterSpacing: '0.04em',
  textTransform: 'uppercase',
};

const colHeaderTh: CSSProperties = {
  border: `1px solid ${P.gridLine}`,
  padding: '4px 14px',
  background: P.neutralCell,
  textAlign: 'center',
  fontFamily: 'system-ui, sans-serif',
  fontSize: '0.8rem',
  fontWeight: 600,
  color: P.secondaryText,
  minWidth: 72,
};

const rowLabelTd: CSSProperties = {
  borderRight: `1px solid ${P.gridLine}`,
  padding: '2px 12px',
  background: P.neutralCell,
  fontFamily: 'system-ui, sans-serif',
  fontSize: '0.75rem',
  fontWeight: 600,
  color: P.secondaryText,
  whiteSpace: 'nowrap',
};

const totalLabelTd: CSSProperties = {
  border: `1px solid ${P.gridLine}`,
  borderTop: `2px solid ${P.groupSep}`,
  padding: '3px 12px',
  background: P.neutralCell,
  fontFamily: 'system-ui, sans-serif',
  fontSize: '0.75rem',
  fontWeight: 700,
  color: P.primaryText,
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
};

const totalCellTd: CSSProperties = {
  border: `1px solid ${P.gridLine}`,
  borderTop: `2px solid ${P.groupSep}`,
  padding: '3px 10px',
  textAlign: 'center',
  background: P.neutralCell,
  fontFamily: 'monospace',
  fontSize: '0.78rem',
  fontWeight: 600,
  color: P.primaryText,
};

const modeLabelStyle: CSSProperties = {
  fontSize: '0.72rem',
  color: P.accent,
  fontWeight: 600,
  marginBottom: '0.3rem',
  letterSpacing: '0.04em',
  textTransform: 'uppercase',
};

const footerStyle: CSSProperties = {
  fontSize: '0.7rem',
  color: P.mutedText,
  marginTop: '0.4rem',
};

// ─── Dynamic cell/header styles ───────────────────────────────────────────────
// These functions follow the consts they reference.

function bodyCellStyle(bg: string | undefined, separator: boolean, selected: boolean): CSSProperties {
  return {
    padding: '2px 10px',
    textAlign: 'center',
    cursor: 'pointer',
    borderTop: `1px solid ${P.gridLine}`,
    borderBottom: `1px solid ${P.gridLine}`,
    borderRight: `1px solid ${P.gridLine}`,
    borderLeft: separator ? `2px solid ${P.groupSep}` : `1px solid ${P.gridLine}`,
    ...(selected ? { boxShadow: `inset 0 0 0 2px ${P.accent}` } : {}),
    background: bg ?? 'transparent',
    color: bg ? P.primaryText : P.mutedText,
  };
}

function colHeaderThStyle(separator: boolean): CSSProperties {
  return {
    ...colHeaderTh,
    borderLeft: separator ? `2px solid ${P.groupSep}` : `1px solid ${P.gridLine}`,
  };
}

function totalCellTdStyle(separator: boolean): CSSProperties {
  return {
    ...totalCellTd,
    borderLeft: separator ? `2px solid ${P.groupSep}` : `1px solid ${P.gridLine}`,
  };
}

// ─── Cell detail panel ────────────────────────────────────────────────────────

const cellDetailPanelStyle: CSSProperties = {
  flexShrink: 0,
  minWidth: 148,
  background: P.neutralCell,
  border: `1px solid ${P.gridLine}`,
  borderRadius: 8,
  padding: '0.65rem 0.85rem',
  fontFamily: 'system-ui, sans-serif',
};

const detailHeaderStyle: CSSProperties = {
  fontSize: '0.8rem',
  fontWeight: 700,
  color: P.primaryText,
  marginBottom: '0.55rem',
  display: 'flex',
  flexDirection: 'column',
  gap: 1,
};

const detailSubStyle: CSSProperties = {
  fontSize: '0.7rem',
  fontWeight: 400,
  color: P.mutedText,
  fontFamily: 'monospace',
};

const detailGridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'auto 1fr auto 1fr auto 1fr',
  columnGap: '0.4rem',
  rowGap: '0.25rem',
  alignItems: 'baseline',
};

const detailRatioRowStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'auto 1fr auto 1fr',
  columnGap: '0.4rem',
  rowGap: '0.25rem',
  alignItems: 'baseline',
};

const detailLabelStyle: CSSProperties = {
  fontSize: '0.68rem',
  color: P.mutedText,
  fontWeight: 600,
  letterSpacing: '0.03em',
};

const detailValueStyle: CSSProperties = {
  fontSize: '0.8rem',
  fontWeight: 600,
  color: P.primaryText,
  fontFamily: 'monospace',
};

const detailDividerStyle: CSSProperties = {
  height: 1,
  background: P.gridLine,
  margin: '0.45rem 0',
};
