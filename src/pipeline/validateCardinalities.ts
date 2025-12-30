// Validates field cardinalities (min/max instances) for all entries.
import {
  PipelineState,
  PipelineResult,
  ResolvedEntry,
  createSuccess,
  createError,
} from './types';

function processEntry(
  entry: ResolvedEntry,
  state: PipelineState
): PipelineResult<void> {
  const { context } = state;
  const { definitions, fieldsByMetric } = context;

  const definition = definitions.get(entry.entry.definitionId);
  if (!definition || definition.type !== 'metric') {
    for (const child of entry.children) {
      const result = processEntry(child, state);
      if (!result.success) return result;
    }
    return createSuccess(undefined);
  }

  const metricFields = fieldsByMetric.get(definition.id) || [];

  for (const field of metricFields) {
    const instanceCount = entry.children.filter((c) => c.fieldId === field.id).length;

    if (instanceCount < field.minInstances) {
      return createError({
        type: 'CARDINALITY_ERROR',
        message: `Field "${field.name}" requires at least ${field.minInstances} instance(s), but got ${instanceCount}`,
        fieldId: field.id,
        fieldName: field.name,
        expected: { min: field.minInstances, max: field.maxInstances },
        actual: instanceCount,
      });
    }

    if (field.maxInstances !== null && instanceCount > field.maxInstances) {
      return createError({
        type: 'CARDINALITY_ERROR',
        message: `Field "${field.name}" allows at most ${field.maxInstances} instance(s), but got ${instanceCount}`,
        fieldId: field.id,
        fieldName: field.name,
        expected: { min: field.minInstances, max: field.maxInstances },
        actual: instanceCount,
      });
    }
  }

  for (const child of entry.children) {
    const result = processEntry(child, state);
    if (!result.success) return result;
  }

  return createSuccess(undefined);
}

export function validateCardinalities(state: PipelineState): PipelineResult<PipelineState> {
  const result = processEntry(state.root, state);
  if (!result.success) {
    return result as PipelineResult<PipelineState>;
  }

  return createSuccess(state);
}
