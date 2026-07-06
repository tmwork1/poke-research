// 収集ジョブ（cron / 手動API）の実行履歴（import_runs）を確認する管理者向けAPI。
// 一覧そのものが管理者向け情報のため、GETであっても常時 Basic 認証で保護する
// （src/middleware.ts の requiresAdminAuth に /api/import/runs を明示的に追加、/api/audit と同様の扱い）。
import { jsonResponse, methodNotAllowed } from '../_shared';
import { fetchImportRuns } from '../../../lib/import-runs';

export const prerender = false;

export async function GET() {
  const runs = await fetchImportRuns();
  return jsonResponse({ data: runs, meta: { count: runs.length } });
}

export const POST = () => methodNotAllowed(['GET']);
export const PUT = POST;
export const PATCH = POST;
export const DELETE = POST;
