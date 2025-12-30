import { AttributeEntry, Entry } from '../domain';
import {
  PipelineState,
  PipelineResult,
  ResolvedEntry,
  createSuccess,
  createError,
  setAttributeValue,
} from './types';

const SUBDIVISION_PATTERN = /subdivision\[(\d+)\]/;
const DIVISION_PATTERN = /division\[(\d+)\]/;
const PATH_PATTERN = /path\[(\d+)\]/;

function extractHierarchyValue(
  formula: string,
  subdivision: string[],
  division: string[],
  path: string[]
): PipelineResult<string> {
  let subdivisionMatch = SUBDIVISION_PATTERN.exec(formula);
  if (subdivisionMatch) {
    const index = parseInt(subdivisionMatch[1], 10);
    if (index < 0 || index >= subdivision.length) {
      return createError({
        type: 'SUBDIVISION_ERROR',
        message: `Invalid subdivision index ${index}. Subdivision has ${subdivision.length} elements: [${subdivision.join(', ')}]`,
        fieldId: '',
        formula,
      });
    }
    return createSuccess(subdivision[index]);
  }

  let divisionMatch = DIVISION_PATTERN.exec(formula);
  if (divisionMatch) {
    const index = parseInt(divisionMatch[1], 10);
    if (index < 0 || index >= division.length) {
      return createError({
        type: 'SUBDIVISION_ERROR',
        message: `Invalid division index ${index}. Division has ${division.length} elements: [${division.join(', ')}]`,
        fieldId: '',
        formula,
      });
    }
    return createSuccess(division[index]);
  }

  let pathMatch = PATH_PATTERN.exec(formula);
  if (pathMatch) {
    const index = parseInt(pathMatch[1], 10);
    if (index < 0 || index >= path.length) {
      return createError({
        type: 'SUBDIVISION_ERROR',
        message: `Invalid path index ${index}. Path has ${path.length} elements: [${path.join(', ')}]`,
        fieldId: '',
        formula,
      });
    }
    return createSuccess(path[index]);
  }

  return createSuccess('');
}

function isHierarchyOnlyFormula(formula: string): boolean {
  const trimmed = formula.trim();
  return (
    /^subdivision\[\d+\]$/.test(trimmed) ||
    /^division\[\d+\]$/.test(trimmed) ||
    /^path\[\d+\]$/.test(trimmed)
  );
}

function processEntry(
  entry: ResolvedEntry,
  state: PipelineState,
  idCounter: { value: number }
): PipelineResult<void> {
  const { context, subdivision, division, path } = state;
  const { definitions, fieldsByMetric, attributeDefinitions } = context;

  const definition = definitions.get(entry.entry.definitionId);
  if (!definition || definition.type !== 'metric') {
    for (const child of entry.children) {
      const result = processEntry(child, state, idCounter);
      if (!result.success) return result;
    }
    return createSuccess(undefined);
  }

  const metricFields = fieldsByMetric.get(definition.id) || [];

  for (const field of metricFields) {
    if (field.inputMode !== 'formula' || !field.formula) continue;
    if (!isHierarchyOnlyFormula(field.formula)) continue;

    const valueResult = extractHierarchyValue(field.formula, subdivision, division, path);
    if (!valueResult.success) {
      return createError({
        ...valueResult.error,
        fieldId: field.id,
      });
    }

    const baseDefinition = definitions.get(field.baseDefinitionId);
    if (!baseDefinition) continue;

    const isAttributeField = baseDefinition.type === 'attribute';
    const isMetricReference = baseDefinition.type === 'metric';

    if (!isAttributeField && !isMetricReference) continue;

    const existingEntry = entry.children.find(
      (c) => c.fieldId === field.id && c.attributeEntry
    );

    if (existingEntry && existingEntry.attributeEntry) {
      // Overwrite existing value
      if (isAttributeField) {
        const attrDef = attributeDefinitions.get(baseDefinition.id);
        if (attrDef) {
          setAttributeValue(existingEntry.attributeEntry, attrDef.datatype, valueResult.value);
        }
      } else {
        // Metric reference - store as string for later resolution by convertToInstances
        existingEntry.attributeEntry.valueString = valueResult.value;
      }
    } else {
      // Create new entry
      const newId = idCounter.value++;
      const now = new Date();

      const newEntry = new Entry(
        newId,
        entry.entry.userId,
        field.baseDefinitionId,
        entry.entry.id,
        entry.entry.timestamp,
        entry.entry.subdivision,
        null,
        now,
        now
      );

      const newAttrEntry = new AttributeEntry(
        newId,
        field.id,
        null,
        null,
        null,
        null,
        null,
        null
      );

      if (isAttributeField) {
        const attrDef = attributeDefinitions.get(baseDefinition.id);
        if (attrDef) {
          setAttributeValue(newAttrEntry, attrDef.datatype, valueResult.value);
        }
      } else {
        // Metric reference - store as string for later resolution by convertToInstances
        newAttrEntry.valueString = valueResult.value;
      }

      entry.children.push({
        entry: newEntry,
        attributeEntry: newAttrEntry,
        fieldId: field.id,
        children: [],
      });
    }
  }

  for (const child of entry.children) {
    const result = processEntry(child, state, idCounter);
    if (!result.success) return result;
  }

  return createSuccess(undefined);
}

export function populateFromSubdivision(state: PipelineState): PipelineResult<PipelineState> {
  const idCounter = { value: -1000 };

  const result = processEntry(state.root, state, idCounter);
  if (!result.success) {
    return result as PipelineResult<PipelineState>;
  }

  return createSuccess(state);
}
