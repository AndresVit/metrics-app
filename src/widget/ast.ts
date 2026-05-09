/**
 * Widget System v2 — Canonical AST
 *
 * Every widget is described as two sections:
 *
 *   data { source, where, group dimensions, named measures }
 *   plot { chart type, role mappings }
 *
 * The data section defines an intermediate aggregated table.
 * The plot section maps that table to a specific visualization.
 *
 * Internal representation is this structured AST — not raw DSL text.
 * Both the textual DSL parser and a future visual editor produce this AST.
 */

// ─────────────────────────────────────────────────────────────
// PATH SEGMENTS
// ─────────────────────────────────────────────────────────────

/** .fieldName */
export interface FieldSegment {
  kind: 'field';
  name: string;
}

/**
 * .parent — traverse to the parent entry.
 * For TIM entries, this reaches the activity entry (EST, WORK, etc.)
 * that contains the TIM session.
 */
export interface ParentSegment {
  kind: 'parent';
}

/** [n] — index into a slash-delimited hierarchy string */
export interface IndexSegment {
  kind: 'index';
  index: number;
}

/**
 * [start:end] / [start:] / [:end] — slice of a hierarchy string.
 * null means unbounded.
 */
export interface SliceSegment {
  kind: 'slice';
  start: number | null;
  end: number | null;
}

export type PathSegment = FieldSegment | ParentSegment | IndexSegment | SliceSegment;

// ─────────────────────────────────────────────────────────────
// EXPRESSION NODES
// ─────────────────────────────────────────────────────────────

/** 42, 3.14, "hello", true, false, null */
export interface LiteralExpr {
  kind: 'literal';
  value: number | string | boolean | null;
}

/**
 * A path expression starting from the dataset alias.
 * Examples:
 *   tims.duration
 *   tims.parent.project
 *   tims.parent.subdivision[0]
 *
 * The first segment is always a FieldSegment whose name is the alias.
 */
export interface PathExpr {
  kind: 'path';
  segments: PathSegment[];
}

/**
 * TIM time-label access.
 * tims.time("t")        → exact match for label "t"
 * tims.timeUnder("m")   → hierarchical: matches "m", "m/thk", "m/sw", etc.
 *
 * These are always inside aggregation functions: sum(tims.time("t"))
 */
export interface TimeExpr {
  kind: 'time';
  /** Path to the TIM entry collection (e.g. PathExpr for "tims") */
  path: PathExpr;
  /** The time type label */
  label: string;
  /** false = exact match only, true = UNDER prefix match */
  hierarchical: boolean;
}

/** ["EST", "WORK"] */
export interface ArrayExpr {
  kind: 'array';
  elements: Expr[];
}

/**
 * Function call: sum(...), avg(...), count(), min(...), max(...)
 * Also used internally for period() and topk() before they are
 * resolved into GroupDimension nodes.
 */
export interface CallExpr {
  kind: 'call';
  fn: string;
  args: Expr[];
  namedArgs: Record<string, Expr>;
}

/** Binary arithmetic or logical expression */
export interface BinaryExpr {
  kind: 'binary';
  op: BinaryOp;
  left: Expr;
  right: Expr;
}

export type BinaryOp =
  | '+' | '-' | '*' | '/' | '%'
  | '=' | '!=' | '<' | '<=' | '>' | '>='
  | 'and' | 'or';

/** Unary prefix: not x, -x */
export interface UnaryExpr {
  kind: 'unary';
  op: 'not' | 'neg';
  arg: Expr;
}

/** path in ["a", "b"] — or negated: path not in [...] */
export interface InExpr {
  kind: 'in';
  expr: Expr;
  values: Expr[];
  negated: boolean;
}

/**
 * path UNDER "prefix"
 * Matches the value itself AND any slash-delimited children.
 * e.g. UNDER "m" matches "m", "m/thk", "m/sw/foo"
 */
export interface UnderExpr {
  kind: 'under';
  expr: Expr;
  prefix: string;
  negated: boolean;
}

/**
 * Reference to a previously defined measure.
 * Enables derived measures: ratio = productive / total
 */
export interface MeasureRefExpr {
  kind: 'measure_ref';
  name: string;
}

export type Expr =
  | LiteralExpr
  | PathExpr
  | TimeExpr
  | ArrayExpr
  | CallExpr
  | BinaryExpr
  | UnaryExpr
  | InExpr
  | UnderExpr
  | MeasureRefExpr;

// ─────────────────────────────────────────────────────────────
// GROUP DIMENSIONS
// ─────────────────────────────────────────────────────────────

/**
 * Temporal bucket dimension.
 * period(day) groups by calendar day regardless of bigPeriod.
 * bigPeriod=year + period(weekday) → 7 buckets aggregated over the year.
 */
export interface PeriodDimension {
  kind: 'period';
  /** Name used to reference this dimension in the plot section */
  name: string;
  periodType: PeriodType;
}

export type PeriodType =
  | 'hour'
  | 'day'
  | 'week'
  | 'month'
  | 'weekday'
  | 'day_of_month'
  | 'month_of_year';

/** Group by a path value (an attribute, field, or hierarchy component) */
export interface AttributeDimension {
  kind: 'attribute';
  /** Name used to reference this dimension in the plot section */
  name: string;
  path: PathExpr;
}

/**
 * Top-K by some measure.
 * topk(tims.parent.subdivision[0], 10, by=sum(tims.time("t")))
 */
export interface TopkDimension {
  kind: 'topk';
  /** Name used to reference this dimension in the plot section */
  name: string;
  path: PathExpr;
  k: number;
  by: Expr;
}

export type GroupDimension = PeriodDimension | AttributeDimension | TopkDimension;

// ─────────────────────────────────────────────────────────────
// MEASURES
// ─────────────────────────────────────────────────────────────

export interface MeasureDef {
  name: string;
  expr: Expr;
}

// ─────────────────────────────────────────────────────────────
// SOURCE DECLARATION
// ─────────────────────────────────────────────────────────────

export interface SourceDecl {
  /** Definition code: "TIM", "EST", "READ", etc. */
  definitionCode: string;
  /** Alias used in path expressions: "tims", "reads", etc. */
  alias: string;
}

// ─────────────────────────────────────────────────────────────
// DATA SPEC
// ─────────────────────────────────────────────────────────────

export interface DataSpec {
  source: SourceDecl;
  where: Expr | null;
  /** Ordered list of group dimensions (may be empty for scalar widgets) */
  group: GroupDimension[];
  /** Named measures, evaluated in dependency order */
  measures: MeasureDef[];
}

// ─────────────────────────────────────────────────────────────
// PLOT SPEC
// ─────────────────────────────────────────────────────────────

export type PlotType = 'kpi' | 'bar' | 'stacked_bar' | 'line' | 'donut' | 'hbar' | 'ranked_list' | 'table';

/**
 * Supported value format types.
 *   number   → integer display (1234)
 *   float    → 2 decimal places (12.34)
 *   duration → minutes as "Xh Y" / "Y'" (e.g. 1689 → "28h9", 45 → "45'")
 */
export type FormatType = 'number' | 'float' | 'duration';

/**
 * Maps dimension/measure names to visual roles.
 *
 * Standard roles per plot type:
 *   kpi:         value, [secondary, tertiary, ...]
 *   bar:         x, y
 *   stacked_bar: x, series, y
 *   line:        x, y [array y for multi-series: y: [m1, m2]]
 *   donut:       category, value
 *   hbar:        category, value  (horizontal bars, same data shape as donut)
 *   table:       rows, value, [cols]
 */
export interface PlotSpec {
  type: PlotType;
  /**
   * role name → dimension/measure name, or list of names for multi-value roles.
   * List form is only valid for KPI (e.g. `secondary: [total, ratio]`).
   */
  roles: Record<string, string | string[]>;
  /**
   * Optional per-measure display format.
   * Absent measures use the default smart formatter.
   * DSL: format { productive: duration }
   */
  format: Record<string, FormatType>;
  /**
   * Optional per-measure / per-series color override.
   * Absent measures fall back to the default palette.
   * DSL: color { productive: green  unproductive: "#ef4444" }
   */
  color: Record<string, string>;
}

// ─────────────────────────────────────────────────────────────
// WIDGET DEFINITION
// ─────────────────────────────────────────────────────────────

export interface WidgetDef {
  name: string;
  data: DataSpec;
  plot: PlotSpec;
}

// ─────────────────────────────────────────────────────────────
// PARSE RESULT
// ─────────────────────────────────────────────────────────────

export interface ParseSuccess {
  ok: true;
  widget: WidgetDef;
}

export interface ParseFailure {
  ok: false;
  error: string;
  line?: number;
  col?: number;
}

export type ParseResult = ParseSuccess | ParseFailure;

// ─────────────────────────────────────────────────────────────
// INTERMEDIATE TABLE (executor output)
// ─────────────────────────────────────────────────────────────

/**
 * A single row in the aggregated intermediate table.
 * Both dimension values and measure values live in one flat record,
 * keyed by their declared name (dim name or measure name).
 *
 * Dimension values: string | null  (group bucket labels)
 * Measure values:   number | null  (aggregated results)
 */
export type IntermediateRow = Record<string, string | number | null>;

/**
 * The aggregated intermediate table produced by the executor.
 * This is the canonical "generic aggregated data" that the chart mapper
 * projects into chart-specific output — the mapper must not perform
 * any new aggregation, only structural transformation.
 *
 * dimColumns and measureColumns are stored separately so the mapper
 * and any inspection tools can distinguish them without parsing the AST.
 */
export interface IntermediateTable {
  /** Ordered group dimension column names (matching data.group[].name) */
  dimColumns: string[];
  /** Ordered measure column names (in dependency-evaluation order) */
  measureColumns: string[];
  rows: IntermediateRow[];
  /**
   * Aggregate row computed over all filtered entries without any grouping.
   * Used by ranked_list (and similar) for a semantically correct total row —
   * derived measures (ratios, etc.) are re-evaluated on the full dataset
   * rather than being summed across groups.
   */
  totalRow?: IntermediateRow;
}
