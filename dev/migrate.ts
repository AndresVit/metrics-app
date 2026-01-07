/**
 * Run SQL migrations directly against Supabase Postgres
 *
 * Usage: npx tsx dev/migrate.ts <sql-file>
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';
import { DEV_CONFIG } from './config';

const { Client } = pg;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Extract project ref from Supabase URL
const projectRef = DEV_CONFIG.SUPABASE_URL.match(/https:\/\/([^.]+)\.supabase\.co/)?.[1];

if (!projectRef) {
  console.error('Could not extract project ref from SUPABASE_URL');
  process.exit(1);
}

// Supabase database connection string
// Format: postgresql://postgres:[password]@db.[project-ref].supabase.co:5432/postgres
// Uses DATABASE_PASSWORD env var (set this to your Supabase database password)
const DATABASE_URL = process.env.DATABASE_URL ||
  `postgresql://postgres:${process.env.DATABASE_PASSWORD || 'YOUR_DB_PASSWORD'}@db.${projectRef}.supabase.co:5432/postgres`;

async function runMigration(sqlFile: string): Promise<void> {
  const filePath = path.resolve(__dirname, '..', sqlFile);

  if (!fs.existsSync(filePath)) {
    throw new Error(`SQL file not found: ${filePath}`);
  }

  const sql = fs.readFileSync(filePath, 'utf-8');

  console.log(`Running migration: ${sqlFile}`);
  console.log('=' .repeat(60));

  const client = new Client({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });

  try {
    await client.connect();
    console.log('Connected to database');

    // Split by semicolons and run each statement
    const statements = sql
      .split(';')
      .map(s => s.trim())
      .filter(s => s.length > 0 && !s.startsWith('--'));

    for (const statement of statements) {
      if (statement.trim()) {
        console.log(`\nExecuting: ${statement.substring(0, 60)}...`);
        try {
          await client.query(statement);
          console.log('  OK');
        } catch (err: any) {
          // Ignore "already exists" errors
          if (err.message.includes('already exists')) {
            console.log(`  SKIPPED (already exists)`);
          } else {
            throw err;
          }
        }
      }
    }

    console.log('\n' + '=' .repeat(60));
    console.log('Migration complete!');
  } finally {
    await client.end();
  }
}

const sqlFile = process.argv[2] || 'supabase/widgets.sql';

runMigration(sqlFile).catch((err) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
