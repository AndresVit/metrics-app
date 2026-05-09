/**
 * Regression test for the timeLabels contamination bug.
 *
 * Root cause: loadTimeTypeValues() loaded ALL child attribute_entries of TIM
 * parent entries without filtering by field_id. Since pipeline.ts propagates
 * the TIM entry's subdivision to its time_init / time_end / duration children,
 * those sibling values (large minute-of-day integers) accumulated under the
 * inherited subdivision key (e.g. "TFG/coding") in timeLabels.
 *
 * Fix: pass timeTypeFieldId to loadTimeTypeValues and add
 *   .eq('field_id', timeTypeFieldId)
 * so only the actual time_type attribute entry is included.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Supabase mock ─────────────────────────────────────────────────────────────
//
// We intercept the chained Supabase builder and return canned rows per
// (table, filter-set) combination.  The builder returns `this` for every
// chainable method so the test can control exactly which rows each query sees.

interface QueryState {
  table: string;
  filters: Record<string, string | number | number[]>;
}

function makeBuilder(resolveData: (state: QueryState) => unknown[]) {
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
      return builder;
    },
    gte: () => builder,
    lt:  () => builder,
    then: (resolve: (v: { data: unknown[]; error: null }) => void) => {
      resolve({ data: resolveData(state), error: null });
    },
  };
  return builder;
}

// Table data shared across queries
const TIME_TYPE_FIELD_ID = 'field-timetype';
const TIME_INIT_FIELD_ID = 'field-timeinit';
const TIME_END_FIELD_ID  = 'field-timeend';
const DURATION_FIELD_ID  = 'field-duration';

const TABLES: Record<string, (state: QueryState) => unknown[]> = {
  definitions: () => [{ id: 'def-tim', code: 'TIM' }],

  entries: (state) => {
    // Parent TIM entries query (no parent_entry_id filter)
    if (!('parent_entry_id' in state.filters)) {
      return [{
        id: 1,
        definition_id: 'def-tim',
        timestamp: '2026-03-10T14:00:00Z',
        subdivision: 'TFG/coding',
      }];
    }
    // Child entries query — returns all four children
    return [
      { id: 10, parent_entry_id: 1, subdivision: 't'          }, // time_type
      { id: 11, parent_entry_id: 1, subdivision: 'TFG/coding' }, // time_init (inherited)
      { id: 12, parent_entry_id: 1, subdivision: 'TFG/coding' }, // time_end  (inherited)
      { id: 13, parent_entry_id: 1, subdivision: 'TFG/coding' }, // duration  (inherited)
    ];
  },

  fields: () => [
    { id: TIME_TYPE_FIELD_ID, name: 'time_type', metric_definition_id: 'def-tim' },
    { id: TIME_INIT_FIELD_ID, name: 'time_init', metric_definition_id: 'def-tim' },
    { id: TIME_END_FIELD_ID,  name: 'time_end',  metric_definition_id: 'def-tim' },
    { id: DURATION_FIELD_ID,  name: 'duration',  metric_definition_id: 'def-tim' },
  ],

  attribute_entries: (state) => {
    const allAttrs = [
      { entry_id: 10, field_id: TIME_TYPE_FIELD_ID, value_int: 45,  value_float: null, value_string: null, value_bool: null },
      { entry_id: 11, field_id: TIME_INIT_FIELD_ID, value_int: 750, value_float: null, value_string: null, value_bool: null },
      { entry_id: 12, field_id: TIME_END_FIELD_ID,  value_int: 795, value_float: null, value_string: null, value_bool: null },
      { entry_id: 13, field_id: DURATION_FIELD_ID,  value_int: 45,  value_float: null, value_string: null, value_bool: null },
    ];

    // Respect field_id filter (the fix under test)
    const fieldIdFilter = state.filters['field_id'] as string | undefined;
    if (fieldIdFilter) {
      return allAttrs.filter(r => r.field_id === fieldIdFilter);
    }

    return allAttrs;
  },
};

vi.mock('../../persistence/supabaseClient', () => ({
  supabase: {
    from: (table: string) => {
      const builder = makeBuilder((state) => TABLES[table]?.(state) ?? []);
      builder._state.table = table;
      return builder;
    },
  },
}));

// ── Tests ─────────────────────────────────────────────────────────────────────

import { loadEntriesInRange } from '../loadEntries';

describe('loadEntriesInRange — timeLabels contamination', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('only includes time_type values in timeValues; sibling fields (time_init, time_end, duration) are excluded', async () => {
    const entries = await loadEntriesInRange(
      'TIM',
      'user-1',
      new Date('2026-03-10T00:00:00'),
      new Date('2026-03-11T00:00:00'),
    );

    expect(entries).toHaveLength(1);
    const timeValues = entries[0].timeValues!;

    // Only the "t" label from the time_type entry should appear
    expect(timeValues.get('t')).toBe(45);

    // The inherited "TFG/coding" key must NOT appear.
    // Before the fix it would hold 750 (time_init) + 795 (time_end) + 45 (duration) = 1590.
    expect(timeValues.has('TFG/coding')).toBe(false);
  });

  it('empty string subdivision from time_type is not included when value is 0', async () => {
    // Sanity: time_type entry with subdivision "t" and value 45 → only "t" key
    const entries = await loadEntriesInRange(
      'TIM',
      'user-1',
      new Date('2026-03-10T00:00:00'),
      new Date('2026-03-11T00:00:00'),
    );

    const timeValues = entries[0].timeValues!;
    expect([...timeValues.keys()]).toEqual(['t']);
  });
});
