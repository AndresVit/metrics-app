/**
 * Entry Loader.
 *
 * Loads persisted entries from Supabase, filtered by definition code and an
 * explicit `[startDate, endDate)` half-open range.
 */

import { supabase } from '../persistence/supabaseClient';
import { LoadedEntry } from './types';

interface EntryRow {
  id: number;
  definition_id: string;
  timestamp: string;
  subdivision: string | null;
  parent_entry_id: number | null;
}

interface AttributeEntryRow {
  entry_id: number;
  field_id: string;
  value_int: number | null;
  value_float: number | null;
  value_string: string | null;
  value_bool: boolean | null;
}

interface FieldRow {
  id: string;
  name: string;
  metric_definition_id: string;
}

interface DefinitionRow {
  id: string;
  code: string;
}

interface ChildEntryRow {
  id: number;
  parent_entry_id: number;
  subdivision: string | null;
}

interface ChildAttributeRow {
  entry_id: number;
  field_id: string;
  value_int: number | null;
}

/**
 * Batch sizes for Supabase .in() queries.
 *
 * PostgREST's default max_rows is 1000.  Each TIM entry has ~8-20 child rows
 * (time_init, time_end, duration + one per timing token).  To keep every
 * parent→children query under the cap we use a conservative batch of 50 parents
 * (50 × 20 = 1000 worst-case child rows).  The children→attribute_entries query
 * returns ~1 row per child, so a larger batch of 500 is safe there.
 *
 * These mirror the values in src/widget/executor.ts. Without batching, large
 * fetch windows (e.g. Time Patterns' 30-day rolling-average window) silently
 * truncate rows — producing entries with null time_init/time_end that later
 * get dropped by the intake adapter.
 */
const PARENT_BATCH = 50;
const CHILD_BATCH  = 500;

function chunks<T>(arr: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < arr.length; i += size) result.push(arr.slice(i, i + size));
  return result;
}

/**
 * Load entries from database for an explicit calendar-date range.
 *
 * @param definitionCode - The metric definition code (e.g. "TIM")
 * @param userId         - The user ID
 * @param startDate      - Inclusive lower bound (local-time midnight of first day)
 * @param endDate        - Exclusive upper bound (local-time midnight of day after last day)
 */
export async function loadEntriesInRange(
  definitionCode: string,
  userId: string,
  startDate: Date,
  endDate: Date,
): Promise<LoadedEntry[]> {
  const t0 = Date.now();

  // Step 1: resolve definition ID
  let t = Date.now();
  const { data: definitions, error: defError } = await supabase
    .from('definitions')
    .select('id, code')
    .eq('user_id', userId)
    .eq('code', definitionCode)
    .eq('type', 'metric');
  console.log(`[loadEntries:${definitionCode}] q1 definitions: ${Date.now() - t}ms`);

  if (defError) throw new Error(`Failed to load definition: ${defError.message}`);
  if (!definitions || definitions.length === 0) throw new Error(`Definition not found: ${definitionCode}`);

  const definitionId = (definitions as DefinitionRow[])[0].id;

  // Step 2: fetch entries + fields in parallel (both depend only on definitionId)
  t = Date.now();
  const [entriesResult, fieldsResult] = await Promise.all([
    supabase
      .from('entries')
      .select('id, definition_id, timestamp, subdivision, parent_entry_id')
      .eq('user_id', userId)
      .eq('definition_id', definitionId)
      .gte('timestamp', startDate.toISOString())
      .lt('timestamp', endDate.toISOString()),
    supabase
      .from('fields')
      .select('id, name, metric_definition_id')
      .eq('metric_definition_id', definitionId),
  ]);
  console.log(`[loadEntries:${definitionCode}] q2+q3 entries+fields parallel: ${Date.now() - t}ms → ${entriesResult.data?.length ?? 0} entries, ${fieldsResult.data?.length ?? 0} fields`);

  if (entriesResult.error) throw new Error(`Failed to load entries: ${entriesResult.error.message}`);
  if (fieldsResult.error) throw new Error(`Failed to load fields: ${fieldsResult.error.message}`);

  if (!entriesResult.data || entriesResult.data.length === 0) {
    console.log(`[loadEntries:${definitionCode}] total: ${Date.now() - t0}ms (0 entries)`);
    return [];
  }

  const entryRows = entriesResult.data as EntryRow[];
  const entryIds = entryRows.map((e) => e.id);
  const fieldRows = (fieldsResult.data || []) as FieldRow[];
  const fieldIdToName = new Map<string, string>();
  for (const field of fieldRows) fieldIdToName.set(field.id, field.name);

  // Step 3: fetch all child entries (needed by both attr-entries and time_type lookups).
  // Batched by parent IDs to stay under PostgREST's 1000-row cap.
  t = Date.now();
  const childBatchResults = await Promise.all(
    chunks(entryIds, PARENT_BATCH).map(batch =>
      supabase
        .from('entries')
        .select('id, parent_entry_id, subdivision')
        .in('parent_entry_id', batch),
    ),
  );
  const childRows: ChildEntryRow[] = [];
  for (const { data, error } of childBatchResults) {
    if (error) throw new Error(`Failed to load child entries: ${error.message}`);
    if (data) childRows.push(...(data as ChildEntryRow[]));
  }
  console.log(`[loadEntries:${definitionCode}] q4 child-entries: ${Date.now() - t}ms → ${childRows.length} rows (IN ${entryIds.length} ids, ${childBatchResults.length} batches)`);

  const childIds = childRows.map((c) => c.id);

  // Step 4: fetch attribute_entries + time_type values in parallel.
  // Both use the same childIds; neither depends on the other.
  // Also batched by child IDs to stay under the row cap.
  let attrRows: AttributeEntryRow[] = [];
  let timeValuesByEntry: Map<number, Map<string, number>> = new Map();

  if (childIds.length > 0) {
    t = Date.now();

    const timeTypeField = definitionCode === 'TIM'
      ? fieldRows.find(f => f.name === 'time_type')
      : undefined;

    const childIdBatches = chunks(childIds, CHILD_BATCH);

    const attrBatchesPromise = Promise.all(
      childIdBatches.map(batch =>
        supabase
          .from('attribute_entries')
          .select('entry_id, field_id, value_int, value_float, value_string, value_bool')
          .in('entry_id', batch),
      ),
    );

    const timeTypeBatchesPromise = timeTypeField
      ? Promise.all(
          childIdBatches.map(batch =>
            supabase
              .from('attribute_entries')
              .select('entry_id, field_id, value_int')
              .in('entry_id', batch)
              .eq('field_id', timeTypeField.id),
          ),
        )
      : Promise.resolve<null>(null);

    const [attrBatches, timeTypeBatches] = await Promise.all([attrBatchesPromise, timeTypeBatchesPromise]);

    for (const { data, error } of attrBatches) {
      if (error) throw new Error(`Failed to load attribute entries: ${error.message}`);
      if (data) attrRows.push(...(data as AttributeEntryRow[]));
    }

    let timeTypeRows: ChildAttributeRow[] = [];
    if (timeTypeBatches) {
      for (const { data, error } of timeTypeBatches) {
        if (error) throw new Error(`Failed to load time_type entries: ${error.message}`);
        if (data) timeTypeRows.push(...(data as ChildAttributeRow[]));
      }
    }

    console.log(`[loadEntries:${definitionCode}] q5+q7 attr-entries parallel: ${Date.now() - t}ms → attr=${attrRows.length} timeType=${timeTypeRows.length} rows (${childIdBatches.length} batches)`);

    if (timeTypeField && timeTypeRows.length > 0) {
      const childIdToValue = new Map<number, number>();
      for (const a of timeTypeRows) {
        if (a.value_int !== null) childIdToValue.set(a.entry_id, a.value_int);
      }

      for (const child of childRows) {
        const value = childIdToValue.get(child.id);
        if (value === undefined) continue;
        const parentId = child.parent_entry_id;
        if (!timeValuesByEntry.has(parentId)) timeValuesByEntry.set(parentId, new Map());
        const parentMap = timeValuesByEntry.get(parentId)!;
        const subdivision = child.subdivision || '';
        parentMap.set(subdivision, (parentMap.get(subdivision) || 0) + value);
      }
    }
  }

  // Build child → parent map
  const childToParent = new Map<number, number>();
  for (const child of childRows) childToParent.set(child.id, child.parent_entry_id);

  console.log(`[loadEntries:${definitionCode}] total: ${Date.now() - t0}ms (${entryRows.length} entries)`);

  // Build LoadedEntry objects
  const result: LoadedEntry[] = [];

  for (const entryRow of entryRows) {
    const attributes = new Map<string, number | string | boolean | null>();

    for (const attr of attrRows) {
      const parentId = childToParent.get(attr.entry_id);
      if (parentId !== entryRow.id) continue;

      const fieldName = fieldIdToName.get(attr.field_id);
      if (!fieldName) continue;
      if (fieldName === 'time_type') continue; // handled separately via timeValues

      const value = attr.value_int ?? attr.value_float ?? attr.value_string ?? attr.value_bool ?? null;
      attributes.set(fieldName, value);
    }

    const loadedEntry: LoadedEntry = {
      id: entryRow.id,
      definitionCode,
      timestamp: new Date(entryRow.timestamp),
      subdivision: entryRow.subdivision,
      parentEntryId: entryRow.parent_entry_id,
      attributes,
    };

    if (definitionCode === 'TIM') {
      loadedEntry.timeValues = timeValuesByEntry.get(entryRow.id) || new Map();
    }

    result.push(loadedEntry);
  }

  return result;
}
