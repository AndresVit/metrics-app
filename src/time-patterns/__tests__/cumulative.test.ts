import { describe, it, expect } from 'vitest';
import { buildCumulativeMatrix } from '../cumulative';
import type { IntradayMatrix, BucketAggregate, Stripe, ColumnSpec } from '../types';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeStripes(count: number): Stripe[] {
  return Array.from({ length: count }, (_, i) => ({
    index: i,
    startMinute: i * 60,
    endMinute: (i + 1) * 60,
    label: `${String(i).padStart(2, '0')}:00`,
  }));
}

function makeColumns(ids: string[]): ColumnSpec[] {
  return ids.map((id, i) => ({
    kind: 'weekday-average' as const,
    id,
    label: id,
    weekday: ((i + 1) % 7) as 0 | 1 | 2 | 3 | 4 | 5 | 6,
  }));
}

function makeCell(
  stripeIndex: number,
  columnId: string,
  duration: number,
  labels: Record<string, number> = {},
): BucketAggregate {
  return {
    stripeIndex,
    columnId,
    totalDurationMinutes: duration,
    timeLabels: labels,
    fragmentCount: 1,
  };
}

function makeMatrix(
  stripeCount: number,
  columnIds: string[],
  cells: Map<string, BucketAggregate>,
): IntradayMatrix {
  return {
    stripes: makeStripes(stripeCount),
    columns: makeColumns(columnIds),
    columnDenominators: Object.fromEntries(columnIds.map(id => [id, 4])),
    cells,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('buildCumulativeMatrix – structure', () => {
  it('empty matrix → empty cells, structure references preserved', () => {
    const m = makeMatrix(3, ['col-a'], new Map());
    const cum = buildCumulativeMatrix(m);

    expect(cum.cells.size).toBe(0);
    expect(cum.stripes).toBe(m.stripes);
    expect(cum.columns).toBe(m.columns);
    expect(cum.columnDenominators).toBe(m.columnDenominators);
  });

  it('denominators are always preserved unchanged', () => {
    const cells = new Map([['0:col-a', makeCell(0, 'col-a', 60)]]);
    const m = makeMatrix(2, ['col-a'], cells);
    const cum = buildCumulativeMatrix(m);

    expect(cum.columnDenominators).toBe(m.columnDenominators);
    expect(cum.columnDenominators['col-a']).toBe(4);
  });
});

describe('buildCumulativeMatrix – single column accumulation', () => {
  it('single non-zero cell at stripe 1: nothing emitted before it, carry-forward after', () => {
    const cells = new Map([
      ['1:col-a', makeCell(1, 'col-a', 60, { t: 45 })],
    ]);
    const m = makeMatrix(3, ['col-a'], cells);
    const cum = buildCumulativeMatrix(m);

    // stripe 0: no data yet → not emitted
    expect(cum.cells.get('0:col-a')).toBeUndefined();
    // stripe 1: same as raw (first data point)
    expect(cum.cells.get('1:col-a')?.totalDurationMinutes).toBe(60);
    expect(cum.cells.get('1:col-a')?.timeLabels).toEqual({ t: 45 });
    // stripe 2: carry-forward (no new data, but running total is still 60)
    expect(cum.cells.get('2:col-a')?.totalDurationMinutes).toBe(60);
    expect(cum.cells.get('2:col-a')?.timeLabels).toEqual({ t: 45 });
  });

  it('running totals sum correctly across all stripes', () => {
    const cells = new Map([
      ['0:col-a', makeCell(0, 'col-a', 30, { t: 20 })],
      ['1:col-a', makeCell(1, 'col-a', 45, { t: 30, m: 15 })],
      ['2:col-a', makeCell(2, 'col-a', 15, { t: 10 })],
    ]);
    const m = makeMatrix(3, ['col-a'], cells);
    const cum = buildCumulativeMatrix(m);

    expect(cum.cells.get('0:col-a')?.totalDurationMinutes).toBe(30);
    expect(cum.cells.get('0:col-a')?.timeLabels).toEqual({ t: 20 });

    expect(cum.cells.get('1:col-a')?.totalDurationMinutes).toBe(75);
    expect(cum.cells.get('1:col-a')?.timeLabels).toEqual({ t: 50, m: 15 });

    expect(cum.cells.get('2:col-a')?.totalDurationMinutes).toBe(90);
    expect(cum.cells.get('2:col-a')?.timeLabels).toEqual({ t: 60, m: 15 });
  });

  it('fragmentCount accumulates', () => {
    const cells = new Map([
      ['0:col-a', makeCell(0, 'col-a', 30)],
      ['1:col-a', makeCell(1, 'col-a', 30)],
      ['2:col-a', makeCell(2, 'col-a', 30)],
    ]);
    const m = makeMatrix(3, ['col-a'], cells);
    const cum = buildCumulativeMatrix(m);

    expect(cum.cells.get('0:col-a')?.fragmentCount).toBe(1);
    expect(cum.cells.get('1:col-a')?.fragmentCount).toBe(2);
    expect(cum.cells.get('2:col-a')?.fragmentCount).toBe(3);
  });
});

describe('buildCumulativeMatrix – sparse matrix', () => {
  it('missing cell treated as zero — total carries forward unchanged', () => {
    //   stripe 0: 40 min
    //   stripe 1: (missing)
    //   stripe 2: 20 min
    const cells = new Map([
      ['0:col-a', makeCell(0, 'col-a', 40)],
      ['2:col-a', makeCell(2, 'col-a', 20)],
    ]);
    const m = makeMatrix(3, ['col-a'], cells);
    const cum = buildCumulativeMatrix(m);

    expect(cum.cells.get('0:col-a')?.totalDurationMinutes).toBe(40);
    expect(cum.cells.get('1:col-a')?.totalDurationMinutes).toBe(40); // carry-forward
    expect(cum.cells.get('2:col-a')?.totalDurationMinutes).toBe(60);
  });

  it('all cells missing → no cells emitted', () => {
    const m = makeMatrix(4, ['col-a'], new Map());
    const cum = buildCumulativeMatrix(m);
    expect(cum.cells.size).toBe(0);
  });

  it('only last stripe has data → first N-1 stripes not emitted, last emitted', () => {
    const cells = new Map([
      ['3:col-a', makeCell(3, 'col-a', 50)],
    ]);
    const m = makeMatrix(4, ['col-a'], cells);
    const cum = buildCumulativeMatrix(m);

    expect(cum.cells.get('0:col-a')).toBeUndefined();
    expect(cum.cells.get('1:col-a')).toBeUndefined();
    expect(cum.cells.get('2:col-a')).toBeUndefined();
    expect(cum.cells.get('3:col-a')?.totalDurationMinutes).toBe(50);
  });
});

describe('buildCumulativeMatrix – multiple columns are independent', () => {
  it('col-a and col-b accumulate separately', () => {
    const cells = new Map([
      ['0:col-a', makeCell(0, 'col-a', 60)],
      ['0:col-b', makeCell(0, 'col-b', 10)],
      ['1:col-a', makeCell(1, 'col-a', 30)],
      // col-b stripe 1 missing
    ]);
    const m = makeMatrix(2, ['col-a', 'col-b'], cells);
    const cum = buildCumulativeMatrix(m);

    expect(cum.cells.get('0:col-a')?.totalDurationMinutes).toBe(60);
    expect(cum.cells.get('1:col-a')?.totalDurationMinutes).toBe(90);

    expect(cum.cells.get('0:col-b')?.totalDurationMinutes).toBe(10);
    expect(cum.cells.get('1:col-b')?.totalDurationMinutes).toBe(10); // carry, no col-b data at stripe 1
  });

  it('cells for different columns do not interfere with each other', () => {
    const cells = new Map([
      ['0:col-a', makeCell(0, 'col-a', 100, { t: 80 })],
      ['0:col-b', makeCell(0, 'col-b', 50,  { t: 30 })],
    ]);
    const m = makeMatrix(1, ['col-a', 'col-b'], cells);
    const cum = buildCumulativeMatrix(m);

    expect(cum.cells.get('0:col-a')?.totalDurationMinutes).toBe(100);
    expect(cum.cells.get('0:col-b')?.totalDurationMinutes).toBe(50);
    expect(cum.cells.get('0:col-a')?.timeLabels).toEqual({ t: 80 });
    expect(cum.cells.get('0:col-b')?.timeLabels).toEqual({ t: 30 });
  });
});

describe('buildCumulativeMatrix – cell snapshot isolation', () => {
  it('emitted cells are independent snapshots (later stripes do not mutate earlier ones)', () => {
    const cells = new Map([
      ['0:col-a', makeCell(0, 'col-a', 30, { t: 20 })],
      ['1:col-a', makeCell(1, 'col-a', 30, { m: 10 })],
    ]);
    const m = makeMatrix(2, ['col-a'], cells);
    const cum = buildCumulativeMatrix(m);

    // stripe 0 emitted first — must not be mutated when stripe 1 is processed
    const cell0 = cum.cells.get('0:col-a');
    const cell1 = cum.cells.get('1:col-a');

    expect(cell0?.timeLabels).toEqual({ t: 20 });
    expect(cell1?.timeLabels).toEqual({ t: 20, m: 10 });
    // confirm they are different objects
    expect(cell0?.timeLabels).not.toBe(cell1?.timeLabels);
  });
});
