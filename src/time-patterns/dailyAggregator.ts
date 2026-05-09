import type { RawTiming, AnalysisRange, DailyAggregate, DailyMatrix } from './types';
import { analyticalDayRange } from './analyticalCalendar';

/**
 * Aggregate timings by analytical day.
 *
 * Only timings whose analyticalDate falls within analysisRange are included.
 * Dates within the range that have no timings are listed in DailyMatrix.dates
 * but are absent from DailyMatrix.byDate (the UI treats them as zero / empty cells).
 *
 * Duration is computed as (timeEnd − timeInit), which is correct regardless
 * of whether timeInit/timeEnd exceed 1440.
 *
 * This is the aggregation path for the Daily Grid view.
 * It does NOT use stripe splitting.
 */
export function aggregateDaily(timings: RawTiming[], analysisRange: AnalysisRange): DailyMatrix {
  const dates = analyticalDayRange(analysisRange.from, analysisRange.to);
  const byDate = new Map<string, DailyAggregate>();

  for (const timing of timings) {
    const date = timing.analyticalDate;
    if (date < analysisRange.from || date > analysisRange.to) continue;

    const existing = byDate.get(date) ?? {
      analyticalDate: date,
      totalDurationMinutes: 0,
      timeLabels: {} as Record<string, number>,
      timingCount: 0,
    };

    existing.totalDurationMinutes += timing.timeEnd - timing.timeInit;
    existing.timingCount++;

    for (const [label, val] of Object.entries(timing.timeLabels)) {
      existing.timeLabels[label] = (existing.timeLabels[label] ?? 0) + val;
    }

    byDate.set(date, existing);
  }

  return { dates, byDate };
}
