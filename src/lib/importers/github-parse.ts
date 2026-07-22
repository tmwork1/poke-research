// GitHub Search API（GET /search/repositories）のレスポンス（repository object）から、
// DB保存・重複判定に必要な情報を取り出す純粋関数群。openalex-parse.ts と同じ方針で、
// cloudflare:workers に依存しないため tests/github-parse.test.ts で直接ユニットテストできる。

export interface GithubRepository {
	id: number;
	name: string;
	full_name: string;
	html_url: string;
	description?: string | null;
	fork: boolean;
	stargazers_count: number;
	forks_count: number;
	language?: string | null;
	topics?: string[];
	owner?: { login?: string | null } | null;
	created_at?: string | null;
	updated_at?: string | null;
	pushed_at?: string | null;
	archived?: boolean;
}

export function resolveTitle(repo: Pick<GithubRepository, 'full_name'>): string {
	return repo.full_name ?? '';
}

// items.external_url として使うURL。リポジトリのトップページURLはGitHub上で一意なため、
// items.external_url の UNIQUE 制約（migrations/002）とも自然に整合する。
export function selectExternalUrl(repo: Pick<GithubRepository, 'html_url'>): string {
	return repo.html_url;
}

export function extractOwnerLogin(repo: Pick<GithubRepository, 'owner'>): string[] {
	const login = repo.owner?.login;
	return login ? [login] : [];
}

// GitHub Search API の /search/repositories は、実機検証の結果 in:readme 修飾子を含めると
// クエリ自体が壊れ（意図した絞り込みが働かず人気リポジトリ全般がヒットする）ことを確認したため
// 使わない。in: 修飾子を省略した場合、デフォルトでリポジトリ名・説明文・トピックスが
// 検索対象になる（READMEの全文検索はできないが、収集後に別途READMEを取得しAIレビューの
// 入力に使うため、発見段階での取りこぼしとして許容する）。
// フォークは stars/forks が本家に集中し重複ノイズになりやすいため、fork:false で検索時点から除外する。
export function buildGithubSearchQuery(keywords: string[]): string {
	const terms = keywords.map((keyword) => keyword.trim()).filter((keyword) => keyword.length > 0);
	if (terms.length === 0) return 'fork:false';
	// 複数キーワードのOR結合構文（括弧+OR）は実機未検証（現状キーワードは1語のみのため発生しない）。
	// 将来キーワードが増えた場合は、hatena.ts と同じ「キーワードごとに個別fetch→マージ」方式への
	// フォールバックを検討する（docs/plan/repo.md 参照）。
	const keywordExpr = terms.length > 1 ? `(${terms.join(' OR ')})` : terms[0];
	return `${keywordExpr} fork:false`;
}
