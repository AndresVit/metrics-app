/**
 * Widget Module
 *
 * Provides read-only aggregation views over persisted entries.
 * Widgets can be persisted to the database and loaded for execution.
 */

// Main entry point
export { runWidget, runWidgetWithData } from './runWidget';
export type { RunWidgetResult } from './runWidget';

// Types
export type {
  ParsedWidget,
  DatasetDeclaration,
  ComputedField,
  Period,
  WidgetParseResult,
  WidgetParseError,
  WidgetResult,
  WidgetEvaluationContext,
  LoadedEntry,
  WidgetConfig,
} from './types';

// Parser (for advanced use)
export { parseWidget, parseWidgetFromString } from './parseWidget';

// Loader (for advanced use)
export { loadEntriesForWidget } from './loadEntries';

// Evaluator (for advanced use)
export { evaluateWidgetExpression } from './evaluateExpression';

// Repository (for persistence)
export { loadWidgets, loadWidgetById, loadWidgetByName } from './WidgetRepository';
export type { StoredWidget } from './WidgetRepository';
