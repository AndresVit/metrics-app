import type {
  RawTiming,
  Stripe,
  ColumnSpec,
  ResolvedColumnScope,
  BucketAggregate,
  IntradayMatrix,
} from './types';
import { splitTiming } from './stripeEngine';

/**
 * Aggregate intraday data from a set of pre-fetched timings.
 *
 * Steps:
 *   1. Split every RawTiming into StripeFragments.
 *   2. Index fragments by (analyticalDate, stripeIndex).
 *   3. For each column, accumulate raw sums from the column's eligible dates.
 *
 * The caller is responsible for:
 *   - fetching timings in the correct FetchRange (use computeFetchRange)
 *   - resolving column scopes (use resolveColumnScope per column)
 *   - ensuring columns[] and columnScopes[] correspond 1-to-1 by columnId
 *
 * Cells with no contributing fragments are absent from the result map
 * (treat as 0 or null in the UI depending on the metric).
 */
export function aggregateIntraday(
  timings: RawTiming[],
  stripes: Stripe[],
  columns: ColumnSpec[],
  columnScopes: ResolvedColumnScope[],
): IntradayMatrix {
  const scopeByColumnId = new Map(columnScopes.map(s => [s.columnId, s]));

  // 1. Split all timings into fragments
  // We build a flat array first, then index it for O(1) lookup per (date, stripe).
  const fragmentIndex = new Map<string, Array<{ durationMinutes: number; timeLabels: Record<string, number> }>>();

  for (const timing of timings) {
    for (const frag of splitTiming(timing, stripes)) {
      const key = `${frag.analyticalDate}:${frag.stripeIndex}`;
      const bucket = fragmentIndex.get(key);
      if (bucket) {
        bucket.push(frag);
      } else {
        fragmentIndex.set(key, [frag]);
      }
    }
  }

  // 2. Aggregate per (column, stripe)
  const cells = new Map<string, BucketAggregate>();
  const columnDenominators: Record<string, number> = {};

  for (const col of columns) {
    const scope = scopeByColumnId.get(col.id);
    if (!scope) continue;

    columnDenominators[col.id] = scope.denominator;

    for (const stripe of stripes) {
      let totalDuration = 0;
      const timeLabels: Record<string, number> = {};
      let fragmentCount = 0;

      for (const date of scope.eligibleDates) {
        const frags = fragmentIndex.get(`${date}:${stripe.index}`);
        if (!frags) continue;

        for (const frag of frags) {
          totalDuration += frag.durationMinutes;
          for (const [label, val] of Object.entries(frag.timeLabels)) {
            timeLabels[label] = (timeLabels[label] ?? 0) + val;
          }
          fragmentCount++;
        }
      }

      if (fragmentCount > 0) {
        cells.set(`${stripe.index}:${col.id}`, {
          stripeIndex: stripe.index,
          columnId: col.id,
          totalDurationMinutes: totalDuration,
          timeLabels,
          fragmentCount,
        });
      }
    }
  }

  return { stripes, columns, columnDenominators, cells };
}
