/**
 * Widget API Server
 *
 * Minimal HTTP API for running widgets.
 * Run with: npx tsx server/api.ts
 */

import express, { Request, Response } from 'express';
import cors from 'cors';
import {
  loadWidgets,
  loadWidgetsByDashboard,
  createWidget,
  updateWidget,
  deleteWidget,
  reorderWidget,
} from '../src/widget';
import { runWidgetV2 } from '../src/widget/runWidgetV2';
import type { SmallPeriod } from '../src/widget';
import {
  loadDashboards,
  loadDashboardById,
  createDashboard,
  deleteDashboard,
  updateDashboard,
  saveDashboardFilters,
} from '../src/dashboard';
import type { DashboardGlobalFilter } from '../src/widget/globalFilter';
import { parseLocalDate, addDays } from '../src/widget/dateUtils';
import { DEV_CONFIG } from '../dev/config';
import { parseDefinitions, ParsedDefinitions } from '../dev/parseDefinitions';
import { ParserRegistry } from '../dev/parserRegistry';
import { DefaultParser } from '../dev/defaultParser';
import { TimingParser } from '../dev/timingParser';
import { PipelineConfig, runPipeline } from '../src/pipeline/pipeline';
import { ResolvedEntry, ExistingEntriesResolver, getAttributeValue } from '../src/pipeline/types';
import {
  persistResolvedEntry,
  persistResolvedEntriesBatch,
  loadDefinitionIdMap,
  loadFieldIdMap,
  PersistenceConfig,
  supabase,
} from '../src/persistence';
import { loadEntriesInRange } from '../src/widget/loadEntries';
import { Entry, MetricEntry, AttributeEntry } from '../src/domain';
import { BackupService } from './backup';
import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());

// Use fixed userId from config (no auth for MVP)
const USER_ID = process.env.USER_ID || DEV_CONFIG.USER_ID;

// Backup service: monthly TXT snapshots of timings, regenerated from the DB.
const BACKUP_DIR = path.join(__dirname, '..', 'backups');
const backupService = new BackupService({ backupDir: BACKUP_DIR, userId: USER_ID });

// -----------------------------------------------------------------------------
// Data Entry Infrastructure
// -----------------------------------------------------------------------------

const DEFINITIONS_FILE = path.join(__dirname, '../dev/definitions.txt');

// Entry store that combines in-memory batch entries with DB-loaded entries.
// DB entries are preloaded for metrics that have search keys so that
// cross-request reference resolution and duplicate detection work.

interface DbSearchKeyEntry {
  entryId: number;
  logicalDefinitionId: string;
  searchKeyValue: string;
  resolvedEntry: ResolvedEntry;
}

class EntryStore implements ExistingEntriesResolver {
  private batchEntries: ResolvedEntry[] = [];
  private dbSearchKeyEntries: DbSearchKeyEntry[] = [];
  private parsedDefs: ParsedDefinitions | null = null;

  setParsedDefinitions(defs: ParsedDefinitions): void {
    this.parsedDefs = defs;
  }

  /** Preload entries from DB for all metrics that have a search key */
  async preloadFromDb(
    userId: string,
    parsedDefs: ParsedDefinitions,
    definitionIdMap: Map<string, string>,
    fieldIdMap: Map<string, string>
  ): Promise<void> {
    const metricsWithKeys = parsedDefs.metricDefinitions.filter(
      (md) => md.searchKeyType !== null
    );
    if (metricsWithKeys.length === 0) return;

    // Build reverse maps: DB UUID → logical ID
    const defUuidToLogical = new Map<string, string>();
    for (const [logicalId, uuid] of definitionIdMap) {
      defUuidToLogical.set(uuid, logicalId);
    }
    const fieldUuidToLogical = new Map<string, string>();
    for (const [logicalId, uuid] of fieldIdMap) {
      fieldUuidToLogical.set(uuid, logicalId);
    }

    // Get DB UUIDs for metrics with keys
    const dbUuids = metricsWithKeys
      .map((md) => definitionIdMap.get(md.definitionId))
      .filter((uuid): uuid is string => uuid !== undefined);
    if (dbUuids.length === 0) return;

    // Query entries with search_key_value
    const { data: entryRows, error } = await supabase
      .from('entries')
      .select('id, definition_id, timestamp, subdivision, search_key_value')
      .eq('user_id', userId)
      .in('definition_id', dbUuids)
      .not('search_key_value', 'is', null);

    if (error || !entryRows) {
      console.warn('[EntryStore] Failed to preload entries:', error?.message);
      return;
    }

    // Load CHILD entries for these metric entries (attribute values live on children)
    const parentIds = (entryRows as { id: number }[]).map((r) => r.id);
    let childEntryRows: { id: number; parent_entry_id: number; subdivision: string | null }[] = [];
    if (parentIds.length > 0) {
      const { data, error: childError } = await supabase
        .from('entries')
        .select('id, parent_entry_id, subdivision')
        .in('parent_entry_id', parentIds);
      if (!childError && data) childEntryRows = data;
    }

    // Load attribute entries for the child entries
    const childIds = childEntryRows.map((r) => r.id);
    let attrRows: { entry_id: number; field_id: string; value_string: string | null; value_int: number | null; value_float: number | null }[] = [];
    if (childIds.length > 0) {
      const { data, error: attrError } = await supabase
        .from('attribute_entries')
        .select('entry_id, field_id, value_string, value_int, value_float')
        .in('entry_id', childIds);
      if (!attrError && data) attrRows = data;
    }

    // Index: child entry id → attribute row
    const attrByChildId = new Map<number, typeof attrRows[0]>();
    for (const row of attrRows) {
      attrByChildId.set(row.entry_id, row);
    }

    // Index: parent entry id → child entries with their attributes
    const childrenByParent = new Map<number, { childEntry: typeof childEntryRows[0]; attr: typeof attrRows[0] }[]>();
    for (const childRow of childEntryRows) {
      const attr = attrByChildId.get(childRow.id);
      if (!attr) continue;
      const existing = childrenByParent.get(childRow.parent_entry_id) || [];
      existing.push({ childEntry: childRow, attr });
      childrenByParent.set(childRow.parent_entry_id, existing);
    }

    // Build ResolvedEntry objects using logical IDs
    for (const row of entryRows as { id: number; definition_id: string; timestamp: string; subdivision: string | null; search_key_value: string }[]) {
      const logicalDefId = defUuidToLogical.get(row.definition_id);
      if (!logicalDefId) continue;

      const now = new Date();
      const entry = new Entry(
        row.id, userId, logicalDefId, null,
        new Date(row.timestamp), row.subdivision, null, now, now
      );

      const children: ResolvedEntry[] = [];
      const childData = childrenByParent.get(row.id) || [];
      for (const { childEntry: childRow, attr } of childData) {
        const logicalFieldId = fieldUuidToLogical.get(attr.field_id);
        if (!logicalFieldId) continue;

        const field = parsedDefs.fields.find((f) => f.id === logicalFieldId);
        const childDefId = field ? field.baseDefinitionId : logicalDefId;

        const childEntry = new Entry(
          childRow.id, userId, childDefId, row.id,
          new Date(row.timestamp), childRow.subdivision, null, now, now
        );
        const attrEntry = new AttributeEntry(
          childRow.id, logicalFieldId,
          attr.value_int ?? null, attr.value_float ?? null,
          attr.value_string ?? null, null, null, null
        );
        children.push({
          entry: childEntry,
          attributeEntry: attrEntry,
          fieldId: logicalFieldId,
          children: [],
        });
      }

      const resolved: ResolvedEntry = {
        entry,
        metricEntry: new MetricEntry(row.id),
        children,
      };

      this.dbSearchKeyEntries.push({
        entryId: row.id,
        logicalDefinitionId: logicalDefId,
        searchKeyValue: row.search_key_value,
        resolvedEntry: resolved,
      });
    }

    console.log(`[EntryStore] Preloaded ${this.dbSearchKeyEntries.length} entries with search keys`);
  }

  addEntry(entry: ResolvedEntry): void {
    this.batchEntries.push(entry);
  }

  findByPrimaryIdentifier(
    metricDefinitionId: string,
    identifierValue: string | number
  ): ResolvedEntry[] {
    if (!this.parsedDefs) return [];
    const metricDef = this.parsedDefs.metricDefinitions.find(
      (md) => md.definitionId === metricDefinitionId
    );
    if (!metricDef || !metricDef.primaryIdentifierFieldId) return [];

    // Check batch entries
    return this.batchEntries.filter((e) => {
      if (e.entry.definitionId !== metricDefinitionId || !e.metricEntry) return false;
      for (const child of e.children) {
        if (child.fieldId === metricDef.primaryIdentifierFieldId && child.attributeEntry) {
          const val = child.attributeEntry.valueString ?? child.attributeEntry.valueInt;
          if (val === identifierValue) return true;
        }
      }
      return false;
    });
  }

  findBySearchKey(
    metricDefinitionId: string,
    searchKeyValue: string
  ): ResolvedEntry[] {
    // Check DB-preloaded entries (matched by stored search_key_value)
    const dbMatches = this.dbSearchKeyEntries
      .filter((e) =>
        e.logicalDefinitionId === metricDefinitionId &&
        e.searchKeyValue === searchKeyValue
      )
      .map((e) => e.resolvedEntry);

    // Check batch entries (matched by field value)
    if (!this.parsedDefs) return dbMatches;
    const metricDef = this.parsedDefs.metricDefinitions.find(
      (md) => md.definitionId === metricDefinitionId
    );
    if (!metricDef || !metricDef.searchKeyType) return dbMatches;

    const batchMatches = this.batchEntries.filter((e) => {
      if (e.entry.definitionId !== metricDefinitionId || !e.metricEntry) return false;

      if (metricDef.searchKeyType === 'subdivision') {
        return e.entry.subdivision === searchKeyValue;
      }

      if (metricDef.searchKeyFieldId) {
        for (const child of e.children) {
          if (child.fieldId === metricDef.searchKeyFieldId && child.attributeEntry) {
            const val = child.attributeEntry.valueString ?? child.attributeEntry.valueInt;
            return String(val) === searchKeyValue;
          }
        }
      }
      return false;
    });

    return [...dbMatches, ...batchMatches];
  }
}

// Cached infrastructure for data entry
let cachedParsedDefinitions: ParsedDefinitions | null = null;
let cachedPersistenceConfig: PersistenceConfig | null = null;
let parserRegistry: ParserRegistry | null = null;

async function initDataEntryInfrastructure(): Promise<{
  parsedDefinitions: ParsedDefinitions;
  persistenceConfig: PersistenceConfig;
  registry: ParserRegistry;
}> {
  // Load definitions if not cached
  if (!cachedParsedDefinitions) {
    cachedParsedDefinitions = parseDefinitions(DEFINITIONS_FILE);
    console.log('[DataEntry] Loaded definitions');
  }

  // Load persistence config if not cached
  if (!cachedPersistenceConfig) {
    const definitionIdMap = await loadDefinitionIdMap(USER_ID);
    const fieldIdMap = await loadFieldIdMap(USER_ID, definitionIdMap);
    cachedPersistenceConfig = { definitionIdMap, fieldIdMap };
    console.log('[DataEntry] Loaded persistence config');
  }

  // Create parser registry if not cached
  if (!parserRegistry) {
    parserRegistry = new ParserRegistry();
    parserRegistry.register(new DefaultParser());
    parserRegistry.register(new TimingParser());
    console.log('[DataEntry] Initialized parser registry');
  }

  return {
    parsedDefinitions: cachedParsedDefinitions,
    persistenceConfig: cachedPersistenceConfig,
    registry: parserRegistry,
  };
}

/**
 * Regenerate definitions.txt from the database and clear the definition cache.
 * Called after every schema editor write so data entry picks up the changes immediately.
 */
async function generateAndWriteDefinitionsFile(): Promise<void> {
  const { data: defs } = await supabase
    .from('definitions')
    .select('id, code, display_name, description, category')
    .eq('user_id', USER_ID)
    .eq('type', 'metric')
    .order('created_at');

  if (!defs || defs.length === 0) return;

  const defIds = (defs as { id: string }[]).map((d) => d.id);

  const [metricDefsResult, fieldsResult] = await Promise.all([
    supabase.from('metric_definitions').select('definition_id, primary_identifier_field_id').in('definition_id', defIds),
    supabase.from('fields')
      .select('id, metric_definition_id, name, description, base_definition_id, min_instances, max_instances, input_mode, formula')
      .in('metric_definition_id', defIds)
      .order('created_at'),
  ]);

  const allFields = (fieldsResult.data || []) as {
    id: string; metric_definition_id: string; name: string; description: string;
    base_definition_id: string; min_instances: number; max_instances: number | null;
    input_mode: string; formula: string | null;
  }[];

  const keyFieldMap = new Map(
    ((metricDefsResult.data || []) as { definition_id: string; primary_identifier_field_id: string | null }[])
      .map((m) => [m.definition_id, m.primary_identifier_field_id])
  );

  const baseDefIds = [...new Set(allFields.map((f) => f.base_definition_id))];
  let attrDefs: { definition_id: string; datatype: string }[] = [];
  let refMetrics: { id: string; code: string }[] = [];

  if (baseDefIds.length > 0) {
    const [attrResult, refResult] = await Promise.all([
      supabase.from('attribute_definitions').select('definition_id, datatype').in('definition_id', baseDefIds),
      supabase.from('definitions').select('id, code').in('id', baseDefIds).eq('type', 'metric'),
    ]);
    attrDefs = (attrResult.data || []) as typeof attrDefs;
    refMetrics = (refResult.data || []) as typeof refMetrics;
  }

  const attrTypeMap = new Map(attrDefs.map((a) => [a.definition_id, a.datatype]));
  const refMetricMap = new Map(refMetrics.map((m) => [m.id, m.code]));

  const fieldsByDef = new Map<string, typeof allFields>();
  for (const f of allFields) {
    const list = fieldsByDef.get(f.metric_definition_id) || [];
    list.push(f);
    fieldsByDef.set(f.metric_definition_id, list);
  }

  const blocks: string[] = [];

  for (const def of defs as { id: string; code: string; display_name: string; description: string; category: string | null }[]) {
    const lines: string[] = [`METRIC ${def.code}`];
    const name = def.display_name || def.code;
    const desc = def.description || '';
    const cat = def.category || '';

    if (name !== def.code) lines.push(`  NAME "${name}"`);
    if (desc) lines.push(`  DESCRIPTION "${desc}"`);
    if (cat) lines.push(`  CATEGORY "${cat}"`);
    if (name !== def.code || desc || cat) lines.push('');

    const keyFieldId = keyFieldMap.get(def.id) ?? null;
    const defFields = fieldsByDef.get(def.id) || [];

    for (const f of defFields) {
      let typeStr: string;
      if (attrTypeMap.has(f.base_definition_id)) {
        typeStr = attrTypeMap.get(f.base_definition_id)!;
      } else if (refMetricMap.has(f.base_definition_id)) {
        typeStr = refMetricMap.get(f.base_definition_id)!;
      } else {
        continue;
      }

      let fieldLine = `  ${f.name}`;

      // Cardinality emission:
      //   min=0, max=1   → "?" (optional single)
      //   min=1, max=1   → no annotation (default)
      //   anything else  → "(min,max)" with "n" for unlimited
      if (f.min_instances === 0 && f.max_instances === 1) {
        fieldLine += '?';
      } else if (f.min_instances !== 1 || f.max_instances !== 1) {
        const maxStr = f.max_instances === null ? 'n' : String(f.max_instances);
        typeStr += ` (${f.min_instances},${maxStr})`;
      }

      fieldLine += `: ${typeStr}`;
      if (f.id === keyFieldId) fieldLine += ' @key';
      if (f.input_mode === 'formula' && f.formula) fieldLine += ` = ${f.formula}`;
      if (f.description) fieldLine += `  # "${f.description}"`;

      lines.push(fieldLine);
    }

    lines.push('END');
    blocks.push(lines.join('\n'));
  }

  fs.writeFileSync(DEFINITIONS_FILE, blocks.join('\n\n') + '\n', 'utf-8');
  console.log('[Schema] Wrote definitions.txt with', defs.length, 'metrics');

  // Clear cache so next data-entry request re-reads the updated file
  cachedParsedDefinitions = null;
  cachedPersistenceConfig = null;
}

/**
 * Parse a required date range from query/body params.
 *
 * Wire contract: `startDate` and `endDate` are BOTH INCLUSIVE (YYYY-MM-DD).
 * This helper returns the internal half-open interval `[startDate, endDateExclusive)`
 * where `endDateExclusive = endDate + 1 day`.
 *
 * Throws on missing/invalid input with a message suitable for a 400 response.
 */
function parseDateRange(
  startDateParam: string | undefined,
  endDateParam: string | undefined,
): { startDate: Date; endDate: Date } {
  if (!startDateParam || !endDateParam) {
    throw new Error('startDate and endDate are required (YYYY-MM-DD)');
  }
  let start: Date;
  let end: Date;
  try {
    start = parseLocalDate(startDateParam);
  } catch {
    throw new Error(`Invalid startDate: ${startDateParam}`);
  }
  try {
    end = parseLocalDate(endDateParam);
  } catch {
    throw new Error(`Invalid endDate: ${endDateParam}`);
  }
  if (start.getTime() > end.getTime()) {
    throw new Error(`startDate (${startDateParam}) must be on or before endDate (${endDateParam})`);
  }
  // Convert inclusive endDate to the exclusive upper bound used internally.
  return { startDate: start, endDate: addDays(end, 1) };
}

/**
 * Parse a required single date param (YYYY-MM-DD) as local-time midnight.
 * Throws on missing/invalid input.
 */
function parseRequiredDate(param: string | undefined, name: string): Date {
  if (!param) throw new Error(`${name} is required (YYYY-MM-DD)`);
  try {
    return parseLocalDate(param);
  } catch {
    throw new Error(`Invalid ${name}: ${param}`);
  }
}

/**
 * Recursively set timestamp on a MetricEntryInput and all nested metric entries.
 * The TimingParser creates entries with new Date(), so we need to update all of them.
 */
function setTimestampRecursively(entry: { timestamp: Date; fields?: Array<{ values?: Array<{ metricEntry?: { timestamp: Date; fields?: Array<{ values?: Array<{ metricEntry?: unknown }> }> } }> }> }, timestamp: Date): void {
  entry.timestamp = timestamp;

  // Recurse into nested metric entries in field values
  if (entry.fields) {
    for (const field of entry.fields) {
      if (field.values) {
        for (const value of field.values) {
          if (value.metricEntry) {
            setTimestampRecursively(value.metricEntry as typeof entry, timestamp);
          }
        }
      }
    }
  }
}

/**
 * Split input content into blocks (separated by blank lines).
 * Returns each block together with its 1-indexed starting line number in the full input.
 */
function splitIntoBlocks(content: string): { block: string; startLine: number }[] {
  const lines = content.split('\n');
  const blocks: { block: string; startLine: number }[] = [];
  let currentBlock: string[] = [];
  let blockStartLine = 1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed === '') {
      if (currentBlock.length > 0) {
        blocks.push({ block: currentBlock.join('\n'), startLine: blockStartLine });
        currentBlock = [];
      }
    } else {
      if (currentBlock.length === 0) {
        blockStartLine = i + 1;
      }
      currentBlock.push(line);
    }
  }

  if (currentBlock.length > 0) {
    blocks.push({ block: currentBlock.join('\n'), startLine: blockStartLine });
  }

  // Filter out blocks that contain only comments
  return blocks.filter(({ block }) => {
    const nonCommentLines = block
      .split('\n')
      .filter((l) => l.trim() !== '' && !l.trim().startsWith('#'));
    return nonCommentLines.length > 0;
  });
}

/** Regex matching date headers (same as ParserRegistry.parseDateHeader) */
const DATE_HEADER_RE = /^([LMXJVSD])?(\d{1,2})\/(\d{1,2})$/;

/**
 * Returns 1 if the block starts with a date header line (which will be removed
 * by the registry before parsing, shifting all subsequent line numbers by 1).
 */
function dateHeaderOffset(block: string): number {
  for (const line of block.split('\n')) {
    const trimmed = line.trim();
    if (trimmed !== '' && !trimmed.startsWith('#')) {
      return DATE_HEADER_RE.test(trimmed) ? 1 : 0;
    }
  }
  return 0;
}

/**
 * Convert a parser-relative line number to a global (full-input) line number.
 */
function toGlobalLine(parserLine: number, blockStartLine: number, headerOffset: number): number {
  return blockStartLine + parserLine - 1 + headerOffset;
}

/**
 * Represents a parsed timing for preview
 */
interface ParsedTiming {
  timeInit: number;
  timeEnd: number;
  duration: number;
  netProductivity: number | null;
  subdivision: string | null;
}

/**
 * Extract timing data from a ResolvedEntry tree for preview
 */
function extractTimingsFromResolved(resolved: ResolvedEntry): ParsedTiming[] {
  const timings: ParsedTiming[] = [];

  function traverse(entry: ResolvedEntry): void {
    // Check if this is a TIM entry
    if (entry.entry.definitionId.includes('tim') && entry.metricEntry) {
      let timeInit: number | null = null;
      let timeEnd: number | null = null;
      let tValue = 0;
      let mValue = 0;
      let pValue = 0;

      // Extract values from children
      for (const child of entry.children) {
        if (child.attributeEntry) {
          const fieldId = child.attributeEntry.fieldId;
          const value = child.attributeEntry.valueInt;

          if (fieldId.includes('time_init') && value !== null) {
            timeInit = value;
          } else if (fieldId.includes('time_end') && value !== null) {
            timeEnd = value;
          } else if (fieldId.includes('time_type') && value !== null) {
            // Get subdivision from entry to determine t/m/p/n
            const sub = child.entry.subdivision || '';
            const baseSub = sub.split('/')[0]; // Get base category (t, m, p, n)
            if (baseSub === 't') tValue += value;
            else if (baseSub === 'm') mValue += value;
            else if (baseSub === 'p') pValue += value;
          }
        }
      }

      if (timeInit !== null && timeEnd !== null) {
        const duration = timeEnd - timeInit;
        const productive = tValue + mValue + pValue;
        const netProductivity = productive > 0 ? tValue / productive : null;

        timings.push({
          timeInit,
          timeEnd,
          duration,
          netProductivity,
          subdivision: entry.entry.subdivision,
        });
      }
    }

    // Recurse into children
    for (const child of entry.children) {
      traverse(child);
    }
  }

  traverse(resolved);
  return timings;
}

/**
 * Extract field name → value map from a resolved metric entry (for preview row).
 * Includes both input fields and formula-computed fields.
 * Reference fields (resolvedFromExisting) are skipped — caller should keep the user-typed string.
 */
function extractFieldValues(
  resolved: ResolvedEntry,
  parsedDefinitions: ParsedDefinitions
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const child of resolved.children) {
    if (!child.fieldId || !child.attributeEntry) continue;
    const field = parsedDefinitions.fields.find(f => f.id === child.fieldId);
    if (!field) continue;
    const value = getAttributeValue(child.attributeEntry);
    if (value !== null) result[field.name] = String(value);
  }
  return result;
}

/**
 * POST /api/v2/run-widget
 *
 * Run a v2 widget DSL through the full pipeline:
 *   parse → analyze → execute → mapToChart
 *
 * Input:
 *   widgetSource: string    — widget DSL source
 *   startDate:    string    — YYYY-MM-DD (inclusive)
 *   endDate:      string    — YYYY-MM-DD (inclusive)
 *   smallPeriod?: 'hour'|'day'|'week'|'month'
 *
 * Output (success):
 *   { success: true, name: string, table: IntermediateTable, chart: ChartOutput }
 *
 * Output (failure):
 *   { success: false, error: string, errors?: string[] }
 *
 * Errors from parse/analysis return 400; executor errors return 500.
 */
app.post('/api/v2/run-widget', async (req: Request, res: Response) => {
  try {
    const {
      widgetSource,
      startDate: startDateParam,
      endDate: endDateParam,
      smallPeriod: smallPeriodParam,
    } = req.body;

    if (!widgetSource || typeof widgetSource !== 'string') {
      res.status(400).json({ success: false, error: 'Missing or invalid widgetSource' });
      return;
    }

    let startDate: Date;
    let endDate: Date;
    try {
      ({ startDate, endDate } = parseDateRange(startDateParam, endDateParam));
    } catch (err) {
      res.status(400).json({ success: false, error: err instanceof Error ? err.message : String(err) });
      return;
    }

    const config = {
      userId: USER_ID,
      startDate,
      endDate,
      smallPeriod: smallPeriodParam as SmallPeriod | undefined,
    };

    const result = await runWidgetV2(widgetSource, config);

    if (!result.success) {
      const status = result.stage === 'execute' ? 500 : 400;
      res.status(status).json({
        success: false,
        error: result.error,
        ...(result.errors ? { errors: result.errors } : {}),
      });
      return;
    }

    res.json({
      success: true,
      name: result.name,
      table: result.table,
      chart: result.chart,
      presentation: result.presentation,
    });
  } catch (err) {
    console.error('[v2] Widget execution error:', err);
    res.status(500).json({
      success: false,
      error: err instanceof Error ? err.message : 'Internal server error',
    });
  }
});

/**
 * GET /api/health
 *
 * Health check endpoint
 */
app.get('/api/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', userId: USER_ID });
});

/**
 * GET /api/widgets
 *
 * List all stored widgets for the user
 */
app.get('/api/widgets', async (_req: Request, res: Response) => {
  try {
    const widgets = await loadWidgets(USER_ID);
    res.json({
      success: true,
      widgets: widgets.map((w) => ({
        id: w.id,
        name: w.name,
        createdAt: w.createdAt.toISOString(),
      })),
    });
  } catch (err) {
    console.error('Widget list error:', err);
    res.status(500).json({
      success: false,
      error: err instanceof Error ? err.message : 'Internal server error',
    });
  }
});

// ============================================
// Dashboard CRUD Endpoints
// ============================================

/**
 * GET /api/dashboards
 *
 * List all dashboards for the user
 */
app.get('/api/dashboards', async (_req: Request, res: Response) => {
  try {
    const dashboards = await loadDashboards(USER_ID);
    res.json({
      success: true,
      dashboards: dashboards.map((d) => ({
        id: d.id,
        name: d.name,
        createdAt: d.createdAt.toISOString(),
        globalFilters: d.globalFilters ?? null,
      })),
    });
  } catch (err) {
    console.error('Dashboard list error:', err);
    res.status(500).json({
      success: false,
      error: err instanceof Error ? err.message : 'Internal server error',
    });
  }
});

/**
 * POST /api/dashboards
 *
 * Create a new dashboard
 * Input: { name: string }
 */
app.post('/api/dashboards', async (req: Request, res: Response) => {
  try {
    const { name } = req.body;

    if (!name || typeof name !== 'string') {
      res.status(400).json({
        success: false,
        error: 'Missing or invalid name',
      });
      return;
    }

    const dashboard = await createDashboard(name.trim(), USER_ID);
    res.json({
      success: true,
      dashboard: {
        id: dashboard.id,
        name: dashboard.name,
        createdAt: dashboard.createdAt.toISOString(),
      },
    });
  } catch (err) {
    console.error('Dashboard create error:', err);
    res.status(500).json({
      success: false,
      error: err instanceof Error ? err.message : 'Internal server error',
    });
  }
});

/**
 * PATCH /api/dashboards/:id/filters
 *
 * Save (overwrite) the global filter for a dashboard.
 * Body: DashboardGlobalFilter  (pass null or {} to clear all filters)
 */
app.patch('/api/dashboards/:id/filters', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const filters: DashboardGlobalFilter | null = req.body ?? null;

    // Treat empty object as "clear filters"
    const isEmptyObject = filters !== null && typeof filters === 'object' && Object.keys(filters).length === 0;
    const toSave = isEmptyObject ? null : filters;

    await saveDashboardFilters(id, USER_ID, toSave);
    res.json({ success: true });
  } catch (err) {
    console.error('Dashboard filters error:', err);
    res.status(500).json({
      success: false,
      error: err instanceof Error ? err.message : 'Internal server error',
    });
  }
});

/**
 * PATCH /api/dashboards/:id
 *
 * Rename a dashboard.
 * Body: { name: string }
 */
app.patch('/api/dashboards/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { name } = req.body as { name?: string };
    if (!name || typeof name !== 'string' || !name.trim()) {
      res.status(400).json({ success: false, error: 'Missing or invalid name' });
      return;
    }
    const dashboard = await updateDashboard(id, name.trim(), USER_ID);
    res.json({
      success: true,
      dashboard: {
        id: dashboard.id,
        name: dashboard.name,
        createdAt: dashboard.createdAt.toISOString(),
      },
    });
  } catch (err) {
    console.error('Dashboard rename error:', err);
    res.status(500).json({
      success: false,
      error: err instanceof Error ? err.message : 'Internal server error',
    });
  }
});

/**
 * DELETE /api/dashboards/:id
 *
 * Delete a dashboard (cascades to widgets)
 */
app.delete('/api/dashboards/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    await deleteDashboard(id, USER_ID);
    res.json({ success: true });
  } catch (err) {
    console.error('Dashboard delete error:', err);
    res.status(500).json({
      success: false,
      error: err instanceof Error ? err.message : 'Internal server error',
    });
  }
});

/**
 * GET /api/dashboards/:id/widgets
 *
 * Get all widgets for a dashboard and execute them.
 * Query params (required):
 * - startDate: YYYY-MM-DD (inclusive)
 * - endDate:   YYYY-MM-DD (inclusive)
 * - groupBy?:  smallPeriod ('hour' | 'day' | 'week' | 'month')
 */
app.get('/api/dashboards/:id/widgets', async (req: Request, res: Response) => {
  try {
    const { id: dashboardId } = req.params;

    // Verify dashboard exists and belongs to user
    const dashboard = await loadDashboardById(dashboardId, USER_ID);
    if (!dashboard) {
      res.status(404).json({
        success: false,
        error: 'Dashboard not found',
      });
      return;
    }

    const smallPeriodParam = req.query.groupBy as SmallPeriod | undefined;

    let startDate: Date;
    let endDate: Date;
    try {
      ({ startDate, endDate } = parseDateRange(
        req.query.startDate as string | undefined,
        req.query.endDate   as string | undefined,
      ));
    } catch (err) {
      res.status(400).json({ success: false, error: err instanceof Error ? err.message : String(err) });
      return;
    }

    // Global filter from stored dashboard config
    const globalFilter: DashboardGlobalFilter | undefined =
      dashboard.globalFilters ?? undefined;

    // Load widgets for the dashboard
    const storedWidgets = await loadWidgetsByDashboard(dashboardId, USER_ID);

    // Execute each widget through the v2 pipeline
    const widgetResults = await Promise.all(
      storedWidgets.map(async (widget) => {
        const base = {
          id: widget.id,
          name: widget.name,
          dsl: widget.dsl,
          orderIndex: widget.orderIndex,
        };
        try {
          const result = await runWidgetV2(widget.dsl, {
            userId: USER_ID,
            startDate,
            endDate,
            smallPeriod: smallPeriodParam,
            globalFilter,
          });
          if (result.success) {
            return { ...base, name: result.name, table: result.table, chart: result.chart, presentation: result.presentation, error: null };
          }
          return { ...base, table: null, chart: null, presentation: null, error: result.error };
        } catch (err) {
          const errorMessage = err instanceof Error ? err.message : 'Unknown error';
          return { ...base, table: null, chart: null, presentation: null, error: errorMessage };
        }
      })
    );

    res.json({
      success: true,
      dashboard: {
        id: dashboard.id,
        name: dashboard.name,
        globalFilters: dashboard.globalFilters ?? null,
      },
      widgets: widgetResults,
    });
  } catch (err) {
    console.error('Dashboard widgets error:', err);
    res.status(500).json({
      success: false,
      error: err instanceof Error ? err.message : 'Internal server error',
    });
  }
});

// ============================================
// Widget CRUD Endpoints
// ============================================

/**
 * POST /api/widgets
 *
 * Create a new widget in a dashboard
 * Input: { dashboardId: string, name: string, dsl: string }
 */
app.post('/api/widgets', async (req: Request, res: Response) => {
  try {
    const { dashboardId, name, dsl } = req.body;

    if (!dashboardId || typeof dashboardId !== 'string') {
      res.status(400).json({ success: false, error: 'Missing or invalid dashboardId' });
      return;
    }
    if (!name || typeof name !== 'string') {
      res.status(400).json({ success: false, error: 'Missing or invalid name' });
      return;
    }
    if (!dsl || typeof dsl !== 'string') {
      res.status(400).json({ success: false, error: 'Missing or invalid dsl' });
      return;
    }

    // Verify dashboard exists
    const dashboard = await loadDashboardById(dashboardId, USER_ID);
    if (!dashboard) {
      res.status(404).json({ success: false, error: 'Dashboard not found' });
      return;
    }

    const widget = await createWidget({ dashboardId, name: name.trim(), dsl }, USER_ID);
    res.json({
      success: true,
      widget: {
        id: widget.id,
        dashboardId: widget.dashboardId,
        name: widget.name,
        orderIndex: widget.orderIndex,
        createdAt: widget.createdAt.toISOString(),
      },
    });
  } catch (err) {
    console.error('Widget create error:', err);
    res.status(500).json({
      success: false,
      error: err instanceof Error ? err.message : 'Internal server error',
    });
  }
});

/**
 * PATCH /api/widgets/:id
 *
 * Update a widget (rename, update DSL, or reorder)
 * Input: { name?: string, dsl?: string, direction?: 'up' | 'down' }
 */
app.patch('/api/widgets/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { name, dsl, direction } = req.body;

    // Handle reorder
    if (direction && ['up', 'down'].includes(direction)) {
      await reorderWidget(id, direction, USER_ID);
      res.json({ success: true });
      return;
    }

    // Handle update (name and/or dsl)
    const updates: { name?: string; dsl?: string } = {};

    if (name !== undefined) {
      if (typeof name !== 'string' || !name.trim()) {
        res.status(400).json({ success: false, error: 'Invalid name' });
        return;
      }
      updates.name = name.trim();
    }

    if (dsl !== undefined) {
      if (typeof dsl !== 'string') {
        res.status(400).json({ success: false, error: 'Invalid dsl' });
        return;
      }
      updates.dsl = dsl;
    }

    if (Object.keys(updates).length > 0) {
      const widget = await updateWidget(id, updates, USER_ID);
      res.json({
        success: true,
        widget: {
          id: widget.id,
          name: widget.name,
          dsl: widget.dsl,
          orderIndex: widget.orderIndex,
        },
      });
      return;
    }

    res.status(400).json({ success: false, error: 'No valid update provided' });
  } catch (err) {
    console.error('Widget update error:', err);
    res.status(500).json({
      success: false,
      error: err instanceof Error ? err.message : 'Internal server error',
    });
  }
});

/**
 * DELETE /api/widgets/:id
 *
 * Delete a widget
 */
app.delete('/api/widgets/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    await deleteWidget(id, USER_ID);
    res.json({ success: true });
  } catch (err) {
    console.error('Widget delete error:', err);
    res.status(500).json({
      success: false,
      error: err instanceof Error ? err.message : 'Internal server error',
    });
  }
});

// ============================================
// Definitions Endpoint (for Simple Mode)
// ============================================

/**
 * GET /api/definitions
 *
 * Returns metric definitions with their fields for Simple mode data entry.
 * Each metric includes: code, displayName, fields (name, type, optional),
 * and whether the metric supports timings.
 */
app.get('/api/definitions', async (_req: Request, res: Response) => {
  try {
    const { parsedDefinitions } = await initDataEntryInfrastructure();

    const metrics: Array<{
      code: string;
      displayName: string;
      name: string;
      description: string;
      timingCapable: boolean;
      fields: Array<{
        name: string;
        type: string;
        optional: boolean;
        inputMode: string;
        description: string;
      }>;
    }> = [];

    // Find TIM definition id for timing capability check
    const timDef = parsedDefinitions.definitionsByCode.get('TIM');
    const timDefId = timDef ? timDef.id : null;

    for (const def of parsedDefinitions.definitions) {
      if (def.type !== 'metric') continue;

      const fields = parsedDefinitions.fieldsByMetricCode.get(def.code) || [];

      // Check timing capability: has a field whose baseDefinitionId is TIM
      const timingCapable = timDefId !== null && fields.some(f => f.baseDefinitionId === timDefId);

      // Get the key field ID for this metric (primaryIdentifierFieldId)
      const metricDef = parsedDefinitions.metricDefinitions.find(md => md.definitionId === def.id);
      const keyFieldId = metricDef?.primaryIdentifierFieldId ?? null;

      // Build field list: all fields except timing (which has its own UI)
      const fieldInfos = fields
        .filter(f => {
          // Skip timing fields — they have their own dedicated UI
          if (timDefId !== null && f.baseDefinitionId === timDefId) return false;
          return true;
        })
        .map(f => {
          const attrDef = parsedDefinitions.attributeDefinitions.find(
            ad => ad.definitionId === f.baseDefinitionId
          );
          // Metric-reference fields (no matching attributeDefinition) — find the referenced metric's code
          let referencedMetricCode: string | undefined;
          if (!attrDef) {
            const refDef = parsedDefinitions.definitions.find(
              d => d.id === f.baseDefinitionId && d.type === 'metric'
            );
            if (refDef) {
              referencedMetricCode = refDef.code;
            }
          }
          return {
            name: f.name,
            type: attrDef ? attrDef.datatype : 'string',
            optional: f.minInstances === 0,
            inputMode: f.inputMode,
            isKey: keyFieldId !== null && f.id === keyFieldId,
            isFormula: f.inputMode === 'formula',
            description: parsedDefinitions.fieldDescriptions.get(f.id) ?? '',
            ...(referencedMetricCode ? { referencedMetricCode } : {}),
          };
        });

      // Skip TIM itself — it's not directly enterable by users
      if (def.code === 'TIM') continue;

      const metaDesc = parsedDefinitions.metricDescriptions.get(def.code);
      metrics.push({
        code: def.code,
        displayName: def.displayName,
        name: metaDesc?.name ?? def.code,
        description: metaDesc?.description ?? '',
        timingCapable,
        fields: fieldInfos,
      });
    }

    res.json({ success: true, definitions: metrics });
  } catch (err) {
    console.error('[API] Definitions error:', err);
    res.status(500).json({
      success: false,
      error: err instanceof Error ? err.message : 'Internal server error',
    });
  }
});

// ============================================
// Search Keys Endpoint (for metric-reference typeahead)
// ============================================

/**
 * GET /api/entries/search-keys
 *
 * Returns deduplicated search_key_value list for a given metric definition.
 * Query params:
 *   - definitionCode (required): metric code (e.g. "BOOK")
 *   - q (optional): case-insensitive substring filter
 * Output: { success: true, searchKeys: string[] }
 */
app.get('/api/entries/search-keys', async (req: Request, res: Response) => {
  try {
    const definitionCode = req.query.definitionCode as string | undefined;
    if (!definitionCode) {
      res.status(400).json({ success: false, error: 'Missing definitionCode' });
      return;
    }

    const q = (req.query.q as string | undefined) || '';

    // Look up the definition's UUID
    const { persistenceConfig } = await initDataEntryInfrastructure();
    const { parsedDefinitions } = await initDataEntryInfrastructure();
    const def = parsedDefinitions.definitionsByCode.get(definitionCode);
    if (!def) {
      res.json({ success: true, searchKeys: [] });
      return;
    }

    const defUuid = persistenceConfig.definitionIdMap.get(def.id);
    if (!defUuid) {
      res.json({ success: true, searchKeys: [] });
      return;
    }

    // Query entries with search_key_value for this definition
    let query = supabase
      .from('entries')
      .select('search_key_value')
      .eq('user_id', USER_ID)
      .eq('definition_id', defUuid)
      .not('search_key_value', 'is', null);

    if (q.trim()) {
      query = query.ilike('search_key_value', `%${q.trim()}%`);
    }

    const { data, error } = await query.limit(100);

    if (error) {
      res.status(500).json({ success: false, error: error.message });
      return;
    }

    // Deduplicate and limit
    const seen = new Set<string>();
    const searchKeys: string[] = [];
    for (const row of data || []) {
      const val = row.search_key_value as string;
      if (!seen.has(val)) {
        seen.add(val);
        searchKeys.push(val);
        if (searchKeys.length >= 20) break;
      }
    }

    res.json({ success: true, searchKeys });
  } catch (err) {
    console.error('[API] Search keys error:', err);
    res.status(500).json({
      success: false,
      error: err instanceof Error ? err.message : 'Internal server error',
    });
  }
});

// ============================================
// Recent Entries Endpoint
// ============================================

/**
 * GET /api/entries/recent
 *
 * Returns the last N entries for a given metric definition, with field values.
 * Query params:
 *   - definitionCode (required): metric code (e.g. "BOOK")
 *   - limit (optional): max entries to return, default 7
 * Output: { success: true, entries: Array<{ id, date, subdivision, searchKey, fields }> }
 */
app.get('/api/entries/recent', async (req: Request, res: Response) => {
  try {
    const definitionCode = req.query.definitionCode as string | undefined;
    if (!definitionCode) {
      res.status(400).json({ success: false, error: 'Missing definitionCode' });
      return;
    }

    const limit = Math.min(parseInt((req.query.limit as string) || '7', 10), 50);
    const { parsedDefinitions, persistenceConfig } = await initDataEntryInfrastructure();
    const { definitionIdMap, fieldIdMap } = persistenceConfig;

    // Look up definition UUID
    const def = parsedDefinitions.definitionsByCode.get(definitionCode);
    if (!def) {
      res.json({ success: true, entries: [] });
      return;
    }
    const defUuid = definitionIdMap.get(def.id);
    if (!defUuid) {
      res.json({ success: true, entries: [] });
      return;
    }

    // Build field UUID → field name reverse map
    const fieldById = new Map<string, (typeof parsedDefinitions.fields)[0]>();
    for (const f of parsedDefinitions.fields) fieldById.set(f.id, f);
    const fieldUuidToName = new Map<string, string>();
    for (const [logicalId, uuid] of fieldIdMap) {
      const f = fieldById.get(logicalId);
      if (f) fieldUuidToName.set(uuid, f.name);
    }

    // Query parent entries (no parent_entry_id = top-level metric entries)
    const { data: entryRows, error } = await supabase
      .from('entries')
      .select('id, timestamp, subdivision, search_key_value')
      .eq('user_id', USER_ID)
      .eq('definition_id', defUuid)
      .is('parent_entry_id', null)
      .order('timestamp', { ascending: false })
      .limit(limit);

    if (error || !entryRows || entryRows.length === 0) {
      res.json({ success: true, entries: [] });
      return;
    }

    const parentIds = (entryRows as { id: number }[]).map((r) => r.id);

    // Query child entries
    let childRows: { id: number; parent_entry_id: number }[] = [];
    const { data: cd } = await supabase
      .from('entries')
      .select('id, parent_entry_id')
      .in('parent_entry_id', parentIds);
    if (cd) childRows = cd;

    // Query attribute values for child entries (including value_entry_id for reference fields)
    const childIds = childRows.map((r) => r.id);
    let attrRows: { entry_id: number; field_id: string; value_string: string | null; value_int: number | null; value_float: number | null; value_entry_id: number | null }[] = [];
    if (childIds.length > 0) {
      const { data: ad } = await supabase
        .from('attribute_entries')
        .select('entry_id, field_id, value_string, value_int, value_float, value_entry_id')
        .in('entry_id', childIds);
      if (ad) attrRows = ad;
    }

    // Batch-resolve value_entry_id → search_key_value for reference fields
    const referencedEntryIds = [...new Set(
      attrRows.map(r => r.value_entry_id).filter((id): id is number => id !== null)
    )];
    const refSearchKeyMap = new Map<number, string>();
    if (referencedEntryIds.length > 0) {
      const { data: refRows } = await supabase
        .from('entries')
        .select('id, search_key_value')
        .in('id', referencedEntryIds)
        .not('search_key_value', 'is', null);
      for (const r of refRows || []) {
        if (r.search_key_value) refSearchKeyMap.set(r.id as number, r.search_key_value as string);
      }
    }

    // Index: child entry id → attribute row
    const attrByChildId = new Map<number, typeof attrRows[0]>();
    for (const r of attrRows) attrByChildId.set(r.entry_id, r);

    // Index: parent entry id → child entries
    const childrenByParent = new Map<number, typeof childRows[0][]>();
    for (const c of childRows) {
      const list = childrenByParent.get(c.parent_entry_id) || [];
      list.push(c);
      childrenByParent.set(c.parent_entry_id, list);
    }

    // Build response
    const entries = (entryRows as { id: number; timestamp: string; subdivision: string | null; search_key_value: string | null }[]).map((row) => {
      const fields: Record<string, string> = {};
      for (const child of childrenByParent.get(row.id) || []) {
        const attr = attrByChildId.get(child.id);
        if (!attr) continue;
        const fieldName = fieldUuidToName.get(attr.field_id);
        if (!fieldName) continue;
        let value: string | null = null;
        if (attr.value_entry_id !== null) {
          // Reference field: display the referenced entry's search key
          value = refSearchKeyMap.get(attr.value_entry_id) ?? '—';
        } else {
          value =
            attr.value_string ??
            (attr.value_float !== null ? String(attr.value_float) : null) ??
            (attr.value_int !== null ? String(attr.value_int) : null);
        }
        if (value !== null) fields[fieldName] = value;
      }
      return {
        id: row.id,
        date: row.timestamp.split('T')[0],
        subdivision: row.subdivision,
        searchKey: row.search_key_value,
        fields,
      };
    });

    res.json({ success: true, entries });
  } catch (err) {
    console.error('[API] Recent entries error:', err);
    res.status(500).json({
      success: false,
      error: err instanceof Error ? err.message : 'Internal server error',
    });
  }
});

// ============================================
// Data Entry Endpoints
// ============================================

/**
 * POST /api/entries/parse-preview
 *
 * Parse DSL input and return timing data for preview (without persisting)
 * Input: { dslInput: string, entryDate: string }
 * Output: { success: true, timings: ParsedTiming[] }
 *      or { success: false, error: string, lineNumber?: number }
 */
app.post('/api/entries/parse-preview', async (req: Request, res: Response) => {
  try {
    const { dslInput, entryDate: entryDateParam } = req.body;

    if (!dslInput || typeof dslInput !== 'string') {
      res.status(400).json({
        success: false,
        error: 'Missing or invalid dslInput',
      });
      return;
    }

    let entryDate: Date;
    try {
      entryDate = parseRequiredDate(entryDateParam, 'entryDate');
    } catch (err) {
      res.status(400).json({ success: false, error: err instanceof Error ? err.message : String(err) });
      return;
    }

    // Initialize infrastructure
    const { parsedDefinitions, persistenceConfig, registry } = await initDataEntryInfrastructure();

    // Build pipeline config with DB-backed entry resolution
    const entryStore = new EntryStore();
    entryStore.setParsedDefinitions(parsedDefinitions);
    await entryStore.preloadFromDb(
      USER_ID, parsedDefinitions,
      persistenceConfig.definitionIdMap, persistenceConfig.fieldIdMap
    );
    const pipelineConfig: PipelineConfig = {
      definitions: parsedDefinitions.definitions,
      metricDefinitions: parsedDefinitions.metricDefinitions,
      attributeDefinitions: parsedDefinitions.attributeDefinitions,
      fields: parsedDefinitions.fields,
      existingEntries: entryStore,
    };

    // Split input into blocks (each with its global start line)
    const blocks = splitIntoBlocks(dslInput);
    if (blocks.length === 0) {
      res.json({ success: true, timings: [], fieldValues: {} });
      return;
    }

    const allTimings: ParsedTiming[] = [];
    let previewFieldValues: Record<string, string> = {};
    // Collect all parse errors across blocks (keyed by global line number)
    const allParseErrors: Array<{ lineNumber: number; message: string; details?: string }> = [];

    // Set entry date on registry for date header resolution.
    // If DSL has a date header (e.g., V2/1), it overrides this.
    // Otherwise, entries use the date supplied by the UI.
    registry.setAnchorDate(entryDate);

    // Process each block — collect errors rather than aborting on first
    for (const { block, startLine } of blocks) {
      const headerOffset = dateHeaderOffset(block);
      const parseResult = registry.parseBlock(block, parsedDefinitions, USER_ID);

      if (!parseResult.success) {
        const errs = parseResult.error.allErrors;
        if (errs && errs.length > 0) {
          // Multiple line errors from timing block — map to global lines
          for (const e of errs) {
            allParseErrors.push({
              lineNumber: toGlobalLine(e.lineNumber, startLine, headerOffset),
              message: e.message,
              details: e.details,
            });
          }
        } else {
          // Single error (header-level, pipeline, etc.)
          allParseErrors.push({
            lineNumber: parseResult.error.lineNumber
              ? toGlobalLine(parseResult.error.lineNumber, startLine, headerOffset)
              : startLine,
            message: parseResult.error.message,
            details: parseResult.error.details,
          });
        }
        continue; // keep processing other blocks
      }

      // Check for warnings (e.g., weekday mismatches)
      const warnings = registry.getWarnings();
      if (warnings.length > 0) {
        console.log(`[API] Parse warnings: ${warnings.join(', ')}`);
      }

      // Run pipeline for each parsed entry
      for (const entryInput of parseResult.entries) {
        const pipelineResult = runPipeline(entryInput, pipelineConfig, USER_ID);

        if (!pipelineResult.success) {
          allParseErrors.push({
            lineNumber: startLine,
            message: pipelineResult.error.message,
          });
          continue;
        }

        // Extract timings from the resolved entry
        const timings = extractTimingsFromResolved(pipelineResult.value);
        allTimings.push(...timings);

        // Extract field values (input + formula) for preview row
        Object.assign(previewFieldValues, extractFieldValues(pipelineResult.value, parsedDefinitions));
      }
    }

    // Return errors if any were collected
    if (allParseErrors.length > 0) {
      res.json({
        success: false,
        errors: allParseErrors,
      });
      return;
    }

    res.json({
      success: true,
      timings: allTimings,
      fieldValues: previewFieldValues,
    });
  } catch (err) {
    console.error('[API] Parse preview error:', err);
    res.status(500).json({
      success: false,
      error: err instanceof Error ? err.message : 'Internal server error',
    });
  }
});

/**
 * POST /api/entries/insert
 *
 * Parse DSL input and persist entries to database
 * Input: { dslInput: string, entryDate: string }
 * Output: { success: true, insertedCount: number }
 *      or { success: false, error: string }
 */
app.post('/api/entries/insert', async (req: Request, res: Response) => {
  try {
    const { dslInput, entryDate: entryDateParam } = req.body;

    if (!dslInput || typeof dslInput !== 'string') {
      res.status(400).json({
        success: false,
        error: 'Missing or invalid dslInput',
      });
      return;
    }

    let entryDate: Date;
    try {
      entryDate = parseRequiredDate(entryDateParam, 'entryDate');
    } catch (err) {
      res.status(400).json({ success: false, error: err instanceof Error ? err.message : String(err) });
      return;
    }

    const reqStart = Date.now();
    const phases: Array<{ name: string; count: number; ms: number }> = [];
    const logPhase = (name: string, count: number, ms: number) => phases.push({ name, count, ms });

    // --- Phase: init infrastructure ---
    let t = Date.now();
    const { parsedDefinitions, persistenceConfig, registry } = await initDataEntryInfrastructure();
    logPhase('init_infra', 0, Date.now() - t);

    // --- Phase: parse blocks (must happen before preload so we know if preload is needed) ---
    t = Date.now();
    const blocks = splitIntoBlocks(dslInput);
    if (blocks.length === 0) {
      res.json({ success: true, insertedCount: 0 });
      return;
    }
    logPhase('split_blocks', blocks.length, Date.now() - t);

    // --- Phase: preload DB entries only if the input uses metrics with search keys ---
    // Build set of field base-definition IDs that have search keys
    const searchKeyMetricIds = new Set(
      parsedDefinitions.metricDefinitions
        .filter((md) => md.searchKeyType !== null)
        .map((md) => md.definitionId)
    );
    // A metric in the paste "needs preload" if it has any field whose base definition has a search key
    const metricsNeedingPreload = new Set<string>(
      parsedDefinitions.fields
        .filter((f) => searchKeyMetricIds.has(f.baseDefinitionId))
        .map((f) => f.metricDefinitionId)
    );
    // Extract definition codes present in the paste (first non-comment token of each block header)
    const codesInPaste = new Set<string>(
      blocks.map(({ block }) => {
        const firstLine = block.split('\n').find((l) => l.trim() && !l.trim().startsWith('#'));
        return firstLine ? firstLine.split(/[;: ]/)[0].trim().toUpperCase() : '';
      })
    );
    const needsPreload = parsedDefinitions.definitions.some(
      (d) => codesInPaste.has(d.code) && metricsNeedingPreload.has(d.id)
    );

    t = Date.now();
    const entryStore = new EntryStore();
    entryStore.setParsedDefinitions(parsedDefinitions);
    if (needsPreload) {
      await entryStore.preloadFromDb(
        USER_ID, parsedDefinitions,
        persistenceConfig.definitionIdMap, persistenceConfig.fieldIdMap
      );
      logPhase('preload_db', 0, Date.now() - t);
    } else {
      logPhase('preload_db_skipped', 0, 0);
    }

    const pipelineConfig: PipelineConfig = {
      definitions: parsedDefinitions.definitions,
      metricDefinitions: parsedDefinitions.metricDefinitions,
      attributeDefinitions: parsedDefinitions.attributeDefinitions,
      fields: parsedDefinitions.fields,
      existingEntries: entryStore,
    };

    // Build metric definitions map (logical ID → MetricDefinition) for persistence
    const metricDefsMap = new Map<string, import('../src/domain').MetricDefinition>();
    for (const md of parsedDefinitions.metricDefinitions) {
      metricDefsMap.set(md.definitionId, md);
    }
    const persistConfig = { ...persistenceConfig, metricDefinitions: metricDefsMap };

    // Shared id map across all entries in this request so cross-references resolve correctly.
    const globalIdMap = new Map<number, number>();

    // Set entry date on registry for date header resolution
    registry.setAnchorDate(entryDate);

    // --- Phase: parse + pipeline ALL blocks before any DB write ---
    // Cross-block references (e.g. BOOK in block 1, READ in block 2) are handled by
    // entryStore.addEntry, which runs during pipeline so later blocks can resolve refs.
    // persistResolvedEntriesBatch updates entry.id in-place at each depth level, so any
    // resolvedFromExisting child sharing the same object reference sees the real DB ID
    // when ref links are collected — identical to same-block behaviour.
    const allResolved: import('../src/pipeline/types').ResolvedEntry[] = [];

    t = Date.now();
    for (const { block, startLine } of blocks) {
      const headerOffset = dateHeaderOffset(block);

      const parseResult = registry.parseBlock(block, parsedDefinitions, USER_ID);

      if (!parseResult.success) {
        const errs = parseResult.error.allErrors;
        const firstErr = errs && errs.length > 0 ? errs[0] : parseResult.error;
        res.json({
          success: false,
          error: firstErr.message,
          lineNumber: firstErr.lineNumber
            ? toGlobalLine(firstErr.lineNumber, startLine, headerOffset)
            : startLine,
          details: firstErr.details,
        });
        return;
      }

      const warnings = registry.getWarnings();
      if (warnings.length > 0) {
        console.log(`[API] Parse warnings: ${warnings.join(', ')}`);
      }

      for (const entryInput of parseResult.entries) {
        const pipelineResult = runPipeline(entryInput, pipelineConfig, USER_ID);

        if (!pipelineResult.success) {
          res.json({
            success: false,
            error: pipelineResult.error.message,
            errorType: pipelineResult.error.type,
          });
          return;
        }

        allResolved.push(pipelineResult.value);
        // Add to store so later blocks can cross-reference entries from earlier blocks
        entryStore.addEntry(pipelineResult.value);
      }
    }
    logPhase('parse+pipeline', allResolved.length, Date.now() - t);

    // --- Phase: ONE batch persist for all blocks combined ---
    // Query count: 6 round-trips total regardless of block count (was N_blocks × 6).
    t = Date.now();
    await persistResolvedEntriesBatch(
      allResolved,
      USER_ID,
      persistConfig,
      globalIdMap,
      logPhase
    );
    logPhase('batch_persist_total', allResolved.length, Date.now() - t);

    // --- Phase: persist entry_tags ---
    // After batch persist, every root resolved.entry.id holds the real DB id.
    // Tags only attach to roots; child entries (TIM, attribute children) have none.
    const tagRows: Array<{ entry_id: number; key: string; value: string | null }> = [];
    for (const resolved of allResolved) {
      if (!resolved.tags || resolved.tags.size === 0) continue;
      for (const [key, value] of resolved.tags) {
        tagRows.push({
          entry_id: resolved.entry.id,
          key,
          value: value === '' ? null : value,
        });
      }
    }
    if (tagRows.length > 0) {
      const tTags = Date.now();
      const { error: tagErr } = await supabase.from('entry_tags').insert(tagRows);
      if (tagErr) {
        throw new Error(`[batch-insert] entry_tags failed: ${tagErr.message}`);
      }
      logPhase('entry_tags', tagRows.length, Date.now() - tTags);
    }

    const insertedCount = allResolved.length;

    // Mark the affected month dirty so the next backup run regenerates it.
    // We don't try to detect whether the input contained timings — the cost
    // of regenerating a month with no schema changes is just one DB read,
    // and being conservative keeps the rule simple.
    backupService.markDirtyForDate(entryDate).catch((err) => {
      console.error('[backup] markDirtyForDate failed:', err);
    });

    const totalMs = Date.now() - reqStart;
    console.log(
      `[API] Insert ${insertedCount} entries in ${totalMs}ms | queries: ${phases.filter(p => p.name.startsWith('entries') || p.name.startsWith('metric') || p.name.startsWith('attribute') || p.name === 'ref_links').length} | phases:\n` +
      phases.map(p => `  ${p.name}: ${p.count} rows, ${p.ms}ms`).join('\n')
    );

    res.json({
      success: true,
      insertedCount,
    });
  } catch (err) {
    console.error('[API] Insert entries error:', err);
    res.status(500).json({
      success: false,
      error: err instanceof Error ? err.message : 'Internal server error',
    });
  }
});

/**
 * DELETE /api/entries/:id
 *
 * Delete an entry by id. Walks up to the top-level ancestor (root) and deletes
 * that — schema's ON DELETE CASCADE on parent_entry_id removes all descendants.
 *
 * This is the right semantics for both surfaces:
 *   - Calendar sends a TIM id (sub-entry of EST): we walk up and delete the
 *     EST block as a whole, matching the "one block per timing" mental model.
 *   - LastEntriesTable sends a top-level id (BOOK/EAT/...): root == itself,
 *     we delete it directly.
 *
 * If the resulting subtree contained a TIM, mark the affected month dirty so
 * the next backup run regenerates that month's TXT.
 */
app.delete('/api/entries/:id', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) {
      res.status(400).json({ success: false, error: 'Invalid entry id' });
      return;
    }

    // Walk up to root.
    type EntryRow = { id: number; definition_id: string; parent_entry_id: number | null; timestamp: string };
    let currentId: number = id;
    let root: EntryRow | undefined;
    for (let hops = 0; hops < 16; hops++) {
      const { data, error } = await supabase
        .from('entries')
        .select('id, definition_id, parent_entry_id, timestamp')
        .eq('id', currentId)
        .eq('user_id', USER_ID)
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (!data) {
        res.status(404).json({ success: false, error: 'Entry not found' });
        return;
      }
      root = data as unknown as EntryRow;
      if (root.parent_entry_id === null) break;
      currentId = root.parent_entry_id;
    }
    if (!root) {
      res.status(404).json({ success: false, error: 'Entry not found' });
      return;
    }

    // Resolve TIM definition id (per-user) so we can decide whether to mark dirty.
    const { data: timDefRows } = await supabase
      .from('definitions')
      .select('id')
      .eq('user_id', USER_ID)
      .eq('code', 'TIM')
      .eq('type', 'metric');
    const timDefId = (timDefRows && timDefRows.length > 0) ? (timDefRows[0] as { id: string }).id : null;

    // Is the deleted subtree timing-bearing? Either root itself is TIM, or root has a TIM child.
    let isTimingBlock = false;
    if (timDefId !== null) {
      if (root.definition_id === timDefId) {
        isTimingBlock = true;
      } else {
        const { data: timChildren } = await supabase
          .from('entries')
          .select('id')
          .eq('parent_entry_id', root.id)
          .eq('definition_id', timDefId)
          .limit(1);
        if (timChildren && timChildren.length > 0) isTimingBlock = true;
      }
    }

    // Delete the root — children cascade.
    const { error: delErr } = await supabase
      .from('entries')
      .delete()
      .eq('id', root.id)
      .eq('user_id', USER_ID);
    if (delErr) throw new Error(delErr.message);

    if (isTimingBlock) {
      backupService.markDirtyForDate(new Date(root.timestamp)).catch((err) => {
        console.error('[backup] markDirtyForDate after delete failed:', err);
      });
    }

    res.json({ success: true, deletedRootId: root.id, markedDirty: isTimingBlock });
  } catch (err) {
    console.error('[API] Delete entry error:', err);
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : 'Internal server error' });
  }
});

// ============================================
// Backup Endpoints
// ============================================

/**
 * POST /api/backup/run
 *
 * Manually trigger a backup. Regenerates every dirty month immediately and
 * clears the dirty list on success. Concurrent calls are coalesced.
 *
 * Optional body { month: "YYYY-MM" } regenerates a single explicit month
 * (without requiring it to be in the dirty list).
 */
app.post('/api/backup/run', async (req: Request, res: Response) => {
  try {
    const explicitMonth = typeof req.body?.month === 'string' ? req.body.month.trim() : '';
    if (explicitMonth) {
      if (!/^\d{4}-\d{2}$/.test(explicitMonth)) {
        res.status(400).json({ success: false, error: 'month must be YYYY-MM' });
        return;
      }
      const wrote = await backupService.regenerateMonth(explicitMonth);
      res.json({ success: true, regenerated: wrote ? [explicitMonth] : [], skipped: wrote ? [] : [explicitMonth], errors: [] });
      return;
    }
    const result = await backupService.regenerateDirtyMonths();
    res.json({ success: result.errors.length === 0, ...result });
  } catch (err) {
    console.error('[API] Backup run error:', err);
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : 'Internal server error' });
  }
});

/**
 * GET /api/backup/status
 *
 * Returns dirty months + lastBackupDate + backup directory path. Used by the
 * UI to label the manual button (e.g. "Backup now (2 dirty)").
 */
app.get('/api/backup/status', async (_req: Request, res: Response) => {
  try {
    const status = await backupService.getStatus();
    res.json({ success: true, ...status });
  } catch (err) {
    console.error('[API] Backup status error:', err);
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : 'Internal server error' });
  }
});

/**
 * GET /api/timings
 *
 * Get existing TIM entries for a date range.
 * Query params (required):
 *   startDate  YYYY-MM-DD  (inclusive)
 *   endDate    YYYY-MM-DD  (inclusive)
 *
 * Response shape:
 *   { success: true, timings: TimingEntry[] }
 *   Each TimingEntry includes legacy flat fields plus the timeLabels map.
 */
app.get('/api/timings', async (req: Request, res: Response) => {
  try {
    let startDate: Date;
    let endDate: Date;
    try {
      ({ startDate, endDate } = parseDateRange(
        req.query.startDate as string | undefined,
        req.query.endDate   as string | undefined,
      ));
    } catch (err) {
      res.status(400).json({ success: false, error: err instanceof Error ? err.message : String(err) });
      return;
    }

    const tTimings = Date.now();
    const entries = await loadEntriesInRange('TIM', USER_ID, startDate, endDate);
    console.log(`[timings] loadEntriesInRange: ${Date.now() - tTimings}ms → ${entries.length} entries`);

    // Walk up to each TIM's parent metric (EST/WORK/etc.) so the calendar can
    // color blocks by the parent's category and label them by the parent's code.
    // Two batched queries: parents + their definitions.
    const parentIds = [...new Set(entries.map(e => e.parentEntryId).filter((x): x is number => x != null))];
    const parentByTimId = new Map<number, { code: string; category: string | null }>();
    if (parentIds.length > 0) {
      const { data: parentRows } = await supabase
        .from('entries')
        .select('id, definition_id')
        .in('id', parentIds);
      const parentDefById = new Map(
        (parentRows as { id: number; definition_id: string }[] | null ?? []).map(r => [r.id, r.definition_id])
      );
      const parentDefIds = [...new Set(parentDefById.values())];
      const { data: defRows } = parentDefIds.length > 0
        ? await supabase.from('definitions').select('id, code, category').in('id', parentDefIds)
        : { data: [] };
      const defById = new Map(
        (defRows as { id: string; code: string; category: string | null }[] | null ?? [])
          .map(d => [d.id, { code: d.code, category: d.category }])
      );
      for (const e of entries) {
        if (e.parentEntryId == null) continue;
        const defId = parentDefById.get(e.parentEntryId);
        if (!defId) continue;
        const def = defById.get(defId);
        if (def) parentByTimId.set(e.id, def);
      }
    }

    // Transform to timing format for frontend
    const timings = entries.map((entry) => {
      const timeInit = entry.attributes.get('time_init') as number | null;
      const timeEnd = entry.attributes.get('time_end') as number | null;
      const duration = entry.attributes.get('duration') as number | null;

      // Legacy flat fields — kept for backward compatibility with CalendarView
      let netProductivity: number | null = null;
      let tValue: number | null = null;
      let mValue: number | null = null;
      let pValue: number | null = null;
      let nValue: number | null = null;

      // New: full label map for the Time Patterns engine
      const timeLabels: Record<string, number> = {};

      if (entry.timeValues) {
        let t = 0, m = 0, p = 0, n = 0;

        for (const [sub, value] of entry.timeValues) {
          // Populate timeLabels with the full subdivision key (e.g. "m/thk")
          timeLabels[sub] = value;

          const baseSub = sub.split('/')[0];
          if (baseSub === 't') t += value;
          else if (baseSub === 'm') m += value;
          else if (baseSub === 'p') p += value;
          else if (baseSub === 'n') n += value;
        }

        tValue = t;
        mValue = m;
        pValue = p;
        nValue = n;
        const productive = t + m + p;
        if (productive > 0) netProductivity = t / productive;
      }

      const parent = parentByTimId.get(entry.id);
      return {
        id: entry.id,
        definitionCode: entry.definitionCode,
        timeInit,
        timeEnd,
        duration,
        tValue,
        mValue,
        pValue,
        nValue,
        netProductivity,
        subdivision: entry.subdivision,
        timestamp: entry.timestamp.toISOString(),
        // additive field — not present in old consumers, safe to add
        timeLabels,
        // Parent metric of the TIM entry (e.g. EST, WORK) and its category.
        // Used by the calendar to label blocks by the parent and color by category.
        parentDefinitionCode: parent?.code ?? null,
        parentCategory: parent?.category ?? null,
      };
    });

    res.json({ success: true, timings });
  } catch (err) {
    console.error('[API] Get timings error:', err);
    res.status(500).json({
      success: false,
      error: err instanceof Error ? err.message : 'Internal server error',
    });
  }
});

// ============================================
// Schema Definitions Editor Endpoints
// ============================================

/**
 * System (locked) attribute names on the TIM definition. These are the timing
 * primitives — users can read them and reference them in formulas, but cannot
 * rename, retype, or delete them. Other TIM attributes (productivity formulas)
 * are user-editable.
 */
const TIM_SYSTEM_ATTRS = new Set(['time_init', 'time_end', 'duration', 'time_type']);

function isLockedTimAttr(definitionCode: string, attrName: string): boolean {
  return definitionCode === 'TIM' && TIM_SYSTEM_ATTRS.has(attrName);
}

/**
 * GET /api/schema/definitions
 *
 * Returns all metric definitions for the user with their fields.
 * Requires the schema_definitions_editor.sql migration to have been run.
 * TIM is included but marked isSystem = true (read-only).
 */
app.get('/api/schema/definitions', async (_req: Request, res: Response) => {
  try {
    const { data: defs, error: defsError } = await supabase
      .from('definitions')
      .select('id, code, display_name, description, category')
      .eq('user_id', USER_ID)
      .eq('type', 'metric')
      .order('created_at');
    if (defsError) throw new Error(defsError.message);
    if (!defs || defs.length === 0) {
      res.json({ success: true, definitions: [] });
      return;
    }

    const defIds = (defs as { id: string }[]).map((d) => d.id);

    const [metricDefsResult, fieldsResult] = await Promise.all([
      supabase
        .from('metric_definitions')
        .select('definition_id, primary_identifier_field_id')
        .in('definition_id', defIds),
      supabase
        .from('fields')
        .select('id, metric_definition_id, name, display_name, description, base_definition_id, min_instances, input_mode, formula')
        .in('metric_definition_id', defIds)
        .order('created_at'),
    ]);

    const fields = (fieldsResult.data || []) as {
      id: string; metric_definition_id: string; name: string;
      display_name: string; description: string; base_definition_id: string;
      min_instances: number; input_mode: string; formula: string | null;
    }[];
    const metricDefs = (metricDefsResult.data || []) as {
      definition_id: string; primary_identifier_field_id: string | null;
    }[];

    const baseDefIds = [...new Set(fields.map((f) => f.base_definition_id))];

    let attrDefs: { definition_id: string; datatype: string }[] = [];
    let refMetrics: { id: string; code: string }[] = [];

    if (baseDefIds.length > 0) {
      const [attrResult, refResult] = await Promise.all([
        supabase.from('attribute_definitions').select('definition_id, datatype').in('definition_id', baseDefIds),
        supabase.from('definitions').select('id, code').in('id', baseDefIds).eq('type', 'metric'),
      ]);
      attrDefs = (attrResult.data || []) as typeof attrDefs;
      refMetrics = (refResult.data || []) as typeof refMetrics;
    }

    const attrDefMap = new Map(attrDefs.map((a) => [a.definition_id, a.datatype]));
    const refMetricMap = new Map(refMetrics.map((m) => [m.id, m.code]));
    const metricDefMap = new Map(metricDefs.map((m) => [m.definition_id, m]));
    const fieldsByDefId = new Map<string, typeof fields>();
    for (const f of fields) {
      const list = fieldsByDefId.get(f.metric_definition_id) || [];
      list.push(f);
      fieldsByDefId.set(f.metric_definition_id, list);
    }

    const definitions = (defs as { id: string; code: string; display_name: string; description: string; category: string | null }[]).map((def) => {
      const md = metricDefMap.get(def.id);
      const defFields = fieldsByDefId.get(def.id) || [];
      const attributes = defFields.map((f) => {
        const type = attrDefMap.has(f.base_definition_id)
          ? attrDefMap.get(f.base_definition_id)!
          : (refMetricMap.get(f.base_definition_id) || 'unknown');
        return {
          id: f.id,
          internalName: f.name,
          displayName: f.display_name || f.name,
          description: f.description || '',
          type,
          optional: f.min_instances === 0,
          isKey: md?.primary_identifier_field_id === f.id,
          mode: f.input_mode as 'input' | 'formula',
          formula: f.formula || '',
          // Locked timing primitives on TIM. Other TIM attributes (formulas)
          // are user-editable.
          isSystemAttr: isLockedTimAttr(def.code, f.name),
        };
      });
      return {
        code: def.code,
        name: def.display_name || def.code,
        description: def.description || '',
        category: def.category,
        // isSystem locks definition-level meta (name/desc/category) on TIM.
        // Attribute-level edits are governed per-attribute via isSystemAttr.
        isSystem: def.code === 'TIM',
        attributes,
      };
    });

    res.json({ success: true, definitions });
  } catch (err) {
    console.error('[Schema] GET definitions error:', err);
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : 'Internal server error' });
  }
});

/**
 * POST /api/schema/definitions
 *
 * Create a new metric definition.
 * Body: { name, code, description, attributes: AttributeInput[] }
 */
app.post('/api/schema/definitions', async (req: Request, res: Response) => {
  try {
    const { name, code, description, category, attributes = [] } = req.body as {
      name: string; code: string; description: string; category?: string | null;
      attributes: { internalName: string; displayName: string; description: string; type: string; optional: boolean; isKey: boolean; mode: string; formula: string }[];
    };

    if (!code || !/^[A-Z]{3,4}$/.test(code)) {
      res.status(400).json({ success: false, error: 'Code must be 3–4 uppercase letters' });
      return;
    }
    if (!name || !name.trim()) {
      res.status(400).json({ success: false, error: 'Name is required' });
      return;
    }

    // Check uniqueness
    const { data: existing } = await supabase
      .from('definitions').select('id').eq('user_id', USER_ID).eq('code', code).single();
    if (existing) {
      res.status(400).json({ success: false, error: `Code "${code}" already exists` });
      return;
    }

    // Validate internalName uniqueness within definition
    const internalNames = attributes.map((a) => a.internalName);
    if (new Set(internalNames).size !== internalNames.length) {
      res.status(400).json({ success: false, error: 'Duplicate attribute internal names' });
      return;
    }

    // Validate at most one key
    const keyCount = attributes.filter((a) => a.isKey).length;
    if (keyCount > 1) {
      res.status(400).json({ success: false, error: 'Only one key attribute is allowed' });
      return;
    }

    // Insert metric definition
    const trimmedCategory = typeof category === 'string' ? category.trim() : '';
    const { data: defRow, error: defError } = await supabase
      .from('definitions')
      .insert({
        user_id: USER_ID,
        type: 'metric',
        code,
        display_name: name.trim(),
        description: description || '',
        category: trimmedCategory || null,
      })
      .select().single();
    if (defError) throw new Error(defError.message);
    const def = defRow as { id: string };

    // Insert metric_definitions record
    const { error: mdError } = await supabase
      .from('metric_definitions')
      .insert({ definition_id: def.id, primary_identifier_field_id: null });
    if (mdError) throw new Error(mdError.message);

    let keyFieldId: string | null = null;

    for (const attr of attributes) {
      const baseDefId = await resolveBaseDefinitionId(attr.type, code, attr.internalName, USER_ID);
      const { data: fieldRow, error: fieldError } = await supabase
        .from('fields')
        .insert({
          user_id: USER_ID,
          metric_definition_id: def.id,
          name: attr.internalName,
          display_name: attr.displayName || attr.internalName,
          description: attr.description || '',
          base_definition_id: baseDefId,
          min_instances: attr.optional ? 0 : 1,
          max_instances: 1,
          input_mode: attr.mode,
          formula: attr.mode === 'formula' ? (attr.formula || null) : null,
        })
        .select().single();
      if (fieldError) throw new Error(fieldError.message);
      if (attr.isKey) keyFieldId = (fieldRow as { id: string }).id;
    }

    if (keyFieldId) {
      await supabase
        .from('metric_definitions')
        .update({ primary_identifier_field_id: keyFieldId })
        .eq('definition_id', def.id);
    }

    await generateAndWriteDefinitionsFile();
    res.json({ success: true, code });
  } catch (err) {
    console.error('[Schema] POST definition error:', err);
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : 'Internal server error' });
  }
});

/**
 * PATCH /api/schema/definitions/:code
 *
 * Update a definition's name and/or description.
 * Body: { name?, description? }
 */
app.patch('/api/schema/definitions/:code', async (req: Request, res: Response) => {
  try {
    const { code } = req.params;
    if (code === 'TIM') {
      res.status(403).json({ success: false, error: 'Cannot edit TIM definition' });
      return;
    }

    const { name, description, category } = req.body as { name?: string; description?: string; category?: string | null };
    const updates: Record<string, string | null> = {};
    if (name !== undefined) updates.display_name = name.trim();
    if (description !== undefined) updates.description = description;
    if (category !== undefined) {
      const trimmed = typeof category === 'string' ? category.trim() : '';
      updates.category = trimmed || null;
    }

    if (Object.keys(updates).length === 0) {
      res.status(400).json({ success: false, error: 'No updates provided' });
      return;
    }

    const { error } = await supabase
      .from('definitions')
      .update(updates)
      .eq('user_id', USER_ID).eq('code', code).eq('type', 'metric');
    if (error) throw new Error(error.message);

    await generateAndWriteDefinitionsFile();
    res.json({ success: true });
  } catch (err) {
    console.error('[Schema] PATCH definition error:', err);
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : 'Internal server error' });
  }
});

/**
 * POST /api/schema/definitions/:code/attributes
 *
 * Add an attribute to an existing definition.
 * Body: { internalName, displayName, description, type, optional, isKey, mode, formula, backfill? }
 * backfill: { type: 'none' | 'fixed_value', value?: string }
 */
app.post('/api/schema/definitions/:code/attributes', async (req: Request, res: Response) => {
  try {
    const { code } = req.params;

    const { internalName, displayName, description: attrDesc, type, optional, isKey, mode, formula, backfill } = req.body as {
      internalName: string; displayName: string; description: string; type: string;
      optional: boolean; isKey: boolean; mode: string; formula: string;
      backfill?: { type: 'none' | 'fixed_value'; value?: string };
    };

    if (!internalName) {
      res.status(400).json({ success: false, error: 'internalName is required' });
      return;
    }

    // TIM allows user-editable attributes (typically formulas), but the timing
    // primitives are reserved system names — refuse those.
    if (isLockedTimAttr(code, internalName)) {
      res.status(403).json({
        success: false,
        error: `"${internalName}" is a reserved TIM attribute and cannot be added`,
      });
      return;
    }

    // Find the metric definition
    const { data: def } = await supabase
      .from('definitions').select('id').eq('user_id', USER_ID).eq('code', code).eq('type', 'metric').single();
    if (!def) {
      res.status(404).json({ success: false, error: 'Definition not found' });
      return;
    }
    const defId = (def as { id: string }).id;

    // Check uniqueness of internalName within this definition
    const { data: existingField } = await supabase
      .from('fields').select('id').eq('metric_definition_id', defId).eq('name', internalName).single();
    if (existingField) {
      res.status(400).json({ success: false, error: `Attribute "${internalName}" already exists` });
      return;
    }

    const baseDefId = await resolveBaseDefinitionId(type, code, internalName, USER_ID);

    const { data: fieldRow, error: fieldError } = await supabase
      .from('fields')
      .insert({
        user_id: USER_ID,
        metric_definition_id: defId,
        name: internalName,
        display_name: displayName || internalName,
        description: attrDesc || '',
        base_definition_id: baseDefId,
        min_instances: optional ? 0 : 1,
        max_instances: 1,
        input_mode: mode,
        formula: mode === 'formula' ? (formula || null) : null,
      })
      .select().single();
    if (fieldError) throw new Error(fieldError.message);
    const fieldId = (fieldRow as { id: string }).id;

    // Backfill existing entries if requested
    if (backfill?.type === 'fixed_value' && backfill.value !== undefined && mode !== 'formula') {
      const { data: parentEntries } = await supabase
        .from('entries')
        .select('id, definition_id, timestamp')
        .eq('user_id', USER_ID)
        .eq('definition_id', defId)
        .is('parent_entry_id', null);

      if (parentEntries && parentEntries.length > 0) {
        for (const parentEntry of parentEntries as { id: number; definition_id: string; timestamp: string }[]) {
          const { data: childEntry, error: childError } = await supabase
            .from('entries')
            .insert({
              user_id: USER_ID,
              definition_id: parentEntry.definition_id,
              parent_entry_id: parentEntry.id,
              timestamp: parentEntry.timestamp,
              subdivision: null,
              comments: null,
              search_key_value: null,
            })
            .select().single();
          if (childError) continue;
          const childId = (childEntry as { id: number }).id;

          const attrValue: Record<string, unknown> = { entry_id: childId, field_id: fieldId };
          if (type === 'int') attrValue.value_int = parseInt(String(backfill.value), 10);
          else if (type === 'float') attrValue.value_float = parseFloat(String(backfill.value));
          else attrValue.value_string = String(backfill.value);

          await supabase.from('attribute_entries').insert(attrValue);
        }
      }
    }

    // Update primary_identifier_field_id if isKey
    if (isKey) {
      await supabase
        .from('metric_definitions')
        .update({ primary_identifier_field_id: fieldId })
        .eq('definition_id', defId);
    }

    await generateAndWriteDefinitionsFile();
    res.json({ success: true });
  } catch (err) {
    console.error('[Schema] POST attribute error:', err);
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : 'Internal server error' });
  }
});

/**
 * PATCH /api/schema/definitions/:code/attributes/:name
 *
 * Update an attribute's editable fields: displayName, description, optional, formula.
 * Type and mode cannot be changed after creation.
 */
app.patch('/api/schema/definitions/:code/attributes/:name', async (req: Request, res: Response) => {
  try {
    const { code, name } = req.params;
    if (isLockedTimAttr(code, name)) {
      res.status(403).json({
        success: false,
        error: `"${name}" is a reserved TIM attribute and cannot be modified`,
      });
      return;
    }

    const { displayName, description, optional, formula } = req.body as {
      displayName?: string; description?: string; optional?: boolean; formula?: string;
    };

    const { data: def } = await supabase
      .from('definitions').select('id').eq('user_id', USER_ID).eq('code', code).eq('type', 'metric').single();
    if (!def) {
      res.status(404).json({ success: false, error: 'Definition not found' });
      return;
    }

    const updates: Record<string, unknown> = {};
    if (displayName !== undefined) updates.display_name = displayName;
    if (description !== undefined) updates.description = description;
    if (optional !== undefined) updates.min_instances = optional ? 0 : 1;
    if (formula !== undefined) updates.formula = formula || null;

    if (Object.keys(updates).length === 0) {
      res.status(400).json({ success: false, error: 'No updates provided' });
      return;
    }

    const { error } = await supabase
      .from('fields')
      .update(updates)
      .eq('metric_definition_id', (def as { id: string }).id)
      .eq('name', name);
    if (error) throw new Error(error.message);

    await generateAndWriteDefinitionsFile();
    res.json({ success: true });
  } catch (err) {
    console.error('[Schema] PATCH attribute error:', err);
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : 'Internal server error' });
  }
});

/**
 * DELETE /api/schema/definitions/:code/attributes/:name
 *
 * Delete an attribute and remove its values from all existing entries.
 */
app.delete('/api/schema/definitions/:code/attributes/:name', async (req: Request, res: Response) => {
  try {
    const { code, name } = req.params;
    if (isLockedTimAttr(code, name)) {
      res.status(403).json({
        success: false,
        error: `"${name}" is a reserved TIM attribute and cannot be deleted`,
      });
      return;
    }

    const { data: def } = await supabase
      .from('definitions').select('id').eq('user_id', USER_ID).eq('code', code).eq('type', 'metric').single();
    if (!def) {
      res.status(404).json({ success: false, error: 'Definition not found' });
      return;
    }
    const defId = (def as { id: string }).id;

    const { data: field } = await supabase
      .from('fields').select('id').eq('metric_definition_id', defId).eq('name', name).single();
    if (!field) {
      res.status(404).json({ success: false, error: 'Attribute not found' });
      return;
    }
    const fieldId = (field as { id: string }).id;

    // Find all child entries that hold values for this field
    const { data: attrEntries } = await supabase
      .from('attribute_entries').select('entry_id').eq('field_id', fieldId);

    if (attrEntries && attrEntries.length > 0) {
      const childEntryIds = (attrEntries as { entry_id: number }[]).map((r) => r.entry_id);
      // Delete child entries (cascades to attribute_entries)
      await supabase.from('entries').delete().in('id', childEntryIds);
    }

    // If this was the primary identifier field, clear that reference
    await supabase
      .from('metric_definitions')
      .update({ primary_identifier_field_id: null })
      .eq('definition_id', defId)
      .eq('primary_identifier_field_id', fieldId);

    // Delete the field
    const { error: deleteError } = await supabase
      .from('fields').delete().eq('id', fieldId);
    if (deleteError) throw new Error(deleteError.message);

    await generateAndWriteDefinitionsFile();
    res.json({ success: true });
  } catch (err) {
    console.error('[Schema] DELETE attribute error:', err);
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : 'Internal server error' });
  }
});

/**
 * Helper: resolve or create the base_definition_id for a field type.
 * For primitive types (int, float, string): creates attribute + attribute_definitions records.
 * For metric codes: looks up the existing metric definition.
 */
async function resolveBaseDefinitionId(
  type: string, metricCode: string, fieldName: string, userId: string
): Promise<string> {
  if (['int', 'float', 'string'].includes(type)) {
    const scopedCode = `${metricCode.toLowerCase()}.${fieldName}`;
    const { data: existing } = await supabase
      .from('definitions').select('id').eq('user_id', userId).eq('code', scopedCode).single();
    if (existing) return (existing as { id: string }).id;

    const { data: attrDef, error } = await supabase
      .from('definitions')
      .insert({ user_id: userId, type: 'attribute', code: scopedCode, display_name: fieldName, description: '' })
      .select().single();
    if (error) throw new Error(error.message);
    const attrDefId = (attrDef as { id: string }).id;
    await supabase.from('attribute_definitions').insert({ definition_id: attrDefId, datatype: type });
    return attrDefId;
  }

  // Metric reference
  const { data: refDef } = await supabase
    .from('definitions').select('id').eq('user_id', userId).eq('code', type).eq('type', 'metric').single();
  if (!refDef) throw new Error(`Referenced metric "${type}" not found`);
  return (refDef as { id: string }).id;
}

// ─────────────────────────────────────────────────────────────────────────────
// User settings (time tags + category colors)
// ─────────────────────────────────────────────────────────────────────────────

interface TimeTagSetting {
  letter: string;        // single a-z
  name: string;
  description: string;
  color: string;         // hex
  position: number;      // display order
}

const DEFAULT_TIME_TAGS: TimeTagSetting[] = [
  { letter: 't', name: 'Productive',   description: '', color: '#b8e6c8', position: 0 },
  { letter: 'm', name: 'Unproductive', description: '', color: '#fde68a', position: 1 },
  { letter: 'p', name: 'Lost',         description: '', color: '#f8c4c4', position: 2 },
  { letter: 'n', name: 'Neutral',      description: '', color: '#e8e8e8', position: 3 },
];

function isValidTimeTag(t: unknown): t is TimeTagSetting {
  if (!t || typeof t !== 'object') return false;
  const o = t as Record<string, unknown>;
  return (
    typeof o.letter === 'string' && /^[a-z]$/.test(o.letter) &&
    typeof o.name === 'string' &&
    typeof o.description === 'string' &&
    typeof o.color === 'string' &&
    typeof o.position === 'number'
  );
}

app.get('/api/settings', async (_req: Request, res: Response) => {
  try {
    const { data, error } = await supabase
      .from('user_settings')
      .select('time_tags, category_colors')
      .eq('user_id', USER_ID)
      .maybeSingle();

    if (error) throw new Error(error.message);

    // Seed defaults on first read so the UI is usable immediately.
    if (!data) {
      const seed = { time_tags: DEFAULT_TIME_TAGS, category_colors: {} };
      const { error: insertErr } = await supabase
        .from('user_settings')
        .insert({ user_id: USER_ID, ...seed });
      if (insertErr) throw new Error(insertErr.message);
      res.json({ success: true, settings: seed });
      return;
    }

    const timeTags = (data.time_tags as TimeTagSetting[] | null) ?? [];
    res.json({
      success: true,
      settings: {
        time_tags: timeTags.length > 0 ? timeTags : DEFAULT_TIME_TAGS,
        category_colors: data.category_colors ?? {},
      },
    });
  } catch (err) {
    console.error('[API] GET /api/settings error:', err);
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
  }
});

app.put('/api/settings', async (req: Request, res: Response) => {
  try {
    const { time_tags, category_colors } = req.body ?? {};

    if (time_tags !== undefined) {
      if (!Array.isArray(time_tags)) {
        res.status(400).json({ success: false, error: 'time_tags must be an array' });
        return;
      }
      if (time_tags.length < 1 || time_tags.length > 6) {
        res.status(400).json({ success: false, error: 'time_tags must have 1–6 entries' });
        return;
      }
      const seen = new Set<string>();
      for (const t of time_tags) {
        if (!isValidTimeTag(t)) {
          res.status(400).json({ success: false, error: 'invalid time tag entry' });
          return;
        }
        if (seen.has(t.letter)) {
          res.status(400).json({ success: false, error: `duplicate letter "${t.letter}"` });
          return;
        }
        seen.add(t.letter);
      }
    }

    if (category_colors !== undefined) {
      if (typeof category_colors !== 'object' || Array.isArray(category_colors)) {
        res.status(400).json({ success: false, error: 'category_colors must be an object' });
        return;
      }
      for (const [k, v] of Object.entries(category_colors)) {
        if (typeof v !== 'string') {
          res.status(400).json({ success: false, error: `category_colors[${k}] must be a string` });
          return;
        }
      }
    }

    const updateRow: Record<string, unknown> = {
      user_id: USER_ID,
      updated_at: new Date().toISOString(),
    };
    if (time_tags !== undefined) updateRow.time_tags = time_tags;
    if (category_colors !== undefined) updateRow.category_colors = category_colors;

    const { error } = await supabase
      .from('user_settings')
      .upsert(updateRow, { onConflict: 'user_id' });

    if (error) throw new Error(error.message);
    res.json({ success: true });
  } catch (err) {
    console.error('[API] PUT /api/settings error:', err);
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`Widget API server running on http://localhost:${PORT}`);
  console.log(`Using userId: ${USER_ID}`);
  console.log('\nEndpoints:');
  console.log(`  POST /api/v2/run-widget        - Run a v2 widget from DSL`);
  console.log(`  GET  /api/widgets              - List stored widgets`);
  console.log(`  GET  /api/dashboards           - List dashboards`);
  console.log(`  POST /api/dashboards           - Create dashboard`);
  console.log(`  PATCH /api/dashboards/:id      - Rename dashboard`);
  console.log(`  DELETE /api/dashboards/:id     - Delete dashboard (cascades to widgets)`);
  console.log(`  GET  /api/dashboards/:id/widgets - Get dashboard widgets`);
  console.log(`  POST /api/widgets              - Create widget`);
  console.log(`  PATCH /api/widgets/:id         - Update widget`);
  console.log(`  DELETE /api/widgets/:id        - Delete widget`);
  console.log(`  POST /api/entries/parse-preview - Parse DSL for preview`);
  console.log(`  POST /api/entries/insert       - Parse and insert entries`);
  console.log(`  DELETE /api/entries/:id        - Delete an entry (and its subtree)`);
  console.log(`  GET  /api/timings              - Get timings for a date`);
  console.log(`  POST /api/backup/run           - Regenerate dirty monthly TXT backups`);
  console.log(`  GET  /api/backup/status        - Backup state (dirty months, last run)`);
  console.log(`  GET  /api/health               - Health check`);
  console.log(`  GET  /api/settings             - Get user settings (time tags + category colors)`);
  console.log(`  PUT  /api/settings             - Update user settings`);

  // Fire-and-forget daily auto-backup. Runs at most once per local day; if a
  // backup has already run today this resolves to null without doing work.
  backupService.runDailyAutoBackup().then((result) => {
    if (result === null) {
      console.log('[backup] auto-backup: skipped (already ran today)');
    } else if (result.regenerated.length === 0 && result.skipped.length === 0 && result.errors.length === 0) {
      console.log('[backup] auto-backup: nothing dirty');
    } else {
      console.log(
        `[backup] auto-backup: regenerated=[${result.regenerated.join(',')}] ` +
        `skipped=[${result.skipped.join(',')}] errors=${result.errors.length}`
      );
      for (const e of result.errors) console.error(`  ${e.month}: ${e.message}`);
    }
  }).catch((err) => {
    console.error('[backup] auto-backup failed:', err);
  });
});
