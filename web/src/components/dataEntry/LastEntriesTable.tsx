/**
 * LastEntriesTable
 *
 * Shown in the right panel when the selected definition is NOT timingable.
 * Displays the last 7 persisted entries and a live "Preview" row
 * reflecting the current form state.
 */

import { useState, useEffect } from 'react';
import type { MetricDefinitionInfo, MetricField } from './SimpleEntryForm';

const API_URL = 'http://localhost:3001';

interface RecentEntry {
  id: number;
  date: string;
  subdivision: string | null;
  searchKey: string | null;
  fields: Record<string, string>;
}

interface LastEntriesTableProps {
  definition: MetricDefinitionInfo | null;
  previewValues: { attrs: Record<string, string>; sub: string } | null;
  /** When this changes (e.g. after a successful insert) the table re-fetches */
  refreshTrigger: string | null;
}

async function deleteEntry(id: number): Promise<{ ok: boolean; error?: string }> {
  try {
    const r = await fetch(`${API_URL}/api/entries/${id}`, { method: 'DELETE' });
    const ct = r.headers.get('content-type') || '';
    if (!ct.includes('application/json')) {
      return { ok: false, error: `Delete endpoint not found (HTTP ${r.status}). Restart the API server.` };
    }
    const data = await r.json();
    if (!data.success) return { ok: false, error: data.error || 'unknown' };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr + 'T12:00:00');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function isNumericType(type: string): boolean {
  return type === 'int' || type === 'float';
}

function formatNumeric(raw: string, type: string): string {
  const n = parseFloat(raw);
  if (isNaN(n)) return raw;
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return (n / 1_000_000).toFixed(3) + 'M';
  if (abs >= 1_000 || type === 'int') return String(Math.round(n));
  return n.toFixed(2);
}

function formatCell(raw: string, field: MetricField): string {
  if (isNumericType(field.type)) return formatNumeric(raw, field.type);
  return raw;
}

function entryFieldValue(entry: RecentEntry, field: MetricField): string {
  // For the key field, prefer search_key_value (guaranteed correct by server)
  if (field.isKey && entry.searchKey !== null) return entry.searchKey;
  const val = entry.fields[field.name];
  if (val === undefined || val === '') return '—';
  return formatCell(val, field);
}

function previewFieldValue(field: MetricField, previewValues: { attrs: Record<string, string>; sub: string } | null): string {
  if (!previewValues) return '—';
  const val = previewValues.attrs[field.name];
  if (val === undefined || val === '') return '—';
  return formatCell(val, field);
}

export function LastEntriesTable({ definition, previewValues, refreshTrigger }: LastEntriesTableProps) {
  const [entries, setEntries] = useState<RecentEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!definition) {
      setEntries([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    fetch(`${API_URL}/api/entries/recent?definitionCode=${encodeURIComponent(definition.code)}&limit=7`)
      .then(r => r.json())
      .then(data => {
        if (!cancelled && data.success) setEntries(data.entries);
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [definition?.code, refreshTrigger, reloadKey]);

  const handleDelete = async (entry: RecentEntry) => {
    const label = entry.searchKey ? ` (${entry.searchKey})` : '';
    if (!window.confirm(`Delete this ${definition?.code} entry${label} from ${formatDate(entry.date)}?\n\nThis removes the whole entry from the database.`)) return;
    setDeleteError(null);
    const result = await deleteEntry(entry.id);
    if (!result.ok) {
      setDeleteError(`Delete error: ${result.error}`);
      return;
    }
    setReloadKey(k => k + 1);
  };

  if (!definition) {
    return (
      <div className="let-empty-state">
        Select a metric to see recent entries.
      </div>
    );
  }

  // Build ordered columns: key field first, then others
  const keyField = definition.fields.find(f => f.isKey);
  const otherFields = definition.fields.filter(f => !f.isKey);
  const visibleFields: MetricField[] = [...(keyField ? [keyField] : []), ...otherFields];

  return (
    <div className="last-entries-table-wrap">
      <div className="let-header">
        <span className="panel-title">Recent Entries</span>
        <span className="let-header-def" title={definition.displayName}>
          for <span className="let-header-def-code">{definition.code}</span>
        </span>
      </div>

      {loading && entries.length === 0 ? (
        <div className="let-status">Loading…</div>
      ) : (
        <table className="let-table">
          <thead>
            <tr>
              <th className="let-th let-th-date">Date</th>
              {visibleFields.map(f => (
                <th
                  key={f.name}
                  className={`let-th${f.isKey ? ' let-th-key' : ''}${isNumericType(f.type) ? ' let-th-numeric' : ' let-th-string'}`}
                >
                  {f.name}
                </th>
              ))}
              <th className="let-th let-th-actions" aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {entries.map(entry => (
              <tr key={entry.id} className="let-row">
                <td className="let-td let-td-date">{formatDate(entry.date)}</td>
                {visibleFields.map(f => (
                  <td key={f.name} className={`let-td${isNumericType(f.type) ? ' let-td-numeric' : ''}`}>
                    {entryFieldValue(entry, f)}
                  </td>
                ))}
                <td className="let-td let-td-actions">
                  <button
                    className="let-delete-btn"
                    onClick={() => handleDelete(entry)}
                    title="Delete this entry"
                    aria-label="Delete entry"
                  >
                    ×
                  </button>
                </td>
              </tr>
            ))}

            {/* Preview row — current form state, not yet persisted */}
            <tr className="let-row let-row-preview">
              <td className="let-td let-td-date let-td-preview-label">Preview ↓</td>
              {visibleFields.map(f => (
                <td key={f.name} className={`let-td let-td-preview-value${isNumericType(f.type) ? ' let-td-numeric' : ''}`}>
                  {previewFieldValue(f, previewValues)}
                </td>
              ))}
              <td className="let-td let-td-actions" />
            </tr>
          </tbody>
        </table>
      )}

      {deleteError && (
        <div className="entry-error" style={{ marginTop: 8 }}>{deleteError}</div>
      )}

      {!loading && entries.length === 0 && (
        <div className="let-status">No entries yet.</div>
      )}
    </div>
  );
}
