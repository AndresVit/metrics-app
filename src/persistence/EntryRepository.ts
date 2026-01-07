/**
 * Entry Repository
 *
 * Persists ResolvedEntry trees to Supabase.
 * Handles the mapping from temporary pipeline IDs to real database IDs.
 * Resolves logical IDs (e.g., "def-est") to real database UUIDs.
 *
 * MVP Scope:
 * - Insert only (no updates, no deletes, no reads)
 * - Persists entries and attribute_entries
 * - Definitions and fields are assumed to already exist
 */
import { supabase } from './supabaseClient';
import { ResolvedEntry } from '../pipeline/types';
import { DefinitionIdMap } from './DefinitionRepository';
import { FieldIdMap } from './FieldRepository';

/**
 * Configuration for persistence, including ID resolution maps.
 */
export interface PersistenceConfig {
  definitionIdMap: DefinitionIdMap;
  fieldIdMap: FieldIdMap;
}

/**
 * Database row types for inserts
 */
interface EntryInsert {
  user_id: string;
  definition_id: string;
  parent_entry_id: number | null;
  timestamp: string; // ISO string for Supabase (always at 00:00)
  subdivision: string | null;
  comments: string | null;
}

interface MetricEntryInsert {
  entry_id: number;
}

interface AttributeEntryInsert {
  entry_id: number;
  field_id: string;
  value_int: number | null;
  value_float: number | null;
  value_string: string | null;
  value_bool: boolean | null;
  value_timestamp: string | null; // ISO string
  value_hierarchy: string | null;
}

/**
 * Resolves a logical definition ID to a database UUID.
 *
 * @param logicalId - The logical definition ID (e.g., "def-est")
 * @param map - The definition ID map
 * @returns The resolved database UUID
 * @throws Error if the logical ID cannot be resolved
 */
function resolveDefinitionId(logicalId: string, map: DefinitionIdMap): string {
  const uuid = map.get(logicalId);
  if (!uuid) {
    throw new Error(
      `Cannot resolve definition ID: logical="${logicalId}" not found in map. ` +
      `Available: [${Array.from(map.keys()).join(', ')}]`
    );
  }
  return uuid;
}

/**
 * Resolves a logical field ID to a database UUID.
 *
 * @param logicalId - The logical field ID (e.g., "field-est-adv")
 * @param map - The field ID map
 * @returns The resolved database UUID
 * @throws Error if the logical ID cannot be resolved
 */
function resolveFieldId(logicalId: string, map: FieldIdMap): string {
  const uuid = map.get(logicalId);
  if (!uuid) {
    throw new Error(
      `Cannot resolve field ID: logical="${logicalId}" not found in map. ` +
      `Available: [${Array.from(map.keys()).join(', ')}]`
    );
  }
  return uuid;
}

/**
 * Persists a ResolvedEntry tree to the database.
 *
 * Traverses depth-first, inserting entries and their specializations.
 * Maintains a map from temporary IDs (from pipeline) to real database IDs.
 * Resolves logical IDs to database UUIDs before inserting.
 *
 * @param root - The root ResolvedEntry from the pipeline
 * @param userId - The user ID for all entries
 * @param config - Persistence configuration with ID resolution maps
 * @throws Error if any database operation fails or ID resolution fails
 */
export async function persistResolvedEntry(
  root: ResolvedEntry,
  userId: string,
  config: PersistenceConfig
): Promise<void> {
  // Map from temporary entry IDs (used during pipeline) to real database IDs
  const idMap = new Map<number, number>();

  // Process the tree depth-first
  await persistEntryRecursive(root, userId, null, idMap, config);
}

/**
 * Recursively persists an entry and its children.
 *
 * @param resolved - The ResolvedEntry to persist
 * @param userId - The user ID
 * @param parentDbId - The real database ID of the parent entry (null for root)
 * @param idMap - Map from temporary IDs to real database IDs
 * @param config - Persistence configuration with ID resolution maps
 */
async function persistEntryRecursive(
  resolved: ResolvedEntry,
  userId: string,
  parentDbId: number | null,
  idMap: Map<number, number>,
  config: PersistenceConfig
): Promise<void> {
  const tempId = resolved.entry.id;
  const logicalDefId = resolved.entry.definitionId;

  // Resolve logical definition ID to UUID
  let resolvedDefId: string;
  try {
    resolvedDefId = resolveDefinitionId(logicalDefId, config.definitionIdMap);
  } catch (err) {
    console.error(`[entries] Insert failed - logical=${logicalDefId}, resolved=MISSING`);
    throw err;
  }

  // 1. Insert into entries table (timestamp is always at 00:00 start of day)
  const entryRow: EntryInsert = {
    user_id: userId,
    definition_id: resolvedDefId,
    parent_entry_id: parentDbId,
    timestamp: resolved.entry.timestamp.toISOString(),
    subdivision: resolved.entry.subdivision,
    comments: resolved.entry.comments,
  };

  const { data: insertedEntry, error: entryError } = await supabase
    .from('entries')
    .insert(entryRow)
    .select('id')
    .single();

  if (entryError || !insertedEntry) {
    console.error(
      `[entries] Insert failed - logical=${logicalDefId}, resolved=${resolvedDefId}, ` +
      `error=${entryError?.message || 'No data returned'}`
    );
    throw new Error(`Failed to insert entry: ${entryError?.message || 'No data returned'}`);
  }

  const realId = insertedEntry.id as number;
  idMap.set(tempId, realId);

  // 2. Insert into metric_entries or attribute_entries
  if (resolved.metricEntry) {
    // This is a metric entry
    const metricRow: MetricEntryInsert = {
      entry_id: realId,
    };

    const { error: metricError } = await supabase.from('metric_entries').insert(metricRow);

    if (metricError) {
      console.error(
        `[metric_entries] Insert failed - entry_id=${realId}, ` +
        `error=${metricError.message}`
      );
      throw new Error(`Failed to insert metric_entry: ${metricError.message}`);
    }
  }

  if (resolved.attributeEntry) {
    const logicalFieldId = resolved.attributeEntry.fieldId;

    // Resolve logical field ID to UUID
    let resolvedFieldId: string;
    try {
      resolvedFieldId = resolveFieldId(logicalFieldId, config.fieldIdMap);
    } catch (err) {
      console.error(`[attribute_entries] Insert failed - logical=${logicalFieldId}, resolved=MISSING`);
      throw err;
    }

    // This is an attribute entry
    const attrRow: AttributeEntryInsert = {
      entry_id: realId,
      field_id: resolvedFieldId,
      value_int: resolved.attributeEntry.valueInt,
      value_float: resolved.attributeEntry.valueFloat,
      value_string: resolved.attributeEntry.valueString,
      value_bool: resolved.attributeEntry.valueBool,
      value_timestamp: resolved.attributeEntry.valueTimestamp?.toISOString() || null,
      value_hierarchy: resolved.attributeEntry.valueHierarchy,
    };

    const { error: attrError } = await supabase.from('attribute_entries').insert(attrRow);

    if (attrError) {
      console.error(
        `[attribute_entries] Insert failed - logical=${logicalFieldId}, resolved=${resolvedFieldId}, ` +
        `error=${attrError.message}`
      );
      throw new Error(`Failed to insert attribute_entry: ${attrError.message}`);
    }
  }

  // 3. Recursively persist children with this entry as parent
  for (const child of resolved.children) {
    await persistEntryRecursive(child, userId, realId, idMap, config);
  }
}

/**
 * Persists multiple ResolvedEntry trees.
 * Each tree is persisted independently.
 *
 * @param entries - Array of root ResolvedEntry objects
 * @param userId - The user ID for all entries
 * @param config - Persistence configuration with ID resolution maps
 * @throws Error if any persistence fails
 */
export async function persistResolvedEntries(
  entries: ResolvedEntry[],
  userId: string,
  config: PersistenceConfig
): Promise<void> {
  for (const entry of entries) {
    await persistResolvedEntry(entry, userId, config);
  }
}
