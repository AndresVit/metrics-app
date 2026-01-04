import {
  Definition,
  MetricDefinition,
  AttributeDefinition,
  Field,
  Entry,
  MetricEntry,
  AttributeEntry,
  AttributeDatatype,
} from '../domain';

export interface FieldInput {
  fieldId: string;
  values: AttributeValueInput[];
}

export interface AttributeValueInput {
  valueInt?: number;
  valueFloat?: number;
  valueString?: string;
  valueBool?: boolean;
  valueTimestamp?: Date;
  valueHierarchy?: string;
  subdivision?: string; // Per-value subdivision (e.g., for timing tokens: t, m, n)
  metricEntry?: MetricEntryInput; // Inline metric entry for metric reference fields
}

export interface MetricEntryInput {
  definitionId: string;
  timestamp: Date;
  subdivision?: string;
  comments?: string;
  fields: FieldInput[];
  children?: MetricEntryInput[];
}

export interface ResolvedEntry {
  entry: Entry;
  metricEntry?: MetricEntry;
  attributeEntry?: AttributeEntry;
  fieldId?: string;
  children: ResolvedEntry[];
}

export interface PipelineContext {
  definitions: Map<string, Definition>;
  metricDefinitions: Map<string, MetricDefinition>;
  attributeDefinitions: Map<string, AttributeDefinition>;
  fields: Map<string, Field>;
  fieldsByMetric: Map<string, Field[]>;
  existingEntries: ExistingEntriesResolver;
}

export interface ExistingEntriesResolver {
  findByPrimaryIdentifier(
    metricDefinitionId: string,
    identifierValue: string | number
  ): ResolvedEntry[];
}

export interface PipelineState {
  root: ResolvedEntry;
  context: PipelineContext;
  division: string[];
  subdivision: string[];
  path: string[];
}

export type PipelineResult<T> =
  | { success: true; value: T }
  | { success: false; error: PipelineError };

export type PipelineError =
  | SubdivisionError
  | InstanceResolutionError
  | FormulaError
  | CardinalityError;

export interface SubdivisionError {
  type: 'SUBDIVISION_ERROR';
  message: string;
  fieldId: string;
  formula: string;
}

export interface InstanceResolutionError {
  type: 'INSTANCE_RESOLUTION_ERROR';
  message: string;
  fieldId: string;
  metricDefinitionId: string;
  identifierValue: string | number;
  matchCount: number;
}

export interface FormulaError {
  type: 'FORMULA_ERROR';
  message: string;
  fieldId: string;
  formula: string;
  details?: string;
}

export interface CardinalityError {
  type: 'CARDINALITY_ERROR';
  message: string;
  fieldId: string;
  fieldName: string;
  expected: { min: number; max: number | null };
  actual: number;
}

export function createError<T extends PipelineError>(error: T): PipelineResult<never> {
  return { success: false, error };
}

export function createSuccess<T>(value: T): PipelineResult<T> {
  return { success: true, value };
}

export function isSuccess<T>(result: PipelineResult<T>): result is { success: true; value: T } {
  return result.success;
}

export function isError<T>(result: PipelineResult<T>): result is { success: false; error: PipelineError } {
  return !result.success;
}

export function getAttributeValue(entry: AttributeEntry): string | number | boolean | Date | null {
  if (entry.valueInt !== null) return entry.valueInt;
  if (entry.valueFloat !== null) return entry.valueFloat;
  if (entry.valueString !== null) return entry.valueString;
  if (entry.valueBool !== null) return entry.valueBool;
  if (entry.valueTimestamp !== null) return entry.valueTimestamp;
  if (entry.valueHierarchy !== null) return entry.valueHierarchy;
  return null;
}

export function setAttributeValue(
  entry: AttributeEntry,
  datatype: AttributeDatatype,
  value: string | number | boolean | Date
): void {
  entry.valueInt = null;
  entry.valueFloat = null;
  entry.valueString = null;
  entry.valueBool = null;
  entry.valueTimestamp = null;
  entry.valueHierarchy = null;

  switch (datatype) {
    case 'int':
      entry.valueInt = value as number;
      break;
    case 'float':
      entry.valueFloat = value as number;
      break;
    case 'string':
      entry.valueString = value as string;
      break;
    case 'bool':
      entry.valueBool = value as boolean;
      break;
    case 'timestamp':
      entry.valueTimestamp = value as Date;
      break;
    case 'hierarchyString':
      entry.valueHierarchy = value as string;
      break;
  }
}
