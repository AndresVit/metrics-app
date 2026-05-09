/**
 * Format a duration in minutes as a human-readable string.
 *
 * Examples:
 *   0    → "0'"
 *   45   → "45'"
 *   60   → "1h"
 *   80   → "1h20"
 *   125  → "2h5"
 *   0.5  → "1'"  (rounded)
 */
export function formatMinutes(minutes: number): string {
  const total = Math.round(minutes);
  if (total <= 0) return "0'";
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m}'`;
  if (m === 0) return `${h}h`;
  return `${h}h${m}`;
}

/**
 * Dense minute formatter for compact grid cells.
 * Sub-hour: "45" (no apostrophe). Mixed: "1h45". Whole-hour: "1h".
 */
export function formatMinutesDense(minutes: number): string {
  const total = Math.round(minutes);
  if (total <= 0) return '0';
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m}`;
  if (m === 0) return `${h}h`;
  return `${h}h${m}`;
}

/**
 * Format a ratio [0, 1] as a percentage string, e.g. 0.823 → "82%".
 * Values outside [0,1] are clamped.
 */
export function formatRatio(ratio: number): string {
  const pct = Math.round(Math.max(0, Math.min(1, ratio)) * 100);
  return `${pct}%`;
}

/**
 * Format a minute-of-day value (0–1439) as HH:MM.
 * Input is normalised to [0, 1440) before formatting.
 */
export function formatMinuteAsTime(minuteOfDay: number): string {
  const m = ((minuteOfDay % 1440) + 1440) % 1440;
  const h = Math.floor(m / 60);
  const min = m % 60;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}
