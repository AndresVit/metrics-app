/**
 * Widget System v2 — In-Memory Executor
 *
 * Takes an ExecutionPlan and a WidgetConfig and returns an IntermediateTable.
 *
 * Architecture:
 *   1. loadEntries()     — load source entries + parent entries if needed
 *   2. applyWhere()      — filter entries using WHERE expression
 *   3. computeDimValues()— evaluate each GroupDimension per entry → bucket key
 *   4. groupEntries()    — partition entries by dimension tuple
 *   5. computeMeasures() — evaluate measures per group (in dependency order)
 *   6. applyTopk()       — keep only top-K entries for topk dimensions
 *   7. return IntermediateTable
 *
 * SQL translation path is a future addition:
 *   - The ExecutionPlan already exposes everything needed to build SQL.
 *   - A future SqlExecutor can implement the same interface and replace this
 *     executor for larger datasets.
 *
 * TIM_PART:
 *   When ExecutionPlan.needsTimPart is true, loadEntries() must also
 *   load all time-label child entries and make them available as virtual
 *   entries with one row per label for group-by-label operations.
 *   TODO: TIM_PART expansion is scaffolded but not fully implemented in v1.
 */

import { supabase } from '../persistence/supabaseClient';
import type {
  WidgetDef, DataSpec,
  GroupDimension, PeriodDimension, AttributeDimension, TopkDimension, PeriodType,
  MeasureDef,
  Expr, PathExpr, TimeExpr, PathSegment,
  IntermediateTable, IntermediateRow,
} from './ast';
import type { ExecutionPlan } from './analyzer';
import type { WidgetConfig } from './types';
import {
  applyGlobalFilterToEntries,
  isFilterActive,
  hasTagRules,
  type RootEntryForFilter,
} from './globalFilter';

// ─────────────────────────────────────────────────────────────
// Internal entry representation
// ─────────────────────────────────────────────────────────────

/**
 * A loaded entry with all data needed for expression evaluation.
 * "source" is the primary entry (TIM, READ, etc.)
 * "parent" is the activity entry this source is nested under (EST, WORK, etc.)
 */
export interface EntryRecord {
  id: number;
  timestamp: Date;
  /** entries.subdivision — for TIM: not a time label, it's the session label if set */
  subdivision: string | null;
  parentId: number | null;
  definitionCode: string;

  /**
   * Attribute field values by field name.
   * Loaded from attribute_entries joined through child entries.
   */
  attrs: Record<string, number | string | boolean | null>;

  /**
   * For TIM entries: exact time-label values.
   * Key: label string (e.g. "t", "m", "m/thk")
   * Value: minutes
   */
  timeLabels: Record<string, number>;

  /** Loaded parent entry, present when plan.parentDepthRequired >= 1 */
  parent?: ParentRecord;
}

export interface ParentRecord {
  id: number;
  subdivision: string | null;
  definitionCode: string;
  attrs: Record<string, number | string | boolean | null>;
}

// ─────────────────────────────────────────────────────────────
// Executor
// ─────────────────────────────────────────────────────────────

export async function executeWidget(
  plan: ExecutionPlan,
  config: WidgetConfig,
): Promise<IntermediateTable> {
  // 1. Load entries
  const entries = await loadEntries(plan, config);

  // 2. Apply WHERE filter
  const { data } = plan.widget;
  const filtered = data.where
    ? entries.filter(e => evalExprBool(data.where!, e, plan.sourceAlias, {}))
    : entries;

  // 3. Compute dimension values per entry
  const { dimKeys, allDimKeys } = computeDimValues(filtered, data.group, config, plan.sourceAlias);

  // 4. Group entries by dimension tuple
  const groups = groupEntries(filtered, dimKeys, allDimKeys);

  // 5. Inject empty groups for period buckets that have no data.
  //    This runs BEFORE measure computation so that sum() on an empty group
  //    correctly returns 0 (not null), via the aggregation semantics in evalAggExpr.
  addEmptyPeriodGroups(groups, data.group, allDimKeys, config);

  // 6. Build measure name→def map (in dependency order)
  const measureMap = new Map(data.measures.map(m => [m.name, m]));

  // 7. Compute measures per group.
  //    Empty groups (injected in step 5) naturally produce:
  //      sum(...)   → 0
  //      count()    → 0
  //      avg/min/max → null
  //      arithmetic → follows null propagation (e.g. 0/0 → null)
  const rows: IntermediateRow[] = [];

  for (const [dimTuple, groupEntries_] of groups) {
    const row: IntermediateRow = {};

    const dimValues = parseDimTuple(dimTuple, allDimKeys);
    for (const [k, v] of Object.entries(dimValues)) {
      row[k] = v;
    }

    const computedMeasures: Record<string, number | null> = {};
    for (const measureName of plan.measureOrder) {
      const mdef = measureMap.get(measureName);
      if (!mdef) continue;
      computedMeasures[measureName] = evalMeasure(
        mdef.expr, groupEntries_, plan.sourceAlias, computedMeasures,
      );
      row[measureName] = computedMeasures[measureName];
    }

    rows.push(row);
  }

  // 8. Sort by period dimension key(s) so output is in natural/chronological order.
  const sortedRows = sortRowsByPeriodDim(rows, data.group);

  // 9. Apply topk filtering per topk dimension
  const topkDims = data.group.filter((d): d is TopkDimension => d.kind === 'topk');
  let finalRows = sortedRows;
  for (const dim of topkDims) {
    finalRows = applyTopk(finalRows, dim);
  }

  // 10. Compute a total row: aggregate all filtered entries without any grouping.
  //     This gives semantically correct totals for derived measures (ratios, etc.)
  //     that can't be recovered by summing the grouped rows.
  const totalComputedMeasures: Record<string, number | null> = {};
  for (const measureName of plan.measureOrder) {
    const mdef = measureMap.get(measureName);
    if (!mdef) continue;
    totalComputedMeasures[measureName] = evalMeasure(
      mdef.expr, filtered, plan.sourceAlias, totalComputedMeasures,
    );
  }
  const totalRow: IntermediateRow = { ...totalComputedMeasures };

  return {
    dimColumns: data.group.map(d => d.name),
    measureColumns: plan.measureOrder,
    rows: finalRows,
    totalRow,
  };
}

// ─────────────────────────────────────────────────────────────
// Entry loading
// ─────────────────────────────────────────────────────────────

async function loadEntries(plan: ExecutionPlan, config: WidgetConfig): Promise<EntryRecord[]> {
  const { userId, startDate, endDate } = config;

  // 1. Resolve definition ID
  const { data: defs, error: defErr } = await supabase
    .from('definitions')
    .select('id, code')
    .eq('user_id', userId)
    .eq('code', plan.sourceCode)
    .eq('type', 'metric');

  if (defErr) throw new Error(`Failed to load definition: ${defErr.message}`);
  if (!defs || defs.length === 0) throw new Error(`Definition not found: ${plan.sourceCode}`);

  const definitionId = defs[0].id as string;

  // 2. Load metric entries in the time range
  const { data: rawEntries, error: entryErr } = await supabase
    .from('entries')
    .select('id, timestamp, subdivision, parent_entry_id')
    .eq('user_id', userId)
    .eq('definition_id', definitionId)
    .gte('timestamp', startDate.toISOString())
    .lt('timestamp', endDate.toISOString());

  if (entryErr) throw new Error(`Failed to load entries: ${entryErr.message}`);

  if (!rawEntries || rawEntries.length === 0) return [];

  const entryIds = rawEntries.map((e: any) => e.id as number);

  // 3. Load fields for this definition
  const { data: fields, error: fieldErr } = await supabase
    .from('fields')
    .select('id, name')
    .eq('metric_definition_id', definitionId);

  if (fieldErr) throw new Error(`Failed to load fields: ${fieldErr.message}`);
  const fieldIdToName = new Map<string, string>(
    (fields || []).map((f: any) => [f.id as string, f.name as string]),
  );

  // 4. Load attribute values via child entries
  const attrsByEntryId = await loadAttributeValues(entryIds, fieldIdToName);

  // 5. Load TIM time labels if any time() / timeUnder() expression is used.
  //    Using plan.requiresTimeData (set by the analyzer) rather than a source-code
  //    heuristic ensures we skip the extra query for TIM widgets that don't need it.
  const timeLabelsByEntryId =
    plan.requiresTimeData
      ? await loadTimeLabels(entryIds)
      : new Map<number, Record<string, number>>();

  // 6. Load parent entries if needed
  const parentRecords =
    plan.parentDepthRequired >= 1
      ? await loadParentRecords(rawEntries, userId)
      : new Map<number, ParentRecord>();

  // 7. Build EntryRecord[]
  const allEntries: EntryRecord[] = rawEntries.map((raw: any): EntryRecord => ({
    id: raw.id,
    timestamp: new Date(raw.timestamp),
    subdivision: raw.subdivision ?? null,
    parentId: raw.parent_entry_id ?? null,
    definitionCode: plan.sourceCode,
    attrs: attrsByEntryId.get(raw.id) ?? {},
    timeLabels: timeLabelsByEntryId.get(raw.id) ?? {},
    parent: parentRecords.get(raw.id),
  }));

  // 8. Dashboard-level global filter.
  //    Evaluated ONLY against each entry's ROOT ancestor (parent_entry_id IS NULL).
  //    If the root passes, the whole subtree is kept; if it fails, it's dropped.
  if (isFilterActive(config.globalFilter)) {
    const rootBySourceId = await resolveRootsForFilter(
      rawEntries,
      userId,
      hasTagRules(config.globalFilter),
    );
    return applyGlobalFilterToEntries(
      allEntries,
      config.globalFilter,
      (id) => rootBySourceId.get(id) ?? null,
    );
  }

  return allEntries;
}

/**
 * Batch sizes for Supabase .in() queries.
 *
 * PostgREST's default max_rows is 1000.  Each TIM entry has ~8-20 child rows
 * (time_init, time_end, duration + one per timing token).  To keep every
 * parent→children query under the cap we use a conservative batch of 50 parents
 * (50 × 20 = 1000 worst-case child rows).  The children→attribute_entries query
 * returns one row per child, so a larger batch of 500 is safe there.
 */
const PARENT_BATCH = 50;
const CHILD_BATCH  = 500;

/** Split an array into chunks of at most `size`. */
function chunks<T>(arr: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < arr.length; i += size) result.push(arr.slice(i, i + size));
  return result;
}

/**
 * Load attribute values for the given metric entry IDs.
 * Attributes are stored as child entries → attribute_entries.
 */
async function loadAttributeValues(
  entryIds: number[],
  fieldIdToName: Map<string, string>,
): Promise<Map<number, Record<string, number | string | boolean | null>>> {
  if (entryIds.length === 0) return new Map();

  // Batch parent IDs (parallel) to stay under PostgREST's row limit.
  const childBatchResults = await Promise.all(
    chunks(entryIds, PARENT_BATCH).map(batch =>
      supabase.from('entries').select('id, parent_entry_id').in('parent_entry_id', batch)
    )
  );
  const childRows: any[] = [];
  for (const { data, error } of childBatchResults) {
    if (error) throw new Error(`Failed to load child entries: ${error.message}`);
    if (data) childRows.push(...data);
  }

  if (childRows.length === 0) return new Map();

  const childIdToParent = new Map<number, number>(
    childRows.map((c: any) => [c.id as number, c.parent_entry_id as number]),
  );
  const childIds = childRows.map((c: any) => c.id as number);

  const attrRows: any[] = [];
  for (const batch of chunks(childIds, CHILD_BATCH)) {
    const { data, error } = await supabase
      .from('attribute_entries')
      .select('entry_id, field_id, value_int, value_float, value_string, value_bool, value_hierarchy')
      .in('entry_id', batch);
    if (error) throw new Error(`Failed to load attribute entries: ${error.message}`);
    if (data) attrRows.push(...data);
  }

  const result = new Map<number, Record<string, number | string | boolean | null>>();

  for (const a of attrRows) {
    const parentId = childIdToParent.get(a.entry_id);
    if (parentId === undefined) continue;
    const fieldName = fieldIdToName.get(a.field_id);
    if (!fieldName) continue;
    if (fieldName === 'time_type') continue; // handled by loadTimeLabels

    if (!result.has(parentId)) result.set(parentId, {});
    const value = a.value_hierarchy ?? a.value_string ?? a.value_float ?? a.value_int ?? a.value_bool ?? null;
    result.get(parentId)![fieldName] = value;
  }

  return result;
}

/**
 * Load time-label values for TIM entries.
 * Each time label is a child entry of the TIM entry, where:
 *   - entries.subdivision = time label (e.g. "t", "m", "m/thk")
 *   - attribute_entries.value_int = minutes
 */
async function loadTimeLabels(entryIds: number[]): Promise<Map<number, Record<string, number>>> {
  if (entryIds.length === 0) return new Map();

  // Batch parent IDs (parallel) to stay under PostgREST's row limit.
  const childBatchResults = await Promise.all(
    chunks(entryIds, PARENT_BATCH).map(batch =>
      supabase.from('entries').select('id, parent_entry_id, subdivision').in('parent_entry_id', batch)
    )
  );
  const childRows: any[] = [];
  for (const { data, error } of childBatchResults) {
    if (error) throw new Error(`Failed to load TIM child entries: ${error.message}`);
    if (data) childRows.push(...data);
  }

  if (childRows.length === 0) return new Map();

  const childIds = childRows.map((c: any) => c.id as number);

  const attrRows: any[] = [];
  for (const batch of chunks(childIds, CHILD_BATCH)) {
    const { data, error } = await supabase
      .from('attribute_entries')
      .select('entry_id, value_int')
      .in('entry_id', batch);
    if (error) throw new Error(`Failed to load TIM time values: ${error.message}`);
    if (data) attrRows.push(...data);
  }

  const childIdToValue = new Map<number, number>(
    attrRows
      .filter((a: any) => a.value_int !== null)
      .map((a: any) => [a.entry_id as number, a.value_int as number]),
  );

  const result = new Map<number, Record<string, number>>();

  for (const child of childRows) {
    const parentId = child.parent_entry_id as number;
    const label = child.subdivision as string | null;
    if (!label) continue;

    const value = childIdToValue.get(child.id);
    if (value === undefined) continue;

    if (!result.has(parentId)) result.set(parentId, {});
    const existing = result.get(parentId)!;
    existing[label] = (existing[label] ?? 0) + value;
  }

  return result;
}

/**
 * Load parent entries for source entries that have a parent_entry_id set.
 * Used for .parent path resolution.
 */
async function loadParentRecords(
  sourceEntries: any[],
  userId: string,
): Promise<Map<number, ParentRecord>> {
  const parentIds = [
    ...new Set(
      sourceEntries
        .map((e: any) => e.parent_entry_id as number | null)
        .filter((id): id is number => id !== null),
    ),
  ];

  if (parentIds.length === 0) return new Map();

  // Load parent entries
  const { data: parents, error: pErr } = await supabase
    .from('entries')
    .select('id, subdivision, definition_id')
    .in('id', parentIds)
    .eq('user_id', userId);

  if (pErr) throw new Error(`Failed to load parent entries: ${pErr.message}`);
  if (!parents || parents.length === 0) return new Map();

  // Load definition codes for parents
  const parentDefIds = [...new Set((parents as any[]).map(p => p.definition_id as string))];
  const { data: parentDefs, error: pdErr } = await supabase
    .from('definitions')
    .select('id, code')
    .in('id', parentDefIds);

  if (pdErr) throw new Error(`Failed to load parent definitions: ${pdErr.message}`);

  const defIdToCode = new Map<string, string>(
    (parentDefs || []).map((d: any) => [d.id as string, d.code as string]),
  );

  // Load parent attribute values
  const parentEntryIds = (parents as any[]).map(p => p.id as number);

  // For parent attributes, we need to know the fields of each parent definition.
  // We load all fields for the parent definitions involved.
  const { data: parentFields, error: pfErr } = await supabase
    .from('fields')
    .select('id, name, metric_definition_id')
    .in('metric_definition_id', parentDefIds);

  if (pfErr) throw new Error(`Failed to load parent fields: ${pfErr.message}`);

  const parentFieldIdToName = new Map<string, string>(
    (parentFields || []).map((f: any) => [f.id as string, f.name as string]),
  );

  const parentAttrs = await loadAttributeValues(parentEntryIds, parentFieldIdToName);

  // Build map from source entry ID → ParentRecord
  const parentIdToRecord = new Map<number, ParentRecord>(
    (parents as any[]).map((p): [number, ParentRecord] => [
      p.id,
      {
        id: p.id,
        subdivision: p.subdivision ?? null,
        definitionCode: defIdToCode.get(p.definition_id) ?? '',
        attrs: parentAttrs.get(p.id) ?? {},
      },
    ]),
  );

  // Map source entry ID → ParentRecord
  const result = new Map<number, ParentRecord>();
  for (const src of sourceEntries) {
    const pid = src.parent_entry_id as number | null;
    if (pid !== null) {
      const pr = parentIdToRecord.get(pid);
      if (pr) result.set(src.id, pr);
    }
  }

  return result;
}

/**
 * Walk the parent_entry_id chain for each source entry up to the root
 * (parent_entry_id IS NULL) and return a map from sourceId → RootEntryForFilter.
 *
 * This is used exclusively by the dashboard-level global filter, which is
 * specified to evaluate ONLY on the root ancestor of each source entry.
 *
 * Algorithm:
 *   1. BFS upward over entries.parent_entry_id, batching `.in('id', [...])`
 *      queries until we reach every root.
 *   2. Trace each source entry to its root via the accumulated parent map.
 *   3. Load full root metadata (definition code, subdivision, timestamp) and
 *      optionally entry_tags for the distinct set of root IDs.
 *
 * When `withTags` is false, the tag query is skipped entirely.
 */
async function resolveRootsForFilter(
  sourceEntries: any[],
  userId: string,
  withTags: boolean,
): Promise<Map<number, RootEntryForFilter>> {
  if (sourceEntries.length === 0) return new Map();

  // entryId → parent_entry_id (null at root)
  const parentOf = new Map<number, number | null>();
  for (const e of sourceEntries) {
    parentOf.set(e.id as number, (e.parent_entry_id ?? null) as number | null);
  }

  // BFS upward: fetch any parent_entry_id we've referenced but not yet loaded.
  let frontier: number[] = [
    ...new Set(
      sourceEntries
        .map((e: any) => e.parent_entry_id as number | null)
        .filter((p): p is number => p !== null),
    ),
  ];
  const MAX_DEPTH = 16; // safety valve against cyclic parents
  for (let depth = 0; depth < MAX_DEPTH && frontier.length > 0; depth++) {
    const missing = frontier.filter((id) => !parentOf.has(id));
    if (missing.length === 0) break;

    const ancestors: any[] = [];
    for (const batch of chunks(missing, PARENT_BATCH)) {
      const { data, error } = await supabase
        .from('entries')
        .select('id, parent_entry_id')
        .in('id', batch)
        .eq('user_id', userId);
      if (error) throw new Error(`Failed to walk parent chain: ${error.message}`);
      if (data) ancestors.push(...data);
    }

    const next = new Set<number>();
    for (const a of ancestors) {
      const pid = (a.parent_entry_id ?? null) as number | null;
      parentOf.set(a.id as number, pid);
      if (pid !== null && !parentOf.has(pid)) next.add(pid);
    }
    frontier = [...next];
  }

  // Trace each source entry to its root.
  const sourceToRootId = new Map<number, number>();
  for (const e of sourceEntries) {
    let cur = e.id as number;
    for (let hops = 0; hops < MAX_DEPTH; hops++) {
      const p = parentOf.get(cur);
      if (p === undefined || p === null) break;
      cur = p;
    }
    sourceToRootId.set(e.id as number, cur);
  }

  const rootIds = [...new Set(sourceToRootId.values())];
  if (rootIds.length === 0) return new Map();

  // Load root metadata (definition code + subdivision + timestamp).
  const rootRows: any[] = [];
  for (const batch of chunks(rootIds, PARENT_BATCH)) {
    const { data, error } = await supabase
      .from('entries')
      .select('id, subdivision, timestamp, definition_id')
      .in('id', batch)
      .eq('user_id', userId);
    if (error) throw new Error(`Failed to load root entries: ${error.message}`);
    if (data) rootRows.push(...data);
  }

  // Resolve definition_id → code for the set of root definitions used.
  const rootDefIds = [...new Set(rootRows.map((r: any) => r.definition_id as string))];
  const defIdToCode = new Map<string, string>();
  if (rootDefIds.length > 0) {
    const { data: defs, error: defErr } = await supabase
      .from('definitions')
      .select('id, code')
      .in('id', rootDefIds);
    if (defErr) throw new Error(`Failed to load root definitions: ${defErr.message}`);
    for (const d of (defs || [])) defIdToCode.set(d.id as string, d.code as string);
  }

  // Load tags for root entries only, and only if the filter actually uses them.
  const tagsByRootId = new Map<number, Record<string, string | null>>();
  if (withTags) {
    const tagRows: any[] = [];
    for (const batch of chunks(rootIds, CHILD_BATCH)) {
      const { data, error } = await supabase
        .from('entry_tags')
        .select('entry_id, key, value')
        .in('entry_id', batch);
      if (error) throw new Error(`Failed to load root entry tags: ${error.message}`);
      if (data) tagRows.push(...data);
    }
    for (const row of tagRows) {
      const id = row.entry_id as number;
      if (!tagsByRootId.has(id)) tagsByRootId.set(id, {});
      tagsByRootId.get(id)![row.key as string] = (row.value as string | null) ?? null;
    }
  }

  // Build the per-rootId filter record.
  const rootRecordById = new Map<number, RootEntryForFilter>();
  for (const r of rootRows) {
    rootRecordById.set(r.id as number, {
      definitionCode: defIdToCode.get(r.definition_id as string) ?? '',
      subdivision: (r.subdivision ?? null) as string | null,
      timestamp: new Date(r.timestamp as string),
      tags: tagsByRootId.get(r.id as number) ?? {},
    });
  }

  // Map every source entry to its root's filter record.
  const result = new Map<number, RootEntryForFilter>();
  for (const [srcId, rootId] of sourceToRootId) {
    const rec = rootRecordById.get(rootId);
    if (rec) result.set(srcId, rec);
  }
  return result;
}

// ─────────────────────────────────────────────────────────────
// Dimension computation
// ─────────────────────────────────────────────────────────────

interface DimValueResult {
  /** Map from entry ID → dimension key object */
  dimKeys: Map<number, Record<string, string | null>>;
  /** Ordered dimension names (same order as data.group) */
  allDimKeys: string[];
}

function computeDimValues(
  entries: EntryRecord[],
  group: GroupDimension[],
  config: WidgetConfig,
  alias: string,
): DimValueResult {
  const allDimKeys = group.map(d => d.name);
  const dimKeys = new Map<number, Record<string, string | null>>();

  for (const entry of entries) {
    const keys: Record<string, string | null> = {};
    for (const dim of group) {
      keys[dim.name] = evalDimension(dim, entry, config, alias);
    }
    dimKeys.set(entry.id, keys);
  }

  return { dimKeys, allDimKeys };
}

function evalDimension(
  dim: GroupDimension,
  entry: EntryRecord,
  config: WidgetConfig,
  alias: string,
): string | null {
  if (dim.kind === 'period') {
    return evalPeriodDim(dim, entry, config);
  }
  if (dim.kind === 'attribute' || dim.kind === 'topk') {
    const raw = resolvePathValue(dim.path, entry, alias);
    if (raw === null || raw === undefined) return null;
    return String(raw);
  }
  return null;
}

function evalPeriodDim(
  dim: PeriodDimension,
  entry: EntryRecord,
  config: WidgetConfig,
): string {
  const ts = entry.timestamp;
  switch (dim.periodType) {
    case 'hour':         return String(ts.getHours()).padStart(2, '0') + ':00';
    case 'day':          return formatDate(ts);
    case 'week':         return getWeekKey(ts);
    case 'month':        return `${ts.getFullYear()}-${String(ts.getMonth() + 1).padStart(2, '0')}`;
    case 'weekday':      return WEEKDAY_NAMES[ts.getDay()];
    case 'day_of_month': return String(ts.getDate());
    case 'month_of_year':return MONTH_NAMES[ts.getMonth()];
    default:             return formatDate(ts);
  }
}

// ─────────────────────────────────────────────────────────────
// Grouping
// ─────────────────────────────────────────────────────────────

export function groupEntries(
  entries: EntryRecord[],
  dimKeys: Map<number, Record<string, string | null>>,
  allDimKeys: string[],
): Map<string, EntryRecord[]> {
  const groups = new Map<string, EntryRecord[]>();

  for (const entry of entries) {
    const keys = dimKeys.get(entry.id);
    const tupleKey = allDimKeys.length === 0
      ? '__all__'
      : allDimKeys.map(k => keys?.[k] ?? '\x00null').join('\x01');

    if (!groups.has(tupleKey)) groups.set(tupleKey, []);
    groups.get(tupleKey)!.push(entry);
  }

  // If no group dimensions, ensure at least one group exists
  if (allDimKeys.length === 0 && !groups.has('__all__')) {
    groups.set('__all__', []);
  }

  return groups;
}

export function parseDimTuple(
  tupleKey: string,
  allDimKeys: string[],
): Record<string, string | null> {
  if (tupleKey === '__all__') return {};
  const parts = tupleKey.split('\x01');
  const result: Record<string, string | null> = {};
  for (let i = 0; i < allDimKeys.length; i++) {
    result[allDimKeys[i]] = parts[i] === '\x00null' ? null : parts[i];
  }
  return result;
}

// ─────────────────────────────────────────────────────────────
// Measure evaluation
// ─────────────────────────────────────────────────────────────

function evalMeasure(
  expr: Expr,
  entries: EntryRecord[],
  alias: string,
  computed: Record<string, number | null>,
): number | null {
  return evalAggExpr(expr, entries, alias, computed);
}

/**
 * Evaluate an expression that may be:
 *  - An aggregation function (sum, avg, count, min, max) over a collection
 *  - An arithmetic expression combining aggregated values and/or measure references
 *  - A measure reference (resolved from already-computed measures)
 */
export function evalAggExpr(
  expr: Expr,
  entries: EntryRecord[],
  alias: string,
  computed: Record<string, number | null>,
): number | null {
  switch (expr.kind) {
    case 'literal':
      return typeof expr.value === 'number' ? expr.value : null;

    case 'measure_ref':
      return computed[expr.name] ?? null;

    case 'binary': {
      if (expr.op === 'and' || expr.op === 'or') return null; // not numeric
      const l = evalAggExpr(expr.left, entries, alias, computed);
      const r = evalAggExpr(expr.right, entries, alias, computed);
      if (l === null || r === null) return null;
      switch (expr.op) {
        case '+': return l + r;
        case '-': return l - r;
        case '*': return l * r;
        case '/': return r === 0 ? null : l / r;
        case '%': return r === 0 ? null : l % r;
        default:  return null;
      }
    }

    case 'unary':
      if (expr.op === 'neg') {
        const v = evalAggExpr(expr.arg, entries, alias, computed);
        return v === null ? null : -v;
      }
      return null;

    case 'call': {
      const fn = expr.fn;

      if (fn === 'count') {
        return entries.length;
      }

      if (fn === 'sum' || fn === 'avg' || fn === 'min' || fn === 'max') {
        const values = entries
          .map(e => evalScalarExpr(expr.args[0], e, alias))
          .filter((v): v is number => v !== null);

        if (values.length === 0) {
          // sum/count of nothing = 0 (additive identity).
          // avg/min/max of nothing = null (undefined over empty set).
          return fn === 'sum' ? 0 : null;
        }

        if (fn === 'sum') return values.reduce((a, b) => a + b, 0);
        if (fn === 'avg') return values.reduce((a, b) => a + b, 0) / values.length;
        if (fn === 'min') return Math.min(...values);
        if (fn === 'max') return Math.max(...values);
      }

      return null;
    }

    default:
      return null;
  }
}

/**
 * Evaluate a scalar expression on a single entry.
 * Used as the argument to sum/avg/min/max/etc.
 */
function evalScalarExpr(
  expr: Expr,
  entry: EntryRecord,
  alias: string,
): number | null {
  switch (expr.kind) {
    case 'literal':
      return typeof expr.value === 'number' ? expr.value : null;

    case 'path': {
      const v = resolvePathValue(expr, entry, alias);
      if (v === null || v === undefined) return null;
      if (typeof v === 'number') return v;
      if (typeof v === 'string') {
        const n = parseFloat(v);
        return isNaN(n) ? null : n;
      }
      return null;
    }

    case 'time': {
      return resolveTimeValue(expr, entry, alias);
    }

    case 'binary': {
      const l = evalScalarExpr(expr.left, entry, alias);
      const r = evalScalarExpr(expr.right, entry, alias);
      if (l === null || r === null) return null;
      switch (expr.op) {
        case '+': return l + r;
        case '-': return l - r;
        case '*': return l * r;
        case '/': return r === 0 ? null : l / r;
        case '%': return r === 0 ? null : l % r;
        default:  return null;
      }
    }

    case 'unary':
      if (expr.op === 'neg') {
        const v = evalScalarExpr(expr.arg, entry, alias);
        return v === null ? null : -v;
      }
      return null;

    default:
      return null;
  }
}

// ─────────────────────────────────────────────────────────────
// Path and time resolution
// ─────────────────────────────────────────────────────────────

/**
 * Resolve a path expression to a scalar value on a single entry.
 *
 * - tims.duration            → entry.attrs["duration"]
 * - tims.subdivision         → entry.subdivision
 * - tims.parent.subdivision  → entry.parent?.subdivision
 * - tims.parent.project      → entry.parent?.attrs["project"]
 * - tims.parent.subdivision[0] → first "/" component of parent subdivision
 */
function resolvePathValue(
  path: PathExpr,
  entry: EntryRecord,
  alias: string,
): string | number | boolean | null | undefined {
  // The first segment is always the alias — skip it
  const segments = path.segments.slice(1);

  let current: any = entry;
  let isParent = false;

  for (const seg of segments) {
    if (current === null || current === undefined) return null;

    switch (seg.kind) {
      case 'parent':
        current = (current as EntryRecord).parent ?? null;
        isParent = true;
        break;

      case 'field': {
        const name = seg.name;
        // Direct entry columns (not in attrs)
        if (name === 'subdivision') {
          current = (current as EntryRecord | ParentRecord).subdivision;
        } else if (name === 'timestamp' && !isParent) {
          current = (current as EntryRecord).timestamp;
        } else if (name === 'code') {
          // entries don't have a direct .code — this would be the definition code
          current = (current as EntryRecord | ParentRecord).definitionCode;
        } else {
          current = (current as EntryRecord | ParentRecord).attrs[name] ?? null;
        }
        break;
      }

      case 'index': {
        // Index into a "/" split hierarchy string
        if (typeof current === 'string') {
          const parts = current.split('/');
          const idx = seg.index < 0 ? parts.length + seg.index : seg.index;
          current = parts[idx] ?? null;
        } else {
          return null;
        }
        break;
      }

      case 'slice': {
        // Slice of "/" split hierarchy, returns joined string
        if (typeof current === 'string') {
          const parts = current.split('/');
          const start = seg.start ?? 0;
          const end = seg.end ?? parts.length;
          current = parts.slice(start, end).join('/') || null;
        } else {
          return null;
        }
        break;
      }
    }
  }

  return current ?? null;
}

/**
 * Resolve a tims.time("label") or tims.timeUnder("label") expression.
 * - exact:        sum time labels matching exactly "label"
 * - hierarchical: sum time labels matching "label" or starting with "label/"
 */
function resolveTimeValue(expr: TimeExpr, entry: EntryRecord, alias: string): number | null {
  // Resolve the path to get the entry whose timeLabels we read.
  // For tims.time("t"), the path is just [alias] so we use the source entry directly.
  // For tims.parent.time("t") (unlikely but possible), we'd need parent's timeLabels.
  const pathTarget = resolvePathToEntry(expr.path, entry, alias);
  if (!pathTarget) return null;

  const labels = pathTarget.timeLabels;
  if (!labels || Object.keys(labels).length === 0) return null;

  if (!expr.hierarchical) {
    // Exact match
    return labels[expr.label] ?? null;
  } else {
    // Hierarchical: sum "label" and all "label/..." entries
    const prefix = expr.label + '/';
    let total = 0;
    let found = false;
    for (const [k, v] of Object.entries(labels)) {
      if (k === expr.label || k.startsWith(prefix)) {
        total += v;
        found = true;
      }
    }
    return found ? total : null;
  }
}

/**
 * Resolve a path to the EntryRecord it refers to (not a field value).
 * Used when we need the timeLabels of the resolved entry.
 */
function resolvePathToEntry(
  path: PathExpr,
  entry: EntryRecord,
  alias: string,
): EntryRecord | null {
  const segments = path.segments.slice(1);
  let current: EntryRecord | ParentRecord = entry;

  for (const seg of segments) {
    if (seg.kind === 'parent') {
      current = (current as EntryRecord).parent ?? null as any;
      if (!current) return null;
    } else {
      // Any field segment after alias ends the entry traversal
      break;
    }
  }

  return current as EntryRecord;
}

// ─────────────────────────────────────────────────────────────
// WHERE clause evaluation
// ─────────────────────────────────────────────────────────────

/**
 * Evaluate a boolean expression for WHERE filtering.
 * Returns true if the entry passes the filter.
 */
export function evalExprBool(
  expr: Expr,
  entry: EntryRecord,
  alias: string,
  computed: Record<string, number | null>,
): boolean {
  switch (expr.kind) {
    case 'literal':
      return Boolean(expr.value);

    case 'binary': {
      if (expr.op === 'and') {
        return evalExprBool(expr.left, entry, alias, computed) &&
               evalExprBool(expr.right, entry, alias, computed);
      }
      if (expr.op === 'or') {
        return evalExprBool(expr.left, entry, alias, computed) ||
               evalExprBool(expr.right, entry, alias, computed);
      }
      // Comparison
      const lv = resolveScalarForComparison(expr.left, entry, alias);
      const rv = resolveScalarForComparison(expr.right, entry, alias);
      if (lv === null || rv === null) return false;
      switch (expr.op) {
        case '=':  return lv === rv;
        case '!=': return lv !== rv;
        case '<':  return lv < rv;
        case '<=': return lv <= rv;
        case '>':  return lv > rv;
        case '>=': return lv >= rv;
        default:   return false;
      }
    }

    case 'unary':
      if (expr.op === 'not') {
        return !evalExprBool(expr.arg, entry, alias, computed);
      }
      return false;

    case 'in': {
      const subject = resolveScalarForComparison(expr.expr, entry, alias);
      const candidates = expr.values.map(v => resolveScalarForComparison(v, entry, alias));
      const match = candidates.some(c => c !== null && c === subject);
      return expr.negated ? !match : match;
    }

    case 'under': {
      const subject = resolveScalarForComparison(expr.expr, entry, alias);
      if (typeof subject !== 'string') return expr.negated;
      const prefix = expr.prefix;
      const match = subject === prefix || subject.startsWith(prefix + '/');
      return expr.negated ? !match : match;
    }

    default:
      return false;
  }
}

function resolveScalarForComparison(
  expr: Expr,
  entry: EntryRecord,
  alias: string,
): string | number | boolean | null {
  switch (expr.kind) {
    case 'literal': return expr.value;
    case 'path':    return resolvePathValue(expr, entry, alias) ?? null;
    case 'time':    return resolveTimeValue(expr, entry, alias);
    default:        return null;
  }
}

// ─────────────────────────────────────────────────────────────
// TopK
// ─────────────────────────────────────────────────────────────

/**
 * After measure computation, filter rows to keep only the top-K distinct values
 * for a topk dimension, ranked by the 'by' measure.
 *
 * Ranking rules:
 *  - 'by' must be a measure_ref (validated by the analyzer).
 *    The measure is already computed in each row; we sum it across all rows
 *    for each candidate dimension value (so multi-period widgets rank by total).
 *  - Dimension values whose 'by' measure is always null are excluded from ranking.
 *  - Ties broken deterministically:
 *      Primary:   measure total descending
 *      Secondary: dimension value string ascending (null sorts last)
 *  - topk happens AFTER period bucket filling, so each surviving dim value
 *    retains its full set of period rows (including empty-bucket zero rows).
 */
export function applyTopk(rows: IntermediateRow[], dim: TopkDimension): IntermediateRow[] {
  const byMeasureName = extractMeasureName(dim.by);
  if (!byMeasureName) return rows;

  // Sum 'by' measure across all rows per distinct dim value
  const dimTotals = new Map<string | null, number>();
  for (const row of rows) {
    const dimVal    = row[dim.name] as string | null;
    const measureVal = row[byMeasureName];
    if (typeof measureVal !== 'number') continue; // null, undefined, or non-numeric → skip
    dimTotals.set(dimVal, (dimTotals.get(dimVal) ?? 0) + measureVal);
  }

  // If nothing could be ranked (measure absent or always null), be a no-op
  if (dimTotals.size === 0) return rows;

  // Sort: measure descending, then dim value ascending for deterministic tie-breaking.
  // null dim values sort after all non-null values.
  const sorted = [...dimTotals.entries()]
    .sort((a, b) => {
      const diff = b[1] - a[1];
      if (diff !== 0) return diff;
      // Secondary: dim value ascending; null sorts last
      const av = a[0] ?? '\uffff';
      const bv = b[0] ?? '\uffff';
      return av < bv ? -1 : av > bv ? 1 : 0;
    })
    .slice(0, dim.k)
    .map(([val]) => val);

  const topSet = new Set(sorted);
  return rows.filter(row => topSet.has(row[dim.name] as string | null));
}

// ─────────────────────────────────────────────────────────────
// Period bucket filling (pre-measure injection)
// ─────────────────────────────────────────────────────────────

/**
 * Inject empty groups (entry arrays) into the groups Map for any period
 * bucket that has no data yet.  This MUST run BEFORE measure computation
 * so that sum() on an empty group naturally returns 0 via evalAggExpr.
 *
 * Only handles the single-period-dim case.  Multi-period-dim cartesian
 * product filling is a future TODO.
 *
 * For widgets with non-period dimensions (attribute, topk) we enumerate
 * only the contexts that already have at least one data row — we cannot
 * enumerate an attribute's domain without domain knowledge.
 * If there are no data rows at all and there's only a period dimension,
 * we still inject all expected buckets as empty groups.
 */
export function addEmptyPeriodGroups(
  groups: Map<string, EntryRecord[]>,
  groupDims: GroupDimension[],
  allDimKeys: string[],
  config: WidgetConfig,
): void {
  const periodDims = groupDims.filter((d): d is PeriodDimension => d.kind === 'period');
  if (periodDims.length === 0) return;
  if (periodDims.length > 1) return; // TODO: cartesian product for multi-period

  const periodDim = periodDims[0];
  const periodDimIdx = allDimKeys.indexOf(periodDim.name);
  const nonPeriodDimKeys = allDimKeys.filter(k => k !== periodDim.name);

  const buckets = generatePeriodBuckets(periodDim.periodType, config.startDate, config.endDate);

  // Collect distinct non-period contexts from existing group keys
  const contexts = new Set<string>();
  for (const tupleKey of groups.keys()) {
    if (tupleKey === '__all__') continue;
    const parts = tupleKey.split('\x01');
    const ctxParts = allDimKeys
      .map((k, i) => (k !== periodDim.name ? parts[i] : null))
      .filter((v): v is string => v !== null);
    contexts.add(ctxParts.join('\x01'));
  }

  // If no data at all and no non-period dims, seed one empty context
  if (contexts.size === 0 && nonPeriodDimKeys.length === 0) {
    contexts.add('');
  }

  // Track (context, bucket) pairs that already exist
  const existing = new Set<string>();
  for (const tupleKey of groups.keys()) {
    if (tupleKey === '__all__') continue;
    const parts = tupleKey.split('\x01');
    const ctxParts = allDimKeys
      .map((k, i) => (k !== periodDim.name ? parts[i] : null))
      .filter((v): v is string => v !== null);
    const ctx = ctxParts.join('\x01');
    const bucketVal = parts[periodDimIdx] ?? '\x00null';
    existing.add(ctx + '\x02' + bucketVal);
  }

  // Insert empty groups for every (context × bucket) that is missing
  for (const context of contexts) {
    const ctxParts = nonPeriodDimKeys.length > 0 ? context.split('\x01') : [];

    for (const bucket of buckets) {
      if (existing.has(context + '\x02' + bucket)) continue;

      // Rebuild the full tuple key with the bucket value at the right position
      const fullParts: string[] = [];
      let ctxIdx = 0;
      for (const dimKey of allDimKeys) {
        if (dimKey === periodDim.name) {
          fullParts.push(bucket);
        } else {
          fullParts.push(ctxParts[ctxIdx++] ?? '\x00null');
        }
      }
      const tupleKey = fullParts.join('\x01');
      if (!groups.has(tupleKey)) {
        groups.set(tupleKey, []);
      }
    }
  }
}

/**
 * Sort intermediate rows by the first period dimension's values.
 * String sort works correctly for all our key formats:
 *   "YYYY-MM-DD", "YYYY-Www", "YYYY-MM", "HH:00", "Mon"/"Tue"/..., etc.
 */
export function sortRowsByPeriodDim(rows: IntermediateRow[], group: GroupDimension[]): IntermediateRow[] {
  const periodDims = group.filter((d): d is PeriodDimension => d.kind === 'period');
  if (periodDims.length === 0) return rows;

  const dimName = periodDims[0].name;
  return [...rows].sort((a, b) => {
    const av = String(a[dimName] ?? '');
    const bv = String(b[dimName] ?? '');
    return av < bv ? -1 : av > bv ? 1 : 0;
  });
}

/**
 * Generate all expected bucket key strings for a given period dimension type
 * within the widget's `[startDate, endDate)` range.
 *
 * For contiguous period types (day, week, month), we enumerate all instances
 * that fall within the window.  For non-contiguous types (weekday, hour, etc.),
 * we return the fixed full set.
 */
function generatePeriodBuckets(
  periodType: PeriodType,
  startDate: Date,
  endDate: Date,
): string[] {
  switch (periodType) {
    case 'day': {
      const buckets: string[] = [];
      const cur = new Date(startDate);
      while (cur < endDate) {
        buckets.push(formatDate(cur));
        cur.setDate(cur.getDate() + 1);
      }
      return buckets;
    }

    case 'week': {
      const buckets: string[] = [];
      const cur = new Date(startDate);
      // Advance to Monday
      const dow = cur.getDay();
      cur.setDate(cur.getDate() - (dow === 0 ? 6 : dow - 1));
      const seen = new Set<string>();
      while (cur < endDate) {
        const key = getWeekKey(cur);
        if (!seen.has(key)) { seen.add(key); buckets.push(key); }
        cur.setDate(cur.getDate() + 7);
      }
      return buckets;
    }

    case 'month': {
      const buckets: string[] = [];
      const cur = new Date(startDate.getFullYear(), startDate.getMonth(), 1);
      while (cur < endDate) {
        buckets.push(`${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, '0')}`);
        cur.setMonth(cur.getMonth() + 1);
      }
      return buckets;
    }

    case 'hour':
      return Array.from({ length: 24 }, (_, h) => String(h).padStart(2, '0') + ':00');

    case 'weekday':
      return [...WEEKDAY_NAMES];

    case 'day_of_month': {
      // Number of days in the anchor month (or the period's start month)
      const year  = startDate.getFullYear();
      const month = startDate.getMonth();
      const daysInMonth = new Date(year, month + 1, 0).getDate();
      return Array.from({ length: daysInMonth }, (_, i) => String(i + 1));
    }

    case 'month_of_year':
      return [...MONTH_NAMES];

    default:
      return [];
  }
}

function extractMeasureName(expr: Expr): string | null {
  if (expr.kind === 'measure_ref') return expr.name;
  // Also handle call(measure_ref) one level deep (e.g. sum(m))
  if (expr.kind === 'call' && expr.args[0]?.kind === 'measure_ref') {
    return expr.args[0].name;
  }
  return null;
}

const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_NAMES   = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                       'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function formatDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function getWeekKey(d: Date): string {
  // ISO week: Monday-anchored
  const tmp = new Date(d);
  tmp.setHours(0, 0, 0, 0);
  tmp.setDate(tmp.getDate() + 3 - ((tmp.getDay() + 6) % 7));
  const week1 = new Date(tmp.getFullYear(), 0, 4);
  const weekNum = 1 + Math.round(
    ((tmp.getTime() - week1.getTime()) / 86400000 - 3 + ((week1.getDay() + 6) % 7)) / 7,
  );
  return `${tmp.getFullYear()}-W${String(weekNum).padStart(2, '0')}`;
}
