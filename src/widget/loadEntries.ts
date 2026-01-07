/**
 * Entry Loader for Widget Evaluation
 *
 * Loads persisted entries from Supabase for widget evaluation.
 * Filters entries by definition code and time period.
 */

import { supabase } from '../persistence/supabaseClient';
import { LoadedEntry, Period, WidgetConfig } from './types';

/**
 * Database row types for query results
 */
interface EntryRow {
  id: number;
  definition_id: string;
  timestamp: string;
  subdivision: string | null;
}

interface AttributeEntryRow {
  entry_id: number;
  field_id: string;
  value_int: number | null;
  value_float: number | null;
  value_string: string | null;
  value_bool: boolean | null;
}

interface FieldRow {
  id: string;
  name: string;
  metric_definition_id: string;
}

interface DefinitionRow {
  id: string;
  code: string;
}

interface ChildEntryRow {
  id: number;
  parent_entry_id: number;
  subdivision: string | null;
}

interface ChildAttributeRow {
  entry_id: number;
  field_id: string;
  value_int: number | null;
}

/**
 * Load entries from database for widget evaluation
 *
 * @param definitionCode - The metric definition code (e.g., "TIM", "READ")
 * @param config - Widget configuration including userId, anchorDate, and period
 * @returns Array of loaded entries with attributes
 */
export async function loadEntriesForWidget(
  definitionCode: string,
  config: WidgetConfig
): Promise<LoadedEntry[]> {
  const { userId } = config;
  // Period comes from temporal context (bigPeriod), defaults to DAY
  const period: Period = config.period || 'DAY';

  // 1. Find the definition ID for the code
  const { data: definitions, error: defError } = await supabase
    .from('definitions')
    .select('id, code')
    .eq('user_id', userId)
    .eq('code', definitionCode)
    .eq('type', 'metric');

  if (defError) {
    throw new Error(`Failed to load definition: ${defError.message}`);
  }

  if (!definitions || definitions.length === 0) {
    throw new Error(`Definition not found: ${definitionCode}`);
  }

  const definitionId = (definitions as DefinitionRow[])[0].id;

  // 2. Get date range for period filter (using anchorDate from config)
  const anchorDate = config.anchorDate || new Date();
  const { startDate, endDate } = getPeriodDateRange(period, anchorDate);

  // 3. Load metric entries matching definition and period (filter by timestamp at 00:00)
  const { data: entries, error: entryError } = await supabase
    .from('entries')
    .select('id, definition_id, timestamp, subdivision')
    .eq('user_id', userId)
    .eq('definition_id', definitionId)
    .gte('timestamp', startDate.toISOString())
    .lt('timestamp', endDate.toISOString());

  if (entryError) {
    throw new Error(`Failed to load entries: ${entryError.message}`);
  }

  if (!entries || entries.length === 0) {
    return [];
  }

  const entryRows = entries as EntryRow[];
  const entryIds = entryRows.map((e) => e.id);

  // 4. Load fields for this definition (for field name lookup)
  const { data: fields, error: fieldError } = await supabase
    .from('fields')
    .select('id, name, metric_definition_id')
    .eq('metric_definition_id', definitionId);

  if (fieldError) {
    throw new Error(`Failed to load fields: ${fieldError.message}`);
  }

  const fieldRows = (fields || []) as FieldRow[];
  const fieldIdToName = new Map<string, string>();
  for (const field of fieldRows) {
    fieldIdToName.set(field.id, field.name);
  }

  // 5. Load child entries for these metric entries (attributes are stored as children)
  const { data: childEntries, error: childError } = await supabase
    .from('entries')
    .select('id, parent_entry_id')
    .in('parent_entry_id', entryIds);

  if (childError) {
    throw new Error(`Failed to load child entries: ${childError.message}`);
  }

  const childRows = (childEntries || []) as { id: number; parent_entry_id: number }[];
  const childIds = childRows.map((c) => c.id);

  // 6. Load attribute entries for child entries
  let attrRows: AttributeEntryRow[] = [];
  if (childIds.length > 0) {
    const { data: attributeEntries, error: attrError } = await supabase
      .from('attribute_entries')
      .select('entry_id, field_id, value_int, value_float, value_string, value_bool')
      .in('entry_id', childIds);

    if (attrError) {
      throw new Error(`Failed to load attribute entries: ${attrError.message}`);
    }

    attrRows = (attributeEntries || []) as AttributeEntryRow[];
  }

  // Build map from child entry ID to parent entry ID
  const childToParent = new Map<number, number>();
  for (const child of childRows) {
    childToParent.set(child.id, child.parent_entry_id);
  }

  // 7. For TIM entries, load time_type values separately (they have subdivisions)
  let timeValuesByEntry: Map<number, Map<string, number>> = new Map();
  if (definitionCode === 'TIM') {
    timeValuesByEntry = await loadTimeTypeValues(entryIds);
  }

  // 8. Build LoadedEntry objects
  const result: LoadedEntry[] = [];

  for (const entryRow of entryRows) {
    const attributes = new Map<string, number | string | boolean | null>();

    // Get attribute values from child entries for this metric entry
    for (const attr of attrRows) {
      const parentId = childToParent.get(attr.entry_id);
      if (parentId !== entryRow.id) continue;

      const fieldName = fieldIdToName.get(attr.field_id);
      if (!fieldName) continue;

      // Skip time_type - handled separately via timeValues
      if (fieldName === 'time_type') continue;

      // Get the typed value
      const value = attr.value_int ?? attr.value_float ?? attr.value_string ?? attr.value_bool ?? null;
      attributes.set(fieldName, value);
    }

    const loadedEntry: LoadedEntry = {
      id: entryRow.id,
      definitionCode,
      timestamp: new Date(entryRow.timestamp),
      subdivision: entryRow.subdivision,
      attributes,
    };

    // Add time values for TIM entries
    if (definitionCode === 'TIM') {
      loadedEntry.timeValues = timeValuesByEntry.get(entryRow.id) || new Map();
    }

    result.push(loadedEntry);
  }

  return result;
}

/**
 * Load time_type values for TIM entries
 *
 * For TIM entries, time_type values are stored as child AttributeEntries
 * where the subdivision indicates the base category (t, m, p, n or t/sub, etc.)
 * and valueInt holds the time value.
 */
async function loadTimeTypeValues(
  parentEntryIds: number[]
): Promise<Map<number, Map<string, number>>> {
  if (parentEntryIds.length === 0) {
    return new Map();
  }

  // Load child entries for these TIM entries
  const { data: childEntries, error: childError } = await supabase
    .from('entries')
    .select('id, parent_entry_id, subdivision')
    .in('parent_entry_id', parentEntryIds);

  if (childError) {
    throw new Error(`Failed to load child entries: ${childError.message}`);
  }

  if (!childEntries || childEntries.length === 0) {
    return new Map();
  }

  const childRows = childEntries as ChildEntryRow[];
  const childIds = childRows.map((c) => c.id);

  // Load attribute entries for children
  const { data: childAttrs, error: attrError } = await supabase
    .from('attribute_entries')
    .select('entry_id, field_id, value_int')
    .in('entry_id', childIds);

  if (attrError) {
    throw new Error(`Failed to load child attribute entries: ${attrError.message}`);
  }

  const attrRows = (childAttrs || []) as ChildAttributeRow[];

  // Build a map of child entry ID to value
  const childIdToValue = new Map<number, number>();
  for (const attr of attrRows) {
    if (attr.value_int !== null) {
      childIdToValue.set(attr.entry_id, attr.value_int);
    }
  }

  // Group time values by parent entry and base category
  const result = new Map<number, Map<string, number>>();

  for (const child of childRows) {
    const parentId = child.parent_entry_id;
    const subdivision = child.subdivision || '';
    const value = childIdToValue.get(child.id);

    if (value === undefined) continue;

    if (!result.has(parentId)) {
      result.set(parentId, new Map());
    }

    const parentTimeValues = result.get(parentId)!;

    // Add to the exact subdivision
    const currentValue = parentTimeValues.get(subdivision) || 0;
    parentTimeValues.set(subdivision, currentValue + value);
  }

  return result;
}

/**
 * Get date range for a period based on anchor date.
 *
 * All periods use anchorDate as the reference point.
 *
 * @param period - The period type (DAY, WEEK, MONTH, YEAR)
 * @param anchorDate - The reference date for computing ranges
 * @returns Start and end dates for the period
 */
function getPeriodDateRange(period: Period, anchorDate: Date): { startDate: Date; endDate: Date } {
  let startDate: Date;
  let endDate: Date;

  switch (period) {
    case 'DAY':
    case 'TODAY': {
      // Single day based on anchorDate (TODAY kept for backwards compatibility)
      startDate = new Date(anchorDate.getFullYear(), anchorDate.getMonth(), anchorDate.getDate(), 0, 0, 0, 0);
      endDate = new Date(anchorDate.getFullYear(), anchorDate.getMonth(), anchorDate.getDate() + 1, 0, 0, 0, 0);
      break;
    }
    case 'WEEK': {
      // Week containing anchorDate (Monday-Sunday)
      const dayOfWeek = anchorDate.getDay();
      const daysToMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
      startDate = new Date(anchorDate.getFullYear(), anchorDate.getMonth(), anchorDate.getDate() - daysToMonday, 0, 0, 0, 0);
      endDate = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate() + 7, 0, 0, 0, 0);
      break;
    }
    case 'MONTH': {
      // Month containing anchorDate
      startDate = new Date(anchorDate.getFullYear(), anchorDate.getMonth(), 1, 0, 0, 0, 0);
      endDate = new Date(anchorDate.getFullYear(), anchorDate.getMonth() + 1, 1, 0, 0, 0, 0);
      break;
    }
    case 'YEAR': {
      // Year containing anchorDate
      startDate = new Date(anchorDate.getFullYear(), 0, 1, 0, 0, 0, 0);
      endDate = new Date(anchorDate.getFullYear() + 1, 0, 1, 0, 0, 0, 0);
      break;
    }
    default:
      throw new Error(`Unsupported period: ${period}`);
  }

  // [DEV] Log computed date range
  console.log(`[loadEntries] period=${period}, anchorDate=${anchorDate.toISOString().split('T')[0]}, range=${startDate.toISOString().split('T')[0]} to ${endDate.toISOString().split('T')[0]}`);

  return { startDate, endDate };
}
