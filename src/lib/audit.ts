// items/sources/annotations の変更履歴を audit_logs に記録・参照する処理。
// 記録失敗が本体の書き込み処理を止めないよう、insert 失敗は握りつぶして console.error に留める。
import { getSupabaseAdminClient } from './supabase';
import type { AuditLog } from './db-types';

export type AuditAction = 'insert' | 'update' | 'delete';

interface RecordAuditLogInput {
  table: string;
  recordId: number | null;
  action: AuditAction;
  actor?: string;
  before: unknown;
  after: unknown;
}

export async function recordAuditLog(input: RecordAuditLogInput): Promise<void> {
  try {
    const supabase = await getSupabaseAdminClient();
    const { error } = await supabase.from('audit_logs').insert([
      {
        table_name: input.table,
        record_id: input.recordId,
        action: input.action,
        actor: input.actor ?? null,
        before: input.before ?? null,
        after: input.after ?? null,
      },
    ]);
    if (error) throw error;
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('[audit] failed to record audit log', error);
  }
}

export interface AuditLogFilters {
  table?: string;
  recordId?: number;
  limit?: number;
}

const DEFAULT_AUDIT_LIMIT = 50;
const MAX_AUDIT_LIMIT = 200;

export async function fetchAuditLogs(filters: AuditLogFilters = {}): Promise<AuditLog[]> {
  const supabase = await getSupabaseAdminClient();
  let query = supabase.from<AuditLog>('audit_logs').select('*').order('created_at', { ascending: false });

  if (filters.table?.trim()) {
    query = query.eq('table_name', filters.table.trim());
  }
  if (filters.recordId !== undefined) {
    query = query.eq('record_id', filters.recordId);
  }

  const limit =
    filters.limit && filters.limit > 0 && filters.limit <= MAX_AUDIT_LIMIT ? filters.limit : DEFAULT_AUDIT_LIMIT;
  query = query.limit(limit);

  const { data, error } = await query;
  if (error) throw error;
  return data ?? [];
}
