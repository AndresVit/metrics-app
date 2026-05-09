import type { RawTiming } from './types';

/**
 * Shape of a single timing row as returned by GET /api/timings.
 * Only the fields the engine needs are declared; extra fields are ignored.
 */
export interface ApiTimingRow {
  id: number;
  /**
   * ISO 8601 timestamp string from the server (stored in UTC by Supabase).
   * The local-time date of this instant is treated as the calendarDate.
   */
  timestamp: string;
  timeInit: number | null;
  timeEnd: number | null;
  /**
   * Full subdivision label map, e.g. { "t": 90, "m": 30, "m/thk": 15 }.
   * Added in Phase 2. Older server versions or malformed rows may omit this
   * field or return null — the adapter normalises both cases to {}.
   */
  timeLabels?: Record<string, number> | null;
}

/**
 * Convert an array of API timing rows into RawTiming[] for the Time Patterns engine.
 *
 * Rows where timeInit or timeEnd is null are skipped — they represent incomplete
 * timings that cannot be split into stripes.
 *
 * Calendar date is derived from timestamp using local time, which matches the
 * convention used everywhere else in the app (parseLocalDate, getPeriodDateRange).
 *
 * analyticalDate = calendarDate always. The entry timestamp is intentionally
 * stored as 00:00 of the day the timing belongs to; timeInit/timeEnd carry the
 * intraday position in minutes from midnight. No 05:00 day-boundary shift is
 * applied here — that logic has been retired.
 */
export function adaptApiTimingsToRawTimings(rows: ApiTimingRow[]): RawTiming[] {
  const result: RawTiming[] = [];

  for (const row of rows) {
    if (row.timeInit === null || row.timeEnd === null) continue;

    // Derive calendarDate from the timestamp's local-time date.
    // new Date(isoString) parses to an instant; .getFullYear/.getMonth/.getDate
    // return local-time components — consistent with parseLocalDate in the app.
    const ts = new Date(row.timestamp);
    const y  = ts.getFullYear();
    const mo = String(ts.getMonth() + 1).padStart(2, '0');
    const d  = String(ts.getDate()).padStart(2, '0');
    const calendarDate = `${y}-${mo}-${d}`;

    result.push({
      id: row.id,
      calendarDate,
      analyticalDate: calendarDate,  // analyticalDate always equals calendarDate
      timeInit: row.timeInit,
      timeEnd: row.timeEnd,
      timeLabels: row.timeLabels ?? {},
    });
  }

  return result;
}
