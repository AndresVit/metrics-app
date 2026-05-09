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
import { ResolvedEntry, getAttributeValue } from '../pipeline/types';
import { MetricDefinition } from '../domain';
import { DefinitionIdMap } from './DefinitionRepository';
import { FieldIdMap } from './FieldRepository';

/**
 * Configuration for persistence, including ID resolution maps.
 */
export interface PersistenceConfig {
  definitionIdMap: DefinitionIdMap;
  fieldIdMap: FieldIdMap;
  /** Map from logical definition ID to MetricDefinition (for search key computation) */
  metricDefinitions?: Map<string, MetricDefinition>;
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
  search_key_value: string | null;
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
  value_entry_id: number | null;
}

/**
 * Resolves a logical definition ID to a database UUID.
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
 * @param root - The root ResolvedEntry from the pipeline
 * @param userId - The user ID for all entries
 * @param config - Persistence configuration with ID resolution maps
 * @param globalIdMap - Optional shared map across multiple persistResolvedEntry calls.
 *   Populated with (pipelineId → realDbId) for every inserted entry so that
 *   in-batch cross-references (e.g. BOOK inserted then READ referencing it in
 *   the same request) can resolve the real DB id.
 */
export async function persistResolvedEntry(
  root: ResolvedEntry,
  userId: string,
  config: PersistenceConfig,
  globalIdMap?: Map<number, number>
): Promise<void> {
  // Map from temporary entry IDs (used during pipeline) to real database IDs
  const idMap = new Map<number, number>();

  // Process the tree depth-first
  await persistEntryRecursive(root, userId, null, idMap, config, globalIdMap);
}

/**
 * Recursively persists an entry and its children.
 */
async function persistEntryRecursive(
  resolved: ResolvedEntry,
  userId: string,
  parentDbId: number | null,
  idMap: Map<number, number>,
  config: PersistenceConfig,
  globalIdMap?: Map<number, number>
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

  // Compute search_key_value if this metric has a search key
  let searchKeyValue: string | null = null;
  if (config.metricDefinitions) {
    const metricDef = config.metricDefinitions.get(logicalDefId);
    if (metricDef && metricDef.searchKeyType) {
      if (metricDef.searchKeyType === 'subdivision') {
        searchKeyValue = resolved.entry.subdivision || null;
      } else if (metricDef.searchKeyType === 'attribute' && metricDef.searchKeyFieldId) {
        for (const child of resolved.children) {
          if (child.fieldId === metricDef.searchKeyFieldId && child.attributeEntry) {
            const val = getAttributeValue(child.attributeEntry);
            searchKeyValue = val !== null ? String(val) : null;
            break;
          }
        }
      }
    }
  }

  // 1. Insert into entries table (timestamp is always at 00:00 start of day)
  const entryRow: EntryInsert = {
    user_id: userId,
    definition_id: resolvedDefId,
    parent_entry_id: parentDbId,
    timestamp: resolved.entry.timestamp.toISOString(),
    subdivision: resolved.entry.subdivision,
    comments: resolved.entry.comments,
    search_key_value: searchKeyValue,
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
  globalIdMap?.set(tempId, realId);

  // Update entry.id in-place so subsequent in-batch references resolve to the real DB id.
  // This is safe because each pipeline run creates a fresh ResolvedEntry tree.
  resolved.entry.id = realId;

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
      value_entry_id: resolved.attributeEntry.valueEntryId,
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

  // 3. Recursively persist non-reference children
  for (const child of resolved.children) {
    if (child.resolvedFromExisting) continue;
    await persistEntryRecursive(child, userId, realId, idMap, config, globalIdMap);
  }

  // 4. Persist reference field links (resolvedFromExisting children with a fieldId + metricEntry)
  //    These represent metric-reference fields (e.g. READ.book → BOOK entry).
  //    We insert a child entries row + attribute_entries row with value_entry_id pointing
  //    to the referenced entry's real DB id.
  for (const child of resolved.children) {
    if (!child.resolvedFromExisting) continue;
    if (!child.fieldId) continue;
    // child.entry.id was updated in-place during its own persistence (for same-batch refs),
    // or is already a real DB id (for DB-preloaded refs).
    const referencedRealId = child.entry.id;

    let resolvedFieldId: string;
    try {
      resolvedFieldId = resolveFieldId(child.fieldId, config.fieldIdMap);
    } catch (err) {
      console.warn(`[attribute_entries] Skipping reference field ${child.fieldId}: field UUID not found`);
      continue;
    }

    let resolvedChildDefId: string;
    try {
      resolvedChildDefId = resolveDefinitionId(child.entry.definitionId, config.definitionIdMap);
    } catch (err) {
      console.warn(`[attribute_entries] Skipping reference def ${child.entry.definitionId}: def UUID not found`);
      continue;
    }

    // Insert a child entries row to serve as the anchor for the attribute_entries FK
    const refEntryRow: EntryInsert = {
      user_id: userId,
      definition_id: resolvedChildDefId,
      parent_entry_id: realId,
      timestamp: resolved.entry.timestamp.toISOString(),
      subdivision: null,
      comments: null,
      search_key_value: null,
    };

    const { data: refEntry, error: refEntryError } = await supabase
      .from('entries')
      .insert(refEntryRow)
      .select('id')
      .single();

    if (refEntryError || !refEntry) {
      console.warn(
        `[attribute_entries] Reference entries insert failed for field=${child.fieldId}: ` +
        (refEntryError?.message || 'No data returned')
      );
      continue;
    }

    const refEntryId = refEntry.id as number;

    // Insert attribute_entries row with value_entry_id pointing to the referenced entry
    const refAttrRow: AttributeEntryInsert = {
      entry_id: refEntryId,
      field_id: resolvedFieldId,
      value_int: null,
      value_float: null,
      value_string: null,
      value_bool: null,
      value_timestamp: null,
      value_hierarchy: null,
      value_entry_id: referencedRealId,
    };

    const { error: refAttrError } = await supabase.from('attribute_entries').insert(refAttrRow);

    if (refAttrError) {
      console.warn(
        `[attribute_entries] Reference attribute insert failed for field=${child.fieldId}: ` +
        refAttrError.message
      );
    }
  }
}

/**
 * Persists multiple ResolvedEntry trees.
 * Uses a shared globalIdMap so in-batch cross-references resolve correctly.
 */
export async function persistResolvedEntries(
  entries: ResolvedEntry[],
  userId: string,
  config: PersistenceConfig
): Promise<void> {
  const globalIdMap = new Map<number, number>();
  for (const entry of entries) {
    await persistResolvedEntry(entry, userId, config, globalIdMap);
  }
}

// ---------------------------------------------------------------------------
// Batch persist (BFS-level bulk insert)
// ---------------------------------------------------------------------------

interface QueueItem {
  resolved: ResolvedEntry;
  parentDbId: number | null;
}

interface PendingRefLink {
  parentRealId: number;
  referencedRealId: number;
  resolvedFieldId: string;
  resolvedChildDefId: string;
  timestamp: Date;
}

/**
 * Builds the entries row payload for a single ResolvedEntry node.
 */
function buildEntryRow(
  resolved: ResolvedEntry,
  userId: string,
  parentDbId: number | null,
  config: PersistenceConfig
): EntryInsert {
  const logicalDefId = resolved.entry.definitionId;
  const resolvedDefId = resolveDefinitionId(logicalDefId, config.definitionIdMap);

  let searchKeyValue: string | null = null;
  if (config.metricDefinitions) {
    const metricDef = config.metricDefinitions.get(logicalDefId);
    if (metricDef && metricDef.searchKeyType) {
      if (metricDef.searchKeyType === 'subdivision') {
        searchKeyValue = resolved.entry.subdivision || null;
      } else if (metricDef.searchKeyType === 'attribute' && metricDef.searchKeyFieldId) {
        for (const child of resolved.children) {
          if (child.fieldId === metricDef.searchKeyFieldId && child.attributeEntry) {
            const val = getAttributeValue(child.attributeEntry);
            searchKeyValue = val !== null ? String(val) : null;
            break;
          }
        }
      }
    }
  }

  return {
    user_id: userId,
    definition_id: resolvedDefId,
    parent_entry_id: parentDbId,
    timestamp: resolved.entry.timestamp.toISOString(),
    subdivision: resolved.entry.subdivision,
    comments: resolved.entry.comments,
    search_key_value: searchKeyValue,
  };
}

/**
 * Persists multiple ResolvedEntry trees using BFS-level batch inserts.
 *
 * Instead of one round-trip per node (N×26 for 40 TIM entries ≈ 1040 queries),
 * this inserts all nodes at the same depth in a single bulk query, then moves
 * to the next depth level once real IDs are available.
 *
 * For 40 EST/TIM timing entries the query count drops to ~7 regardless of N.
 *
 * @param roots      - All root ResolvedEntry trees to persist
 * @param userId     - User ID for all rows
 * @param config     - Persistence config with ID maps
 * @param globalIdMap - Shared map updated with tempId → realId for every
 *                     inserted entry; callers can use this for cross-batch refs
 * @param logger     - Optional per-phase timing/count logger
 */
export async function persistResolvedEntriesBatch(
  roots: ResolvedEntry[],
  userId: string,
  config: PersistenceConfig,
  globalIdMap: Map<number, number>,
  logger?: (phase: string, count: number, ms: number) => void
): Promise<void> {
  // Reference links: resolvedFromExisting children need an entries anchor row
  // + attribute_entries row with value_entry_id. Collected during traversal
  // and batch-inserted at the end (after all fresh entries have real IDs).
  const pendingRefLinks: PendingRefLink[] = [];

  let currentLevel: QueueItem[] = roots.map((r) => ({ resolved: r, parentDbId: null }));
  let depth = 0;

  while (currentLevel.length > 0) {
    const t0 = Date.now();

    // --- 1. Batch insert entries for this level ---
    const entryRows: EntryInsert[] = currentLevel.map(({ resolved, parentDbId }) =>
      buildEntryRow(resolved, userId, parentDbId, config)
    );

    const { data: insertedEntries, error: entriesError } = await supabase
      .from('entries')
      .insert(entryRows)
      .select('id');

    if (entriesError || !insertedEntries || insertedEntries.length !== currentLevel.length) {
      throw new Error(
        `[batch-insert] entries depth=${depth} failed: ` +
        (entriesError?.message || `expected ${currentLevel.length} rows, got ${insertedEntries?.length ?? 0}`)
      );
    }

    logger?.(`entries depth=${depth}`, currentLevel.length, Date.now() - t0);

    // --- 2. Map temp IDs → real IDs; build metric/attr row batches ---
    const metricRows: MetricEntryInsert[] = [];
    const attrRows: AttributeEntryInsert[] = [];

    for (let i = 0; i < currentLevel.length; i++) {
      const { resolved } = currentLevel[i];
      const realId = (insertedEntries[i] as { id: number }).id;

      globalIdMap.set(resolved.entry.id, realId);
      resolved.entry.id = realId; // in-place update so downstream refs see real ID

      if (resolved.metricEntry) {
        metricRows.push({ entry_id: realId });
      }

      if (resolved.attributeEntry) {
        const logicalFieldId = resolved.attributeEntry.fieldId;
        let resolvedFieldId: string;
        try {
          resolvedFieldId = resolveFieldId(logicalFieldId, config.fieldIdMap);
        } catch {
          console.warn(`[batch-insert] Cannot resolve field ${logicalFieldId}, skipping attribute_entries row`);
          continue;
        }
        attrRows.push({
          entry_id: realId,
          field_id: resolvedFieldId,
          value_int: resolved.attributeEntry.valueInt,
          value_float: resolved.attributeEntry.valueFloat,
          value_string: resolved.attributeEntry.valueString,
          value_bool: resolved.attributeEntry.valueBool,
          value_timestamp: resolved.attributeEntry.valueTimestamp?.toISOString() || null,
          value_hierarchy: resolved.attributeEntry.valueHierarchy,
          value_entry_id: resolved.attributeEntry.valueEntryId,
        });
      }
    }

    // --- 3. Batch insert metric_entries and attribute_entries for this level ---
    if (metricRows.length > 0) {
      const t1 = Date.now();
      const { error: meErr } = await supabase.from('metric_entries').insert(metricRows);
      if (meErr) throw new Error(`[batch-insert] metric_entries depth=${depth} failed: ${meErr.message}`);
      logger?.(`metric_entries depth=${depth}`, metricRows.length, Date.now() - t1);
    }

    if (attrRows.length > 0) {
      const t1 = Date.now();
      const { error: aeErr } = await supabase.from('attribute_entries').insert(attrRows);
      if (aeErr) throw new Error(`[batch-insert] attribute_entries depth=${depth} failed: ${aeErr.message}`);
      logger?.(`attribute_entries depth=${depth}`, attrRows.length, Date.now() - t1);
    }

    // --- 4. Collect next level children and pending reference links ---
    const nextLevel: QueueItem[] = [];

    for (const { resolved } of currentLevel) {
      const parentRealId = resolved.entry.id; // now a real DB ID

      for (const child of resolved.children) {
        if (child.resolvedFromExisting) {
          if (!child.fieldId) continue;
          let resolvedFieldId: string;
          let resolvedChildDefId: string;
          try {
            resolvedFieldId = resolveFieldId(child.fieldId, config.fieldIdMap);
            resolvedChildDefId = resolveDefinitionId(child.entry.definitionId, config.definitionIdMap);
          } catch {
            console.warn(`[batch-insert] Cannot resolve ref link field=${child.fieldId}, skipping`);
            continue;
          }
          pendingRefLinks.push({
            parentRealId,
            referencedRealId: child.entry.id, // updated in-place if same-batch BOOK
            resolvedFieldId,
            resolvedChildDefId,
            timestamp: resolved.entry.timestamp,
          });
        } else {
          nextLevel.push({ resolved: child, parentDbId: parentRealId });
        }
      }
    }

    currentLevel = nextLevel;
    depth++;
  }

  // --- 5. Batch insert reference link entries (resolvedFromExisting children) ---
  if (pendingRefLinks.length > 0) {
    const t0 = Date.now();
    const refEntryRows: EntryInsert[] = pendingRefLinks.map((ref) => ({
      user_id: userId,
      definition_id: ref.resolvedChildDefId,
      parent_entry_id: ref.parentRealId,
      timestamp: ref.timestamp.toISOString(),
      subdivision: null,
      comments: null,
      search_key_value: null,
    }));

    const { data: refEntries, error: refErr } = await supabase
      .from('entries')
      .insert(refEntryRows)
      .select('id');

    if (!refErr && refEntries && refEntries.length === pendingRefLinks.length) {
      const refAttrRows: AttributeEntryInsert[] = (refEntries as { id: number }[]).map((re, i) => ({
        entry_id: re.id,
        field_id: pendingRefLinks[i].resolvedFieldId,
        value_int: null,
        value_float: null,
        value_string: null,
        value_bool: null,
        value_timestamp: null,
        value_hierarchy: null,
        value_entry_id: pendingRefLinks[i].referencedRealId,
      }));

      const { error: refAttrErr } = await supabase.from('attribute_entries').insert(refAttrRows);
      if (refAttrErr) {
        console.warn(`[batch-insert] Batch reference attr_entries insert failed: ${refAttrErr.message}`);
      }
      logger?.('ref_links', pendingRefLinks.length, Date.now() - t0);
    } else {
      console.warn(`[batch-insert] Batch reference entries insert failed: ${refErr?.message}`);
    }
  }
}
