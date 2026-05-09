import { useState, useEffect, createContext, useContext, useCallback, useRef, type ReactNode } from 'react';
import './App.css';
import { ModeToggle, type EntryMode } from './components/ModeToggle';
import { SimpleEntryForm, type MetricDefinitionInfo } from './components/dataEntry/SimpleEntryForm';
import { LastEntriesTable } from './components/dataEntry/LastEntriesTable';
import { DefinitionsEditor } from './components/definitions/DefinitionsEditor';
import { TimePatternsView } from './components/time-patterns/TimePatternsView';
import { SettingsPage } from './components/settings/SettingsPage';
import { SettingsProvider, useSettings, colorForTimeTag, colorForCategory } from './components/settings/SettingsContext';
import { WidgetV2, type ChartOutput, type ChartPresentation } from './components/widgets/WidgetV2';
import { WidgetV2Editor } from './components/widgets/WidgetV2Editor';

const API_URL = 'http://localhost:3001';

// ============================================
// Types
// ============================================

type BigPeriod = 'day' | 'week' | 'month' | 'year';
type SmallPeriod = 'hour' | 'day' | 'week' | 'month';

// ─────────────────────────────────────────────────────────────
// Global filter types (mirrors src/widget/globalFilter.ts)
// ─────────────────────────────────────────────────────────────

interface TagFilterRule {
  key: string;
  value?: string;
}

interface DashboardGlobalFilter {
  includeDefinitionCodes?: string[];
  excludeDefinitionCodes?: string[];
  subdivisionContains?: string;
  subdivisionExcludes?: string;
  /** 0=Sun…6=Sat, analytical (05:00 boundary) */
  weekdays?: number[];
  tagFilters?: TagFilterRule[];
}

interface DashboardInfo {
  id: string;
  name: string;
  createdAt: string;
  globalFilters: DashboardGlobalFilter | null;
}

interface DashboardWidget {
  id: string;
  name: string;
  dsl: string;
  orderIndex: number;
  chart?: ChartOutput;
  presentation?: ChartPresentation;
  error: string | null;
}

// ============================================
// Local-time date helpers (frontend)
// These mirror src/widget/dateUtils.ts but live here to avoid cross-package imports.
// ============================================

function localMidnight(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
}

/** Parse YYYY-MM-DD as local-time midnight (avoids UTC-parsing bug). */
function parseLocalDate(str: string): Date {
  const [y, m, d] = str.split('-').map(Number);
  return new Date(y, m - 1, d, 0, 0, 0, 0);
}

/** Format Date → YYYY-MM-DD (local time). */
function formatDateParam(date: Date): string {
  const y = date.getFullYear();
  const m = (date.getMonth() + 1).toString().padStart(2, '0');
  const d = date.getDate().toString().padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Add n days to a Date (returns a new Date at local-time midnight). */
function addDays(date: Date, n: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + n, 0, 0, 0, 0);
}

/**
 * The temporal context stores `endDate` as exclusive (midnight after the last
 * day in range). The backend wire contract expects an **inclusive** endDate, so
 * subtract one day before sending.
 */
function formatInclusiveEndDate(exclusiveEndDate: Date): string {
  return formatDateParam(addDays(exclusiveEndDate, -1));
}

/**
 * Compute [startDate, endDate) for a named preset centred on anchor.
 * endDate is exclusive (midnight after last day). Week is Monday-anchored.
 */
function computePresetRange(preset: BigPeriod, anchor: Date): { startDate: Date; endDate: Date } {
  const y = anchor.getFullYear();
  const mo = anchor.getMonth();
  const d = anchor.getDate();
  switch (preset) {
    case 'day':
      return { startDate: new Date(y, mo, d), endDate: new Date(y, mo, d + 1) };
    case 'week': {
      const dow = anchor.getDay();
      const back = dow === 0 ? 6 : dow - 1;
      const s = new Date(y, mo, d - back);
      return { startDate: s, endDate: new Date(s.getFullYear(), s.getMonth(), s.getDate() + 7) };
    }
    case 'month':
      return { startDate: new Date(y, mo, 1), endDate: new Date(y, mo + 1, 1) };
    case 'year':
      return { startDate: new Date(y, 0, 1), endDate: new Date(y + 1, 0, 1) };
  }
}

// ============================================
// Temporal Context
// ============================================

type ActivePreset = BigPeriod | 'custom';

interface TemporalContextValue {
  /** Inclusive lower bound (local-time midnight). */
  startDate: Date;
  /** Exclusive upper bound (local-time midnight of day after last day). */
  endDate: Date;
  /** Which preset is active, or 'custom' for a manually set range. */
  activePreset: ActivePreset;
  smallPeriod: SmallPeriod;
  setPreset: (preset: BigPeriod) => void;
  /** Set preset centered on an explicit anchor date (avoids startDate drift). */
  navigate: (preset: BigPeriod, anchor: Date) => void;
  setSmallPeriod: (period: SmallPeriod) => void;
  setStartDate: (date: Date) => void;
  setEndDate: (date: Date) => void;
  navigateBack: () => void;
  navigateForward: () => void;
}

const TemporalContext = createContext<TemporalContextValue | null>(null);

function TemporalContextProvider({ children }: { children: ReactNode }) {
  // Initialise to today (DAY preset)
  const [startDate, setStartDateState] = useState<Date>(() => localMidnight(new Date()));
  const [endDate, setEndDateState] = useState<Date>(() => {
    const d = localMidnight(new Date());
    d.setDate(d.getDate() + 1);
    return d;
  });
  const [activePreset, setActivePreset] = useState<ActivePreset>('day');
  const [smallPeriod, setSmallPeriod] = useState<SmallPeriod>('hour');

  const navigate = (preset: BigPeriod, anchor: Date) => {
    const { startDate: s, endDate: e } = computePresetRange(preset, anchor);
    setStartDateState(s);
    setEndDateState(e);
    setActivePreset(preset);
  };

  const setPreset = (preset: BigPeriod) => {
    navigate(preset, startDate);
  };

  const setStartDate = (date: Date) => {
    setStartDateState(localMidnight(date));
    setActivePreset('custom');
  };

  const setEndDate = (date: Date) => {
    setEndDateState(localMidnight(date));
    setActivePreset('custom');
  };

  const navigateBack = () => {
    if (activePreset !== 'custom') {
      // Shift the anchor (= startDate) by one preset unit back, then recompute range.
      const anchor = new Date(startDate);
      switch (activePreset) {
        case 'day': anchor.setDate(anchor.getDate() - 1); break;
        case 'week': anchor.setDate(anchor.getDate() - 7); break;
        case 'month': anchor.setMonth(anchor.getMonth() - 1); break;
        case 'year': anchor.setFullYear(anchor.getFullYear() - 1); break;
      }
      const { startDate: s, endDate: e } = computePresetRange(activePreset, anchor);
      setStartDateState(s);
      setEndDateState(e);
    } else {
      // Custom: shift both dates by the current span.
      const spanMs = endDate.getTime() - startDate.getTime();
      setStartDateState(new Date(startDate.getTime() - spanMs));
      setEndDateState(new Date(endDate.getTime() - spanMs));
    }
  };

  const navigateForward = () => {
    if (activePreset !== 'custom') {
      const anchor = new Date(startDate);
      switch (activePreset) {
        case 'day': anchor.setDate(anchor.getDate() + 1); break;
        case 'week': anchor.setDate(anchor.getDate() + 7); break;
        case 'month': anchor.setMonth(anchor.getMonth() + 1); break;
        case 'year': anchor.setFullYear(anchor.getFullYear() + 1); break;
      }
      const { startDate: s, endDate: e } = computePresetRange(activePreset, anchor);
      setStartDateState(s);
      setEndDateState(e);
    } else {
      const spanMs = endDate.getTime() - startDate.getTime();
      setStartDateState(new Date(startDate.getTime() + spanMs));
      setEndDateState(new Date(endDate.getTime() + spanMs));
    }
  };

  return (
    <TemporalContext.Provider
      value={{
        startDate,
        endDate,
        activePreset,
        smallPeriod,
        setPreset,
        navigate,
        setSmallPeriod,
        setStartDate,
        setEndDate,
        navigateBack,
        navigateForward,
      }}
    >
      {children}
    </TemporalContext.Provider>
  );
}

function useTemporalContext(): TemporalContextValue {
  const context = useContext(TemporalContext);
  if (!context) {
    throw new Error('useTemporalContext must be used within a TemporalContextProvider');
  }
  return context;
}

// ============================================
// Dashboard Context
// ============================================

interface DashboardContextValue {
  dashboards: DashboardInfo[];
  activeDashboardId: string | null;
  loading: boolean;
  error: string | null;
  setActiveDashboardId: (id: string | null) => void;
  refreshDashboards: () => Promise<void>;
  createNewDashboard: (name: string) => Promise<DashboardInfo | null>;
  /** Rename a dashboard. Returns true on success. */
  renameDashboard: (id: string, name: string) => Promise<boolean>;
  /** Delete a dashboard (cascades to widgets at the DB level). */
  deleteDashboardById: (id: string) => Promise<boolean>;
  /** Global filter for the active dashboard (null = no filter). */
  activeFilters: DashboardGlobalFilter | null;
  saveFilters: (filters: DashboardGlobalFilter | null) => Promise<void>;
}

const DashboardContext = createContext<DashboardContextValue | null>(null);

function DashboardContextProvider({ children }: { children: ReactNode }) {
  const [dashboards, setDashboards] = useState<DashboardInfo[]>([]);
  const [activeDashboardId, setActiveDashboardId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeFilters, setActiveFilters] = useState<DashboardGlobalFilter | null>(null);

  const refreshDashboards = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`${API_URL}/api/dashboards`);
      const data = await response.json();
      if (data.success) {
        setDashboards(data.dashboards);
        // Auto-select first dashboard if none selected
        if (data.dashboards.length > 0 && !activeDashboardId) {
          const first = data.dashboards[0];
          setActiveDashboardId(first.id);
          setActiveFilters(first.globalFilters ?? null);
        }
      } else {
        setError(data.error || 'Failed to load dashboards');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error');
    } finally {
      setLoading(false);
    }
  }, [activeDashboardId]);

  // When the active dashboard changes, load its stored filters.
  const handleSetActiveDashboardId = useCallback((id: string | null) => {
    setActiveDashboardId(id);
    if (!id) {
      setActiveFilters(null);
      return;
    }
    // Find filters from already-loaded dashboards list.
    setDashboards((prev) => {
      const found = prev.find(d => d.id === id);
      setActiveFilters(found?.globalFilters ?? null);
      return prev;
    });
  }, []);

  const createNewDashboard = useCallback(async (name: string): Promise<DashboardInfo | null> => {
    try {
      const response = await fetch(`${API_URL}/api/dashboards`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      const data = await response.json();
      if (data.success) {
        const newDashboard = { ...data.dashboard, globalFilters: null };
        setDashboards((prev) => [...prev, newDashboard]);
        setActiveDashboardId(newDashboard.id);
        setActiveFilters(null);
        return newDashboard;
      } else {
        setError(data.error || 'Failed to create dashboard');
        return null;
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error');
      return null;
    }
  }, []);

  const renameDashboard = useCallback(async (id: string, name: string): Promise<boolean> => {
    try {
      const resp = await fetch(`${API_URL}/api/dashboards/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      const data = await resp.json();
      if (data.success) {
        setDashboards(prev => prev.map(d => d.id === id ? { ...d, name: data.dashboard.name } : d));
        return true;
      }
      setError(data.error || 'Failed to rename dashboard');
      return false;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error');
      return false;
    }
  }, []);

  const deleteDashboardById = useCallback(async (id: string): Promise<boolean> => {
    try {
      const resp = await fetch(`${API_URL}/api/dashboards/${id}`, { method: 'DELETE' });
      const data = await resp.json();
      if (data.success) {
        let nextActive: string | null = null;
        setDashboards(prev => {
          const remaining = prev.filter(d => d.id !== id);
          if (id === activeDashboardId) nextActive = remaining[0]?.id ?? null;
          return remaining;
        });
        if (id === activeDashboardId) {
          setActiveDashboardId(nextActive);
          setActiveFilters(null);
        }
        return true;
      }
      setError(data.error || 'Failed to delete dashboard');
      return false;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error');
      return false;
    }
  }, [activeDashboardId]);

  const saveFilters = useCallback(async (filters: DashboardGlobalFilter | null) => {
    if (!activeDashboardId) return;
    try {
      const response = await fetch(`${API_URL}/api/dashboards/${activeDashboardId}/filters`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(filters ?? {}),
      });
      const data = await response.json();
      if (data.success) {
        setActiveFilters(filters);
        // Update cached dashboard entry
        setDashboards((prev) =>
          prev.map(d => d.id === activeDashboardId ? { ...d, globalFilters: filters } : d)
        );
      }
    } catch {
      // swallow — not critical
    }
  }, [activeDashboardId]);

  useEffect(() => {
    refreshDashboards();
  }, []);

  return (
    <DashboardContext.Provider
      value={{
        dashboards,
        activeDashboardId,
        loading,
        error,
        setActiveDashboardId: handleSetActiveDashboardId,
        refreshDashboards,
        createNewDashboard,
        renameDashboard,
        deleteDashboardById,
        activeFilters,
        saveFilters,
      }}
    >
      {children}
    </DashboardContext.Provider>
  );
}

function useDashboardContext(): DashboardContextValue {
  const context = useContext(DashboardContext);
  if (!context) {
    throw new Error('useDashboardContext must be used within a DashboardContextProvider');
  }
  return context;
}

// ============================================
// Temporal Bar Component
// ============================================

const BIG_PERIODS: { value: BigPeriod; label: string }[] = [
  { value: 'day', label: 'Day' },
  { value: 'week', label: 'Week' },
  { value: 'month', label: 'Month' },
  { value: 'year', label: 'Year' },
];

const SMALL_PERIODS: { value: SmallPeriod; label: string }[] = [
  { value: 'hour', label: 'Hour' },
  { value: 'day', label: 'Day' },
  { value: 'week', label: 'Week' },
  { value: 'month', label: 'Month' },
];

/**
 * Format the date range label shown in the top bar.
 * For named presets, shows a compact representation.
 * For custom, shows "start – end".
 */
function formatRangeLabel(startDate: Date, endDate: Date, preset: ActivePreset): string {
  // endDate is exclusive — the last calendar day is one day before endDate.
  // Use the local-time addDays helper so DST boundaries don't knock the result
  // back to the previous calendar day (a bare 86 400 000 ms subtraction fails
  // across spring-forward weeks — e.g. the week of 2026-03-23 → 2026-03-29).
  const lastDay = addDays(endDate, -1);

  switch (preset) {
    case 'day':
      return startDate.toLocaleDateString('en-US', {
        weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
      });
    case 'month':
      return startDate.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    case 'year':
      return String(startDate.getFullYear());
    default: {
      // week or custom — show "Apr 7 – Apr 13, 2026"
      const sameYear = startDate.getFullYear() === lastDay.getFullYear();
      const start = startDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      const end = lastDay.toLocaleDateString('en-US', {
        month: 'short', day: 'numeric', year: 'numeric',
      });
      return sameYear ? `${start} – ${end}` : `${start}, ${startDate.getFullYear()} – ${end}`;
    }
  }
}

function countActiveFilters(f: DashboardGlobalFilter | null): number {
  if (!f) return 0;
  let n = 0;
  if ((f.includeDefinitionCodes?.length ?? 0) > 0) n++;
  if ((f.excludeDefinitionCodes?.length ?? 0) > 0) n++;
  if (f.subdivisionContains?.trim()) n++;
  if (f.subdivisionExcludes?.trim()) n++;
  if ((f.weekdays?.length ?? 0) > 0) n++;
  if ((f.tagFilters?.length ?? 0) > 0) n += f.tagFilters!.length;
  return n;
}

// ============================================
// Filters Popover Component
// ============================================

const WEEKDAY_OPTIONS = [
  { value: 1, label: 'Mon' },
  { value: 2, label: 'Tue' },
  { value: 3, label: 'Wed' },
  { value: 4, label: 'Thu' },
  { value: 5, label: 'Fri' },
  { value: 6, label: 'Sat' },
  { value: 0, label: 'Sun' },
];

function FiltersPopover({
  filters,
  onApply,
  onClose,
}: {
  filters: DashboardGlobalFilter | null;
  onApply: (f: DashboardGlobalFilter | null) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<DashboardGlobalFilter>(() => ({
    includeDefinitionCodes: filters?.includeDefinitionCodes ?? [],
    excludeDefinitionCodes: filters?.excludeDefinitionCodes ?? [],
    subdivisionContains: filters?.subdivisionContains ?? '',
    subdivisionExcludes: filters?.subdivisionExcludes ?? '',
    weekdays: filters?.weekdays ?? [],
    tagFilters: filters?.tagFilters ?? [],
  }));

  // Helpers for comma-separated definition code lists
  const inclCodes = draft.includeDefinitionCodes?.join(', ') ?? '';
  const exclCodes = draft.excludeDefinitionCodes?.join(', ') ?? '';

  const parseCodes = (s: string): string[] =>
    s.split(',').map(c => c.trim().toUpperCase()).filter(Boolean);

  const toggleWeekday = (wd: number) => {
    const current = draft.weekdays ?? [];
    setDraft(d => ({
      ...d,
      weekdays: current.includes(wd) ? current.filter(w => w !== wd) : [...current, wd],
    }));
  };

  const addTagRule = () => {
    setDraft(d => ({ ...d, tagFilters: [...(d.tagFilters ?? []), { key: '', value: '' }] }));
  };

  const removeTagRule = (idx: number) => {
    setDraft(d => ({ ...d, tagFilters: (d.tagFilters ?? []).filter((_, i) => i !== idx) }));
  };

  const updateTagRule = (idx: number, field: 'key' | 'value', val: string) => {
    setDraft(d => ({
      ...d,
      tagFilters: (d.tagFilters ?? []).map((r, i) => i === idx ? { ...r, [field]: val } : r),
    }));
  };

  const handleApply = () => {
    // Normalise — clear empty arrays and strings so backend sees a clean object
    const normalized: DashboardGlobalFilter = {};
    const inc = parseCodes(inclCodes);
    if (inc.length > 0) normalized.includeDefinitionCodes = inc;
    const exc = parseCodes(exclCodes);
    if (exc.length > 0) normalized.excludeDefinitionCodes = exc;
    if (draft.subdivisionContains?.trim()) normalized.subdivisionContains = draft.subdivisionContains.trim();
    if (draft.subdivisionExcludes?.trim()) normalized.subdivisionExcludes = draft.subdivisionExcludes.trim();
    if ((draft.weekdays ?? []).length > 0) normalized.weekdays = draft.weekdays;
    const tags = (draft.tagFilters ?? []).filter(r => r.key.trim());
    if (tags.length > 0) normalized.tagFilters = tags.map(r => ({
      key: r.key.trim(),
      value: r.value?.trim() || undefined,
    }));
    const isEmpty = Object.keys(normalized).length === 0;
    onApply(isEmpty ? null : normalized);
  };

  const handleClear = () => {
    onApply(null);
  };

  return (
    <div className="filters-popover" role="dialog" aria-label="Dashboard filters">
      <div className="filters-popover-header">
        <span className="filters-popover-title">Dashboard Filters</span>
        <button className="filters-popover-close" onClick={onClose} aria-label="Close">&#x2715;</button>
      </div>

      <div className="filters-popover-body">
        <div className="filter-section">
          <label className="filter-label">Include definitions (comma-separated codes)</label>
          <input
            className="filter-input"
            type="text"
            placeholder="e.g. READ, EST"
            value={inclCodes}
            onChange={e => setDraft(d => ({ ...d, includeDefinitionCodes: parseCodes(e.target.value) }))}
          />
        </div>

        <div className="filter-section">
          <label className="filter-label">Exclude definitions</label>
          <input
            className="filter-input"
            type="text"
            placeholder="e.g. TIM"
            value={exclCodes}
            onChange={e => setDraft(d => ({ ...d, excludeDefinitionCodes: parseCodes(e.target.value) }))}
          />
        </div>

        <div className="filter-section">
          <label className="filter-label">Subdivision contains</label>
          <input
            className="filter-input"
            type="text"
            placeholder="case-insensitive substring"
            value={draft.subdivisionContains ?? ''}
            onChange={e => setDraft(d => ({ ...d, subdivisionContains: e.target.value }))}
          />
        </div>

        <div className="filter-section">
          <label className="filter-label">Subdivision excludes</label>
          <input
            className="filter-input"
            type="text"
            placeholder="case-insensitive substring"
            value={draft.subdivisionExcludes ?? ''}
            onChange={e => setDraft(d => ({ ...d, subdivisionExcludes: e.target.value }))}
          />
        </div>

        <div className="filter-section">
          <label className="filter-label">Weekdays (analytical, 05:00 boundary)</label>
          <div className="filter-weekday-row">
            {WEEKDAY_OPTIONS.map(wd => (
              <button
                key={wd.value}
                className={`filter-weekday-btn${(draft.weekdays ?? []).includes(wd.value) ? ' active' : ''}`}
                onClick={() => toggleWeekday(wd.value)}
              >
                {wd.label}
              </button>
            ))}
          </div>
        </div>

        <div className="filter-section">
          <div className="filter-label-row">
            <label className="filter-label">Tag filters</label>
            <button className="filter-add-btn" onClick={addTagRule}>+ Add</button>
          </div>
          {(draft.tagFilters ?? []).map((rule, idx) => (
            <div key={idx} className="filter-tag-row">
              <input
                className="filter-input filter-tag-key"
                type="text"
                placeholder="key"
                value={rule.key}
                onChange={e => updateTagRule(idx, 'key', e.target.value)}
              />
              <span className="filter-tag-sep">=</span>
              <input
                className="filter-input filter-tag-val"
                type="text"
                placeholder="value (optional)"
                value={rule.value ?? ''}
                onChange={e => updateTagRule(idx, 'value', e.target.value)}
              />
              <button className="filter-remove-btn" onClick={() => removeTagRule(idx)}>&#x2715;</button>
            </div>
          ))}
        </div>
      </div>

      <div className="filters-popover-footer">
        <button className="filter-btn-clear" onClick={handleClear}>Clear all</button>
        <button className="filter-btn-apply" onClick={handleApply}>Apply</button>
      </div>
    </div>
  );
}

function TemporalBar({ entryMode, currentView }: { entryMode?: EntryMode; currentView?: AppView }) {
  const {
    startDate,
    endDate,
    activePreset,
    smallPeriod,
    setPreset,
    navigate,
    setSmallPeriod,
    setStartDate,
    setEndDate,
    navigateBack,
    navigateForward,
  } = useTemporalContext();

  const { activeFilters, saveFilters } = useDashboardContext();

  const [showDateEditors, setShowDateEditors] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const filtersBtnRef = useRef<HTMLDivElement>(null);

  const isEntryContext = entryMode !== undefined;
  // Single-date mode: entry context OR Day preset — show one date, not a range.
  const isSingleDate = isEntryContext || activePreset === 'day';

  // Close filters popover on outside click
  useEffect(() => {
    if (!showFilters) return;
    const handler = (e: MouseEvent) => {
      if (filtersBtnRef.current && !filtersBtnRef.current.contains(e.target as Node)) {
        setShowFilters(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showFilters]);

  // Data Entry has its own date nav and mode toggle inside its card,
  // and doesn't use dashboard filters — collapse the top bar entirely.
  // (Early return placed after hooks to respect rules-of-hooks.)
  if (isEntryContext) return null;

  const filterCount = countActiveFilters(activeFilters);

  // The "last day" (inclusive) for the end-date input: endDate - 1 day.
  // Same DST caveat as formatRangeLabel — subtracting 86 400 000 ms fails
  // across spring-forward. addDays(endDate, -1) is local-time safe.
  const lastInclusiveDay = addDays(endDate, -1);

  const handleStartDateChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.value) return;
    const picked = parseLocalDate(e.target.value);
    if (isSingleDate) {
      // Keep preset='day'; update both bounds atomically via navigate.
      navigate('day', picked);
    } else {
      setStartDate(picked);
    }
  };

  const handleEndDateChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.value) return;
    // User picks the last inclusive day; we store exclusive endDate = that day + 1.
    const picked = parseLocalDate(e.target.value);
    const exclusive = new Date(picked);
    exclusive.setDate(exclusive.getDate() + 1);
    setEndDate(exclusive);
  };

  const handleFiltersApply = async (f: DashboardGlobalFilter | null) => {
    await saveFilters(f);
    setShowFilters(false);
  };

  const rangeLabel = formatRangeLabel(startDate, endDate, activePreset);
  const navTitle = activePreset !== 'custom' ? activePreset : 'range';

  return (
    <div className="top-toolbar">
      {/* Preset buttons */}
      <div className="segmented-control">
        {BIG_PERIODS.map((period) => (
          <button
            key={period.value}
            className={activePreset === period.value ? 'active' : ''}
            onClick={() => setPreset(period.value)}
          >
            {period.label}
          </button>
        ))}
      </div>

      {/* Group-by selector */}
      <select
        value={smallPeriod}
        onChange={(e) => setSmallPeriod(e.target.value as SmallPeriod)}
        className="temporal-select"
        title="Group by"
      >
        {SMALL_PERIODS.map((period) => (
          <option key={period.value} value={period.value}>
            {period.label}
          </option>
        ))}
      </select>

      {/* Navigation + date range display */}
      <div className="temporal-navigation">
        <button className="nav-btn" onClick={navigateBack} title={`Previous ${navTitle}`}>&#8249;</button>

        <div className="date-range-container">
          <button
            className={`date-range-btn${activePreset === 'custom' ? ' custom' : ''}`}
            onClick={() => setShowDateEditors(!showDateEditors)}
            title="Edit date range"
          >
            {rangeLabel}
          </button>

          {showDateEditors && (
            <div className="date-range-editors">
              <label className="date-editor-label">{isSingleDate ? 'Date' : 'From'}</label>
              <input
                type="date"
                className="date-picker-input"
                value={formatDateParam(startDate)}
                onChange={handleStartDateChange}
              />
              {!isSingleDate && (
                <>
                  <label className="date-editor-label">To (inclusive)</label>
                  <input
                    type="date"
                    className="date-picker-input"
                    value={formatDateParam(lastInclusiveDay)}
                    onChange={handleEndDateChange}
                  />
                </>
              )}
              <button
                className="date-editors-close"
                onClick={() => setShowDateEditors(false)}
              >
                Done
              </button>
            </div>
          )}
        </div>

        <button className="nav-btn" onClick={navigateForward} title={`Next ${navTitle}`}>&#8250;</button>
      </div>

      {currentView === 'calendar' && <CalendarToolbarControls />}

      {/* Filters button */}
      <div className="filters-btn-container" ref={filtersBtnRef}>
        <button
          className={`toolbar-filters-btn${filterCount > 0 ? ' active' : ''}`}
          onClick={() => setShowFilters(!showFilters)}
          title="Dashboard filters"
        >
          Filters{filterCount > 0 && <span className="filter-badge">{filterCount}</span>}
        </button>
        {showFilters && (
          <FiltersPopover
            filters={activeFilters}
            onApply={handleFiltersApply}
            onClose={() => setShowFilters(false)}
          />
        )}
      </div>
    </div>
  );
}

function CalendarToolbarControls() {
  const { zoomLevel, setZoomLevel, viewMode, setViewMode } = useCalendarSettings();
  const { startDate, setStartDate } = useTemporalContext();

  return (
    <div className="calendar-toolbar-controls" aria-label="Calendar controls">
      <div className="calendar-zoom-group" title="Vertical zoom">
        <button
          className="calendar-icon-btn"
          onClick={() => setZoomLevel((z) => getNextZoom(z, -1))}
          disabled={zoomLevel <= ZOOM_MIN + 0.001}
          aria-label="Zoom out"
          title="Zoom out"
        >−</button>
        <span className="calendar-zoom-value">{Math.round(zoomLevel * 100)}%</span>
        <button
          className="calendar-icon-btn"
          onClick={() => setZoomLevel((z) => getNextZoom(z, +1))}
          disabled={zoomLevel >= ZOOM_MAX - 0.001}
          aria-label="Zoom in"
          title="Zoom in"
        >+</button>
      </div>
      <div className="calendar-viewmode-group" role="tablist" aria-label="View mode">
        <button
          className={`calendar-viewmode-btn${viewMode === '7day' ? ' active' : ''}`}
          onClick={() => setViewMode('7day')}
          role="tab"
          aria-selected={viewMode === '7day'}
        >7d</button>
        <button
          className={`calendar-viewmode-btn${viewMode === '3day' ? ' active' : ''}`}
          onClick={() => setViewMode('3day')}
          role="tab"
          aria-selected={viewMode === '3day'}
        >3d</button>
      </div>
      {viewMode === '3day' && (
        <div className="calendar-nav3-group" aria-label="3-day navigation">
          <button
            className="calendar-icon-btn"
            onClick={() => setStartDate(addDaysLocal(startDate, -3))}
            title="Previous 3 days"
            aria-label="Previous 3 days"
          >‹</button>
          <button
            className="calendar-icon-btn"
            onClick={() => setStartDate(addDaysLocal(startDate, +3))}
            title="Next 3 days"
            aria-label="Next 3 days"
          >›</button>
        </div>
      )}
    </div>
  );
}

// ============================================
// Dashboard Selector Component
// ============================================

// ============================================
// Sidebar Component
// ============================================

function Sidebar({
  currentView,
  onViewChange,
  collapsed,
  onToggle,
}: {
  currentView: AppView;
  onViewChange: (view: AppView) => void;
  collapsed: boolean;
  onToggle: () => void;
}) {
  const {
    dashboards, activeDashboardId, loading,
    setActiveDashboardId, createNewDashboard,
    renameDashboard, deleteDashboardById,
  } = useDashboardContext();
  const [dashboardsOpen, setDashboardsOpen] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);

  // Inline rename state — only one dashboard can be in-rename at a time.
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');

  const handleCreate = async () => {
    if (!newName.trim()) return;
    setCreating(true);
    await createNewDashboard(newName.trim());
    setNewName('');
    setShowCreate(false);
    setCreating(false);
  };

  const startRename = (id: string, currentName: string) => {
    setRenamingId(id);
    setRenameValue(currentName);
  };

  const commitRename = async () => {
    if (!renamingId) return;
    const next = renameValue.trim();
    const current = dashboards.find(d => d.id === renamingId)?.name ?? '';
    if (next && next !== current) {
      await renameDashboard(renamingId, next);
    }
    setRenamingId(null);
    setRenameValue('');
  };

  const cancelRename = () => {
    setRenamingId(null);
    setRenameValue('');
  };

  const handleDelete = async (id: string, name: string, widgetCount?: number) => {
    const widgetSuffix = widgetCount && widgetCount > 0
      ? ` and its ${widgetCount} widget${widgetCount === 1 ? '' : 's'}`
      : ' and all its widgets';
    if (!window.confirm(`Delete dashboard "${name}"${widgetSuffix}?\n\nThis cannot be undone.`)) {
      return;
    }
    await deleteDashboardById(id);
  };

  return (
    <nav className={`sidebar ${collapsed ? 'sidebar-collapsed' : ''}`}>
      {/* Collapse toggle */}
      <button className="sidebar-toggle" onClick={onToggle} title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}>
        {collapsed ? (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6" /></svg>
        ) : (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6" /></svg>
        )}
      </button>

      {/* Dashboard section (collapsible) */}
      <div className="sidebar-section">
        <button
          className={`sidebar-section-header ${currentView === 'dashboard' ? 'active-section' : ''}`}
          onClick={() => {
            if (collapsed) {
              onToggle();
            }
            setDashboardsOpen(!dashboardsOpen);
          }}
          title="Dashboard"
        >
          <span className="sidebar-folder-icon">
            {dashboardsOpen && !collapsed ? (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" /><line x1="2" y1="10" x2="22" y2="10" /></svg>
            ) : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" /></svg>
            )}
          </span>
          {!collapsed && <span>Dashboard</span>}
        </button>

        {dashboardsOpen && !collapsed && (
          <div className="sidebar-section-items">
            {loading && dashboards.length === 0 ? (
              <div className="sidebar-item disabled">Loading...</div>
            ) : (
              <>
                {dashboards.map((d) => {
                  const isActive = currentView === 'dashboard' && activeDashboardId === d.id;
                  const isRenaming = renamingId === d.id;
                  return (
                    <div
                      key={d.id}
                      className={`sidebar-dash-row${isActive ? ' active' : ''}`}
                    >
                      {isRenaming ? (
                        <input
                          autoFocus
                          className="sidebar-dash-rename"
                          value={renameValue}
                          onChange={e => setRenameValue(e.target.value)}
                          onBlur={commitRename}
                          onKeyDown={e => {
                            if (e.key === 'Enter') commitRename();
                            else if (e.key === 'Escape') cancelRename();
                          }}
                        />
                      ) : (
                        <button
                          className="sidebar-dash-name"
                          onClick={() => {
                            setActiveDashboardId(d.id);
                            if (currentView !== 'dashboard') onViewChange('dashboard');
                          }}
                          onDoubleClick={() => startRename(d.id, d.name)}
                          title={d.name}
                        >
                          {d.name}
                        </button>
                      )}
                      {!isRenaming && (
                        <div className="sidebar-dash-actions">
                          <button
                            className="sidebar-dash-icon-btn"
                            title="Rename"
                            onClick={(e) => { e.stopPropagation(); startRename(d.id, d.name); }}
                          >
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                            </svg>
                          </button>
                          <button
                            className="sidebar-dash-icon-btn sidebar-dash-icon-danger"
                            title="Delete dashboard and its widgets"
                            onClick={(e) => { e.stopPropagation(); handleDelete(d.id, d.name); }}
                          >
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <polyline points="3 6 5 6 21 6" />
                              <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                              <path d="M10 11v6" />
                              <path d="M14 11v6" />
                              <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
                            </svg>
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
                {!showCreate ? (
                  <button
                    className="sidebar-item sidebar-create-btn"
                    onClick={() => setShowCreate(true)}
                  >
                    + Create Dashboard
                  </button>
                ) : (
                  <div className="sidebar-create-form">
                    <input
                      type="text"
                      placeholder="Name"
                      value={newName}
                      onChange={(e) => setNewName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') handleCreate();
                        if (e.key === 'Escape') setShowCreate(false);
                      }}
                      autoFocus
                    />
                    <div className="sidebar-create-actions">
                      <button onClick={handleCreate} disabled={creating || !newName.trim()}>
                        {creating ? '...' : 'Add'}
                      </button>
                      <button className="cancel" onClick={() => setShowCreate(false)}>
                        &times;
                      </button>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>

      {/* Data Entry */}
      <button
        className={`sidebar-nav-item ${currentView === 'entry' ? 'active' : ''}`}
        onClick={() => onViewChange('entry')}
        title="Data Entry"
      >
        {collapsed ? (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" /><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" /></svg>
        ) : (
          <>
            <svg className="sidebar-nav-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" /><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" /></svg>
            Data Entry
          </>
        )}
      </button>

      {/* Calendar */}
      <button
        className={`sidebar-nav-item ${currentView === 'calendar' ? 'active' : ''}`}
        onClick={() => onViewChange('calendar')}
        title="Calendar"
      >
        {collapsed ? (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2" /><line x1="16" y1="2" x2="16" y2="6" /><line x1="8" y1="2" x2="8" y2="6" /><line x1="3" y1="10" x2="21" y2="10" /></svg>
        ) : (
          <>
            <svg className="sidebar-nav-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2" /><line x1="16" y1="2" x2="16" y2="6" /><line x1="8" y1="2" x2="8" y2="6" /><line x1="3" y1="10" x2="21" y2="10" /></svg>
            Calendar
          </>
        )}
      </button>

      {/* Definitions */}
      <button
        className={`sidebar-nav-item ${currentView === 'definitions' ? 'active' : ''}`}
        onClick={() => onViewChange('definitions')}
        title="Definitions"
      >
        {collapsed ? (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" /><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" /></svg>
        ) : (
          <>
            <svg className="sidebar-nav-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" /><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" /></svg>
            Definitions
          </>
        )}
      </button>

      {/* Time Patterns */}
      <button
        className={`sidebar-nav-item ${currentView === 'time-patterns' ? 'active' : ''}`}
        onClick={() => onViewChange('time-patterns')}
        title="Time Patterns"
      >
        {collapsed ? (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" /><rect x="3" y="14" width="7" height="7" /><rect x="14" y="14" width="7" height="7" /></svg>
        ) : (
          <>
            <svg className="sidebar-nav-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" /><rect x="3" y="14" width="7" height="7" /><rect x="14" y="14" width="7" height="7" /></svg>
            Time Patterns
          </>
        )}
      </button>

      {/* Settings */}
      <button
        className={`sidebar-nav-item ${currentView === 'settings' ? 'active' : ''}`}
        onClick={() => onViewChange('settings')}
        title="Settings"
      >
        {collapsed ? (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>
        ) : (
          <>
            <svg className="sidebar-nav-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>
            Settings
          </>
        )}
      </button>
    </nav>
  );
}

// ============================================
// Widget Modal Component
// ============================================

interface WidgetModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSaved: () => void;
  initialData?: { widgetId?: string; name: string; dsl: string };
  mode: 'create' | 'edit';
  dashboardId: string;
  /** Inclusive lower bound (local-time midnight). */
  startDate: Date;
  /** Exclusive upper bound (local-time midnight of day after last day). */
  endDate: Date;
  smallPeriod: SmallPeriod;
}

const DEFAULT_V2_DSL = `widget "my_widget" {
  data {
    source: TIM as tims
    where: tims.parent.code in ["EST"]
    group { x: period(day) }
    measure productive = sum(tims.time("t"))
  }
  plot {
    type: bar
    x: x
    y: productive
  }
}`;

function WidgetModal({ isOpen, onClose, onSaved, initialData, mode, dashboardId, startDate, endDate, smallPeriod }: WidgetModalProps) {
  if (!isOpen) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content modal-content-wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>{mode === 'create' ? 'Create Widget' : 'Edit Widget'}</h3>
          <button className="modal-close" onClick={onClose}>&times;</button>
        </div>
        <WidgetV2Editor
          dashboardId={dashboardId}
          startDate={startDate}
          endDate={endDate}
          smallPeriod={smallPeriod}
          initialDsl={initialData?.dsl ?? DEFAULT_V2_DSL}
          initialName={initialData?.name}
          widgetId={mode === 'edit' ? initialData?.widgetId : undefined}
          onSaved={() => { onSaved(); onClose(); }}
          onCancel={onClose}
        />
      </div>
    </div>
  );
}

const EXAMPLE_WIDGET = `widget "daily_productivity" {
  data {
    source: TIM as tims
    group { x: period(day) }
    measure productive = sum(tims.time("t"))
  }
  plot {
    type: bar
    x: x
    y: productive
  }
}`;

interface DashboardWidgetsResponse {
  success: boolean;
  dashboard?: { id: string; name: string; globalFilters: DashboardGlobalFilter | null };
  widgets?: DashboardWidget[];
  error?: string;
}

// Route types
type AppView = 'dashboard' | 'runner' | 'entry' | 'calendar' | 'definitions' | 'time-patterns' | 'settings';

function parseCurrentView(): AppView {
  const params = new URLSearchParams(window.location.search);
  if (params.get('dev') === 'runner') return 'runner';
  if (params.get('view') === 'entry') return 'entry';
  if (params.get('view') === 'calendar') return 'calendar';
  if (params.get('view') === 'definitions') return 'definitions';
  if (params.get('view') === 'time-patterns') return 'time-patterns';
  if (params.get('view') === 'settings') return 'settings';
  return 'dashboard';
}


/**
 * Bridges the temporal context and global filter to TimePatternsView.
 *
 * from/to: inclusive date-string bounds derived from the global temporal context.
 * activeFilters: forwarded so Time Patterns respects the same weekday filter
 *   selected in the Filters popover (and future filter fields as they are added).
 */
function TimePatternsViewBridge() {
  const { startDate, endDate, activePreset } = useTemporalContext();
  const { activeFilters } = useDashboardContext();
  const from = formatDateParam(startDate);
  const to = formatDateParam(addDays(endDate, -1));  // endDate is exclusive
  return <TimePatternsView from={from} to={to} activeFilters={activeFilters} activePreset={activePreset} />;
}

function AppInner() {
  const [currentView, setCurrentView] = useState<AppView>(parseCurrentView);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [entryMode, setEntryMode] = useState<EntryMode>('simple');
  const { activePreset, startDate, endDate, navigate } = useTemporalContext();

  // Sync view state when browser back/forward navigation changes the URL.
  useEffect(() => {
    const handler = () => setCurrentView(parseCurrentView());
    window.addEventListener('popstate', handler);
    return () => window.removeEventListener('popstate', handler);
  }, []);

  const handleViewChange = (newView: AppView) => {
    if (newView !== currentView) {
      // ── Temporal-context transition rules ──────────────────────────────────

      if (newView === 'time-patterns' && currentView !== 'time-patterns') {
        // Entering Time Patterns: Day → containing Week only.
        if (activePreset === 'day') {
          navigate('week', startDate);
        }
      } else if (currentView === 'time-patterns' && (newView === 'dashboard' || newView === 'calendar')) {
        // Leaving Time Patterns back to analytical views.
        // If in Week and the current week contains today → snap to Day = today.
        if (activePreset === 'week') {
          const today = localMidnight(new Date());
          if (today >= startDate && today < endDate) {
            navigate('day', today);
          }
        }
      } else if (newView === 'entry' && activePreset !== 'day') {
        // Entering Data Entry: always single-day; anchor on first day of current range.
        navigate('day', startDate);
      }
    }

    // Update URL without page reload.
    const params = new URLSearchParams(window.location.search);
    params.delete('dev');
    params.delete('view');
    if (newView === 'runner') params.set('dev', 'runner');
    else if (newView !== 'dashboard') params.set('view', newView);
    const newUrl = params.toString()
      ? `${window.location.pathname}?${params.toString()}`
      : window.location.pathname;
    window.history.pushState({}, '', newUrl);

    setCurrentView(newView);
  };

  return (
    <div className="app-layout">
      <TemporalBar
        entryMode={currentView === 'entry' ? entryMode : undefined}
        currentView={currentView}
      />
      <div className="app-body">
        <Sidebar
          currentView={currentView}
          onViewChange={handleViewChange}
          collapsed={sidebarCollapsed}
          onToggle={() => setSidebarCollapsed(!sidebarCollapsed)}
        />
        <main className={`main-content${currentView === 'definitions' ? ' main-content-definitions' : ''}`}>
          {currentView === 'dashboard' ? (
            <Dashboard />
          ) : currentView === 'entry' ? (
            <DataEntryView mode={entryMode} onModeChange={setEntryMode} />
          ) : currentView === 'calendar' ? (
            <CalendarView />
          ) : currentView === 'definitions' ? (
            <DefinitionsEditor />
          ) : currentView === 'time-patterns' ? (
            <TimePatternsViewBridge />
          ) : currentView === 'settings' ? (
            <SettingsPage />
          ) : (
            <WidgetRunner />
          )}
        </main>
      </div>
    </div>
  );
}

// ============================================
// Calendar Settings Context (zoom + view mode)
// ============================================

interface CalendarSettingsContextValue {
  zoomLevel: number;
  setZoomLevel: React.Dispatch<React.SetStateAction<number>>;
  viewMode: CalendarViewMode;
  setViewMode: React.Dispatch<React.SetStateAction<CalendarViewMode>>;
}

const CalendarSettingsContext = createContext<CalendarSettingsContextValue | null>(null);

function CalendarSettingsProvider({ children }: { children: ReactNode }) {
  const [zoomLevel, setZoomLevel] = useState<number>(() => readZoomFromStorage());
  const [viewMode, setViewMode] = useState<CalendarViewMode>(() => readViewModeFromStorage());

  useEffect(() => {
    try { localStorage.setItem(ZOOM_STORAGE_KEY, String(zoomLevel)); } catch { /* ignore */ }
  }, [zoomLevel]);
  useEffect(() => {
    try { localStorage.setItem(VIEWMODE_STORAGE_KEY, viewMode); } catch { /* ignore */ }
  }, [viewMode]);

  return (
    <CalendarSettingsContext.Provider value={{ zoomLevel, setZoomLevel, viewMode, setViewMode }}>
      {children}
    </CalendarSettingsContext.Provider>
  );
}

function useCalendarSettings(): CalendarSettingsContextValue {
  const ctx = useContext(CalendarSettingsContext);
  if (!ctx) throw new Error('useCalendarSettings must be used within CalendarSettingsProvider');
  return ctx;
}

function App() {
  return (
    <SettingsProvider>
      <TemporalContextProvider>
        <DashboardContextProvider>
          <CalendarSettingsProvider>
            <AppInner />
          </CalendarSettingsProvider>
        </DashboardContextProvider>
      </TemporalContextProvider>
    </SettingsProvider>
  );
}

// ============================================
// Data Entry Types
// ============================================

interface TimingBlock {
  id?: number;
  timeInit: number;
  timeEnd: number;
  duration: number;
  netProductivity: number | null;
  subdivision: string | null;
  isPersisted: boolean; // true = from DB, false = from preview
}

// ============================================
// Day Calendar Preview Component
// ============================================

interface DayCalendarPreviewProps {
  persistedTimings: TimingBlock[];
  previewTimings: TimingBlock[];
  isLoading?: boolean;
  onDeleteTiming?: (id: number) => void;
}

function DayCalendarPreview({ persistedTimings, previewTimings, isLoading, onDeleteTiming }: DayCalendarPreviewProps) {
  // Calendar displays 00:00 to 24:00 (1440 minutes)
  const CALENDAR_HEIGHT = 720; // pixels for full day
  const MINUTES_IN_DAY = 1440;
  const HOUR_HEIGHT = CALENDAR_HEIGHT / 24;

  // Generate hour labels
  const hours = Array.from({ length: 25 }, (_, i) => i);

  // Convert minutes to pixel position
  const minutesToPixels = (minutes: number): number => {
    return (minutes / MINUTES_IN_DAY) * CALENDAR_HEIGHT;
  };

  // Get color based on net productivity
  const getProductivityColor = (netProductivity: number | null, isPersisted: boolean): string => {
    if (netProductivity === null) {
      return isPersisted ? '#e9ecef' : 'rgba(233, 236, 239, 0.6)';
    }
    // Green for high productivity, yellow for medium, orange for low
    if (netProductivity >= 0.7) {
      return isPersisted ? '#28a745' : 'rgba(40, 167, 69, 0.5)';
    } else if (netProductivity >= 0.4) {
      return isPersisted ? '#ffc107' : 'rgba(255, 193, 7, 0.5)';
    } else {
      return isPersisted ? '#fd7e14' : 'rgba(253, 126, 20, 0.5)';
    }
  };

  // Format time for tooltip
  const formatTime = (minutes: number): string => {
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
  };

  return (
    <div className="day-calendar-preview">
      {isLoading && <div className="calendar-loading">Loading...</div>}
      <div className="calendar-container">
        {/* Hour labels */}
        <div className="calendar-hours">
          {hours.map((hour) => (
            <div
              key={hour}
              className="hour-label"
              style={{ top: hour * HOUR_HEIGHT }}
            >
              {hour.toString().padStart(2, '0')}:00
            </div>
          ))}
        </div>

        {/* Timeline area */}
        <div className="calendar-timeline" style={{ height: CALENDAR_HEIGHT }}>
          {/* Hour grid lines */}
          {hours.map((hour) => (
            <div
              key={hour}
              className="hour-line"
              style={{ top: hour * HOUR_HEIGHT }}
            />
          ))}

          {/* Persisted timing blocks */}
          {persistedTimings.map((timing, index) => (
            <div
              key={`persisted-${timing.id || index}`}
              className="timing-block persisted"
              style={{
                top: minutesToPixels(timing.timeInit),
                height: Math.max(minutesToPixels(timing.duration), 4),
                backgroundColor: getProductivityColor(timing.netProductivity, true),
                position: 'absolute',
              }}
              title={`${formatTime(timing.timeInit)} - ${formatTime(timing.timeEnd)} (${timing.duration}min)\nProductivity: ${timing.netProductivity !== null ? (timing.netProductivity * 100).toFixed(0) + '%' : 'N/A'}`}
            >
              {onDeleteTiming && timing.id !== undefined && (
                <button
                  className="timing-delete-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (window.confirm(`Delete this timing block (${formatTime(timing.timeInit)} – ${formatTime(timing.timeEnd)})?\n\nThis removes the whole entry from the database.`)) {
                      onDeleteTiming(timing.id!);
                    }
                  }}
                  title="Delete this timing"
                  aria-label="Delete timing"
                >
                  ×
                </button>
              )}
            </div>
          ))}

          {/* Preview timing blocks */}
          {previewTimings.map((timing, index) => (
            <div
              key={`preview-${index}`}
              className="timing-block preview"
              style={{
                top: minutesToPixels(timing.timeInit),
                height: Math.max(minutesToPixels(timing.duration), 4),
                backgroundColor: getProductivityColor(timing.netProductivity, false),
                borderStyle: 'dashed',
              }}
              title={`[PREVIEW] ${formatTime(timing.timeInit)} - ${formatTime(timing.timeEnd)} (${timing.duration}min)\nProductivity: ${timing.netProductivity !== null ? (timing.netProductivity * 100).toFixed(0) + '%' : 'N/A'}`}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

// ============================================
// Data Entry View Component
// ============================================

const EXAMPLE_TIMING_INPUT = `# Example timing block
# Format: DEF_CODE:subdivision;attr:value,attr:value
# Then timing lines: HHMM-HHMM tokens

EST:TFG/coding;adv:10,project:thesis;tagkey:tagvalue
0900-0930 t20m10 | adv:15 | tagkey:tagvalue
0930-1015 t35m10
1030-1130 t45m15`;

function DataEntryView({ mode, onModeChange }: { mode: EntryMode; onModeChange: (mode: EntryMode) => void }) {
  const { startDate, navigateBack, navigateForward, navigate } = useTemporalContext();
  // For data entry the "entry date" is the first (and typically only) day in range.
  const entryDate = startDate;
  const [showDatePicker, setShowDatePicker] = useState(false);
  const dateBtnRef = useRef<HTMLDivElement>(null);
  const [dslInput, setDslInput] = useState(EXAMPLE_TIMING_INPUT);
  const [persistedTimings, setPersistedTimings] = useState<TimingBlock[]>([]);
  const [previewTimings, setPreviewTimings] = useState<TimingBlock[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [lineErrors, setLineErrors] = useState<Array<{ lineNumber: number; message: string }>>([]);
  const [isLoadingPersisted, setIsLoadingPersisted] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [insertSuccess, setInsertSuccess] = useState<string | null>(null);

  // Manual backup button state
  const [backupDirtyCount, setBackupDirtyCount] = useState<number>(0);
  const [isBackingUp, setIsBackingUp] = useState(false);
  const [backupMessage, setBackupMessage] = useState<{ text: string; kind: 'success' | 'error' } | null>(null);

  const refreshBackupStatus = useCallback(async () => {
    try {
      const r = await fetch(`${API_URL}/api/backup/status`);
      const ct = r.headers.get('content-type') || '';
      if (!ct.includes('application/json')) return; // server hasn't been restarted with the new routes yet
      const data = await r.json();
      if (data.success) setBackupDirtyCount((data.dirtyMonths as string[]).length);
    } catch {
      // status is best-effort
    }
  }, []);

  useEffect(() => {
    refreshBackupStatus();
  }, [refreshBackupStatus, insertSuccess]);

  const handleManualBackup = async () => {
    setIsBackingUp(true);
    setBackupMessage(null);
    try {
      const r = await fetch(`${API_URL}/api/backup/run`, { method: 'POST' });
      const ct = r.headers.get('content-type') || '';
      if (!ct.includes('application/json')) {
        setBackupMessage({
          kind: 'error',
          text: `Backup endpoint not found (HTTP ${r.status}). Restart the API server to pick up the new routes.`,
        });
        return;
      }
      const data = await r.json();
      if (data.success) {
        const regen = (data.regenerated as string[]) || [];
        setBackupMessage({
          kind: 'success',
          text: regen.length > 0 ? `Backed up: ${regen.join(', ')}` : 'Nothing to back up',
        });
      } else {
        setBackupMessage({ kind: 'error', text: `Backup error: ${data.error || 'unknown'}` });
      }
    } catch (err) {
      setBackupMessage({ kind: 'error', text: `Backup error: ${err instanceof Error ? err.message : String(err)}` });
    } finally {
      setIsBackingUp(false);
      refreshBackupStatus();
    }
  };

  // Selected definition (from SimpleEntryForm) — drives the right-panel choice
  const [selectedDefinition, setSelectedDefinition] = useState<MetricDefinitionInfo | null>(null);
  // Snapshot of form values at blur/Preview time — drives the preview row in LastEntriesTable
  const [previewFormValues, setPreviewFormValues] = useState<{ attrs: Record<string, string>; sub: string } | null>(null);

  // Reset definition state when mode changes
  useEffect(() => {
    setSelectedDefinition(null);
    setPreviewFormValues(null);
  }, [mode]);

  // Close date picker on outside click
  useEffect(() => {
    if (!showDatePicker) return;
    const handler = (e: MouseEvent) => {
      if (dateBtnRef.current && !dateBtnRef.current.contains(e.target as Node)) {
        setShowDatePicker(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showDatePicker]);

  // Show calendar when: advanced mode, or selected definition supports timings
  const showCalendar = mode === 'advanced' || (selectedDefinition?.timingCapable ?? false);

  // Simple mode: DSL generated by the form, stored here for Preview/Insert
  const simpleDslRef = useRef('');

  // Load persisted timings when entryDate changes
  useEffect(() => {
    loadPersistedTimings();
  }, [entryDate]);

  const loadPersistedTimings = async () => {
    setIsLoadingPersisted(true);
    setError(null);

    const tFetch = performance.now();
    try {
      const dateStr = formatDateParam(entryDate);
      const response = await fetch(
        `${API_URL}/api/timings?startDate=${dateStr}&endDate=${dateStr}`
      );
      const tResponse = performance.now();
      console.log(`[timings] fetch complete: ${Math.round(tResponse - tFetch)}ms`);
      const data = await response.json();
      const tParsed = performance.now();
      console.log(`[timings] JSON parse: ${Math.round(tParsed - tResponse)}ms, ${data.timings?.length ?? 0} entries`);

      if (data.success) {
        const tFilter = performance.now();
        const timings: TimingBlock[] = data.timings
          .filter((t: { timeInit: number | null; timeEnd: number | null }) => t.timeInit !== null && t.timeEnd !== null)
          .map((t: { id: number; timeInit: number; timeEnd: number; duration: number; netProductivity: number | null; subdivision: string | null }) => ({
            ...t,
            isPersisted: true,
          }));
        const tSetState = performance.now();
        console.log(`[timings] filter+map: ${Math.round(tSetState - tFilter)}ms → ${timings.length} items`);
        setPersistedTimings(timings);
        const tDone = performance.now();
        console.log(`[timings] setState done: ${Math.round(tDone - tSetState)}ms`);
      } else {
        setError(data.error || 'Failed to load timings');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error');
    } finally {
      setIsLoadingPersisted(false);
    }
  };

  // Get the current DSL input based on mode
  const getCurrentDsl = useCallback(() => {
    return mode === 'simple' ? simpleDslRef.current : dslInput;
  }, [mode, dslInput]);

  const handleClear = () => {
    setDslInput('');
    simpleDslRef.current = '';
    setPreviewTimings([]);
    setError(null);
    setLineErrors([]);
    setInsertSuccess(null);
  };

  const handlePreview = async () => {
    const currentDsl = getCurrentDsl();
    if (!currentDsl.trim()) {
      setPreviewTimings([]);
      return;
    }

    setIsProcessing(true);
    setError(null);
    setLineErrors([]);
    setInsertSuccess(null);

    try {
      const response = await fetch(`${API_URL}/api/entries/parse-preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          dslInput: currentDsl,
          entryDate: formatDateParam(entryDate),
        }),
      });
      const data = await response.json();

      if (data.success) {
        const timings: TimingBlock[] = data.timings.map((t: { timeInit: number; timeEnd: number; duration: number; netProductivity: number | null; subdivision: string | null }) => ({
          ...t,
          isPersisted: false,
        }));
        setPreviewTimings(timings);
        // Merge formula-computed field values into the preview row
        if (data.fieldValues && Object.keys(data.fieldValues).length > 0) {
          setPreviewFormValues(prev => prev
            ? { attrs: { ...prev.attrs, ...data.fieldValues }, sub: prev.sub }
            : null
          );
        }
      } else if (data.errors && Array.isArray(data.errors)) {
        // Multi-error response: annotate lines
        setLineErrors(data.errors);
        setPreviewTimings([]);
      } else {
        // Single error fallback
        const msg = data.lineNumber
          ? `Line ${data.lineNumber}: ${data.error}`
          : (data.error || 'Parse error');
        setError(msg);
        setPreviewTimings([]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error');
      setPreviewTimings([]);
    } finally {
      setIsProcessing(false);
    }
  };

  const handleInsert = async (): Promise<boolean> => {
    const currentDsl = getCurrentDsl();
    if (!currentDsl.trim()) {
      setError('No input to insert');
      return false;
    }

    setIsProcessing(true);
    setError(null);
    setInsertSuccess(null);

    const t0 = performance.now();
    try {
      const t1 = performance.now();
      const response = await fetch(`${API_URL}/api/entries/insert`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          dslInput: currentDsl,
          entryDate: formatDateParam(entryDate),
        }),
      });
      const data = await response.json();
      const t2 = performance.now();
      console.log(`[insert] fetch /api/entries/insert: ${Math.round(t2 - t1)}ms`);

      if (data.success) {
        setInsertSuccess(`Successfully inserted ${data.insertedCount} entries`);
        setPreviewTimings([]);
        // Reload persisted timings to show newly inserted entries
        const t3 = performance.now();
        await loadPersistedTimings();
        const t4 = performance.now();
        console.log(`[insert] loadPersistedTimings (/api/timings): ${Math.round(t4 - t3)}ms`);
        console.log(`[insert] total handleInsert (button→data ready): ${Math.round(t4 - t0)}ms`);
        return true;
      } else {
        setError(data.error || 'Insert error');
        if (data.lineNumber) {
          setError(`Line ${data.lineNumber}: ${data.error}`);
        }
        return false;
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error');
      return false;
    } finally {
      setIsProcessing(false);
      console.log(`[insert] setIsProcessing(false) at: ${Math.round(performance.now() - t0)}ms`);
    }
  };

  const handleSimpleDslGenerated = useCallback((dsl: string) => {
    simpleDslRef.current = dsl;
  }, []);

  const handleDeleteTiming = useCallback(async (id: number) => {
    setError(null);
    setInsertSuccess(null);
    try {
      const r = await fetch(`${API_URL}/api/entries/${id}`, { method: 'DELETE' });
      const ct = r.headers.get('content-type') || '';
      if (!ct.includes('application/json')) {
        setError(`Delete endpoint not found (HTTP ${r.status}). Restart the API server to pick up the new routes.`);
        return;
      }
      const data = await r.json();
      if (!data.success) {
        setError(`Delete error: ${data.error || 'unknown'}`);
        return;
      }
      setInsertSuccess('Entry deleted');
      await loadPersistedTimings();
    } catch (err) {
      setError(`Delete error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, []);

  return (
    <div className="data-entry-view">
      <div className="data-entry-grid">
        {/* Input Panel */}
        <div className="data-entry-input-panel">
          <div className="entry-panel-header">
            <span className="panel-title">
              {mode === 'simple' ? 'New Entry' : 'Raw Input'}
            </span>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <button
                className="btn-text"
                onClick={handleManualBackup}
                disabled={isBackingUp}
                title={backupDirtyCount > 0
                  ? `Regenerate ${backupDirtyCount} dirty month${backupDirtyCount === 1 ? '' : 's'}`
                  : 'No months are dirty — runs anyway'}
              >
                {isBackingUp
                  ? 'Backing up…'
                  : `Backup${backupDirtyCount > 0 ? ` (${backupDirtyCount})` : ''}`}
              </button>
              <ModeToggle mode={mode} onChange={onModeChange} />
            </div>
          </div>
          {backupMessage && (
            <div className={backupMessage.kind === 'error' ? 'entry-error' : 'entry-success'} style={{ marginTop: 4 }}>
              {backupMessage.text}
            </div>
          )}

          <div className="simple-attribute-row entry-date-row">
            <span className="simple-attr-name">Date</span>
            <div className="simple-attr-input-col">
              <div className="entry-date-control" ref={dateBtnRef}>
                <button className="nav-btn" onClick={navigateBack} title="Previous day">&#8249;</button>
                <div className="date-range-container">
                  <button
                    className="date-range-btn"
                    onClick={() => setShowDatePicker(!showDatePicker)}
                    title="Select date"
                  >
                    {entryDate.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}
                  </button>
                  {showDatePicker && (
                    <div className="date-range-editors">
                      <label className="date-editor-label">Date</label>
                      <input
                        type="date"
                        className="date-picker-input"
                        value={formatDateParam(entryDate)}
                        onChange={(e) => {
                          if (!e.target.value) return;
                          navigate('day', parseLocalDate(e.target.value));
                          setShowDatePicker(false);
                        }}
                      />
                      <button className="date-editors-close" onClick={() => setShowDatePicker(false)}>Done</button>
                    </div>
                  )}
                </div>
                <button className="nav-btn" onClick={navigateForward} title="Next day">&#8250;</button>
              </div>
            </div>
          </div>

          {mode === 'advanced' ? (
            <>
              <textarea
                className="dsl-textarea"
                value={dslInput}
                onChange={(e) => setDslInput(e.target.value)}
                placeholder="Enter timing DSL..."
                rows={20}
                disabled={isProcessing}
              />

              <div className="panel-actions-bottom">
                <button
                  className="btn-text"
                  onClick={handleClear}
                  disabled={isProcessing}
                >
                  Clear
                </button>
                <button
                  className="btn-outline"
                  onClick={handlePreview}
                  disabled={isProcessing || !dslInput.trim()}
                >
                  {isProcessing ? 'Processing...' : 'Preview'}
                </button>
                <button
                  className="btn-contained-sm"
                  onClick={handleInsert}
                  disabled={isProcessing || !dslInput.trim()}
                >
                  Insert
                </button>
              </div>

              {error && (
                <div className="entry-error">
                  <strong>Error:</strong> {error}
                </div>
              )}

              {lineErrors.length > 0 && (
                <div className="error-annotation-view">
                  {dslInput.split('\n').map((line, idx) => {
                    const globalLine = idx + 1;
                    const err = lineErrors.find((e) => e.lineNumber === globalLine);
                    return (
                      <div key={idx} className={`annotation-line${err ? ' annotation-line-error' : ''}`}>
                        <span className="annotation-text">{line || '\u00A0'}</span>
                        {err && <span className="annotation-error-marker"> &lt;&lt; {err.message}</span>}
                      </div>
                    );
                  })}
                </div>
              )}

              {insertSuccess && (
                <div className="entry-success">
                  {insertSuccess}
                </div>
              )}
            </>
          ) : (
            <SimpleEntryForm
              onDslGenerated={handleSimpleDslGenerated}
              onPreview={handlePreview}
              onInsert={handleInsert}
              onClear={handleClear}
              isProcessing={isProcessing}
              error={error}
              insertSuccess={insertSuccess}
              onDefinitionChange={setSelectedDefinition}
              onFormStateChange={(attrs, sub) => {
                setPreviewFormValues({ attrs, sub });
                const dsl = simpleDslRef.current;
                if (!dsl.trim()) return;
                fetch(`${API_URL}/api/entries/parse-preview`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ dslInput: dsl, entryDate: formatDateParam(entryDate) }),
                })
                  .then(r => r.json())
                  .then(data => {
                    if (data.success && data.fieldValues) {
                      setPreviewFormValues({ attrs: { ...attrs, ...data.fieldValues }, sub });
                    }
                  })
                  .catch(() => { });
              }}
            />
          )}
        </div>

        {/* Preview Panel — calendar for timing definitions, last entries table otherwise */}
        <div className="data-entry-preview-panel">
          {showCalendar ? (
            <>
              <div className="panel-title-row">
                <span className="panel-title">Preview</span>
                <div className="preview-legend">
                  <span className="legend-item persisted">Persisted</span>
                  <span className="legend-item preview">Preview</span>
                </div>
              </div>
              <DayCalendarPreview
                persistedTimings={persistedTimings}
                previewTimings={previewTimings}
                isLoading={isLoadingPersisted}
                onDeleteTiming={handleDeleteTiming}
              />
            </>
          ) : (
            <LastEntriesTable
              definition={selectedDefinition}
              previewValues={previewFormValues}
              refreshTrigger={insertSuccess}
            />
          )}
        </div>
      </div>
    </div>
  );
}

// ============================================
// Calendar View Component (Week View)
// ============================================

interface CalendarTiming {
  id: string;
  definitionCode: string;
  timeInit: number;
  timeEnd: number;
  duration: number;
  tValue: number | null;
  mValue: number | null;
  pValue: number | null;
  nValue: number | null;
  netProductivity: number | null;
  subdivision: string | null;
  timestamp: string;
  /** Full label map: subdivision string (e.g. "t", "m/thk") → minutes. */
  timeLabels?: Record<string, number>;
  /** Parent metric definition code (e.g. "EST", "WORK") — null if TIM is orphan. */
  parentDefinitionCode?: string | null;
  /** Parent metric's category (top-level or hierarchical, e.g. "productive/uni"). */
  parentCategory?: string | null;
  // Future: mainKpi and secondaryKpi will come from definition-level config
}

// Get Monday of the week containing the given date
function getWeekStart(date: Date): Date {
  const d = new Date(date);
  const day = d.getDay();
  // Adjust: Sunday (0) -> 6, Monday (1) -> 0, etc.
  const diff = day === 0 ? 6 : day - 1;
  d.setDate(d.getDate() - diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

// Format date as YYYY-MM-DD in local timezone for comparison
function dateKey(date: Date): string {
  const year = date.getFullYear();
  const month = (date.getMonth() + 1).toString().padStart(2, '0');
  const day = date.getDate().toString().padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// Day names
const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

// Height thresholds (px) for showing text inside timing blocks
const BLOCK_LINE1_MIN_HEIGHT = 20;
const BLOCK_LINE2_MIN_HEIGHT = 36;

// KPI config per definition — future: read from definition-level mainKpi/secondaryKpi attributes
type KpiKey = 'tValue' | 'netProductivity' | 'duration';
interface CalendarKpiConfig {
  mainKpi: { key: KpiKey };
  secondaryKpi: { key: KpiKey };
}

const DEFAULT_CALENDAR_KPI: CalendarKpiConfig = {
  mainKpi: { key: 'tValue' },
  secondaryKpi: { key: 'netProductivity' },
};

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function getCalendarKpiConfig(_definitionCode: string): CalendarKpiConfig {
  // Future: look up definition-level mainKpi/secondaryKpi attributes
  return DEFAULT_CALENDAR_KPI;
}

function formatMinutesCompact(minutes: number): string {
  if (minutes >= 60) {
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return m > 0 ? `${h}h${m.toString().padStart(2, '0')}` : `${h}h`;
  }
  return `${minutes}'`;
}

function formatKpiForBlock(key: KpiKey, value: number | null): string {
  if (value === null) return '—';
  if (key === 'netProductivity') return (value * 10).toFixed(1);
  if (key === 'tValue' || key === 'duration') return formatMinutesCompact(value);
  return value.toString();
}

// CalendarBlock — a unit rendered in the calendar. Either a single timing or a
// merged "session" of consecutive timings sharing definition + subdivision root,
// with similar net productivity, separated by ≤ SESSION_MAX_GAP_MIN minutes.
interface CalendarBlock {
  id: string;
  isSession: boolean;
  count: number;
  definitionCode: string;
  subdivisionRoot: string | null;
  subdivision: string | null;
  timeInit: number;
  timeEnd: number;
  totalDuration: number;
  totalT: number;
  totalM: number;
  totalP: number;
  totalN: number;
  netProductivity: number | null;
  internalProductivity: number | null;
  /** Parent metric's category at the time the block was constructed; sessions inherit from first timing. */
  parentCategory: string | null;
  /** Parent metric's code (e.g. "EST"); used as a stable label and as fallback color seed. */
  parentDefinitionCode: string | null;
  timings: CalendarTiming[];
}

type CalendarViewMode = '7day' | '3day';

const BASE_HOUR_HEIGHT = 30;
const ZOOM_STEPS = [0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0, 4.0];
const ZOOM_MIN = ZOOM_STEPS[0];
const ZOOM_MAX = ZOOM_STEPS[ZOOM_STEPS.length - 1];
const ZOOM_DEFAULT = 1.5;
const ZOOM_STORAGE_KEY = 'calendar.zoomLevel';
const VIEWMODE_STORAGE_KEY = 'calendar.viewMode';

function readZoomFromStorage(): number {
  try {
    const v = localStorage.getItem(ZOOM_STORAGE_KEY);
    if (v) {
      const n = parseFloat(v);
      if (Number.isFinite(n) && n >= ZOOM_MIN && n <= ZOOM_MAX) return n;
    }
  } catch { /* ignore */ }
  return ZOOM_DEFAULT;
}

function readViewModeFromStorage(): CalendarViewMode {
  try {
    const v = localStorage.getItem(VIEWMODE_STORAGE_KEY);
    if (v === '3day' || v === '7day') return v;
  } catch { /* ignore */ }
  return '7day';
}

function getNextZoom(current: number, dir: 1 | -1): number {
  let idx = ZOOM_STEPS.findIndex((z) => Math.abs(z - current) < 0.01);
  if (idx < 0) {
    let best = 0, bd = Infinity;
    for (let i = 0; i < ZOOM_STEPS.length; i++) {
      const d = Math.abs(ZOOM_STEPS[i] - current);
      if (d < bd) { bd = d; best = i; }
    }
    idx = best;
  }
  const next = idx + dir;
  if (next < 0 || next >= ZOOM_STEPS.length) return current;
  return ZOOM_STEPS[next];
}

function getNDays(anchor: Date, count: number): Date[] {
  const out: Date[] = [];
  for (let i = 0; i < count; i++) {
    const d = new Date(anchor);
    d.setHours(0, 0, 0, 0);
    d.setDate(anchor.getDate() + i);
    out.push(d);
  }
  return out;
}

function addDaysLocal(d: Date, n: number): Date {
  const r = new Date(d);
  r.setDate(d.getDate() + n);
  return r;
}

function timingInternalProd(t: CalendarTiming): number | null {
  const tv = t.tValue ?? 0;
  const mv = t.mValue ?? 0;
  const denom = tv + mv;
  return denom > 0 ? tv / denom : null;
}

// Stable color per definition code — derives a hue from a string hash.
// Used for the thin colored stripe on each block's left edge.
function hashCode(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h * 31) + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function definitionColor(code: string): string {
  const hue = hashCode(code) % 360;
  return `hsl(${hue}, 55%, 50%)`;
}

/**
 * Color for a calendar block's left-edge stripe.
 * Prefers the user's configured category color (with hierarchical inheritance);
 * falls back to a stable hash of the parent metric code, or "TIM" when orphaned.
 */
function blockStripeColor(
  parentCategory: string | null,
  parentDefinitionCode: string | null,
  categoryColors: Record<string, string>
): string {
  const fromCategory = colorForCategory(categoryColors, parentCategory);
  if (fromCategory) return fromCategory;
  return definitionColor(parentDefinitionCode || 'TIM');
}

const SESSION_MAX_GAP_MIN = 5;
const SESSION_MAX_NETPROD_DELTA = 0.20;

// Per-category colors for the day-summary stacked bar and breakdown chips.
// (Fallback only — actual rendering reads colors from user_settings via SettingsContext.)
const CAT_COLORS = { t: '#b8e6c8', m: '#fde68a', p: '#f8c4c4', n: '#e8e8e8' } as const;

/** Sum minutes across a set of timings, grouped by base letter (top of subdivision). */
function sumLetterTotals(timings: CalendarTiming[]): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const t of timings) {
    const labels = t.timeLabels;
    if (labels) {
      for (const [sub, value] of Object.entries(labels)) {
        const base = sub.split('/')[0];
        totals[base] = (totals[base] ?? 0) + value;
      }
    } else {
      // Legacy fallback for entries without a timeLabels map.
      if (t.tValue) totals.t = (totals.t ?? 0) + t.tValue;
      if (t.mValue) totals.m = (totals.m ?? 0) + t.mValue;
      if (t.pValue) totals.p = (totals.p ?? 0) + t.pValue;
      if (t.nValue) totals.n = (totals.n ?? 0) + t.nValue;
    }
  }
  return totals;
}

function getSubdivisionRoot(sub: string | null): string | null {
  if (!sub) return null;
  return sub.split('/')[0];
}

function getProductivityColor(netProductivity: number | null): string {
  if (netProductivity === null) return '#e8e8e8';
  if (netProductivity >= 0.8) return '#b8e6c8';
  if (netProductivity >= 0.7) return '#c8f0d0';
  if (netProductivity >= 0.6) return '#fde68a';
  if (netProductivity >= 0.4) return '#ffe0b2';
  return '#f8c4c4';
}

function formatTimeOfDay(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
}

function isTodayDate(date: Date): boolean {
  return dateKey(date) === dateKey(new Date());
}

interface DaySummary {
  t: number;
  m: number;
  p: number;
  n: number;
  total: number;
  netProd: number | null;
}

function computeDaySummary(dayTimings: CalendarTiming[]): DaySummary {
  let t = 0, m = 0, p = 0, n = 0;
  for (const x of dayTimings) {
    t += x.tValue ?? 0;
    m += x.mValue ?? 0;
    p += x.pValue ?? 0;
    n += x.nValue ?? 0;
  }
  const denom = t + m + p;
  return { t, m, p, n, total: t + m + p + n, netProd: denom > 0 ? t / denom : null };
}

function singletonBlock(t: CalendarTiming): CalendarBlock {
  return {
    id: t.id,
    isSession: false,
    count: 1,
    definitionCode: t.definitionCode,
    subdivisionRoot: getSubdivisionRoot(t.subdivision),
    subdivision: t.subdivision,
    timeInit: t.timeInit,
    timeEnd: t.timeEnd,
    totalDuration: t.duration,
    totalT: t.tValue ?? 0,
    totalM: t.mValue ?? 0,
    totalP: t.pValue ?? 0,
    totalN: t.nValue ?? 0,
    netProductivity: t.netProductivity,
    internalProductivity: timingInternalProd(t),
    parentCategory: t.parentCategory ?? null,
    parentDefinitionCode: t.parentDefinitionCode ?? null,
    timings: [t],
  };
}

function mergeIntoSessions(timings: CalendarTiming[]): CalendarBlock[] {
  if (timings.length === 0) return [];
  const sorted = [...timings].sort((a, b) => a.timeInit - b.timeInit);
  const blocks: CalendarBlock[] = [];
  let current: CalendarBlock | null = null;

  for (const t of sorted) {
    if (current === null) {
      current = singletonBlock(t);
      continue;
    }
    // Sessions only merge if same TIM-parent metric AND same subdivision root.
    // (definitionCode is always "TIM" today; the meaningful distinction is the parent.)
    const sameDef = current.definitionCode === t.definitionCode
      && current.parentDefinitionCode === (t.parentDefinitionCode ?? null);
    const sameSub = current.subdivisionRoot === getSubdivisionRoot(t.subdivision);
    const gap = t.timeInit - current.timeEnd;
    const closeEnough = gap >= 0 && gap <= SESSION_MAX_GAP_MIN;
    const cur = current.netProductivity;
    const cand = t.netProductivity;
    const prodOk =
      cur === null && cand === null
        ? true
        : cur !== null && cand !== null
          ? Math.abs(cur - cand) <= SESSION_MAX_NETPROD_DELTA
          : false;

    if (sameDef && sameSub && closeEnough && prodOk) {
      current.timeEnd = t.timeEnd;
      current.totalDuration += t.duration;
      current.totalT += t.tValue ?? 0;
      current.totalM += t.mValue ?? 0;
      current.totalP += t.pValue ?? 0;
      current.totalN += t.nValue ?? 0;
      current.count += 1;
      current.timings.push(t);
      const denom = current.totalT + current.totalM + current.totalP;
      current.netProductivity = denom > 0 ? current.totalT / denom : null;
      const denomI = current.totalT + current.totalM;
      current.internalProductivity = denomI > 0 ? current.totalT / denomI : null;
      current.isSession = true;
    } else {
      blocks.push(current);
      current = singletonBlock(t);
    }
  }
  if (current) blocks.push(current);
  return blocks;
}

function CalendarView() {
  const { startDate } = useTemporalContext();
  const { zoomLevel, viewMode } = useCalendarSettings();
  const { settings } = useSettings();
  const userLetters = settings?.timeTags ?? [];
  const [timings, setTimings] = useState<CalendarTiming[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedBlock, setSelectedBlock] = useState<{ block: CalendarBlock; rect: DOMRect } | null>(null);
  const [showLegend, setShowLegend] = useState(false);
  const [legendBtnRect, setLegendBtnRect] = useState<DOMRect | null>(null);
  const [now, setNow] = useState<Date>(() => new Date());
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const lastScrolledRangeRef = useRef<string | null>(null);

  // Tick the "now" line every minute. Resync to the next minute boundary first
  // so the line ticks visibly at :00, not at a random offset.
  useEffect(() => {
    const msToNextMinute = 60_000 - (Date.now() % 60_000);
    let intervalId: number | null = null;
    const timeoutId = window.setTimeout(() => {
      setNow(new Date());
      intervalId = window.setInterval(() => setNow(new Date()), 60_000);
    }, msToNextMinute);
    return () => {
      window.clearTimeout(timeoutId);
      if (intervalId !== null) window.clearInterval(intervalId);
    };
  }, []);

  // Calendar constants — HOUR_HEIGHT scales with zoom.
  const HOUR_HEIGHT = BASE_HOUR_HEIGHT * zoomLevel;
  const CALENDAR_HEIGHT = HOUR_HEIGHT * 24;
  const MINUTES_IN_DAY = 1440;
  const hours = Array.from({ length: 25 }, (_, i) => i);

  // Day dates: 7 days from week-start (7-day mode), or 3 days from startDate (3-day mode).
  const dayCount = viewMode === '3day' ? 3 : 7;
  const anchorDate = viewMode === '3day' ? startDate : getWeekStart(startDate);
  const dayDates = getNDays(anchorDate, dayCount);
  const rangeStart = dayDates[0];
  const rangeEnd = dayDates[dayDates.length - 1];
  const rangeKey = dateKey(rangeStart) + '|' + viewMode;

  // Load timings for the visible range
  useEffect(() => {
    loadRangeTimings();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startDate, viewMode]);

  // Auto-scroll to the first hour with data when the range changes
  // (or to 07:00 if empty). Only fires once per (range, viewMode).
  useEffect(() => {
    if (!scrollContainerRef.current) return;
    if (isLoading) return;
    if (lastScrolledRangeRef.current === rangeKey) return;
    let scrollHour = 7;
    if (timings.length > 0) {
      const minMin = timings.reduce(
        (acc, t) => Math.min(acc, t.timeInit),
        Number.POSITIVE_INFINITY
      );
      if (Number.isFinite(minMin)) scrollHour = Math.max(0, Math.floor(minMin / 60) - 1);
    }
    scrollContainerRef.current.scrollTop = scrollHour * HOUR_HEIGHT;
    lastScrolledRangeRef.current = rangeKey;
  }, [timings, rangeKey, isLoading, HOUR_HEIGHT]);

  // Preserve which time is at the top when zoom level changes.
  const prevHourHeightRef = useRef<number | null>(null);
  useEffect(() => {
    if (!scrollContainerRef.current) return;
    const prev = prevHourHeightRef.current;
    if (prev !== null && prev !== HOUR_HEIGHT) {
      const oldTop = scrollContainerRef.current.scrollTop;
      const hourAtTop = oldTop / prev;
      scrollContainerRef.current.scrollTop = hourAtTop * HOUR_HEIGHT;
    }
    prevHourHeightRef.current = HOUR_HEIGHT;
  }, [HOUR_HEIGHT]);

  // Close popovers on Escape
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setSelectedBlock(null);
        setShowLegend(false);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  // Close popovers on outside click. Listener attached one tick late so the
  // opening click doesn't immediately close the popover.
  useEffect(() => {
    if (!selectedBlock && !showLegend) return;
    const onDown = () => {
      setSelectedBlock(null);
      setShowLegend(false);
    };
    const id = window.setTimeout(() => document.addEventListener('mousedown', onDown), 0);
    return () => {
      window.clearTimeout(id);
      document.removeEventListener('mousedown', onDown);
    };
  }, [selectedBlock, showLegend]);

  // Close the block popover on any scroll (block moves, popover doesn't).
  useEffect(() => {
    if (!selectedBlock) return;
    const onScroll = () => setSelectedBlock(null);
    window.addEventListener('scroll', onScroll, true);
    return () => window.removeEventListener('scroll', onScroll, true);
  }, [selectedBlock]);

  const loadRangeTimings = async () => {
    setIsLoading(true);
    setError(null);

    const url = `${API_URL}/api/timings?startDate=${formatDateParam(rangeStart)}&endDate=${formatDateParam(rangeEnd)}`;

    try {
      const response = await fetch(url);
      const data = await response.json();

      if (data.success) {
        const filtered = data.timings.filter(
          (t: CalendarTiming) => t.timeInit !== null && t.timeEnd !== null
        );
        setTimings(filtered);
      } else {
        setError(data.error || 'Failed to load timings');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error');
    } finally {
      setIsLoading(false);
    }
  };

  // Group timings by local date (not UTC)
  const timingsByDate = new Map<string, CalendarTiming[]>();
  for (const timing of timings) {
    const timingDate = new Date(timing.timestamp);
    const key = dateKey(timingDate);
    if (!timingsByDate.has(key)) {
      timingsByDate.set(key, []);
    }
    timingsByDate.get(key)!.push(timing);
  }

  const minutesToPixels = (minutes: number): number =>
    (minutes / MINUTES_IN_DAY) * CALENDAR_HEIGHT;

  const handleBlockClick = (block: CalendarBlock, e: React.MouseEvent<HTMLDivElement>) => {
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    setSelectedBlock({ block, rect });
  };

  return (
    <div className="calendar-view">
      {(isLoading || error) && (
        <div className="calendar-status-bar">
          {isLoading && <span className="calendar-loading-indicator">Loading...</span>}
          {error && <span className="calendar-error-indicator">{error}</span>}
        </div>
      )}

      <div className="calendar-week-grid">
        {/* Sticky header row */}
        <div className="calendar-header-row">
          <div className="calendar-hour-labels-header calendar-legend-host">
            <button
              className="calendar-legend-btn"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                setLegendBtnRect(rect);
                setShowLegend((s) => !s);
                setSelectedBlock(null);
              }}
              title="Color legend"
              aria-label="Color legend"
            >i</button>
          </div>
          {dayDates.map((date, dayIndex) => {
            const key = dateKey(date);
            return (
              <div key={key} className={`calendar-day-header ${isTodayDate(date) ? 'today' : ''}`}>
                <span className="day-name">{DAY_NAMES[dayIndex]}</span>
                <span className="day-date-inline">{date.getDate()}</span>
              </div>
            );
          })}
        </div>

        {/* Day summary row */}
        <div className="calendar-summary-row">
          <div className="calendar-hour-labels-header"></div>
          {dayDates.map((date) => {
            const key = dateKey(date);
            const dayTimings = timingsByDate.get(key) || [];
            const summary = computeDaySummary(dayTimings);
            const hasTiming = dayTimings.length > 0;

            return (
              <div key={key} className={`calendar-day-summary${viewMode === '3day' ? ' threeday' : ''}`}>
                {hasTiming ? (
                  <>
                    {viewMode === '7day' && (
                      <div className="calendar-day-summary-line">
                        <span className="summary-t">{formatMinutesCompact(summary.t)}</span>
                        <span className="summary-sep">{'·'}</span>
                        <span className="summary-mp">{formatMinutesCompact(summary.m + summary.p)}</span>
                        <span className="summary-sep">{'·'}</span>
                        <span className="summary-n">{formatMinutesCompact(summary.n)}</span>
                        <span className="summary-sep">{'·'}</span>
                        <span className="summary-netprod">
                          {summary.netProd === null ? '—' : (summary.netProd * 10).toFixed(1)}
                        </span>
                      </div>
                    )}
                    {(() => {
                      const totals = sumLetterTotals(dayTimings);
                      const total = Object.values(totals).reduce((a, b) => a + b, 0);
                      if (total <= 0) return null;
                      // Render in user-configured order; trailing unconfigured letters fall to the end.
                      const orderedLetters = [
                        ...userLetters.map(t => t.letter),
                        ...Object.keys(totals).filter(l => !userLetters.find(t => t.letter === l)),
                      ];
                      const tooltip = orderedLetters
                        .filter(l => (totals[l] ?? 0) > 0)
                        .map(l => `${l} ${formatMinutesCompact(totals[l])}`)
                        .join('  ·  ');
                      return (
                        <div className="calendar-day-summary-bar" title={tooltip}>
                          {orderedLetters.map(l => {
                            const v = totals[l] ?? 0;
                            if (v <= 0) return null;
                            const color = colorForTimeTag(userLetters, l) ?? CAT_COLORS[l as keyof typeof CAT_COLORS] ?? '#cccccc';
                            return <span key={l} style={{ width: `${(v / total) * 100}%`, backgroundColor: color }} />;
                          })}
                        </div>
                      );
                    })()}
                    {viewMode === '3day' && (() => {
                      const dayDur = summary.t + summary.m + summary.p + summary.n;
                      const dayInternalDenom = summary.t + summary.m;
                      const dayInternal = dayInternalDenom > 0 ? summary.t / dayInternalDenom : null;
                      return (
                        <>
                          <div className="cal-summary-3d-headers">
                            <span className="cb-def">subdivision</span>
                            <span className="cb-range">range</span>
                            <span className="cb-dur">dur</span>
                            <span className="cb-t">t</span>
                            <span className="cb-mp">m+p</span>
                            <span className="cb-np">np</span>
                            <span className="cb-ip">ip</span>
                          </div>
                          <div className="cal-summary-3d-totals">
                            <span className="cb-def">Total</span>
                            <span className="cb-range"></span>
                            <span className="cb-dur">{formatMinutesCompact(dayDur)}</span>
                            <span className="cb-t">{formatMinutesCompact(summary.t)}</span>
                            <span className="cb-mp">{formatMinutesCompact(summary.m + summary.p)}</span>
                            <span className="cb-np">{summary.netProd === null ? '—' : (summary.netProd * 10).toFixed(1)}</span>
                            <span className="cb-ip">{dayInternal === null ? '—' : (dayInternal * 10).toFixed(1)}</span>
                          </div>
                        </>
                      );
                    })()}
                  </>
                ) : null}
              </div>
            );
          })}
        </div>

        {/* Scrollable body */}
        <div className="calendar-scroll-body" ref={scrollContainerRef}>
          {/* Hour labels column */}
          <div className="calendar-hour-labels">
            <div className="calendar-hours-container" style={{ height: CALENDAR_HEIGHT }}>
              {hours.map((hour) => (
                <div
                  key={hour}
                  className="calendar-hour-label"
                  data-major={[9, 13, 17, 21].includes(hour) ? 'true' : undefined}
                  data-even={hour % 2 === 0 ? 'true' : 'false'}
                  style={{ top: hour * HOUR_HEIGHT }}
                >
                  {hour.toString().padStart(2, '0')}:00
                </div>
              ))}
            </div>
          </div>

          {/* Day columns */}
          {dayDates.map((date) => {
            const key = dateKey(date);
            const dayTimings = timingsByDate.get(key) || [];
            const blocks = mergeIntoSessions(dayTimings);
            const isEmpty = dayTimings.length === 0;
            const isToday = isTodayDate(date);
            const nowMin = isToday ? now.getHours() * 60 + now.getMinutes() : null;

            return (
              <div key={key} className={`calendar-day-column${isToday ? ' today' : ''}${isEmpty ? ' is-empty' : ''}`}>
                <div className="calendar-day-timeline" style={{ height: CALENDAR_HEIGHT }}>
                  {Array.from({ length: 24 }).map((_, h) => (
                    <div
                      key={`band-${h}`}
                      className={`calendar-hour-band${h % 2 === 0 ? ' even' : ' odd'}`}
                      style={{ top: h * HOUR_HEIGHT, height: HOUR_HEIGHT }}
                    />
                  ))}
                  {hours.map((hour) => (
                    <div
                      key={hour}
                      className="calendar-hour-line"
                      data-major={[9, 13, 17, 21].includes(hour) ? 'true' : undefined}
                      style={{ top: hour * HOUR_HEIGHT }}
                    />
                  ))}

                  {blocks.map((block) => {
                    const blockHeight = Math.max(minutesToPixels(block.timeEnd - block.timeInit), 4);
                    const showLine1 = blockHeight >= BLOCK_LINE1_MIN_HEIGHT;
                    const showLine2 = blockHeight >= BLOCK_LINE2_MIN_HEIGHT;
                    const kpiConfig = getCalendarKpiConfig(block.definitionCode);
                    const kpiValueFor = (k: KpiKey): number | null => {
                      if (k === 'duration') return block.totalDuration;
                      if (k === 'tValue') return block.totalT;
                      return block.netProductivity;
                    };

                    return (
                      <div
                        key={block.id}
                        className={`calendar-timing-block${block.isSession ? ' is-session' : ''}`}
                        style={{
                          top: minutesToPixels(block.timeInit),
                          height: blockHeight,
                          backgroundColor: getProductivityColor(block.netProductivity),
                        }}
                        title={`${formatTimeOfDay(block.timeInit)} – ${formatTimeOfDay(block.timeEnd)}${block.isSession ? `  ·  session ×${block.count}` : ''}\nProductivity: ${block.netProductivity !== null ? (block.netProductivity * 100).toFixed(0) + '%' : 'N/A'}`}
                        onMouseDown={(e) => e.stopPropagation()}
                        onClick={(e) => handleBlockClick(block, e)}
                      >
                        <span
                          className="calendar-block-defstripe"
                          style={{ backgroundColor: blockStripeColor(block.parentCategory, block.parentDefinitionCode, settings?.categoryColors ?? {}) }}
                        />
                        {viewMode === '3day' ? (
                          showLine1 && (
                            <div className="calendar-block-3day">
                              <span className="cb-def">
                                {block.subdivision || block.parentDefinitionCode || block.definitionCode}
                                {block.isSession && (
                                  <span className="calendar-block-session-tag" title={`Session of ${block.count}`}>
                                  <svg className="calendar-block-stack-icon" width="9" height="9" viewBox="0 0 8 8" aria-hidden="true">
                                    <rect x="0" y="0" width="8" height="1.6" rx="0.4" />
                                    <rect x="0" y="3.2" width="8" height="1.6" rx="0.4" />
                                    <rect x="0" y="6.4" width="8" height="1.6" rx="0.4" />
                                  </svg>
                                  {block.count}
                                </span>

                                )}
                              </span>
                              <span className="cb-range">{formatTimeOfDay(block.timeInit)}–{formatTimeOfDay(block.timeEnd)}</span>
                              <span className="cb-dur">{formatMinutesCompact(block.totalDuration)}</span>
                              <span className="cb-t">{formatMinutesCompact(block.totalT)}</span>
                              <span className="cb-mp">{formatMinutesCompact(block.totalM + block.totalP)}</span>
                              <span className="cb-np">{block.netProductivity !== null ? (block.netProductivity * 10).toFixed(1) : '—'}</span>
                              <span className="cb-ip">{block.internalProductivity !== null ? (block.internalProductivity * 10).toFixed(1) : '—'}</span>
                            </div>
                          )
                        ) : (
                          <>
                            {showLine1 && (
                              <div className="calendar-block-line1">
                                <span className="calendar-block-def">
                                  {block.subdivision || block.parentDefinitionCode || block.definitionCode}
                                  {block.isSession && (
                                    <span className="calendar-block-session-tag" title={`Session of ${block.count}`}>
                                  <svg className="calendar-block-stack-icon" width="9" height="9" viewBox="0 0 8 8" aria-hidden="true">
                                    <rect x="0" y="0" width="8" height="1.6" rx="0.4" />
                                    <rect x="0" y="3.2" width="8" height="1.6" rx="0.4" />
                                    <rect x="0" y="6.4" width="8" height="1.6" rx="0.4" />
                                  </svg>
                                  {block.count}
                                </span>

                                  )}
                                </span>
                                <span className="calendar-block-kpis">
                                  {formatKpiForBlock(kpiConfig.mainKpi.key, kpiValueFor(kpiConfig.mainKpi.key))}
                                  {' \u00B7 '}
                                  {formatKpiForBlock(kpiConfig.secondaryKpi.key, kpiValueFor(kpiConfig.secondaryKpi.key))}
                                </span>
                              </div>
                            )}
                            {showLine2 && (
                              <div className="calendar-block-line2">
                                {formatMinutesCompact(block.totalDuration)}
                              </div>
                            )}
                          </>
                        )}
                      </div>
                    );
                  })}

                  {nowMin !== null && (
                    <div className="calendar-now-line" style={{ top: minutesToPixels(nowMin) }}>
                      <span className="calendar-now-dot" />
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {selectedBlock && (
        <BlockPopover
          block={selectedBlock.block}
          anchorRect={selectedBlock.rect}
          onClose={() => setSelectedBlock(null)}
        />
      )}

      {showLegend && legendBtnRect && (
        <div
          className="calendar-legend-popover"
          style={{
            position: 'fixed',
            top: legendBtnRect.bottom + 6,
            left: legendBtnRect.left,
          }}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="calendar-legend-title">Block color · net productivity</div>
          <div className="calendar-legend-row"><span className="lc" style={{ backgroundColor: '#b8e6c8' }} /> &ge; 80%</div>
          <div className="calendar-legend-row"><span className="lc" style={{ backgroundColor: '#c8f0d0' }} /> 70&ndash;80%</div>
          <div className="calendar-legend-row"><span className="lc" style={{ backgroundColor: '#fde68a' }} /> 60&ndash;70%</div>
          <div className="calendar-legend-row"><span className="lc" style={{ backgroundColor: '#ffe0b2' }} /> 40&ndash;60%</div>
          <div className="calendar-legend-row"><span className="lc" style={{ backgroundColor: '#f8c4c4' }} /> &lt; 40%</div>
          <div className="calendar-legend-row"><span className="lc" style={{ backgroundColor: '#e8e8e8' }} /> no productivity data</div>
          <div className="calendar-legend-title calendar-legend-title-2">Day-summary bar · category</div>
          {userLetters.map(t => (
            <div key={t.letter} className="calendar-legend-row">
              <span className="lc" style={{ backgroundColor: t.color }} /> {t.letter}{t.name ? ` · ${t.name}` : ''}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

interface BlockPopoverProps {
  block: CalendarBlock;
  anchorRect: DOMRect;
  onClose: () => void;
}

function BlockPopover({ block, anchorRect, onClose }: BlockPopoverProps) {
  const { settings } = useSettings();
  const userLetters = settings?.timeTags ?? [];
  const POPOVER_W = 280;
  const GAP = 8;
  const placeRight = anchorRect.right + GAP + POPOVER_W < window.innerWidth;
  const left = placeRight
    ? anchorRect.right + GAP
    : Math.max(8, anchorRect.left - GAP - POPOVER_W);
  const top = Math.max(8, Math.min(anchorRect.top, window.innerHeight - 320));

  const np = block.netProductivity;
  const pct = np === null ? '—' : (np * 100).toFixed(0) + '%';
  const ip = block.internalProductivity;
  const ipPct = ip === null ? '—' : (ip * 100).toFixed(0) + '%';

  return (
    <div
      className="calendar-block-popover"
      style={{ top, left, width: POPOVER_W }}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="cbp-header">
        <span className="cbp-title">{block.subdivision || block.parentDefinitionCode || block.definitionCode}</span>
        {block.isSession && <span className="cbp-badge">×{block.count}</span>}
        <button className="cbp-close" onClick={onClose} aria-label="Close">×</button>
      </div>
      <div className="cbp-row">
        <span className="cbp-label">Range</span>
        <span className="cbp-val">{formatTimeOfDay(block.timeInit)} – {formatTimeOfDay(block.timeEnd)}</span>
      </div>
      <div className="cbp-row">
        <span className="cbp-label">Duration</span>
        <span className="cbp-val">{formatMinutesCompact(block.totalDuration)}</span>
      </div>
      <div className="cbp-row">
        <span className="cbp-label">Net productivity</span>
        <span className="cbp-val">{pct}</span>
      </div>
      <div className="cbp-row">
        <span className="cbp-label">Internal productivity</span>
        <span className="cbp-val">{ipPct}</span>
      </div>
      <div className="cbp-breakdown">
        {(() => {
          const totals = sumLetterTotals(block.timings);
          const ordered = [
            ...userLetters.map(t => t.letter),
            ...Object.keys(totals).filter(l => !userLetters.find(t => t.letter === l)),
          ];
          return ordered.map(l => {
            const v = totals[l] ?? 0;
            if (v <= 0) return null;
            const color = colorForTimeTag(userLetters, l) ?? CAT_COLORS[l as keyof typeof CAT_COLORS] ?? '#cccccc';
            return (
              <span key={l} className="cbp-cat">
                <i style={{ backgroundColor: color }} /> {l} {formatMinutesCompact(v)}
              </span>
            );
          });
        })()}
      </div>
      {block.isSession && (
        <div className="cbp-constituents">
          <div className="cbp-section-title">Constituents</div>
          {block.timings.map((t) => (
            <div key={t.id} className="cbp-constituent">
              <span className="cbp-c-time">{formatTimeOfDay(t.timeInit)}–{formatTimeOfDay(t.timeEnd)}</span>
              <span className="cbp-c-dur">{formatMinutesCompact(t.duration)}</span>
              <span className="cbp-c-np">{t.netProductivity === null ? '—' : (t.netProductivity * 100).toFixed(0) + '%'}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ============================================
// Dashboard Component
// ============================================

function Dashboard() {
  const { startDate, endDate, smallPeriod } = useTemporalContext();
  const { activeDashboardId, dashboards } = useDashboardContext();
  const [widgets, setWidgets] = useState<DashboardWidget[]>([]);
  const [dashboardName, setDashboardName] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showChartValues, setShowChartValues] = useState(false);

  // v1 modal state
  const [modalOpen, setModalOpen] = useState(false);
  const [modalMode, setModalMode] = useState<'create' | 'edit'>('create');
  const [editingWidget, setEditingWidget] = useState<DashboardWidget | null>(null);

  const loadDashboardWidgets = useCallback(async () => {
    if (!activeDashboardId) {
      setWidgets([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const params = new URLSearchParams({
        startDate: formatDateParam(startDate),
        endDate: formatInclusiveEndDate(endDate),
        groupBy: smallPeriod,
      });

      const response = await fetch(
        `${API_URL}/api/dashboards/${activeDashboardId}/widgets?${params}`
      );
      const data: DashboardWidgetsResponse = await response.json();

      if (data.success && data.widgets) {
        setWidgets(data.widgets);
        setDashboardName(data.dashboard?.name || '');
      } else {
        setError(data.error || 'Failed to load dashboard');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error');
    } finally {
      setLoading(false);
    }
  }, [activeDashboardId, startDate, endDate, smallPeriod]);

  // Widget actions
  const handleDeleteWidget = async (widgetId: string) => {
    if (!confirm('Delete this widget?')) return;
    try {
      const response = await fetch(`${API_URL}/api/widgets/${widgetId}`, {
        method: 'DELETE',
      });
      const data = await response.json();
      if (data.success) {
        setWidgets((prev) => prev.filter((w) => w.id !== widgetId));
      } else {
        alert(data.error || 'Failed to delete widget');
      }
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Network error');
    }
  };

  const handleReorderWidget = async (widgetId: string, direction: 'up' | 'down') => {
    try {
      const response = await fetch(`${API_URL}/api/widgets/${widgetId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ direction }),
      });
      const data = await response.json();
      if (data.success) {
        loadDashboardWidgets();
      } else {
        alert(data.error || 'Failed to reorder widget');
      }
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Network error');
    }
  };

  // Widget create/edit handlers
  const openCreateModal = () => {
    setEditingWidget(null);
    setModalMode('create');
    setModalOpen(true);
  };

  const openEditModal = (widget: DashboardWidget) => {
    setEditingWidget(widget);
    setModalMode('edit');
    setModalOpen(true);
  };

  const closeModal = () => {
    setModalOpen(false);
    setEditingWidget(null);
  };

  // WidgetV2Editor handles its own save flow; this callback just triggers a refresh.
  const handleWidgetSaved = async () => {
    await loadDashboardWidgets();
  };

  // Reload when context changes
  useEffect(() => {
    loadDashboardWidgets();
  }, [loadDashboardWidgets]);

  // No dashboard selected
  if (!activeDashboardId) {
    if (dashboards.length === 0) {
      return (
        <div className="dashboard-empty">
          <h2>No Dashboards</h2>
          <p>Create a dashboard using the + button above.</p>
        </div>
      );
    }
    return <div className="dashboard-loading">Select a dashboard...</div>;
  }

  if (loading) {
    return <div className="dashboard-loading">Loading widgets...</div>;
  }

  if (error) {
    return (
      <div className="dashboard-error">
        <h2>Error</h2>
        <p>{error}</p>
        <button onClick={loadDashboardWidgets}>Retry</button>
      </div>
    );
  }

  if (widgets.length === 0) {
    return (
      <div className="dashboard-empty">
        <h2>{dashboardName || 'Dashboard'}</h2>
        <p>No widgets in this dashboard yet.</p>
        <button onClick={openCreateModal} className="dashboard-action-secondary" title="Add a new widget">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
          Add widget
        </button>
        <WidgetModal
          isOpen={modalOpen}
          onClose={closeModal}
          onSaved={handleWidgetSaved}
          initialData={editingWidget ? { widgetId: editingWidget.id, name: editingWidget.name, dsl: editingWidget.dsl } : undefined}
          mode={modalMode}
          dashboardId={activeDashboardId ?? ''}
          startDate={startDate}
          endDate={endDate}
          smallPeriod={smallPeriod}
        />
      </div>
    );
  }

  return (
    <div className="dashboard">
      <div className="dashboard-actions-bar">
        <button onClick={openCreateModal} className="dashboard-action-secondary" title="Add a new widget to this dashboard">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
          Add widget
        </button>
        <label className="dashboard-show-values" title={showChartValues ? 'Hide numeric values on charts' : 'Show numeric values on charts'}>
          <input
            type="checkbox"
            checked={showChartValues}
            onChange={(e) => setShowChartValues(e.target.checked)}
          />
          <span>Show values</span>
        </label>
        <button onClick={loadDashboardWidgets} className="dashboard-action-ghost" title="Refresh widgets">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <polyline points="23 4 23 10 17 10" />
            <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
          </svg>
        </button>
      </div>

      <div className="widget-grid">
        {widgets.map((widget, index) => (
          <div key={widget.id} className="widget-card">
            <div className="widget-header">
              <h3>{widget.name}</h3>
              <div className="widget-actions">
                <button
                  className="widget-action-btn"
                  onClick={() => openEditModal(widget)}
                  title="Edit"
                >
                  E
                </button>
                <button
                  className="widget-action-btn"
                  onClick={() => handleReorderWidget(widget.id, 'up')}
                  disabled={index === 0}
                  title="Move up"
                >
                  ↑
                </button>
                <button
                  className="widget-action-btn"
                  onClick={() => handleReorderWidget(widget.id, 'down')}
                  disabled={index === widgets.length - 1}
                  title="Move down"
                >
                  ↓
                </button>
                <button
                  className="widget-action-btn delete-btn"
                  onClick={() => handleDeleteWidget(widget.id)}
                  title="Delete"
                >
                  ×
                </button>
              </div>
            </div>
            {widget.error ? (
              <div className="widget-error">
                <p>{widget.error}</p>
              </div>
            ) : widget.chart ? (
              <WidgetV2
                chart={widget.chart}
                presentation={widget.presentation}
                showChartValues={showChartValues}
              />
            ) : (
              <div className="widget-no-result">No result</div>
            )}
          </div>
        ))}
      </div>

      <WidgetModal
        isOpen={modalOpen}
        onClose={closeModal}
        onSaved={handleWidgetSaved}
        initialData={editingWidget ? { widgetId: editingWidget.id, name: editingWidget.name, dsl: editingWidget.dsl } : undefined}
        mode={modalMode}
        dashboardId={activeDashboardId ?? ''}
        startDate={startDate}
        endDate={endDate}
        smallPeriod={smallPeriod}
      />
    </div>
  );
}

function WidgetRunner() {
  const { startDate, endDate, smallPeriod } = useTemporalContext();
  const [widgetSource, setWidgetSource] = useState(EXAMPLE_WIDGET);
  const [v2Result, setV2Result] = useState<{ name: string; chart: ChartOutput; presentation?: ChartPresentation } | null>(null);
  const [loading, setLoading] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);

  const handleRun = async () => {
    setLoading(true);
    setV2Result(null);
    setRunError(null);

    try {
      const response = await fetch(`${API_URL}/api/v2/run-widget`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          widgetSource,
          startDate: formatDateParam(startDate),
          endDate: formatInclusiveEndDate(endDate),
          smallPeriod,
        }),
      });
      const data = await response.json();
      if (data.success) {
        setV2Result({ name: data.name, chart: data.chart, presentation: data.presentation });
      } else {
        setRunError(data.error || 'Widget execution failed');
      }
    } catch (err) {
      setRunError(err instanceof Error ? err.message : 'Network error');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="runner">
      <div className="editor-section">
        <label htmlFor="widget-source">Widget DSL:</label>
        <textarea
          id="widget-source"
          value={widgetSource}
          onChange={(e) => {
            setWidgetSource(e.target.value);
            setV2Result(null); setRunError(null);
          }}
          rows={15}
          placeholder="Paste your widget DSL here..."
        />
      </div>

      <div className="button-section">
        <button onClick={handleRun} disabled={loading || !widgetSource.trim()}>
          {loading ? 'Running...' : 'Run Widget (v2)'}
        </button>
      </div>

      {runError && (
        <div className="result-section">
          <div className="error"><h2>Error</h2><pre>{runError}</pre></div>
        </div>
      )}

      {v2Result && (
        <div className="result-section">
          <h2>{v2Result.name}</h2>
          <WidgetV2 chart={v2Result.chart} presentation={v2Result.presentation} />
        </div>
      )}

    </div>
  );
}

export default App;
