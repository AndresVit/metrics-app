/**
 * Field Repository
 *
 * Loads fields from Supabase and provides mapping from
 * logical IDs (e.g., "field-est-adv") to real database UUIDs.
 *
 * Logical ID format: field-${metricCode.toLowerCase()}-${fieldName}
 */
import { supabase } from './supabaseClient';
import { DefinitionIdMap } from './DefinitionRepository';

export type FieldIdMap = Map<string, string>;

interface FieldRow {
  id: string;
  name: string;
  metric_definition_id: string;
}

/**
 * Loads all fields and builds a map from logical IDs to database UUIDs.
 *
 * @param userId - The user ID to filter fields
 * @param definitionIdMap - Map of logical definition IDs to UUIDs (used to reverse-lookup metric codes)
 * @returns Map where key = logical ID (e.g., "field-est-adv"), value = database UUID
 * @throws Error if the query fails
 */
export async function loadFieldIdMap(
  userId: string,
  definitionIdMap: DefinitionIdMap
): Promise<FieldIdMap> {
  const { data, error } = await supabase
    .from('fields')
    .select('id, name, metric_definition_id')
    .eq('user_id', userId);

  if (error) {
    throw new Error(`Failed to load fields: ${error.message}`);
  }

  // Build reverse map: UUID → logical definition ID
  const uuidToLogicalDef = new Map<string, string>();
  for (const [logicalId, uuid] of definitionIdMap) {
    uuidToLogicalDef.set(uuid, logicalId);
  }

  const map: FieldIdMap = new Map();

  for (const row of data as FieldRow[]) {
    // Get the metric's logical ID from its UUID
    const metricLogicalId = uuidToLogicalDef.get(row.metric_definition_id);
    if (!metricLogicalId) {
      console.warn(`Warning: Field ${row.id} references unknown metric ${row.metric_definition_id}`);
      continue;
    }

    // Extract metric code from logical ID (e.g., "def-est" → "est")
    const metricCode = metricLogicalId.replace('def-', '');

    // Build field's logical ID
    const logicalFieldId = `field-${metricCode}-${row.name}`;
    map.set(logicalFieldId, row.id);
  }

  return map;
}
