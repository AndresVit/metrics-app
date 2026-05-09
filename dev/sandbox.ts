/**
 * sandbox.ts
 *
 * Single entry point for testing the pipeline end-to-end.
 *
 * Run with: npx tsx dev/sandbox.ts
 *
 * This file is intentionally verbose and explicit.
 * No abstractions. No helpers. No magic.
 *
 * Updated to use ParserRegistry for routing input blocks to parsers.
 * Supports both single-line entries (via DefaultParser) and multiline
 * timing blocks (via TimingParser).
 */

import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'url';
import { parseDefinitions, ParsedDefinitions } from './parseDefinitions';
import { PipelineConfig, runPipeline } from '../src/pipeline/pipeline';
import { MetricEntryInput, ResolvedEntry, ExistingEntriesResolver } from '../src/pipeline/types';
import { ParserRegistry } from './parserRegistry';
import { DefaultParser } from './defaultParser';
import { TimingParser } from './timingParser';
import {
  persistResolvedEntry,
  loadDefinitionIdMap,
  loadFieldIdMap,
  PersistenceConfig,
} from '../src/persistence';
import { DEV_CONFIG } from './config';

// -----------------------------------------------------------------------------
// Configuration
// -----------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const USER_ID = DEV_CONFIG.USER_ID;
const DEFINITIONS_FILE = path.join(__dirname, 'definitions.txt');
const ENTRIES_FILE = path.join(__dirname, 'entries.txt');
const TIMING_ENTRIES_FILE = path.join(__dirname, 'timing_entries.txt');

// -----------------------------------------------------------------------------
// In-memory entry store for instance resolution
// -----------------------------------------------------------------------------

/**
 * Stores successfully processed entries for later resolution.
 * This is an MVP implementation - no persistence, no optimization.
 */
class InMemoryEntryStore implements ExistingEntriesResolver {
  private entries: ResolvedEntry[] = [];
  private parsedDefs: ParsedDefinitions | null = null;

  setParsedDefinitions(defs: ParsedDefinitions): void {
    this.parsedDefs = defs;
  }

  addEntry(entry: ResolvedEntry): void {
    this.entries.push(entry);
  }

  findByPrimaryIdentifier(
    metricDefinitionId: string,
    identifierValue: string | number
  ): ResolvedEntry[] {
    if (!this.parsedDefs) return [];

    // Find the MetricDefinition to get primaryIdentifierFieldId
    const metricDef = this.parsedDefs.metricDefinitions.find(
      (m) => m.definitionId === metricDefinitionId
    );
    if (!metricDef || !metricDef.primaryIdentifierFieldId) return [];

    const primaryFieldId = metricDef.primaryIdentifierFieldId;

    // Find entries that match the metric definition and have matching primary identifier
    const matches: ResolvedEntry[] = [];

    for (const entry of this.entries) {
      // Check if this entry is of the requested metric type
      if (entry.entry.definitionId !== metricDefinitionId) continue;

      // Find the primary identifier value in the entry's children
      for (const child of entry.children) {
        if (child.fieldId !== primaryFieldId) continue;
        if (!child.attributeEntry) continue;

        // Get the value from the attribute entry
        const attrValue =
          child.attributeEntry.valueInt ??
          child.attributeEntry.valueString ??
          child.attributeEntry.valueFloat ??
          null;

        if (attrValue === identifierValue) {
          matches.push(entry);
          break;
        }
      }
    }

    return matches;
  }
}

const entryStore = new InMemoryEntryStore();

// -----------------------------------------------------------------------------
// Parser Registry Setup
// -----------------------------------------------------------------------------

function createParserRegistry(): ParserRegistry {
  const registry = new ParserRegistry();
  registry.register(new DefaultParser());
  registry.register(new TimingParser());
  return registry;
}

// -----------------------------------------------------------------------------
// Input Block Parsing
// -----------------------------------------------------------------------------

/**
 * Split input file content into blocks.
 *
 * A block is:
 *   - One or more non-empty, non-comment lines
 *   - Separated by one or more blank lines
 *   - Comments (lines starting with #) within blocks are preserved
 *   - Standalone comment blocks are skipped
 *
 * This allows multiline timing blocks to be grouped together.
 */
function splitIntoBlocks(content: string): string[] {
  const lines = content.split('\n');
  const blocks: string[] = [];
  let currentBlock: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed === '') {
      // Empty line: end current block if non-empty
      if (currentBlock.length > 0) {
        blocks.push(currentBlock.join('\n'));
        currentBlock = [];
      }
    } else {
      currentBlock.push(line);
    }
  }

  // Don't forget the last block
  if (currentBlock.length > 0) {
    blocks.push(currentBlock.join('\n'));
  }

  // Filter out blocks that contain only comments
  return blocks.filter((block) => {
    const nonCommentLines = block
      .split('\n')
      .filter((l) => l.trim() !== '' && !l.trim().startsWith('#'));
    return nonCommentLines.length > 0;
  });
}

// -----------------------------------------------------------------------------
// Logging helpers (intentionally simple)
// -----------------------------------------------------------------------------

function logSeparator(label: string): void {
  console.log();
  console.log('='.repeat(80));
  console.log(label);
  console.log('='.repeat(80));
}

function logSubsection(label: string): void {
  console.log();
  console.log('--- ' + label + ' ---');
}

function logDefinitions(parsed: ParsedDefinitions): void {
  logSubsection('Definitions');
  for (const def of parsed.definitions) {
    console.log(`  [${def.type}] ${def.code} (id: ${def.id})`);
  }

  logSubsection('Metric Definitions');
  for (const metricDef of parsed.metricDefinitions) {
    console.log(`  definitionId: ${metricDef.definitionId}, primaryIdentifierFieldId: ${metricDef.primaryIdentifierFieldId ?? '(none)'}`);
  }

  logSubsection('Attribute Definitions');
  for (const attrDef of parsed.attributeDefinitions) {
    console.log(`  definitionId: ${attrDef.definitionId}, datatype: ${attrDef.datatype}`);
  }

  logSubsection('Fields');
  for (const field of parsed.fields) {
    const formula = field.formula ? ` = ${field.formula}` : '';
    console.log(
      `  ${field.id}: ${field.name} -> ${field.baseDefinitionId}${formula}`
    );
  }
}

function logMetricEntryInput(input: MetricEntryInput, indent: number = 0): void {
  const prefix = '  '.repeat(indent);
  console.log(`${prefix}definitionId: ${input.definitionId}`);
  console.log(`${prefix}timestamp: ${input.timestamp.toISOString()}`);
  console.log(`${prefix}subdivision: "${input.subdivision || ''}"`);
  console.log(`${prefix}fields:`);
  for (const field of input.fields) {
    // Check if any values have inline metric entries
    const hasInlineMetric = field.values.some((v) => v.metricEntry);
    if (hasInlineMetric) {
      console.log(`${prefix}  - ${field.fieldId}: [inline metric]`);
      for (const v of field.values) {
        if (v.metricEntry) {
          logMetricEntryInput(v.metricEntry, indent + 2);
        }
      }
    } else {
      const values = field.values.map((v) => {
        let val = 'null';
        if (v.valueInt !== undefined) val = `int(${v.valueInt})`;
        else if (v.valueFloat !== undefined) val = `number(${v.valueFloat})`;
        else if (v.valueString !== undefined) val = `string("${v.valueString}")`;
        else if (v.valueBool !== undefined) val = `bool(${v.valueBool})`;
        // Include per-value subdivision if present
        if (v.subdivision) val += `[sub:${v.subdivision}]`;
        return val;
      });
      console.log(`${prefix}  - ${field.fieldId}: [${values.join(', ')}]`);
    }
  }
  if (input.children && input.children.length > 0) {
    console.log(`${prefix}children:`);
    for (const child of input.children) {
      logMetricEntryInput(child, indent + 1);
    }
  }
}

function logResolvedEntry(entry: ResolvedEntry, indent: number = 0): void {
  const prefix = '  '.repeat(indent);
  console.log(`${prefix}Entry ID: ${entry.entry.id}`);
  console.log(`${prefix}  definitionId: ${entry.entry.definitionId}`);
  console.log(`${prefix}  subdivision: ${entry.entry.subdivision ?? '(none)'}`);

  if (entry.metricEntry) {
    console.log(`${prefix}  [MetricEntry]`);
  }

  if (entry.attributeEntry) {
    const ae = entry.attributeEntry;
    const value =
      ae.valueInt ?? ae.valueFloat ?? ae.valueString ?? ae.valueBool ?? ae.valueTimestamp ?? ae.valueHierarchy;
    // Show subdivision on AttributeEntry child (comes from Entry.subdivision)
    const sub = entry.entry.subdivision ? `, subdivision=${entry.entry.subdivision}` : '';
    console.log(`${prefix}  [AttributeEntry] fieldId=${ae.fieldId}, value=${value}${sub}`);
  }

  for (const child of entry.children) {
    logResolvedEntry(child, indent + 1);
  }
}

// -----------------------------------------------------------------------------
// Main
// -----------------------------------------------------------------------------

async function main(): Promise<void> {
  logSeparator('SANDBOX: Pipeline Test with Parser Registry');

  // Step 1: Parse definitions
  console.log(`\nReading definitions from: ${DEFINITIONS_FILE}`);
  let parsedDefinitions: ParsedDefinitions;
  try {
    parsedDefinitions = parseDefinitions(DEFINITIONS_FILE);
    console.log(`Parsed ${parsedDefinitions.definitions.length} definitions`);
    console.log(`Parsed ${parsedDefinitions.metricDefinitions.length} metric definitions`);
    console.log(`Parsed ${parsedDefinitions.attributeDefinitions.length} attribute definitions`);
    console.log(`Parsed ${parsedDefinitions.fields.length} fields`);
  } catch (error) {
    console.error('FAILED to parse definitions:');
    console.error(error);
    return;
  }

  logDefinitions(parsedDefinitions);

  // Set up entry store with parsed definitions for instance resolution
  entryStore.setParsedDefinitions(parsedDefinitions);

  // Create parser registry
  const registry = createParserRegistry();
  console.log('\nParser registry initialized with DefaultParser and TimingParser');

  // Build PipelineConfig
  const pipelineConfig: PipelineConfig = {
    definitions: parsedDefinitions.definitions,
    metricDefinitions: parsedDefinitions.metricDefinitions,
    attributeDefinitions: parsedDefinitions.attributeDefinitions,
    fields: parsedDefinitions.fields,
    existingEntries: entryStore,
  };

  // Load ID maps from Supabase for persistence
  logSubsection('Loading ID Maps from Supabase');
  let persistenceConfig: PersistenceConfig | null = null;
  try {
    const definitionIdMap = await loadDefinitionIdMap(USER_ID);
    const fieldIdMap = await loadFieldIdMap(USER_ID, definitionIdMap);
    persistenceConfig = { definitionIdMap, fieldIdMap };
    console.log(`Loaded ${definitionIdMap.size} definition ID mappings`);
    console.log(`Loaded ${fieldIdMap.size} field ID mappings`);
  } catch (error) {
    console.warn('Failed to load ID maps from Supabase - persistence disabled');
    console.warn(error instanceof Error ? error.message : error);
  }

  // Step 2: Process regular entries
  if (fs.existsSync(ENTRIES_FILE)) {
    logSeparator('PROCESSING: Regular Entries');
    console.log(`\nReading entries from: ${ENTRIES_FILE}`);

    try {
      const content = fs.readFileSync(ENTRIES_FILE, 'utf-8');
      const blocks = splitIntoBlocks(content);
      console.log(`Found ${blocks.length} input blocks`);

      await processBlocks(blocks, registry, parsedDefinitions, pipelineConfig, persistenceConfig);
    } catch (error) {
      console.error('FAILED to process entries:');
      console.error(error);
    }
  } else {
    console.log(`\nNo entries file found at: ${ENTRIES_FILE}`);
  }

  // Step 3: Process timing entries
  if (fs.existsSync(TIMING_ENTRIES_FILE)) {
    logSeparator('PROCESSING: Timing Entries');
    console.log(`\nReading timing entries from: ${TIMING_ENTRIES_FILE}`);

    try {
      const content = fs.readFileSync(TIMING_ENTRIES_FILE, 'utf-8');
      const blocks = splitIntoBlocks(content);
      console.log(`Found ${blocks.length} input blocks`);

      await processBlocks(blocks, registry, parsedDefinitions, pipelineConfig, persistenceConfig);
    } catch (error) {
      console.error('FAILED to process timing entries:');
      console.error(error);
    }
  } else {
    console.log(`\nNo timing entries file found at: ${TIMING_ENTRIES_FILE}`);
    console.log('To test timing input, create: dev/timing_entries.txt');
  }

  logSeparator('SANDBOX COMPLETE');
}

async function processBlocks(
  blocks: string[],
  registry: ParserRegistry,
  parsedDefinitions: ParsedDefinitions,
  pipelineConfig: PipelineConfig,
  persistenceConfig: PersistenceConfig | null
): Promise<void> {
  for (let blockIndex = 0; blockIndex < blocks.length; blockIndex++) {
    const block = blocks[blockIndex];

    logSubsection(`Block ${blockIndex + 1}`);
    console.log('Input:');
    for (const line of block.split('\n')) {
      console.log(`  > ${line}`);
    }

    // Parse block through registry
    const parseResult = registry.parseBlock(block, parsedDefinitions, USER_ID);

    if (!parseResult.success) {
      console.log('\n  PARSE ERROR:');
      console.log(`    Message: ${parseResult.error.message}`);
      if (parseResult.error.lineNumber !== undefined) {
        console.log(`    Line: ${parseResult.error.lineNumber}`);
      }
      if (parseResult.error.details) {
        console.log(`    Details: ${parseResult.error.details}`);
      }
      continue;
    }

    console.log(`\n  Parsed ${parseResult.entries.length} MetricEntryInput(s):`);
    for (let i = 0; i < parseResult.entries.length; i++) {
      console.log(`\n  [Entry ${i + 1}]`);
      logMetricEntryInput(parseResult.entries[i], 2);
    }

    // Run pipeline for each entry
    console.log('\n  Pipeline Results:');
    for (let i = 0; i < parseResult.entries.length; i++) {
      const input = parseResult.entries[i];
      console.log(`\n  [Pipeline Run ${i + 1}]`);

      try {
        const result = runPipeline(input, pipelineConfig, USER_ID);

        if (result.success) {
          console.log('    STATUS: SUCCESS');
          console.log('    Resolved entry tree:');
          logResolvedEntry(result.value, 3);

          // Store successful entry for future instance resolution
          entryStore.addEntry(result.value);

          // Persist to Supabase
          if (persistenceConfig) {
            try {
              await persistResolvedEntry(result.value, USER_ID, persistenceConfig);
              console.log('    Persisted successfully');
            } catch (persistError) {
              console.log('    Persistence error:', persistError instanceof Error ? persistError.message : persistError);
            }
          } else {
            console.log('    Persistence skipped (no ID maps loaded)');
          }
        } else {
          console.log('    STATUS: FAILED');
          console.log(`    Error type: ${result.error.type}`);
          console.log(`    Message: ${result.error.message}`);
          if ('fieldId' in result.error) {
            console.log(`    Field ID: ${result.error.fieldId}`);
          }
          if ('details' in result.error && result.error.details) {
            console.log(`    Details: ${result.error.details}`);
          }
        }
      } catch (error) {
        console.log('    STATUS: EXCEPTION');
        console.error('    ', error);
      }
    }
  }
}

// Run
main().catch((error) => {
  console.error('Sandbox failed:', error);
  process.exit(1);
});