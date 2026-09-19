// 週次通知の採用停止検知を、DB・Cloudflare・Discord に接続せず検証する。
// article-ai.test.ts と同様にモジュール解決を差し替え、実際の API ハンドラを呼び出す。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

const mockModuleUrl = `data:text/javascript,${encodeURIComponent(`
  export const state = { hasRecent: true, count: 0, error: null, calls: [], reports: [] };
  export const env = {};
  export const getSupabaseAdminClient = async () => ({
    from(table) {
      const query = {
        select(...args) { state.calls.push([table, 'select', ...args]); return query; },
        eq(...args) { state.calls.push([table, 'eq', ...args]); return query; },
        gte(...args) { state.calls.push([table, 'gte', ...args]); return query; },
        limit(...args) { state.calls.push([table, 'limit', ...args]); return query; },
        then(resolve, reject) {
          return Promise.resolve(table === 'items'
            ? { count: state.count, error: state.error }
            : { data: state.hasRecent ? [{ id: 1 }] : [], error: null }).then(resolve, reject);
        },
      };
      return query;
    },
  });
  export const runWeeklyReview = async () => ({ itemCandidates: [], sourceCandidates: [], dismissedCount: 2 });
  export const formatWeeklyReviewMessage = () => '重複候補はありませんでした。\\n（除外済み 2 組を除く）';
  export const sendMaintenanceReport = async (...args) => { state.reports.push(args); };
`)}`;
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.endsWith('/maintenance/weekly-review.ts')) {
      if (['cloudflare:workers', '../../../lib/maintenance-review', '../../../lib/notify'].includes(specifier)) {
        return { url: mockModuleUrl, shortCircuit: true };
      }
      if (specifier === '../_shared' || specifier === '../../../lib/import-runs') {
        return nextResolve(`${specifier}.ts`, context);
      }
    }
    if (specifier === './supabase' && context.parentURL?.endsWith('/lib/import-runs.ts')) {
      return { url: mockModuleUrl, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
const { POST } = await import('../src/pages/api/maintenance/weekly-review.ts');
const { countRecentAcceptedItems } = await import('../src/lib/import-runs.ts');
const { state, env } = await import(mockModuleUrl);
hooks.deregister();

describe('週次DBレビューの採用停止検知', () => {
  for (const { hasRecent, count, warning } of [
    { hasRecent: true, count: 0, warning: 'accepted' },
    { hasRecent: true, count: 3, warning: null },
    { hasRecent: false, count: 0, warning: 'stopped' },
    { hasRecent: false, count: 1, warning: 'stopped' },
  ]) {
    it(`実行記録=${hasRecent}・採用${count}件で件数と適切な警告を通知する`, async (t) => {
      Object.assign(state, { hasRecent, count, error: null, calls: [], reports: [] });
      t.mock.method(Date, 'now', () => Date.parse('2026-09-20T00:00:00.000Z'));

      const response = await POST();
      assert.equal(response.status, 201);
      assert.deepEqual(await response.json(), {
        data: { itemCandidates: 0, sourceCandidates: 0, dismissed: 2, hasRecentImportRun: hasRecent, recentAcceptedItems: count },
      });
      assert.equal(state.reports.length, 1);
      const [sentEnv, title, message] = state.reports[0];
      assert.equal(sentEnv, env);
      assert.equal(title, '週次DBレビュー');
      assert.ok(message.startsWith('重複候補はありませんでした。\n（除外済み 2 組を除く）'));
      assert.equal(message.split('\n').filter((line: string) => line === `直近7日の新規採用 ${count} 件`).length, 1);
      assert.equal(message.includes('新規採用が0件です'), warning === 'accepted');
      assert.equal(message.includes('収集ジョブの実行記録がありません'), warning === 'stopped');
      assert.equal((message.match(/⚠️/g) ?? []).length, warning ? 1 : 0);
      if (warning === 'accepted') {
        assert.match(message, /AIレビューのフィルタ/);
        assert.match(message, /reasoning_effort やプロンプトの変更/);
      }
      // 件数のみの取得と採用条件、および実行記録と同じ7日間の境界を確認する。
      assert.deepEqual(state.calls.filter((call: unknown[]) => call[0] === 'items'), [
        ['items', 'select', '*', { count: 'exact', head: true }],
        ['items', 'eq', 'ai_accepted', true],
        ['items', 'gte', 'created_at', '2026-09-13T00:00:00.000Z'],
      ]);
      assert.deepEqual(state.calls.find((call: unknown[]) => call[0] === 'import_runs' && call[1] === 'gte'),
        ['import_runs', 'gte', 'finished_at', '2026-09-13T00:00:00.000Z']);
    });
  }

  it('件数取得のエラーを採用0件として通知しない', async () => {
    const error = new Error('件数取得失敗');
    Object.assign(state, { error, reports: [] });
    try {
      await assert.rejects(() => countRecentAcceptedItems('2026-09-13T00:00:00.000Z'), error);
      await assert.rejects(() => POST(), error);
      assert.equal(state.reports.length, 0);
    } finally {
      state.error = null;
    }
  });
});
