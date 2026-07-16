// 収集ジョブ（cron / 手動API）の実行履歴を import_runs に記録・参照する処理。
// これまで fetched/inserted/skipped は Workers のログにしか残らず、失敗時の再実行判断が
// できなかった（migrations/014_add_import_runs.sql）。記録の失敗が収集ジョブ本体を
// 止めないよう、insert 失敗は握りつぶして console.error に留める（src/lib/audit.ts と同じ方針）。
import { getSupabaseAdminClient } from './supabase';

export type ImportRunTrigger = 'cron' | 'api';
export type ImportRunStatus = 'succeeded' | 'failed';

export interface ImportRunInput {
  provider: string;
  trigger: ImportRunTrigger;
  status: ImportRunStatus;
  fetched?: number;
  inserted?: number;
  updated?: number;
  skipped?: number;
  error?: string | null;
  detail?: Record<string, unknown> | null;
  startedAt: string;
  finishedAt?: string;
}

export interface ImportRun {
  id: number;
  provider: string;
  trigger: string;
  status: string;
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
  error: string | null;
  detail: Record<string, unknown>;
  started_at: string;
  finished_at: string;
}

export async function recordImportRun(input: ImportRunInput): Promise<void> {
  try {
    const supabase = await getSupabaseAdminClient();
    const { error } = await supabase.from('import_runs').insert([
      {
        provider: input.provider,
        trigger: input.trigger,
        status: input.status,
        fetched: input.fetched ?? 0,
        inserted: input.inserted ?? 0,
        updated: input.updated ?? 0,
        skipped: input.skipped ?? 0,
        error: input.error ?? null,
        detail: input.detail ?? {},
        started_at: input.startedAt,
        finished_at: input.finishedAt ?? new Date().toISOString(),
      },
    ]);
    if (error) throw error;
  } catch (recordError) {
    // eslint-disable-next-line no-console
    console.error('[import-runs] failed to record import run', recordError);
  }
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export async function fetchImportRuns(limit = DEFAULT_LIMIT): Promise<ImportRun[]> {
  const supabase = await getSupabaseAdminClient();
  const safeLimit = Number.isInteger(limit) && limit > 0 && limit <= MAX_LIMIT ? limit : DEFAULT_LIMIT;

  const { data, error } = await supabase
    .from('import_runs')
    .select('*')
    .order('finished_at', { ascending: false })
    .limit(safeLimit);
  if (error) throw error;
  return (data ?? []) as ImportRun[];
}

interface ImportOutcomeLike {
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}

// cron ハンドラ・手動起動 API の両方が使う共通ラッパー。
// 成功時は結果の fetched/inserted/updated/skipped を、失敗時はエラーメッセージを記録したうえで
// 呼び出し元にエラーを再throwする（ジョブ全体の失敗検知・アラート送信は呼び出し元の責務のまま）。
export async function runAndRecord<T extends ImportOutcomeLike>(
  provider: string,
  trigger: ImportRunTrigger,
  fn: () => Promise<T>,
): Promise<T> {
  const startedAt = new Date().toISOString();
  try {
    const result = await fn();
    await recordImportRun({
      provider,
      trigger,
      status: 'succeeded',
      fetched: result.fetched,
      inserted: result.inserted,
      updated: result.updated,
      skipped: result.skipped,
      startedAt,
    });
    return result;
  } catch (error) {
    await recordImportRun({
      provider,
      trigger,
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
      startedAt,
    });
    throw error;
  }
}
