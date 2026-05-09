import { describe, it, expect } from 'vitest';
import { extractLabelValue, resolveMetricValue } from '../metricSpec';
import type { LabelSelector, MetricSource } from '../types';

const LABELS: Record<string, number> = {
  't':     90,
  'm':     30,
  'm/thk': 15,
  'm/sw':  10,
  'p':      5,
};

describe('extractLabelValue – exact', () => {
  const sel = (label: string): LabelSelector => ({ kind: 'exact', label });

  it('matches exact key', () => {
    expect(extractLabelValue(sel('t'), LABELS)).toBe(90);
    expect(extractLabelValue(sel('m'), LABELS)).toBe(30);
    expect(extractLabelValue(sel('m/thk'), LABELS)).toBe(15);
  });

  it('returns 0 for missing key', () => {
    expect(extractLabelValue(sel('n'), LABELS)).toBe(0);
    expect(extractLabelValue(sel('m/'), LABELS)).toBe(0);
  });

  it('exact "m" does NOT include "m/thk" or "m/sw"', () => {
    expect(extractLabelValue(sel('m'), LABELS)).toBe(30);
  });
});

describe('extractLabelValue – prefix', () => {
  const sel = (prefix: string): LabelSelector => ({ kind: 'prefix', prefix });

  it('matches exact key and all sub-keys', () => {
    // "m" should match "m", "m/thk", "m/sw"
    expect(extractLabelValue(sel('m'), LABELS)).toBe(30 + 15 + 10);
  });

  it('only matches at "/" boundaries (not partial string matches)', () => {
    // "m/thk" is a sibling of "m/t*" at the same level — "m/t" does NOT match "m/thk"
    // because the prefix rule is: key === prefix || key.startsWith(prefix + "/")
    // "m/thk".startsWith("m/t/") is false.
    expect(extractLabelValue(sel('m/t'), LABELS)).toBe(0);
    // Similarly "m/s" does not match "m/sw"
    expect(extractLabelValue(sel('m/s'), LABELS)).toBe(0);
    // But "m/thk" as an exact prefix matches itself
    expect(extractLabelValue(sel('m/thk'), LABELS)).toBe(15);
  });

  it('returns 0 for unknown prefix', () => {
    expect(extractLabelValue(sel('n'), LABELS)).toBe(0);
  });

  it('prefix "t" matches only "t" (no sub-keys present)', () => {
    expect(extractLabelValue(sel('t'), LABELS)).toBe(90);
  });
});

describe('extractLabelValue – any', () => {
  const sel: LabelSelector = { kind: 'any' };

  it('sums all values', () => {
    expect(extractLabelValue(sel, LABELS)).toBe(90 + 30 + 15 + 10 + 5);
  });

  it('empty record → 0', () => {
    expect(extractLabelValue(sel, {})).toBe(0);
  });
});

describe('resolveMetricValue', () => {
  const agg = { totalDurationMinutes: 120, timeLabels: LABELS };

  it('duration source divides by denominator', () => {
    const src: MetricSource = { kind: 'duration' };
    expect(resolveMetricValue(src, agg, 4)).toBe(30);
    expect(resolveMetricValue(src, agg, 1)).toBe(120);
  });

  it('label source applies selector then divides', () => {
    const src: MetricSource = { kind: 'label', selector: { kind: 'exact', label: 't' } };
    expect(resolveMetricValue(src, agg, 3)).toBeCloseTo(30);
  });

  it('label source with prefix divides correctly', () => {
    // sum of "m" + "m/thk" + "m/sw" = 55; denominator = 5 → 11
    const src: MetricSource = { kind: 'label', selector: { kind: 'prefix', prefix: 'm' } };
    expect(resolveMetricValue(src, agg, 5)).toBeCloseTo(11);
  });

  it('denominator = 0 → returns null', () => {
    const src: MetricSource = { kind: 'duration' };
    expect(resolveMetricValue(src, agg, 0)).toBeNull();
  });

  it('denominator = 1 → returns raw value (single-day column)', () => {
    const src: MetricSource = { kind: 'duration' };
    expect(resolveMetricValue(src, agg, 1)).toBe(120);
  });
});
