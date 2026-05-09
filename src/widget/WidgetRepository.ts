/**
 * Widget Repository
 *
 * Handles loading and managing widgets from the database.
 */

import { supabase } from '../persistence/supabaseClient';

export interface StoredWidget {
  id: string;
  userId: string;
  dashboardId: string | null;
  name: string;
  dsl: string;
  orderIndex: number;
  createdAt: Date;
}

interface WidgetRow {
  id: string;
  user_id: string;
  dashboard_id: string | null;
  name: string;
  dsl: string;
  order_index: number;
  created_at: string;
}

const WIDGET_COLUMNS = 'id, user_id, dashboard_id, name, dsl, order_index, created_at';

function mapRowToWidget(row: WidgetRow): StoredWidget {
  return {
    id: row.id,
    userId: row.user_id,
    dashboardId: row.dashboard_id,
    name: row.name,
    dsl: row.dsl,
    orderIndex: row.order_index,
    createdAt: new Date(row.created_at),
  };
}

export async function loadWidgets(userId: string): Promise<StoredWidget[]> {
  const { data, error } = await supabase
    .from('widgets')
    .select(WIDGET_COLUMNS)
    .eq('user_id', userId)
    .order('order_index');

  if (error) {
    throw new Error(`Failed to load widgets: ${error.message}`);
  }

  return (data || []).map((row: WidgetRow) => mapRowToWidget(row));
}

export async function loadWidgetsByDashboard(
  dashboardId: string,
  userId: string
): Promise<StoredWidget[]> {
  const { data, error } = await supabase
    .from('widgets')
    .select(WIDGET_COLUMNS)
    .eq('dashboard_id', dashboardId)
    .eq('user_id', userId)
    .order('order_index');

  if (error) {
    throw new Error(`Failed to load widgets: ${error.message}`);
  }

  return (data || []).map((row: WidgetRow) => mapRowToWidget(row));
}

export async function loadWidgetById(
  widgetId: string,
  userId: string
): Promise<StoredWidget | null> {
  const { data, error } = await supabase
    .from('widgets')
    .select(WIDGET_COLUMNS)
    .eq('id', widgetId)
    .eq('user_id', userId)
    .single();

  if (error) {
    if (error.code === 'PGRST116') {
      return null;
    }
    throw new Error(`Failed to load widget: ${error.message}`);
  }

  return mapRowToWidget(data as WidgetRow);
}

export async function loadWidgetByName(
  name: string,
  userId: string
): Promise<StoredWidget | null> {
  const { data, error } = await supabase
    .from('widgets')
    .select(WIDGET_COLUMNS)
    .eq('name', name)
    .eq('user_id', userId)
    .single();

  if (error) {
    if (error.code === 'PGRST116') {
      return null;
    }
    throw new Error(`Failed to load widget: ${error.message}`);
  }

  return mapRowToWidget(data as WidgetRow);
}

export interface CreateWidgetInput {
  dashboardId: string;
  name: string;
  dsl: string;
}

export async function createWidget(
  input: CreateWidgetInput,
  userId: string
): Promise<StoredWidget> {
  const { data: existingWidgets } = await supabase
    .from('widgets')
    .select('order_index')
    .eq('dashboard_id', input.dashboardId)
    .order('order_index', { ascending: false })
    .limit(1);

  const nextOrderIndex =
    existingWidgets && existingWidgets.length > 0
      ? existingWidgets[0].order_index + 1
      : 0;

  const { data, error } = await supabase
    .from('widgets')
    .insert({
      user_id: userId,
      dashboard_id: input.dashboardId,
      name: input.name,
      dsl: input.dsl,
      order_index: nextOrderIndex,
    })
    .select(WIDGET_COLUMNS)
    .single();

  if (error) {
    throw new Error(`Failed to create widget: ${error.message}`);
  }

  return mapRowToWidget(data as WidgetRow);
}

export interface UpdateWidgetInput {
  name?: string;
  dsl?: string;
}

export async function updateWidget(
  widgetId: string,
  input: UpdateWidgetInput,
  userId: string
): Promise<StoredWidget> {
  const updates: Record<string, unknown> = {};
  if (input.name !== undefined) {
    updates.name = input.name;
  }
  if (input.dsl !== undefined) {
    updates.dsl = input.dsl;
  }

  if (Object.keys(updates).length === 0) {
    const widget = await loadWidgetById(widgetId, userId);
    if (!widget) {
      throw new Error('Widget not found');
    }
    return widget;
  }

  const { data, error } = await supabase
    .from('widgets')
    .update(updates)
    .eq('id', widgetId)
    .eq('user_id', userId)
    .select(WIDGET_COLUMNS)
    .single();

  if (error) {
    throw new Error(`Failed to update widget: ${error.message}`);
  }

  return mapRowToWidget(data as WidgetRow);
}

export async function deleteWidget(
  widgetId: string,
  userId: string
): Promise<void> {
  const { error } = await supabase
    .from('widgets')
    .delete()
    .eq('id', widgetId)
    .eq('user_id', userId);

  if (error) {
    throw new Error(`Failed to delete widget: ${error.message}`);
  }
}

export async function reorderWidget(
  widgetId: string,
  direction: 'up' | 'down',
  userId: string
): Promise<void> {
  const widget = await loadWidgetById(widgetId, userId);
  if (!widget || !widget.dashboardId) {
    throw new Error('Widget not found');
  }

  const widgets = await loadWidgetsByDashboard(widget.dashboardId, userId);

  const currentIndex = widgets.findIndex((w) => w.id === widgetId);
  if (currentIndex === -1) {
    throw new Error('Widget not found in dashboard');
  }

  const targetIndex =
    direction === 'up'
      ? Math.max(0, currentIndex - 1)
      : Math.min(widgets.length - 1, currentIndex + 1);

  if (targetIndex === currentIndex) {
    return;
  }

  const currentWidget = widgets[currentIndex];
  const targetWidget = widgets[targetIndex];

  const updates = [
    supabase
      .from('widgets')
      .update({ order_index: targetWidget.orderIndex })
      .eq('id', currentWidget.id)
      .eq('user_id', userId),
    supabase
      .from('widgets')
      .update({ order_index: currentWidget.orderIndex })
      .eq('id', targetWidget.id)
      .eq('user_id', userId),
  ];

  const results = await Promise.all(updates);
  for (const result of results) {
    if (result.error) {
      throw new Error(`Failed to reorder widgets: ${result.error.message}`);
    }
  }
}
