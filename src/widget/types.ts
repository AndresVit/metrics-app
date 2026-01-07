/**
 * Widget Types
 *
 * Types for the Widget DSL and evaluation pipeline.
 * Widgets are READ-ONLY aggregation views over persisted entries.
 */

/**
 * Parsed widget structure from DSL
 */
export interface ParsedWidget {
  name: string;
  dataset: DatasetDeclaration;
  computedFields: ComputedField[];
}

/**
 * Dataset declaration: alias = DEF FROM PERIOD
 */
export interface DatasetDeclaration {
  alias: string;
  definitionCode: string;
  period: Period;
}

/**
 * Period for filtering entries
 * MVP: TODAY only
 */
export type Period = 'TODAY';

/**
 * Computed field declaration: "label": type = expression
 */
export interface ComputedField {
  label: string;
  datatype: 'int' | 'float';
  expression: string;
}

/**
 * Result type for widget parsing
 */
export type WidgetParseResult =
  | { success: true; widget: ParsedWidget }
  | { success: false; error: WidgetParseError };

/**
 * Parse error details
 */
export interface WidgetParseError {
  message: string;
  lineNumber?: number;
  details?: string;
}

/**
 * Widget evaluation result
 */
export type WidgetResult = Record<string, number>;

/**
 * Evaluation context for widget expressions
 */
export interface WidgetEvaluationContext {
  /**
   * The dataset entries loaded from the database
   * Key: alias, Value: array of loaded entries
   */
  datasets: Map<string, LoadedEntry[]>;

  /**
   * Definition code for the dataset (for time() method support)
   */
  definitionCode: string;
}

/**
 * Loaded entry from database with all attribute values
 * Flattened structure for widget evaluation
 */
export interface LoadedEntry {
  id: number;
  definitionCode: string;
  timestamp: Date;
  subdivision: string | null;

  /**
   * Attribute values keyed by field name
   */
  attributes: Map<string, number | string | boolean | null>;

  /**
   * For TIM entries: time_type values grouped by base category
   * Key: base category (t, m, p, n or t/sub, m/sub, etc.)
   * Value: sum of values for that category
   */
  timeValues?: Map<string, number>;
}

/**
 * Configuration for widget evaluation
 */
export interface WidgetConfig {
  userId: string;
}
