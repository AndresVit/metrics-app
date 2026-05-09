/**
 * SettingsPage — user-configurable time tags + category colors.
 *
 * Time tags drive the simple-mode timing input fields and the colors used
 * across dashboard / time-patterns. Letters are single a-z, 1–6 entries.
 *
 * Category colors map top-level definition categories to hex colors.
 * Sub-paths (e.g. "productive/uni") inherit at render time — not configured here.
 */

import { useState, useEffect, useCallback } from 'react';
import { useSettings, type TimeTagSetting } from './SettingsContext';

const API_URL = 'http://localhost:3001';

const HEX_RE = /^#[0-9a-fA-F]{6}$/;
const LETTER_RE = /^[a-z]$/;

export function SettingsPage() {
  const { settings, loading, refresh } = useSettings();
  const [timeTags, setTimeTags] = useState<TimeTagSetting[]>([]);
  const [categoryColors, setCategoryColors] = useState<Array<{ name: string; color: string }>>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  // Hydrate local form state from context whenever it loads/refreshes
  useEffect(() => {
    if (!settings) return;
    setTimeTags(settings.timeTags);
    setCategoryColors(
      Object.entries(settings.categoryColors).map(([name, color]) => ({ name, color }))
    );
  }, [settings]);

  // ── Time tag editing ────────────────────────────────────────────────────────

  const updateTag = (i: number, patch: Partial<TimeTagSetting>) => {
    setTimeTags(prev => prev.map((t, idx) => (idx === i ? { ...t, ...patch } : t)));
  };

  const addTag = () => {
    if (timeTags.length >= 6) return;
    const used = new Set(timeTags.map(t => t.letter));
    const next = 'abcdefghijklmnopqrstuvwxyz'.split('').find(l => !used.has(l)) || 'a';
    setTimeTags(prev => [
      ...prev,
      { letter: next, name: '', description: '', color: '#cccccc', position: prev.length },
    ]);
  };

  const removeTag = (i: number) => {
    if (timeTags.length <= 1) return;
    setTimeTags(prev => prev.filter((_, idx) => idx !== i).map((t, idx) => ({ ...t, position: idx })));
  };

  const moveTag = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= timeTags.length) return;
    setTimeTags(prev => {
      const copy = [...prev];
      [copy[i], copy[j]] = [copy[j], copy[i]];
      return copy.map((t, idx) => ({ ...t, position: idx }));
    });
  };

  // ── Category color editing ──────────────────────────────────────────────────

  const updateCategory = (i: number, patch: Partial<{ name: string; color: string }>) => {
    setCategoryColors(prev => prev.map((c, idx) => (idx === i ? { ...c, ...patch } : c)));
  };

  const addCategory = () => {
    setCategoryColors(prev => [...prev, { name: '', color: '#cccccc' }]);
  };

  const removeCategory = (i: number) => {
    setCategoryColors(prev => prev.filter((_, idx) => idx !== i));
  };

  // ── Validation + save ───────────────────────────────────────────────────────

  const validate = (): string | null => {
    if (timeTags.length < 1 || timeTags.length > 6) {
      return 'You must have between 1 and 6 time tags';
    }
    const seen = new Set<string>();
    for (const t of timeTags) {
      if (!LETTER_RE.test(t.letter)) return `Invalid letter: "${t.letter}" (must be a-z)`;
      if (seen.has(t.letter)) return `Duplicate letter: "${t.letter}"`;
      seen.add(t.letter);
      if (!t.name.trim()) return `Tag "${t.letter}" needs a name`;
      if (!HEX_RE.test(t.color)) return `Tag "${t.letter}" has an invalid color`;
    }
    const seenCats = new Set<string>();
    for (const c of categoryColors) {
      const name = c.name.trim();
      if (!name) return 'Empty category name';
      if (seenCats.has(name)) return `Duplicate category: "${name}"`;
      seenCats.add(name);
      if (!HEX_RE.test(c.color)) return `Category "${name}" has an invalid color`;
    }
    return null;
  };

  const save = useCallback(async () => {
    const err = validate();
    if (err) { setError(err); return; }
    setSaving(true);
    setError(null);
    try {
      const category_colors: Record<string, string> = {};
      for (const c of categoryColors) category_colors[c.name.trim()] = c.color;

      const resp = await fetch(`${API_URL}/api/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ time_tags: timeTags, category_colors }),
      });
      const data = await resp.json();
      if (!data.success) {
        setError(data.error || 'Failed to save');
      } else {
        setSavedAt(Date.now());
        await refresh();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timeTags, categoryColors]);

  if (loading) return <div className="settings-page"><p>Loading…</p></div>;

  return (
    <div className="settings-page">
      <h1 className="settings-title">Settings</h1>

      <section className="settings-section">
        <h2 className="settings-section-title">Time tags</h2>
        <p className="settings-section-desc">
          1–6 letters that appear as fields in the simple-mode timing form. Single
          characters a–z. Drives the colors used across dashboards.
        </p>
        <div className="settings-tag-list">
          {timeTags.map((t, i) => (
            <div key={i} className="settings-tag-row">
              <input
                className="settings-letter-input"
                value={t.letter}
                onChange={e => updateTag(i, { letter: e.target.value.toLowerCase().slice(0, 1) })}
                maxLength={1}
                aria-label="Letter"
              />
              <input
                className="settings-name-input"
                value={t.name}
                onChange={e => updateTag(i, { name: e.target.value })}
                placeholder="Name"
                aria-label="Name"
              />
              <input
                className="settings-desc-input"
                value={t.description}
                onChange={e => updateTag(i, { description: e.target.value })}
                placeholder="Description (optional)"
                aria-label="Description"
              />
              <input
                type="color"
                className="settings-color-input"
                value={t.color}
                onChange={e => updateTag(i, { color: e.target.value })}
                aria-label="Color"
              />
              <button className="btn-text" onClick={() => moveTag(i, -1)} disabled={i === 0} title="Move up">↑</button>
              <button className="btn-text" onClick={() => moveTag(i, +1)} disabled={i === timeTags.length - 1} title="Move down">↓</button>
              <button className="btn-text" onClick={() => removeTag(i)} disabled={timeTags.length <= 1} title="Remove">✕</button>
            </div>
          ))}
        </div>
        <button className="btn-outline" onClick={addTag} disabled={timeTags.length >= 6}>
          + Add tag
        </button>
      </section>

      <section className="settings-section">
        <h2 className="settings-section-title">Category colors</h2>
        <p className="settings-section-desc">
          Top-level category names mapped to colors. Sub-paths (e.g. "productive/uni")
          inherit the parent color.
        </p>
        <div className="settings-tag-list">
          {categoryColors.map((c, i) => (
            <div key={i} className="settings-tag-row">
              <input
                className="settings-name-input"
                value={c.name}
                onChange={e => updateCategory(i, { name: e.target.value })}
                placeholder="category name"
                aria-label="Category"
              />
              <input
                type="color"
                className="settings-color-input"
                value={c.color}
                onChange={e => updateCategory(i, { color: e.target.value })}
                aria-label="Color"
              />
              <button className="btn-text" onClick={() => removeCategory(i)} title="Remove">✕</button>
            </div>
          ))}
        </div>
        <button className="btn-outline" onClick={addCategory}>+ Add category</button>
      </section>

      <div className="settings-footer">
        <button className="btn-contained-sm" onClick={save} disabled={saving}>
          {saving ? 'Saving…' : 'Save changes'}
        </button>
        {error && <span className="settings-error">{error}</span>}
        {savedAt && !error && <span className="settings-saved">Saved.</span>}
      </div>
    </div>
  );
}
