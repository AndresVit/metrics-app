/**
 * SimpleModeWidgetEditor
 *
 * Structured form for building widget DSL without writing expressions.
 * Each row that previously took a DSL fragment (filter clauses, group
 * dimensions, measure formulas) is a structured picker with a per-row
 * "use expression" escape hatch.
 *
 * Simple Mode is one-way: it emits DSL via `onDslChange` and never
 * parses DSL back into the form.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { AutocompleteSelect, type AutocompleteOption } from '../definitions/AutocompleteSelect';
import {
  AGGREGATORS, AGGREGATOR_LABELS,
  EMPTY_SIMPLE_FORM, FILTER_OPS, FILTER_OP_LABELS, FORMATS,
  PERIOD_LABELS, PERIOD_TYPES, TIM_CATEGORIES, TIM_CATEGORY_LABELS,
  WIDGET_TYPES, WIDGET_TYPE_LABELS,
  generateDsl, sourceAlias,
  type AggregateField, type AggregatorKind, type FilterOp, type FormatKind,
  type PeriodType, type SimpleFilter, type SimpleGroup, type SimpleMeasure,
  type SimplePlot, type SimpleWidgetForm, type SimpleWidgetType,
} from './simpleDsl';

// Re-export types/constants used by parents (e.g., WidgetV2Editor) so the
// public surface of this module stays the same.
export { EMPTY_SIMPLE_FORM, generateDsl };
export type { SimpleWidgetForm, SimpleGroup, SimpleMeasure, SimplePlot, SimpleWidgetType, FormatKind };

const API_URL = 'http://localhost:3001';

// ─── Schema model ─────────────────────────────────────────────────────────────

interface SchemaAttribute {
  internalName: string;
  displayName: string;
  description: string;
}

interface SchemaDefinition {
  code: string;
  name: string;
  attributes: SchemaAttribute[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function uid() { return Math.random().toString(36).slice(2, 9); }

/** Plot role labels by chart type — friendly labels only, no DSL hint. */
const PLOT_ROLE_LABELS: Record<SimpleWidgetType, Record<string, string>> = {
  line:        { x: 'X axis',        y: 'Lines (values)' },
  stacked_bar: { x: 'X axis',        series: 'Stack by',     y: 'Bar value' },
  kpi:         { value: 'Main value', secondary: 'Secondary values' },
  ranked_list: { label: 'Row label',  primary: 'Main value', secondary: 'Secondary values' },
  donut:       { category: 'Slice by', value: 'Slice value' },
  hbar:        { category: 'Bar by',  value: 'Bar value' },
};

// ─── Component ────────────────────────────────────────────────────────────────

interface Props {
  form: SimpleWidgetForm;
  /** The widget name (owned by the parent's name input). Becomes `widget "<name>"` in the DSL. */
  widgetName: string;
  onChange: (f: SimpleWidgetForm) => void;
  onDslChange: (dsl: string) => void;
}

/**
 * Walk forward from `el` and focus the next focusable input/select/textarea.
 * Mirrors `focusNextField` in MetricTypeahead.
 */
function focusNextFieldFrom(el: HTMLElement | null): void {
  if (!el) return;
  requestAnimationFrame(() => {
    const all = Array.from(
      document.querySelectorAll<HTMLElement>(
        'input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled])'
      )
    );
    const inside = all.filter((x) => el.contains(x));
    if (inside.length === 0) return;
    const last = inside[inside.length - 1];
    const idx = all.indexOf(last);
    if (idx >= 0 && idx + 1 < all.length) all[idx + 1].focus();
  });
}

export function SimpleModeWidgetEditor({ form, widgetName, onChange, onDslChange }: Props) {
  const [definitions, setDefinitions] = useState<SchemaDefinition[]>([
    { code: 'TIM', name: 'TIM', attributes: [] },
  ]);

  // Load source definitions and their attributes.
  useEffect(() => {
    let cancelled = false;
    fetch(`${API_URL}/api/schema/definitions`)
      .then((r) => r.json())
      .then((data) => {
        if (cancelled || !data?.success) return;
        const defs: SchemaDefinition[] = (data.definitions ?? []).map((d: {
          code: string;
          name?: string;
          attributes?: { internalName: string; displayName?: string; description?: string }[];
        }) => ({
          code: d.code,
          name: d.name || d.code,
          attributes: (d.attributes ?? []).map((a) => ({
            internalName: a.internalName,
            displayName: a.displayName || a.internalName,
            description: a.description || '',
          })),
        }));
        if (!defs.find((d) => d.code === 'TIM')) {
          defs.unshift({ code: 'TIM', name: 'TIM', attributes: [] });
        }
        setDefinitions(defs);
      })
      .catch(() => { /* keep default */ });
    return () => { cancelled = true; };
  }, []);

  const sourceOptions: AutocompleteOption[] = useMemo(
    () => definitions.map((d) => ({ value: d.code, label: d.name })),
    [definitions]
  );

  const currentDef = useMemo(
    () => definitions.find((d) => d.code === form.source),
    [definitions, form.source]
  );
  const sourceAttributes = currentDef?.attributes ?? [];
  const alias = sourceAlias(form.source);

  const dsl = useMemo(() => generateDsl(form, widgetName), [form, widgetName]);

  // Push DSL changes upward, but only when the DSL itself changes — NOT when the
  // parent re-renders with a new onDslChange function ref. Otherwise every parent
  // re-render fires the callback (which clears Run results), and the chart
  // vanishes the moment Run completes.
  const onDslChangeRef = useRef(onDslChange);
  useEffect(() => { onDslChangeRef.current = onDslChange; }, [onDslChange]);
  useEffect(() => { onDslChangeRef.current(dsl); }, [dsl]);

  const update = (patch: Partial<SimpleWidgetForm>) => onChange({ ...form, ...patch });
  const updatePlot = (patch: Partial<SimplePlot>) => onChange({ ...form, plot: { ...form.plot, ...patch } });

  const groupOptions: AutocompleteOption[] = form.groups
    .filter((g) => g.name.trim())
    .map((g) => ({ value: g.name.trim(), label: g.name.trim() }));
  const measureNames = form.measures.map((m) => m.name.trim()).filter(Boolean);

  // ── Filter row helpers ─────────────────────────────────────────────────────
  const addFilter = () => update({
    filters: [...form.filters, { id: uid(), kind: 'clause', field: '', op: '=', values: '' }],
  });
  const updateFilter = (id: string, next: SimpleFilter) =>
    update({ filters: form.filters.map((f) => (f.id === id ? next : f)) });
  const removeFilter = (id: string) =>
    update({ filters: form.filters.filter((f) => f.id !== id) });

  // ── Group row helpers ──────────────────────────────────────────────────────
  const addGroup = () => update({
    groups: [...form.groups, { id: uid(), name: '', kind: 'period', periodType: 'day' }],
  });
  const updateGroup = (id: string, next: SimpleGroup) =>
    update({ groups: form.groups.map((g) => (g.id === id ? next : g)) });
  const removeGroup = (id: string) =>
    update({ groups: form.groups.filter((g) => g.id !== id) });

  // ── Measure row helpers ────────────────────────────────────────────────────
  const addMeasure = () => update({
    measures: [...form.measures, {
      id: uid(),
      name: '',
      kind: 'aggregate',
      aggregator: 'sum',
      field: { kind: 'path', path: '' },
    }],
  });
  const updateMeasure = (id: string, next: SimpleMeasure) =>
    update({ measures: form.measures.map((m) => (m.id === id ? next : m)) });
  const removeMeasure = (id: string) =>
    update({ measures: form.measures.filter((m) => m.id !== id) });

  return (
    <div className="simple-editor">
      {/* ── Basics ─────────────────────────────────────────────────────────── */}
      <section className="simple-section">
        <h4>Basics</h4>
        <div className="simple-row">
          <label>Chart type</label>
          <select
            value={form.type}
            onChange={(e) => update({ type: e.target.value as SimpleWidgetType, plot: {} })}
          >
            {WIDGET_TYPES.map((t) => (
              <option key={t} value={t}>{WIDGET_TYPE_LABELS[t]}</option>
            ))}
          </select>
        </div>
      </section>

      {/* ── Source ─────────────────────────────────────────────────────────── */}
      <section className="simple-section">
        <h4>Source</h4>
        <div className="simple-row">
          <label>Definition</label>
          <AutocompleteSelect
            options={sourceOptions}
            value={form.source}
            onChange={(v) => update({ source: v })}
            placeholder="TIM"
          />
        </div>
      </section>

      {/* ── Filters ────────────────────────────────────────────────────────── */}
      <section className="simple-section">
        <div className="simple-section-header">
          <h4>Filters (optional)</h4>
          <button type="button" className="btn-ghost" onClick={addFilter}>+ Add filter</button>
        </div>
        {form.filters.length === 0 && (
          <div className="simple-hint">No filters — all entries from {form.source} are included.</div>
        )}
        {form.filters.map((f) => (
          <FilterRow
            key={f.id}
            filter={f}
            attributes={sourceAttributes}
            onChange={(next) => updateFilter(f.id, next)}
            onRemove={() => removeFilter(f.id)}
          />
        ))}
      </section>

      {/* ── Break down by (Groups) ─────────────────────────────────────────── */}
      <section className="simple-section">
        <div className="simple-section-header">
          <h4>Break down by (groups)</h4>
          <button type="button" className="btn-ghost" onClick={addGroup}>+ Add group</button>
        </div>
        {form.groups.length === 0 && (
          <div className="simple-hint">No groups — measures will collapse to a single value.</div>
        )}
        {form.groups.map((g) => (
          <GroupRow
            key={g.id}
            group={g}
            attributes={sourceAttributes}
            onChange={(next) => updateGroup(g.id, next)}
            onRemove={() => removeGroup(g.id)}
          />
        ))}
      </section>

      {/* ── What to measure ────────────────────────────────────────────────── */}
      <section className="simple-section">
        <div className="simple-section-header">
          <h4>What to measure</h4>
          <button type="button" className="btn-ghost" onClick={addMeasure}>+ Add measure</button>
        </div>
        {form.measures.length === 0 && (
          <div className="simple-hint">Add at least one measure to get a chart.</div>
        )}
        {form.measures.map((m) => (
          <MeasureRow
            key={m.id}
            measure={m}
            sourceCode={form.source}
            attributes={sourceAttributes}
            onChange={(next) => updateMeasure(m.id, next)}
            onRemove={() => removeMeasure(m.id)}
          />
        ))}
      </section>

      {/* ── Plot ───────────────────────────────────────────────────────────── */}
      <section className="simple-section">
        <h4>Chart layout</h4>
        <PlotControls
          form={form}
          groupOptions={groupOptions}
          measureNames={measureNames}
          updatePlot={updatePlot}
        />
      </section>

      {/* ── Advanced (format + color) ──────────────────────────────────────── */}
      {form.measures.length > 0 && (
        <details className="simple-section simple-advanced">
          <summary>Advanced — formatting & colors</summary>
          <div className="simple-advanced-body">
            <h5>Format</h5>
            {form.measures.filter((m) => m.name.trim()).map((m) => (
              <div className="simple-row" key={`fmt-${m.id}`}>
                <label>{m.name}</label>
                <select
                  value={m.format ?? ''}
                  onChange={(e) => {
                    const val = e.target.value as FormatKind | '';
                    updateMeasure(m.id, { ...m, format: val || undefined });
                  }}
                >
                  <option value="">(none — auto)</option>
                  {FORMATS.map((f) => <option key={f} value={f}>{f}</option>)}
                </select>
              </div>
            ))}
            <h5>Color</h5>
            {form.measures.filter((m) => m.name.trim()).map((m) => (
              <div className="simple-row" key={`color-${m.id}`}>
                <label>{m.name}</label>
                <ColorPicker
                  value={m.color ?? ''}
                  onChange={(c) => updateMeasure(m.id, { ...m, color: c || undefined })}
                />
              </div>
            ))}
          </div>
        </details>
      )}

      {/* ── DSL preview ────────────────────────────────────────────────────── */}
      <section className="simple-section">
        <h4>Generated DSL</h4>
        <pre className="simple-dsl-preview"><code>{dsl}</code></pre>
        <div className="simple-hint">Source alias is <code>{alias}</code>. Switch to Advanced to edit DSL directly.</div>
      </section>
    </div>
  );
}

// ─── Filter row ───────────────────────────────────────────────────────────────

interface FilterRowProps {
  filter: SimpleFilter;
  attributes: SchemaAttribute[];
  onChange: (next: SimpleFilter) => void;
  onRemove: () => void;
}

function FilterRow({ filter, attributes, onChange, onRemove }: FilterRowProps) {
  if (filter.kind === 'expression') {
    return (
      <div className="simple-row simple-row-stack">
        <label>where</label>
        <input
          type="text"
          placeholder="e.g. tims.parent.code in [&quot;EST&quot;] and tims.duration > 60"
          value={filter.expression}
          onChange={(e) => onChange({ ...filter, expression: e.target.value })}
        />
        <button
          type="button"
          className="btn-ghost simple-link-btn"
          title="Switch back to structured filter"
          onClick={() => onChange({ id: filter.id, kind: 'clause', field: '', op: '=', values: '' })}
        >use builder</button>
        <button type="button" className="btn-ghost simple-x" onClick={onRemove}>✕</button>
      </div>
    );
  }
  return (
    <div className="simple-list-item simple-filter-row">
      <PathCombobox
        attributes={attributes}
        value={filter.field}
        onChange={(v) => onChange({ ...filter, field: v })}
        placeholder="field (e.g. parent.code)"
      />
      <select
        value={filter.op}
        onChange={(e) => onChange({ ...filter, op: e.target.value as FilterOp })}
        title={FILTER_OP_LABELS[filter.op]}
      >
        {FILTER_OPS.map((op) => <option key={op} value={op}>{op}</option>)}
      </select>
      <input
        type="text"
        placeholder={filter.op === 'in' ? 'EST, READ' : 'value'}
        value={filter.values}
        onChange={(e) => onChange({ ...filter, values: e.target.value })}
      />
      <button
        type="button"
        className="btn-ghost simple-link-btn"
        title="Use a free-text expression instead"
        onClick={() => onChange({ id: filter.id, kind: 'expression', expression: '' })}
      >use expression</button>
      <button type="button" className="btn-ghost simple-x" onClick={onRemove}>✕</button>
    </div>
  );
}

// ─── Group row ────────────────────────────────────────────────────────────────

interface GroupRowProps {
  group: SimpleGroup;
  attributes: SchemaAttribute[];
  onChange: (next: SimpleGroup) => void;
  onRemove: () => void;
}

function GroupRow({ group, attributes, onChange, onRemove }: GroupRowProps) {
  const setKind = (kind: SimpleGroup['kind']) => {
    if (kind === group.kind) return;
    if (kind === 'period') {
      onChange({ id: group.id, name: group.name, kind: 'period', periodType: 'day' });
    } else if (kind === 'field') {
      onChange({ id: group.id, name: group.name, kind: 'field', field: '' });
    } else {
      onChange({ id: group.id, name: group.name, kind: 'expression', expression: '' });
    }
  };

  return (
    <div className="simple-list-item simple-group-row">
      <input
        type="text"
        className="simple-name-input"
        placeholder="name (e.g. x)"
        value={group.name}
        onChange={(e) => onChange({ ...group, name: e.target.value })}
      />
      <select
        className="simple-kind-select"
        value={group.kind}
        onChange={(e) => setKind(e.target.value as SimpleGroup['kind'])}
      >
        <option value="period">Time period</option>
        <option value="field">Field</option>
        <option value="expression">Expression</option>
      </select>

      {group.kind === 'period' && (
        <select
          value={group.periodType}
          onChange={(e) => onChange({ ...group, periodType: e.target.value as PeriodType })}
        >
          {PERIOD_TYPES.map((p) => <option key={p} value={p}>{PERIOD_LABELS[p]}</option>)}
        </select>
      )}
      {group.kind === 'field' && (
        <PathCombobox
          attributes={attributes}
          value={group.field}
          onChange={(v) => onChange({ ...group, field: v })}
          placeholder="field (e.g. book_title, parent.project)"
        />
      )}
      {group.kind === 'expression' && (
        <input
          type="text"
          placeholder='e.g. topk(reads.book_title, 5, by=sum(reads.duration))'
          value={group.expression}
          onChange={(e) => onChange({ ...group, expression: e.target.value })}
        />
      )}

      <button type="button" className="btn-ghost simple-x" onClick={onRemove}>✕</button>
    </div>
  );
}

// ─── Measure row ──────────────────────────────────────────────────────────────

interface MeasureRowProps {
  measure: SimpleMeasure;
  sourceCode: string;
  attributes: SchemaAttribute[];
  onChange: (next: SimpleMeasure) => void;
  onRemove: () => void;
}

function MeasureRow({ measure, sourceCode, attributes, onChange, onRemove }: MeasureRowProps) {
  const setKind = (kind: SimpleMeasure['kind']) => {
    if (kind === measure.kind) return;
    const base = { id: measure.id, name: measure.name, format: measure.format, color: measure.color };
    if (kind === 'aggregate') {
      onChange({ ...base, kind: 'aggregate', aggregator: 'sum', field: { kind: 'path', path: '' } });
    } else {
      onChange({ ...base, kind: 'expression', formula: '' });
    }
  };

  return (
    <div className="simple-list-item simple-measure-row">
      <input
        type="text"
        className="simple-name-input"
        placeholder="name (e.g. productive)"
        value={measure.name}
        onChange={(e) => onChange({ ...measure, name: e.target.value })}
      />
      <select
        className="simple-kind-select"
        value={measure.kind}
        onChange={(e) => setKind(e.target.value as SimpleMeasure['kind'])}
      >
        <option value="aggregate">Aggregate</option>
        <option value="expression">Formula</option>
      </select>

      {measure.kind === 'aggregate' && (
        <>
          <select
            value={measure.aggregator}
            onChange={(e) => onChange({ ...measure, aggregator: e.target.value as AggregatorKind })}
          >
            {AGGREGATORS.map((a) => <option key={a} value={a}>{AGGREGATOR_LABELS[a]}</option>)}
          </select>
          {measure.aggregator !== 'count' && (
            <>
              <span className="simple-of">of</span>
              <MeasureFieldCombobox
                sourceCode={sourceCode}
                attributes={attributes}
                value={measure.field}
                onChange={(field) => onChange({ ...measure, field })}
              />
            </>
          )}
        </>
      )}
      {measure.kind === 'expression' && (
        <input
          type="text"
          placeholder='e.g. sum(tims.time("t")) / sum(tims.duration)'
          value={measure.formula}
          onChange={(e) => onChange({ ...measure, formula: e.target.value })}
        />
      )}

      <button type="button" className="btn-ghost simple-x" onClick={onRemove}>✕</button>
    </div>
  );
}

// ─── ColorPicker: swatch dropdown + free-text fallback ───────────────────────

const COLOR_PRESETS: { label: string; value: string }[] = [
  { label: 'Red',    value: 'red'    },
  { label: 'Orange', value: 'orange' },
  { label: 'Yellow', value: 'yellow' },
  { label: 'Green',  value: 'green'  },
  { label: 'Teal',   value: 'teal'   },
  { label: 'Blue',   value: 'blue'   },
  { label: 'Indigo', value: 'indigo' },
  { label: 'Purple', value: 'purple' },
  { label: 'Pink',   value: 'pink'   },
  { label: 'Brown',  value: 'brown'  },
  { label: 'Gray',   value: 'gray'   },
  { label: 'Black',  value: 'black'  },
];

interface ColorPickerProps {
  value: string;
  onChange: (next: string) => void;
}

function ColorPicker({ value, onChange }: ColorPickerProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  return (
    <div className="simple-color-picker" ref={containerRef}>
      <button
        type="button"
        className="simple-color-swatch"
        title="Pick a color"
        style={{ background: value || 'transparent' }}
        onClick={() => setOpen((o) => !o)}
      />
      <input
        type="text"
        className="simple-color-input"
        placeholder="e.g. green, #3366cc"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => setOpen(true)}
      />
      {open && (
        <div className="simple-color-grid">
          {COLOR_PRESETS.map((c) => (
            <button
              key={c.value}
              type="button"
              className={`simple-color-cell${value === c.value ? ' selected' : ''}`}
              title={c.label}
              style={{ background: c.value }}
              onClick={() => { onChange(c.value); setOpen(false); }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── PathCombobox: free-typing autocomplete over source attributes ────────────

interface PathComboboxProps {
  attributes: SchemaAttribute[];
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}

function PathCombobox({ attributes, value, onChange, placeholder }: PathComboboxProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  const lower = value.toLowerCase();
  const suggestions = attributes.filter(
    (a) => !value || a.internalName.toLowerCase().includes(lower) || a.displayName.toLowerCase().includes(lower)
  );

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Tab' && open && suggestions.length > 0) {
      e.preventDefault();
      onChange(suggestions[0].internalName);
      setOpen(false);
      focusNextFieldFrom(containerRef.current);
    }
  };

  return (
    <div className="simple-combobox" ref={containerRef}>
      <input
        type="text"
        value={value}
        onChange={(e) => { onChange(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
      />
      {open && suggestions.length > 0 && (
        <div className="simple-combobox-list">
          {suggestions.map((a) => (
            <div
              key={a.internalName}
              className="simple-combobox-option"
              onMouseDown={(e) => {
                e.preventDefault();
                onChange(a.internalName);
                setOpen(false);
              }}
            >
              <span className="simple-combobox-name">{a.internalName}</span>
              {a.displayName && a.displayName !== a.internalName && (
                <span className="simple-combobox-label"> – {a.displayName}</span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── MeasureFieldCombobox: paths + (for TIM) time-category options ────────────

interface MeasureFieldComboboxProps {
  sourceCode: string;
  attributes: SchemaAttribute[];
  value: AggregateField;
  onChange: (field: AggregateField) => void;
}

interface MeasureFieldOption {
  key: string;
  label: string;
  field: AggregateField;
}

function MeasureFieldCombobox({ sourceCode, attributes, value, onChange }: MeasureFieldComboboxProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  // Build the option list. TIM categories first (when applicable), then attrs.
  const options: MeasureFieldOption[] = useMemo(() => {
    const opts: MeasureFieldOption[] = [];
    if (sourceCode === 'TIM') {
      for (const c of TIM_CATEGORIES) {
        opts.push({
          key: `tim:${c}`,
          label: `time: ${TIM_CATEGORY_LABELS[c]} (${c})`,
          field: { kind: 'tim_time', category: c },
        });
      }
    }
    for (const a of attributes) {
      opts.push({
        key: `path:${a.internalName}`,
        label: a.displayName && a.displayName !== a.internalName
          ? `${a.internalName} – ${a.displayName}`
          : a.internalName,
        field: { kind: 'path', path: a.internalName },
      });
    }
    return opts;
  }, [sourceCode, attributes]);

  // Display string: what shows in the input.
  const displayText =
    value.kind === 'tim_time'
      ? `time: ${TIM_CATEGORY_LABELS[value.category]} (${value.category})`
      : value.path;

  // Free typing: always treated as a path.
  const onInputChange = (raw: string) => {
    onChange({ kind: 'path', path: raw });
    setOpen(true);
  };

  const lower = displayText.toLowerCase();
  const filtered = options.filter((o) => o.label.toLowerCase().includes(lower));

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Tab' && open && filtered.length > 0) {
      e.preventDefault();
      onChange(filtered[0].field);
      setOpen(false);
      focusNextFieldFrom(containerRef.current);
    }
  };

  return (
    <div className="simple-combobox" ref={containerRef}>
      <input
        type="text"
        value={displayText}
        onChange={(e) => onInputChange(e.target.value)}
        onFocus={() => setOpen(true)}
        onKeyDown={handleKeyDown}
        placeholder="field (e.g. duration, parent.project)"
      />
      {open && filtered.length > 0 && (
        <div className="simple-combobox-list">
          {filtered.map((o) => (
            <div
              key={o.key}
              className="simple-combobox-option"
              onMouseDown={(e) => {
                e.preventDefault();
                onChange(o.field);
                setOpen(false);
              }}
            >
              {o.label}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Plot controls ────────────────────────────────────────────────────────────

interface PlotProps {
  form: SimpleWidgetForm;
  groupOptions: AutocompleteOption[];
  measureNames: string[];
  updatePlot: (patch: Partial<SimplePlot>) => void;
}

function PlotControls({ form, groupOptions, measureNames, updatePlot }: PlotProps) {
  const p = form.plot;
  const labels = PLOT_ROLE_LABELS[form.type];

  const groupSelect = (value: string | undefined, onChange: (v: string) => void) => (
    <AutocompleteSelect
      options={groupOptions}
      value={value ?? ''}
      onChange={onChange}
      placeholder={groupOptions.length === 0 ? 'Define a group first' : 'group'}
    />
  );
  const measureSelect = (value: string | undefined, onChange: (v: string) => void) => (
    <select value={value ?? ''} onChange={(e) => onChange(e.target.value)}>
      <option value="">{measureNames.length === 0 ? 'Define a measure first' : 'measure…'}</option>
      {measureNames.map((n) => <option key={n} value={n}>{n}</option>)}
    </select>
  );
  const multiMeasure = (values: string[] | undefined, onChange: (v: string[]) => void) => (
    <div className="simple-multiselect">
      {measureNames.length === 0 && <span className="simple-hint">No measures defined</span>}
      {measureNames.map((n) => {
        const checked = values?.includes(n) ?? false;
        return (
          <label key={n} className="simple-check">
            <input
              type="checkbox"
              checked={checked}
              onChange={(e) => {
                const set = new Set(values ?? []);
                if (e.target.checked) set.add(n); else set.delete(n);
                onChange(Array.from(set));
              }}
            />
            {n}
          </label>
        );
      })}
    </div>
  );

  switch (form.type) {
    case 'line':
      return (
        <>
          <div className="simple-row"><label>{labels.x}</label>{groupSelect(p.x, (v) => updatePlot({ x: v }))}</div>
          <div className="simple-row"><label>{labels.y}</label>{multiMeasure(p.y, (v) => updatePlot({ y: v }))}</div>
        </>
      );
    case 'stacked_bar':
      return (
        <>
          <div className="simple-row"><label>{labels.x}</label>{groupSelect(p.x, (v) => updatePlot({ x: v }))}</div>
          <div className="simple-row"><label>{labels.series}</label>{groupSelect(p.series, (v) => updatePlot({ series: v }))}</div>
          <div className="simple-row"><label>{labels.y}</label>{measureSelect(p.yMeasure, (v) => updatePlot({ yMeasure: v }))}</div>
        </>
      );
    case 'kpi':
      return (
        <>
          <div className="simple-row"><label>{labels.value}</label>{measureSelect(p.value, (v) => updatePlot({ value: v }))}</div>
          <div className="simple-row"><label>{labels.secondary}</label>{multiMeasure(p.secondary, (v) => updatePlot({ secondary: v }))}</div>
        </>
      );
    case 'ranked_list':
      return (
        <>
          <div className="simple-row"><label>{labels.label}</label>{groupSelect(p.label, (v) => updatePlot({ label: v }))}</div>
          <div className="simple-row"><label>{labels.primary}</label>{measureSelect(p.primary, (v) => updatePlot({ primary: v }))}</div>
          <div className="simple-row"><label>{labels.secondary}</label>{multiMeasure(p.secondary, (v) => updatePlot({ secondary: v }))}</div>
        </>
      );
    case 'donut':
    case 'hbar':
      return (
        <>
          <div className="simple-row"><label>{labels.category}</label>{groupSelect(p.category, (v) => updatePlot({ category: v }))}</div>
          <div className="simple-row"><label>{labels.value}</label>{measureSelect(p.yMeasure, (v) => updatePlot({ yMeasure: v }))}</div>
        </>
      );
  }
}
