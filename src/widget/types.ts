/**
 * Widget Types
 *
 * Shared types for the v2 widget execution pipeline.
 */

import type { DashboardGlobalFilter, TagFilterRule } from './globalFilter';
export type { DashboardGlobalFilter, TagFilterRule };

/**
 * SmallPeriod for temporal grouping within the widget's date range.
 * Value comes from Global Temporal Context.
 */
export type SmallPeriod = 'hour' | 'day' | 'week' | 'month';

/**
 * Loaded entry from database with all attribute values.
 * Flattened structure used by the executor and entry loader.
 */
export interface LoadedEntry {
  id: number;
  definitionCode: string;
  timestamp: Date;
  subdivision: string | null;
  /** Direct parent entry id (null for root entries; undefined when caller doesn't load it). */
  parentEntryId?: number | null;

  /**
   * Attribute values keyed by field name
   */
  attributes: Map<string, number | string | boolean | null>;

  /**
   * For TIM entries: time_type values grouped by base category
   * Key: base category (t, m, p, n or t/sub, m/sub, etc.)
   * Value: sum of values for that category
   */
  timeValues?: Map<string, number>;
}

/**
 * Configuration for widget evaluation.
 *
 * Temporal model: the date range is specified explicitly as a half-open
 * interval `[startDate, endDate)` where both bounds are local-time midnight.
 */
export interface WidgetConfig {
  userId: string;

  /** Inclusive lower bound — local-time midnight of the first day in range. */
  startDate: Date;
  /** Exclusive upper bound — local-time midnight of the day AFTER the last day in range. */
  endDate: Date;

  /**
   * SmallPeriod from Global Temporal Context.
   * Used for "group by smallPeriod" clause.
   * Determines the granularity of temporal grouping.
   */
  smallPeriod?: SmallPeriod;

  /**
   * Dashboard-level global filter, applied before widget-specific WHERE clause.
   * Filters root entries; passing entries carry their whole subtree.
   */
  globalFilter?: DashboardGlobalFilter;
}
