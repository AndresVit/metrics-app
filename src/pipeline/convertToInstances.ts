// Resolves metric references by looking up existing entries via primary identifier.
import {
  PipelineState,
  PipelineResult,
  ResolvedEntry,
  createSuccess,
  createError,
  getAttributeValue,
} from './types';

function processEntry(
  entry: ResolvedEntry,
  state: PipelineState
): PipelineResult<void> {
  const { context } = state;
  const { definitions, metricDefinitions, fields } = context;

  const definition = definitions.get(entry.entry.definitionId);
  if (!definition || definition.type !== 'metric') {
    for (const child of entry.children) {
      const result = processEntry(child, state);
      if (!result.success) return result;
    }
    return createSuccess(undefined);
  }

  for (let i = 0; i < entry.children.length; i++) {
    const child = entry.children[i];
    if (!child.fieldId) continue;

    const field = fields.get(child.fieldId);
    if (!field) continue;

    const baseDefinition = definitions.get(field.baseDefinitionId);
    if (!baseDefinition || baseDefinition.type !== 'metric') continue;

    const metricDef = metricDefinitions.get(baseDefinition.id);
    if (!metricDef || !metricDef.primaryIdentifierFieldId) continue;

    if (child.metricEntry && !child.attributeEntry) {
      continue;
    }

    if (child.attributeEntry) {
      const identifierValue = getAttributeValue(child.attributeEntry);
      if (identifierValue === null) continue;

      const matches = context.existingEntries.findByPrimaryIdentifier(
        baseDefinition.id,
        identifierValue as string | number
      );

      if (matches.length === 0) {
        return createError({
          type: 'INSTANCE_RESOLUTION_ERROR',
          message: `No matching instance found for metric "${baseDefinition.code}" with identifier "${identifierValue}"`,
          fieldId: field.id,
          metricDefinitionId: baseDefinition.id,
          identifierValue: identifierValue as string | number,
          matchCount: 0,
        });
      }

      if (matches.length > 1) {
        return createError({
          type: 'INSTANCE_RESOLUTION_ERROR',
          message: `Ambiguous reference: ${matches.length} instances found for metric "${baseDefinition.code}" with identifier "${identifierValue}"`,
          fieldId: field.id,
          metricDefinitionId: baseDefinition.id,
          identifierValue: identifierValue as string | number,
          matchCount: matches.length,
        });
      }

      const resolvedInstance = matches[0];
      entry.children[i] = {
        entry: resolvedInstance.entry,
        metricEntry: resolvedInstance.metricEntry,
        fieldId: child.fieldId,
        children: resolvedInstance.children,
      };
    }
  }

  for (const child of entry.children) {
    const result = processEntry(child, state);
    if (!result.success) return result;
  }

  return createSuccess(undefined);
}

export function convertToInstances(state: PipelineState): PipelineResult<PipelineState> {
  const result = processEntry(state.root, state);
  if (!result.success) {
    return result as PipelineResult<PipelineState>;
  }

  return createSuccess(state);
}
