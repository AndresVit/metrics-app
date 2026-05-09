import type { CSSProperties, ReactNode } from 'react';
import { resolveMetricValue } from '@time-patterns/metricSpec';
import { formatMinutes, formatMinuteAsTime } from '@time-patterns/formatDuration';
import { getAnalyticalWeekday } from '@time-patterns/analyticalCalendar';
import type {
  IntradayMatrix,
  DailyMatrix,
  ResolvedColumnScope,
  TimePatternsConfig,
} from '@time-patterns/types';
import { useSettings, colorForTimeTag } from '../settings/SettingsContext';

// ─── Selection type ───────────────────────────────────────────────────────────

export type DrilldownSelection =
  | { kind: 'heatmap-cell'; stripeIndex: number; columnId: string }
  | { kind: 'daily-cell';   date: string };

// ─── Props ─────────────────────────────────────────────────────────────────────

interface Props {
  selection: DrilldownSelection;
  matrix: IntradayMatrix | null;
  columnScopes: ResolvedColumnScope[];
  dailyMatrix: DailyMatrix | null;
  config: TimePatternsConfig;
  onClose: () => void;
}

// ─── Sub-components ───────────────────────────────────────────────────────────

const WEEKDAY_NAMES = [
  'Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday',
] as const;

const DATES_THRESHOLD = 7; // show all if ≤ this many, else first 5 + overflow count

function EligibleDates({ dates }: { dates: string[] }) {
  if (dates.length === 0) return <em style={{ color: '#94a3b8' }}>none</em>;
  if (dates.length <= DATES_THRESHOLD) {
    return <span>{dates.join(', ')}</span>;
  }
  const overflow = dates.length - 5;
  return (
    <span>
      {dates.slice(0, 5).join(', ')}
      <span style={{ color: '#94a3b8' }}> … and {overflow} more ({dates.length} total)</span>
    </span>
  );
}

function TimeLabels({ labels }: { labels: Record<string, number> }) {
  const { settings } = useSettings();
  const tags = settings?.timeTags ?? [];
  const entries = Object.entries(labels).filter(([, v]) => v > 0);
  if (entries.length === 0) return <em style={{ color: '#94a3b8' }}>none</em>;
  return (
    <>
      {entries.map(([k, v]) => {
        const color = colorForTimeTag(tags, k);
        return (
          <span key={k} style={{ marginRight: '0.75rem' }}>
            {color && (
              <span
                aria-hidden="true"
                style={{
                  display: 'inline-block',
                  width: '8px',
                  height: '8px',
                  borderRadius: '2px',
                  background: color,
                  marginRight: '4px',
                  verticalAlign: 'middle',
                }}
              />
            )}
            <strong>{k}</strong> {formatMinutes(v)}
          </span>
        );
      })}
    </>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <tr>
      <td style={labelTd}>{label}</td>
      <td style={valueTd}>{children}</td>
    </tr>
  );
}

// ─── Heatmap cell detail ──────────────────────────────────────────────────────

function HeatmapCellDetail({
  selection, matrix, columnScopes, config,
}: {
  selection: Extract<DrilldownSelection, { kind: 'heatmap-cell' }>;
  matrix: IntradayMatrix | null;
  columnScopes: ResolvedColumnScope[];
  config: TimePatternsConfig;
}) {
  if (!matrix) return <p style={emptyMsg}>Matrix not loaded.</p>;

  const { stripeIndex, columnId } = selection;
  const col    = matrix.columns.find(c => c.id === columnId);
  const stripe = matrix.stripes.find(s => s.index === stripeIndex);
  const scope  = columnScopes.find(s => s.columnId === columnId);
  const cell   = matrix.cells.get(`${stripeIndex}:${columnId}`);
  const denom  = matrix.columnDenominators[columnId] ?? 0;
  const val    = cell ? resolveMetricValue(config.metric.source, cell, denom) : null;

  return (
    <table style={detailTable}>
      <tbody>
        <Row label="Column">{col?.label ?? columnId}</Row>
        <Row label="Stripe">
          {stripe
            ? `${formatMinuteAsTime(stripe.startMinute)} – ${formatMinuteAsTime(stripe.endMinute)}`
            : `index ${stripeIndex}`}
        </Row>
        <Row label="Metric">{config.metric.label}</Row>
        <Row label="Value">
          {val !== null
            ? <><strong>{formatMinutes(val)}</strong><span style={muted}> / day avg</span></>
            : <em style={muted}>no data</em>}
        </Row>
        <Row label="Denominator">{denom} day{denom !== 1 ? 's' : ''}</Row>
        {scope && (
          <>
            <Row label="Scope">
              {scope.scopeKind === 'anchor-relative' ? 'anchor-relative' : 'analysis-range'}
            </Row>
            <Row label="Eligible dates">
              <EligibleDates dates={scope.eligibleDates} />
            </Row>
          </>
        )}
        <Row label="Raw duration">
          {cell
            ? formatMinutes(cell.totalDurationMinutes)
            : <em style={muted}>no cell</em>}
        </Row>
        <Row label="Time labels">
          {cell ? <TimeLabels labels={cell.timeLabels} /> : <em style={muted}>—</em>}
        </Row>
      </tbody>
    </table>
  );
}

// ─── Daily cell detail ────────────────────────────────────────────────────────

function DailyCellDetail({
  selection, dailyMatrix, config,
}: {
  selection: Extract<DrilldownSelection, { kind: 'daily-cell' }>;
  dailyMatrix: DailyMatrix | null;
  config: TimePatternsConfig;
}) {
  if (!dailyMatrix) return <p style={emptyMsg}>Daily matrix not loaded.</p>;

  const { date } = selection;
  const agg = dailyMatrix.byDate.get(date);
  const val = agg ? resolveMetricValue(config.metric.source, agg, 1) : null;
  const dayOfWeek = WEEKDAY_NAMES[getAnalyticalWeekday(date)];

  return (
    <table style={detailTable}>
      <tbody>
        <Row label="Date">
          {date} <span style={muted}>({dayOfWeek})</span>
        </Row>
        <Row label="Metric">{config.metric.label}</Row>
        {agg ? (
          <>
            <Row label="Value">
              {val !== null
                ? <strong>{formatMinutes(val)}</strong>
                : <em style={muted}>—</em>}
            </Row>
            <Row label="Total duration">{formatMinutes(agg.totalDurationMinutes)}</Row>
            <Row label="Timings">{agg.timingCount}</Row>
            <Row label="Time labels"><TimeLabels labels={agg.timeLabels} /></Row>
          </>
        ) : (
          <tr>
            <td colSpan={2} style={{ ...valueTd, paddingTop: '0.4rem' }}>
              <em style={muted}>No activity recorded for this day.</em>
            </td>
          </tr>
        )}
      </tbody>
    </table>
  );
}

// ─── Panel shell ──────────────────────────────────────────────────────────────

export function DrilldownPanel({
  selection, matrix, columnScopes, dailyMatrix, config, onClose,
}: Props) {
  const title = selection.kind === 'heatmap-cell' ? 'Cell detail' : 'Day detail';

  return (
    <div style={panelStyle}>
      <div style={panelHeader}>
        <span style={panelTitle}>{title}</span>
        <button onClick={onClose} style={closeBtn} aria-label="Close detail panel">×</button>
      </div>
      <div style={panelBody}>
        {selection.kind === 'heatmap-cell'
          ? <HeatmapCellDetail
              selection={selection}
              matrix={matrix}
              columnScopes={columnScopes}
              config={config}
            />
          : <DailyCellDetail
              selection={selection}
              dailyMatrix={dailyMatrix}
              config={config}
            />}
      </div>
    </div>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const panelStyle: CSSProperties = {
  marginTop: '1rem',
  border: '1px solid #e2e8f0',
  borderRadius: 6,
  background: '#f8fafc',
  maxWidth: 540,
  fontSize: '0.8rem',
};

const panelHeader: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  padding: '0.45rem 0.75rem',
  borderBottom: '1px solid #e2e8f0',
  background: '#f1f5f9',
  borderRadius: '6px 6px 0 0',
};

const panelTitle: CSSProperties = {
  fontWeight: 600,
  color: '#334155',
  fontSize: '0.78rem',
  letterSpacing: '0.03em',
  textTransform: 'uppercase',
};

const closeBtn: CSSProperties = {
  background: 'none',
  border: 'none',
  cursor: 'pointer',
  fontSize: '1.15rem',
  color: '#94a3b8',
  lineHeight: 1,
  padding: '0 2px',
};

const panelBody: CSSProperties = {
  padding: '0.6rem 0.75rem',
};

const detailTable: CSSProperties = {
  borderCollapse: 'collapse',
  width: '100%',
};

const labelTd: CSSProperties = {
  color: '#64748b',
  fontWeight: 500,
  paddingRight: '1.2rem',
  paddingTop: '0.18rem',
  paddingBottom: '0.18rem',
  verticalAlign: 'top',
  whiteSpace: 'nowrap',
  width: 130,
};

const valueTd: CSSProperties = {
  color: '#1e293b',
  paddingTop: '0.18rem',
  paddingBottom: '0.18rem',
  verticalAlign: 'top',
  wordBreak: 'break-word',
};

const muted: CSSProperties = {
  color: '#94a3b8',
};

const emptyMsg: CSSProperties = {
  margin: 0,
  color: '#94a3b8',
};
