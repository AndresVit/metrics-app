/**
 * Regression test: loadEntriesInRange must batch .in() queries so that large
 * fetch windows don't silently truncate rows at PostgREST's 1000-row cap.
 *
 * Root cause: loadEntriesInRange previously issued a single
 *   .from('entries').in('parent_entry_id', entryIds)
 * and a single
 *   .from('attribute_entries').in('entry_id', childIds)
 * Any result set exceeding 1000 rows was silently truncated. Since time_init
 * and time_end live in attribute_entries, truncated rows surfaced as entries
 * with null time_init/time_end — later dropped by the intake adapter. This
 * produced missing Sat/Sun data in the Time Patterns heatmap whenever the
 * fetch range (analysisRange ∪ rolling-30 window ≈ 33 days) generated
 * enough children to exceed the cap.
 *
 * Fix: batch both queries via chunks(arr, PARENT_BATCH|CHILD_BATCH), mirroring
 * the working pattern in src/widget/executor.ts.
 *
 * The mock enforces MOCK_ROW_CAP per .in() call and generates inputs that
 * would exceed it if unbatched.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Simulated PostgREST row cap. Must be >= CHILD_BATCH (500) so a single
// correctly-batched child→attribute query fits, but small enough that the
// unbatched totals definitely exceed it.
const MOCK_ROW_CAP = 600;

// Dataset (TIM schema: each parent has 4 children — time_type, time_init,
// time_end, duration — and each child has exactly 1 attribute_entries row).
//   parents  = 300  → exceeds PARENT_BATCH (50) → 6 batches
//   children = 1200 → exceeds CHILD_BATCH  (500) → 3 batches
//   attrs    = 1200 → exceeds MOCK_ROW_CAP (600) × 2
const PARENT_COUNT = 300;

const TIME_TYPE_FIELD_ID = 'field-timetype';
const TIME_INIT_FIELD_ID = 'field-timeinit';
const TIME_END_FIELD_ID  = 'field-timeend';
const DURATION_FIELD_ID  = 'field-duration';

interface ParentRow {
  id: number;
  definition_id: string;
  timestamp: string;
  subdivision: string | null;
  parent_entry_id: number | null;
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

const parents: ParentRow[] = [];
const children: ChildRow[] = [];
const attrs: AttrRow[] = [];

for (let p = 0; p < PARENT_COUNT; p++) {
  const parentId = 1000 + p;
  parents.push({
    id: parentId,
    definition_id: 'def-tim',
    timestamp: `2026-03-${String((p % 28) + 1).padStart(2, '0')}T14:00:00Z`,
    subdivision: null,
    parent_entry_id: null,
  });

  const tTypeId  = parentId * 100 + 0;
  const tInitId  = parentId * 100 + 1;
  const tEndId   = parentId * 100 + 2;
  const durId    = parentId * 100 + 3;

  children.push(
    { id: tTypeId, parent_entry_id: parentId, subdivision: 't' },
    { id: tInitId, parent_entry_id: parentId, subdivision: null },
    { id: tEndId,  parent_entry_id: parentId, subdivision: null },
    { id: durId,   parent_entry_id: parentId, subdivision: null },
  );

  attrs.push(
    { entry_id: tTypeId, field_id: TIME_TYPE_FIELD_ID, value_int: 30,  value_float: null, value_string: null, value_bool: null },
    { entry_id: tInitId, field_id: TIME_INIT_FIELD_ID, value_int: 540, value_float: null, value_string: null, value_bool: null },
    { entry_id: tEndId,  field_id: TIME_END_FIELD_ID,  value_int: 570, value_float: null, value_string: null, value_bool: null },
    { entry_id: durId,   field_id: DURATION_FIELD_ID,  value_int: 30,  value_float: null, value_string: null, value_bool: null },
  );
}

// ── Mock Supabase builder that enforces MOCK_ROW_CAP per .in() query ──────────

interface QueryState {
  table: string;
  filters: Record<string, string | number | number[]>;
}

const inCallLog: { table: string; column: string; size: number }[] = [];

function resolveRows(state: QueryState): unknown[] {
  switch (state.table) {
    case 'definitions':
      return [{ id: 'def-tim', code: 'TIM' }];

    case 'fields':
      return [
        { id: TIME_TYPE_FIELD_ID, name: 'time_type', metric_definition_id: 'def-tim' },
        { id: TIME_INIT_FIELD_ID, name: 'time_init', metric_definition_id: 'def-tim' },
        { id: TIME_END_FIELD_ID,  name: 'time_end',  metric_definition_id: 'def-tim' },
        { id: DURATION_FIELD_ID,  name: 'duration',  metric_definition_id: 'def-tim' },
      ];

    case 'entries': {
      if (!('parent_entry_id' in state.filters)) return parents;
      const parentIds = new Set(state.filters['parent_entry_id'] as number[]);
      let rows = children.filter(c => parentIds.has(c.parent_entry_id));
      if (rows.length > MOCK_ROW_CAP) rows = rows.slice(0, MOCK_ROW_CAP);
      return rows;
    }

    case 'attribute_entries': {
      const entryIds = new Set(state.filters['entry_id'] as number[]);
      let rows = attrs.filter(a => entryIds.has(a.entry_id));
      const fieldIdFilter = state.filters['field_id'] as string | undefined;
      if (fieldIdFilter) rows = rows.filter(a => a.field_id === fieldIdFilter);
      if (rows.length > MOCK_ROW_CAP) rows = rows.slice(0, MOCK_ROW_CAP);
      return rows;
    }

    default:
      return [];
  }
}

function makeBuilder() {
  const state: QueryState = { table: '', filters: {} };
  const builder = {
    _state: state,
    select: () => builder,
    eq: (col: string, val: string | number) => {
      state.filters[col] = val;
      return builder;
    },
    in: (col: string, vals: number[]) => {
      state.filters[col] = vals;
      inCallLog.push({ table: state.table, column: col, size: vals.length });
      return builder;
    },
    gte: () => builder,
    lt:  () => builder,
    then: (resolve: (v: { data: unknown[]; error: null }) => void) => {
      resolve({ data: resolveRows(state), error: null });
    },
  };
  return builder;
}

vi.mock('../../persistence/supabaseClient', () => ({
  supabase: {
    from: (table: string) => {
      const b = makeBuilder();
      b._state.table = table;
      return b;
    },
  },
}));

import { loadEntriesInRange } from '../loadEntries';

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('loadEntriesInRange — batching against PostgREST 1000-row cap', () => {
  beforeEach(() => { inCallLog.length = 0; });

  it('batches parent→child .in() so no single query exceeds PARENT_BATCH (50)', async () => {
    await loadEntriesInRange(
      'TIM',
      'user-1',
      new Date('2026-03-01T00:00:00'),
      new Date('2026-04-01T00:00:00'),
    );

    const parentBatches = inCallLog.filter(c => c.table === 'entries' && c.column === 'parent_entry_id');
    expect(parentBatches.length).toBeGreaterThan(1);
    for (const call of parentBatches) {
      expect(call.size).toBeLessThanOrEqual(50);
    }
  });

  it('batches child→attribute_entries .in() so no single query exceeds CHILD_BATCH (500)', async () => {
    await loadEntriesInRange(
      'TIM',
      'user-1',
      new Date('2026-03-01T00:00:00'),
      new Date('2026-04-01T00:00:00'),
    );

    const attrBatches = inCallLog.filter(c => c.table === 'attribute_entries' && c.column === 'entry_id');
    expect(attrBatches.length).toBeGreaterThan(1);
    for (const call of attrBatches) {
      expect(call.size).toBeLessThanOrEqual(500);
    }
  });

  it('returns every parent entry with time_init, time_end, and time_type intact — even when the unbatched total would exceed the simulated cap', async () => {
    // Unbatched, the attribute_entries query would return all 1200 rows in one
    // call and get capped at 600 — losing half of the time_init/time_end data.
    // With batching, each of the 3 batches returns ≤500 rows (under cap).
    const entries = await loadEntriesInRange(
      'TIM',
      'user-1',
      new Date('2026-03-01T00:00:00'),
      new Date('2026-04-01T00:00:00'),
    );

    expect(entries).toHaveLength(PARENT_COUNT);

    let withTimeInit = 0;
    let withTimeEnd  = 0;
    let withTimeType = 0;
    for (const e of entries) {
      if (e.attributes.get('time_init') === 540) withTimeInit++;
      if (e.attributes.get('time_end')  === 570) withTimeEnd++;
      if (e.timeValues && e.timeValues.get('t') === 30) withTimeType++;
    }
    expect(withTimeInit).toBe(PARENT_COUNT);
    expect(withTimeEnd).toBe(PARENT_COUNT);
    expect(withTimeType).toBe(PARENT_COUNT);
  });
});
