/**
 * seedWidgets.ts
 *
 * Seeds Supabase with widgets from widgets.txt.
 * Generates real UUIDs for each widget.
 *
 * Run with: npx tsx dev/seedWidgets.ts
 *
 * Options:
 *   --dry-run    Print what would be inserted without actually inserting
 *   --clean      Delete existing widgets for user before seeding
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import { supabase } from '../src/persistence/supabaseClient';
import { DEV_CONFIG } from './config';
import { parseWidget } from '../src/widget/parseWidget';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuration
const WIDGETS_FILE = path.join(__dirname, 'widgets.txt');
const USER_ID = process.env.SEED_USER_ID || DEV_CONFIG.USER_ID;

// Parse command line arguments
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const CLEAN = args.includes('--clean');

// -----------------------------------------------------------------------------
// Widget Parsing
// -----------------------------------------------------------------------------

interface ParsedWidgetBlock {
  name: string;
  dsl: string;
}

/**
 * Parse widgets.txt into individual widget blocks.
 * Each block starts with WIDGET and ends with END.
 */
function parseWidgetsFile(filePath: string): ParsedWidgetBlock[] {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');

  const widgets: ParsedWidgetBlock[] = [];
  let currentBlock: string[] = [];
  let inWidget = false;

  for (const line of lines) {
    const trimmed = line.trim();

    // Skip comments
    if (trimmed.startsWith('#')) continue;

    if (trimmed.startsWith('WIDGET ')) {
      inWidget = true;
      currentBlock = [line];
    } else if (trimmed === 'END' && inWidget) {
      currentBlock.push(line);
      const dsl = currentBlock.join('\n');

      // Validate the widget DSL
      const parsed = parseWidget(dsl);
      if (parsed.success) {
        widgets.push({
          name: parsed.widget.name,
          dsl: dsl,
        });
      } else {
        console.warn(`Warning: Skipping invalid widget: ${parsed.error.message}`);
      }

      currentBlock = [];
      inWidget = false;
    } else if (inWidget) {
      currentBlock.push(line);
    }
  }

  return widgets;
}

// -----------------------------------------------------------------------------
// Database Row Types
// -----------------------------------------------------------------------------

interface WidgetRow {
  id: string;
  user_id: string;
  name: string;
  dsl: string;
}

// -----------------------------------------------------------------------------
// Seed Functions
// -----------------------------------------------------------------------------

async function cleanExistingWidgets(): Promise<void> {
  console.log(`\nCleaning existing widgets for user ${USER_ID}...`);

  const { error } = await supabase
    .from('widgets')
    .delete()
    .eq('user_id', USER_ID);

  if (error) throw new Error(`Failed to delete widgets: ${error.message}`);
  console.log('  Deleted existing widgets');
}

async function seedWidgets(widgets: ParsedWidgetBlock[]): Promise<void> {
  console.log('\nSeeding widgets...');

  const rows: WidgetRow[] = widgets.map((widget) => ({
    id: randomUUID(),
    user_id: USER_ID,
    name: widget.name,
    dsl: widget.dsl,
  }));

  if (DRY_RUN) {
    console.log('  [DRY RUN] Would insert widgets:');
    for (const row of rows) {
      console.log(`    "${row.name}" -> ${row.id}`);
      console.log(`      DSL: ${row.dsl.split('\n').length} lines`);
    }
    return;
  }

  const { error } = await supabase.from('widgets').insert(rows);
  if (error) throw new Error(`Failed to insert widgets: ${error.message}`);
  console.log(`  Inserted ${rows.length} widgets`);

  // Print inserted widgets
  console.log('\n  Inserted widgets:');
  for (const row of rows) {
    console.log(`    "${row.name}" -> ${row.id}`);
  }
}

// -----------------------------------------------------------------------------
// Main
// -----------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('='.repeat(60));
  console.log('Seed Widgets');
  console.log('='.repeat(60));
  console.log(`\nFile: ${WIDGETS_FILE}`);
  console.log(`User ID: ${USER_ID}`);
  if (DRY_RUN) console.log('Mode: DRY RUN (no changes will be made)');
  if (CLEAN) console.log('Mode: CLEAN (will delete existing widgets first)');

  // Check if file exists
  if (!fs.existsSync(WIDGETS_FILE)) {
    throw new Error(`Widgets file not found: ${WIDGETS_FILE}`);
  }

  // Parse widgets.txt
  console.log('\nParsing widgets.txt...');
  const widgets = parseWidgetsFile(WIDGETS_FILE);
  console.log(`  Found ${widgets.length} widgets`);

  for (const widget of widgets) {
    console.log(`    - "${widget.name}"`);
  }

  if (widgets.length === 0) {
    console.log('\nNo widgets to seed.');
    return;
  }

  // Clean existing widgets if requested
  if (CLEAN && !DRY_RUN) {
    await cleanExistingWidgets();
  }

  // Seed widgets
  await seedWidgets(widgets);

  console.log('\n' + '='.repeat(60));
  console.log(DRY_RUN ? 'DRY RUN COMPLETE' : 'SEED COMPLETE');
  console.log('='.repeat(60));
}

main().catch((error) => {
  console.error('\nSeed failed:', error);
  process.exit(1);
});
