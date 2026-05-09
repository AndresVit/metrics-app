/**
 * Dashboard Repository
 *
 * Handles loading and managing dashboards from the database.
 */

import { supabase } from '../persistence/supabaseClient';
import type { DashboardGlobalFilter } from '../widget/globalFilter';

/**
 * Stored dashboard from database
 */
export interface StoredDashboard {
  id: string;
  userId: string;
  name: string;
  createdAt: Date;
  /** Dashboard-level global filter, null when no filter is configured. */
  globalFilters: DashboardGlobalFilter | null;
}

/**
 * Database row type
 */
interface DashboardRow {
  id: string;
  user_id: string;
  name: string;
  created_at: string;
  global_filters: DashboardGlobalFilter | null;
}

/**
 * Load all dashboards for a user
 */
export async function loadDashboards(userId: string): Promise<StoredDashboard[]> {
  const { data, error } = await supabase
    .from('dashboards')
    .select('id, user_id, name, created_at, global_filters')
    .eq('user_id', userId)
    .order('name');

  if (error) {
    throw new Error(`Failed to load dashboards: ${error.message}`);
  }

  return (data || []).map((row: DashboardRow) => ({
    id: row.id,
    userId: row.user_id,
    name: row.name,
    createdAt: new Date(row.created_at),
    globalFilters: row.global_filters ?? null,
  }));
}

/**
 * Load a single dashboard by ID
 */
export async function loadDashboardById(
  dashboardId: string,
  userId: string
): Promise<StoredDashboard | null> {
  const { data, error } = await supabase
    .from('dashboards')
    .select('id, user_id, name, created_at, global_filters')
    .eq('id', dashboardId)
    .eq('user_id', userId)
    .single();

  if (error) {
    if (error.code === 'PGRST116') {
      return null;
    }
    throw new Error(`Failed to load dashboard: ${error.message}`);
  }

  const row = data as DashboardRow;
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    createdAt: new Date(row.created_at),
    globalFilters: row.global_filters ?? null,
  };
}

/**
 * Save (overwrite) the global filter for a dashboard.
 * Pass null to clear all filters.
 */
export async function saveDashboardFilters(
  dashboardId: string,
  userId: string,
  filters: DashboardGlobalFilter | null,
): Promise<void> {
  const { error } = await supabase
    .from('dashboards')
    .update({ global_filters: filters })
    .eq('id', dashboardId)
    .eq('user_id', userId);

  if (error) {
    throw new Error(`Failed to save dashboard filters: ${error.message}`);
  }
}

/**
 * Create a new dashboard
 */
export async function createDashboard(
  name: string,
  userId: string
): Promise<StoredDashboard> {
  const { data, error } = await supabase
    .from('dashboards')
    .insert({ user_id: userId, name })
    .select('id, user_id, name, created_at, global_filters')
    .single();

  if (error) {
    throw new Error(`Failed to create dashboard: ${error.message}`);
  }

  const row = data as DashboardRow;
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    createdAt: new Date(row.created_at),
    globalFilters: row.global_filters ?? null,
  };
}

/**
 * Update a dashboard name
 */
export async function updateDashboard(
  dashboardId: string,
  name: string,
  userId: string
): Promise<StoredDashboard> {
  const { data, error } = await supabase
    .from('dashboards')
    .update({ name })
    .eq('id', dashboardId)
    .eq('user_id', userId)
    .select('id, user_id, name, created_at, global_filters')
    .single();

  if (error) {
    throw new Error(`Failed to update dashboard: ${error.message}`);
  }

  const row = data as DashboardRow;
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    createdAt: new Date(row.created_at),
    globalFilters: row.global_filters ?? null,
  };
}

/**
 * Delete a dashboard
 */
export async function deleteDashboard(
  dashboardId: string,
  userId: string
): Promise<void> {
  const { error } = await supabase
    .from('dashboards')
    .delete()
    .eq('id', dashboardId)
    .eq('user_id', userId);

  if (error) {
    throw new Error(`Failed to delete dashboard: ${error.message}`);
  }
}
