/**
 * runMigrations.ts
 *
 * Runs SQL migrations against Supabase using the REST API.
 * Run with: npx tsx dev/runMigrations.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { DEV_CONFIG } from './config';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SUPABASE_URL = process.env.SUPABASE_URL || DEV_CONFIG.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || DEV_CONFIG.SUPABASE_SERVICE_ROLE_KEY;

// Migration files in order
const MIGRATIONS = [
  '../supabase/dashboards.sql',
  '../supabase/widgets_phase2.sql',
];

async function runSQL(sql: string, description: string): Promise<void> {
  console.log(`\nRunning: ${description}...`);

  const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/exec_sql`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    },
    body: JSON.stringify({ query: sql }),
  });

  if (!response.ok) {
    // Try alternative: direct pg endpoint
    const pgResponse = await fetch(`${SUPABASE_URL}/pg`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      },
      body: JSON.stringify({ query: sql }),
    });

    if (!pgResponse.ok) {
      const text = await response.text();
      throw new Error(`Migration failed: ${text}`);
    }
  }

  console.log(`  Done`);
}

async function main(): Promise<void> {
  console.log('='.repeat(60));
  console.log('Running Supabase Migrations');
  console.log('='.repeat(60));
  console.log(`\nSupabase URL: ${SUPABASE_URL}`);

  for (const migrationPath of MIGRATIONS) {
    const fullPath = path.join(__dirname, migrationPath);
    const fileName = path.basename(migrationPath);

    if (!fs.existsSync(fullPath)) {
      console.log(`\nSkipping ${fileName} (file not found)`);
      continue;
    }

    const sql = fs.readFileSync(fullPath, 'utf-8');

    try {
      await runSQL(sql, fileName);
    } catch (error) {
      console.error(`\nError running ${fileName}:`, error);
      console.log('\nPlease run migrations manually in Supabase SQL Editor:');
      console.log(`  1. ${fullPath}`);
      throw error;
    }
  }

  console.log('\n' + '='.repeat(60));
  console.log('MIGRATIONS COMPLETE');
  console.log('='.repeat(60));
}

main().catch((error) => {
  console.error('\nMigration failed. Run manually in Supabase SQL Editor.');
  process.exit(1);
});
