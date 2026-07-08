// 検索エンジンのクロール・インデックス対応のため、静的ページとタグ別ページを列挙する。
import { methodNotAllowed } from './api/_shared';
import { fetchCatalogItems, fetchTopTags } from '../lib/catalog';
import { topic } from '../config/topic.config.mjs';

export const prerender = false;

const SITE_URL = topic.site.url;
const SITEMAP_TAG_LIMIT = 50;

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

interface SitemapUrl {
  loc: string;
  lastmod?: string;
}

export async function GET() {
  const [topTags, latestItems] = await Promise.all([
    fetchTopTags(SITEMAP_TAG_LIMIT),
    // 最新記事1件の公開日を、更新頻度の高いページ（トップ・一覧）の lastmod に流用する。
    fetchCatalogItems({ limit: 1 }),
  ]);
  const latestItem = latestItems[0];
  const latestPublishedAt = latestItem ? latestItem.published_at ?? latestItem.created_at : undefined;
  const lastmod = latestPublishedAt ? new Date(latestPublishedAt).toISOString() : undefined;

  const staticUrls: SitemapUrl[] = [
    { loc: `${SITE_URL}/`, lastmod },
    { loc: `${SITE_URL}/items`, lastmod },
    { loc: `${SITE_URL}/papers`, lastmod },
    { loc: `${SITE_URL}/tags` },
    { loc: `${SITE_URL}/about` },
  ];
  // タグごとの最新記事日時までは追わず、全タグ共通で lastmod を割り切って付与する
  // （タグ別に問い合わせると RPC 呼び出しが taggedURL 数分増えてしまうため）。
  const tagUrls: SitemapUrl[] = topTags.map((tag) => ({
    loc: `${SITE_URL}/tags/${encodeURIComponent(tag.name)}`,
    lastmod,
  }));

  const urls = [...staticUrls, ...tagUrls]
    .map(
      (url) => `
  <url>
    <loc>${escapeXml(url.loc)}</loc>${url.lastmod ? `\n    <lastmod>${url.lastmod}</lastmod>` : ''}
  </url>`,
    )
    .join('');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}
</urlset>`;

  return new Response(xml, {
    status: 200,
    headers: { 'Content-Type': 'application/xml; charset=utf-8' },
  });
}

export const POST = () => methodNotAllowed(['GET']);
export const PUT = POST;
export const PATCH = POST;
export const DELETE = POST;
