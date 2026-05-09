/**
 * Executor pure-logic tests.
 *
 * We test the exported helper functions directly, bypassing loadEntries()
 * (which requires Supabase).  This covers the core computation semantics
 * without any I/O.
 */

import { describe, it, expect } from 'vitest';
import {
  evalAggExpr,
  evalExprBool,
  groupEntries,
  parseDimTuple,
  addEmptyPeriodGroups,
  sortRowsByPeriodDim,
  applyTopk,
  type EntryRecord,
} from '../executor';
import type {
  Expr, PeriodDimension, TopkDimension, IntermediateRow,
} from '../ast';
import type { WidgetConfig } from '../types';

// ─────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────

function makeEntry(overrides: Partial<EntryRecord> = {}): EntryRecord {
  return {
    id: 1,
    timestamp: new Date('2026-03-11T10:00:00Z'),
    subdivision: null,
    parentId: null,
    definitionCode: 'TIM',
    attrs: {},
    timeLabels: {},
    ...overrides,
  };
}

// AST helper builders
const lit = (v: number): Expr => ({ kind: 'literal', value: v });
const path = (...names: string[]): Expr => ({
  kind: 'path',
  segments: names.map(n => n === 'parent'
    ? { kind: 'parent' as const }
    : { kind: 'field' as const, name: n }),
});
const call = (fn: string, arg: Expr): Expr => ({
  kind: 'call', fn, args: [arg], namedArgs: {},
});
const binary = (op: string, left: Expr, right: Expr): Expr => ({
  kind: 'binary', op: op as any, left, right,
});
const mref = (name: string): Expr => ({ kind: 'measure_ref', name });
const timeExact = (label: string): Expr => ({
  kind: 'time',
  path: { kind: 'path', segments: [{ kind: 'field', name: 'tims' }] },
  label,
  hierarchical: false,
});

// Mon 2026-03-09 .. Mon 2026-03-16 (exclusive upper bound)
const WEEK_CONFIG: WidgetConfig = {
  userId: 'test',
  startDate: new Date(2026, 2, 9, 0, 0, 0, 0),
  endDate:   new Date(2026, 2, 16, 0, 0, 0, 0),
};

// ─────────────────────────────────────────────────────────────
// evalAggExpr — empty-group semantics
// ─────────────────────────────────────────────────────────────

describe('evalAggExpr — empty group semantics', () => {
  it('sum([]) → 0', () => {
    const result = evalAggExpr(call('sum', path('tims', 'duration')), [], 'tims', {});
    expect(result).toBe(0);
  });

  it('count([]) → 0', () => {
    const result = evalAggExpr(call('count', path('tims', 'duration')), [], 'tims', {});
    expect(result).toBe(0);
  });

  it('avg([]) → null', () => {
    const result = evalAggExpr(call('avg', path('tims', 'duration')), [], 'tims', {});
    expect(result).toBeNull();
  });

  it('min([]) → null', () => {
    const result = evalAggExpr(call('min', path('tims', 'duration')), [], 'tims', {});
    expect(result).toBeNull();
  });

  it('max([]) → null', () => {
    const result = evalAggExpr(call('max', path('tims', 'duration')), [], 'tims', {});
    expect(result).toBeNull();
  });

  it('ratio with empty groups → null via 0/0', () => {
    // productive = sum([]) = 0, total = sum([]) = 0 → 0/0 → null
    const expr = binary('/', mref('productive'), mref('total'));
    const computed = { productive: 0, total: 0 };
    const result = evalAggExpr(expr, [], 'tims', computed);
    expect(result).toBeNull();
  });

  it('ratio with data → value', () => {
    const expr = binary('/', mref('productive'), mref('total'));
    const computed = { productive: 60, total: 90 };
    const result = evalAggExpr(expr, [], 'tims', computed);
    expect(result).toBeCloseTo(0.667, 2);
  });
});

// ─────────────────────────────────────────────────────────────
// evalAggExpr — non-empty groups
// ─────────────────────────────────────────────────────────────

describe('evalAggExpr — non-empty groups', () => {
  const entries = [
    makeEntry({ id: 1, attrs: { duration: 90 } }),
    makeEntry({ id: 2, attrs: { duration: 60 } }),
    makeEntry({ id: 3, attrs: { duration: 30 } }),
  ];

  it('sum(tims.duration)', () => {
    const result = evalAggExpr(call('sum', path('tims', 'duration')), entries, 'tims', {});
    expect(result).toBe(180);
  });

  it('avg(tims.duration)', () => {
    const result = evalAggExpr(call('avg', path('tims', 'duration')), entries, 'tims', {});
    expect(result).toBe(60);
  });

  it('min(tims.duration)', () => {
    const result = evalAggExpr(call('min', path('tims', 'duration')), entries, 'tims', {});
    expect(result).toBe(30);
  });

  it('max(tims.duration)', () => {
    const result = evalAggExpr(call('max', path('tims', 'duration')), entries, 'tims', {});
    expect(result).toBe(90);
  });

  it('count()', () => {
    const result = evalAggExpr({ kind: 'call', fn: 'count', args: [], namedArgs: {} }, entries, 'tims', {});
    expect(result).toBe(3);
  });

  it('null attrs excluded from avg', () => {
    const mixed = [
      makeEntry({ id: 1, attrs: { duration: 100 } }),
      makeEntry({ id: 2, attrs: {} }),           // duration missing → null
      makeEntry({ id: 3, attrs: { duration: 200 } }),
    ];
    const result = evalAggExpr(call('avg', path('tims', 'duration')), mixed, 'tims', {});
    expect(result).toBe(150); // avg of [100, 200] only
  });

  it('time("t") exact match', () => {
    const e = makeEntry({ id: 1, timeLabels: { t: 90, m: 30 } });
    const result = evalAggExpr(call('sum', timeExact('t')), [e], 'tims', {});
    expect(result).toBe(90);
  });

  it('time("t") sums across multiple entries', () => {
    const e1 = makeEntry({ id: 1, timeLabels: { t: 90 } });
    const e2 = makeEntry({ id: 2, timeLabels: { t: 60 } });
    const result = evalAggExpr(call('sum', timeExact('t')), [e1, e2], 'tims', {});
    expect(result).toBe(150);
  });
});

// ─────────────────────────────────────────────────────────────
// evalExprBool — WHERE filtering
// ─────────────────────────────────────────────────────────────

describe('evalExprBool — WHERE clause', () => {
  const e = makeEntry({
    attrs: { duration: 90, project: 'Alpha' },
    parent: { id: 99, subdivision: 'm/thk', definitionCode: 'EST', attrs: { project: 'Alpha' } },
  });

  it('path in literal array', () => {
    const expr: Expr = {
      kind: 'in',
      expr: path('tims', 'parent', 'code'),
      values: [{ kind: 'literal', value: 'EST' }],
      negated: false,
    };
    // Note: .code resolves to definitionCode on parent
    expect(evalExprBool(expr, e, 'tims', {})).toBe(true);
  });

  it('path in array — no match', () => {
    const expr: Expr = {
      kind: 'in',
      expr: path('tims', 'parent', 'code'),
      values: [{ kind: 'literal', value: 'READ' }],
      negated: false,
    };
    expect(evalExprBool(expr, e, 'tims', {})).toBe(false);
  });

  it('path not in array', () => {
    const expr: Expr = {
      kind: 'in',
      expr: path('tims', 'parent', 'code'),
      values: [{ kind: 'literal', value: 'READ' }],
      negated: true,
    };
    expect(evalExprBool(expr, e, 'tims', {})).toBe(true);
  });

  it('UNDER prefix match', () => {
    const expr: Expr = {
      kind: 'under',
      expr: path('tims', 'parent', 'subdivision'),
      prefix: 'm',
      negated: false,
    };
    expect(evalExprBool(expr, e, 'tims', {})).toBe(true);
  });

  it('UNDER exact match (no slash)', () => {
    const expr: Expr = {
      kind: 'under',
      expr: path('tims', 'parent', 'subdivision'),
      prefix: 'm/thk',
      negated: false,
    };
    expect(evalExprBool(expr, e, 'tims', {})).toBe(true);
  });

  it('UNDER does not match sibling prefix', () => {
    const expr: Expr = {
      kind: 'under',
      expr: path('tims', 'parent', 'subdivision'),
      prefix: 'mm',
      negated: false,
    };
    // "m/thk" does NOT start with "mm/"
    expect(evalExprBool(expr, e, 'tims', {})).toBe(false);
  });

  it('NOT UNDER', () => {
    const expr: Expr = {
      kind: 'under',
      expr: path('tims', 'parent', 'subdivision'),
      prefix: 'x',
      negated: true,
    };
    expect(evalExprBool(expr, e, 'tims', {})).toBe(true);
  });

  it('numeric comparison >', () => {
    const expr: Expr = binary('>', path('tims', 'duration'), lit(50));
    expect(evalExprBool(expr, e, 'tims', {})).toBe(true);
  });

  it('numeric comparison <= false', () => {
    const expr: Expr = binary('<=', path('tims', 'duration'), lit(50));
    expect(evalExprBool(expr, e, 'tims', {})).toBe(false);
  });

  it('AND short-circuits', () => {
    const alwaysTrue  = binary('>', path('tims', 'duration'), lit(0));
    const alwaysFalse = binary('<', path('tims', 'duration'), lit(0));
    expect(evalExprBool(binary('and', alwaysTrue, alwaysFalse) as Expr, e, 'tims', {})).toBe(false);
    expect(evalExprBool(binary('or',  alwaysTrue, alwaysFalse) as Expr, e, 'tims', {})).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────
// groupEntries + parseDimTuple
// ─────────────────────────────────────────────────────────────

describe('groupEntries / parseDimTuple', () => {
  const e1 = makeEntry({ id: 1 });
  const e2 = makeEntry({ id: 2 });

  it('single group when no dims', () => {
    const dimKeys = new Map([[1, {}], [2, {}]]);
    const groups = groupEntries([e1, e2], dimKeys, []);
    expect(groups.has('__all__')).toBe(true);
    expect(groups.get('__all__')!).toHaveLength(2);
  });

  it('separate groups for distinct dim values', () => {
    const dimKeys = new Map([
      [1, { x: '2026-03-09' }],
      [2, { x: '2026-03-10' }],
    ]);
    const groups = groupEntries([e1, e2], dimKeys, ['x']);
    expect(groups.size).toBe(2);
    expect(groups.get('2026-03-09')![0]).toBe(e1);
    expect(groups.get('2026-03-10')![0]).toBe(e2);
  });

  it('groups same dim value together', () => {
    const e3 = makeEntry({ id: 3 });
    const dimKeys = new Map([
      [1, { x: '2026-03-09' }],
      [2, { x: '2026-03-09' }],
      [3, { x: '2026-03-10' }],
    ]);
    const groups = groupEntries([e1, e2, e3], dimKeys, ['x']);
    expect(groups.get('2026-03-09')!).toHaveLength(2);
    expect(groups.get('2026-03-10')!).toHaveLength(1);
  });

  it('parseDimTuple decodes keys back to record', () => {
    const record = parseDimTuple('Alpha\x012026-03-09', ['project', 'x']);
    expect(record).toEqual({ project: 'Alpha', x: '2026-03-09' });
  });

  it('parseDimTuple handles null encoding', () => {
    const record = parseDimTuple('\x00null\x012026-03-09', ['project', 'x']);
    expect(record).toEqual({ project: null, x: '2026-03-09' });
  });

  it('parseDimTuple returns empty record for __all__', () => {
    expect(parseDimTuple('__all__', ['x'])).toEqual({});
  });
});

// ─────────────────────────────────────────────────────────────
// addEmptyPeriodGroups — bucket filling
// ─────────────────────────────────────────────────────────────

describe('addEmptyPeriodGroups', () => {
  const periodDim: PeriodDimension = { kind: 'period', name: 'x', periodType: 'day' };

  it('fills missing day buckets for single period dim', () => {
    // One entry on Monday; expect all 7 days of the week to be in groups
    const groups = new Map<string, EntryRecord[]>([
      ['2026-03-09', [makeEntry({ id: 1 })]],
    ]);
    addEmptyPeriodGroups(groups, [periodDim], ['x'], WEEK_CONFIG);
    // Mon 03-09 through Sun 03-15 = 7 keys
    expect(groups.size).toBe(7);
    expect(groups.get('2026-03-10')).toEqual([]);
    expect(groups.get('2026-03-15')).toEqual([]);
  });

  it('does not overwrite existing groups', () => {
    const entry = makeEntry({ id: 1 });
    const groups = new Map<string, EntryRecord[]>([
      ['2026-03-09', [entry]],
    ]);
    addEmptyPeriodGroups(groups, [periodDim], ['x'], WEEK_CONFIG);
    expect(groups.get('2026-03-09')).toEqual([entry]); // unchanged
  });

  it('no-op when no period dims', () => {
    const groups = new Map<string, EntryRecord[]>([['Alpha', [makeEntry()]]]);
    addEmptyPeriodGroups(groups, [], ['project'], WEEK_CONFIG);
    expect(groups.size).toBe(1); // unchanged
  });

  it('fills per non-period context (multi-dim)', () => {
    // Two projects; Alpha only has Monday, Beta only has Wednesday
    const allDimKeys = ['project', 'x'];
    const groups = new Map<string, EntryRecord[]>([
      ['Alpha\x012026-03-09', [makeEntry({ id: 1 })]],
      ['Beta\x012026-03-11',  [makeEntry({ id: 2 })]],
    ]);
    addEmptyPeriodGroups(groups, [periodDim], allDimKeys, WEEK_CONFIG);

    // 2 projects × 7 days = 14 groups
    expect(groups.size).toBe(14);
    // Alpha gets all 7 days
    expect(groups.has('Alpha\x012026-03-10')).toBe(true);
    expect(groups.get('Alpha\x012026-03-10')).toEqual([]);
    // Beta gets all 7 days
    expect(groups.has('Beta\x012026-03-09')).toBe(true);
    expect(groups.get('Beta\x012026-03-09')).toEqual([]);
    // Original entries preserved
    expect(groups.get('Alpha\x012026-03-09')).toHaveLength(1);
    expect(groups.get('Beta\x012026-03-11')).toHaveLength(1);
  });

  it('injects all buckets even when groups is empty (only period dim)', () => {
    const groups = new Map<string, EntryRecord[]>();
    addEmptyPeriodGroups(groups, [periodDim], ['x'], WEEK_CONFIG);
    expect(groups.size).toBe(7);
    for (const g of groups.values()) expect(g).toEqual([]);
  });

  it('does not inject contexts for projects not in data', () => {
    // Only ProjectA in data; ProjectC not present — should NOT appear after filling
    const groups = new Map<string, EntryRecord[]>([
      ['ProjectA\x012026-03-09', [makeEntry()]],
    ]);
    addEmptyPeriodGroups(groups, [periodDim], ['project', 'x'], WEEK_CONFIG);
    const keys = [...groups.keys()];
    expect(keys.every(k => k.startsWith('ProjectA'))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────
// sortRowsByPeriodDim
// ─────────────────────────────────────────────────────────────

describe('sortRowsByPeriodDim', () => {
  const periodDim: PeriodDimension = { kind: 'period', name: 'x', periodType: 'day' };

  it('sorts rows chronologically', () => {
    const rows: IntermediateRow[] = [
      { x: '2026-03-11', v: 60 },
      { x: '2026-03-09', v: 90 },
      { x: '2026-03-10', v: 0  },
    ];
    const sorted = sortRowsByPeriodDim(rows, [periodDim]);
    expect(sorted.map(r => r.x)).toEqual(['2026-03-09', '2026-03-10', '2026-03-11']);
  });

  it('no-op when no period dims', () => {
    const rows: IntermediateRow[] = [{ project: 'B', v: 1 }, { project: 'A', v: 2 }];
    const sorted = sortRowsByPeriodDim(rows, []);
    expect(sorted[0].project).toBe('B'); // order unchanged
  });

  it('does not mutate input array', () => {
    const rows: IntermediateRow[] = [
      { x: '2026-03-11' }, { x: '2026-03-09' },
    ];
    const sorted = sortRowsByPeriodDim(rows, [periodDim]);
    expect(rows[0].x).toBe('2026-03-11'); // original unchanged
    expect(sorted[0].x).toBe('2026-03-09');
  });
});

// ─────────────────────────────────────────────────────────────
// applyTopk
// ─────────────────────────────────────────────────────────────

describe('applyTopk', () => {
  function topkDim(k: number, byMeasure: string): TopkDimension {
    return {
      kind: 'topk', name: 'project', k,
      path: { kind: 'path', segments: [{ kind: 'field', name: 'tims' }, { kind: 'parent' }, { kind: 'field', name: 'project' }] },
      by: { kind: 'measure_ref', name: byMeasure },
    };
  }

  const rows: IntermediateRow[] = [
    { project: 'Alpha', x: '2026-03-09', productive: 90  },
    { project: 'Alpha', x: '2026-03-10', productive: 0   },
    { project: 'Beta',  x: '2026-03-09', productive: 30  },
    { project: 'Beta',  x: '2026-03-10', productive: 120 },
    { project: 'Gamma', x: '2026-03-09', productive: 45  },
    { project: 'Gamma', x: '2026-03-10', productive: 30  },
  ];
  // Totals: Alpha=90, Beta=150, Gamma=75  → ranked: Beta(150) > Alpha(90) > Gamma(75)

  it('keeps top 2 by measure total', () => {
    const result = applyTopk(rows, topkDim(2, 'productive'));
    const projects = [...new Set(result.map(r => r.project))].sort();
    expect(projects).toEqual(['Alpha', 'Beta']);
  });

  it('keeps all when k >= distinct count', () => {
    const result = applyTopk(rows, topkDim(5, 'productive'));
    expect(result).toHaveLength(rows.length);
  });

  it('retains all rows for surviving dim values (period rows intact)', () => {
    const result = applyTopk(rows, topkDim(2, 'productive'));
    // Beta has 2 rows (Mon + Tue), Alpha has 2 rows
    expect(result.filter(r => r.project === 'Beta')).toHaveLength(2);
    expect(result.filter(r => r.project === 'Alpha')).toHaveLength(2);
  });

  it('deterministic tie-breaking: alpha ascending on equal totals', () => {
    // Alpha and Zulu both total 100; Bravo totals 50.
    // k=2: should pick Alpha and Zulu deterministically (both > Bravo)
    // Between Alpha and Zulu, both qualify so order among top-2 doesn't matter —
    // what matters is that Bravo is excluded and Alpha is preferred over Zulu
    // only if they tie AND Bravo is in conflict.
    //
    // More precisely: Alpha(100) ties with Zulu(100).  Both beat Bravo(50).
    // k=2 → Alpha and Zulu both included.  Verifies stability.
    const tieRows: IntermediateRow[] = [
      { project: 'Zulu',  productive: 100 },
      { project: 'Alpha', productive: 100 },
      { project: 'Bravo', productive: 50  },
    ];
    const result1 = applyTopk(tieRows, topkDim(2, 'productive'));
    const result2 = applyTopk([...tieRows].reverse(), topkDim(2, 'productive'));
    const p1 = [...new Set(result1.map(r => r.project))].sort();
    const p2 = [...new Set(result2.map(r => r.project))].sort();
    expect(p1).toEqual(['Alpha', 'Zulu']);
    expect(p2).toEqual(['Alpha', 'Zulu']);
  });

  it('tie-breaking: smaller string wins when k cuts in the middle of a tie', () => {
    // Three projects all total 100; k=2 → pick top 2.
    // After primary sort (equal), secondary is string asc: Alpha < Beta < Gamma.
    // So Alpha and Beta should win.
    const tieRows: IntermediateRow[] = [
      { project: 'Gamma', productive: 100 },
      { project: 'Alpha', productive: 100 },
      { project: 'Beta',  productive: 100 },
    ];
    const result = applyTopk(tieRows, topkDim(2, 'productive'));
    const projects = [...new Set(result.map(r => r.project))].sort();
    expect(projects).toEqual(['Alpha', 'Beta']);
  });

  it('excludes dim values with all-null measure', () => {
    const nullRows: IntermediateRow[] = [
      { project: 'Alpha', productive: 90   },
      { project: 'Ghost', productive: null },  // always null — excluded from ranking
    ];
    const result = applyTopk(nullRows, topkDim(2, 'productive'));
    expect(result.every(r => r.project !== 'Ghost')).toBe(true);
  });

  it('no-op when by measure not found', () => {
    // Should not crash; returns all rows
    const result = applyTopk(rows, topkDim(2, 'nonexistent'));
    expect(result).toHaveLength(rows.length);
  });

  it('topk without period dimension: single row per project', () => {
    const singleRows: IntermediateRow[] = [
      { project: 'Alpha', productive: 90  },
      { project: 'Beta',  productive: 150 },
      { project: 'Gamma', productive: 75  },
    ];
    const result = applyTopk(singleRows, topkDim(2, 'productive'));
    const projects = [...new Set(result.map(r => r.project))].sort();
    expect(projects).toEqual(['Alpha', 'Beta']);
  });
});
