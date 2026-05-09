/**
 * Widget System v2 — Combined Runner
 *
 * Convenience function that runs the full v2 pipeline:
 *   parse → analyze → execute → mapToChart
 *
 * This is the main entry point for API handlers.
 */

import { parseWidgetDef } from './parser';
import { analyzeWidget } from './analyzer';
import { executeWidget } from './executor';
import { mapToChart, ChartOutput, ChartPresentation } from './chartMapper';
import type { Expr, IntermediateTable, MeasureDef } from './ast';
import type { WidgetConfig } from './types';

/**
 * If a measure expression reduces to a single `time("X")` or `timeUnder("X")`
 * call (optionally wrapped in one aggregation function: sum/avg/min/max),
 * return the base letter X (or first segment of "X/sub"). Otherwise null.
 *
 * This is used to default-color chart series with the user's configured
 * time-tag color: a series whose value is "all the t time" should get the
 * user's chosen color for `t`. Combinations (t + m, ratios, etc.) get the
 * usual rotating palette.
 */
function extractTimeTagFromMeasure(expr: Expr): string | null {
  // Unwrap a single aggregation call if present.
  let node: Expr = expr;
  if (node.kind === 'call' && node.args.length === 1) {
    node = node.args[0];
  }
  if (node.kind !== 'time') return null;
  const label = node.label;
  if (!label) return null;
  // Hierarchical labels inherit the base letter's color ("m/thk" → "m").
  return label.split('/')[0];
}

function buildMeasureTimeTags(measures: MeasureDef[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of measures) {
    const tag = extractTimeTagFromMeasure(m.expr);
    if (tag) out[m.name] = tag;
  }
  return out;
}

export type { ChartOutput, ChartPresentation };

export interface RunWidgetV2Success {
  success: true;
  /** Widget name from DSL */
  name: string;
  /** Intermediate aggregated table (dims + measures) */
  table: IntermediateTable;
  /** Chart-ready output */
  chart: ChartOutput;
  /**
   * Presentation hints (format / color) extracted from the plot spec.
   * Passed to the renderer so formatting is driven by the DSL, not hardcoded.
   */
  presentation: ChartPresentation;
}

export interface RunWidgetV2Failure {
  success: false;
  error: string;
  /** Which pipeline stage failed */
  stage: 'parse' | 'analyze' | 'execute' | 'map';
  /** Detailed validation errors (analyzer stage only) */
  errors?: string[];
  /** Source location (parse errors only) */
  line?: number;
  col?: number;
}

export type RunWidgetV2Response = RunWidgetV2Success | RunWidgetV2Failure;

/**
 * Run a widget DSL source string end-to-end and return the chart-ready output
 * along with the intermediate table.
 *
 * @param source  - Widget DSL text
 * @param config  - Temporal context (userId, anchorDate, period, etc.)
 */
export async function runWidgetV2(
  source: string,
  config: WidgetConfig,
): Promise<RunWidgetV2Response> {
  // 1. Parse
  const parseResult = parseWidgetDef(source);
  if (!parseResult.ok) {
    return {
      success: false,
      stage: 'parse',
      error: parseResult.error,
      line: parseResult.line,
      col: parseResult.col,
    };
  }

  const { widget } = parseResult;

  // 2. Analyze
  const analysisResult = analyzeWidget(widget);
  if (!analysisResult.ok) {
    return {
      success: false,
      stage: 'analyze',
      error: `Validation errors: ${analysisResult.errors.join('; ')}`,
      errors: analysisResult.errors,
    };
  }

  const { plan } = analysisResult;

  // 3. Execute (DB access)
  let table: IntermediateTable;
  try {
    table = await executeWidget(plan, config);
  } catch (e) {
    return {
      success: false,
      stage: 'execute',
      error: e instanceof Error ? e.message : String(e),
    };
  }

  // 4. Map to chart output (pure transform, should not throw in practice)
  let chart: ChartOutput;
  try {
    chart = mapToChart(table, widget.plot);
  } catch (e) {
    return {
      success: false,
      stage: 'map',
      error: e instanceof Error ? e.message : String(e),
    };
  }

  const presentation: ChartPresentation = {
    format: widget.plot.format,
    color: widget.plot.color,
    measureTimeTags: buildMeasureTimeTags(widget.data.measures),
  };

  return {
    success: true,
    name: widget.name,
    table,
    chart,
    presentation,
  };
}
