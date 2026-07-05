// Supabase の CRUD 呼び出しを、テーブル単位の薄い共通 API にまとめる。
// API ルートやスクリプト側は、ここを通して基本操作を揃えて使う。
import { getSupabaseClient } from './supabase';
import type { Annotation, Item, Source } from './db-types';
import { recordAuditLog } from './audit';

export const tables = {
  users: 'users',
  sources: 'sources',
  items: 'items',
  tags: 'tags',
  item_tags: 'item_tags',
  item_relations: 'item_relations',
  annotations: 'annotations',
} as const;

type EntityWithId = { id: number };

export type SourceInsert = Omit<Source, 'id' | 'created_at'>;
export type SourceUpdate = Partial<SourceInsert>;
export type ItemInsert = Omit<Item, 'id' | 'created_at'>;
export type ItemUpdate = Partial<ItemInsert>;
export type AnnotationInsert = Omit<Annotation, 'id' | 'created_at'>;
export type AnnotationUpdate = Partial<AnnotationInsert>;

async function selectAll<T>(table: string): Promise<T[]> {
  const supabase = await getSupabaseClient();
  const { data, error } = await supabase.from<T>(table).select('*');
  if (error) throw error;
  return data || [];
}

async function selectById<T extends EntityWithId>(table: string, id: number): Promise<T | null> {
  const supabase = await getSupabaseClient();
  const { data, error } = await supabase
    .from<T>(table)
    .select('*')
    .eq('id', id)
    .single();
  if (error) {
    if ((error as any).status === 406 || (error as any).status === 404) return null;
    throw error;
  }
  return data || null;
}

async function insertOne<T>(table: string, row: object, actor?: string): Promise<T> {
  const supabase = await getSupabaseClient();
  const { data, error } = await supabase
    .from<T>(table)
    .insert([row])
    .select()
    .single();
  if (error) throw error;
  await recordAuditLog({
    table,
    recordId: (data as unknown as EntityWithId | null)?.id ?? null,
    action: 'insert',
    actor,
    before: null,
    after: data,
  });
  return data as T;
}

async function updateOne<T extends EntityWithId>(
  table: string,
  id: number,
  row: object,
  actor?: string,
): Promise<T | null> {
  const supabase = await getSupabaseClient();
  const before = await selectById<T>(table, id);
  const { data, error } = await supabase
    .from<T>(table)
    .update(row)
    .eq('id', id)
    .select('*')
    .single();
  if (error) {
    if ((error as any).status === 406 || (error as any).status === 404) return null;
    throw error;
  }
  if (data) {
    await recordAuditLog({ table, recordId: id, action: 'update', actor, before, after: data });
  }
  return data || null;
}

async function deleteOne<T extends EntityWithId>(table: string, id: number, actor?: string): Promise<T | null> {
  const supabase = await getSupabaseClient();
  const { data, error } = await supabase
    .from<T>(table)
    .delete()
    .eq('id', id)
    .select('*')
    .single();
  if (error) {
    if ((error as any).status === 406 || (error as any).status === 404) return null;
    throw error;
  }
  if (data) {
    await recordAuditLog({ table, recordId: id, action: 'delete', actor, before: data, after: null });
  }
  return data || null;
}

export async function fetchAllSources(): Promise<Source[]> {
  return selectAll<Source>(tables.sources);
}

export async function getSourceById(id: number): Promise<Source | null> {
  return selectById<Source>(tables.sources, id);
}

export async function insertSource(source: SourceInsert, actor?: string): Promise<Source> {
  return insertOne<Source>(tables.sources, source, actor);
}

export async function updateSource(id: number, source: SourceUpdate, actor?: string): Promise<Source | null> {
  return updateOne<Source>(tables.sources, id, source, actor);
}

export async function deleteSource(id: number, actor?: string): Promise<Source | null> {
  return deleteOne<Source>(tables.sources, id, actor);
}

export async function fetchAllItems(): Promise<Item[]> {
  return selectAll<Item>(tables.items);
}

export async function getItemById(id: number): Promise<Item | null> {
  return selectById<Item>(tables.items, id);
}

export async function insertItem(item: ItemInsert, actor?: string): Promise<Item> {
  return insertOne<Item>(tables.items, item, actor);
}

export async function updateItem(id: number, item: ItemUpdate, actor?: string): Promise<Item | null> {
  return updateOne<Item>(tables.items, id, item, actor);
}

export async function deleteItem(id: number, actor?: string): Promise<Item | null> {
  return deleteOne<Item>(tables.items, id, actor);
}

export async function fetchAllAnnotations(): Promise<Annotation[]> {
  return selectAll<Annotation>(tables.annotations);
}

export async function getAnnotationById(id: number): Promise<Annotation | null> {
  return selectById<Annotation>(tables.annotations, id);
}

export async function insertAnnotation(annotation: AnnotationInsert, actor?: string): Promise<Annotation> {
  return insertOne<Annotation>(tables.annotations, annotation, actor);
}

export async function updateAnnotation(
  id: number,
  annotation: AnnotationUpdate,
  actor?: string,
): Promise<Annotation | null> {
  return updateOne<Annotation>(tables.annotations, id, annotation, actor);
}

export async function deleteAnnotation(id: number, actor?: string): Promise<Annotation | null> {
  return deleteOne<Annotation>(tables.annotations, id, actor);
}

export default {
  fetchAllSources,
  getSourceById,
  insertSource,
  updateSource,
  deleteSource,
  fetchAllItems,
  getItemById,
  insertItem,
  updateItem,
  deleteItem,
  fetchAllAnnotations,
  getAnnotationById,
  insertAnnotation,
  updateAnnotation,
  deleteAnnotation,
};
