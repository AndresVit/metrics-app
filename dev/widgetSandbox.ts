/**
 * widgetSandbox.ts
 *
 * Development sandbox for testing the Widget system.
 *
 * Run with: npx tsx dev/widgetSandbox.ts
 *
 * This script demonstrates widget evaluation with:
 * 1. In-memory test data (always works)
 * 2. Live Supabase data (if configured)
 */

import { runWidget, runWidgetWithData, LoadedEntry } from '../src/widget';
import { DEV_CONFIG } from './config';

// -----------------------------------------------------------------------------
// Configuration
// -----------------------------------------------------------------------------

const USER_ID = DEV_CONFIG.USER_ID;

// -----------------------------------------------------------------------------
// Example Widgets
// -----------------------------------------------------------------------------

const DAILY_PRODUCTIVITY_WIDGET = `
WIDGET "Daily Productivity"

tims = TIM FROM TODAY

"productive_time": int = sum(tims.time("t"))
"meeting_time": int = sum(tims.time("m"))
"planning_time": int = sum(tims.time("p"))
"neutral_time": int = sum(tims.time("n"))
"total_duration": int = sum(tims.duration)
"productivity": float = sum(tims.time("t")) / (sum(tims.time("t")) + sum(tims.time("m")) + sum(tims.time("p")))
END
`;

const DAILY_READING_WIDGET = `
WIDGET "Daily Reading"

reads = READ FROM TODAY

"pages": int = sum(reads.pages_read)
"duration": int = sum(reads.duration)
"sessions": int = count(reads)
END
`;

// -----------------------------------------------------------------------------
// Test Data
// -----------------------------------------------------------------------------

/**
 * Create mock TIM entries for testing
 */
function createMockTimEntries(): LoadedEntry[] {
  const now = new Date();

  // Entry 1: Morning session - mostly productive
  const entry1: LoadedEntry = {
    id: 1,
    definitionCode: 'TIM',
    timestamp: new Date(now.getFullYear(), now.getMonth(), now.getDate(), 9, 0),
    subdivision: null,
    attributes: new Map([
      ['time_init', 540],  // 9:00
      ['time_end', 600],   // 10:00
      ['duration', 60],
    ]),
    timeValues: new Map([
      ['t', 45],           // 45 min productive
      ['m', 10],           // 10 min meetings
      ['n', 5],            // 5 min breaks
    ]),
  };

  // Entry 2: Late morning - mixed
  const entry2: LoadedEntry = {
    id: 2,
    definitionCode: 'TIM',
    timestamp: new Date(now.getFullYear(), now.getMonth(), now.getDate(), 10, 30),
    subdivision: null,
    attributes: new Map([
      ['time_init', 630],  // 10:30
      ['time_end', 720],   // 12:00
      ['duration', 90],
    ]),
    timeValues: new Map([
      ['t', 50],           // 50 min productive
      ['m', 25],           // 25 min meetings
      ['p', 10],           // 10 min planning
      ['n', 5],            // 5 min breaks
    ]),
  };

  // Entry 3: Afternoon - productive
  const entry3: LoadedEntry = {
    id: 3,
    definitionCode: 'TIM',
    timestamp: new Date(now.getFullYear(), now.getMonth(), now.getDate(), 14, 0),
    subdivision: null,
    attributes: new Map([
      ['time_init', 840],  // 14:00
      ['time_end', 930],   // 15:30
      ['duration', 90],
    ]),
    timeValues: new Map([
      ['t', 70],           // 70 min productive
      ['m', 15],           // 15 min meetings
      ['n', 5],            // 5 min breaks
    ]),
  };

  return [entry1, entry2, entry3];
}

/**
 * Create mock READ entries for testing
 */
function createMockReadEntries(): LoadedEntry[] {
  const now = new Date();

  const entry1: LoadedEntry = {
    id: 101,
    definitionCode: 'READ',
    timestamp: new Date(now.getFullYear(), now.getMonth(), now.getDate(), 8, 0),
    subdivision: 'Dune',
    attributes: new Map([
      ['pages_read', 25],
      ['duration', 45],
    ]),
  };

  const entry2: LoadedEntry = {
    id: 102,
    definitionCode: 'READ',
    timestamp: new Date(now.getFullYear(), now.getMonth(), now.getDate(), 20, 0),
    subdivision: 'Dune',
    attributes: new Map([
      ['pages_read', 30],
      ['duration', 50],
    ]),
  };

  return [entry1, entry2];
}

// -----------------------------------------------------------------------------
// Logging Helpers
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

// -----------------------------------------------------------------------------
// Main
// -----------------------------------------------------------------------------

async function main(): Promise<void> {
  logSeparator('WIDGET SANDBOX');

  // -------------------------------------------------------------------------
  // Part 1: Test with in-memory mock data
  // -------------------------------------------------------------------------

  logSubsection('Part 1: In-Memory Widget Tests');

  // Test Daily Productivity widget with mock TIM data
  console.log('\n[Test 1] Daily Productivity Widget (mock data)');
  console.log('Widget source:');
  console.log(DAILY_PRODUCTIVITY_WIDGET.trim().split('\n').map(l => '  ' + l).join('\n'));

  const mockTimEntries = createMockTimEntries();
  console.log(`\nMock data: ${mockTimEntries.length} TIM entries`);
  for (const entry of mockTimEntries) {
    const timeStr = entry.timeValues
      ? Array.from(entry.timeValues.entries()).map(([k, v]) => `${k}:${v}`).join(', ')
      : 'none';
    console.log(`  - Entry ${entry.id}: duration=${entry.attributes.get('duration')}, time=[${timeStr}]`);
  }

  const productivityResult = runWidgetWithData(DAILY_PRODUCTIVITY_WIDGET, mockTimEntries);

  if (productivityResult.success) {
    console.log(`\nResult for "${productivityResult.name}":`);
    console.log(JSON.stringify(productivityResult.result, null, 2));
  } else {
    console.log(`\nError: ${productivityResult.error}`);
  }

  // Test Daily Reading widget with mock READ data
  console.log('\n[Test 2] Daily Reading Widget (mock data)');
  console.log('Widget source:');
  console.log(DAILY_READING_WIDGET.trim().split('\n').map(l => '  ' + l).join('\n'));

  const mockReadEntries = createMockReadEntries();
  console.log(`\nMock data: ${mockReadEntries.length} READ entries`);
  for (const entry of mockReadEntries) {
    console.log(`  - Entry ${entry.id}: pages=${entry.attributes.get('pages_read')}, duration=${entry.attributes.get('duration')}`);
  }

  const readingResult = runWidgetWithData(DAILY_READING_WIDGET, mockReadEntries);

  if (readingResult.success) {
    console.log(`\nResult for "${readingResult.name}":`);
    console.log(JSON.stringify(readingResult.result, null, 2));
  } else {
    console.log(`\nError: ${readingResult.error}`);
  }

  // -------------------------------------------------------------------------
  // Part 2: Test with live Supabase data
  // -------------------------------------------------------------------------

  logSubsection('Part 2: Live Supabase Widget Tests');

  console.log('\n[Test 3] Daily Productivity Widget (live data)');
  console.log(`User ID: ${USER_ID}`);
  console.log('Fetching TIM entries from database...\n');

  try {
    const liveResult = await runWidget(DAILY_PRODUCTIVITY_WIDGET, { userId: USER_ID });

    if (liveResult.success) {
      console.log(`Result for "${liveResult.name}":`);
      console.log(JSON.stringify(liveResult.result, null, 2));
    } else {
      console.log(`Error: ${liveResult.error}`);
    }
  } catch (err) {
    console.log(`Exception: ${err instanceof Error ? err.message : err}`);
    console.log('(This is expected if Supabase is not configured or has no data)');
  }

  // -------------------------------------------------------------------------
  // Part 3: Edge cases and validation
  // -------------------------------------------------------------------------

  logSubsection('Part 3: Edge Cases');

  // Test with empty data
  console.log('\n[Test 4] Empty data');
  const emptyResult = runWidgetWithData(DAILY_PRODUCTIVITY_WIDGET, []);
  if (emptyResult.success) {
    console.log(`Result: ${JSON.stringify(emptyResult.result)}`);
  } else {
    console.log(`Error: ${emptyResult.error}`);
  }

  // Test parse error
  console.log('\n[Test 5] Invalid widget syntax');
  const invalidWidget = `
WIDGET Missing Quotes

tims = TIM FROM TODAY

"test": int = sum(tims.duration)
END
`;
  const invalidResult = runWidgetWithData(invalidWidget, mockTimEntries);
  if (invalidResult.success) {
    console.log(`Result: ${JSON.stringify(invalidResult.result)}`);
  } else {
    console.log(`Expected error: ${invalidResult.error}`);
  }

  logSeparator('WIDGET SANDBOX COMPLETE');
}

// Run
main().catch((error) => {
  console.error('Widget sandbox failed:', error);
  process.exit(1);
});
