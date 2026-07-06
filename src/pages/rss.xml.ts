// 新着アイテムのRSS 2.0フィードを配信する。購読者が巡回せずに新着を追える導線として設置する。
import { methodNotAllowed } from './api/_shared';
import { fetchCatalogItems } from '../lib/catalog';
import { topic } from '../config/topic.config.mjs';

export const prerender = false;

const SITE_URL = topic.site.url;
const FEED_ITEM_LIMIT = 30;

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export async function GET({ request }: { request: Request }) {
  // ?tag=xxx で特定タグの新着だけを購読できるようにする。
  const tag = new URL(request.url).searchParams.get('tag')?.trim() || undefined;
  const items = await fetchCatalogItems({ tag, limit: FEED_ITEM_LIMIT });

  const entries = items
    .map((item) => {
      const link = item.external_url ?? SITE_URL;
      const pubDate = new Date(item.published_at ?? item.created_at ?? Date.now()).toUTCString();
      return `
    <item>
      <title>${escapeXml(item.title || `Item ${item.id}`)}</title>
      <link>${escapeXml(link)}</link>
      <guid isPermaLink="false">item-${item.id}</guid>
      <description>${escapeXml(item.summary ?? '')}</description>
      <pubDate>${pubDate}</pubDate>
    </item>`;
    })
    .join('');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>${escapeXml(topic.site.name)} 新着アイテム${tag ? `（#${escapeXml(tag)}）` : ''}</title>
    <link>${SITE_URL}</link>
    <description>${escapeXml(topic.collection.label)}プログラミング情報ハブの新着アイテム${tag ? `（タグ: ${escapeXml(tag)}）` : ''}</description>
    <language>ja</language>${entries}
  </channel>
</rss>`;

  return new Response(xml, {
    status: 200,
    headers: { 'Content-Type': 'application/rss+xml; charset=utf-8' },
  });
}

export const POST = () => methodNotAllowed(['GET']);
export const PUT = POST;
export const PATCH = POST;
export const DELETE = POST;
