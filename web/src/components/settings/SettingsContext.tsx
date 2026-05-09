/**
 * SettingsContext — single source of truth for user settings on the client.
 *
 * Fetches once at app mount and caches in context. Components that consume
 * letters/colors should use useSettings(); the SettingsPage notifies via
 * refresh() after a save so dependent views (timing forms, dashboards, etc.)
 * pick up changes without a page reload.
 */

import { createContext, useContext, useEffect, useState, useCallback, type ReactNode } from 'react';

const API_URL = 'http://localhost:3001';

export interface TimeTagSetting {
  letter: string;
  name: string;
  description: string;
  color: string;
  position: number;
}

export interface UserSettings {
  timeTags: TimeTagSetting[];
  categoryColors: Record<string, string>;
}

interface SettingsContextValue {
  settings: UserSettings | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

const FALLBACK: UserSettings = {
  timeTags: [
    { letter: 't', name: 'Productive',   description: '', color: '#b8e6c8', position: 0 },
    { letter: 'm', name: 'Unproductive', description: '', color: '#fde68a', position: 1 },
    { letter: 'p', name: 'Lost',         description: '', color: '#f8c4c4', position: 2 },
    { letter: 'n', name: 'Neutral',      description: '', color: '#e8e8e8', position: 3 },
  ],
  categoryColors: {},
};

const SettingsContext = createContext<SettingsContextValue | null>(null);

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<UserSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const resp = await fetch(`${API_URL}/api/settings`);
      const data = await resp.json();
      if (!data.success) throw new Error(data.error || 'failed to load settings');
      const tags = [...(data.settings.time_tags ?? [])].sort(
        (a: TimeTagSetting, b: TimeTagSetting) => a.position - b.position
      );
      setSettings({
        timeTags: tags.length > 0 ? tags : FALLBACK.timeTags,
        categoryColors: data.settings.category_colors ?? {},
      });
    } catch (e) {
      // Fall back to defaults so the app stays usable if settings fail to load.
      setSettings(FALLBACK);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  return (
    <SettingsContext.Provider value={{ settings, loading, error, refresh }}>
      {children}
    </SettingsContext.Provider>
  );
}

export function useSettings(): SettingsContextValue {
  const v = useContext(SettingsContext);
  if (!v) throw new Error('useSettings must be used inside SettingsProvider');
  return v;
}

/**
 * Resolve a color for a given category path. Sub-paths inherit the parent's color
 * (e.g. "productive/uni" → looks up "productive"). Returns null if no match.
 */
export function colorForCategory(
  categoryColors: Record<string, string>,
  category: string | null | undefined
): string | null {
  if (!category) return null;
  const parts = category.split('/');
  for (let i = parts.length; i > 0; i--) {
    const key = parts.slice(0, i).join('/');
    if (categoryColors[key]) return categoryColors[key];
  }
  return null;
}

/**
 * Resolve a color for a given time-type subdivision. The subdivision may be
 * a single letter ("t") or hierarchical ("m/thk"); the base letter wins.
 */
export function colorForTimeTag(
  timeTags: TimeTagSetting[],
  subdivision: string | null | undefined
): string | null {
  if (!subdivision) return null;
  const base = subdivision.split('/')[0];
  return timeTags.find(t => t.letter === base)?.color ?? null;
}
