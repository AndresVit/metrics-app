/**
 * testSearchKey.ts
 *
 * Demonstrates search key functionality:
 * 1. Parsing definitions with @key annotation
 * 2. Successful reference resolution via search key
 * 3. Duplicate key detection
 *
 * Run with: npx tsx dev/testSearchKey.ts
 */

import { parseDefinitionsFromString } from './parseDefinitions';
import { DefaultParser } from './defaultParser';
import { ParserRegistry } from './parserRegistry';
import { runPipeline, PipelineConfig } from '../src/pipeline/pipeline';
import { ResolvedEntry, ExistingEntriesResolver, getAttributeValue } from '../src/pipeline/types';
import { MetricDefinition } from '../src/domain';

// ─── Helpers ─────────────────────────────────────────────────────────────────

class TestEntryStore implements ExistingEntriesResolver {
  private entries: ResolvedEntry[] = [];
  private parsedDefs: ReturnType<typeof parseDefinitionsFromString>;

  constructor(parsedDefs: ReturnType<typeof parseDefinitionsFromString>) {
    this.parsedDefs = parsedDefs;
  }

  addEntry(entry: ResolvedEntry): void {
    this.entries.push(entry);
  }

  findByPrimaryIdentifier(
    metricDefinitionId: string,
    identifierValue: string | number
  ): ResolvedEntry[] {
    const metricDef = this.parsedDefs.metricDefinitions.find(
      (md) => md.definitionId === metricDefinitionId
    );
    if (!metricDef || !metricDef.primaryIdentifierFieldId) return [];

    return this.entries.filter((e) => {
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
    const metricDef = this.parsedDefs.metricDefinitions.find(
      (md) => md.definitionId === metricDefinitionId
    );
    if (!metricDef || !metricDef.searchKeyType) return [];

    return this.entries.filter((e) => {
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
  }
}

function printResult(label: string, result: ReturnType<typeof runPipeline>): void {
  if (result.success) {
    console.log(`✓ ${label}: SUCCESS`);
    printEntry(result.value, '  ');
  } else {
    console.log(`✗ ${label}: ${result.error.type} - ${result.error.message}`);
  }
  console.log();
}

function printEntry(entry: ResolvedEntry, indent: string): void {
  const defId = entry.entry.definitionId;
  const sub = entry.entry.subdivision ? `:${entry.entry.subdivision}` : '';
  console.log(`${indent}[${defId}${sub}] id=${entry.entry.id}`);

  if (entry.attributeEntry) {
    const val = getAttributeValue(entry.attributeEntry);
    console.log(`${indent}  field=${entry.fieldId} value=${val}`);
  }

  for (const child of entry.children) {
    printEntry(child, indent + '  ');
  }
}

// ─── Test Definitions ────────────────────────────────────────────────────────

const DEFINITIONS = `
METRIC BOOK
  title: string @key
  total_pages: int
  total_words: int
  words_per_page: float = self.total_words / self.total_pages
END

METRIC READ
  pages_read: int
  duration: int
  book: BOOK = subdivision[0]
  wpm: float = self.pages_read * self.book.words_per_page / self.duration
END
`;

// ─── Run Tests ───────────────────────────────────────────────────────────────

console.log('=== Search Key Feature Tests ===\n');

// Test 1: Parse definitions with @key
console.log('--- Test 1: Parse definitions with @key ---');
const parsed = parseDefinitionsFromString(DEFINITIONS);
const bookMetric = parsed.metricDefinitions.find((m) => m.definitionId === 'def-book');
console.log(`BOOK searchKeyType: ${bookMetric?.searchKeyType}`);
console.log(`BOOK searchKeyFieldId: ${bookMetric?.searchKeyFieldId}`);
console.log(`BOOK primaryIdentifierFieldId: ${bookMetric?.primaryIdentifierFieldId}`);
console.log();

// Test 2: Insert BOOK entry and resolve READ reference
console.log('--- Test 2: Insert BOOK, then READ referencing it ---');
const registry = new ParserRegistry();
registry.register(new DefaultParser());

const entryStore = new TestEntryStore(parsed);
const pipelineConfig: PipelineConfig = {
  definitions: parsed.definitions,
  metricDefinitions: parsed.metricDefinitions,
  attributeDefinitions: parsed.attributeDefinitions,
  fields: parsed.fields,
  existingEntries: entryStore,
};

const userId = 'test-user';
const entryDate = new Date(2026, 0, 15);

// Insert BOOK;title:Dune,total_pages:240,total_words:60000
const bookBlock = 'BOOK;title:Dune,total_pages:240,total_words:60000';
const bookParsed = registry.parseBlock(bookBlock, parsed, userId);
if (!bookParsed.success) {
  console.log(`Parse failed: ${bookParsed.error.message}`);
  process.exit(1);
}

// Set timestamp
bookParsed.entries[0].timestamp = entryDate;

const bookResult = runPipeline(bookParsed.entries[0], pipelineConfig, userId);
printResult('Insert BOOK(Dune)', bookResult);

if (bookResult.success) {
  entryStore.addEntry(bookResult.value);
}

// Insert READ:Dune/ch3;pages_read:12,duration:30
const readBlock = 'READ:Dune/ch3;pages_read:12,duration:30';
const readParsed = registry.parseBlock(readBlock, parsed, userId);
if (!readParsed.success) {
  console.log(`Parse failed: ${readParsed.error.message}`);
  process.exit(1);
}

readParsed.entries[0].timestamp = entryDate;

const readResult = runPipeline(readParsed.entries[0], pipelineConfig, userId);
printResult('Insert READ(Dune/ch3) - resolves book via search key', readResult);

// Test 3: Duplicate key detection
console.log('--- Test 3: Duplicate key detection ---');
const bookBlock2 = 'BOOK;title:Dune,total_pages:500,total_words:120000';
const bookParsed2 = registry.parseBlock(bookBlock2, parsed, userId);
if (!bookParsed2.success) {
  console.log(`Parse failed: ${bookParsed2.error.message}`);
  process.exit(1);
}
bookParsed2.entries[0].timestamp = entryDate;

const bookResult2 = runPipeline(bookParsed2.entries[0], pipelineConfig, userId);
printResult('Insert duplicate BOOK(Dune) - should fail', bookResult2);

// Test 4: Different key value succeeds
console.log('--- Test 4: Different key value succeeds ---');
const bookBlock3 = 'BOOK;title:Foundation,total_pages:300,total_words:75000';
const bookParsed3 = registry.parseBlock(bookBlock3, parsed, userId);
if (!bookParsed3.success) {
  console.log(`Parse failed: ${bookParsed3.error.message}`);
  process.exit(1);
}
bookParsed3.entries[0].timestamp = entryDate;

const bookResult3 = runPipeline(bookParsed3.entries[0], pipelineConfig, userId);
printResult('Insert BOOK(Foundation) - should succeed', bookResult3);

// Test 5: METRIC="value" syntax in parser
console.log('--- Test 5: BOOK="Dune" syntax ---');
const readBlock2 = 'READ:ch4;pages_read:15,duration:25,book:BOOK="Dune"';
const readParsed2 = registry.parseBlock(readBlock2, parsed, userId);
if (!readParsed2.success) {
  console.log(`Parse failed: ${readParsed2.error.message}`);
} else {
  readParsed2.entries[0].timestamp = entryDate;
  // The book field has formula=subdivision[0], but also we provided explicit value
  // Since book has a formula, the explicit value from parser won't be used
  // (formulas override). The BOOK="Dune" syntax works for input-mode fields.
  // For formula fields, the subdivision approach is the canonical way.
  console.log('Parsed BOOK="Dune" syntax successfully (for input-mode metric reference fields)');
}

console.log();
console.log('=== All tests complete ===');
