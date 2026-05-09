/**
 * WidgetV2Editor
 *
 * A self-contained panel that lets the user:
 *   1. Edit a v2 widget DSL in a textarea
 *   2. Run it against the current temporal context
 *   3. Preview the resulting chart
 *   4. See parse/analyzer/executor errors inline
 *   5. Save (create or update) the widget to the active dashboard
 *
 * Props:
 *   dashboardId  — target dashboard for save
 *   startDate    — inclusive lower bound (local-time midnight)
 *   endDate      — exclusive upper bound (local-time midnight of day after last day)
 *   smallPeriod  — grouping granularity
 *   initialDsl   — prefill DSL (edit mode)
 *   initialName  — prefill widget name (edit mode)
 *   widgetId     — if set, editing an existing widget (PATCH); else creating (POST)
 *   onSaved      — called after a successful save so the parent can refresh
 *   onCancel     — called when the user dismisses without saving
 */

import { useState, useCallback } from 'react';
import { WidgetV2, type ChartOutput, type ChartPresentation } from './WidgetV2';
import { SimpleModeWidgetEditor, EMPTY_SIMPLE_FORM, type SimpleWidgetForm } from './SimpleModeWidgetEditor';

type EditorMode = 'simple' | 'advanced';

const API_URL = 'http://localhost:3001';

const EXAMPLE_V2_DSL = `widget "my_widget" {
  data {
    source: TIM as tims
    where: tims.parent.code in ["EST"]
    group { x: period(day) }
    measure productive = sum(tims.time("t"))
  }
  plot {
    type: bar
    x: x
    y: productive
  }
}`;

interface RunResult {
  chart: ChartOutput;
  name: string;
  presentation?: ChartPresentation;
}

interface ErrorResult {
  error: string;
  errors?: string[];
  stage?: string;
  line?: number;
  col?: number;
}

type SmallPeriod = 'hour' | 'day' | 'week' | 'month';

interface WidgetV2EditorProps {
  dashboardId: string;
  /** Inclusive lower bound (local-time midnight). */
  startDate: Date;
  /** Exclusive upper bound (local-time midnight of day after last day). */
  endDate: Date;
  smallPeriod: SmallPeriod;
  initialDsl?: string;
  initialName?: string;
  widgetId?: string;
  onSaved: () => void;
  onCancel: () => void;
}

function formatDateParam(date: Date): string {
  const y = date.getFullYear();
  const m = (date.getMonth() + 1).toString().padStart(2, '0');
  const d = date.getDate().toString().padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function formatInclusiveEndDate(exclusiveEndDate: Date): string {
  return formatDateParam(new Date(
    exclusiveEndDate.getFullYear(),
    exclusiveEndDate.getMonth(),
    exclusiveEndDate.getDate() - 1,
    0, 0, 0, 0,
  ));
}

export function WidgetV2Editor({
  dashboardId,
  startDate,
  endDate,
  smallPeriod,
  initialDsl,
  initialName,
  widgetId,
  onSaved,
  onCancel,
}: WidgetV2EditorProps) {
  const [dsl, setDsl] = useState(initialDsl ?? EXAMPLE_V2_DSL);
  const [name, setName] = useState(initialName ?? '');
  const [running, setRunning] = useState(false);
  const [saving, setSaving] = useState(false);
  const [runResult, setRunResult] = useState<RunResult | null>(null);
  const [runError, setRunError] = useState<ErrorResult | null>(null);
  // Track whether DSL has changed since the last successful run
  const [lastRunDsl, setLastRunDsl] = useState<string | null>(initialDsl ?? null);
  // Track the current widget id — switches create→update after first successful save
  const [currentWidgetId, setCurrentWidgetId] = useState<string | undefined>(widgetId);
  // Simple-mode form state — Simple emits DSL; Advanced is the source of truth.
  // When editing an existing widget we default to Advanced (we don't parse DSL → form).
  const [mode, setMode] = useState<EditorMode>(initialDsl ? 'advanced' : 'simple');
  const [simpleForm, setSimpleForm] = useState<SimpleWidgetForm>({ ...EMPTY_SIMPLE_FORM });

  const handleRun = useCallback(async () => {
    setRunning(true);
    setRunResult(null);
    setRunError(null);

    try {
      const res = await fetch(`${API_URL}/api/v2/run-widget`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          widgetSource: dsl,
          startDate: formatDateParam(startDate),
          endDate:   formatInclusiveEndDate(endDate),
          smallPeriod,
        }),
      });
      const data = await res.json();

      if (data.success) {
        setRunResult({ chart: data.chart, name: data.name, presentation: data.presentation });
        setLastRunDsl(dsl);
        // Auto-fill name from DSL if not set yet
        if (!name && data.name) setName(data.name);
      } else {
        setRunError({ error: data.error, errors: data.errors, stage: data.stage, line: data.line, col: data.col });
      }
    } catch (err) {
      setRunError({ error: err instanceof Error ? err.message : 'Network error' });
    } finally {
      setRunning(false);
    }
  }, [dsl, startDate, endDate, smallPeriod, name]);

  const handleSave = useCallback(async () => {
    if (!name.trim()) {
      alert('Please enter a widget name before saving.');
      return;
    }
    if (!dashboardId) {
      alert('No active dashboard selected.');
      return;
    }
    if (lastRunDsl !== dsl) {
      const ok = window.confirm('The DSL has changed since the last run. Save without running?');
      if (!ok) return;
    }

    setSaving(true);
    try {
      let res: Response;
      if (currentWidgetId) {
        // Update existing
        res = await fetch(`${API_URL}/api/widgets/${currentWidgetId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: name.trim(), dsl }),
        });
      } else {
        // Create new
        res = await fetch(`${API_URL}/api/widgets`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            dashboardId,
            name: name.trim(),
            dsl,
            dslVersion: 'v2',
          }),
        });
      }
      const data = await res.json();
      if (data.success) {
        // Remember the id so a second Save updates instead of inserting again
        if (!currentWidgetId && data.widget?.id) {
          setCurrentWidgetId(data.widget.id);
        }
        onSaved();
      } else {
        alert(data.error || 'Save failed');
      }
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Network error');
    } finally {
      setSaving(false);
    }
  }, [name, dsl, dashboardId, currentWidgetId, onSaved, lastRunDsl]);

  return (
    <div className="wv2-editor">
      <div className="wv2-editor-header">
        <input
          className="wv2-editor-name"
          type="text"
          placeholder="Widget name"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <div className="wv2-editor-actions">
          <div className="wv2-mode-toggle" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'simple'}
              className={`wv2-mode-btn${mode === 'simple' ? ' active' : ''}`}
              onClick={() => setMode('simple')}
            >Simple</button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'advanced'}
              className={`wv2-mode-btn${mode === 'advanced' ? ' active' : ''}`}
              onClick={() => setMode('advanced')}
            >Advanced</button>
          </div>
          <button className="btn-secondary" onClick={handleRun} disabled={running}>
            {running ? 'Running…' : '▶ Run'}
          </button>
          <button className="btn-primary" onClick={handleSave} disabled={saving || !name.trim()}>
            {saving ? 'Saving…' : widgetId ? 'Update' : 'Save'}
          </button>
          <button className="btn-ghost" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>

      <div className="wv2-editor-body">
        <div className="wv2-editor-left">
          {mode === 'advanced' ? (
            <textarea
              className="wv2-editor-textarea"
              value={dsl}
              onChange={(e) => {
                setDsl(e.target.value);
                setRunResult(null);
                setRunError(null);
              }}
              spellCheck={false}
              autoComplete="off"
            />
          ) : (
            <SimpleModeWidgetEditor
              form={simpleForm}
              widgetName={name}
              onChange={setSimpleForm}
              onDslChange={(next) => {
                setDsl(next);
                setRunResult(null);
                setRunError(null);
              }}
            />
          )}
        </div>

        <div className="wv2-editor-right">
          {running && (
            <div className="widget-loading">Running…</div>
          )}

          {!running && runError && (
            <div className="wv2-editor-error">
              {runError.stage && (
                <div className="wv2-editor-error-stage">
                  {runError.stage} error
                  {runError.line != null && (
                    <span className="wv2-editor-error-loc"> — line {runError.line}{runError.col != null ? `, col ${runError.col}` : ''}</span>
                  )}
                </div>
              )}
              <pre className="wv2-editor-error-text">{runError.error}</pre>
              {runError.errors && runError.errors.length > 1 && (
                <ul className="wv2-editor-error-list">
                  {runError.errors.map((e, i) => <li key={i}>{e}</li>)}
                </ul>
              )}
            </div>
          )}

          {!running && runResult && (
            <WidgetV2 chart={runResult.chart} presentation={runResult.presentation} />
          )}

          {!running && !runError && !runResult && (
            <div className="wv2-editor-hint">
              Press <strong>▶ Run</strong> to preview the widget.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
