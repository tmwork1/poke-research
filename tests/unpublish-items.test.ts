import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseTargets, unpublishItems } from '../scripts/db/unpublish-items.mjs';
import { topic } from '../src/config/topic.config.mjs';
import { computePromptHash } from '../src/lib/importers/ai-review-prompt.mjs';

it('対象と必須理由を検証し、JSONLの個別理由を優先する', async () => {
  const options = await parseTargets(['--ids=1,2', '--reason=共通理由']);
  assert.deepEqual(options.targets, [{ id: 1, reason: '共通理由' }, { id: 2, reason: '共通理由' }]);
  for (const args of [['--ids=1'], ['--ids=0', '--reason=x'], ['--ids=1,1', '--reason=x'], ['--ids=1', '--from=x'], ['--ids=1', '--reason=x', '--dry-run=false']]) {
    await assert.rejects(parseTargets(args));
  }
  const dir = await mkdtemp(join(tmpdir(), 'unpublish-test-'));
  try {
    const path = join(dir, 'targets.jsonl');
    await writeFile(path, '1\r\n{"id":2,"reason":"個別理由"}\r\n');
    const parsed = await parseTargets([`--from=${path}`, '--reason=共通理由']);
    assert.deepEqual(parsed.targets, [{ id: 1, reason: '共通理由' }, { id: 2, reason: '個別理由' }]);
    await writeFile(path, '1\n{"id":2,"reason":""}\n');
    await assert.rejects(parseTargets([`--from=${path}`, '--reason=共通理由']));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('dry-runはタイトルと現在の公開状態を表示し、更新しない', async () => {
  const logs: string[] = [];
  const db = { from(table: string) {
    assert.equal(table, 'items');
    return { select(columns: string) {
      assert.equal(columns, 'id, title, ai_accepted');
      return { eq() { return { async single() { return { data: { id: 1, title: '記事', ai_accepted: true }, error: null }; } }; } };
    } };
  } };
  await unpublishItems(db, { targets: [{ id: 1, reason: '確認済み' }], model: 'human-review', dryRun: true }, (line: string) => logs.push(line));
  assert.deepEqual(logs, ['[dry-run] #1: 記事 (ai_accepted=true)']);
});

it('非公開化と再判定記録だけを更新し、欠損・エラー後も続行する', async () => {
  const updates: Record<string, unknown>[] = [];
  const logs: string[] = [];
  const db = { from(table: string) {
    assert.equal(table, 'items');
    return { update(values: Record<string, unknown>) {
      updates.push(values);
      return { eq(column: string, id: number) {
        assert.equal(column, 'id');
        return { select() { return { async single() {
          return id === 1 ? { data: null, error: null } : id === 2 ? { data: null, error: new Error('更新失敗') } : { data: { id }, error: null };
        } }; } };
      } };
    } };
  } };
  const result = await unpublishItems(db, { targets: [1, 2, 3].map((id) => ({ id, reason: '確認済み' })), model: 'human-review', dryRun: false }, (line: string) => logs.push(line));
  assert.deepEqual(result, { succeeded: 1, failed: 2 });
  assert.equal(logs.at(-1), '非公開化1件 / 失敗2件');
  assert.equal(updates.length, 3);
  assert.deepEqual(updates[2], {
    ai_accepted: false, ai_recheck_accepted: false, ai_recheck_model: 'human-review',
    ai_recheck_reason: '確認済み', ai_recheck_prompt_hash: await computePromptHash(topic),
    ai_recheck_confidence: null, ai_rechecked_at: updates[2].ai_rechecked_at,
  });
  assert.ok(Number.isFinite(Date.parse(updates[2].ai_rechecked_at as string)));
});
