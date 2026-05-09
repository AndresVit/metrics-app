/**
 * Persistent state for the monthly TXT backup system.
 *
 * Tracks:
 *   - dirtyMonths   : months whose snapshot is stale and must be regenerated
 *   - lastBackupDate: YYYY-MM-DD of the last successful auto-backup run, used
 *                     to enforce the "at most once per day" policy
 *
 * Stored as a single JSON file at <backupDir>/.state.json. Reads tolerate a
 * missing or malformed file by returning empty defaults — the file is the
 * snapshot of state, not the source of truth.
 */

import * as fs from 'fs';
import * as path from 'path';

export interface BackupState {
  dirtyMonths: string[];          // ["YYYY-MM", ...]
  lastBackupDate: string | null;  // "YYYY-MM-DD" or null
}

const STATE_FILE = '.state.json';

export class BackupStateStore {
  constructor(private backupDir: string) {}

  private statePath(): string {
    return path.join(this.backupDir, STATE_FILE);
  }

  async ensureDir(): Promise<void> {
    await fs.promises.mkdir(this.backupDir, { recursive: true });
  }

  async read(): Promise<BackupState> {
    await this.ensureDir();
    try {
      const raw = await fs.promises.readFile(this.statePath(), 'utf8');
      const parsed = JSON.parse(raw);
      const dirtyMonths = Array.isArray(parsed.dirtyMonths)
        ? parsed.dirtyMonths.filter((m: unknown): m is string => typeof m === 'string')
        : [];
      const lastBackupDate = typeof parsed.lastBackupDate === 'string' ? parsed.lastBackupDate : null;
      return { dirtyMonths, lastBackupDate };
    } catch {
      return { dirtyMonths: [], lastBackupDate: null };
    }
  }

  async write(state: BackupState): Promise<void> {
    await this.ensureDir();
    const tmp = this.statePath() + '.tmp';
    await fs.promises.writeFile(tmp, JSON.stringify(state, null, 2), 'utf8');
    await fs.promises.rename(tmp, this.statePath());
  }

  async markMonthDirty(monthKey: string): Promise<void> {
    const state = await this.read();
    if (!state.dirtyMonths.includes(monthKey)) {
      state.dirtyMonths.push(monthKey);
      await this.write(state);
    }
  }

  async clearDirty(monthsToClear: string[]): Promise<void> {
    const state = await this.read();
    state.dirtyMonths = state.dirtyMonths.filter((m) => !monthsToClear.includes(m));
    await this.write(state);
  }

  async setLastBackupDate(dateStr: string): Promise<void> {
    const state = await this.read();
    state.lastBackupDate = dateStr;
    await this.write(state);
  }
}

/** YYYY-MM key for a Date (local time). */
export function monthKeyOf(d: Date): string {
  const y = d.getFullYear();
  const m = (d.getMonth() + 1).toString().padStart(2, '0');
  return `${y}-${m}`;
}

/** YYYY-MM-DD key for a Date (local time). */
export function dayKeyOf(d: Date): string {
  const y = d.getFullYear();
  const m = (d.getMonth() + 1).toString().padStart(2, '0');
  const day = d.getDate().toString().padStart(2, '0');
  return `${y}-${m}-${day}`;
}
