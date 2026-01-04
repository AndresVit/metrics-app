/**
 * Definition Repository
 *
 * Loads definitions from Supabase and provides mapping from
 * logical IDs (e.g., "def-est") to real database UUIDs.
 *
 * Logical ID format: def-${code.toLowerCase()}
 */
import { supabase } from './supabaseClient';

export type DefinitionIdMap = Map<string, string>;

interface DefinitionRow {
  id: string;
  code: string;
}

/**
 * Loads all definitions and builds a map from logical IDs to database UUIDs.
 *
 * @param userId - The user ID to filter definitions
 * @returns Map where key = logical ID (e.g., "def-est"), value = database UUID
 * @throws Error if the query fails
 */
export async function loadDefinitionIdMap(userId: string): Promise<DefinitionIdMap> {
  const { data, error } = await supabase
    .from('definitions')
    .select('id, code')
    .eq('user_id', userId);

  if (error) {
    throw new Error(`Failed to load definitions: ${error.message}`);
  }

  const map: DefinitionIdMap = new Map();

  for (const row of data as DefinitionRow[]) {
    const logicalId = `def-${row.code.toLowerCase()}`;
    map.set(logicalId, row.id);
  }

  return map;
}
