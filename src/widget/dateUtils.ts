/**
 * Date utilities for the metrics-app backend.
 *
 * All functions operate in LOCAL time. Never use `new Date("YYYY-MM-DD")` —
 * it parses as UTC midnight and causes off-by-one errors in non-UTC timezones.
 *
 * These utilities are backend-only.  The frontend (web/src/) has its own
 * inline equivalents so we avoid cross-package imports.
 */

export type BigPeriod = 'day' | 'week' | 'month' | 'year';

// ─────────────────────────────────────────────────────────────
// Parsing / formatting
// ─────────────────────────────────────────────────────────────

/**
 * Parse a YYYY-MM-DD string as local-time midnight.
 * Safe alternative to `new Date("YYYY-MM-DD")` which parses as UTC.
 */
export function parseLocalDate(str: string): Date {
  const parts = str.split('-');
  if (parts.length !== 3) throw new Error(`Invalid date string: "${str}"`);
  const y = parseInt(parts[0], 10);
  const m = parseInt(parts[1], 10) - 1; // 0-indexed
  const d = parseInt(parts[2], 10);
  if (isNaN(y) || isNaN(m) || isNaN(d)) throw new Error(`Invalid date string: "${str}"`);
  return new Date(y, m, d, 0, 0, 0, 0);
}

/**
 * Format a Date as YYYY-MM-DD (local time).
 */
export function formatDateParam(date: Date): string {
  const y = date.getFullYear();
  const m = (date.getMonth() + 1).toString().padStart(2, '0');
  const d = date.getDate().toString().padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// ─────────────────────────────────────────────────────────────
// Date arithmetic
// ─────────────────────────────────────────────────────────────

/** Local-time midnight of the given date (strips time component). */
export function localMidnight(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
}

/** Add N days using date arithmetic (safe with DST). */
export function addDays(date: Date, n: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

/** Add N months. JS Date handles month overflow (e.g. Jan 31 + 1 month = Feb 28/29). */
export function addMonths(date: Date, n: number): Date {
  const d = new Date(date);
  d.setMonth(d.getMonth() + n);
  return d;
}

/** Add N years. */
export function addYears(date: Date, n: number): Date {
  const d = new Date(date);
  d.setFullYear(d.getFullYear() + n);
  return d;
}

// ─────────────────────────────────────────────────────────────
// Preset range computation
// ─────────────────────────────────────────────────────────────

/**
 * Compute [startDate, endDate) for a named preset centred on `anchor`.
 * endDate is exclusive — i.e. midnight of the day AFTER the last day.
 *
 * Week is Monday-anchored (ISO 8601).
 */
export function computePresetRange(
  preset: BigPeriod,
  anchor: Date,
): { startDate: Date; endDate: Date } {
  const y = anchor.getFullYear();
  const mo = anchor.getMonth();
  const d = anchor.getDate();

  switch (preset) {
    case 'day': {
      const s = new Date(y, mo, d, 0, 0, 0, 0);
      const e = new Date(y, mo, d + 1, 0, 0, 0, 0);
      return { startDate: s, endDate: e };
    }
    case 'week': {
      const dow = anchor.getDay(); // 0=Sun, 1=Mon, …
      const daysBack = dow === 0 ? 6 : dow - 1;
      const s = new Date(y, mo, d - daysBack, 0, 0, 0, 0);
      const e = new Date(s.getFullYear(), s.getMonth(), s.getDate() + 7, 0, 0, 0, 0);
      return { startDate: s, endDate: e };
    }
    case 'month': {
      const s = new Date(y, mo, 1, 0, 0, 0, 0);
      const e = new Date(y, mo + 1, 1, 0, 0, 0, 0);
      return { startDate: s, endDate: e };
    }
    case 'year': {
      const s = new Date(y, 0, 1, 0, 0, 0, 0);
      const e = new Date(y + 1, 0, 1, 0, 0, 0, 0);
      return { startDate: s, endDate: e };
    }
  }
}

// ─────────────────────────────────────────────────────────────
// Analytical weekday
// ─────────────────────────────────────────────────────────────

/**
 * Compute the analytical weekday for a timestamp.
 *
 * Business rule: the analytical day starts at 05:00 local time.
 * A timestamp at 03:00 on Tuesday is considered Monday analytically.
 *
 * Returns 0=Sunday, 1=Monday, …, 6=Saturday.
 */
export function analyticalWeekday(ts: Date): number {
  // Subtract 5 hours to shift the boundary from midnight to 05:00.
  const adjusted = new Date(ts.getTime() - 5 * 60 * 60 * 1000);
  return adjusted.getDay();
}
