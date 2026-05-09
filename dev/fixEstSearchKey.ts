/**
 * Remove the search key from EST's project field.
 * Run with: npx tsx dev/fixEstSearchKey.ts
 */

import { createClient } from '@supabase/supabase-js';
import { DEV_CONFIG } from './config';

const supabase = createClient(DEV_CONFIG.SUPABASE_URL, DEV_CONFIG.SUPABASE_SERVICE_ROLE_KEY);

async function main() {
  // Find the metric_definitions row for EST
  const { data: def, error: defErr } = await supabase
    .from('definitions')
    .select('id')
    .eq('code', 'EST')
    .single();

  if (defErr || !def) {
    console.error('Could not find EST definition:', defErr);
    process.exit(1);
  }

  const { error } = await supabase
    .from('metric_definitions')
    .update({ primary_identifier_field_id: null })
    .eq('definition_id', def.id);

  if (error) {
    console.error('Failed to clear search key:', error);
    process.exit(1);
  }

  console.log('Done — EST no longer has a search key.');
}

main();
