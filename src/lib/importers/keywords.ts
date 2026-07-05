// Qiita/note などキーワード検索型のインポーターが共通で使う検索語彙。
// 新しい略称・愛称（例: 「ポケカ」）を追加・削除したい場合は、各インポーター本体ではなく
// ここを編集する（Zenn はトピックタグでの絞り込みのため対象外）。
// 「ポケモン」は部分一致で「ポケモンGO」「ポケモンカード」等も拾うため、それらは重ねて持たない。
// 「pokemon」「pokeapi」は英語タイトル・API名のみの記事を、「ダメージ計算」はポケモン名を
// タイトルに含まない対戦ツール系記事を拾う（無関係ヒットは AI レビューが棄却する前提）。
export const POKEMON_KEYWORDS = ['ポケモン', 'ポケカ', 'ポケットモンスター', 'pokemon', 'pokeapi', 'ダメージ計算'] as const;

// Zenn はキーワード全文検索ではなくトピックタグでの絞り込みのため、別リストで管理する
// （Zenn のトピックスラッグは英数字のみ、日本語不可）。複数指定するとマージ・重複排除して取得する。
// 候補: 'pokemongo'（48件のprogramming/AIコンペ系とは傾向が異なり、チートツール改造史エッセイが
// 中心。10件確認済みだが今回は対象外としている。追加する場合はここに足すだけでよい）。
export const ZENN_TOPICS = ['pokemon'] as const;

// Brave Search が対象外サービスや GitHub/YouTube を返さないよう、クエリの -site: と
// 結果フィルタの両方で使う共有リスト。
export const EXCLUDED_BLOG_DOMAINS = [
	'qiita.com', 'zenn.dev', 'note.com', 'github.com', 'youtube.com', 'x.com', 'twitter.com',
] as const;
