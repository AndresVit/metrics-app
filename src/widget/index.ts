/**
 * Widget Module
 *
 * Provides read-only aggregation views over persisted entries.
 * Widgets can be persisted to the database and loaded for execution.
 *
 * Pipeline:
 *   parseWidgetDef(source) → ParseResult
 *   analyzeWidget(def)     → AnalysisResult (ExecutionPlan)
 *   executeWidget(plan, config) → IntermediateTable
 *   mapToChart(table, plot)     → ChartOutput
 *
 * Or combined:
 *   runWidgetV2(source, config) → ChartOutput
 */

// ── AST types ─────────────────────────────────────────────────
export type {
  WidgetDef, DataSpec, PlotSpec, PlotType,
  SourceDecl, GroupDimension, PeriodDimension, AttributeDimension, TopkDimension,
  MeasureDef, PeriodType,
  Expr, LiteralExpr, PathExpr, TimeExpr, ArrayExpr, CallExpr,
  BinaryExpr, BinaryOp, UnaryExpr, InExpr, UnderExpr, MeasureRefExpr,
  PathSegment, FieldSegment, ParentSegment, IndexSegment, SliceSegment,
  IntermediateTable, IntermediateRow,
  ParseResult, ParseSuccess, ParseFailure,
} from './ast';

// ── Parser ────────────────────────────────────────────────────
export { parseWidgetDef } from './parser';

// ── Analyzer ──────────────────────────────────────────────────
export { analyzeWidget } from './analyzer';
export type { AnalysisResult, AnalysisSuccess, AnalysisFailure, ExecutionPlan } from './analyzer';

// ── Executor ──────────────────────────────────────────────────
export { executeWidget } from './executor';
export type { EntryRecord, ParentRecord } from './executor';

// ── Chart mapper ──────────────────────────────────────────────
export { mapToChart } from './chartMapper';
export type {
  ChartOutput, KpiOutput, BarOutput, StackedBarOutput,
  LineOutput, DonutOutput, TableOutput,
  KpiValue, BarSeries, TableOutputRow,
} from './chartMapper';

// ── Combined runner ───────────────────────────────────────────
export { runWidgetV2 } from './runWidgetV2';

// ── Shared widget config types ────────────────────────────────
export type { WidgetConfig, LoadedEntry, SmallPeriod } from './types';

// ── Repository ────────────────────────────────────────────────
export {
  loadWidgets,
  loadWidgetById,
  loadWidgetByName,
  loadWidgetsByDashboard,
  createWidget,
  updateWidget,
  deleteWidget,
  reorderWidget,
} from './WidgetRepository';
export type {
  StoredWidget,
  CreateWidgetInput,
  UpdateWidgetInput,
} from './WidgetRepository';
