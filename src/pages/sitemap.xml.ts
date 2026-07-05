// 検索エンジンのクロール・インデックス対応のため、静的ページとタグ別ページを列挙する。
import { methodNotAllowed } from './api/_shared';
import { fetchTopTags } from '../lib/catalog';

export const prerender = false;

const SITE_URL = 'https://poke-research.com';
const SITEMAP_TAG_LIMIT = 50;

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export async function GET() {
  const topTags = await fetchTopTags(SITEMAP_TAG_LIMIT);

  const staticUrls = [`${SITE_URL}/`, `${SITE_URL}/items`];
  const tagUrls = topTags.map((tag) => `${SITE_URL}/tags/${encodeURIComponent(tag.name)}`);

  const urls = [...staticUrls, ...tagUrls]
    .map((url) => `
  <url>
    <loc>${escapeXml(url)}</loc>
  </url>`)
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
