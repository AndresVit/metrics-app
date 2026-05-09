import { describe, it, expect } from 'vitest';
import { buildStripes, splitTiming } from '../stripeEngine';
import type { StripeConfig, RawTiming } from '../types';

// Standard 60-minute layout starting at 05:00
const STD_CONFIG: StripeConfig = { startMinute: 300, sizeMinutes: 60 };

describe('buildStripes', () => {
  it('generates 24 stripes for 60-min layout', () => {
    const stripes = buildStripes(STD_CONFIG);
    expect(stripes).toHaveLength(24);
  });

  it('first stripe starts at 05:00', () => {
    const stripes = buildStripes(STD_CONFIG);
    expect(stripes[0].startMinute).toBe(300);
    expect(stripes[0].endMinute).toBe(360);
    expect(stripes[0].label).toBe('05:00');
  });

  it('stripe 19 represents 00:00–01:00 of the next calendar day', () => {
    const stripes = buildStripes(STD_CONFIG);
    const s = stripes[19];
    expect(s.startMinute).toBe(1440); // 300 + 19*60
    expect(s.endMinute).toBe(1500);
    expect(s.label).toBe('00:00'); // normalised to [0,1440)
  });

  it('last stripe (23) ends at 1740 (05:00 of next day, closing the analytical day)', () => {
    const stripes = buildStripes(STD_CONFIG);
    const last = stripes[23];
    expect(last.startMinute).toBe(1680);
    expect(last.endMinute).toBe(1740);
    expect(last.label).toBe('04:00');
  });

  it('count override (4 stripes of 60 min) generates exactly 4 stripes', () => {
    const stripes = buildStripes({ startMinute: 300, sizeMinutes: 60, count: 4 });
    expect(stripes).toHaveLength(4);
  });

  it('120-min stripes produce 12 stripes (divides 1440 evenly, no partial)', () => {
    const stripes = buildStripes({ startMinute: 300, sizeMinutes: 120 });
    expect(stripes).toHaveLength(12);
    expect(stripes[0].endMinute - stripes[0].startMinute).toBe(120);
    expect(stripes[11].endMinute - stripes[11].startMinute).toBe(120);
  });

  it('150-min stripes: 9 full + 1 partial of 90 min covering exactly 1440 min', () => {
    // 1440 / 150 = 9 remainder 90
    const stripes = buildStripes({ startMinute: 300, sizeMinutes: 150 });
    expect(stripes).toHaveLength(10);

    // First 9 stripes are full-width
    for (let i = 0; i < 9; i++) {
      expect(stripes[i].endMinute - stripes[i].startMinute).toBe(150);
    }

    // Last stripe is shortened to the 90-min remainder
    const last = stripes[9];
    expect(last.startMinute).toBe(300 + 9 * 150); // 1650
    expect(last.endMinute).toBe(300 + 1440);       // 1740
    expect(last.endMinute - last.startMinute).toBe(90);
    expect(last.label).toBe('03:30');

    // Total coverage = exactly one analytical day
    const totalCoverage = stripes.reduce((s, st) => s + (st.endMinute - st.startMinute), 0);
    expect(totalCoverage).toBe(1440);
  });

  it('count override generates exactly that many full-width stripes (may overshoot)', () => {
    // 10 × 150 = 1500 min, which exceeds 1440 — intentional when count is explicit
    const stripes = buildStripes({ startMinute: 300, sizeMinutes: 150, count: 10 });
    expect(stripes).toHaveLength(10);
    expect(stripes[9].endMinute - stripes[9].startMinute).toBe(150); // full-width, not partial
    expect(stripes[9].endMinute).toBe(300 + 10 * 150); // 1800
  });
});

// Helper to create a minimal RawTiming where calendarDate == analyticalDate (daytime)
function makeTiming(
  timeInit: number,
  timeEnd: number,
  timeLabels: Record<string, number> = {},
  opts: { analyticalDate?: string; calendarDate?: string } = {},
): RawTiming {
  return {
    id: 1,
    calendarDate: opts.calendarDate ?? '2026-03-21',
    analyticalDate: opts.analyticalDate ?? '2026-03-21',
    timeInit,
    timeEnd,
    timeLabels,
  };
}

describe('splitTiming', () => {
  const stripes = buildStripes(STD_CONFIG);

  it('timing entirely within one stripe → single fragment', () => {
    // 10:00–10:30 → stripe 5 [600, 660)
    const frags = splitTiming(makeTiming(600, 630, { t: 30 }), stripes);
    expect(frags).toHaveLength(1);
    expect(frags[0].stripeIndex).toBe(5);
    expect(frags[0].durationMinutes).toBe(30);
    expect(frags[0].timeLabels['t']).toBeCloseTo(30);
  });

  it('design-doc example: 12:40–13:10 with t24 m6 splits proportionally', () => {
    // Stripe 7: [720, 780) = 12:00–13:00
    // Stripe 8: [780, 840) = 13:00–14:00
    const frags = splitTiming(makeTiming(760, 790, { t: 24, m: 6 }), stripes);
    expect(frags).toHaveLength(2);

    const f7 = frags.find(f => f.stripeIndex === 7)!;
    const f8 = frags.find(f => f.stripeIndex === 8)!;

    // 20 minutes in stripe 7, 10 in stripe 8 (total 30)
    expect(f7.durationMinutes).toBe(20);
    expect(f8.durationMinutes).toBe(10);

    // Labels distributed by ratio 2/3 and 1/3
    expect(f7.timeLabels['t']).toBeCloseTo(16);
    expect(f7.timeLabels['m']).toBeCloseTo(4);
    expect(f8.timeLabels['t']).toBeCloseTo(8);
    expect(f8.timeLabels['m']).toBeCloseTo(2);

    // Totals must reconstitute the original
    expect(f7.durationMinutes + f8.durationMinutes).toBe(30);
    expect((f7.timeLabels['t'] ?? 0) + (f8.timeLabels['t'] ?? 0)).toBeCloseTo(24);
    expect((f7.timeLabels['m'] ?? 0) + (f8.timeLabels['m'] ?? 0)).toBeCloseTo(6);
  });

  it('timing with no labels produces fragments with empty timeLabels', () => {
    const frags = splitTiming(makeTiming(600, 660, {}), stripes);
    expect(frags).toHaveLength(1);
    expect(frags[0].timeLabels).toEqual({});
    expect(frags[0].durationMinutes).toBe(60);
  });

  it('zero-duration timing → no fragments', () => {
    expect(splitTiming(makeTiming(600, 600), stripes)).toHaveLength(0);
  });

  it('timing spanning 3 stripes distributes correctly', () => {
    // 11:00–14:00 = 180 min across stripes 6, 7, 8
    const frags = splitTiming(makeTiming(660, 840, { t: 180 }), stripes);
    expect(frags).toHaveLength(3);
    const totalDuration = frags.reduce((s, f) => s + f.durationMinutes, 0);
    const totalT = frags.reduce((s, f) => s + (f.timeLabels['t'] ?? 0), 0);
    expect(totalDuration).toBe(180);
    expect(totalT).toBeCloseTo(180);
  });

  it('post-midnight timing (calendarDate = analyticalDate + 1 day) maps to correct stripes', () => {
    // 00:30–02:00 on calendarDate 2026-03-22, analytical day = 2026-03-21
    // Normalised: normInit = 30 + 1440 = 1470, normEnd = 120 + 1440 = 1560
    // Stripe 19: [1440, 1500) → overlap [1470, 1500) = 30 min
    // Stripe 20: [1500, 1560) → overlap [1500, 1560) = 60 min
    const timing = makeTiming(30, 120, { t: 60, m: 30 }, {
      analyticalDate: '2026-03-21',
      calendarDate: '2026-03-22',
    });
    const frags = splitTiming(timing, stripes);
    expect(frags).toHaveLength(2);

    const f19 = frags.find(f => f.stripeIndex === 19)!;
    const f20 = frags.find(f => f.stripeIndex === 20)!;

    expect(f19.durationMinutes).toBe(30);
    expect(f20.durationMinutes).toBe(60);
    expect(f19.timeLabels['t']).toBeCloseTo(20);  // 60 * 30/90
    expect(f20.timeLabels['t']).toBeCloseTo(40);  // 60 * 60/90
    expect(f19.timeLabels['m']).toBeCloseTo(10);  // 30 * 30/90
    expect(f20.timeLabels['m']).toBeCloseTo(20);  // 30 * 60/90
  });

  it('timing exactly on a stripe boundary starts in next stripe', () => {
    // 13:00–13:30: starts exactly at stripe 8's boundary [780, 840)
    const frags = splitTiming(makeTiming(780, 810), stripes);
    expect(frags).toHaveLength(1);
    expect(frags[0].stripeIndex).toBe(8);
  });

  it('prefix label key "m/thk" is preserved after split', () => {
    const frags = splitTiming(makeTiming(600, 660, { 'm/thk': 60 }), stripes);
    expect(frags[0].timeLabels['m/thk']).toBeCloseTo(60);
  });
});
