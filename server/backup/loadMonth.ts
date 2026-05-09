/**
 * Load all TIM entries for one calendar month, joined to their parent
 * EST/WORK headers and attribute children, ready to be passed to serializeMonth.
 *
 * Strategy:
 *   1. resolve TIM definition_id
 *   2. fetch TIM entries in [start, end) (local-time month)
 *   3. fetch their attribute children (time_init / time_end / time_type)
 *   4. fetch their parent metric entries (EST / WORK / ...) by id set
 *   5. fetch parent attribute children (adv, project, ...) and join values
 *
 * The DB is the source of truth — this loader never falls back to files.
 */

import { supabase } from '../../src/persistence';
import type { TimingBlock } from './serialize';

interface TimRow {
  id: number;
  parent_entry_id: number | null;
  timestamp: string;
  subdivision: string | null;
}

interface ChildRow {
  id: number;
  parent_entry_id: number;
  subdivision: string | null;
}

interface AttrRow {
  entry_id: number;
  field_id: string;
  value_int: number | null;
  value_float: number | null;
  value_string: string | null;
  value_bool: boolean | null;
}

interface ParentRow {
  id: number;
  definition_id: string;
  subdivision: string | null;
}

interface FieldRow {
  id: string;
  name: string;
  metric_definition_id: string;
}

interface DefRow {
  id: string;
  code: string;
}

export async function loadMonthTimings(userId: string, monthKey: string): Promise<TimingBlock[]> {
  const [yearStr, monthStr] = monthKey.split('-');
  const year = parseInt(yearStr, 10);
  const month = parseInt(monthStr, 10);
  if (!Number.isFinite(year) || !Number.isFinite(month)) {
    throw new Error(`Invalid monthKey: ${monthKey}`);
  }

  const startDate = new Date(year, month - 1, 1, 0, 0, 0, 0);
  const endDate = new Date(year, month, 1, 0, 0, 0, 0);

  // 1. TIM definition id
  const { data: timDefs, error: timDefErr } = await supabase
    .from('definitions')
    .select('id')
    .eq('user_id', userId)
    .eq('code', 'TIM')
    .eq('type', 'metric');
  if (timDefErr) throw new Error(`Load TIM def: ${timDefErr.message}`);
  if (!timDefs || timDefs.length === 0) return [];
  const timDefId = (timDefs as { id: string }[])[0].id;

  // 2. TIM entries in range
  const { data: timEntries, error: timErr } = await supabase
    .from('entries')
    .select('id, parent_entry_id, timestamp, subdivision')
    .eq('user_id', userId)
    .eq('definition_id', timDefId)
    .gte('timestamp', startDate.toISOString())
    .lt('timestamp', endDate.toISOString());
  if (timErr) throw new Error(`Load TIM entries: ${timErr.message}`);
  if (!timEntries || timEntries.length === 0) return [];
  const tims = timEntries as TimRow[];

  // 3. TIM children (time_init / time_end / time_type / duration).
  // Batched against PostgREST's 1000-row response cap: each TIM has ~8 children,
  // so a single .in() over >125 TIM ids would silently truncate.
  const BATCH = 100;
  const timIds = tims.map((t) => t.id);
  const timChildRows: ChildRow[] = [];
  for (let i = 0; i < timIds.length; i += BATCH) {
    const batch = timIds.slice(i, i + BATCH);
    const { data, error } = await supabase
      .from('entries')
      .select('id, parent_entry_id, subdivision')
      .in('parent_entry_id', batch);
    if (error) throw new Error(`Load TIM children: ${error.message}`);
    if (data) timChildRows.push(...(data as ChildRow[]));
  }

  const timChildIds = timChildRows.map((c) => c.id);
  let timAttrs: AttrRow[] = [];
  for (let i = 0; i < timChildIds.length; i += BATCH * 5) {
    const batch = timChildIds.slice(i, i + BATCH * 5);
    if (batch.length === 0) continue;
    const { data, error } = await supabase
      .from('attribute_entries')
      .select('entry_id, field_id, value_int, value_float, value_string, value_bool')
      .in('entry_id', batch);
    if (error) throw new Error(`Load TIM attrs: ${error.message}`);
    if (data) timAttrs.push(...(data as AttrRow[]));
  }

  const { data: timFields, error: timFieldsErr } = await supabase
    .from('fields')
    .select('id, name, metric_definition_id')
    .eq('metric_definition_id', timDefId);
  if (timFieldsErr) throw new Error(`Load TIM fields: ${timFieldsErr.message}`);
  const timFieldNameById = new Map<string, string>();
  for (const f of (timFields || []) as FieldRow[]) timFieldNameById.set(f.id, f.name);

  const attrByChildId = new Map<number, AttrRow>();
  for (const a of timAttrs) attrByChildId.set(a.entry_id, a);

  const timeValuesByTim = new Map<number, Map<string, number>>();
  const timeInitByTim = new Map<number, number>();
  const timeEndByTim = new Map<number, number>();

  for (const child of timChildRows) {
    const attr = attrByChildId.get(child.id);
    if (!attr) continue;
    const fieldName = timFieldNameById.get(attr.field_id);
    if (!fieldName) continue;

    if (fieldName === 'time_init' && attr.value_int !== null) {
      timeInitByTim.set(child.parent_entry_id, attr.value_int);
    } else if (fieldName === 'time_end' && attr.value_int !== null) {
      timeEndByTim.set(child.parent_entry_id, attr.value_int);
    } else if (fieldName === 'time_type' && attr.value_int !== null) {
      const sub = child.subdivision || '';
      const map = timeValuesByTim.get(child.parent_entry_id) || new Map<string, number>();
      map.set(sub, (map.get(sub) || 0) + attr.value_int);
      timeValuesByTim.set(child.parent_entry_id, map);
    }
  }

  // 4. Parent entries (EST / WORK / ...) — batched.
  const parentIds = [...new Set(tims.map((t) => t.parent_entry_id).filter((id): id is number => id !== null))];
  const parentRows: ParentRow[] = [];
  for (let i = 0; i < parentIds.length; i += BATCH) {
    const batch = parentIds.slice(i, i + BATCH);
    const { data, error } = await supabase
      .from('entries')
      .select('id, definition_id, subdivision')
      .in('id', batch);
    if (error) throw new Error(`Load parents: ${error.message}`);
    if (data) parentRows.push(...(data as ParentRow[]));
  }
  const parentById = new Map<number, ParentRow>(parentRows.map((p) => [p.id, p]));

  // 5. Parent definitions (id → code) and parent fields (id → name)
  const parentDefIds = [...new Set(parentRows.map((p) => p.definition_id))];
  let defRows: DefRow[] = [];
  if (parentDefIds.length > 0) {
    const { data, error } = await supabase
      .from('definitions')
      .select('id, code')
      .in('id', parentDefIds);
    if (error) throw new Error(`Load parent defs: ${error.message}`);
    defRows = (data || []) as DefRow[];
  }
  const codeByDefId = new Map<string, string>(defRows.map((d) => [d.id, d.code]));

  let parentFields: FieldRow[] = [];
  if (parentDefIds.length > 0) {
    const { data, error } = await supabase
      .from('fields')
      .select('id, name, metric_definition_id')
      .in('metric_definition_id', parentDefIds);
    if (error) throw new Error(`Load parent fields: ${error.message}`);
    parentFields = (data || []) as FieldRow[];
  }
  const fieldNameById = new Map<string, string>(parentFields.map((f) => [f.id, f.name]));

  // 6. Parent children (each holds an attribute value or a metric ref) — batched.
  const parentChildren: ChildRow[] = [];
  for (let i = 0; i < parentIds.length; i += BATCH) {
    const batch = parentIds.slice(i, i + BATCH);
    const { data, error } = await supabase
      .from('entries')
      .select('id, parent_entry_id, subdivision')
      .in('parent_entry_id', batch);
    if (error) throw new Error(`Load parent children: ${error.message}`);
    if (data) parentChildren.push(...(data as ChildRow[]));
  }

  const parentChildIds = parentChildren.map((c) => c.id);
  const parentAttrs: AttrRow[] = [];
  for (let i = 0; i < parentChildIds.length; i += BATCH * 5) {
    const batch = parentChildIds.slice(i, i + BATCH * 5);
    if (batch.length === 0) continue;
    const { data, error } = await supabase
      .from('attribute_entries')
      .select('entry_id, field_id, value_int, value_float, value_string, value_bool')
      .in('entry_id', batch);
    if (error) throw new Error(`Load parent attrs: ${error.message}`);
    if (data) parentAttrs.push(...(data as AttrRow[]));
  }
  const attrByParentChildId = new Map<number, AttrRow>(parentAttrs.map((a) => [a.entry_id, a]));

  // 6b. Tags on each parent (entry_tags joined by parent entry id) — batched.
  // Tags live on the parent EST/WORK/etc. entry — not on the TIM child.
  const tagRows: { entry_id: number; key: string; value: string | null }[] = [];
  for (let i = 0; i < parentIds.length; i += BATCH) {
    const batch = parentIds.slice(i, i + BATCH);
    const { data, error } = await supabase
      .from('entry_tags')
      .select('entry_id, key, value')
      .in('entry_id', batch);
    if (error) throw new Error(`Load parent tags: ${error.message}`);
    if (data) tagRows.push(...(data as typeof tagRows));
  }
  const tagsByParent = new Map<number, Array<{ key: string; value: string | null }>>();
  for (const r of tagRows) {
    const list = tagsByParent.get(r.entry_id) || [];
    list.push({ key: r.key, value: r.value });
    tagsByParent.set(r.entry_id, list);
  }

  // 7. Build attributes list per parent (skip metric-ref children — they have no attribute_entries row)
  const attrsByParent = new Map<number, Array<{ name: string; value: string }>>();
  for (const child of parentChildren) {
    const attr = attrByParentChildId.get(child.id);
    if (!attr) continue;
    const name = fieldNameById.get(attr.field_id);
    if (!name) continue;
    let value: string;
    if (attr.value_int !== null) value = String(attr.value_int);
    else if (attr.value_float !== null) value = String(attr.value_float);
    else if (attr.value_string !== null) value = attr.value_string;
    else if (attr.value_bool !== null) value = attr.value_bool ? 'true' : 'false';
    else continue;
    const list = attrsByParent.get(child.parent_entry_id) || [];
    list.push({ name, value });
    attrsByParent.set(child.parent_entry_id, list);
  }

  // 8. Build TimingBlocks
  const blocks: TimingBlock[] = [];
  for (const tim of tims) {
    const timeInit = timeInitByTim.get(tim.id);
    const timeEnd = timeEndByTim.get(tim.id);
    if (timeInit === undefined || timeEnd === undefined) continue;
    const timeValues = timeValuesByTim.get(tim.id) || new Map<string, number>();

    const ts = new Date(tim.timestamp);
    const localDay = new Date(ts.getFullYear(), ts.getMonth(), ts.getDate());

    let header: TimingBlock['header'];
    if (tim.parent_entry_id !== null) {
      const parent = parentById.get(tim.parent_entry_id);
      if (parent) {
        header = {
          definitionCode: codeByDefId.get(parent.definition_id) || 'TIM',
          subdivision: parent.subdivision,
          attributes: attrsByParent.get(parent.id) || [],
          tags: tagsByParent.get(parent.id) || [],
        };
      } else {
        header = { definitionCode: 'TIM', subdivision: tim.subdivision, attributes: [], tags: [] };
      }
    } else {
      header = { definitionCode: 'TIM', subdivision: tim.subdivision, attributes: [], tags: [] };
    }

    blocks.push({ date: localDay, timeInit, timeEnd, timeValues, header });
  }

  return blocks;
}
