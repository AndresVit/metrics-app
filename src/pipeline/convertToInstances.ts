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

      // Use search key lookup if the target metric has a search key and the resolver supports it
      let matches: ResolvedEntry[];
      const hasSearchKey = metricDef.searchKeyType !== null;
      if (hasSearchKey && context.existingEntries.findBySearchKey) {
        matches = context.existingEntries.findBySearchKey(
          baseDefinition.id,
          String(identifierValue)
        );
      } else {
        matches = context.existingEntries.findByPrimaryIdentifier(
          baseDefinition.id,
          identifierValue as string | number
        );
      }

      const keyLabel = hasSearchKey
        ? `search key "${identifierValue}"`
        : `identifier "${identifierValue}"`;

      if (matches.length === 0) {
        return createError({
          type: 'INSTANCE_RESOLUTION_ERROR',
          message: `No matching instance found for metric "${baseDefinition.code}" where ${keyLabel}`,
          fieldId: field.id,
          metricDefinitionId: baseDefinition.id,
          identifierValue: identifierValue as string | number,
          matchCount: 0,
        });
      }

      if (matches.length > 1) {
        return createError({
          type: 'INSTANCE_RESOLUTION_ERROR',
          message: `Ambiguous match for metric "${baseDefinition.code}" where ${keyLabel} (${matches.length} matches)`,
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
        resolvedFromExisting: true,
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
