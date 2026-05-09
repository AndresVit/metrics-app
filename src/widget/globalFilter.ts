/**
 * Dashboard-level global filter.
 *
 * Applied BEFORE widget-specific WHERE clauses.  All conditions are evaluated
 * ONLY against the ROOT entry of each source entry's parent chain
 * (parent_entry_id IS NULL).  If the root passes, the entire subtree is kept;
 * if it fails, the whole subtree is excluded.  This module is pure and has no
 * knowledge of the DB — the executor is responsible for walking the parent
 * chain and invoking `passesGlobalFilter` with the correct root record.
 *
 * Semantics (all conditions ANDed):
 *   includeDefinitionCodes  — root definition must be in this whitelist
 *   excludeDefinitionCodes  — root definition must NOT be in this blacklist
 *   subdivisionContains     — case-insensitive substring match on root subdivision
 *   subdivisionExcludes     — case-insensitive substring exclusion on root subdivision
 *   weekdays                — analytical weekday of root timestamp (05:00 boundary)
 *   tagFilters              — AND of per-tag rules (key[=value]) on ROOT tags,
 *                              with hierarchical "/" value matching
 */

import { analyticalWeekday } from './dateUtils';

export interface TagFilterRule {
  key: string;
  /**
   * If present: the root's tag value must match this value hierarchically
   * (see `tagValueMatches`). If absent/empty: root must simply have the key.
   */
  value?: string;
}

export interface DashboardGlobalFilter {
  includeDefinitionCodes?: string[];
  excludeDefinitionCodes?: string[];
  subdivisionContains?: string;
  subdivisionExcludes?: string;
  /** 0=Sunday … 6=Saturday, analytical (05:00 boundary) */
  weekdays?: number[];
  /** Each rule is applied with AND semantics. */
  tagFilters?: TagFilterRule[];
}

/**
 * Minimal root entry shape needed to evaluate the global filter.
 * The executor builds this from DB rows (definitions + entries + entry_tags).
 */
export interface RootEntryForFilter {
  definitionCode: string;
  subdivision: string | null;
  timestamp: Date;
  /** Tag key → tag value (null when the tag is a bare key with no value). */
  tags: Record<string, string | null>;
}

// ─────────────────────────────────────────────────────────────
// Active-filter helpers
// ─────────────────────────────────────────────────────────────

export function isFilterActive(f: DashboardGlobalFilter | null | undefined): boolean {
  if (!f) return false;
  return (
    (f.includeDefinitionCodes?.length ?? 0) > 0 ||
    (f.excludeDefinitionCodes?.length ?? 0) > 0 ||
    !!f.subdivisionContains?.trim() ||
    !!f.subdivisionExcludes?.trim() ||
    (f.weekdays?.length ?? 0) > 0 ||
    (f.tagFilters?.length ?? 0) > 0
  );
}

export function countActiveFilters(f: DashboardGlobalFilter): number {
  let n = 0;
  if ((f.includeDefinitionCodes?.length ?? 0) > 0) n++;
  if ((f.excludeDefinitionCodes?.length ?? 0) > 0) n++;
  if (f.subdivisionContains?.trim()) n++;
  if (f.subdivisionExcludes?.trim()) n++;
  if ((f.weekdays?.length ?? 0) > 0) n++;
  if ((f.tagFilters?.length ?? 0) > 0) n += f.tagFilters!.length;
  return n;
}

/**
 * Return true if the filter has any tag rules.  Callers use this to decide
 * whether they must fetch entry_tags rows at all.
 */
export function hasTagRules(f: DashboardGlobalFilter | null | undefined): boolean {
  return (f?.tagFilters?.length ?? 0) > 0;
}

// ─────────────────────────────────────────────────────────────
// Core predicate — evaluated on ROOT entries only
// ─────────────────────────────────────────────────────────────

/**
 * Evaluate the filter against a root entry.  Returns true if the root (and
 * therefore its entire subtree) passes.
 */
export function passesGlobalFilter(
  root: RootEntryForFilter,
  filter: DashboardGlobalFilter,
): boolean {
  // 1. includeDefinitionCodes — whitelist
  if (filter.includeDefinitionCodes && filter.includeDefinitionCodes.length > 0) {
    if (!filter.includeDefinitionCodes.includes(root.definitionCode)) return false;
  }

  // 2. excludeDefinitionCodes — blacklist
  if (filter.excludeDefinitionCodes && filter.excludeDefinitionCodes.length > 0) {
    if (filter.excludeDefinitionCodes.includes(root.definitionCode)) return false;
  }

  // 3. subdivisionContains (case-insensitive substring)
  if (filter.subdivisionContains?.trim()) {
    const needle = filter.subdivisionContains.toLowerCase();
    if (!root.subdivision?.toLowerCase().includes(needle)) return false;
  }

  // 4. subdivisionExcludes
  if (filter.subdivisionExcludes?.trim()) {
    const needle = filter.subdivisionExcludes.toLowerCase();
    if (root.subdivision?.toLowerCase().includes(needle)) return false;
  }

  // 5. weekdays — analytical weekday (05:00 boundary)
  if (filter.weekdays && filter.weekdays.length > 0) {
    const wd = analyticalWeekday(root.timestamp);
    if (!filter.weekdays.includes(wd)) return false;
  }

  // 6. tagFilters — all rules must pass (AND)
  if (filter.tagFilters && filter.tagFilters.length > 0) {
    for (const rule of filter.tagFilters) {
      if (!passesTagRule(root.tags, rule)) return false;
    }
  }

  return true;
}

// ─────────────────────────────────────────────────────────────
// Hierarchical tag matching
// ─────────────────────────────────────────────────────────────

/**
 * Hierarchical "/" tag-value matching.
 *
 *   rule   "office"          matches  "office", "office/kitchen", "office/hall/up"
 *   rule   "office/kitchen"  matches  "office/kitchen", "office/kitchen/fridge"
 *   rule   "office"          does NOT match  "office2", "office-kitchen"
 *   rule   "office/kitchen"  does NOT match  "office" (too shallow)
 *
 * Empty rule value falls back to a plain key-presence check.
 */
export function tagValueMatches(ruleValue: string, tagValue: string): boolean {
  if (tagValue === ruleValue) return true;
  return tagValue.startsWith(ruleValue + '/');
}

function passesTagRule(
  tags: Record<string, string | null>,
  rule: TagFilterRule,
): boolean {
  if (!(rule.key in tags)) return false;

  const hasValue = rule.value !== undefined && rule.value !== '';
  if (!hasValue) return true; // key exists, no value constraint

  const tagValue = tags[rule.key];
  if (tagValue === null) return false; // rule wants a specific value but tag has none
  return tagValueMatches(rule.value!, tagValue);
}

// ─────────────────────────────────────────────────────────────
// Entry-level helper
// ─────────────────────────────────────────────────────────────

/**
 * Keep only the entries whose ROOT ancestor passes the filter.
 *
 * The executor resolves each source entry to its root via `getRoot(entryId)`.
 * When `getRoot` returns null (broken chain), the entry is dropped defensively.
 */
export function applyGlobalFilterToEntries<T extends { id: number }>(
  entries: T[],
  filter: DashboardGlobalFilter | null | undefined,
  getRoot: (entryId: number) => RootEntryForFilter | null,
): T[] {
  if (!isFilterActive(filter)) return entries;
  const f = filter!;
  return entries.filter((e) => {
    const root = getRoot(e.id);
    if (!root) return false;
    return passesGlobalFilter(root, f);
  });
}
