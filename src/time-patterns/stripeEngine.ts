import type { StripeConfig, Stripe, RawTiming, StripeFragment } from './types';
import { dateDiffDays } from './analyticalCalendar';
import { formatMinuteAsTime } from './formatDuration';

/**
 * Build the ordered list of stripes for a StripeConfig.
 * Stripes are defined as absolute minute offsets from midnight of the analytical date.
 * With startMinute=300 and sizeMinutes=60:
 *   Stripe 0 = [300, 360)  = 05:00–06:00
 *   Stripe 19= [1440,1500) = 00:00–01:00 (next calendar day)
 *   Stripe 23= [1680,1740) = 04:00–05:00 (closes the analytical day at 05:00)
 *
 * Without a count override, stripes cover exactly one analytical day (1440 minutes).
 * If sizeMinutes does not divide 1440 evenly, the last stripe is shortened to fit.
 * With a count override, exactly `count` full-width stripes are generated (may overshoot).
 */
export function buildStripes(config: StripeConfig): Stripe[] {
  const stripes: Stripe[] = [];

  if (config.count !== undefined) {
    // Explicit count: generate that many full-width stripes.
    for (let i = 0; i < config.count; i++) {
      const startMinute = config.startMinute + i * config.sizeMinutes;
      stripes.push({
        index: i,
        startMinute,
        endMinute: startMinute + config.sizeMinutes,
        label: formatMinuteAsTime(startMinute),
      });
    }
    return stripes;
  }

  // No count: cover exactly one analytical day starting at startMinute.
  // If sizeMinutes does not divide 1440, the last stripe is shortened to the remainder.
  const dayEnd = config.startMinute + 1440;
  let i = 0;
  while (true) {
    const startMinute = config.startMinute + i * config.sizeMinutes;
    if (startMinute >= dayEnd) break;
    stripes.push({
      index: i,
      startMinute,
      endMinute: Math.min(startMinute + config.sizeMinutes, dayEnd),
      label: formatMinuteAsTime(startMinute),
    });
    i++;
  }
  return stripes;
}

/**
 * Split one RawTiming into StripeFragments.
 *
 * The timing's timeInit/timeEnd are in minutes from midnight of calendarDate.
 * To compare against stripe boundaries (which are relative to the analytical
 * date's midnight), we add a day-offset correction:
 *
 *   normInit = timeInit + dateDiffDays(analyticalDate, calendarDate) × 1440
 *
 * timeLabel values are distributed proportionally to each fragment's duration.
 * Fragments with zero duration are omitted.
 */
export function splitTiming(timing: RawTiming, stripes: Stripe[]): StripeFragment[] {
  // How many calendar days ahead of analyticalDate is calendarDate?
  // (0 when same day, 1 when calendarDate = analyticalDate + 1 for early-morning timings)
  const dayOffset = dateDiffDays(timing.analyticalDate, timing.calendarDate);
  const normInit = timing.timeInit + dayOffset * 1440;
  const normEnd = timing.timeEnd + dayOffset * 1440;
  const totalDuration = normEnd - normInit;

  if (totalDuration <= 0) return [];

  const fragments: StripeFragment[] = [];

  for (const stripe of stripes) {
    const overlapStart = Math.max(normInit, stripe.startMinute);
    const overlapEnd = Math.min(normEnd, stripe.endMinute);
    if (overlapEnd <= overlapStart) continue;

    const fragmentDuration = overlapEnd - overlapStart;
    const ratio = fragmentDuration / totalDuration;

    // Distribute each label proportionally
    const timeLabels: Record<string, number> = {};
    for (const [label, minutes] of Object.entries(timing.timeLabels)) {
      timeLabels[label] = minutes * ratio;
    }

    fragments.push({
      timingId: timing.id,
      analyticalDate: timing.analyticalDate,
      stripeIndex: stripe.index,
      durationMinutes: fragmentDuration,
      timeLabels,
    });
  }

  return fragments;
}
