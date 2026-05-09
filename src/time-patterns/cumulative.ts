import type { IntradayMatrix, BucketAggregate } from './types';

/**
 * Transform an IntradayMatrix into its cumulative equivalent.
 *
 * For each column independently, the value at stripe i becomes the sum of all
 * raw aggregate values from stripe 0 through stripe i.
 *
 * Semantics:
 * - stripes and columns arrays are shared by reference (unchanged)
 * - columnDenominators are shared by reference (unchanged — denominator is a
 *   column-level concept, not affected by cumulation)
 * - missing cells (sparse matrix) are treated as zero
 * - a cumulative cell is only emitted once any data has accumulated (cumDuration > 0),
 *   then continues to be emitted for all subsequent stripes (carry-forward)
 * - each emitted cell is a fresh object with a snapshot of the running totals
 *
 * The returned matrix can be passed directly to IntradayHeatmap and processed
 * with resolveMetricValue / formatMinutes as usual.
 */
export function buildCumulativeMatrix(matrix: IntradayMatrix): IntradayMatrix {
  const cells = new Map<string, BucketAggregate>();

  for (const col of matrix.columns) {
    let cumDuration = 0;
    const cumLabels: Record<string, number> = {};
    let cumFragments = 0;

    for (const stripe of matrix.stripes) {
      const key = `${stripe.index}:${col.id}`;
      const cell = matrix.cells.get(key);

      if (cell) {
        cumDuration += cell.totalDurationMinutes;
        for (const [label, val] of Object.entries(cell.timeLabels)) {
          cumLabels[label] = (cumLabels[label] ?? 0) + val;
        }
        cumFragments += cell.fragmentCount;
      }

      // Only emit once any data has been seen for this column.
      // Carry-forward: even if this stripe had no new data, the running total
      // from earlier stripes is still the correct cumulative value.
      if (cumDuration > 0) {
        cells.set(key, {
          stripeIndex: stripe.index,
          columnId: col.id,
          totalDurationMinutes: cumDuration,
          timeLabels: { ...cumLabels }, // snapshot — further mutations don't affect this cell
          fragmentCount: cumFragments,
        });
      }
    }
  }

  return {
    stripes: matrix.stripes,
    columns: matrix.columns,
    columnDenominators: matrix.columnDenominators,
    cells,
  };
}

/**
 * Transform an IntradayMatrix into cumulative-week form.
 *
 * Weekday columns (those whose id appears in weekdayColumnIds, in Mon→Sun order):
 *   - cumulative down stripes within the column
 *   - PLUS a carry from the previous weekday column's final stripe value
 *   - result: Mon[stripe i] = cumulative Mon data up to stripe i
 *             Tue[stripe i] = Mon_total + cumulative Tue data up to stripe i
 *             Sun[last]     = full week total
 *
 * Non-weekday columns (avg-week, avg-month, avg-total, etc.):
 *   - regular per-column cumulative (same as buildCumulativeMatrix)
 *   - no cross-column carry
 *
 * weekdayColumnIds must be the Mon→Sun subset of matrix.columns[].id in order.
 * Columns not present in the matrix are silently skipped.
 */
export function buildCumulativeWeekMatrix(
  matrix: IntradayMatrix,
  weekdayColumnIds: string[],
): IntradayMatrix {
  const cells = new Map<string, BucketAggregate>();
  const weekdayIdSet = new Set(weekdayColumnIds);

  // ── Weekday columns: cumulative down + carry across ────────────────────────
  let carryDuration = 0;
  const carryLabels: Record<string, number> = {};
  let carryFragments = 0;

  for (const colId of weekdayColumnIds) {
    if (!matrix.columns.find(c => c.id === colId)) continue; // not in this matrix

    let runDuration = 0;
    const runLabels: Record<string, number> = {};
    let runFragments = 0;
    // Track this column's raw total to accumulate into the carry.
    let colRawDuration = 0;
    const colRawLabels: Record<string, number> = {};
    let colRawFragments = 0;

    for (const stripe of matrix.stripes) {
      const key = `${stripe.index}:${colId}`;
      const cell = matrix.cells.get(key);

      if (cell) {
        runDuration += cell.totalDurationMinutes;
        colRawDuration += cell.totalDurationMinutes;
        for (const [label, val] of Object.entries(cell.timeLabels)) {
          runLabels[label] = (runLabels[label] ?? 0) + val;
          colRawLabels[label] = (colRawLabels[label] ?? 0) + val;
        }
        runFragments += cell.fragmentCount;
        colRawFragments += cell.fragmentCount;
      }

      const emitDuration = carryDuration + runDuration;
      if (emitDuration > 0) {
        const emitLabels: Record<string, number> = {};
        for (const [label, val] of Object.entries(carryLabels)) {
          emitLabels[label] = val;
        }
        for (const [label, val] of Object.entries(runLabels)) {
          emitLabels[label] = (emitLabels[label] ?? 0) + val;
        }
        cells.set(key, {
          stripeIndex: stripe.index,
          columnId: colId,
          totalDurationMinutes: emitDuration,
          timeLabels: emitLabels,
          fragmentCount: carryFragments + runFragments,
        });
      }
    }

    // Update carry with this column's raw total
    carryDuration += colRawDuration;
    for (const [label, val] of Object.entries(colRawLabels)) {
      carryLabels[label] = (carryLabels[label] ?? 0) + val;
    }
    carryFragments += colRawFragments;
  }

  // ── Avg columns: regular per-column cumulative (no cross-column carry) ─────
  for (const col of matrix.columns) {
    if (weekdayIdSet.has(col.id)) continue;

    let cumDuration = 0;
    const cumLabels: Record<string, number> = {};
    let cumFragments = 0;

    for (const stripe of matrix.stripes) {
      const key = `${stripe.index}:${col.id}`;
      const cell = matrix.cells.get(key);

      if (cell) {
        cumDuration += cell.totalDurationMinutes;
        for (const [label, val] of Object.entries(cell.timeLabels)) {
          cumLabels[label] = (cumLabels[label] ?? 0) + val;
        }
        cumFragments += cell.fragmentCount;
      }

      if (cumDuration > 0) {
        cells.set(key, {
          stripeIndex: stripe.index,
          columnId: col.id,
          totalDurationMinutes: cumDuration,
          timeLabels: { ...cumLabels },
          fragmentCount: cumFragments,
        });
      }
    }
  }

  return {
    stripes: matrix.stripes,
    columns: matrix.columns,
    columnDenominators: matrix.columnDenominators,
    cells,
  };
}

