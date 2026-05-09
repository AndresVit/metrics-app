/**
 * Supabase Client Configuration
 *
 * Minimal client setup for persistence layer.
 * Uses dev/config.ts for credentials, with env var override.
 */
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { DEV_CONFIG } from '../../dev/config';

const SUPABASE_URL = process.env.SUPABASE_URL || DEV_CONFIG.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || DEV_CONFIG.SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || DEV_CONFIG.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || SUPABASE_URL === 'https://your-project.supabase.co') {
  console.warn(
    'Warning: SUPABASE_URL not configured. ' +
      'Update dev/config.ts with your credentials.'
  );
}

export const supabase: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
