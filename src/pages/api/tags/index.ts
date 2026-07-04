// tags の一覧取得を提供する API ルート。
// タグ一覧は読み取り専用なので、更新系メソッドはすべて拒否する。
import { jsonResponse, methodNotAllowed } from '../_shared';
import { fetchCatalogTags } from '../../../lib/catalog';

export const prerender = false;

export async function GET() {
	const tags = await fetchCatalogTags();
	return jsonResponse({ data: tags, meta: { count: tags.length } });
}

export const POST = () => methodNotAllowed(['GET']);
export const PUT = POST;
export const PATCH = POST;
export const DELETE = POST;