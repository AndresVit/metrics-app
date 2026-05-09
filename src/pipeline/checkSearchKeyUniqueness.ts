// Checks that entries with search keys don't duplicate existing entries.
import {
  PipelineState,
  PipelineResult,
  ResolvedEntry,
  createSuccess,
  createError,
  getAttributeValue,
} from './types';

/**
 * Computes the search key value for a resolved entry based on its metric's search key config.
 * Returns null if the metric has no search key.
 */
export function computeSearchKeyValue(
  entry: ResolvedEntry,
  state: PipelineState
): string | null {
  const { context } = state;
  const { metricDefinitions } = context;

  const metricDef = metricDefinitions.get(entry.entry.definitionId);
  if (!metricDef || !metricDef.searchKeyType) return null;

  if (metricDef.searchKeyType === 'subdivision') {
    return entry.entry.subdivision || null;
  }

  // searchKeyType === 'attribute'
  if (!metricDef.searchKeyFieldId) return null;

  for (const child of entry.children) {
    if (child.fieldId === metricDef.searchKeyFieldId && child.attributeEntry) {
      const value = getAttributeValue(child.attributeEntry);
      return value !== null ? String(value) : null;
    }
  }

  return null;
}

/**
 * Checks uniqueness only for the root entry being inserted.
 * Does not recurse into children — resolved references (from convertToInstances)
 * are existing entries and should not be rechecked, and inline metric entries
 * (like TIM inside EST) are covered by the DB unique index if they have keys.
 */
export function checkSearchKeyUniqueness(state: PipelineState): PipelineResult<PipelineState> {
  const { root, context } = state;
  const { definitions, metricDefinitions } = context;

  const definition = definitions.get(root.entry.definitionId);
  if (!definition || definition.type !== 'metric') {
    return createSuccess(state);
  }

  const metricDef = metricDefinitions.get(definition.id);
  if (!metricDef || !metricDef.searchKeyType) {
    return createSuccess(state);
  }

  const keyValue = computeSearchKeyValue(root, state);
  if (keyValue !== null && context.existingEntries.findBySearchKey) {
    const existing = context.existingEntries.findBySearchKey(definition.id, keyValue);
    if (existing.length > 0) {
      const existingId = existing[0].entry.id;
      return createError({
        type: 'DUPLICATE_KEY_ERROR',
        message: `Duplicate ${definition.code} search key="${keyValue}" (existing entry id=${existingId})`,
        metricDefinitionId: definition.id,
        searchKeyValue: keyValue,
        existingEntryId: existingId,
      });
    }
  }

  return createSuccess(state);
}
