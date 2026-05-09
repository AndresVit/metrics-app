import { describe, it, expect } from 'vitest';
import { adaptApiTimingsToRawTimings } from '../intake';
import type { ApiTimingRow } from '../intake';

// Helper: build a minimal ApiTimingRow.
// timestamp is expressed as a local-time date string (no Z suffix) so that
// new Date(ts).getFullYear() etc. return predictable local-time values.
function row(
  id: number,
  localDateStr: string, // "2026-03-21T10:00:00" — local time, no Z
  timeInit: number | null,
  timeEnd: number | null,
  timeLabels: Record<string, number> = {},
): ApiTimingRow {
  return { id, timestamp: localDateStr, timeInit, timeEnd, timeLabels };
}

describe('adaptApiTimingsToRawTimings', () => {
  it('basic daytime timing — calendarDate and analyticalDate both equal timestamp date', () => {
    // 10:00 local → timeInit=600, well above 05:00 boundary
    const result = adaptApiTimingsToRawTimings([
      row(1, '2026-03-21T10:00:00', 600, 660, { t: 60 }),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: 1,
      calendarDate: '2026-03-21',
      analyticalDate: '2026-03-21',
      timeInit: 600,
      timeEnd: 660,
      timeLabels: { t: 60 },
    });
  });

  it('early-morning timing — analyticalDate equals calendarDate (no 05:00 shift)', () => {
    // timestamp = 2026-03-21 (local), timeInit = 120 (02:00).
    // Under the simplified model: timestamp IS the day; no shift applied.
    // analyticalDate must equal calendarDate.
    const result = adaptApiTimingsToRawTimings([
      row(2, '2026-03-21T02:00:00', 120, 180, { m: 60 }),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].calendarDate).toBe('2026-03-21');
    expect(result[0].analyticalDate).toBe('2026-03-21');
    expect(result[0].timeInit).toBe(120);
    expect(result[0].timeEnd).toBe(180);
    expect(result[0].timeLabels).toEqual({ m: 60 });
  });

  it('timeInit exactly at boundary (300) — analyticalDate stays on calendarDate', () => {
    const result = adaptApiTimingsToRawTimings([
      row(3, '2026-03-21T05:00:00', 300, 360, {}),
    ]);
    expect(result[0].analyticalDate).toBe('2026-03-21');
  });

  it('timeInit > 1440 — analyticalDate equals calendarDate from timestamp', () => {
    // timeInit = 1470 means a cross-midnight session stored with timestamp 2026-03-21.
    // analyticalDate = calendarDate = '2026-03-21' (from the timestamp, no shift).
    const result = adaptApiTimingsToRawTimings([
      row(4, '2026-03-21T00:30:00', 1470, 1530, { t: 60 }),
    ]);
    expect(result[0].calendarDate).toBe('2026-03-21');
    expect(result[0].analyticalDate).toBe('2026-03-21');
  });

  it('timeLabels are passed through unchanged', () => {
    const labels = { t: 90, m: 30, 'm/thk': 15, 'm/sw': 10, p: 5 };
    const result = adaptApiTimingsToRawTimings([
      row(5, '2026-03-21T10:00:00', 600, 750, labels),
    ]);
    expect(result[0].timeLabels).toEqual(labels);
  });

  it('empty timeLabels is valid', () => {
    const result = adaptApiTimingsToRawTimings([
      row(6, '2026-03-21T10:00:00', 600, 660, {}),
    ]);
    expect(result[0].timeLabels).toEqual({});
  });

  it('rows with null timeInit are skipped', () => {
    const result = adaptApiTimingsToRawTimings([
      row(7, '2026-03-21T10:00:00', null, 660, { t: 60 }),
    ]);
    expect(result).toHaveLength(0);
  });

  it('rows with null timeEnd are skipped', () => {
    const result = adaptApiTimingsToRawTimings([
      row(8, '2026-03-21T10:00:00', 600, null, { t: 60 }),
    ]);
    expect(result).toHaveLength(0);
  });

  it('mixed batch: valid and incomplete rows', () => {
    const result = adaptApiTimingsToRawTimings([
      row(9,  '2026-03-21T10:00:00', 600, 660, { t: 60 }),
      row(10, '2026-03-21T11:00:00', null, 720, {}),   // skipped
      row(11, '2026-03-21T12:00:00', 720, null, {}),   // skipped
      row(12, '2026-03-21T13:00:00', 780, 840, { m: 60 }),
    ]);
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe(9);
    expect(result[1].id).toBe(12);
  });

  it('row with null timeLabels → normalised to empty object, does not crash', () => {
    // Reproduces the "Cannot convert undefined or null to object" bug:
    // server returns null for timeLabels (e.g. old server version or malformed row).
    const rawRow = {
      id: 20,
      timestamp: '2026-03-21T10:00:00',
      timeInit: 600,
      timeEnd: 660,
      timeLabels: null,
    };
    const result = adaptApiTimingsToRawTimings([rawRow as unknown as ApiTimingRow]);
    expect(result).toHaveLength(1);
    expect(result[0].timeLabels).toEqual({});
  });

  it('row with missing timeLabels → normalised to empty object, does not crash', () => {
    // Reproduces the bug when the field is absent entirely (server not restarted
    // after Phase 2 deploy, or stale cache).
    const rawRow = {
      id: 21,
      timestamp: '2026-03-21T10:00:00',
      timeInit: 600,
      timeEnd: 660,
      // timeLabels intentionally omitted
    };
    const result = adaptApiTimingsToRawTimings([rawRow as unknown as ApiTimingRow]);
    expect(result).toHaveLength(1);
    expect(result[0].timeLabels).toEqual({});
  });

  it('multiple timings on different calendar dates get different analytical dates', () => {
    const result = adaptApiTimingsToRawTimings([
      row(13, '2026-03-20T14:00:00', 840, 900, { t: 60 }),  // 14:00 on 2026-03-20
      row(14, '2026-03-21T03:00:00', 180, 240, { m: 60 }),  // 03:00 on 2026-03-21
    ]);
    expect(result[0].analyticalDate).toBe('2026-03-20');
    expect(result[1].analyticalDate).toBe('2026-03-21');
    // Each timing's analyticalDate equals its calendarDate; no day-boundary shift.
  });
});
