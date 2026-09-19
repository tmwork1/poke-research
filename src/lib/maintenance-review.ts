// DBの重複候補を検出する読み取り専用の週次レビュージョブ（scripts/db/detect-duplicate-items.mjs・
// detect-duplicate-sources.mjs のロジックを Worker の scheduled ハンドラから呼べるよう移植したもの）。
// DBは一切書き換えない。統合が必要な場合は merge-item.mjs / merge-source.mjs を人手で実行する。
import { getSupabaseClient } from './supabase';

function normalizeUrl(value: string | null | undefined): string | null {
	if (!value) return null;
	try {
		const u = new URL(value);
		const host = u.hostname.replace(/^www\./, '');
		const path = u.pathname.replace(/\/$/, '');
		return `${host}${path}`.toLowerCase();
	} catch {
		return null;
	}
}

function stripSymbols(value: string | null | undefined): string {
	return (value ?? '')
		.toLowerCase()
		.replace(/[\s　]/g, '')
		.replace(/[!-/:-@[-`{-~「」【】（）()。、・！？]/g, '');
}

// maxDist（= isSimilarTitle/isSimilarName の閾値）以内かどうかだけが分かればよいため、
// 対角線から幅maxDistのバンドだけを計算するUkkonenの帯域DPを使う（O(len*maxDist)、
// 通常のO(len^2)のフルDPより大幅に速い）。バンド外のセルは実際の値によらず
// 「maxDistを超えている」ことだけ分かればよいので、番兵値 INF=maxDist+1 として扱う。
// 件数の2乗オーダーで週次レビュー全体から呼ばれ、DP行ごとの配列確保がGC負荷として
// 無視できなかったため、行バッファはモジュールスコープで使い回す（同期実行のため競合しない）。
const LEV_MAX_LEN = 1024;
let levBufA = new Int32Array(LEV_MAX_LEN + 1);
let levBufB = new Int32Array(LEV_MAX_LEN + 1);

function levenshteinWithinBound(s: string[], t: string[], maxDist: number): number {
	const n = s.length;
	const m = t.length;
	const INF = maxDist + 1;
	if (Math.abs(n - m) > maxDist) return INF;
	if (m > LEV_MAX_LEN) {
		levBufA = new Int32Array(m + 1);
		levBufB = new Int32Array(m + 1);
	}

	let prev = levBufA;
	let cur = levBufB;
	prev.fill(INF, 0, m + 1);
	for (let j = 0; j <= Math.min(m, maxDist); j += 1) prev[j] = j;

	for (let i = 1; i <= n; i += 1) {
		cur.fill(INF, 0, m + 1);
		const jLo = Math.max(1, i - maxDist);
		const jHi = Math.min(m, i + maxDist);
		if (i <= maxDist) cur[0] = i;
		for (let j = jLo; j <= jHi; j += 1) {
			const cost = s[i - 1] === t[j - 1] ? 0 : 1;
			cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
		}
		const tmp = prev;
		prev = cur;
		cur = tmp;
	}
	return Math.min(prev[m], INF);
}

// 「Step1/Step2」「第8世代/第9世代」のような連載・バージョン違いを誤検出しないよう、
// 数字列が異なる場合は完全一致以外を別記事として扱う。件数の2乗オーダーで呼ばれるため、
// 比較の都度ではなく一覧作成時に1件あたり1回だけ計算する（digitsOf/charsOf）。
function digitsOf(value: string): string {
	return (value.match(/\d+/g) ?? []).join(',');
}

function charsOf(value: string): string[] {
	return [...value];
}

interface SimilarityInput {
	normalized: string;
	digits: string;
	chars: string[];
}

function isSimilarTitle(a: SimilarityInput, b: SimilarityInput): boolean {
	if (!a.normalized || !b.normalized) return false;
	if (a.normalized === b.normalized) return true;
	if (a.digits !== b.digits) return false;
	const maxLen = Math.max(a.chars.length, b.chars.length);
	if (maxLen < 10) return false;
	const threshold = Math.floor(maxLen * 0.1);
	// レーベンシュタイン距離は少なくとも文字数の差分以上になるため、その時点で
	// 閾値を超えると分かる組は本体のDP計算自体を省略する。
	// 全件O(件数^2)で比較する週次レビューのCPU時間を抑えるための最適化（判定結果は変わらない）。
	if (Math.abs(a.chars.length - b.chars.length) > threshold) return false;
	return levenshteinWithinBound(a.chars, b.chars, threshold) <= threshold;
}

function isSimilarName(a: SimilarityInput, b: SimilarityInput): boolean {
	if (!a.normalized || !b.normalized) return false;
	if (a.normalized === b.normalized) return true;
	const maxLen = Math.max(a.chars.length, b.chars.length);
	if (maxLen < 4) return false;
	const threshold = Math.floor(maxLen * 0.1);
	if (Math.abs(a.chars.length - b.chars.length) > threshold) return false;
	return levenshteinWithinBound(a.chars, b.chars, threshold) <= threshold;
}

export interface DuplicateItemCandidate {
	reason: 'url' | 'title';
	fromId: number;
	fromTitle: string;
	toId: number;
	toTitle: string;
}

export interface DuplicateSourceCandidate {
	reason: 'url' | 'name';
	fromId: number;
	fromName: string;
	fromUrl: string | null;
	toId: number;
	toName: string;
	toUrl: string | null;
}

async function fetchAllRows<T>(
	fetchPage: (offset: number, pageSize: number) => PromiseLike<{ data: T[] | null; error: unknown }>,
): Promise<T[]> {
	// PostgREST の既定上限1000件で途切れないよう、ページングして全行を取得する。
	const pageSize = 1000;
	const rows: T[] = [];
	for (let offset = 0; ; offset += pageSize) {
		const { data, error } = await fetchPage(offset, pageSize);
		if (error) throw error;
		const page = data ?? [];
		rows.push(...page);
		if (page.length < pageSize) return rows;
	}
}

// items は1000件超（2026-08時点）あり、全組をO(件数^2)で総当たりすると
// GitHub Actions移設後のfetchハンドラのCPU時間制限（error 1102、旧scheduledハンドラは
// CPU上限30秒だったため問題化していなかった）を超えてしまうことが本番で判明した。
// URL一致はMapによるグルーピングでO(件数)にし、タイトル類似度は文字数でソートした上で
// 「レーベンシュタイン距離は文字数の差分以上」という性質から導ける探索幅
// （lenB <= lenA / 0.9 の範囲、isSimilarTitleの閾値判定と数学的に同値）に限定して
// 比較件数を絞る（結果はO(件数^2)の総当たりと完全に一致する。単なる高速化）。
export async function detectDuplicateItemCandidates(): Promise<DuplicateItemCandidate[]> {
	const supabase = await getSupabaseClient();
	const items = await fetchAllRows((offset, pageSize) =>
		supabase.from('items').select('id, title, external_url').order('id').range(offset, offset + pageSize - 1),
	);

	const list = (items ?? []).map((item) => {
		const normTitle = stripSymbols(item.title);
		return {
			...item,
			normUrl: normalizeUrl(item.external_url),
			titleSim: { normalized: normTitle, digits: digitsOf(normTitle), chars: charsOf(normTitle) } satisfies SimilarityInput,
		};
	});
	type ListItem = (typeof list)[number];

	const candidates: DuplicateItemCandidate[] = [];
	const pushCandidate = (reason: 'url' | 'title', a: ListItem, b: ListItem) => {
		const [from, to] = a.id < b.id ? [a, b] : [b, a];
		candidates.push({ reason, fromId: from.id, fromTitle: from.title, toId: to.id, toTitle: to.title });
	};

	const urlGroups = new Map<string, ListItem[]>();
	for (const item of list) {
		if (!item.normUrl) continue;
		const group = urlGroups.get(item.normUrl);
		if (group) group.push(item);
		else urlGroups.set(item.normUrl, [item]);
	}
	for (const group of urlGroups.values()) {
		if (group.length < 2) continue;
		for (let i = 0; i < group.length; i += 1) {
			for (let j = i + 1; j < group.length; j += 1) {
				pushCandidate('url', group[i], group[j]);
			}
		}
	}

	const byLength = [...list].sort((x, y) => x.titleSim.chars.length - y.titleSim.chars.length);
	for (let i = 0; i < byLength.length; i += 1) {
		const a = byLength[i];
		const lenA = a.titleSim.chars.length;
		if (lenA === 0) continue;
		for (let j = i + 1; j < byLength.length; j += 1) {
			const b = byLength[j];
			const lenB = b.titleSim.chars.length;
			// ソート済みのためlenBは単調増加。lenB > lenA/0.9 になった時点で、
			// これ以降のjも含め isSimilarTitle の閾値判定を満たし得ないため打ち切る。
			if (lenB > lenA / 0.9) break;
			// URLが一致する組は既にurl理由で追加済みのため、タイトル側の判定はスキップする
			// （urlHitが真ならisSimilarTitleを評価しなかった従来の挙動と同じ）。
			if (a.normUrl && a.normUrl === b.normUrl) continue;
			if (isSimilarTitle(a.titleSim, b.titleSim)) {
				pushCandidate('title', a, b);
			}
		}
	}
	return candidates;
}

export async function detectDuplicateSourceCandidates(): Promise<DuplicateSourceCandidate[]> {
	const supabase = await getSupabaseClient();
	const sources = await fetchAllRows((offset, pageSize) =>
		supabase.from('sources').select('id, name, origin_url').order('id').range(offset, offset + pageSize - 1),
	);

	const list = (sources ?? []).map((source) => {
		const normName = stripSymbols(source.name);
		return {
			...source,
			normUrl: normalizeUrl(source.origin_url),
			nameSim: { normalized: normName, digits: '', chars: charsOf(normName) } satisfies SimilarityInput,
		};
	});

	const candidates: DuplicateSourceCandidate[] = [];
	for (let i = 0; i < list.length; i += 1) {
		for (let j = i + 1; j < list.length; j += 1) {
			const a = list[i];
			const b = list[j];
			const urlHit = Boolean(a.normUrl && b.normUrl && a.normUrl === b.normUrl);
			// urlHit が既に真なら名称の重い類似度計算（Levenshtein）は省略する。
			if (urlHit || isSimilarName(a.nameSim, b.nameSim)) {
				candidates.push({
					reason: urlHit ? 'url' : 'name',
					fromId: a.id,
					fromName: a.name,
					fromUrl: a.origin_url,
					toId: b.id,
					toName: b.name,
					toUrl: b.origin_url,
				});
			}
		}
	}
	return candidates;
}

export interface WeeklyReviewResult {
	itemCandidates: DuplicateItemCandidate[];
	sourceCandidates: DuplicateSourceCandidate[];
}

export async function runWeeklyReview(): Promise<WeeklyReviewResult> {
	const [itemCandidates, sourceCandidates] = await Promise.all([
		detectDuplicateItemCandidates(),
		detectDuplicateSourceCandidates(),
	]);
	return { itemCandidates, sourceCandidates };
}

const MAX_EXAMPLES_PER_SECTION = 5;

export function formatWeeklyReviewMessage(result: WeeklyReviewResult): string {
	const { itemCandidates, sourceCandidates } = result;
	if (itemCandidates.length === 0 && sourceCandidates.length === 0) {
		return '重複候補はありませんでした。';
	}

	const lines: string[] = [];
	if (itemCandidates.length > 0) {
		lines.push(`items 重複候補 ${itemCandidates.length} 組（merge-item.mjs で統合可）:`);
		for (const c of itemCandidates.slice(0, MAX_EXAMPLES_PER_SECTION)) {
			lines.push(`  [${c.reason}] #${c.fromId} "${c.fromTitle}" <-> #${c.toId} "${c.toTitle}"`);
		}
		if (itemCandidates.length > MAX_EXAMPLES_PER_SECTION) {
			lines.push(`  ...ほか ${itemCandidates.length - MAX_EXAMPLES_PER_SECTION} 組`);
		}
	}
	if (sourceCandidates.length > 0) {
		lines.push(`sources 重複候補 ${sourceCandidates.length} 組（merge-source.mjs で統合可）:`);
		for (const c of sourceCandidates.slice(0, MAX_EXAMPLES_PER_SECTION)) {
			lines.push(`  [${c.reason}] #${c.fromId} "${c.fromName}" <-> #${c.toId} "${c.toName}"`);
		}
		if (sourceCandidates.length > MAX_EXAMPLES_PER_SECTION) {
			lines.push(`  ...ほか ${sourceCandidates.length - MAX_EXAMPLES_PER_SECTION} 組`);
		}
	}
	return lines.join('\n');
}
