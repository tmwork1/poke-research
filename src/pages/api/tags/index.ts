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