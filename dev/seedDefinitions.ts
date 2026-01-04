/**
 * seedDefinitions.ts
 *
 * Seeds Supabase with definitions and fields from definitions.txt.
 * Generates real UUIDs for each definition and field.
 *
 * Run with: SUPABASE_URL=... SUPABASE_ANON_KEY=... npx tsx dev/seedDefinitions.ts
 *
 * Options:
 *   --dry-run    Print what would be inserted without actually inserting
 *   --clean      Delete existing definitions/fields for user before seeding
 */

import * as path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import { parseDefinitions } from './parseDefinitions';
import { supabase } from '../src/persistence/supabaseClient';
import { DEV_CONFIG } from './config';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuration
const DEFINITIONS_FILE = path.join(__dirname, 'definitions.txt');
const USER_ID = process.env.SEED_USER_ID || DEV_CONFIG.USER_ID;

// Parse command line arguments
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const CLEAN = args.includes('--clean');

// -----------------------------------------------------------------------------
// ID Mapping
// -----------------------------------------------------------------------------

type IdMap = Map<string, string>;

/**
 * Generates UUID mappings for all logical IDs.
 */
function generateIdMaps(parsed: ReturnType<typeof parseDefinitions>): {
  definitionIdMap: IdMap;
  fieldIdMap: IdMap;
} {
  const definitionIdMap: IdMap = new Map();
  const fieldIdMap: IdMap = new Map();

  // Generate UUIDs for all definitions
  for (const def of parsed.definitions) {
    definitionIdMap.set(def.id, randomUUID());
  }

  // Generate UUIDs for all fields
  for (const field of parsed.fields) {
    fieldIdMap.set(field.id, randomUUID());
  }

  return { definitionIdMap, fieldIdMap };
}

// -----------------------------------------------------------------------------
// Database Row Types
// -----------------------------------------------------------------------------

interface DefinitionRow {
  id: string;
  user_id: string;
  type: string;
  code: string;
  display_name: string;
  category: string | null;
  parent_definition_id: string | null;
}

interface AttributeDefinitionRow {
  definition_id: string;
  datatype: string;
}

interface MetricDefinitionRow {
  definition_id: string;
  primary_identifier_field_id: string | null;
}

interface FieldRow {
  id: string;
  user_id: string;
  metric_definition_id: string;
  name: string;
  base_definition_id: string;
  min_instances: number;
  max_instances: number | null;
  input_mode: string;
  formula: string | null;
}

// -----------------------------------------------------------------------------
// Seed Functions
// -----------------------------------------------------------------------------

async function cleanExistingData(): Promise<void> {
  console.log(`\nCleaning existing data for user ${USER_ID}...`);

  // Delete in reverse dependency order
  // First get all entry IDs for this user
  const { data: userEntries } = await supabase
    .from('entries')
    .select('id')
    .eq('user_id', USER_ID);
  const entryIds = userEntries?.map(e => e.id) || [];

  if (entryIds.length > 0) {
    // Delete attribute_entries (references entries)
    const { error: attrEntriesError } = await supabase
      .from('attribute_entries')
      .delete()
      .in('entry_id', entryIds);
    if (attrEntriesError) throw new Error(`Failed to delete attribute_entries: ${attrEntriesError.message}`);
    console.log('  Deleted attribute_entries');

    // Delete metric_entries (references entries)
    const { error: metricEntriesError } = await supabase
      .from('metric_entries')
      .delete()
      .in('entry_id', entryIds);
    if (metricEntriesError) throw new Error(`Failed to delete metric_entries: ${metricEntriesError.message}`);
    console.log('  Deleted metric_entries');

    // Delete entries (references definitions)
    const { error: entriesError } = await supabase
      .from('entries')
      .delete()
      .eq('user_id', USER_ID);
    if (entriesError) throw new Error(`Failed to delete entries: ${entriesError.message}`);
    console.log('  Deleted entries');
  }

  const { error: fieldsError } = await supabase
    .from('fields')
    .delete()
    .eq('user_id', USER_ID);
  if (fieldsError) throw new Error(`Failed to delete fields: ${fieldsError.message}`);
  console.log('  Deleted fields');

  const { error: metricDefsError } = await supabase
    .from('metric_definitions')
    .delete()
    .in('definition_id',
      (await supabase.from('definitions').select('id').eq('user_id', USER_ID)).data?.map(d => d.id) || []
    );
  if (metricDefsError) throw new Error(`Failed to delete metric_definitions: ${metricDefsError.message}`);
  console.log('  Deleted metric_definitions');

  const { error: attrDefsError } = await supabase
    .from('attribute_definitions')
    .delete()
    .in('definition_id',
      (await supabase.from('definitions').select('id').eq('user_id', USER_ID)).data?.map(d => d.id) || []
    );
  if (attrDefsError) throw new Error(`Failed to delete attribute_definitions: ${attrDefsError.message}`);
  console.log('  Deleted attribute_definitions');

  const { error: defsError } = await supabase
    .from('definitions')
    .delete()
    .eq('user_id', USER_ID);
  if (defsError) throw new Error(`Failed to delete definitions: ${defsError.message}`);
  console.log('  Deleted definitions');
}

async function seedDefinitions(
  parsed: ReturnType<typeof parseDefinitions>,
  definitionIdMap: IdMap
): Promise<void> {
  console.log('\nSeeding definitions...');

  const rows: DefinitionRow[] = parsed.definitions.map((def) => ({
    id: definitionIdMap.get(def.id)!,
    user_id: USER_ID,
    type: def.type,
    code: def.code,
    display_name: def.displayName,
    category: def.category,
    parent_definition_id: def.parentDefinitionId
      ? definitionIdMap.get(def.parentDefinitionId) || null
      : null,
  }));

  if (DRY_RUN) {
    console.log('  [DRY RUN] Would insert definitions:');
    for (const row of rows) {
      console.log(`    ${row.code} (${row.type}) -> ${row.id}`);
    }
    return;
  }

  const { error } = await supabase.from('definitions').insert(rows);
  if (error) throw new Error(`Failed to insert definitions: ${error.message}`);
  console.log(`  Inserted ${rows.length} definitions`);
}

async function seedAttributeDefinitions(
  parsed: ReturnType<typeof parseDefinitions>,
  definitionIdMap: IdMap
): Promise<void> {
  console.log('\nSeeding attribute_definitions...');

  const rows: AttributeDefinitionRow[] = parsed.attributeDefinitions.map((attrDef) => ({
    definition_id: definitionIdMap.get(attrDef.definitionId)!,
    datatype: attrDef.datatype,
  }));

  if (rows.length === 0) {
    console.log('  No attribute definitions to insert');
    return;
  }

  if (DRY_RUN) {
    console.log('  [DRY RUN] Would insert attribute_definitions:');
    for (const row of rows) {
      console.log(`    ${row.definition_id} (${row.datatype})`);
    }
    return;
  }

  const { error } = await supabase.from('attribute_definitions').insert(rows);
  if (error) throw new Error(`Failed to insert attribute_definitions: ${error.message}`);
  console.log(`  Inserted ${rows.length} attribute_definitions`);
}

async function seedMetricDefinitions(
  parsed: ReturnType<typeof parseDefinitions>,
  definitionIdMap: IdMap,
  fieldIdMap: IdMap
): Promise<void> {
  console.log('\nSeeding metric_definitions...');

  const rows: MetricDefinitionRow[] = parsed.metricDefinitions.map((metricDef) => ({
    definition_id: definitionIdMap.get(metricDef.definitionId)!,
    primary_identifier_field_id: metricDef.primaryIdentifierFieldId
      ? fieldIdMap.get(metricDef.primaryIdentifierFieldId) || null
      : null,
  }));

  if (DRY_RUN) {
    console.log('  [DRY RUN] Would insert metric_definitions:');
    for (const row of rows) {
      console.log(`    ${row.definition_id} (primary_field: ${row.primary_identifier_field_id || 'none'})`);
    }
    return;
  }

  // Insert without primary_identifier_field_id first (fields don't exist yet)
  const rowsWithoutPrimary = rows.map((r) => ({
    definition_id: r.definition_id,
    primary_identifier_field_id: null,
  }));

  const { error } = await supabase.from('metric_definitions').insert(rowsWithoutPrimary);
  if (error) throw new Error(`Failed to insert metric_definitions: ${error.message}`);
  console.log(`  Inserted ${rows.length} metric_definitions`);
}

async function seedFields(
  parsed: ReturnType<typeof parseDefinitions>,
  definitionIdMap: IdMap,
  fieldIdMap: IdMap
): Promise<void> {
  console.log('\nSeeding fields...');

  const rows: FieldRow[] = parsed.fields.map((field) => ({
    id: fieldIdMap.get(field.id)!,
    user_id: USER_ID,
    metric_definition_id: definitionIdMap.get(field.metricDefinitionId)!,
    name: field.name,
    base_definition_id: definitionIdMap.get(field.baseDefinitionId)!,
    min_instances: field.minInstances,
    max_instances: field.maxInstances,
    input_mode: field.inputMode,
    formula: field.formula,
  }));

  if (DRY_RUN) {
    console.log('  [DRY RUN] Would insert fields:');
    for (const row of rows) {
      const formula = row.formula ? ` = ${row.formula}` : '';
      console.log(`    ${row.name}: ${row.base_definition_id}${formula} -> ${row.id}`);
    }
    return;
  }

  const { error } = await supabase.from('fields').insert(rows);
  if (error) throw new Error(`Failed to insert fields: ${error.message}`);
  console.log(`  Inserted ${rows.length} fields`);
}

async function updatePrimaryIdentifierFields(
  parsed: ReturnType<typeof parseDefinitions>,
  definitionIdMap: IdMap,
  fieldIdMap: IdMap
): Promise<void> {
  console.log('\nUpdating primary_identifier_field_id...');

  const updates = parsed.metricDefinitions
    .filter((m) => m.primaryIdentifierFieldId)
    .map((metricDef) => ({
      definition_id: definitionIdMap.get(metricDef.definitionId)!,
      primary_identifier_field_id: fieldIdMap.get(metricDef.primaryIdentifierFieldId!)!,
    }));

  if (updates.length === 0) {
    console.log('  No primary identifier fields to update');
    return;
  }

  if (DRY_RUN) {
    console.log('  [DRY RUN] Would update primary_identifier_field_id:');
    for (const update of updates) {
      console.log(`    ${update.definition_id} -> ${update.primary_identifier_field_id}`);
    }
    return;
  }

  for (const update of updates) {
    const { error } = await supabase
      .from('metric_definitions')
      .update({ primary_identifier_field_id: update.primary_identifier_field_id })
      .eq('definition_id', update.definition_id);
    if (error) {
      throw new Error(`Failed to update primary_identifier_field_id: ${error.message}`);
    }
  }
  console.log(`  Updated ${updates.length} primary_identifier_field_id values`);
}

// -----------------------------------------------------------------------------
// Print ID Mapping (for reference)
// -----------------------------------------------------------------------------

function printIdMapping(
  parsed: ReturnType<typeof parseDefinitions>,
  definitionIdMap: IdMap,
  fieldIdMap: IdMap
): void {
  console.log('\n--- ID Mapping Reference ---');
  console.log('\nDefinitions (logical -> UUID):');
  for (const def of parsed.definitions) {
    console.log(`  ${def.id} -> ${definitionIdMap.get(def.id)}`);
  }
  console.log('\nFields (logical -> UUID):');
  for (const field of parsed.fields) {
    console.log(`  ${field.id} -> ${fieldIdMap.get(field.id)}`);
  }
}

// -----------------------------------------------------------------------------
// Main
// -----------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('='.repeat(60));
  console.log('Seed Definitions');
  console.log('='.repeat(60));
  console.log(`\nFile: ${DEFINITIONS_FILE}`);
  console.log(`User ID: ${USER_ID}`);
  if (DRY_RUN) console.log('Mode: DRY RUN (no changes will be made)');
  if (CLEAN) console.log('Mode: CLEAN (will delete existing data first)');

  // Parse definitions
  console.log('\nParsing definitions.txt...');
  const parsed = parseDefinitions(DEFINITIONS_FILE);
  console.log(`  Found ${parsed.definitions.length} definitions`);
  console.log(`  Found ${parsed.metricDefinitions.length} metric definitions`);
  console.log(`  Found ${parsed.attributeDefinitions.length} attribute definitions`);
  console.log(`  Found ${parsed.fields.length} fields`);

  // Generate ID mappings
  const { definitionIdMap, fieldIdMap } = generateIdMaps(parsed);

  // Print mapping for reference
  printIdMapping(parsed, definitionIdMap, fieldIdMap);

  // Clean existing data if requested
  if (CLEAN && !DRY_RUN) {
    await cleanExistingData();
  }

  // Seed in dependency order
  await seedDefinitions(parsed, definitionIdMap);
  await seedAttributeDefinitions(parsed, definitionIdMap);
  await seedMetricDefinitions(parsed, definitionIdMap, fieldIdMap);
  await seedFields(parsed, definitionIdMap, fieldIdMap);
  await updatePrimaryIdentifierFields(parsed, definitionIdMap, fieldIdMap);

  console.log('\n' + '='.repeat(60));
  console.log(DRY_RUN ? 'DRY RUN COMPLETE' : 'SEED COMPLETE');
  console.log('='.repeat(60));
}

main().catch((error) => {
  console.error('\nSeed failed:', error);
  process.exit(1);
});
