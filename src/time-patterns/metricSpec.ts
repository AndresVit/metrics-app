import type { LabelSelector, MetricSource } from './types';

/**
 * Sum all values in timeLabels that match the given selector.
 *
 * 'exact'  – matches the label key exactly
 * 'prefix' – matches the exact key OR any key that starts with prefix + "/"
 *            (mirrors DSL timeUnder("m") which matches "m", "m/thk", "m/sw", …)
 * 'any'    – sum of all values in the record
 */
export function extractLabelValue(
  selector: LabelSelector,
  timeLabels: Record<string, number>,
): number {
  switch (selector.kind) {
    case 'exact':
      return timeLabels[selector.label] ?? 0;

    case 'prefix': {
      const { prefix } = selector;
      let sum = 0;
      for (const [key, val] of Object.entries(timeLabels)) {
        if (key === prefix || key.startsWith(`${prefix}/`)) sum += val;
      }
      return sum;
    }

    case 'multi-prefix': {
      let sum = 0;
      for (const prefix of selector.prefixes) {
        for (const [key, val] of Object.entries(timeLabels)) {
          if (key === prefix || key.startsWith(`${prefix}/`)) sum += val;
        }
      }
      return sum;
    }

    case 'any': {
      let sum = 0;
      for (const val of Object.values(timeLabels)) sum += val;
      return sum;
    }

    default: {
      const _: never = selector;
      throw new Error(`Unknown LabelSelector kind: ${JSON.stringify(_)}`);
    }
  }
}

/**
 * Extract a per-day average metric value from a raw aggregate.
 *
 * Returns null when denominator is 0 (no eligible days for this column).
 *
 * The aggregate carries raw sums; this function applies the denominator so
 * callers always receive an already-averaged value in minutes.
 */
export function resolveMetricValue(
  source: MetricSource,
  agg: { totalDurationMinutes: number; timeLabels: Record<string, number> },
  denominator: number,
): number | null {
  switch (source.kind) {
    case 'duration':
      if (denominator === 0) return null;
      return agg.totalDurationMinutes / denominator;

    case 'label':
      if (denominator === 0) return null;
      return extractLabelValue(source.selector, agg.timeLabels) / denominator;

    case 'label-ratio': {
      // Ratio of aggregated sums — the column day-count denominator is NOT used.
      const num = extractLabelValue(source.numerator, agg.timeLabels);
      const den = source.denominator === 'duration'
        ? agg.totalDurationMinutes
        : extractLabelValue(source.denominator, agg.timeLabels);
      return den === 0 ? null : num / den;
    }

    default: {
      const _: never = source;
      throw new Error(`Unknown MetricSource kind: ${JSON.stringify(_)}`);
    }
  }
}
