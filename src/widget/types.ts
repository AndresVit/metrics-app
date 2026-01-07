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
 * Dataset declaration: alias = DEF
 *
 * Period comes from the temporal context, not from the DSL.
 */
export interface DatasetDeclaration {
  alias: string;
  definitionCode: string;
}

/**
 * Period for filtering entries
 * Specifies the time range for widget queries
 */
export type Period = 'TODAY' | 'DAY' | 'WEEK' | 'MONTH' | 'YEAR';

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
 * Values can be null (e.g., division by zero returns null instead of error)
 */
export type WidgetResult = Record<string, number | null>;

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
  /**
   * Anchor date for time-based filtering.
   * Used to compute the date range based on the period.
   * If not provided, defaults to current date.
   */
  anchorDate?: Date;
  /**
   * Period from the temporal context (bigPeriod).
   * Determines the date range: DAY, WEEK, MONTH, or YEAR.
   * If not provided, defaults to 'DAY'.
   */
  period?: Period;
}
