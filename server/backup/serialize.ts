/**
 * Pure serialization helpers: DB-shaped timing data → Advanced text blocks.
 *
 * The output is deterministic so that snapshots are stable across regenerations:
 *   - blocks ordered by day, then by start time
 *   - per-day header emitted once
 *   - tokens ordered (t, m, p, n) then alphabetically by sub-category
 *   - attributes ordered alphabetically by name
 *
 * Output shape per day:
 *   <DayHeader>
 *   <HeaderLine>
 *   <TimingLine>
 *
 *   <HeaderLine>
 *   <TimingLine>
 */

const WEEKDAY_LETTERS = ['D', 'L', 'M', 'X', 'J', 'V', 'S']; // Sunday..Saturday (Spanish-style)

const BASE_ORDER: Record<string, number> = { t: 0, m: 1, p: 2, n: 3 };

export interface TimingHeaderInfo {
  definitionCode: string;
  subdivision: string | null;
  attributes: Array<{ name: string; value: string }>;
  /** Tags on the root (parent) entry. Empty array = none. */
  tags?: Array<{ key: string; value: string | null }>;
}

export interface TimingBlock {
  /** Local-time midnight of the day this timing belongs to. */
  date: Date;
  /** Minutes from midnight. May exceed 1440 for past-midnight ranges. */
  timeInit: number;
  timeEnd: number;
  /** subdivision-keyed minutes, e.g. {"t": 20, "m": 10, "m/thk": 5} */
  timeValues: Map<string, number>;
  header: TimingHeaderInfo;
}

export function formatDayHeader(date: Date): string {
  const weekday = WEEKDAY_LETTERS[date.getDay()];
  const day = date.getDate();
  const month = date.getMonth() + 1;
  return `${weekday}${day}/${month}`;
}

export function formatTimeRange(timeInit: number, timeEnd: number): string {
  return `${minToHHMM(timeInit)}-${minToHHMM(timeEnd)}`;
}

function minToHHMM(t: number): string {
  const hh = Math.floor(t / 60);
  const mm = t % 60;
  return `${hh.toString().padStart(2, '0')}${mm.toString().padStart(2, '0')}`;
}

export function serializeTokens(timeValues: Map<string, number>): string {
  const entries = [...timeValues.entries()].filter(([, v]) => v > 0);
  entries.sort(([a], [b]) => {
    const [aBase, aSub = ''] = a.split('/');
    const [bBase, bSub = ''] = b.split('/');
    const aOrd = BASE_ORDER[aBase] ?? 99;
    const bOrd = BASE_ORDER[bBase] ?? 99;
    if (aOrd !== bOrd) return aOrd - bOrd;
    return aSub.localeCompare(bSub);
  });
  return entries.map(([k, v]) => `${k}${v}`).join('');
}

export function formatHeaderLine(header: TimingHeaderInfo): string {
  let line = header.definitionCode;
  if (header.subdivision && header.subdivision.trim() !== '') {
    line += `:${header.subdivision}`;
  }
  const tags = header.tags ?? [];
  // Always emit the attributes ';' if there are tags too, so the tags ';'
  // sits at the right block position: DEF:sub;[attrs];tags
  if (header.attributes.length > 0 || tags.length > 0) {
    const sorted = [...header.attributes].sort((a, b) => a.name.localeCompare(b.name));
    const parts = sorted.map((a) => `${a.name}:${a.value}`);
    line += `;${parts.join(',')}`;
  }
  if (tags.length > 0) {
    const sortedTags = [...tags].sort((a, b) => a.key.localeCompare(b.key));
    const tagParts = sortedTags.map((t) => `${t.key}:${t.value ?? ''}`);
    line += `;${tagParts.join(',')}`;
  }
  return line;
}

/**
 * Serialize a list of timing blocks into the monthly TXT file content.
 *
 * Day header rule: emit the day header once, then all timing blocks for that
 * day. Blank line between blocks (within a day or across days). The output
 * always ends with a trailing newline.
 */
export function serializeMonth(blocks: TimingBlock[]): string {
  if (blocks.length === 0) return '';

  const sorted = [...blocks].sort((a, b) => {
    const dt = a.date.getTime() - b.date.getTime();
    if (dt !== 0) return dt;
    return a.timeInit - b.timeInit;
  });

  const lines: string[] = [];
  let lastDayKey: string | null = null;
  for (const block of sorted) {
    const dayKey = `${block.date.getFullYear()}-${block.date.getMonth() + 1}-${block.date.getDate()}`;
    if (dayKey !== lastDayKey) {
      if (lines.length > 0) lines.push(''); // blank line between days
      lines.push(formatDayHeader(block.date));
      lastDayKey = dayKey;
    } else {
      lines.push(''); // blank line between blocks within the same day
    }
    lines.push(formatHeaderLine(block.header));
    const tokenStr = serializeTokens(block.timeValues);
    const timingLine = `${formatTimeRange(block.timeInit, block.timeEnd)}${tokenStr ? ' ' + tokenStr : ''}`;
    lines.push(timingLine);
  }

  return lines.join('\n') + '\n';
}
