import { useState, useEffect, useCallback, useMemo } from 'react';
import type { CSSProperties } from 'react';
import { buildDefaultConfig, loadMatrices, buildMetricPresets, FALLBACK_METRIC_PRESETS, DEFAULT_METRIC_ID } from './timePatternsClient';
import { useSettings } from '../settings/SettingsContext';

const API_URL = 'http://localhost:3001';
import { IntradayHeatmap } from './IntradayHeatmap';
import { IntradayLineChart } from './IntradayLineChart';
import { IntradayBarChart } from './IntradayBarChart';
import { DailyGrid } from './DailyGrid';
import { DrilldownPanel } from './DrilldownPanel';
import type { DrilldownSelection } from './DrilldownPanel';
import { buildCumulativeMatrix, buildCumulativeWeekMatrix } from '@time-patterns/cumulative';
import type {
  TimePatternsConfig,
  IntradayMatrix,
  ViewMode,
  AnalysisRange,
} from '@time-patterns/types';
import type { LoadResult, ActivePreset } from './timePatternsClient';

// ─── Minimal filter type (mirrors DashboardGlobalFilter from App.tsx) ──────────
interface GlobalFilter {
  weekdays?: number[];
}

// ─── Today helper ─────────────────────────────────────────────────────────────

function localDateString(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}


// ─── Stripe helpers ────────────────────────────────────────────────────────────

function hhmmToMinutes(hhmm: string): number | null {
  const parts = hhmm.split(':').map(Number);
  if (parts.length !== 2 || parts.some(isNaN)) return null;
  const [h, m] = parts;
  if (h < 0 || h > 23 || m < 0 || m > 59) return null;
  return h * 60 + m;
}

// ─── State ─────────────────────────────────────────────────────────────────────

type Status = 'idle' | 'loading' | 'error' | 'ready';

interface ViewState {
  status: Status;
  result: LoadResult | null;
  error: string | null;
}

// ─── Props ─────────────────────────────────────────────────────────────────────

interface Props {
  /** Inclusive start date string (YYYY-MM-DD). */
  from: string;
  /** Inclusive end date string (YYYY-MM-DD). */
  to: string;
  activeFilters: GlobalFilter | null;
  /** Active temporal preset — drives avg-total visibility. Defaults to 'custom'. */
  activePreset?: ActivePreset;
}

// ─── Main view ────────────────────────────────────────────────────────────────

export function TimePatternsView({ from, to, activeFilters, activePreset = 'custom' }: Props) {
  // Cap `to` at today: the temporal bar may extend the range past the current date
  // (e.g. "week" preset ends on Sunday even if today is Thursday). Future days
  // have no data, so clamp to avoid empty trailing rows.
  const today = localDateString();
  const effectiveTo = to > today ? today : to;

  // Build anchor Date at noon of the effective end date.
  const anchorDate = new Date(`${effectiveTo}T12:00:00`);

  const [config, setConfig] = useState<TimePatternsConfig>(() =>
    buildDefaultConfig(anchorDate),
  );
  const [viewMode, setViewMode]       = useState<ViewMode>('regular');
  const [selectedMetricId, setSelectedMetricId] = useState(DEFAULT_METRIC_ID);
  const [stripeSizeStr,  setStripeSizeStr]  = useState('60');
  const [stripeStartStr, setStripeStartStr] = useState('09:00');
  const [selection, setSelection]   = useState<DrilldownSelection | null>(null);

  // ── Dynamic metric presets ─────────────────────────────────────────────────
  // Built from user settings (time-tag letters) + TIM formula attributes.
  const { settings } = useSettings();
  const [timFormulaAttrs, setTimFormulaAttrs] = useState<Array<{ internalName: string; displayName: string; formula: string }>>([]);

  useEffect(() => {
    (async () => {
      try {
        const r = await fetch(`${API_URL}/api/schema/definitions`);
        const data = await r.json();
        if (!data.success) return;
        const tim = (data.definitions ?? []).find((d: { code: string }) => d.code === 'TIM');
        if (!tim) return;
        const formulas = (tim.attributes ?? [])
          .filter((a: { mode: string; formula: string; isSystemAttr?: boolean }) =>
            a.mode === 'formula' && a.formula && !a.isSystemAttr)
          .map((a: { internalName: string; displayName: string; formula: string }) => ({
            internalName: a.internalName,
            displayName: a.displayName,
            formula: a.formula,
          }));
        setTimFormulaAttrs(formulas);
      } catch {
        // settings still usable without formula presets
      }
    })();
  }, []);

  const metricPresets = useMemo(
    () => buildMetricPresets({
      timeTags: settings?.timeTags ?? [],
      timFormulaAttrs,
    }),
    [settings, timFormulaAttrs],
  );

  const findMetricPreset = useCallback((id: string): TimePatternsConfig['metric'] => {
    return metricPresets.find(m => m.id === id)
      ?? FALLBACK_METRIC_PRESETS.find(m => m.id === id)
      ?? metricPresets[0]
      ?? FALLBACK_METRIC_PRESETS[0];
  }, [metricPresets]);

  // If the currently-selected metric disappears (e.g. user deleted that
  // letter from settings), fall back to a sane default.
  useEffect(() => {
    if (metricPresets.length === 0) return;
    if (!metricPresets.find(m => m.id === selectedMetricId)) {
      const fallback = metricPresets[0].id;
      setSelectedMetricId(fallback);
      setConfig(c => ({ ...c, metric: metricPresets[0] }));
    }
  }, [metricPresets, selectedMetricId]);

  const [state, setState] = useState<ViewState>({
    status: 'idle',
    result: null,
    error: null,
  });

  // Derive enabled weekdays from the active filter.
  const enabledWeekdays: number[] | null =
    activeFilters?.weekdays && activeFilters.weekdays.length > 0
      ? activeFilters.weekdays
      : null;

  // Derive concrete analysis range — capped at today.
  const analysisRange: AnalysisRange = { from, to: effectiveTo };

  const load = useCallback(async (
    cfg: TimePatternsConfig,
    range: AnalysisRange,
    wdays: number[] | null,
    preset: ActivePreset,
  ) => {
    setState(s => ({ ...s, status: 'loading', error: null }));
    setSelection(null);
    try {
      const result = await loadMatrices(cfg, range, wdays, preset);
      setState({ status: 'ready', result, error: null });
    } catch (e) {
      setState(s => ({ ...s, status: 'error', error: e instanceof Error ? e.message : String(e) }));
    }
  }, []);

  // Auto-load on mount.
  useEffect(() => {
    load(config, analysisRange, enabledWeekdays, activePreset);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reload when date range or preset changes.
  useEffect(() => {
    const cappedTo = to > localDateString() ? localDateString() : to;
    const newAnchor = new Date(`${cappedTo}T12:00:00`);
    setConfig(c => {
      const next = { ...c, anchorDate: newAnchor };
      load(next, { from, to: cappedTo }, enabledWeekdays, activePreset);
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from, to, activePreset]);

  // Auto-reload when filters change.
  useEffect(() => {
    if (state.status !== 'idle') {
      load(config, analysisRange, enabledWeekdays, activePreset);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(enabledWeekdays)]);

  function changeViewMode(mode: ViewMode) {
    setViewMode(mode);
    // mode change is instant — no reload needed
  }

  function applyMetric(id: string) {
    const metric = findMetricPreset(id);
    const next = { ...config, metric };
    setConfig(next);
    load(next, analysisRange, enabledWeekdays, activePreset);
  }

  function applyStripe() {
    const size  = parseInt(stripeSizeStr, 10);
    const start = hhmmToMinutes(stripeStartStr);
    if (isNaN(size) || size < 1 || size > 480 || start === null) return;
    const next = { ...config, stripeConfig: { startMinute: start, sizeMinutes: size } };
    setConfig(next);
    load(next, analysisRange, enabledWeekdays, activePreset);
  }

  function manualLoad() {
    load(config, analysisRange, enabledWeekdays, activePreset);
  }

  // ── Derived display matrices ─────────────────────────────────────────────────
  const result = state.result;
  let displayMatrix: IntradayMatrix | null = null;

  if (result) {
    if (viewMode === 'regular') {
      displayMatrix = result.matrix;
    } else if (viewMode === 'cumulative') {
      displayMatrix = buildCumulativeMatrix(result.matrix);
    } else {
      displayMatrix = buildCumulativeWeekMatrix(result.matrix, result.weekdayColumnIds);
    }
  }

  // Compute shared trailing-empty trim: find the last stripe that has any cell data.
  // Applied to both the heatmap and the line chart x-axis so they cut off identically.
  let displayStripeCount = result?.matrix.stripes.length ?? 0;
  if (result) {
    let lastNonEmpty = -1;
    for (let si = 0; si < result.matrix.stripes.length; si++) {
      const stripe = result.matrix.stripes[si];
      for (const col of result.matrix.columns) {
        const cell = result.matrix.cells.get(`${stripe.index}:${col.id}`);
        if (cell && cell.totalDurationMinutes > 0) { lastNonEmpty = si; break; }
      }
    }
    if (lastNonEmpty >= 0) displayStripeCount = lastNonEmpty + 1;
  }

  return (
    <div style={rootStyle}>
      {/* ── Controls ── */}
      <div style={controlsBarStyle}>

        {/* Mode pills */}
        <div style={controlGroupStyle}>
          <span style={ctrlLabelStyle}>Mode</span>
          <div style={pillGroupStyle}>
            {(['regular', 'cumulative', 'cumulative-week'] as ViewMode[]).map(m => (
              <button
                key={m}
                style={pillStyle(viewMode === m)}
                onClick={() => changeViewMode(m)}
              >
                {m === 'regular' ? 'Regular' : m === 'cumulative' ? 'Cumulative' : 'Cumulative week'}
              </button>
            ))}
          </div>
        </div>

        <div style={dividerStyle} />

        {/* Metric */}
        <div style={controlGroupStyle}>
          <span style={ctrlLabelStyle}>Metric</span>
          <select
            value={selectedMetricId}
            onChange={e => { setSelectedMetricId(e.target.value); applyMetric(e.target.value); }}
            style={selectStyle}
          >
            {metricPresets.map(m => (
              <option key={m.id} value={m.id}>{m.label}</option>
            ))}
          </select>
        </div>

        <div style={dividerStyle} />

        {/* Stripe */}
        <div style={controlGroupStyle}>
          <span style={ctrlLabelStyle}>Stripe</span>
          <input
            type="number"
            min={1}
            max={480}
            step={1}
            value={stripeSizeStr}
            onChange={e => setStripeSizeStr(e.target.value)}
            onBlur={applyStripe}
            onKeyDown={e => e.key === 'Enter' && applyStripe()}
            style={{ ...textInputStyle, width: 56 }}
            title="Stripe size in minutes (1–480)"
          />
          <span style={unitLabelStyle}>min</span>
          <span style={ctrlLabelStyle}>Start</span>
          <input
            type="time"
            value={stripeStartStr}
            onChange={e => setStripeStartStr(e.target.value)}
            onBlur={applyStripe}
            onKeyDown={e => e.key === 'Enter' && applyStripe()}
            style={{ ...textInputStyle, width: 88 }}
            title="Day start time (HH:MM)"
          />
        </div>

        <button
          onClick={manualLoad}
          disabled={state.status === 'loading'}
          style={loadBtnStyle}
        >
          {state.status === 'loading' ? '…' : 'Load'}
        </button>
      </div>

      {/* Error */}
      {state.status === 'error' && (
        <p style={{ color: '#c00', margin: '0.5rem 0', fontSize: '0.85rem' }}>
          Error: {state.error}
        </p>
      )}

      {/* Idle hint */}
      {state.status === 'idle' && (
        <p style={{ color: '#aaa', fontSize: '0.85rem' }}>Loading…</p>
      )}

      {/* ── Section A: Weekly heatmap ── */}
      {state.status === 'ready' && displayMatrix && result && (
        <section style={sectionStyle}>
          <IntradayHeatmap
            matrix={displayMatrix}
            config={config}
            viewMode={viewMode}
            displayStripeCount={displayStripeCount}
            selectedCell={selection?.kind === 'heatmap-cell' ? selection : null}
            onCellClick={(stripeIndex, columnId) =>
              setSelection(s =>
                s?.kind === 'heatmap-cell' && s.stripeIndex === stripeIndex && s.columnId === columnId
                  ? null
                  : { kind: 'heatmap-cell', stripeIndex, columnId },
              )
            }
          />
        </section>
      )}

      {/* ── Section B: Line chart ── */}
      {state.status === 'ready' && result && (
        <section style={sectionStyle}>
          <IntradayLineChart
            viewMode={viewMode}
            lineMatrix={result.lineMatrix}
            chartMatrices={result.chartMatrices}
            weekdayColumnIds={result.weekdayColumnIds}
            config={config}
            displayStripeCount={displayStripeCount}
          />
        </section>
      )}

      {/* ── Section C: Daily grid ── */}
      {state.status === 'ready' && result?.dailyMatrix && result.analysisRange && (
        <section style={sectionStyle}>
          <DailyGrid
            dailyMatrix={result.dailyMatrix}
            config={config}
            analysisRange={result.dailyRange}
            viewMode={viewMode}
            selectedDate={selection?.kind === 'daily-cell' ? selection.date : null}
            onDayClick={date =>
              setSelection(s =>
                s?.kind === 'daily-cell' && s.date === date
                  ? null
                  : { kind: 'daily-cell', date },
              )
            }
          />
        </section>
      )}

      {/* ── Section D: Bar chart (always regular-mode data) ── */}
      {state.status === 'ready' && result && (
        <section style={sectionStyle}>
          <IntradayBarChart
            matrix={result.matrix}
            config={config}
            displayStripeCount={displayStripeCount}
          />
        </section>
      )}

      {/* ── Drilldown panel ── */}
      {selection && result && (
        <DrilldownPanel
          selection={selection}
          matrix={result.matrix}
          columnScopes={result.columnScopes}
          dailyMatrix={result.dailyMatrix}
          config={config}
          onClose={() => setSelection(null)}
        />
      )}
    </div>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const rootStyle: CSSProperties = {
  padding: '0 1.25rem 1rem',
  maxWidth: '100%',
};

const controlsBarStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '0.5rem',
  marginBottom: '0.5rem',
  flexWrap: 'wrap',
  padding: '0.35rem 0.75rem',
  background: '#F8F7FB',
  borderRadius: 8,
  border: '1px solid #E5E1EE',
};

const controlGroupStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '0.35rem',
};

const pillGroupStyle: CSSProperties = {
  display: 'flex',
  gap: 3,
};

const dividerStyle: CSSProperties = {
  width: 1,
  height: '1.5rem',
  background: '#E5E1EE',
  alignSelf: 'center',
  flexShrink: 0,
};

const ctrlLabelStyle: CSSProperties = {
  fontSize: '0.75rem',
  color: '#6E6680',
  fontWeight: 600,
  letterSpacing: '0.04em',
  textTransform: 'uppercase',
  whiteSpace: 'nowrap',
};

const unitLabelStyle: CSSProperties = {
  fontSize: '0.75rem',
  color: '#9B93AD',
};

function pillStyle(active: boolean): CSSProperties {
  return {
    padding: '3px 10px',
    borderRadius: 20,
    border: `1px solid ${active ? '#6366f1' : '#CFC7DE'}`,
    background: active ? '#6366f1' : '#FFFFFF',
    color: active ? '#FFFFFF' : '#6E6680',
    cursor: 'pointer',
    fontSize: '0.8rem',
    fontWeight: active ? 600 : 400,
    lineHeight: '1.4',
    whiteSpace: 'nowrap',
  };
}

const selectStyle: CSSProperties = {
  padding: '3px 6px',
  border: '1px solid #d1d5db',
  borderRadius: 6,
  fontSize: '0.82rem',
  color: '#1e293b',
  background: '#fff',
  cursor: 'pointer',
};

const textInputStyle: CSSProperties = {
  padding: '3px 8px',
  border: '1px solid #d1d5db',
  borderRadius: 6,
  fontSize: '0.82rem',
  color: '#1e293b',
  background: '#fff',
  width: 72,
  outline: 'none',
};

const loadBtnStyle: CSSProperties = {
  marginLeft: 'auto',
  padding: '4px 14px',
  borderRadius: 6,
  border: '1px solid #cbd5e1',
  background: '#f1f5f9',
  color: '#475569',
  cursor: 'pointer',
  fontSize: '0.82rem',
  fontWeight: 500,
};

const sectionStyle: CSSProperties = {
  marginBottom: '1.25rem',
  background: '#FFFFFF',
  borderRadius: 10,
  border: '1px solid #E5E1EE',
  boxShadow: '0 1px 3px rgba(35,31,46,0.04)',
  padding: '0.75rem 1rem',
  // No overflowX here — table sections handle their own inner scroll;
  // the chart section must NOT have overflow:auto or hover triggers a scrollbar flash.
};
