/**
 * Monthly TXT backup orchestrator.
 *
 * Architecture (intentionally simple):
 *   - DB is the source of truth.
 *   - Inserts/edits/deletes only mark the affected month dirty.
 *   - Backup generation rebuilds a full monthly snapshot from the DB.
 *   - Auto-backup runs at most once per day (gated by lastBackupDate).
 *
 * No incremental TXT patching, no file watcher, no bidirectional sync.
 */

import * as fs from 'fs';
import * as path from 'path';
import { BackupStateStore, monthKeyOf, dayKeyOf } from './state';
import { loadMonthTimings } from './loadMonth';
import { serializeMonth } from './serialize';

export interface BackupServiceOptions {
  backupDir: string;
  userId: string;
}

export interface BackupRunResult {
  regenerated: string[];           // months actually written
  skipped: string[];                // months that were dirty but produced empty content (deleted/cleared)
  errors: Array<{ month: string; message: string }>;
}

export class BackupService {
  private store: BackupStateStore;
  private inFlight: Promise<BackupRunResult> | null = null;

  constructor(private opts: BackupServiceOptions) {
    this.store = new BackupStateStore(opts.backupDir);
  }

  /** Mark a month as dirty given a Date in that month. */
  async markDirtyForDate(date: Date): Promise<void> {
    await this.store.markMonthDirty(monthKeyOf(date));
  }

  /** Mark a month as dirty given a YYYY-MM key directly. */
  async markMonthDirty(monthKey: string): Promise<void> {
    await this.store.markMonthDirty(monthKey);
  }

  async listDirtyMonths(): Promise<string[]> {
    const state = await this.store.read();
    return state.dirtyMonths.slice();
  }

  async getStatus(): Promise<{ dirtyMonths: string[]; lastBackupDate: string | null; backupDir: string }> {
    const state = await this.store.read();
    return { dirtyMonths: state.dirtyMonths, lastBackupDate: state.lastBackupDate, backupDir: this.opts.backupDir };
  }

  /**
   * Regenerate one monthly TXT file from DB.
   *
   * - Fetches all timings for the month.
   * - If there are timings, writes them atomically to timings_YYYY_MM.txt.
   * - If there are none, deletes the file (clean state).
   *
   * Returns true if the file was written or deleted, false on no-op.
   */
  async regenerateMonth(monthKey: string): Promise<boolean> {
    const blocks = await loadMonthTimings(this.opts.userId, monthKey);
    const content = serializeMonth(blocks);
    const filePath = this.fileFor(monthKey);

    if (content.length === 0) {
      // No timings in this month — remove any stale file
      try {
        await fs.promises.unlink(filePath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
      return false;
    }

    await this.store.ensureDir();
    const tmp = filePath + '.tmp';
    await fs.promises.writeFile(tmp, content, 'utf8');
    await fs.promises.rename(tmp, filePath);
    return true;
  }

  /**
   * Regenerate every dirty month and clear them from the dirty list on success.
   * Errors on a single month do not abort the rest — they are collected and returned.
   *
   * Concurrent calls are coalesced: while a run is in flight, additional callers
   * receive the same in-flight promise.
   */
  async regenerateDirtyMonths(): Promise<BackupRunResult> {
    if (this.inFlight) return this.inFlight;

    const run = (async () => {
      const dirty = await this.listDirtyMonths();
      const result: BackupRunResult = { regenerated: [], skipped: [], errors: [] };
      const successfullyProcessed: string[] = [];

      for (const monthKey of dirty) {
        try {
          const wrote = await this.regenerateMonth(monthKey);
          if (wrote) result.regenerated.push(monthKey);
          else result.skipped.push(monthKey);
          successfullyProcessed.push(monthKey);
        } catch (err) {
          result.errors.push({ month: monthKey, message: err instanceof Error ? err.message : String(err) });
        }
      }

      if (successfullyProcessed.length > 0) {
        await this.store.clearDirty(successfullyProcessed);
      }
      return result;
    })();

    this.inFlight = run;
    try {
      return await run;
    } finally {
      this.inFlight = null;
    }
  }

  /**
   * Auto-backup gate: run regenerateDirtyMonths at most once per local day.
   *
   * Returns the result if the run happened, or null if it was skipped because
   * a backup has already run today.
   */
  async runDailyAutoBackup(now: Date = new Date()): Promise<BackupRunResult | null> {
    const todayKey = dayKeyOf(now);
    const state = await this.store.read();
    if (state.lastBackupDate === todayKey) return null;
    if (state.dirtyMonths.length === 0) {
      // Nothing to do — but record that we "checked" today, so we don't keep checking
      await this.store.setLastBackupDate(todayKey);
      return { regenerated: [], skipped: [], errors: [] };
    }
    const result = await this.regenerateDirtyMonths();
    if (result.errors.length === 0) {
      await this.store.setLastBackupDate(todayKey);
    }
    return result;
  }

  private fileFor(monthKey: string): string {
    const [y, m] = monthKey.split('-');
    return path.join(this.opts.backupDir, `timings_${y}_${m}.txt`);
  }
}
