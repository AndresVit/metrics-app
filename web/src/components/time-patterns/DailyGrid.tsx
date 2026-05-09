import type { CSSProperties } from 'react';
import { resolveMetricValue, extractLabelValue } from '@time-patterns/metricSpec';
import { formatMinutes, formatRatio } from '@time-patterns/formatDuration';
import { addDays, getAnalyticalWeekday } from '@time-patterns/analyticalCalendar';
import type { DailyMatrix, AnalysisRange, TimePatternsConfig, ViewMode, DailyAggregate } from '@time-patterns/types';

// ─── Palette ──────────────────────────────────────────────────────────────────
const P = {
  neutralCell:   '#F8F7FB',
  gridLine:      '#E5E1EE',
  groupSep:      '#CFC7DE',
  primaryText:   '#231F2E',
  secondaryText: '#6E6680',
  mutedText:     '#9B93AD',
  textOnDark:    '#FFFFFF',
  accent:        '#7C3AED',
  accentSoft:    '#EDE9FE',
} as const;

// ─── Volume color scale (Table C) ─────────────────────────────────────────────
// Table C: color by daily metric amount (volume), not quality.
// Single blue hue (hsl 215) separates it from Table A's red→green quality scale.
// Continuous: sat 30→55%, lit 96→78% as intensity goes 0→1. Text always dark.
function volumeColor(intensity: number): string {
  const sat = Math.round(30 + intensity * 25);
  const lit = Math.round(96 - intensity * 18);
  return `hsl(215, ${sat}%, ${lit}%)`;
}

// ─── Secondary metric helpers ─────────────────────────────────────────────────

function netProductivity(agg: DailyAggregate): number | null {
  const t = extractLabelValue({ kind: 'prefix', prefix: 't' }, agg.timeLabels);
  const m = extractLabelValue({ kind: 'prefix', prefix: 'm' }, agg.timeLabels);
  const p = extractLabelValue({ kind: 'prefix', prefix: 'p' }, agg.timeLabels);
  const total = t + m + p;
  return total === 0 ? null : t / total;
}

function internalProductivity(agg: DailyAggregate): number | null {
  const t  = extractLabelValue({ kind: 'prefix', prefix: 't' }, agg.timeLabels);
  const tm = extractLabelValue({ kind: 'multi-prefix', prefixes: ['t', 'm'] }, agg.timeLabels);
  return tm === 0 ? null : t / tm;
}

// ─── Props ─────────────────────────────────────────────────────────────────────

interface Props {
  dailyMatrix: DailyMatrix;
  config: TimePatternsConfig;
  analysisRange: AnalysisRange;
  viewMode: ViewMode;
  selectedDate?: string | null;
  onDayClick?: (date: string) => void;
}

// ─── Calendar layout ──────────────────────────────────────────────────────────

const WEEKDAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;
const MONTH_ABBR    = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'] as const;

function isoIndex(date: string): number {
  const wd = getAnalyticalWeekday(date);
  return wd === 0 ? 6 : wd - 1;
}

function weekRowLabel(mondayDate: string): string {
  const [, mo, d] = mondayDate.split('-').map(Number);
  return `${MONTH_ABBR[mo - 1]} ${d}`;
}

function buildWeekRows(displayRange: AnalysisRange): string[][] {
  const gridStart = addDays(displayRange.from, -isoIndex(displayRange.from));
  const gridEnd   = addDays(displayRange.to,    6 - isoIndex(displayRange.to));
  const rows: string[][] = [];
  let current = gridStart;
  while (current <= gridEnd) {
    const week: string[] = [];
    for (let i = 0; i < 7; i++) { week.push(current); current = addDays(current, 1); }
    rows.push(week);
  }
  return rows;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function DailyGrid({ dailyMatrix, config, analysisRange, viewMode, selectedDate, onDayClick }: Props) {
  let maxRaw = 0;
  for (const agg of dailyMatrix.byDate.values()) {
    const val = resolveMetricValue(config.metric.source, agg, 1);
    if (val !== null && val > maxRaw) maxRaw = val;
  }

  const rows = buildWeekRows(analysisRange);
  const isCumulative = viewMode === 'cumulative' || viewMode === 'cumulative-week';

  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={tableStyle}>
        <thead>
          <tr>
            <th style={rowLabelTh} />
            {WEEKDAY_LABELS.map(d => <th key={d} style={colHeaderTh}>{d}</th>)}
            <th style={weekTotalTh}>wk</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((week, wi) => {
            const rawVals: (number | null)[] = week.map(date => {
              if (date < analysisRange.from || date > analysisRange.to) return null;
              const agg = dailyMatrix.byDate.get(date);
              return agg ? (resolveMetricValue(config.metric.source, agg, 1) ?? 0) : 0;
            });

            const weeklyTotal = rawVals.reduce<number>((sum, v) => sum + (v ?? 0), 0);

            let displayVals: (number | null)[];
            if (isCumulative) {
              let running = 0;
              displayVals = rawVals.map(v => { if (v === null) return null; running += v; return running; });
            } else {
              displayVals = rawVals;
            }

            return (
              <tr key={wi}>
                <td style={rowLabelTd}>{weekRowLabel(week[0])}</td>
                {week.map((date, di) => {
                  const inRange = date >= analysisRange.from && date <= analysisRange.to;
                  if (!inRange) return <td key={date} style={outOfRangeCellStyle} />;

                  const dayNum = parseInt(date.split('-')[2], 10);
                  const agg    = dailyMatrix.byDate.get(date);
                  const dispVal = displayVals[di];
                  const netP   = agg ? netProductivity(agg)      : null;
                  const intP   = agg ? internalProductivity(agg)  : null;
                  const selected = selectedDate === date;

                  // Volume-driven color: intensity = dispVal / maxRaw.
                  // Empty cells (no data) use neutral background with no color.
                  let bg: string | undefined;
                  if (dispVal !== null && dispVal > 0) {
                    const intensity = config.metric.unit === 'ratio'
                      ? Math.min(dispVal, 1)
                      : (maxRaw > 0 ? Math.min(dispVal / maxRaw, 1) : 0);
                    if (intensity > 0) bg = volumeColor(intensity);
                  }

                  const hasSecondary = (netP !== null || intP !== null) && config.metric.unit !== 'ratio';

                  return (
                    <td key={date} style={dayCellStyle(bg, selected)} onClick={() => onDayClick?.(date)}>
                      <div style={cellLayoutStyle}>
                        <div style={cellTopStyle}>
                          <div style={{ ...dayNumStyle, color: P.secondaryText }}>
                            {dayNum}
                          </div>
                          {dispVal !== null && dispVal > 0 && (
                            <div style={{ ...valStyle, color: P.primaryText }}>
                              {config.metric.unit === 'ratio' ? formatRatio(dispVal) : formatMinutes(dispVal)}
                            </div>
                          )}
                        </div>
                        {hasSecondary && (
                          <div style={{ ...secondaryMetricsStyle, color: P.secondaryText }}>
                            {netP !== null && <span title="Net productivity">{formatRatio(netP)}</span>}
                            {intP !== null && <span title="Internal productivity">{formatRatio(intP)}</span>}
                          </div>
                        )}
                      </div>
                    </td>
                  );
                })}
                <td style={weekTotalCellStyle(weeklyTotal > 0)}>
                  {config.metric.unit === 'ratio' ? '—' : (weeklyTotal > 0 ? formatMinutes(weeklyTotal) : '')}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const tableStyle: CSSProperties = {
  borderCollapse: 'collapse',
  fontSize: '0.78rem',
};

const colHeaderTh: CSSProperties = {
  border: `1px solid ${P.gridLine}`,
  padding: '4px 0',
  background: P.neutralCell,
  textAlign: 'center',
  fontFamily: 'system-ui, sans-serif',
  fontSize: '0.7rem',
  fontWeight: 600,
  color: P.secondaryText,
  letterSpacing: '0.04em',
  textTransform: 'uppercase',
  width: 76,
  minWidth: 76,
};

const weekTotalTh: CSSProperties = {
  border: `1px solid ${P.gridLine}`,
  borderLeft: `2px solid ${P.groupSep}`,
  padding: '4px 0',
  background: P.neutralCell,
  textAlign: 'center',
  fontFamily: 'system-ui, sans-serif',
  fontSize: '0.7rem',
  fontWeight: 600,
  color: P.secondaryText,
  letterSpacing: '0.04em',
  textTransform: 'uppercase',
  width: 60,
  minWidth: 60,
};

const rowLabelTh: CSSProperties = {
  border: `1px solid ${P.gridLine}`,
  background: P.neutralCell,
};

const rowLabelTd: CSSProperties = {
  border: `1px solid ${P.gridLine}`,
  padding: '0 8px',
  background: P.neutralCell,
  fontFamily: 'system-ui, sans-serif',
  fontSize: '0.68rem',
  color: P.mutedText,
  whiteSpace: 'nowrap',
  verticalAlign: 'middle',
  textAlign: 'right',
  width: 52,
};

const outOfRangeCellStyle: CSSProperties = {
  border: `1px solid ${P.gridLine}`,
  background: P.neutralCell,
  width: 76,
  height: 54,
};

function dayCellStyle(bg: string | undefined, selected: boolean): CSSProperties {
  return {
    border: selected ? `1px solid ${P.accent}` : `1px solid ${P.gridLine}`,
    boxShadow: selected ? `inset 0 0 0 2px ${P.accent}` : undefined,
    background: bg ?? 'transparent',
    width: 76,
    height: 54,
    padding: '4px 5px',
    verticalAlign: 'top',
    cursor: 'pointer',
  };
}

function weekTotalCellStyle(hasData: boolean): CSSProperties {
  return {
    border: `1px solid ${P.gridLine}`,
    borderLeft: `2px solid ${P.groupSep}`,
    background: P.neutralCell,
    padding: '0 8px',
    verticalAlign: 'middle',
    textAlign: 'center',
    fontFamily: 'monospace',
    fontSize: '0.75rem',
    fontWeight: 600,
    color: hasData ? P.secondaryText : P.mutedText,
    width: 60,
    minWidth: 60,
  };
}

const cellLayoutStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  height: '100%',
  justifyContent: 'space-between',
};

const cellTopStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 1,
};

const dayNumStyle: CSSProperties = {
  fontSize: '0.7rem',
  fontWeight: 500,
  lineHeight: '1.2',
  // color set inline based on textLight
};

const valStyle: CSSProperties = {
  fontSize: '0.72rem',
  fontWeight: 600,
  fontFamily: 'monospace',
  // color set inline based on textLight
};

const secondaryMetricsStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'flex-end',
  gap: 4,
  fontSize: '0.6rem',
  fontFamily: 'monospace',
  // color set inline based on textLight
};
