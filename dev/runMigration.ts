/**
 * Run SQL migration against Supabase
 *
 * Usage: npx tsx dev/runMigration.ts <sql-file>
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';
import { DEV_CONFIG } from './config';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Use service role key for admin operations
const supabase = createClient(
  DEV_CONFIG.SUPABASE_URL,
  DEV_CONFIG.SUPABASE_SERVICE_ROLE_KEY
);

async function runMigration(sqlFile: string): Promise<void> {
  const filePath = path.resolve(__dirname, '..', sqlFile);

  if (!fs.existsSync(filePath)) {
    throw new Error(`SQL file not found: ${filePath}`);
  }

  const sql = fs.readFileSync(filePath, 'utf-8');

  console.log(`Running migration: ${sqlFile}`);
  console.log('SQL:');
  console.log(sql);
  console.log('\nExecuting...');

  // Execute SQL using Supabase's rpc or raw query
  // For DDL statements, we need to use the postgres connection directly
  // Since we can't do that easily, we'll use the REST API approach

  const { error } = await supabase.rpc('exec_sql', { sql_query: sql }).single();

  if (error) {
    // If rpc doesn't exist, the user needs to run this manually
    console.log('\nNote: Direct SQL execution requires running in Supabase SQL Editor.');
    console.log('Please copy the SQL above and run it in your Supabase dashboard:');
    console.log(`  ${DEV_CONFIG.SUPABASE_URL.replace('.supabase.co', '.supabase.co/project/_/sql')}`);
    console.log('\nOr use the Supabase CLI: supabase db push');
  } else {
    console.log('Migration complete!');
  }
}

const sqlFile = process.argv[2];
if (!sqlFile) {
  console.log('Usage: npx tsx dev/runMigration.ts <sql-file>');
  console.log('Example: npx tsx dev/runMigration.ts supabase/widgets.sql');
  process.exit(1);
}

runMigration(sqlFile).catch(console.error);
