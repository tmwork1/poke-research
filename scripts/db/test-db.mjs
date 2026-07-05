import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL || 'http://localhost:54321';
const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_PUBLISHABLE_KEY;

if (!key) {
  console.error('No SUPABASE key found in environment. Run scripts/db/setup-env.ps1 or set env vars.');
  process.exit(1);
}

const supabase = createClient(url, key, { detectSessionInUrl: false });

async function main() {
  console.log('Running M1 CRUD smoke test...');

  const source = {
    name: 'test-source',
    type: 'smoke-test',
    origin_url: 'https://example.com/source',
    metadata: { purpose: 'smoke-test' },
  };

  const { data: insertedSource, error: sourceInsertError } = await supabase
    .from('sources')
    .insert([source])
    .select()
    .single();
  if (sourceInsertError) {
    console.error('Source insert error:', sourceInsertError);
    process.exit(2);
  }
  console.log('Inserted source:', insertedSource);

  const item = {
    source_id: insertedSource.id,
    external_url: 'https://example.com/item',
    kind: 'article',
    title: 'test-item',
    authors: ['smoke-test'],
    summary: 'temporary item for smoke testing',
    published_at: null,
    updated_at: null,
    metadata: { purpose: 'smoke-test' },
    version: '1',
  };

  const { data: insertedItem, error: itemInsertError } = await supabase
    .from('items')
    .insert([item])
    .select()
    .single();
  if (itemInsertError) {
    console.error('Item insert error:', itemInsertError);
    process.exit(3);
  }
  console.log('Inserted item:', insertedItem);

  const annotation = {
    item_id: insertedItem.id,
    author_id: null,
    kind: 'note',
    value: { text: 'smoke test annotation' },
    provenance: { source: 'scripts/db/test-db.mjs' },
  };

  const { data: insertedAnnotation, error: annotationInsertError } = await supabase
    .from('annotations')
    .insert([annotation])
    .select()
    .single();
  if (annotationInsertError) {
    console.error('Annotation insert error:', annotationInsertError);
    process.exit(4);
  }
  console.log('Inserted annotation:', insertedAnnotation);

  const { error: annotationDeleteError } = await supabase
    .from('annotations')
    .delete()
    .eq('id', insertedAnnotation.id);
  if (annotationDeleteError) {
    console.error('Annotation delete error:', annotationDeleteError);
    process.exit(5);
  }

  const { error: itemDeleteError } = await supabase.from('items').delete().eq('id', insertedItem.id);
  if (itemDeleteError) {
    console.error('Item delete error:', itemDeleteError);
    process.exit(6);
  }

  const { error: sourceDeleteError } = await supabase.from('sources').delete().eq('id', insertedSource.id);
  if (sourceDeleteError) {
    console.error('Source delete error:', sourceDeleteError);
    process.exit(7);
  }

  console.log('M1 CRUD smoke test completed successfully.');

  console.log('Running M4 audit_logs smoke test...');

  const auditLog = {
    table_name: 'items',
    record_id: 1,
    action: 'insert',
    actor: 'smoke-test',
    before: null,
    after: { purpose: 'smoke-test' },
  };

  const { data: insertedAuditLog, error: auditInsertError } = await supabase
    .from('audit_logs')
    .insert([auditLog])
    .select()
    .single();
  if (auditInsertError) {
    console.error('Audit log insert error:', auditInsertError);
    process.exit(8);
  }
  console.log('Inserted audit log:', insertedAuditLog);

  const { error: auditDeleteError } = await supabase.from('audit_logs').delete().eq('id', insertedAuditLog.id);
  if (auditDeleteError) {
    console.error('Audit log delete error:', auditDeleteError);
    process.exit(9);
  }

  console.log('M4 audit_logs smoke test completed successfully.');
}

main().catch((e) => { console.error(e); process.exit(99); });
