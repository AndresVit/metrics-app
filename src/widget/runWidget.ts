/**
 * Widget Runner
 *
 * Main entry point for widget evaluation.
 * Parses widget DSL, loads data, and evaluates expressions.
 */

import { parseWidget } from './parseWidget';
import { loadEntriesForWidget } from './loadEntries';
import { evaluateWidgetExpression } from './evaluateExpression';
import {
  WidgetResult,
  WidgetConfig,
  WidgetEvaluationContext,
  LoadedEntry,
} from './types';

/**
 * Result type for runWidget
 */
export type RunWidgetResult =
  | { success: true; name: string; result: WidgetResult }
  | { success: false; error: string };

/**
 * Run a widget from source DSL
 *
 * @param widgetSource - The widget DSL source string
 * @param config - Widget configuration (userId)
 * @returns Widget result or error
 *
 * @example
 * const result = await runWidget(`
 *   WIDGET "Daily Productivity"
 *
 *   tims = TIM FROM TODAY
 *
 *   "good": int = sum(tims.time("t"))
 *   "total": int = sum(tims.duration)
 *   END
 * `, { userId: 'user-123' });
 */
export async function runWidget(
  widgetSource: string,
  config: WidgetConfig
): Promise<RunWidgetResult> {
  // 1. Parse the widget DSL
  const parseResult = parseWidget(widgetSource);
  if (!parseResult.success) {
    return {
      success: false,
      error: `Parse error: ${parseResult.error.message}${
        parseResult.error.lineNumber ? ` (line ${parseResult.error.lineNumber})` : ''
      }${parseResult.error.details ? ` - ${parseResult.error.details}` : ''}`,
    };
  }

  const widget = parseResult.widget;

  // 2. Load data for the dataset
  let entries: LoadedEntry[];
  try {
    entries = await loadEntriesForWidget(
      widget.dataset.definitionCode,
      widget.dataset.period,
      config
    );
  } catch (err) {
    return {
      success: false,
      error: `Data load error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // 3. Build evaluation context
  const datasets = new Map<string, LoadedEntry[]>();
  datasets.set(widget.dataset.alias, entries);

  const evalCtx: WidgetEvaluationContext = {
    datasets,
    definitionCode: widget.dataset.definitionCode,
  };

  // 4. Evaluate each computed field
  const result: WidgetResult = {};

  for (const field of widget.computedFields) {
    const evalResult = evaluateWidgetExpression(field.expression, evalCtx);

    if (!evalResult.success) {
      return {
        success: false,
        error: `Evaluation error in field "${field.label}": ${evalResult.error}`,
      };
    }

    // Apply type coercion based on declared type
    let value = evalResult.value;
    if (field.datatype === 'int') {
      value = Math.floor(value);
    }

    result[field.label] = value;
  }

  return {
    success: true,
    name: widget.name,
    result,
  };
}

/**
 * Run a widget with in-memory data (for testing without database)
 *
 * @param widgetSource - The widget DSL source string
 * @param entries - Pre-loaded entries
 * @returns Widget result or error
 */
export function runWidgetWithData(
  widgetSource: string,
  entries: LoadedEntry[]
): { success: true; name: string; result: WidgetResult } | { success: false; error: string } {
  // 1. Parse the widget DSL
  const parseResult = parseWidget(widgetSource);
  if (!parseResult.success) {
    return {
      success: false,
      error: `Parse error: ${parseResult.error.message}${
        parseResult.error.lineNumber ? ` (line ${parseResult.error.lineNumber})` : ''
      }${parseResult.error.details ? ` - ${parseResult.error.details}` : ''}`,
    };
  }

  const widget = parseResult.widget;

  // 2. Build evaluation context with provided data
  const datasets = new Map<string, LoadedEntry[]>();
  datasets.set(widget.dataset.alias, entries);

  const evalCtx: WidgetEvaluationContext = {
    datasets,
    definitionCode: widget.dataset.definitionCode,
  };

  // 3. Evaluate each computed field
  const result: WidgetResult = {};

  for (const field of widget.computedFields) {
    const evalResult = evaluateWidgetExpression(field.expression, evalCtx);

    if (!evalResult.success) {
      return {
        success: false,
        error: `Evaluation error in field "${field.label}": ${evalResult.error}`,
      };
    }

    // Apply type coercion based on declared type
    let value = evalResult.value;
    if (field.datatype === 'int') {
      value = Math.floor(value);
    }

    result[field.label] = value;
  }

  return {
    success: true,
    name: widget.name,
    result,
  };
}
