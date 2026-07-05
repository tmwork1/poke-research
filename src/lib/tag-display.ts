// tags.name はタグの重複排除のためNFKD正規化・小文字統一して保存している（[[../importers/article-ai.ts]] の normalizeTagName）。
// そのため画面にそのまま出すと "github actions" のように読みにくくなる。ここでは保存値はそのままに、
// 表示用のラベルだけ既知語の公式表記（大文字小文字・略語）へ変換する。

const KNOWN_LABELS: Record<string, string> = {
	// タグ全体で一致するもの（英語+日本語の複合語など、単語分割では復元できない表記）
	'romハック': 'ROMハック',
	'aiエージェント': 'AIエージェント',
	'ローカルllm': 'ローカルLLM',

	// 単語単位で一致するもの
	ai: 'AI',
	api: 'API',
	llm: 'LLM',
	rom: 'ROM',
	css: 'CSS',
	html: 'HTML',
	json: 'JSON',
	sql: 'SQL',
	ui: 'UI',
	ux: 'UX',
	cli: 'CLI',
	npm: 'npm',
	pypi: 'PyPI',
	dotfiles: 'dotfiles',
	python: 'Python',
	typescript: 'TypeScript',
	javascript: 'JavaScript',
	react: 'React',
	vue: 'Vue',
	docker: 'Docker',
	java: 'Java',
	github: 'GitHub',
	gitlab: 'GitLab',
	actions: 'Actions',
	claude: 'Claude',
	codex: 'Codex',
	prolog: 'Prolog',
	terminal: 'Terminal',
	discord: 'Discord',
	unity: 'Unity',
	pokeapi: 'PokeAPI',
	openai: 'OpenAI',
};

const ASCII_WORD = /^[a-z0-9][a-z0-9.+#-]*$/i;

function formatWord(word: string): string {
	const known = KNOWN_LABELS[word.toLowerCase()];
	if (known) return known;
	if (ASCII_WORD.test(word)) return word.charAt(0).toUpperCase() + word.slice(1);
	return word;
}

export function formatTagLabel(name: string): string {
	const trimmed = name.trim();
	const wholeMatch = KNOWN_LABELS[trimmed.toLowerCase()];
	if (wholeMatch) return wholeMatch;

	return trimmed
		.split(/([ _]+)/)
		.map((part) => (/^[ _]+$/.test(part) ? ' ' : formatWord(part)))
		.join('');
}
