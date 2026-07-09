// 複数の収集元（Qiita/Zenn/...）で共通する DB 書き込み・並列実行処理をまとめる。
// ソース固有のフィールドマッピングは各インポーター側に残し、ここでは汎用部分だけを扱う。
import { normalizeTagName } from './article-ai';
import { buildAiRecheckColumns, buildAiReviewColumns, shouldPreserveAcceptedItem } from './process-import-item';
import { getSupabaseClient } from '../supabase';
import { normalizeSource, type ItemRow } from '../catalog-normalize';

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

export interface ItemTagSyncEntry {
	itemId: number;
	tags: string[];
	tagLabels?: Record<string, string>;
}

/**
 * cronジョブ向けのバッチタグ同期。ジョブ内で新規挿入されたばかりの記事（＝item_tagsに既存行が
 * 無いことが前提）をまとめて渡すことで、ensureTags（タグ解決）を記事N件でも1回に、item_tagsの
 * insertも1回にまとめる（syncItemTagsのように既存行との差分削除は行わない。既存記事は
 * findExistingExternalUrls等で呼び出し前にスキップされているため、ここに来るのは常に新規行）。
 */
export async function syncNewItemTagsBatch(entries: ItemTagSyncEntry[]): Promise<void> {
	const targets = entries.filter((entry) => entry.tags.length > 0);
	if (targets.length === 0) return;

	const mergedTagLabels: Record<string, string> = {};
	for (const entry of targets) {
		if (entry.tagLabels) Object.assign(mergedTagLabels, entry.tagLabels);
	}
	const tagIdMap = await ensureTags(
		targets.flatMap((entry) => entry.tags),
		mergedTagLabels,
	);

	const rows: Array<{ item_id: number; tag_id: number }> = [];
	for (const entry of targets) {
		const normalizedTagNames = [...new Set(entry.tags.map(normalizeTagName).filter((tagName) => tagName.length > 0))];
		for (const tagName of normalizedTagNames) {
			const tagId = tagIdMap.get(tagName);
			if (tagId !== undefined) rows.push({ item_id: entry.itemId, tag_id: tagId });
		}
	}
	if (rows.length === 0) return;

	const supabase = await getSupabaseClient();
	const { error } = await supabase.from('item_tags').insert(rows);
	if (error && error.code !== '23505') throw error;
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
	/**
	 * 実際にこの記事を取り込んだ収集ジョブ（migrations/024）。sources.type はプラットフォーム単位
	 * （blog/hatena/feedはいずれも'blog'）でしか区別できないため、事後解析（例:
	 * 「本来Qiitaジョブで見つかるべき記事がBrave Search経由でしか見つかっていない」といった
	 * 収集精度の傾向分析）向けに、実際の発見経路を専用列として持つ。値は各インポーターの
	 * metadata.provenance.source と揃える（'qiita-importer'/'zenn-importer'/'arxiv-importer'/
	 * 'note-importer'/'brave-search-importer'/'hatena-bookmark-importer'/'feed-importer'）。
	 */
	collectionRoute: string;
	/** 検索対象を広げるための本文テキスト（migrations/015）。未取得なら省略可。 */
	body?: string | null;
	/** AIが判定した記事本文の主な言語（ISO 639-1の小文字コード。migrations/021）。 */
	language: string | null;
	/**
	 * AIレビューでの採否（migrations/018）。false を渡すと一覧・検索からは除外されるが items
	 * には保存され、偽陰性（誤棄却）レビューの対象になる（同一 external_url を後日再収集して
	 * accepted になれば true に戻る）。
	 */
	aiAccepted: boolean;
	/**
	 * 直近の再チェックの条件・結果（migrations/025）。ai_accepted とは別に常に上書きされる列に書く
	 * （shouldPreserveAcceptedItem で ai_accepted 自体の更新が握りつぶされた場合も対象）。
	 */
	aiRecheckModel: string;
	aiRecheckPromptVersion: string;
	aiRecheckReason: string;
	aiRecheckConfidence: number | null;
}

export interface UpsertItemOptions {
	/** 棄却記事はタグ同期をスキップし、tags テーブルをノイズで汚さないようにする（既定 true）。 */
	syncTags?: boolean;
	/**
	 * 呼び出し側が事前に findExistingExternalUrls 等で external_url の非存在を確認済みの場合、
	 * ここでの既存行チェック（select）を省略して1 subrequest 減らす（Qiita/Zenn/arXivは
	 * 既存候補を呼び出し前にスキップしているため、ここに到達するのは常に新規行）。
	 * 既存有無が保証できない呼び出し元（blog/hatena/feedは正規化後のURLが事前チェック時と
	 * 異なりうる）では既定の false のままにする。
	 */
	assumeNew?: boolean;
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
	let action: 'inserted' | 'updated' = 'inserted';
	const recheckedAtIso = new Date().toISOString();
	const aiRecheckColumns = buildAiRecheckColumns(
		{
			accepted: payload.aiAccepted,
			model: payload.aiRecheckModel,
			promptVersion: payload.aiRecheckPromptVersion,
			reason: payload.aiRecheckReason,
			confidence: payload.aiRecheckConfidence,
		},
		recheckedAtIso,
	);

	if (!options.assumeNew) {
		const { data: existingItems, error: selectError } = await supabase
			.from('items')
			.select('id, ai_accepted')
			.eq('external_url', payload.externalUrl)
			.limit(1);
		if (selectError) throw selectError;
		const existing = (existingItems?.[0] ?? null) as { id: number; ai_accepted?: boolean } | null;
		action = existing ? 'updated' : 'inserted';

		// 一度採用され公開中の記事（既存行 ai_accepted=true）は、収集ジョブの再レビューが棄却に
		// 反転しても格下げしない（retag-existing-items.mjs の「不採用判定は警告のみ」方針と揃える）。
		// 境界記事では判定が揺れうるため、ここで上書きを許すと公開記事が収集のたびに一覧から
		// 見えたり消えたりする。ai_accepted/metadata/summary は一切書き込まないが、再チェック列
		// （ai_recheck_*、migrations/025）だけは常に上書きする。これにより「ai_accepted=true
		// のまま古いプロンプト基準の判定が凍結されている」をSQLで検出できるようにする
		// （判定ロジックと詳しい理由は process-import-item.ts の shouldPreserveAcceptedItem を参照）。
		if (existing && shouldPreserveAcceptedItem(existing.ai_accepted, payload.aiAccepted)) {
			const { error: recheckUpdateError } = await supabase.from('items').update(aiRecheckColumns).eq('id', existing.id);
			if (recheckUpdateError) throw recheckUpdateError;
			return { id: existing.id, action: 'skipped' };
		}
	}

	// ai_review_*（migrations/025）は、ai_accepted/summary/metadata が実際に書き込まれるこの
	// upsert 経路でのみ更新する（preserve-skip 分岐では更新しない）。これにより「今公開されている
	// 内容を生んだ判定」を ai_recheck_*（常に最新）と同じフラット列同士でSQL比較できるようにする
	// （process-import-item.ts の buildAiReviewColumns 参照）。
	const aiReviewColumns = buildAiReviewColumns(
		{
			model: payload.aiRecheckModel,
			promptVersion: payload.aiRecheckPromptVersion,
			reason: payload.aiRecheckReason,
			confidence: payload.aiRecheckConfidence,
		},
		recheckedAtIso,
	);

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
				collection_route: payload.collectionRoute,
				body: payload.body ?? null,
				ai_accepted: payload.aiAccepted,
				language: payload.language,
				...aiRecheckColumns,
				...aiReviewColumns,
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
	// 候補記事のURLをまとめて1回のクエリで問い合わせ、既に収集済みのものはAIレビュー・DB書き込みを
	// 行わずスキップする（cronのsubrequest数・OpenAI課金を抑える）差分検知に各インポーターが使う。
	// 記事内容の変更は追跡しない方針のため、判定は「既存かどうか」のみで version 比較は行わない。
	// Qiita などソート順が保証されない検索APIでは、設定ページ数の最後のページが全て既知記事かどうかの
	// 判定（新着記事が後続ページに埋もれていないかの目安）にも使う。
	if (externalUrls.length === 0) return new Set();
	const supabase = await getSupabaseClient();
	const { data, error } = await supabase.from('items').select('external_url').in('external_url', externalUrls);
	if (error) throw error;
	return new Set((data ?? []).map((row) => row.external_url as string));
}

export interface DailyDigestItemRow {
	title: string;
	externalUrl: string;
	collectionRoute: string;
	sourceName: string | null;
	kind: string;
}

// 日次収集ジョブが複数のWorker呼び出し（時間分割スロット）に分かれたため、まとめ通知は
// メモリ上の結果を受け渡せない。代わりにこの関数で、指定時刻以降に作成された対象ジョブの
// itemsをDBから直接集計する（src/worker.ts の日次まとめ通知専用cronが呼ぶ）。
// AIレビューで棄却された記事（ai_accepted=false、偽陰性対策で保存はされる）は通知対象外にする。
export async function fetchDailyDigestItems(sinceIso: string, collectionRoutes: string[]): Promise<DailyDigestItemRow[]> {
	if (collectionRoutes.length === 0) return [];
	const supabase = await getSupabaseClient();
	const { data, error } = await supabase
		.from('items')
		.select('title, external_url, collection_route, kind, source:sources(id, name, type, origin_url)')
		.gte('created_at', sinceIso)
		.in('collection_route', collectionRoutes)
		.eq('ai_accepted', true);
	if (error) throw error;
	return (data ?? []).map((row) => {
		const source = normalizeSource((row as Pick<ItemRow, 'source'>).source);
		return {
			title: row.title as string,
			externalUrl: row.external_url as string,
			collectionRoute: row.collection_route as string,
			sourceName: source?.name ?? null,
			kind: row.kind as string,
		};
	});
}

export interface FeedSubscriptionUpsertPayload {
	feedUrl: string;
	hostname: string;
	discoveredFromUrl: string;
}

export async function upsertFeedSubscription(payload: FeedSubscriptionUpsertPayload): Promise<void> {
	// 無効化済み（status='disabled'）のフィードを再発見のたびに誤って再有効化しないよう、
	// 既存行があれば何もしない（ignoreDuplicates）。未登録の場合のみ active で新規作成する。
	const supabase = await getSupabaseClient();
	const { error } = await supabase
		.from('feed_subscriptions')
		.upsert(
			{ feed_url: payload.feedUrl, hostname: payload.hostname, discovered_from_url: payload.discoveredFromUrl },
			{ onConflict: 'feed_url', ignoreDuplicates: true },
		);
	if (error) throw error;
}

export interface FeedSubscription {
	id: number;
	feedUrl: string;
	hostname: string;
}

export async function fetchActiveFeedSubscriptions(): Promise<FeedSubscription[]> {
	const supabase = await getSupabaseClient();
	const { data, error } = await supabase.from('feed_subscriptions').select('id, feed_url, hostname').eq('status', 'active');
	if (error) throw error;
	return (data ?? []).map((row) => ({
		id: row.id as number,
		feedUrl: row.feed_url as string,
		hostname: row.hostname as string,
	}));
}

const MAX_CONSECUTIVE_FEED_FAILURES = 5;

export async function recordFeedFetchOutcome(id: number, success: boolean): Promise<void> {
	// 連続失敗が既定回数に達したフィードは status='disabled' にして、死んだフィードへの
	// 無駄なポーリングを止める（再有効化する運用コマンドは今回は用意しない）。
	const supabase = await getSupabaseClient();
	const nowIso = new Date().toISOString();

	if (success) {
		const { error } = await supabase
			.from('feed_subscriptions')
			.update({ consecutive_failures: 0, last_fetched_at: nowIso })
			.eq('id', id);
		if (error) throw error;
		return;
	}

	const { data, error: selectError } = await supabase
		.from('feed_subscriptions')
		.select('consecutive_failures')
		.eq('id', id)
		.single();
	if (selectError) throw selectError;

	const consecutiveFailures = ((data as { consecutive_failures: number }).consecutive_failures ?? 0) + 1;
	const status = consecutiveFailures >= MAX_CONSECUTIVE_FEED_FAILURES ? 'disabled' : 'active';

	const { error: updateError } = await supabase
		.from('feed_subscriptions')
		.update({ consecutive_failures: consecutiveFailures, last_fetched_at: nowIso, status })
		.eq('id', id);
	if (updateError) throw updateError;
}

// processImportItem・shouldPreserveAcceptedItem は getSupabaseClient/OpenAI 呼び出しに依存しない
// 純粋な関数のため、node --test から直接テストできるよう process-import-item.ts に切り出して
// ある（cloudflare:workers 依存が無いファイルに分離することで import 時点で落ちないようにする
// 目的。catalog-normalize.ts と同じ方針）。ここでは既存の import 元（qiita/zenn/note/blog.ts）を
// 変えずに済むよう re-export するだけにする。
export { processImportItem, shouldPreserveAcceptedItem, type ImportItemOutcome } from './process-import-item';
