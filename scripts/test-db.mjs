import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL || 'http://localhost:54321';
const key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;

if (!key) {
  console.error('No SUPABASE key found in environment. Run scripts/setup-env.ps1 or set env vars.');
  process.exit(1);
}

const supabase = createClient(url, key, { detectSessionInUrl: false });

async function main() {
  console.log('Running basic Supabase connection test...');

  const { data, error } = await supabase.from('pokemon').select('id, species').limit(5);
  if (error) {
    console.error('Select error:', error);
    process.exit(2);
  }
  console.log('Fetched rows (up to 5):', data);

  // Insert a test row, then delete it
  const test = { species: 'test-species', national_id: 99999, nickname: 'test-temp' };
  const { data: ins, error: insErr } = await supabase.from('pokemon').insert([test]).select().single();
  if (insErr) {
    console.error('Insert error:', insErr);
    process.exit(3);
  }
  console.log('Inserted test row:', ins);

  const { error: delErr } = await supabase.from('pokemon').delete().eq('id', ins.id);
  if (delErr) {
    console.error('Delete error:', delErr);
    process.exit(4);
  }
  console.log('Deleted test row id', ins.id);

  console.log('Supabase basic tests completed successfully.');
}

main().catch((e) => { console.error(e); process.exit(99); });
