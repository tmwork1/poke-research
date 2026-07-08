import { topic } from '../../config/topic.config.mjs';

// Qiita/note などキーワード検索型のインポーターが共通で使う検索語彙。
// 新しい略称・愛称（例: 「ポケカ」）を追加・削除したい場合は、各インポーター本体ではなく
// src/config/topic.config.mjs の collection.searchKeywords を編集する
// （Zenn はトピックタグでの絞り込みのため対象外）。
// 「ポケモン」は部分一致で「ポケモンGO」「ポケモンカード」等も拾うため、それらは重ねて持たない。
// 「pokemon」「pokeapi」は英語タイトル・API名のみの記事を、「ダメージ計算 実装」はポケモン名を
// タイトルに含まない対戦ツール系の実装記事を拾う。単に「ダメージ計算」だけだと、記事ではなく
// ダメージ計算ツールそのもの（yakkun.com/gamewith.jp のツールページ等）が大量にヒットし、
// AI レビューがツールページを記事として誤って accepted=true にしてしまう事例が本番で発生した
// ため、「実装」を足してツールの解説記事に絞り込む。
export const POKEMON_KEYWORDS = topic.collection.searchKeywords;

// Zenn はキーワード全文検索ではなくトピックタグでの絞り込みのため、別リストで管理する
// （Zenn のトピックスラッグは英数字のみ、日本語不可）。複数指定するとマージ・重複排除して取得する。
// 候補: 'pokemongo'（48件のprogramming/AIコンペ系とは傾向が異なり、チートツール改造史エッセイが
// 中心。10件確認済みだが今回は対象外としている。追加する場合は topic.config.mjs の
// collection.zennTopics に足すだけでよい）。
export const ZENN_TOPICS = topic.collection.zennTopics;

// Brave Search が対象外サービスや GitHub/YouTube、および検索結果の枠を占有しがちな企業攻略
// サイトを返さないよう、クエリの -site: と結果フィルタの両方で使う共有リスト。
// Brave のクエリは400文字・50語が上限のため、ここに載せるのは「検索結果を占有して他の
// 個人ブログ記事を押し出してしまう」もの（キーワード数×このリストの件数だけ -site: が
// クエリに追加されるが、実測で1クエリあたり230文字前後に収まる）に限る。
// トピック固有の追加分（本番調査でダメージ計算ツール等のWikiが検索結果を占有していた）は
// topic.config.mjs の collection.extraExcludedBlogDomains で管理する。
export const EXCLUDED_BLOG_DOMAINS = [
	// 他インポーターが専用で扱う／対象外と決定済みのサービス（トピックに依らず共通）。
	// note.com は専用API（note.ts）がCloudflare Workersからブロックされているため対象外とせず、
	// 他の個人ブログ同様Brave Search経由で発見しHTML抽出で収集する（KNOWN_BLOG_PLATFORMSも参照）。
	'qiita.com', 'zenn.dev', 'github.com', 'youtube.com', 'x.com', 'twitter.com',
	...topic.collection.extraExcludedBlogDomains,
] as const;

// 結果フィルタでのみ弾くドメイン。検索結果を占有するわけではないが記事として不適切な
// もの（SNSの集約・ブックマークページ、ミラー、アプリストアの配布ページ等）を、
// クエリ文字数を増やさずに除外するためこちらに置く。isExcludedBlogDomain は両方を見る。
export const FILTERED_BLOG_DOMAINS = [
	// b.hatena.ne.jp は「はてなブックマーク」であり、個人ブログの hatenablog.com/hatenablog.jp
	// とは別ドメインなので誤って一緒くたに除外しないこと。
	'b.hatena.ne.jp', 'pinterest.com', 'sourceforge.net', 'play.google.com', 'apps.apple.com',
] as const;

// 与えられたホスト名が EXCLUDED_BLOG_DOMAINS / FILTERED_BLOG_DOMAINS のいずれかに
// 一致する（サブドメイン含む）かを判定する純粋関数。URL解析・HTTP呼び出しを含まないため、
// cloudflare:workers に依存する importers/*.ts と異なりユニットテストで直接検証できる。
export function isExcludedBlogDomain(hostname: string): boolean {
	const normalized = hostname.replace(/^www\./, '');
	return [...EXCLUDED_BLOG_DOMAINS, ...FILTERED_BLOG_DOMAINS].some(
		(domain) => normalized === domain || normalized.endsWith(`.${domain}`),
	);
}

// Brave Search 経由のブログ収集で、ドメインごとに source が無限に増えるのを防ぐための
// 「有名どころ」許可リスト。ここに載っているサービスは Qiita/Zenn/note と同様、
// サービス単位（= 個々のユーザーのサブドメインをまとめて1レコード）で source を作る。
// 載っていないドメインは共通の「その他」source（OTHER_BLOG_SOURCE）にまとめる。
export const KNOWN_BLOG_PLATFORMS = [
	// note.ts と同じ source（name: 'note', originUrl: 'https://note.com/'）に集約されるよう
	// note.ts の NOTE_SOURCE_NAME / NOTE_SOURCE_ORIGIN_URL と一致させる。
	{ domain: 'note.com', name: 'note' },
	{ domain: 'hatenablog.com', name: 'はてなブログ' },
	{ domain: 'hatenablog.jp', name: 'はてなブログ' },
	{ domain: 'hatenadiary.jp', name: 'はてなダイアリー' },
	{ domain: 'hatenadiary.com', name: 'はてなダイアリー' },
	{ domain: 'speakerdeck.com', name: 'Speaker Deck' },
	{ domain: 'github.io', name: 'GitHub Pages' },
	{ domain: 'livedoor.jp', name: 'livedoor Blog' },
	{ domain: 'fc2.com', name: 'FC2ブログ' },
	{ domain: 'seesaa.net', name: 'Seesaa Blog' },
	{ domain: 'exblog.jp', name: 'Exblog' },
	{ domain: 'ameblo.jp', name: 'アメーバブログ' },
	{ domain: 'wordpress.com', name: 'WordPress.com' },
	{ domain: 'blogspot.com', name: 'Blogger' },
	{ domain: 'medium.com', name: 'Medium' },
] as const;

// 上記に無いドメインをまとめて受け止める共通 source。
// 個人ブログに限らず Stack Overflow・企業テックブログ等も混ざるため、名称は「その他」とする。
export const OTHER_BLOG_SOURCE = {
	name: 'その他',
	originUrl: `https://other-blogs.${topic.site.slug}.invalid/`,
} as const;
