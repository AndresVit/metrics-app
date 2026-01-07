import {
  Definition,
  MetricDefinition,
  AttributeDefinition,
  Field,
  Entry,
  MetricEntry,
  AttributeEntry,
} from '../domain';
import {
  MetricEntryInput,
  FieldInput,
  PipelineContext,
  PipelineState,
  PipelineResult,
  ResolvedEntry,
  ExistingEntriesResolver,
  createSuccess,
  createError,
  setAttributeValue,
} from './types';
import { populateFromSubdivision } from './populateFromSubdivision';
import { convertToInstances } from './convertToInstances';
import { applyFormulas } from './applyFormulas';
import { validateCardinalities } from './validateCardinalities';

/**
 * Normalizes a timestamp to start of day (00:00:00).
 * All entry timestamps should be at 00:00 to represent the day they belong to.
 */
function normalizeToStartOfDay(timestamp: Date): Date {
  const d = new Date(timestamp);
  d.setHours(0, 0, 0, 0);
  return d;
}

export interface PipelineConfig {
  definitions: Definition[];
  metricDefinitions: MetricDefinition[];
  attributeDefinitions: AttributeDefinition[];
  fields: Field[];
  existingEntries: ExistingEntriesResolver;
}

function buildContext(config: PipelineConfig): PipelineContext {
  const definitions = new Map<string, Definition>();
  const metricDefinitions = new Map<string, MetricDefinition>();
  const attributeDefinitions = new Map<string, AttributeDefinition>();
  const fields = new Map<string, Field>();
  const fieldsByMetric = new Map<string, Field[]>();

  for (const def of config.definitions) {
    definitions.set(def.id, def);
  }

  for (const metricDef of config.metricDefinitions) {
    metricDefinitions.set(metricDef.definitionId, metricDef);
  }

  for (const attrDef of config.attributeDefinitions) {
    attributeDefinitions.set(attrDef.definitionId, attrDef);
  }

  for (const field of config.fields) {
    fields.set(field.id, field);
    const existing = fieldsByMetric.get(field.metricDefinitionId) || [];
    existing.push(field);
    fieldsByMetric.set(field.metricDefinitionId, existing);
  }

  return {
    definitions,
    metricDefinitions,
    attributeDefinitions,
    fields,
    fieldsByMetric,
    existingEntries: config.existingEntries,
  };
}

function buildDivision(
  definitionId: string,
  definitions: Map<string, Definition>
): string[] {
  const result: string[] = [];
  let currentId: string | null = definitionId;

  while (currentId) {
    const def = definitions.get(currentId);
    if (!def) break;
    result.unshift(def.code);
    currentId = def.parentDefinitionId;
  }

  return result;
}

function buildResolvedEntry(
  input: MetricEntryInput,
  context: PipelineContext,
  userId: string,
  idCounter: { value: number },
  parentEntryId: number | null
): PipelineResult<ResolvedEntry> {
  const { definitions, fields, attributeDefinitions } = context;

  const definition = definitions.get(input.definitionId);
  if (!definition) {
    return createError({
      type: 'FORMULA_ERROR',
      message: `Definition not found: ${input.definitionId}`,
      fieldId: '',
      formula: '',
    });
  }

  const entryId = idCounter.value++;
  const now = new Date();

  const entry = new Entry(
    entryId,
    userId,
    input.definitionId,
    parentEntryId,
    normalizeToStartOfDay(input.timestamp),
    input.subdivision || null,
    input.comments || null,
    now,
    now
  );

  const metricEntry = definition.type === 'metric' ? new MetricEntry(entryId) : undefined;

  const children: ResolvedEntry[] = [];

  for (const fieldInput of input.fields) {
    const field = fields.get(fieldInput.fieldId);
    if (!field) {
      return createError({
        type: 'FORMULA_ERROR',
        message: `Field not found: ${fieldInput.fieldId}`,
        fieldId: fieldInput.fieldId,
        formula: '',
      });
    }

    const baseDef = definitions.get(field.baseDefinitionId);
    if (!baseDef) continue;

    const attrDef = attributeDefinitions.get(baseDef.id);
    const isMetricReference = baseDef.type === 'metric';

    for (const valueInput of fieldInput.values) {
      const childId = idCounter.value++;

      // Use value-level subdivision if provided, otherwise fall back to parent subdivision
      const childSubdivision = valueInput.subdivision ?? input.subdivision ?? null;

      const childEntry = new Entry(
        childId,
        userId,
        field.baseDefinitionId,
        entryId,
        normalizeToStartOfDay(input.timestamp),
        childSubdivision,
        null,
        now,
        now
      );

      if (attrDef) {
        // Field references an attribute - create AttributeEntry with typed value
        const attrEntry = new AttributeEntry(
          childId,
          field.id,
          null,
          null,
          null,
          null,
          null,
          null
        );

        if (valueInput.valueInt !== undefined) {
          setAttributeValue(attrEntry, 'int', valueInput.valueInt);
        } else if (valueInput.valueFloat !== undefined) {
          setAttributeValue(attrEntry, 'float', valueInput.valueFloat);
        } else if (valueInput.valueString !== undefined) {
          setAttributeValue(attrEntry, 'string', valueInput.valueString);
        } else if (valueInput.valueBool !== undefined) {
          setAttributeValue(attrEntry, 'bool', valueInput.valueBool);
        } else if (valueInput.valueTimestamp !== undefined) {
          setAttributeValue(attrEntry, 'timestamp', valueInput.valueTimestamp);
        } else if (valueInput.valueHierarchy !== undefined) {
          setAttributeValue(attrEntry, 'hierarchyString', valueInput.valueHierarchy);
        }

        children.push({
          entry: childEntry,
          attributeEntry: attrEntry,
          fieldId: field.id,
          children: [],
        });
      } else if (isMetricReference) {
        // Field references a metric
        if (valueInput.metricEntry) {
          // Inline metric entry - build it recursively with parent_entry_id = current entry
          const inlineResult = buildResolvedEntry(
            valueInput.metricEntry,
            context,
            userId,
            idCounter,
            entryId
          );
          if (!inlineResult.success) return inlineResult;

          // Add the inline metric entry as a child, tagged with this field
          inlineResult.value.fieldId = field.id;
          children.push(inlineResult.value);
        } else {
          // Identifier reference - will be resolved by convertToInstances
          const attrEntry = new AttributeEntry(
            childId,
            field.id,
            null,
            null,
            null,
            null,
            null,
            null
          );

          // Store the identifier value - typically a string or int
          if (valueInput.valueInt !== undefined) {
            attrEntry.valueInt = valueInput.valueInt;
          } else if (valueInput.valueString !== undefined) {
            attrEntry.valueString = valueInput.valueString;
          }

          children.push({
            entry: childEntry,
            attributeEntry: attrEntry,
            fieldId: field.id,
            children: [],
          });
        }
      }
    }
  }

  if (input.children) {
    for (const childInput of input.children) {
      const childResult = buildResolvedEntry(childInput, context, userId, idCounter, entryId);
      if (!childResult.success) return childResult;
      children.push(childResult.value);
    }
  }

  return createSuccess({
    entry,
    metricEntry,
    children,
  });
}

export function buildInitialState(
  input: MetricEntryInput,
  config: PipelineConfig,
  userId: string
): PipelineResult<PipelineState> {
  const context = buildContext(config);
  const idCounter = { value: 1 };

  const rootResult = buildResolvedEntry(input, context, userId, idCounter, null);
  if (!rootResult.success) return rootResult;

  const division = buildDivision(input.definitionId, context.definitions);
  const subdivision = input.subdivision ? input.subdivision.split('/') : [];
  const path = [...division, ...subdivision];

  return createSuccess({
    root: rootResult.value,
    context,
    division,
    subdivision,
    path,
  });
}

export type PipelineStep = (state: PipelineState) => PipelineResult<PipelineState>;

export function createPipeline(steps: PipelineStep[]): PipelineStep {
  return (initialState: PipelineState): PipelineResult<PipelineState> => {
    let state = initialState;

    for (const step of steps) {
      const result = step(state);
      if (!result.success) {
        return result;
      }
      state = result.value;
    }

    return createSuccess(state);
  };
}

export function runPipeline(
  input: MetricEntryInput,
  config: PipelineConfig,
  userId: string
): PipelineResult<ResolvedEntry> {
  const stateResult = buildInitialState(input, config, userId);
  if (!stateResult.success) return stateResult;

  const pipeline = createPipeline([
    populateFromSubdivision,
    convertToInstances,
    applyFormulas,
    validateCardinalities,
  ]);

  const result = pipeline(stateResult.value);
  if (!result.success) return result;

  return createSuccess(result.value.root);
}
