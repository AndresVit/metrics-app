/**
 * simpleDsl.ts
 *
 * Pure types + DSL generator for the v2 Simple-Mode widget editor.
 * The form state uses discriminated unions so every input has a
 * structured form (the common case) plus a `kind: 'expression'` escape
 * hatch (free-text DSL fragment) for power users.
 *
 * The generator emits the same DSL as the Advanced editor — Simple Mode
 * is a UI veneer, not a separate language.
 */

// ─── Widget-type catalogue ────────────────────────────────────────────────────

export type SimpleWidgetType =
  | 'line'
  | 'stacked_bar'
  | 'kpi'
  | 'ranked_list'
  | 'donut'
  | 'hbar';

export const WIDGET_TYPE_LABELS: Record<SimpleWidgetType, string> = {
  line: 'Line chart',
  stacked_bar: 'Stacked bar chart',
  kpi: 'KPI (single number)',
  ranked_list: 'Ranked list',
  donut: 'Donut chart',
  hbar: 'Horizontal bar chart',
};

export const WIDGET_TYPES: SimpleWidgetType[] = [
  'line', 'stacked_bar', 'kpi', 'ranked_list', 'donut', 'hbar',
];

// ─── Period types ─────────────────────────────────────────────────────────────

export type PeriodType =
  | 'hour' | 'day' | 'week' | 'month'
  | 'weekday' | 'day_of_month' | 'month_of_year';

export const PERIOD_TYPES: PeriodType[] = [
  'hour', 'day', 'week', 'month', 'weekday', 'day_of_month', 'month_of_year',
];

export const PERIOD_LABELS: Record<PeriodType, string> = {
  hour: 'Hour',
  day: 'Day',
  week: 'Week',
  month: 'Month',
  weekday: 'Day of week',
  day_of_month: 'Day of month',
  month_of_year: 'Month of year',
};

// ─── Aggregators ──────────────────────────────────────────────────────────────

export type AggregatorKind = 'sum' | 'avg' | 'count' | 'min' | 'max';

export const AGGREGATORS: AggregatorKind[] = ['sum', 'avg', 'count', 'min', 'max'];

export const AGGREGATOR_LABELS: Record<AggregatorKind, string> = {
  sum: 'Sum',
  avg: 'Average',
  count: 'Count',
  min: 'Minimum',
  max: 'Maximum',
};

// ─── Filter operators ─────────────────────────────────────────────────────────
// Note: the widget DSL uses single `=` for equality, not `==` (see lexer.ts).
// The UI displays `=` and emits it directly into the DSL.

export type FilterOp = 'in' | '=' | '!=' | '>' | '<' | '>=' | '<=';

export const FILTER_OPS: FilterOp[] = ['=', '!=', 'in', '>', '<', '>=', '<='];

export const FILTER_OP_LABELS: Record<FilterOp, string> = {
  '=': 'equals',
  '!=': 'not equal',
  in: 'in (matches or is under)',
  '>': 'greater than',
  '<': 'less than',
  '>=': 'greater or equal',
  '<=': 'less or equal',
};

// ─── TIM time categories ──────────────────────────────────────────────────────
// User-facing labels for the t/m/p/n arguments to tims.time(...).

export type TimCategory = 't' | 'm' | 'p' | 'n';

export const TIM_CATEGORIES: TimCategory[] = ['t', 'm', 'p', 'n'];

export const TIM_CATEGORY_LABELS: Record<TimCategory, string> = {
  t: 'Productive',
  m: 'Unproductive',
  p: 'Lost',
  n: 'Neutral',
};

// ─── Format / Color (advanced) ────────────────────────────────────────────────

export type FormatKind = 'number' | 'float' | 'duration';

export const FORMATS: FormatKind[] = ['number', 'float', 'duration'];

// ─── Filter clause ────────────────────────────────────────────────────────────

export type SimpleFilter =
  | {
      id: string;
      kind: 'clause';
      /** Path on the source, no alias prefix (e.g., "parent.code"). */
      field: string;
      op: FilterOp;
      /** Comma-separated raw values (we quote/format on emit). */
      values: string;
    }
  | { id: string; kind: 'expression'; expression: string };

// ─── Group dimension ──────────────────────────────────────────────────────────

export type SimpleGroup =
  | { id: string; name: string; kind: 'period'; periodType: PeriodType }
  | {
      id: string;
      name: string;
      kind: 'field';
      /** Path on the source, no alias prefix (e.g., "book_title", "parent.project"). */
      field: string;
    }
  | { id: string; name: string; kind: 'expression'; expression: string };

// ─── Measure ──────────────────────────────────────────────────────────────────

/** What the aggregator is applied to. */
export type AggregateField =
  | {
      kind: 'path';
      /** Path on the source (e.g., "duration", "wpm"). Empty path is invalid. */
      path: string;
    }
  | { kind: 'tim_time'; category: TimCategory };

export type SimpleMeasure = {
  id: string;
  name: string;
  format?: FormatKind;
  color?: string;
} & (
  | { kind: 'aggregate'; aggregator: AggregatorKind; field: AggregateField }
  | { kind: 'expression'; formula: string }
);

// ─── Plot ─────────────────────────────────────────────────────────────────────

export interface SimplePlot {
  x?: string;             // group name — line / stacked_bar
  y?: string[];           // measure names — line
  series?: string;        // group name — stacked_bar
  yMeasure?: string;      // measure name — stacked_bar / donut / hbar
  value?: string;         // measure name — kpi
  secondary?: string[];   // measure names — kpi / ranked_list
  label?: string;         // group name — ranked_list
  primary?: string;       // measure name — ranked_list
  category?: string;      // group name — donut / hbar
}

// ─── Whole form ───────────────────────────────────────────────────────────────

/**
 * Form state for Simple Mode. The widget *name* is owned by the parent
 * (WidgetV2Editor's name input) and passed into `generateDsl` separately —
 * keeping it here would create two visible name inputs.
 */
export interface SimpleWidgetForm {
  type: SimpleWidgetType;
  /** Definition code (e.g., "TIM", "READ"). Alias is auto-derived. */
  source: string;
  filters: SimpleFilter[];
  groups: SimpleGroup[];
  measures: SimpleMeasure[];
  plot: SimplePlot;
}

export const EMPTY_SIMPLE_FORM: SimpleWidgetForm = {
  type: 'line',
  source: 'TIM',
  filters: [],
  groups: [],
  measures: [],
  plot: {},
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Lower-case + 's'. Matches the convention in user examples
 * (TIM → tims, READ → reads).
 */
export function sourceAlias(code: string): string {
  return (code || '').toLowerCase() + 's';
}

const NUMERIC_RE = /^-?\d+(\.\d+)?$/;

/** Quote a single filter value unless it looks like a number. */
function emitFilterValue(raw: string): string {
  const v = raw.trim();
  if (v === '') return '""';
  if (NUMERIC_RE.test(v)) return v;
  // Strip any quotes the user typed; we re-add them.
  const unquoted = v.replace(/^["']|["']$/g, '');
  return `"${unquoted}"`;
}

function emitFilterValues(csv: string): string[] {
  return csv.split(',').map((s) => emitFilterValue(s)).filter((s) => s !== '');
}

/** Compose a path expression: <alias>.<path>, or just <alias> if path empty. */
function composePath(alias: string, path: string): string {
  const p = path.trim();
  if (!p) return alias;
  return `${alias}.${p}`;
}

const IDENT_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/**
 * The DSL `color` block accepts either an IDENT (like `green`) or a quoted
 * STRING (like `"#3b82f6"`). Wrap anything that isn't a bare identifier.
 */
function emitColorValue(raw: string): string {
  const v = raw.trim();
  if (!v) return v;
  // Strip any quotes the user typed, then re-emit with the right quoting.
  const unquoted = v.replace(/^["']|["']$/g, '');
  if (IDENT_RE.test(unquoted)) return unquoted;
  return `"${unquoted}"`;
}

// ─── DSL generation ───────────────────────────────────────────────────────────

export function generateDsl(form: SimpleWidgetForm, widgetName: string): string {
  const indent = (n: number) => '  '.repeat(n);
  const alias = sourceAlias(form.source);
  const lines: string[] = [];

  const name = widgetName.trim() || 'untitled';
  lines.push(`widget "${name}" {`);

  // ── data block ────────────────────────────────────────────────────────────
  const dataLines: string[] = [];
  dataLines.push(`${indent(2)}source: ${form.source}${alias ? ` as ${alias}` : ''}`);

  const whereExpr = generateWhere(form.filters, alias);
  if (whereExpr) dataLines.push(`${indent(2)}where: ${whereExpr}`);

  for (const g of form.groups) {
    const line = generateGroupLine(g, alias);
    if (line) dataLines.push(`${indent(2)}${line}`);
  }

  for (const m of form.measures) {
    const line = generateMeasureLine(m, alias);
    if (line) dataLines.push(`${indent(2)}${line}`);
  }

  lines.push(`${indent(1)}data {`);
  lines.push(...dataLines);
  lines.push(`${indent(1)}}`);

  // ── plot block (with nested format / color) ───────────────────────────────
  // Per the parser, `format { ... }` and `color { ... }` are parsed *inside*
  // the plot block, not as siblings of `data`/`plot`. (parser.ts:parsePlotSpec)
  const plotLines = generatePlotLines(form, indent);
  if (plotLines.length > 0) {
    lines.push('');
    lines.push(`${indent(1)}plot {`);
    lines.push(`${indent(2)}type: ${form.type}`);
    lines.push(...plotLines);

    const fmt = form.measures.filter((m) => m.format && m.name.trim());
    if (fmt.length > 0) {
      lines.push('');
      lines.push(`${indent(2)}format {`);
      for (const m of fmt) lines.push(`${indent(3)}${m.name.trim()}: ${m.format}`);
      lines.push(`${indent(2)}}`);
    }

    const colors = form.measures.filter((m) => m.color && m.name.trim());
    if (colors.length > 0) {
      lines.push('');
      lines.push(`${indent(2)}color {`);
      for (const m of colors) {
        lines.push(`${indent(3)}${m.name.trim()}: ${emitColorValue(m.color!)}`);
      }
      lines.push(`${indent(2)}}`);
    }

    lines.push(`${indent(1)}}`);
  }

  lines.push('}');
  return lines.join('\n');
}

function generateWhere(filters: SimpleFilter[], alias: string): string {
  const parts: string[] = [];
  for (const f of filters) {
    if (f.kind === 'expression') {
      const e = f.expression.trim();
      if (e) parts.push(`(${e})`);
    } else {
      const path = composePath(alias, f.field);
      if (!f.field.trim()) continue;
      if (f.op === 'in') {
        const vals = emitFilterValues(f.values);
        if (vals.length === 0) continue;
        parts.push(`${path} in [${vals.join(', ')}]`);
      } else {
        const v = emitFilterValue(f.values);
        if (!f.values.trim()) continue;
        parts.push(`${path} ${f.op} ${v}`);
      }
    }
  }
  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0];
  return parts.join(' and ');
}

function generateGroupLine(g: SimpleGroup, alias: string): string {
  const name = g.name.trim();
  if (!name) return '';
  switch (g.kind) {
    case 'period':
      return `group { ${name}: period(${g.periodType}) }`;
    case 'field': {
      if (!g.field.trim()) return '';
      return `group { ${name}: ${composePath(alias, g.field)} }`;
    }
    case 'expression': {
      const e = g.expression.trim();
      if (!e) return '';
      return `group { ${name}: ${e} }`;
    }
  }
}

function generateMeasureLine(m: SimpleMeasure, alias: string): string {
  const name = m.name.trim();
  if (!name) return '';
  if (m.kind === 'expression') {
    const f = m.formula.trim();
    if (!f) return '';
    return `measure ${name} = ${f}`;
  }
  // aggregate
  const agg = m.aggregator;
  if (agg === 'count') {
    return `measure ${name} = count(${alias})`;
  }
  let inner: string;
  if (m.field.kind === 'tim_time') {
    inner = `${alias}.time("${m.field.category}")`;
  } else {
    if (!m.field.path.trim()) return '';
    inner = composePath(alias, m.field.path);
  }
  return `measure ${name} = ${agg}(${inner})`;
}

function generatePlotLines(form: SimpleWidgetForm, indent: (n: number) => string): string[] {
  const out: string[] = [];
  const p = form.plot;
  switch (form.type) {
    case 'line':
      if (p.x) out.push(`${indent(2)}x: ${p.x}`);
      if (p.y && p.y.length > 0) out.push(`${indent(2)}y: [${p.y.join(', ')}]`);
      break;
    case 'stacked_bar':
      if (p.x) out.push(`${indent(2)}x: ${p.x}`);
      if (p.series) out.push(`${indent(2)}series: ${p.series}`);
      if (p.yMeasure) out.push(`${indent(2)}y: ${p.yMeasure}`);
      break;
    case 'kpi':
      if (p.value) out.push(`${indent(2)}value: ${p.value}`);
      if (p.secondary && p.secondary.length > 0) out.push(`${indent(2)}secondary: [${p.secondary.join(', ')}]`);
      break;
    case 'ranked_list':
      if (p.label) out.push(`${indent(2)}label: ${p.label}`);
      if (p.primary) out.push(`${indent(2)}primary: ${p.primary}`);
      if (p.secondary && p.secondary.length > 0) out.push(`${indent(2)}secondary: [${p.secondary.join(', ')}]`);
      break;
    case 'donut':
    case 'hbar':
      if (p.category) out.push(`${indent(2)}category: ${p.category}`);
      if (p.yMeasure) out.push(`${indent(2)}value: ${p.yMeasure}`);
      break;
  }
  return out;
}
