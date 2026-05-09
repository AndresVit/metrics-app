/**
 * Widget System v2 — Analyzer / Planner
 *
 * Walks a WidgetDef AST and produces an ExecutionPlan:
 *
 *  1. Validates all path expressions start from the declared source alias.
 *  2. Infers which joins are needed (parent traversal at each depth).
 *  3. Resolves measure dependencies and orders them topologically.
 *  4. Detects whether internal TIM_PART representation is required.
 *  5. Validates plot roles against declared dimensions and measures.
 *
 * TIM_PART is an internal representation that unpacks a single TIM entry
 * into one row per time-label token.  It is only needed when the query
 * must GROUP BY time-label type/hierarchy, or when timeUnder() is used
 * (because summing hierarchically in-memory across all labels is O(labels)
 * and requires knowing the label prefix structure).
 *
 * For simple sum(tims.time("t")) the executor runs directly on the loaded
 * TIM entries without TIM_PART.
 */

import type {
  WidgetDef, PlotSpec, PlotType,
  MeasureDef,
  Expr, PathExpr,
} from './ast';

// ─────────────────────────────────────────────────────────────
// Public result types
// ─────────────────────────────────────────────────────────────

export interface AnalysisSuccess {
  ok: true;
  plan: ExecutionPlan;
}

export interface AnalysisFailure {
  ok: false;
  errors: string[];
}

export type AnalysisResult = AnalysisSuccess | AnalysisFailure;

// ─────────────────────────────────────────────────────────────
// Execution plan
// ─────────────────────────────────────────────────────────────

/**
 * The execution plan produced by the analyzer.
 * The executor consumes this to load data and evaluate the widget.
 */
export interface ExecutionPlan {
  widget: WidgetDef;

  /** The source alias and definition code */
  sourceAlias: string;
  sourceCode: string;

  /**
   * Whether parent entries need to be loaded.
   * True when any path contains a .parent segment.
   * The number indicates the maximum traversal depth (1 = direct parent, 2 = grandparent, etc.)
   */
  parentDepthRequired: number;

  /**
   * Attribute fields that need to be loaded from attribute_entries.
   * Includes fields from the source, and from parent entries if applicable.
   * Key: "source" | "parent" | "parent2" etc.
   * Value: set of field names needed at that level.
   */
  requiredFields: Map<string, Set<string>>;

  /**
   * Whether the executor must load TIM time-label child entries.
   * True when any time() or timeUnder() expression appears anywhere in the widget.
   * This is distinct from needsTimPart — time-label loading is required for even
   * simple exact-match operations like sum(tims.time("t")).
   * When false the executor can skip the extra child-entry query entirely.
   */
  requiresTimeData: boolean;

  /**
   * Whether any path references .parent.code (the parent definition code).
   *
   * IMPORTANT: .parent.code is a PSEUDO-PROPERTY.  It is NOT stored as an
   * attribute_entry — it is the definitions.code column from the parent's
   * definition row.  The executor resolves it via entry.parent.definitionCode,
   * which is loaded through a separate definitions lookup in loadParentRecords().
   *
   * Because of this, 'code' is deliberately excluded from requiredFields["parent"].
   * requiredFields only lists real attribute fields (loaded from attribute_entries).
   */
  requiresParentCode: boolean;

  /**
   * Whether the executor should build the internal TIM_PART representation.
   * Only true for TIM sources where hierarchical time-label operations are needed.
   */
  needsTimPart: boolean;

  /**
   * Ordered measure evaluation sequence (dependency-resolved).
   * Measures earlier in this list do not reference measures later in the list.
   */
  measureOrder: string[];

  /** Non-fatal warnings */
  warnings: string[];
}

// ─────────────────────────────────────────────────────────────
// Analyzer
// ─────────────────────────────────────────────────────────────

export class WidgetAnalyzer {
  private errors: string[] = [];
  private warnings: string[] = [];

  analyze(widget: WidgetDef): AnalysisResult {
    this.errors = [];
    this.warnings = [];

    const { data, plot } = widget;
    const alias = data.source.alias;

    const measureNames = new Set(data.measures.map(m => m.name));
    const dimNames = new Set(data.group.map(d => d.name));

    // 1. Validate where clause
    if (data.where) {
      this.validateExpr(data.where, alias, measureNames, new Set());
    }

    // 2. Validate group dimensions
    for (const dim of data.group) {
      if (dim.kind === 'attribute') {
        this.validatePath(dim.path, alias);
      } else if (dim.kind === 'topk') {
        this.validatePath(dim.path, alias);
        // topk.by must be a measure_ref (a declared measure name).
        // Inline aggregation expressions (e.g. sum(tims.time("t"))) are not supported
        // in v1 — the executor ranks by a pre-computed measure column, not by re-evaluating
        // an arbitrary expression. Use a declared measure instead:
        //   measure productive = sum(tims.time("t"))
        //   project: topk(tims.parent.project, 5, by=productive)
        if (dim.by.kind !== 'measure_ref') {
          this.errors.push(
            `topk dimension '${dim.name}': 'by' must reference a declared measure name ` +
            `(e.g. by=productive), not an inline expression. ` +
            `Define the expression as a named measure first.`,
          );
        } else {
          this.validateExpr(dim.by, alias, measureNames, new Set());
        }
      }
      // period dims have no expression to validate
    }

    // 3. Validate measures (with cycle detection)
    const measureOrder = this.resolveMeasureOrder(data.measures, measureNames);
    for (const measure of data.measures) {
      this.validateExpr(measure.expr, alias, measureNames, new Set());
    }

    // 4. Validate plot roles
    this.validatePlotRoles(plot, measureNames, dimNames);

    if (this.errors.length > 0) {
      return { ok: false, errors: [...this.errors] };
    }

    // 5. Infer joins
    const parentDepthRequired = this.inferParentDepth(widget);

    // 6. Collect required fields per level
    const requiredFields = this.collectRequiredFields(widget, alias);

    // 7. Detect TIM_PART need
    const needsTimPart = this.detectTimPartNeed(widget);

    // 8. Detect time-label data and parent-code requirements
    const requiresTimeData = this.detectTimeDataNeed(widget);
    const requiresParentCode = this.detectParentCodeNeed(widget);

    return {
      ok: true,
      plan: {
        widget,
        sourceAlias: alias,
        sourceCode: data.source.definitionCode,
        parentDepthRequired,
        requiredFields,
        requiresTimeData,
        requiresParentCode,
        needsTimPart,
        measureOrder,
        warnings: [...this.warnings],
      },
    };
  }

  // ─── Expression validation ───────────────────────────────────

  private validateExpr(
    expr: Expr,
    sourceAlias: string,
    measureNames: Set<string>,
    seenMeasures: Set<string>,
  ): void {
    switch (expr.kind) {
      case 'literal':
        break;

      case 'path':
        this.validatePath(expr, sourceAlias);
        break;

      case 'time':
        this.validatePath(expr.path, sourceAlias);
        if (!expr.label) {
          this.errors.push('time() / timeUnder() expression requires a non-empty label string');
        }
        break;

      case 'array':
        for (const el of expr.elements) {
          this.validateExpr(el, sourceAlias, measureNames, seenMeasures);
        }
        break;

      case 'call': {
        const knownFns = new Set(['sum', 'avg', 'count', 'min', 'max', 'period', 'topk']);
        if (!knownFns.has(expr.fn)) {
          this.errors.push(`Unknown function '${expr.fn}'. Known functions: ${[...knownFns].join(', ')}`);
        }
        // time() / timeUnder() inside arithmetic within an aggregate causes
        // silent null-propagation: entries missing one label are dropped entirely
        // from the sum.  Require the split form instead.
        if (['sum', 'avg', 'min', 'max'].includes(expr.fn)) {
          for (const arg of expr.args) {
            if (this.hasTimeNodeInsideArithmetic(arg)) {
              this.errors.push(
                `time() / timeUnder() cannot appear inside arithmetic within ${expr.fn}(). ` +
                `Use ${expr.fn}(tims.time("a")) + ${expr.fn}(tims.time("b")) instead of ` +
                `${expr.fn}(tims.time("a") + tims.time("b")).`,
              );
            }
          }
        }
        for (const arg of expr.args) {
          this.validateExpr(arg, sourceAlias, measureNames, seenMeasures);
        }
        for (const arg of Object.values(expr.namedArgs)) {
          this.validateExpr(arg, sourceAlias, measureNames, seenMeasures);
        }
        break;
      }

      case 'binary':
        this.validateExpr(expr.left, sourceAlias, measureNames, seenMeasures);
        this.validateExpr(expr.right, sourceAlias, measureNames, seenMeasures);
        break;

      case 'unary':
        this.validateExpr(expr.arg, sourceAlias, measureNames, seenMeasures);
        break;

      case 'in':
        this.validateExpr(expr.expr, sourceAlias, measureNames, seenMeasures);
        for (const v of expr.values) {
          this.validateExpr(v, sourceAlias, measureNames, seenMeasures);
        }
        break;

      case 'under':
        this.validateExpr(expr.expr, sourceAlias, measureNames, seenMeasures);
        break;

      case 'measure_ref':
        if (!measureNames.has(expr.name)) {
          this.errors.push(
            `Undefined reference '${expr.name}'. ` +
            `If this is a measure, it must be defined with 'measure ${expr.name} = ...'`,
          );
        } else if (seenMeasures.has(expr.name)) {
          this.errors.push(`Circular measure reference involving '${expr.name}'`);
        }
        break;

      default: {
        const _exhaust: never = expr;
        void _exhaust;
      }
    }
  }

  /**
   * Returns true if `expr` contains a time() or timeUnder() node that is
   * nested inside arithmetic (binary/unary), i.e. not at the root.
   * Used to reject sum(time("a") + time("b")) in favour of sum(time("a")) + sum(time("b")).
   */
  private hasTimeNodeInsideArithmetic(expr: Expr): boolean {
    // time() at the root of an aggregate arg is fine
    if (expr.kind === 'time') return false;
    return this.exprContainsTime(expr);
  }

  private exprContainsTime(expr: Expr): boolean {
    switch (expr.kind) {
      case 'time':   return true;
      case 'binary': return this.exprContainsTime(expr.left) || this.exprContainsTime(expr.right);
      case 'unary':  return this.exprContainsTime(expr.arg);
      case 'call':   return expr.args.some(a => this.exprContainsTime(a));
      default:       return false;
    }
  }

  private validatePath(path: PathExpr, sourceAlias: string): void {
    if (path.segments.length === 0) {
      this.errors.push('Empty path expression');
      return;
    }
    const first = path.segments[0];
    if (first.kind !== 'field' || first.name !== sourceAlias) {
      this.errors.push(
        `Path '${pathToString(path)}' must start with the source alias '${sourceAlias}'`,
      );
    }
  }

  // ─── Measure dependency resolution ──────────────────────────

  /**
   * Topological sort of measures by dependency.
   * Returns measure names in evaluation order (dependencies first).
   * Detects and reports cycles.
   */
  private resolveMeasureOrder(measures: MeasureDef[], allMeasureNames: Set<string>): string[] {
    const nameToMeasure = new Map(measures.map(m => [m.name, m]));
    const visited = new Set<string>();
    const inStack = new Set<string>();
    const order: string[] = [];

    const visit = (name: string): void => {
      if (visited.has(name)) return;
      if (inStack.has(name)) {
        this.errors.push(`Circular measure dependency involving '${name}'`);
        return;
      }
      inStack.add(name);
      const measure = nameToMeasure.get(name);
      if (measure) {
        for (const ref of collectMeasureRefs(measure.expr)) {
          if (allMeasureNames.has(ref)) {
            visit(ref);
          }
        }
      }
      inStack.delete(name);
      visited.add(name);
      order.push(name);
    };

    for (const m of measures) {
      visit(m.name);
    }

    return order;
  }

  // ─── Join inference ──────────────────────────────────────────

  /**
   * Determine the maximum parent traversal depth needed.
   * 0 = no parent join, 1 = direct parent, 2 = grandparent, etc.
   */
  private inferParentDepth(widget: WidgetDef): number {
    let maxDepth = 0;

    const checkPath = (path: PathExpr): void => {
      let depth = 0;
      for (const seg of path.segments) {
        if (seg.kind === 'parent') depth++;
      }
      if (depth > maxDepth) maxDepth = depth;
      if (depth > 2) {
        this.warnings.push(
          `Path '${pathToString(path)}' traverses ${depth} parent levels. ` +
          `Only 1 level (direct parent) is supported in the v1 executor.`,
        );
      }
    };

    walkAllPaths(widget, checkPath);
    return maxDepth;
  }

  /**
   * Collect the set of attribute field names needed at each entry level.
   * Used by the executor to load only the fields it needs.
   */
  private collectRequiredFields(widget: WidgetDef, alias: string): Map<string, Set<string>> {
    const result = new Map<string, Set<string>>();

    const addField = (level: string, name: string): void => {
      // 'code' is a pseudo-property (definition code), NOT an attribute_entry field.
      // It is resolved by loadParentRecords() via a definitions lookup.
      // Exclude it here so requiredFields only lists real attribute fields.
      if (name === 'code') return;
      if (!result.has(level)) result.set(level, new Set());
      result.get(level)!.add(name);
    };

    const checkPath = (path: PathExpr): void => {
      let parentDepth = 0;
      let lastField: string | null = null;

      for (const seg of path.segments) {
        if (seg.kind === 'field' && seg.name !== alias) {
          lastField = seg.name;
        } else if (seg.kind === 'parent') {
          parentDepth++;
          lastField = null;
        }
      }

      if (lastField !== null) {
        const level = parentDepth === 0 ? 'source' : `parent${parentDepth > 1 ? parentDepth : ''}`;
        addField(level, lastField);
      }
    };

    walkAllPaths(widget, checkPath);
    return result;
  }

  // ─── Time data detection ─────────────────────────────────────

  /**
   * Returns true when any time() or timeUnder() expression appears in the widget.
   * Drives requiresTimeData in the plan so the executor knows to load time-label
   * child entries (the extra Supabase query in loadTimeLabels).
   */
  private detectTimeDataNeed(widget: WidgetDef): boolean {
    let found = false;
    const walk = (expr: Expr): void => {
      if (found) return;
      switch (expr.kind) {
        case 'time':   found = true; break;
        case 'binary': walk(expr.left); walk(expr.right); break;
        case 'unary':  walk(expr.arg); break;
        case 'call':   expr.args.forEach(walk); Object.values(expr.namedArgs).forEach(walk); break;
        case 'in':     walk(expr.expr); break;
        case 'under':  walk(expr.expr); break;
        default: break;
      }
    };
    if (widget.data.where) walk(widget.data.where);
    for (const m of widget.data.measures) walk(m.expr);
    return found;
  }

  /**
   * Returns true when any path references .parent.code.
   * Drives requiresParentCode in the plan to make the pseudo-property dependency explicit.
   */
  private detectParentCodeNeed(widget: WidgetDef): boolean {
    let found = false;
    const checkPath = (path: PathExpr): void => {
      if (found) return;
      let inParent = false;
      for (const seg of path.segments) {
        if (seg.kind === 'parent') { inParent = true; continue; }
        if (inParent && seg.kind === 'field' && seg.name === 'code') {
          found = true;
          return;
        }
        // Reset on any non-parent, non-code segment after .parent
        if (inParent && seg.kind !== 'index' && seg.kind !== 'slice') {
          inParent = false;
        }
      }
    };
    walkAllPaths(widget, checkPath);
    return found;
  }

  // ─── TIM_PART detection ──────────────────────────────────────

  /**
   * TIM_PART is the internal representation where a single TIM entry is
   * expanded into one row per time-label token (for hierarchical operations).
   *
   * It is needed when:
   *  - Source is TIM, AND
   *  - Any timeUnder() expression is used (hierarchical prefix sum), OR
   *  - Any group dimension groups by a time-label path (e.g. tims.label_type)
   */
  private detectTimPartNeed(widget: WidgetDef): boolean {
    if (widget.data.source.definitionCode !== 'TIM') return false;

    let needed = false;

    const walkExpr = (expr: Expr): void => {
      if (needed) return;
      switch (expr.kind) {
        case 'time':
          if (expr.hierarchical) needed = true;
          break;
        case 'binary':
          walkExpr(expr.left);
          walkExpr(expr.right);
          break;
        case 'unary':
          walkExpr(expr.arg);
          break;
        case 'call':
          expr.args.forEach(walkExpr);
          Object.values(expr.namedArgs).forEach(walkExpr);
          break;
        case 'in':
          walkExpr(expr.expr);
          break;
        case 'under':
          // UNDER on a time-label path implies hierarchical matching
          if (expr.expr.kind === 'path') {
            const segs = expr.expr.segments;
            const last = segs[segs.length - 1];
            // Heuristic: if the path ends in a field named "label" or "time_type"
            if (last?.kind === 'field' && (last.name === 'label' || last.name === 'time_type')) {
              needed = true;
            }
          }
          break;
        default:
          break;
      }
    };

    for (const m of widget.data.measures) walkExpr(m.expr);
    if (widget.data.where) walkExpr(widget.data.where);

    for (const dim of widget.data.group) {
      if (dim.kind === 'topk') walkExpr(dim.by);
    }

    return needed;
  }

  // ─── Plot role validation ────────────────────────────────────

  private validatePlotRoles(
    plot: PlotSpec,
    measureNames: Set<string>,
    dimNames: Set<string>,
  ): void {
    const allNames = new Set([...measureNames, ...dimNames]);

    // Required roles per type
    const required: Record<PlotType, string[]> = {
      kpi:         [],           // flexible: any role mapped to a measure
      bar:         ['x', 'y'],
      stacked_bar: ['x', 'series', 'y'],
      line:        ['x', 'y'],
      donut:       ['category', 'value'],
      hbar:        ['category', 'value'],
      ranked_list: ['label', 'primary'],  // secondary is optional
      table:       ['rows', 'value'],     // cols is optional
    };

    for (const role of required[plot.type] ?? []) {
      if (!(role in plot.roles)) {
        this.errors.push(`Plot type '${plot.type}' requires role '${role}'`);
      }
    }

    // Helper: flatten a role value (string or string[]) to an array
    const flatten = (v: string | string[]): string[] => Array.isArray(v) ? v : [v];

    for (const [role, target] of Object.entries(plot.roles)) {
      // Array-valued roles allowed on kpi (any role) and line (y role only)
      if (Array.isArray(target)) {
        const allowed =
          plot.type === 'kpi' ||
          (plot.type === 'line' && role === 'y') ||
          (plot.type === 'ranked_list' && role === 'secondary');
        if (!allowed) {
          this.errors.push(`Array role '${role}' is only supported for 'kpi', 'y' on 'line', or 'secondary' on 'ranked_list'`);
        }
        for (const t of target) {
          if (!allNames.has(t)) {
            this.errors.push(
              `Plot role '${role}' references '${t}' which is not a declared dimension or measure`,
            );
          }
        }
      } else {
        if (!allNames.has(target)) {
          this.errors.push(
            `Plot role '${role}' references '${target}' which is not a declared dimension or measure`,
          );
        }
      }
    }

    // Semantic role constraints (non-KPI roles are always single strings)
    const strRole = (name: string): string | undefined => {
      const v = plot.roles[name];
      return typeof v === 'string' ? v : undefined;
    };

    if (plot.type === 'bar') {
      const rx = strRole('x'), ry = strRole('y');
      if (rx && !dimNames.has(rx)) {
        this.errors.push(`Plot role 'x' for 'bar' must reference a group dimension, not a measure`);
      }
      if (ry && !measureNames.has(ry)) {
        this.errors.push(`Plot role 'y' for 'bar' must reference a measure`);
      }
    }

    if (plot.type === 'line') {
      const rx = strRole('x');
      if (rx && !dimNames.has(rx)) {
        this.errors.push(`Plot role 'x' for 'line' must reference a group dimension, not a measure`);
      }
      // y can be a single string or an array (multi-series)
      const yRaw = plot.roles['y'];
      const yNames = Array.isArray(yRaw) ? yRaw : (yRaw ? [yRaw] : []);
      for (const yn of yNames) {
        if (!measureNames.has(yn)) {
          this.errors.push(`Plot role 'y' for 'line' must reference a measure (got '${yn}')`);
        }
      }
    }

    if (plot.type === 'stacked_bar') {
      const rx = strRole('x'), rs = strRole('series'), ry = strRole('y');
      if (rx && !dimNames.has(rx)) {
        this.errors.push(`Plot role 'x' for 'stacked_bar' must reference a group dimension`);
      }
      if (rs && !dimNames.has(rs)) {
        this.errors.push(`Plot role 'series' for 'stacked_bar' must reference a group dimension`);
      }
      if (ry && !measureNames.has(ry)) {
        this.errors.push(`Plot role 'y' for 'stacked_bar' must reference a measure`);
      }
    }

    if (plot.type === 'donut' || plot.type === 'hbar') {
      const rc = strRole('category'), rv = strRole('value');
      if (rc && !dimNames.has(rc)) {
        this.errors.push(`Plot role 'category' for '${plot.type}' must reference a group dimension`);
      }
      if (rv && !measureNames.has(rv)) {
        this.errors.push(`Plot role 'value' for '${plot.type}' must reference a measure`);
      }
    }

    if (plot.type === 'ranked_list') {
      const rl = strRole('label'), rp = strRole('primary');
      if (rl && !dimNames.has(rl)) {
        this.errors.push(`Plot role 'label' for 'ranked_list' must reference a group dimension`);
      }
      if (rp && !measureNames.has(rp)) {
        this.errors.push(`Plot role 'primary' for 'ranked_list' must reference a measure`);
      }
      const secRaw = plot.roles['secondary'];
      const secNames = Array.isArray(secRaw) ? secRaw : (secRaw ? [secRaw] : []);
      for (const sn of secNames) {
        if (!measureNames.has(sn)) {
          this.errors.push(`Plot role 'secondary' for 'ranked_list' references '${sn}' which is not a measure`);
        }
      }
    }

    if (plot.type === 'table') {
      const rr = strRole('rows'), rc = strRole('cols'), rv = strRole('value');
      if (rr && !dimNames.has(rr)) {
        this.errors.push(`Plot role 'rows' for 'table' must reference a group dimension`);
      }
      if (rc && !dimNames.has(rc)) {
        this.errors.push(`Plot role 'cols' for 'table' must reference a group dimension`);
      }
      if (rv && !measureNames.has(rv)) {
        this.errors.push(`Plot role 'value' for 'table' must reference a measure`);
      }
    }

    if (plot.type === 'kpi') {
      // At least one role (including list members) should map to a measure
      const targets = Object.values(plot.roles).flatMap(flatten);
      const rolesTargetingMeasures = targets.filter(t => measureNames.has(t));
      if (rolesTargetingMeasures.length === 0) {
        this.warnings.push(`KPI plot has no roles targeting measures`);
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

/** Walk every PathExpr in the widget AST and call fn on each */
function walkAllPaths(widget: WidgetDef, fn: (path: PathExpr) => void): void {
  const walkExpr = (expr: Expr): void => {
    switch (expr.kind) {
      case 'path':   fn(expr); break;
      case 'time':   fn(expr.path); break;
      case 'binary': walkExpr(expr.left); walkExpr(expr.right); break;
      case 'unary':  walkExpr(expr.arg); break;
      case 'call':
        expr.args.forEach(walkExpr);
        Object.values(expr.namedArgs).forEach(walkExpr);
        break;
      case 'in':    walkExpr(expr.expr); expr.values.forEach(walkExpr); break;
      case 'under': walkExpr(expr.expr); break;
      case 'array': expr.elements.forEach(walkExpr); break;
      default: break;
    }
  };

  const { data } = widget;
  if (data.where) walkExpr(data.where);
  for (const m of data.measures) walkExpr(m.expr);
  for (const dim of data.group) {
    if (dim.kind === 'attribute') fn(dim.path);
    else if (dim.kind === 'topk') {
      fn(dim.path);
      walkExpr(dim.by);
    }
  }
}

/** Collect all MeasureRefExpr names within an expression tree */
function collectMeasureRefs(expr: Expr): string[] {
  const refs: string[] = [];
  const walk = (e: Expr): void => {
    switch (e.kind) {
      case 'measure_ref': refs.push(e.name); break;
      case 'binary':  walk(e.left); walk(e.right); break;
      case 'unary':   walk(e.arg); break;
      case 'call':    e.args.forEach(walk); Object.values(e.namedArgs).forEach(walk); break;
      case 'in':      walk(e.expr); e.values.forEach(walk); break;
      case 'under':   walk(e.expr); break;
      case 'array':   e.elements.forEach(walk); break;
      default: break;
    }
  };
  walk(expr);
  return refs;
}

/** Convert a PathExpr back to a readable string for error messages */
export function pathToString(path: PathExpr): string {
  return path.segments
    .map((seg, i) => {
      switch (seg.kind) {
        case 'field':  return i === 0 ? seg.name : `.${seg.name}`;
        case 'parent': return '.parent';
        case 'index':  return `[${seg.index}]`;
        case 'slice':  return `[${seg.start ?? ''}:${seg.end ?? ''}]`;
      }
    })
    .join('');
}

// ─────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────

export function analyzeWidget(widget: WidgetDef): AnalysisResult {
  return new WidgetAnalyzer().analyze(widget);
}
