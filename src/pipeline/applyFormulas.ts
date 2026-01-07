// Evaluates non-hierarchy formula fields and creates/updates AttributeEntries.
// Formula fields always produce exactly ONE scalar value.
import { AttributeEntry, Entry } from '../domain';
import {
  PipelineState,
  PipelineResult,
  ResolvedEntry,
  createSuccess,
  createError,
  setAttributeValue,
} from './types';
import { evaluateFormula } from './formulaEngine';


type FormulaValue = number | number[] | string | string[] | boolean | boolean[] | null;

/**
 * Checks if a formula is a hierarchy-only formula (subdivision[n], division[n], path[n]).
 * These are handled by populateFromSubdivision and should be skipped in applyFormulas.
 */
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
  parent: ResolvedEntry | null,
  root: ResolvedEntry,
  state: PipelineState,
  idCounter: { value: number }
): PipelineResult<void> {
  const { context } = state;
  const { definitions, fieldsByMetric, attributeDefinitions } = context;

  const definition = definitions.get(entry.entry.definitionId);
  if (!definition || definition.type !== 'metric') {
    for (const child of entry.children) {
      const result = processEntry(child, entry, root, state, idCounter);
      if (!result.success) return result;
    }
    return createSuccess(undefined);
  }

  const metricFields = fieldsByMetric.get(definition.id) || [];

  // fieldValues: Accumulates computed formula values during iteration over fields.
  // Purpose: Enables later formulas to reference values computed by earlier formulas
  // within the same metric entry. Fields are processed in order (input fields first,
  // then formula fields), so a formula can depend on previously computed formula values.
  // Scope: Local to this entry - not shared across entries or recursive calls.
  // The formula engine receives this map and can access values by field name.
  const fieldValues = new Map<string, FormulaValue>();

  const sortedFields = [...metricFields].sort((a, b) => {
    if (a.inputMode === 'input' && b.inputMode === 'formula') return -1;
    if (a.inputMode === 'formula' && b.inputMode === 'input') return 1;
    return 0;
  });

  for (const field of sortedFields) {
    // Skip non-formula fields. This is intentional: input fields have their values
    // provided directly and do not require formula evaluation.
    if (field.inputMode !== 'formula' || !field.formula) continue;

    // Skip hierarchy-only formulas - they are handled by populateFromSubdivision
    // These formulas (subdivision[n], division[n], path[n]) are evaluated early
    // because they may be needed for instance resolution in convertToInstances
    if (isHierarchyOnlyFormula(field.formula)) continue;

    // Schema validation: non-hierarchy formula fields MUST have an AttributeDefinition as their base.
    // Note: Hierarchy formulas CAN reference metrics (for instance resolution), but those
    // are handled by populateFromSubdivision and skipped above.
    const baseDefinition = definitions.get(field.baseDefinitionId);
    if (!baseDefinition || baseDefinition.type !== 'attribute') {
      return createError({
        type: 'FORMULA_ERROR',
        message: `Formula field "${field.name}" has invalid baseDefinitionId: expected AttributeDefinition, got ${baseDefinition?.type ?? 'undefined'}`,
        fieldId: field.id,
        formula: field.formula,
      });
    }

    const attrDef = attributeDefinitions.get(baseDefinition.id);
    if (!attrDef) {
      return createError({
        type: 'FORMULA_ERROR',
        message: `Formula field "${field.name}" references AttributeDefinition that is not in attributeDefinitions map`,
        fieldId: field.id,
        formula: field.formula,
      });
    }

    const result = evaluateFormula(
      field.formula,
      entry,
      parent,
      root,
      state,
      fieldValues
    );

    if (!result.success) {
      const error = result.error;
      if (error.type === 'FORMULA_ERROR') {
        return createError({
          type: 'FORMULA_ERROR',
          message: error.message,
          fieldId: field.id,
          formula: field.formula,
          details: error.details,
        });
      }
      return result as PipelineResult<void>;
    }

    const value = result.value;
    if (value === null) {
      return createError({
        type: 'FORMULA_ERROR',
        message: `Formula evaluated to null`,
        fieldId: field.id,
        formula: field.formula,
      });
    }

    if (Array.isArray(value)) {
      return createError({
        type: 'FORMULA_ERROR',
        message: `Formula must produce a single value, got array of ${value.length} elements`,
        fieldId: field.id,
        formula: field.formula,
      });
    }

    fieldValues.set(field.name, value);

    // baseDefinition and attrDef already validated above - safe to use directly

    const existingEntry = entry.children.find(
      (c) => c.fieldId === field.id && c.attributeEntry
    );

    if (existingEntry && existingEntry.attributeEntry) {
      setAttributeValue(
        existingEntry.attributeEntry,
        attrDef.datatype,
        value as string | number | boolean | Date
      );
    } else {
      const newId = idCounter.value++;
      const now = new Date();

      // MVP Decision: Formula-generated AttributeEntries inherit the parent entry's subdivision.
      // This ensures computed attributes share the same organizational context as their
      // parent metric entry. If formulas need to produce values in a different subdivision,
      // that would require a new field configuration or formula syntax - not currently supported.
      // TODO: Consider whether formulas should be able to specify/override subdivision in future.
      const newEntry = new Entry(
        newId,
        entry.entry.userId,
        field.baseDefinitionId,
        entry.entry.id,
        entry.entry.timestamp, // Already normalized to 00:00
        entry.entry.subdivision, // Inherited from parent - see comment above
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
      setAttributeValue(
        newAttrEntry,
        attrDef.datatype,
        value as string | number | boolean | Date
      );

      entry.children.push({
        entry: newEntry,
        attributeEntry: newAttrEntry,
        fieldId: field.id,
        children: [],
      });
    }
  }

  for (const child of entry.children) {
    const result = processEntry(child, entry, root, state, idCounter);
    if (!result.success) return result;
  }

  return createSuccess(undefined);
}

export function applyFormulas(state: PipelineState): PipelineResult<PipelineState> {
  const idCounter = { value: -2000 };

  const result = processEntry(state.root, null, state.root, state, idCounter);
  if (!result.success) {
    return result as PipelineResult<PipelineState>;
  }

  return createSuccess(state);
}
