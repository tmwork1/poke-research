// 複数の収集元（Qiita/Zenn/...）で共通する DB 書き込み・並列実行処理をまとめる。
// ソース固有のフィールドマッピングは各インポーター側に残し、ここでは汎用部分だけを扱う。
import { normalizeTagName } from './article-ai';
import { shouldPreserveAcceptedItem } from './process-import-item';
import { getSupabaseClient } from '../supabase';

// 本文は検索対象を広げるために保存するが、行が肥大化しないよう妥当な長さで切り詰める。
const MAX_STORED_BODY_CHARS = 20000;

export function truncateBodyForStorage(text: string): string {
	return text.length > MAX_STORED_BODY_CHARS ? text.slice(0, MAX_STORED_BODY_CHARS) : text;
}

export function stripHtml(value: string): string {
	// AI への入力や要約生成でノイズになりやすいタグを先に除去する。
	return value
		.replace(/<script[\s\S]*?<\/script>/gi, ' ')
		.replace(/<style[\s\S]*?<\/style>/gi, ' ')
		.replace(/<[^>]+>/g, ' ')
		.replace(/&nbsp;/gi, ' ')
		.replace(/&amp;/gi, '&')
		.replace(/&lt;/gi, '<')
		.replace(/&gt;/gi, '>')
		.replace(/&quot;/gi, '"')
		.replace(/&#39;/gi, "'")
		.replace(/\s+/g, ' ')
		.trim();
}

export async function mapWithConcurrency<T, R>(
	inputs: T[],
	limit: number,
	fn: (input: T) => Promise<R>,
): Promise<R[]> {
	// 記事ごとの OpenAI 呼び出しと DB 書き込みを、限られた同時実行数で並列化する。
	const results: R[] = new Array(inputs.length);
	let cursor = 0;

	async function worker() {
		while (cursor < inputs.length) {
			const index = cursor;
			cursor += 1;
			results[index] = await fn(inputs[index]);
		}
	}

	await Promise.all(Array.from({ length: Math.min(limit, inputs.length) }, worker));
	return results;
}

function levenshteinDistance(a: string, b: string): number {
	// タグ名は短い（高々数十文字）ため、素朴な DP で十分。サロゲートペアを壊さないよう
	// コードポイント単位で比較する。
	const s = [...a];
	const t = [...b];
	if (s.length === 0) return t.length;
	if (t.length === 0) return s.length;

	let previous = Array.from({ length: t.length + 1 }, (_, i) => i);
	for (let i = 1; i <= s.length; i += 1) {
		const current = [i];
		for (let j = 1; j <= t.length; j += 1) {
			const cost = s[i - 1] === t[j - 1] ? 0 : 1;
			current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
		}
		previous = current;
	}
	return previous[t.length];
}

export function findNearDuplicateTag<T extends { name: string }>(tagName: string, existingTags: T[]): T | null {
	// 「ポケモンカート」問題（濁点・半濁点の打ち間違い）対策として、編集距離1の既存タグが
	// あれば新規作成せずそちらへ寄せる。python2/python3 のような正当な近接タグを巻き込まない
	// よう、非ASCII文字（日本語）を含む5文字以上のタグに限定し、差分が数字のみの場合は除外する。
	const chars = [...tagName];
	if (chars.length < 5) return null;
	if (!chars.some((ch) => ch.charCodeAt(0) > 0x7f)) return null;

	for (const existing of existingTags) {
		if (existing.name === tagName) continue;
		if (Math.abs([...existing.name].length - chars.length) > 1) continue;
		if (levenshteinDistance(tagName, existing.name) !== 1) continue;
		// 数字部分だけの違い（例: 第8世代/第9世代、数字の有無）はバージョン・世代違いの
		// 可能性が高いので別タグのまま温存する。
		const hasDigit = /\d/.test(tagName) || /\d/.test(existing.name);
		if (hasDigit && tagName.replace(/\d/g, '') === existing.name.replace(/\d/g, '')) continue;
		return existing;
	}
	return null;
}

async function ensureTags(tagNames: string[], tagLabels: Record<string, string> = {}): Promise<Map<string, number>> {
	// 既存タグを先に引き、足りないタグだけをまとめて作成する。
	const normalizedTagNames = [...new Set(tagNames.map(normalizeTagName).filter((tag) => tag.length > 0))];
	const tagIdMap = new Map<string, number>();
	if (normalizedTagNames.length === 0) return tagIdMap;

	const supabase = await getSupabaseClient();
	const { data: existingTags, error: selectError } = await supabase.from('tags').select('id, name').in('name', normalizedTagNames);
	if (selectError) throw selectError;

	for (const tag of existingTags ?? []) {
		tagIdMap.set(tag.name, tag.id);
	}

	let missingTagNames = normalizedTagNames.filter((tagName) => !tagIdMap.has(tagName));
	if (missingTagNames.length > 0) {
		// 新規作成の前に、綴りが非常に近い既存タグ（誤字の可能性が高い）へ寄せられないか照合する。
		const { data: allTags, error: allTagsError } = await supabase.from('tags').select('id, name');
		if (allTagsError) throw allTagsError;
		missingTagNames = missingTagNames.filter((tagName) => {
			const nearDuplicate = findNearDuplicateTag(tagName, allTags ?? []);
			if (!nearDuplicate) return true;
			tagIdMap.set(tagName, nearDuplicate.id);
			return false;
		});
	}
	if (missingTagNames.length > 0) {
		// 新規タグだけ、AI/収集元がそのまま使った表記を display_name として残す。
		// 大文字小文字の表記決定は追加時点のものを尊重し、以後の取り込みでは上書きしない。
		const { error: insertError } = await supabase
			.from('tags')
			.insert(missingTagNames.map((name) => ({ name, display_name: tagLabels[name] && tagLabels[name] !== name ? tagLabels[name] : null })));
		if (insertError && insertError.code !== '23505') throw insertError;

		const { data: refreshedTags, error: refreshError } = await supabase
			.from('tags')
			.select('id, name')
			.in('name', normalizedTagNames);
		if (refreshError) throw refreshError;

		for (const tag of refreshedTags ?? []) {
			tagIdMap.set(tag.name, tag.id);
		}
	}

	return tagIdMap;
}

export async function syncItemTags(itemId: number, tagNames: string[], tagLabels: Record<string, string> = {}): Promise<void> {
	// 全削除→再作成だと失敗時にタグが失われたまま残るため、差分だけ insert/delete する。
	const normalizedTagNames = [...new Set(tagNames.map(normalizeTagName).filter((tag) => tag.length > 0))];
	const supabase = await getSupabaseClient();

	const tagIdMap = await ensureTags(normalizedTagNames, tagLabels);
	const desiredTagIds = new Set(
		normalizedTagNames
			.map((tagName) => tagIdMap.get(tagName))
			.filter((tagId): tagId is number => typeof tagId === 'number'),
	);

	const { data: existingRelations, error: selectError } = await supabase
		.from('item_tags')
		.select('tag_id')
		.eq('item_id', itemId);
	if (selectError) throw selectError;
	const existingTagIds = new Set((existingRelations ?? []).map((relation) => relation.tag_id));

	const toInsert = [...desiredTagIds]
		.filter((tagId) => !existingTagIds.has(tagId))
		.map((tagId) => ({ item_id: itemId, tag_id: tagId }));
	if (toInsert.length > 0) {
		const { error: insertError } = await supabase.from('item_tags').insert(toInsert);
		if (insertError) throw insertError;
	}

	const toDelete = [...existingTagIds].filter((tagId) => !desiredTagIds.has(tagId));
	if (toDelete.length > 0) {
		const { error: deleteError } = await supabase
			.from('item_tags')
			.delete()
			.eq('item_id', itemId)
			.in('tag_id', toDelete);
		if (deleteError) throw deleteError;
	}
}

export async function fetchTopTagNames(limit = 40): Promise<string[]> {
	// AIレビューがタグを新規発明しがちな問題を減らすため、使用頻度の高い既存タグを
	// 事前に取得し、判定プロンプトへの再利用ヒントとして渡す。
	// 集計は DB 側の RPC（migrations/012 の top_tags）で行う。
	const supabase = await getSupabaseClient();
	const { data, error } = await supabase.rpc('top_tags', { tag_limit: limit });
	if (error) throw error;

	return ((data ?? []) as Array<{ name: string }>).map((row) => row.name);
}

export interface SourceUpsertPayload {
	name: string;
	type: string;
	originUrl: string;
	metadata: Record<string, unknown>;
}

export async function upsertSourceByOriginUrl(payload: SourceUpsertPayload): Promise<{ id: number }> {
	// select してから insert/update する形は同時実行時に重複行を作りうるため、
	// origin_url の UNIQUE 制約(migrations/002)を前提に upsert で原子的に処理する。
	const supabase = await getSupabaseClient();
	const { data, error } = await supabase
		.from('sources')
		.upsert(
			{ name: payload.name, type: payload.type, origin_url: payload.originUrl, metadata: payload.metadata },
			{ onConflict: 'origin_url' },
		)
		.select('id')
		.single();
	if (error) throw error;
	return data as { id: number };
}

export interface ItemUpsertPayload {
	sourceId: number;
	externalUrl: string;
	kind: string;
	title: string;
	authors: string[];
	summary: string;
	publishedAt: string | null;
	updatedAt: string | null;
	metadata: Record<string, unknown>;
	version: string;
	/** 検索対象を広げるための本文テキスト（migrations/015）。未取得なら省略可。 */
	body?: string | null;
	/**
	 * AIレビューでの採否（migrations/018）。false を渡すと一覧・検索からは除外されるが items
	 * には保存され、偽陰性（誤棄却）レビューの対象になる（同一 external_url を後日再収集して
	 * accepted になれば true に戻る）。
	 */
	aiAccepted: boolean;
}

export interface UpsertItemOptions {
	/** 棄却記事はタグ同期をスキップし、tags テーブルをノイズで汚さないようにする（既定 true）。 */
	syncTags?: boolean;
}

export async function upsertItemByExternalUrl(
	payload: ItemUpsertPayload,
	tags: string[],
	tagLabels: Record<string, string> = {},
	options: UpsertItemOptions = {},
): Promise<{ id: number; action: 'inserted' | 'updated' | 'skipped' }> {
	// action の判定は結果表示用の分類に過ぎず、書き込み自体は external_url の
	// UNIQUE 制約(migrations/002)を前提にした upsert で原子的に行う。
	const supabase = await getSupabaseClient();
	const { data: existingItems, error: selectError } = await supabase
		.from('items')
		.select('id, ai_accepted')
		.eq('external_url', payload.externalUrl)
		.limit(1);
	if (selectError) throw selectError;
	const existing = (existingItems?.[0] ?? null) as { id: number; ai_accepted?: boolean } | null;
	const action: 'inserted' | 'updated' = existing ? 'updated' : 'inserted';

	// 一度採用され公開中の記事（既存行 ai_accepted=true）は、収集ジョブの再レビューが棄却に
	// 反転しても格下げしない（retag-existing-items.mjs の「不採用判定は警告のみ」方針と揃える）。
	// 境界記事では判定が揺れうるため、ここで上書きを許すと公開記事が収集のたびに一覧から
	// 見えたり消えたりする。metadata/summary も含め一切書き込まず既存 id を返す
	// （判定ロジックと詳しい理由は process-import-item.ts の shouldPreserveAcceptedItem を参照）。
	if (existing && shouldPreserveAcceptedItem(existing.ai_accepted, payload.aiAccepted)) {
		return { id: existing.id, action: 'skipped' };
	}

	const { data: upserted, error: upsertError } = await supabase
		.from('items')
		.upsert(
			{
				source_id: payload.sourceId,
				external_url: payload.externalUrl,
				kind: payload.kind,
				title: payload.title,
				authors: payload.authors,
				summary: payload.summary,
				published_at: payload.publishedAt,
				updated_at: payload.updatedAt,
				metadata: payload.metadata,
				version: payload.version,
				body: payload.body ?? null,
				ai_accepted: payload.aiAccepted,
			},
			{ onConflict: 'external_url' },
		)
		.select('id')
		.single();
	if (upsertError) throw upsertError;

	const itemId = (upserted as { id: number }).id;
	if (options.syncTags ?? true) {
		await syncItemTags(itemId, tags, tagLabels);
	}
	return { id: itemId, action };
}

export async function findExistingExternalUrls(externalUrls: string[]): Promise<Set<string>> {
	// Qiita などソート順が保証されない検索APIで、設定ページ数の最後のページが全て
	// 既知記事かどうかを判定するために使う（新着記事が後続ページに埋もれていないかの目安）。
	if (externalUrls.length === 0) return new Set();
	const supabase = await getSupabaseClient();
	const { data, error } = await supabase.from('items').select('external_url').in('external_url', externalUrls);
	if (error) throw error;
	return new Set((data ?? []).map((row) => row.external_url as string));
}

export async function findItemVersionByExternalUrl(externalUrl: string): Promise<string | null> {
	// Brave Search 経由のブログ収集は fetch/AIレビューのコストが他インポーターより重いため、
	// 本文ハッシュ(version)が前回と同じなら再レビューを省略する差分検知に使う。
	const supabase = await getSupabaseClient();
	const { data, error } = await supabase.from('items').select('version').eq('external_url', externalUrl).limit(1);
	if (error) throw error;
	return data?.[0]?.version ?? null;
}

// processImportItem・shouldPreserveAcceptedItem は getSupabaseClient/OpenAI 呼び出しに依存しない
// 純粋な関数のため、node --test から直接テストできるよう process-import-item.ts に切り出して
// ある（cloudflare:workers 依存が無いファイルに分離することで import 時点で落ちないようにする
// 目的。catalog-normalize.ts と同じ方針）。ここでは既存の import 元（qiita/zenn/note/blog.ts）を
// 変えずに済むよう re-export するだけにする。
export { processImportItem, shouldPreserveAcceptedItem, type ImportItemOutcome } from './process-import-item';
