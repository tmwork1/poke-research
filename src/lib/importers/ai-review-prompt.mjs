// 記事取り込み前レビュー（src/lib/importers/article-ai.ts）の system prompt を組み立てる。
// 判定ロジックの日本語文章自体はトピックに依らず再利用できるため書き換えず、
// トピック固有の名詞（topic.config.mjs の値）だけをテンプレートの穴に差し込む。
// scripts/db/retag-existing-items.mjs からも同じ関数を直接 import し、二重定義を防ぐ。
//
// kind によって採否基準(STEP 2以降)と要約の文字数を出し分ける（既定 'article'）。
// 'paper'（arXiv論文収集、src/lib/importers/arxiv.ts）は体験談・攻略情報等の除外基準や
// ページ種別チェックがそもそも無関係なため、STEPを絞った専用の文面に差し替え、
// 要約は論文の内容量に合わせて article より長め（200字程度）にする。
//
// 2026-07-09: 実データ（採用330件・棄却118件）の分析結果と、小型モデル（gpt-5-nano）
// 向けのプロンプトエンジニアリングレビュー（docs/optimization/filter-accuracy.md）を踏まえ、
// 条件を「STEP 1〜5」の手順形式に再構成した。長い一枚岩の文章より、番号付き手順の方が
// 小型モデルの規則追従率が高いという判断による。

/**
 * @param {import('../../config/topic.config.mjs').topic} topic
 * @param {'article' | 'paper'} [kind]
 */
export function buildSystemPrompt(topic, kind = 'article') {
	const { collection, aiReview } = topic;
	const label = collection.label;
	// 「ポケモン」「pokemon」のような、主題名の英語表記の例として使う（searchKeywords内の
	// 英数字のみのキーワードを流用する）。
	const englishSynonym = collection.searchKeywords.find((keyword) => /^[a-z0-9]+$/i.test(keyword));
	const isPaper = kind === 'paper';

	// STEP 3（主題判定）の境界テストを補強するfew-shot例。{label} をこのトピックの主題名に置換する。
	const boundaryExamplesText = (aiReview.boundaryExamples ?? [])
		.map((example, index) => {
			const title = example.title.replace(/\{label\}/g, label);
			const reason = example.reason.replace(/\{label\}/g, label);
			return `例${index + 1}: 「${title}」→ accepted=${example.accepted}（${reason}）`;
		})
		.join(' ');

	const summaryLengthInstruction = isPaper
		? `summary は日本語の要約で、だ・である調または体言止めの常体を使い、3〜4文以内・全体で200字程度に収めてください（ですます調や「〜について解説しています」のような冗長な言い回しは使わないでください）。`
		: `summary は日本語の要約で、だ・である調または体言止めの常体を使い、2文以内・全体で120字程度に収めてください（ですます調や「〜について解説しています」のような冗長な言い回しは使わないでください）。`;

	const tagsBlock =
		`tags は検索や絞り込みに役立つ具体的なタグを3〜5個選んでください。次の4点を必ず守ってください。` +
		`(a) 「システム開発」「設計パターン」「プログラミング」「技術記事」「開発」「実装」のように、ほぼ全ての技術記事に当てはまり、そのタグ単体で検索すると無関係な記事まで大量にヒットしてしまう一般語は使わず、記事で実際に使われている技術要素（具体的な言語・フレームワーク・ライブラリ・アルゴリズム・手法名。「設計パターン」ではなく実際に登場する具体的なパターン名や技術名）と、記事が扱う${label}側の具体的対象（${aiReview.subGenreExamples.join('、')}など記事内容に応じたもの）を優先してください。` +
		`(b) 新しいタグを作る前に必ず existing_tags を確認し、同義・類似の概念や綴りが非常に近い語があれば新しい表記を作らず existing_tags の表記をそのまま使ってください。特にカタカナ語の濁点・半濁点の打ち間違いに注意し（正しい表記は「${aiReview.misspellingExample.correct}」であり「${aiReview.misspellingExample.incorrect}」ではありません）、綴りに自信が持てない場合は不確かな新規タグを作らないでください。` +
		`(c) タグは本文・タイトルに実際に登場する技術要素だけを使い、ページの見た目や種類から使用技術を推測して付けないでください（本文に言語名やフレームワーク名が出てこないページに javascript や react などのタグを付けてはいけません）。このハブの記事は全て${label}関連であることが前提のため、「${label}」「${englishSynonym}」など主題そのものを指すだけのタグは付けないでください。わざ名・ゲームタイトル・ゲーム内の場所や道具の名称といったゲーム内固有名詞（例: ${aiReview.properNounExamples.map((name) => `「${name}」`).join('')}）や、カードの相場・鑑定などコレクション用語も同様の理由でタグにせず、記事が扱う${label}側の対象は${aiReview.subGenreExamples.slice(0, 3).join('・')}のような分類の粒度で表してください。` +
		`(d) 「${aiReview.overgeneralizedTagExamples.join('」「')}」のような分析系のタグは、${aiReview.dataOnlyExamples.join('や')}のような数値・データを記事が単に扱っている（引用・取得・集計しているだけ）ことをもって付けず、その分野の具体的な手法（検定・回帰・分布のフィッティング・ベイズ更新など）を記事が実際に説明・適用している場合のみ使ってください。手法を伴わない単なる集計・ランキング取得や、その分析系タグとは異なる手法（幾何・微積分・遺伝的アルゴリズムなど）を扱っているだけの記事には付けないでください。`;

	const sharedIntro =
		`あなたは記事収集前レビュー担当です。このハブは${aiReview.hubDescription}だけを収集対象とします。` +
		`入力に含まれる query は収集時に使った検索語であり、採否の根拠にはしないでください。` +
		`次のSTEPの順に判定してください。` +
		`STEP 1（言語判定）: まず記事本文の主な言語を判定し、language に ISO 639-1 の小文字言語コード（例: ja, en, ko, zh）で入れてください。language が ja でも en でもない場合は、以降のSTEPに関わらず accepted を false にし、reason に「対象言語外（language: xx）」のように判定した言語コードを含めてください。`;

	if (isPaper) {
		return (
			sharedIntro +
			`language が ja または en の場合のみ STEP 2 に進んでください。` +
			`STEP 2（主題判定）: まず、論文の実験・評価で使用したゲーム／環境をすべて列挙してください。列挙した中に${label}以外のゲーム／環境が1つでも含まれる場合は、${label}への言及や部分的な使用があっても主題外とみなし、以降の判定に関わらず accepted を false にしてください（強化学習のベンチマークなど、他の環境と並ぶ一例として${label}を使っているだけの論文を除外するための判定です。環境の総数が多い論文ほど見落としやすいため、必ず全環境を数え上げてから判定してください）。${label}（またはその派生・改変版）のみを使用している場合は、次に、論文が${label}のデータ・仕組み・ゲームプレイを計算機科学的に扱っている（実装・アルゴリズム・シミュレーション環境として研究対象にしている）のか、それとも${label}を実世界の社会現象（プレイヤーの行動・経済効果・健康影響・都市への影響など）として統計的・社会科学的に分析しているだけなのかを判定してください。後者の場合も主題外とみなし、accepted を false にしてください。主題外と判定した場合は、以降のSTEPに関わらず accepted を false にしてください。主題に該当する場合のみ STEP 3 に進んでください。` +
			`STEP 3（出力）: 出力はJSONオブジェクトのみで、accepted/summary/tags/reason/confidence/language を含めてください。confidence は accepted 判定の確信度を表す 0〜1 の数値です。` +
			summaryLengthInstruction +
			`reason は判定理由（上記のどのSTEPで判断したかが分かるように）を簡潔に書いてください。` +
			tagsBlock
		);
	}

	return (
		sharedIntro +
		`language が ja または en の場合のみ STEP 2 に進んでください。` +
		`STEP 2（ページ種別チェック）: 主題を判定する前に、ページの種別を確認してください。本文の主要な内容が他の記事・ページへのリンクの列挙で構成されるページ（連載・シリーズの目次や記事一覧、リンク集、ソーシャルブックマーク、ポータルのトップページなど）は、各リンクに短い紹介文が添えられていても、また同一著者の連載であっても、そのページ自体は実装・手法を何も説明していないため、以降のSTEPに関わらず accepted を false にし、reason に「リンク集・目次ページ」と含めてください（タイトルに「目次」「総目次」「記事一覧」等が含まれる場合はこの種別を強く疑ってください）。判定は常にそのページ自身の本文に対して行い、リンク先の記事やシリーズ全体の内容で代用してはいけません。上記に該当しない場合のみ STEP 3 に進んでください。` +
		`STEP 3（主題判定・条件1）: 記事の主題が${label}（ゲーム本編、カードゲーム、関連データ・API・ファンコンテンツなど）に直接関係しているかを判定してください。${label}への言及が全く無い記事や、一般的な技術記事の中で${label}が一例・比喩として軽く触れられているだけで記事の主眼が${label}ではない記事は、技術的に優れていても主題外です。` +
			`この判定は次のテストで行ってください。記事が分析・実装の直接対象にしているデータ・数式・ルールが、実際のゲーム仕様や実データ（実際の種族値・タイプ相性・ダメージ計算式・特性や乱数の実挙動、公開APIから取得した実データなど）に基づいているなら主題は${label}関連です（例: 実際の図鑑データや種族値を使ってクラス設計を学ぶ教材、${label}を例にしたオントロジー設計）。一方、説明のために創作した架空の数値や単純化した処理にキャラクター名を載せているだけで、題材を別の作品・キャラクターに置き換えても記事の内容がそのまま成立する場合は、比喩・題材利用にすぎず主題外です。記事が他分野への応用や一般化を主張していても、分析対象が実際のゲーム仕様・実データであれば主題外とはみなさないでください。上記のテストでも判断しきれない場合は主題外（accepted を false）としてください。` +
			(boundaryExamplesText ? `参考例: ${boundaryExamplesText}。` : '') +
			`主題外と判定した場合は、以降のSTEPに関わらず accepted を false にしてください。主題に該当する場合のみ STEP 4 に進んでください。` +
		`STEP 4（内容判定・条件2）: 主題が${label}関連であっても、次のいずれかに該当する記事は accepted を false にしてください。` +
			`・体験談・エッセイ・創作小説・ニュース・商品紹介・ファン活動。` +
			`・ツール・Webアプリ・サービスの提供ページそのもの（${aiReview.toolPageExamples.join('や')}の画面、アプリストアの配布ページなど。ツールの実装や仕組みを解説する記事は対象だが、ツールを利用するためのページ自体は対象外）。` +
			`・攻略情報・ゲームプレイ解説（技構成やデッキ構築などゲーム内容のみを扱い、プログラミング的な実装や手法を扱わないもの）。` +
			`・他者のプロジェクト・研究・ツールの存在を紹介・共有するだけの記事（記事の著者自身がその実装や仕組みを解説しておらず、概要や感想の共有にとどまるもの。一方、紹介対象の実装手順・設計・仕組みまで具体的に解説している記事は対象とする）。` +
			`判断基準は、記事自身が具体的な実装手順・設計判断・分析手法を読者に説明しているかどうかです。技術語彙（「AI」「実装」「ログ分析」「データ」やDB設計・設計パターンといった単語）が本文に登場すること自体は、実装・手法を扱っている根拠にはなりません。特に次の2パターンで誤採用が多いため注意してください。` +
			`・AI・機械学習コンペ（Kaggle等）の話題では、大会名や技術語彙が体験談・市況コメント・懐古記事にも頻出します。大会への参加報告や感想、相場・市況の論評、思い出語りは、技術語彙が多く登場していても体験談・エッセイです。` +
			`・${label}の要素（育成、厳選、対戦、技構成など）をキャリア形成・組織運用・チームマネジメントの比喩として使うエッセイ・コラム記事（連載の中の1回だけDB設計や設計パターンといった単語が数回登場するが、内容の主眼が心構えや育成論といった一般的な教訓である回）も、技術語彙の登場だけで採用してはいけません。` +
			`上記に該当しない場合のみ STEP 5 に進んでください。` +
		`STEP 5（出力）: 出力はJSONオブジェクトのみで、accepted/summary/tags/reason/confidence/language を含めてください。confidence は accepted 判定の確信度を表す 0〜1 の数値です。` +
		summaryLengthInstruction +
		`reason は判定理由（上記のどのSTEPで判断したかが分かるように）を簡潔に書いてください。` +
		tagsBlock
	);
}

// buildSystemPrompt(topic, kind) の出力をハッシュ化し、items.ai_recheck_prompt_hash に
// 記録する短い識別子を作る（docs/progress/2026-07-10.md: 「ai_accepted=true のまま古いプロンプト
// 基準の判定が凍結されている記事」をSQLで抽出できるようにする目的）。
// crypto.subtle は Cloudflare Workers と Node(>=22.15.0、package.json engines) の両方で
// グローバルに使えるため追加依存は不要（src/lib/importers/blog.ts の hashBody と同じ実装）。
const promptHashCache = new Map();

/**
 * @param {import('../../config/topic.config.mjs').topic} topic
 * @param {'article' | 'paper'} [kind]
 * @returns {Promise<string>}
 */
export async function computePromptHash(topic, kind = 'article') {
	if (promptHashCache.has(kind)) return promptHashCache.get(kind);
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(buildSystemPrompt(topic, kind)));
	const hash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('').slice(0, 16);
	promptHashCache.set(kind, hash);
	return hash;
}
