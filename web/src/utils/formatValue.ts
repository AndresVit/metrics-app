/**
 * Centralized value formatting utilities for widget renderers.
 *
 * FormatType mirrors the backend type from src/widget/ast.ts.
 * Keep these two in sync.
 */

export type FormatType = 'number' | 'float' | 'duration';

/**
 * Format a duration given in minutes as a compact human-readable string.
 *
 * Examples:
 *   0    → "0'"
 *   45   → "45'"
 *   60   → "1h"
 *   80   → "1h20"
 *   1689 → "28h9"
 */
export function formatDuration(minutes: number): string {
  const total = Math.round(minutes);
  if (total <= 0) return "0'";
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m}'`;
  if (m === 0) return `${h}h`;
  return `${h}h${m}`;
}

/**
 * Compact duration formatter for chart axes — avoids clutter.
 * Shows only the hour component (or minutes for sub-hour values).
 *
 * Examples:
 *   45  → "45'"
 *   90  → "1h"
 *   150 → "2h"
 */
export function formatDurationAxis(minutes: number): string {
  const h = Math.floor(minutes / 60);
  if (h === 0) return `${Math.round(minutes)}'`;
  return `${h}h`;
}

/**
 * Default smart formatter (matches the existing `fmt` behavior in WidgetV2.tsx).
 */
function fmtDefault(v: number): string {
  if (Math.abs(v) >= 1000) return v.toLocaleString(undefined, { maximumFractionDigits: 0 });
  if (Number.isInteger(v)) return String(v);
  return v.toFixed(2);
}

/**
 * Format a numeric value according to the given FormatType.
 * Handles null and non-finite values uniformly.
 *
 * @param v      The value to format
 * @param format The FormatType, or undefined to use the default smart formatter
 */
export function fmtValue(v: number | null | undefined, format: FormatType | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  switch (format) {
    case 'duration': return formatDuration(v);
    case 'float':    return v.toFixed(2);
    case 'number':   return Number.isInteger(v)
      ? String(v)
      : v.toLocaleString(undefined, { maximumFractionDigits: 0 });
    default:         return fmtDefault(v);
  }
}

/**
 * Format a value for use on chart axes (compact).
 * For duration format, uses the compact axis formatter; others behave like fmtValue.
 */
export function fmtAxis(v: number | null | undefined, format: FormatType | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '';
  if (format === 'duration') return formatDurationAxis(v);
  return fmtValue(v, format);
}
