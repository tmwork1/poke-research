// 検索キーワードのハイライト表示用に、テキストを一致部分と非一致部分へ分割する。
// HTML 文字列を組み立てずセグメント配列を返し、描画側（Astro）でエスケープ済みのまま
// <mark> に包めるようにする（XSS を構造的に避ける）。

export interface HighlightSegment {
	text: string;
	hit: boolean;
}

export function splitForHighlight(text: string, tokens: string[]): HighlightSegment[] {
	const cleanTokens = [...new Set(tokens.map((token) => token.trim().toLowerCase()).filter((token) => token.length > 0))];
	if (!text || cleanTokens.length === 0) {
		return [{ text, hit: false }];
	}

	const lower = text.toLowerCase();
	const segments: HighlightSegment[] = [];
	let cursor = 0;

	while (cursor < text.length) {
		// 現在位置以降で最初に現れるトークンを探す（重なりは先勝ち）。
		let bestIndex = -1;
		let bestLength = 0;
		for (const token of cleanTokens) {
			const index = lower.indexOf(token, cursor);
			if (index === -1) continue;
			if (bestIndex === -1 || index < bestIndex || (index === bestIndex && token.length > bestLength)) {
				bestIndex = index;
				bestLength = token.length;
			}
		}
		if (bestIndex === -1) {
			segments.push({ text: text.slice(cursor), hit: false });
			break;
		}
		if (bestIndex > cursor) {
			segments.push({ text: text.slice(cursor, bestIndex), hit: false });
		}
		segments.push({ text: text.slice(bestIndex, bestIndex + bestLength), hit: true });
		cursor = bestIndex + bestLength;
	}

	return segments;
}

export function tokenizeQuery(q?: string | null): string[] {
	return (q ?? '').split(/\s+/).filter((token) => token.length > 0);
}
