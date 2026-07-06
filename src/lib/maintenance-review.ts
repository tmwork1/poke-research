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

function levenshtein(a: string, b: string): number {
	const s = [...a];
	const t = [...b];
	if (!s.length) return t.length;
	if (!t.length) return s.length;
	let prev = Array.from({ length: t.length + 1 }, (_, i) => i);
	for (let i = 1; i <= s.length; i += 1) {
		const cur = [i];
		for (let j = 1; j <= t.length; j += 1) {
			cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (s[i - 1] === t[j - 1] ? 0 : 1));
		}
		prev = cur;
	}
	return prev[t.length];
}

function isSimilarTitle(a: string, b: string): boolean {
	if (!a || !b) return false;
	if (a === b) return true;
	// 「Step1/Step2」「第8世代/第9世代」のような連載・バージョン違いを誤検出しないよう、
	// 数字列が異なる場合は完全一致以外を別記事として扱う。
	const digitsA = (a.match(/\d+/g) ?? []).join(',');
	const digitsB = (b.match(/\d+/g) ?? []).join(',');
	if (digitsA !== digitsB) return false;
	const maxLen = Math.max([...a].length, [...b].length);
	if (maxLen < 10) return false;
	return levenshtein(a, b) <= Math.floor(maxLen * 0.1);
}

function isSimilarName(a: string, b: string): boolean {
	if (!a || !b) return false;
	if (a === b) return true;
	const maxLen = Math.max([...a].length, [...b].length);
	if (maxLen < 4) return false;
	return levenshtein(a, b) <= Math.floor(maxLen * 0.1);
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

export async function detectDuplicateItemCandidates(): Promise<DuplicateItemCandidate[]> {
	const supabase = await getSupabaseClient();
	const { data: items, error } = await supabase.from('items').select('id, title, external_url').order('id');
	if (error) throw error;

	const list = (items ?? []).map((item) => ({
		...item,
		normUrl: normalizeUrl(item.external_url),
		normTitle: stripSymbols(item.title),
	}));

	const candidates: DuplicateItemCandidate[] = [];
	for (let i = 0; i < list.length; i += 1) {
		for (let j = i + 1; j < list.length; j += 1) {
			const a = list[i];
			const b = list[j];
			const urlHit = Boolean(a.normUrl && b.normUrl && a.normUrl === b.normUrl);
			const titleHit = isSimilarTitle(a.normTitle, b.normTitle);
			if (urlHit || titleHit) {
				candidates.push({
					reason: urlHit ? 'url' : 'title',
					fromId: a.id,
					fromTitle: a.title,
					toId: b.id,
					toTitle: b.title,
				});
			}
		}
	}
	return candidates;
}

export async function detectDuplicateSourceCandidates(): Promise<DuplicateSourceCandidate[]> {
	const supabase = await getSupabaseClient();
	const { data: sources, error } = await supabase.from('sources').select('id, name, origin_url').order('id');
	if (error) throw error;

	const list = (sources ?? []).map((source) => ({
		...source,
		normUrl: normalizeUrl(source.origin_url),
		normName: stripSymbols(source.name),
	}));

	const candidates: DuplicateSourceCandidate[] = [];
	for (let i = 0; i < list.length; i += 1) {
		for (let j = i + 1; j < list.length; j += 1) {
			const a = list[i];
			const b = list[j];
			const urlHit = Boolean(a.normUrl && b.normUrl && a.normUrl === b.normUrl);
			const nameHit = isSimilarName(a.normName, b.normName);
			if (urlHit || nameHit) {
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
