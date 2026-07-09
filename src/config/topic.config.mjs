// このハブが扱うトピックの設定を1箇所にまとめたもの。別トピック向けに再配布する場合は
// このファイルを書き換える（加えて package.json/wrangler.jsonc の name、
// public/favicon.svg・og-image.png/svg、README を参照）。
// プレーンな .mjs のため、TypeScript 側（allowJs: true）からも scripts/ 配下の
// Node 単体スクリプトからも同じ値を import できる。

export const topic = {
	site: {
		name: 'PokeResearch',
		// notify のプレフィックスや User-Agent、内部専用ホスト名など、機械可読な識別子に使う。
		slug: 'poke-research',
		// Layout.astro のロゴをこの3つに分けて表示し、accent部分だけ強調色にする。
		logoAccent: { before: 'Poke', accent: 'R', after: 'esearch' },
		description: 'ポケモンに関するプログラミング・開発の技術記事を自動収集する情報ハブ',
		shareText: 'ポケモン×プログラミングの記事をまとめた情報ハブです',
		url: 'https://poke-research.com',
		storageKeyPrefix: 'pokeresearch',
		contactHandle: '@ml7ddw0',
		contactUrl: 'https://x.com/ml7ddw0',
		repoUrl: 'https://github.com/tmwork1/poke-research',
	},

	collection: {
		// AIレビューの system prompt 内で主題名として使う表記。
		label: 'ポケモン',
		// Qiita/note/arXiv/はてなブックマークなどキーワード検索型インポーターが使う検索語彙。
		// Brave Search（blog.ts）は語数に比例して課金対象のAPI呼び出し（job）が増えるため、
		// ここには含めず collection.blogSearchKeywords で別管理する。
		searchKeywords: ['ポケモン', 'ポケカ', 'ポケットモンスター', 'pokemon', 'pokeapi', 'ダメージ計算 実装'],
		// Zenn のトピックタグ絞り込み（日本語不可、英数字のみ）。
		zennTopics: ['pokemon'],
		// Brave Search のブログ収集専用の検索語彙。searchKeywords とは独立して増減できる
		// （Brave は語数だけ課金対象のAPI呼び出しが増えるため、意図的に絞った少数語にする）。
		blogSearchKeywords: ['ポケモン', 'pokemon'],
		// Brave Search のブログ収集で、検索結果を占有しがちな攻略Wiki等トピック固有の除外ドメイン。
		// qiita.com/zenn.dev/note.com/github.com等の汎用的な除外は keywords.ts 側に共通で持つ。
		extraExcludedBlogDomains: ['yakkun.com', 'gamewith.jp', 'appmedia.jp', 'game8.jp', 'altema.jp', 'gamerch.com'],
	},

	aiReview: {
		// ハブが対象とする技術情報の説明（system prompt の冒頭に使う）。
		hubDescription:
			'ポケモンのプログラミング・開発に関する技術情報（ツール、API、データ解析、対戦・育成支援、ROMハック、ファンゲーム開発などの実装や手法を扱う記事）',
		// タグ付けの際、記事が扱うトピック側の対象をこの粒度で表すよう指示する例。
		subGenreExamples: ['カードゲーム', 'ROM改造', '対戦・育成', '図鑑データ'],
		// 記事ではなくツールの提供ページそのものを指す例（accepted=falseにする対象の例示）。
		toolPageExamples: ['ダメージ計算ツール', '育成支援ツール'],
		// タグにすべきでないゲーム内固有名詞（わざ名・ゲームタイトル等）の例。
		properNounExamples: ['ハイドロポンプ', 'ダイヤモンドパール'],
		// 表記揺れ・打ち間違いに注意を促すための正しい表記と間違えやすい表記の例。
		misspellingExample: { correct: 'ポケモンカード', incorrect: 'ポケモンカート' },
		// 手法を伴わない単なる数値・データの引用だけで乱用されがちな分析系タグの例。
		overgeneralizedTagExamples: ['統計学', '確率分布'],
		// 上記の分析系タグが誤って付与されがちな、単なる数値・データの例（手法そのものではない）。
		dataOnlyExamples: ['種族値', '乱数', 'APIから取得したデータ'],
		// 条件(1)の境界判断（比喩として使っているだけ vs 実データ・実仕様を分析対象にしている）を
		// 小型モデルに掴ませるためのfew-shot例。{label} はプロンプト側で主題名に置換される。
		boundaryExamples: [
			{ title: '{label}に学ぶ○○【総目次】', accepted: false, reason: '本文が既存記事へのリンク列挙のみの目次ページ' },
			{
				title: 'Javaのメソッドが分からなかったので{label}のキャラクターで覚えたら理解できた話',
				accepted: false,
				reason: '架空の数値やキャラクター名を暗記の題材にしているだけで、{label}固有の実データ・ルールを分析対象にしていない',
			},
			{ title: '{label}の○○という特性を数理モデルで解析してみた', accepted: true, reason: '{label}の実際の仕様・データを分析対象にした技術記事' },
		],
	},
};
