// 本番実行前にユーザー確認必須。
// apply-item-review.mjs はレビュー記録・採用記事の公開を担当し、自動で非公開にはしない。
// 本スクリプトは人手で確認した対象を、理由と判定者を記録して明示的に非公開にする。
// 再公開時に作り直す手間を避けるため、summary とタグ（item_tags）は削除・更新しない。
// 使い方:
//   node scripts/db/unpublish-items.mjs --ids=1,2,3 --reason="リンク先が404" --dry-run
//   node scripts/db/unpublish-items.mjs --from=unpublish.jsonl [--reason="共通理由"] [--model=human-review]
// --from は1行1ID、または {"id":123,"reason":"個別理由"} のJSONL。
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { topic } from '../../src/config/topic.config.mjs';
import { computePromptHash } from '../../src/lib/importers/ai-review-prompt.mjs';

export async function parseTargets(argv) {
  const flags = {};
  for (const arg of argv) {
    const match = arg.match(/^--(ids|from|reason|model)=(.*)$/s);
    const name = match?.[1] ?? (arg === '--dry-run' ? 'dry-run' : null);
    if (!name || flags[name] !== undefined) throw new Error(`不正または重複した引数: ${arg}`);
    flags[name] = match ? match[2] : true;
  }
  if ((flags.ids !== undefined) === (flags.from !== undefined)) throw new Error('--ids または --from のどちらか一方を指定してください。');
  const model = flags.model === undefined ? 'human-review' : flags.model.trim();
  if (!model) throw new Error('--model は空にできません。');
  let inputs;
  if (flags.from !== undefined) {
    if (!flags.from.trim()) throw new Error('--from にはファイルのパスを指定してください。');
    const lines = (await readFile(flags.from, 'utf8')).trim().split(/\r?\n/);
    inputs = lines.map((line, index) => {
      try {
        const value = JSON.parse(line);
        return typeof value === 'number' ? { id: value } : value;
      } catch {
        throw new Error(`第${index + 1}行: IDまたはJSONオブジェクトを指定してください。`);
      }
    });
  } else {
    inputs = flags.ids.split(',').map((id) => ({ id: /^\d+$/.test(id.trim()) ? Number(id) : NaN }));
  }
  const seen = new Set();
  // 全対象のIDと理由を事前検証し、不正な入力ではDBに接続しない。
  const targets = inputs.map((input, index) => {
    if (!input || typeof input !== 'object' || Array.isArray(input) || !Number.isSafeInteger(input.id) || input.id <= 0) {
      throw new Error(`対象${index + 1}: IDには正の安全な整数を指定してください。`);
    }
    if (seen.has(input.id)) throw new Error(`IDが重複しています: ${input.id}`);
    seen.add(input.id);
    const rawReason = input.reason === undefined ? flags.reason : input.reason;
    const reason = typeof rawReason === 'string' ? rawReason.trim() : '';
    if (!reason) throw new Error(`#${input.id}: 理由は必須です（--reason またはJSONLのreason）。`);
    return { id: input.id, reason };
  });
  return { targets, model, dryRun: Boolean(flags['dry-run']) };
}

export async function unpublishItems(supabase, { targets, model, dryRun }, log = console.log) {
  const promptHash = dryRun ? null : await computePromptHash(topic);
  let succeeded = 0;
  let failed = 0;
  for (const { id, reason } of targets) {
    try {
      if (dryRun) {
        // 現在のタイトル・公開状態を表示するため、dry-runでもDBの読み取りは必要。
        const { data, error } = await supabase.from('items').select('id, title, ai_accepted').eq('id', id).single();
        if (error) throw error;
        if (!data) throw new Error('対象が見つかりません。');
        log(`[dry-run] #${data.id}: ${data.title} (ai_accepted=${data.ai_accepted})`);
      } else {
        const { data, error } = await supabase.from('items').update({
          ai_accepted: false,
          ai_recheck_accepted: false,
          ai_recheck_model: model,
          ai_recheck_reason: reason,
          ai_recheck_prompt_hash: promptHash,
          ai_recheck_confidence: null,
          ai_rechecked_at: new Date().toISOString(),
        }).eq('id', id).select('id').single();
        if (error) throw error;
        if (!data) throw new Error('対象が見つかりません。');
        log(`#${id}: 非公開化成功（${reason}）`);
      }
      succeeded += 1;
    } catch (error) {
      failed += 1;
      log(`#${id}: 失敗（${error.message ?? String(error)}）`);
    }
  }
  if (!dryRun) log(`非公開化${succeeded}件 / 失敗${failed}件`);
  return { succeeded, failed };
}

async function main() {
  const options = await parseTargets(process.argv.slice(2));
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL / SUPABASE_SECRET_KEY are required.');
  const supabase = createClient(url, key, { detectSessionInUrl: false });
  const { failed } = await unpublishItems(supabase, options);
  if (failed) process.exitCode = 9;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
