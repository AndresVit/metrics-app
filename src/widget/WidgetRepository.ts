/**
 * Widget Repository
 *
 * Handles loading and managing widgets from the database.
 */

import { supabase } from '../persistence/supabaseClient';

/**
 * Stored widget from database
 */
export interface StoredWidget {
  id: string;
  userId: string;
  name: string;
  dsl: string;
  createdAt: Date;
}

/**
 * Database row type
 */
interface WidgetRow {
  id: string;
  user_id: string;
  name: string;
  dsl: string;
  created_at: string;
}

/**
 * Load all widgets for a user
 */
export async function loadWidgets(userId: string): Promise<StoredWidget[]> {
  const { data, error } = await supabase
    .from('widgets')
    .select('id, user_id, name, dsl, created_at')
    .eq('user_id', userId)
    .order('name');

  if (error) {
    throw new Error(`Failed to load widgets: ${error.message}`);
  }

  return (data || []).map((row: WidgetRow) => ({
    id: row.id,
    userId: row.user_id,
    name: row.name,
    dsl: row.dsl,
    createdAt: new Date(row.created_at),
  }));
}

/**
 * Load a single widget by ID
 */
export async function loadWidgetById(
  widgetId: string,
  userId: string
): Promise<StoredWidget | null> {
  const { data, error } = await supabase
    .from('widgets')
    .select('id, user_id, name, dsl, created_at')
    .eq('id', widgetId)
    .eq('user_id', userId)
    .single();

  if (error) {
    if (error.code === 'PGRST116') {
      // No rows returned
      return null;
    }
    throw new Error(`Failed to load widget: ${error.message}`);
  }

  const row = data as WidgetRow;
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    dsl: row.dsl,
    createdAt: new Date(row.created_at),
  };
}

/**
 * Load a widget by name
 */
export async function loadWidgetByName(
  name: string,
  userId: string
): Promise<StoredWidget | null> {
  const { data, error } = await supabase
    .from('widgets')
    .select('id, user_id, name, dsl, created_at')
    .eq('name', name)
    .eq('user_id', userId)
    .single();

  if (error) {
    if (error.code === 'PGRST116') {
      return null;
    }
    throw new Error(`Failed to load widget: ${error.message}`);
  }

  const row = data as WidgetRow;
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    dsl: row.dsl,
    createdAt: new Date(row.created_at),
  };
}
