// クエリパラメータ・リクエスト値としての正の整数パースを共通化する。
// API ルートと Astro ページの両方から使う。

export function parsePositiveInteger(value: string | number | null | undefined, fallback: number): number {
	const parsed = typeof value === 'number' ? value : Number(value ?? NaN);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function parseOptionalPositiveInteger(value: string | number | null | undefined): number | undefined {
	if (value === null || value === undefined || value === '') return undefined;
	const parsed = typeof value === 'number' ? value : Number(value);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}
