import type { AnalyticalDate, CalendarDate, AnalysisRange, AnalysisRangeSpec } from './types';
import { DAY_BOUNDARY_MINUTES } from './types';

// ─── Core date arithmetic ─────────────────────────────────────────────────────

/**
 * Add n calendar days to a date string (YYYY-MM-DD).
 * Uses UTC arithmetic to avoid DST shifts.
 */
export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const result = new Date(Date.UTC(y, m - 1, d + n));
  return formatUTCDate(result);
}

/** Days from baseDate to laterDate (positive if laterDate is after baseDate). */
export function dateDiffDays(baseDate: string, laterDate: string): number {
  const [by, bm, bd] = baseDate.split('-').map(Number);
  const [ly, lm, ld] = laterDate.split('-').map(Number);
  const msPerDay = 86_400_000;
  return Math.round((Date.UTC(ly, lm - 1, ld) - Date.UTC(by, bm - 1, bd)) / msPerDay);
}

function formatUTCDate(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// ─── Analytical date resolution ───────────────────────────────────────────────

/**
 * Convert a timing's calendar date + timeInit to its analytical date.
 *
 * timeInit is minutes from midnight of calendarDate and may exceed 1440
 * (e.g. 1470 = 00:30 on the following calendar day).
 *
 * Rules:
 *   actualCalendarDay = calendarDate + floor(timeInit / 1440)
 *   if timeInit % 1440 < DAY_BOUNDARY_MINUTES → analyticalDate = actualCalendarDay − 1
 *   else                                       → analyticalDate = actualCalendarDay
 */
export function toAnalyticalDate(calendarDate: CalendarDate, timeInit: number): AnalyticalDate {
  const dayOffset = Math.floor(timeInit / 1440);
  const minuteInDay = timeInit % 1440;
  const actualCalendarDay = addDays(calendarDate, dayOffset);
  return minuteInDay < DAY_BOUNDARY_MINUTES
    ? addDays(actualCalendarDay, -1)
    : actualCalendarDay;
}

/**
 * Convert an instant (a JS Date object with local-time semantics) to its analytical date.
 *
 * If the local hour:minute is before DAY_BOUNDARY_MINUTES, the instant belongs
 * to the previous analytical day.  This is used to resolve "today" and "yesterday"
 * columns relative to the anchor instant — NOT the naive calendar date.
 *
 * Example: 02:00 local time on 2026-03-21 → analytical date "2026-03-20".
 */
export function analyticalDateOfInstant(instant: Date): AnalyticalDate {
  const totalMinutes = instant.getHours() * 60 + instant.getMinutes();
  const y = instant.getFullYear();
  const m = String(instant.getMonth() + 1).padStart(2, '0');
  const d = String(instant.getDate()).padStart(2, '0');
  const calendarDate = `${y}-${m}-${d}`;
  return totalMinutes < DAY_BOUNDARY_MINUTES ? addDays(calendarDate, -1) : calendarDate;
}

// ─── Range helpers ────────────────────────────────────────────────────────────

/**
 * Resolve a declarative AnalysisRangeSpec to a concrete [from, to] pair.
 * All boundaries are computed relative to the analytical date of anchorDate.
 */
export function resolveAnalysisRange(spec: AnalysisRangeSpec, anchorDate: Date): AnalysisRange {
  const today = analyticalDateOfInstant(anchorDate);

  switch (spec.kind) {
    case 'last-n-days':
      return { from: addDays(today, -(spec.days - 1)), to: today };

    case 'last-n-weeks':
      return { from: addDays(today, -(spec.weeks * 7 - 1)), to: today };

    case 'this-month': {
      const [y, mo] = today.split('-').map(Number);
      const from = `${y}-${String(mo).padStart(2, '0')}-01`;
      // End at today, not the full month end — avoids future empty days diluting averages.
      return { from, to: today };
    }

    case 'this-week': {
      // ISO week: Mon=1 … Sun=0. Shift back to Monday.
      const wd = getAnalyticalWeekday(today); // 0=Sun, 1=Mon, …
      const daysToMonday = wd === 0 ? -6 : 1 - wd;
      const from = addDays(today, daysToMonday);
      // End at today, not the full week end — avoids future empty days diluting averages.
      return { from, to: today };
    }

    case 'custom':
      return { from: spec.from, to: spec.to };

    default: {
      const _: never = spec;
      throw new Error(`Unknown AnalysisRangeSpec kind: ${JSON.stringify(_)}`);
    }
  }
}

/**
 * Return an ordered list of every analytical date in [from, to] inclusive.
 */
export function analyticalDayRange(from: AnalyticalDate, to: AnalyticalDate): AnalyticalDate[] {
  const result: AnalyticalDate[] = [];
  let current = from;
  while (current <= to) {
    result.push(current);
    current = addDays(current, 1);
  }
  return result;
}

// ─── Weekday helpers ──────────────────────────────────────────────────────────

/**
 * Day of week for an analytical date. 0 = Sunday, 1 = Monday, …, 6 = Saturday.
 * Uses UTC to avoid local-timezone shifts on the date string.
 */
export function getAnalyticalWeekday(date: AnalyticalDate): number {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** True if the analytical date falls on Monday–Friday. */
export function isWorkday(date: AnalyticalDate): boolean {
  const wd = getAnalyticalWeekday(date);
  return wd >= 1 && wd <= 5;
}
