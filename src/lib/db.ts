// Supabase の CRUD 呼び出しを、テーブル単位の薄い共通 API にまとめる。
// API ルートやスクリプト側は、ここを通して基本操作を揃えて使う。
import { getSupabaseClient } from './supabase';
import type { Annotation, Item, Source } from './db-types';

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

async function insertOne<T>(table: string, row: object): Promise<T> {
  const supabase = await getSupabaseClient();
  const { data, error } = await supabase
    .from<T>(table)
    .insert([row])
    .select()
    .single();
  if (error) throw error;
  return data as T;
}

async function updateOne<T extends EntityWithId>(table: string, id: number, row: object): Promise<T | null> {
  const supabase = await getSupabaseClient();
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
  return data || null;
}

async function deleteOne<T extends EntityWithId>(table: string, id: number): Promise<T | null> {
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
  return data || null;
}

export async function fetchAllSources(): Promise<Source[]> {
  return selectAll<Source>(tables.sources);
}

export async function getSourceById(id: number): Promise<Source | null> {
  return selectById<Source>(tables.sources, id);
}

export async function insertSource(source: SourceInsert): Promise<Source> {
  return insertOne<Source>(tables.sources, source);
}

export async function updateSource(id: number, source: SourceUpdate): Promise<Source | null> {
  return updateOne<Source>(tables.sources, id, source);
}

export async function deleteSource(id: number): Promise<Source | null> {
  return deleteOne<Source>(tables.sources, id);
}

export async function fetchAllItems(): Promise<Item[]> {
  return selectAll<Item>(tables.items);
}

export async function getItemById(id: number): Promise<Item | null> {
  return selectById<Item>(tables.items, id);
}

export async function insertItem(item: ItemInsert): Promise<Item> {
  return insertOne<Item>(tables.items, item);
}

export async function updateItem(id: number, item: ItemUpdate): Promise<Item | null> {
  return updateOne<Item>(tables.items, id, item);
}

export async function deleteItem(id: number): Promise<Item | null> {
  return deleteOne<Item>(tables.items, id);
}

export async function fetchAllAnnotations(): Promise<Annotation[]> {
  return selectAll<Annotation>(tables.annotations);
}

export async function getAnnotationById(id: number): Promise<Annotation | null> {
  return selectById<Annotation>(tables.annotations, id);
}

export async function insertAnnotation(annotation: AnnotationInsert): Promise<Annotation> {
  return insertOne<Annotation>(tables.annotations, annotation);
}

export async function updateAnnotation(id: number, annotation: AnnotationUpdate): Promise<Annotation | null> {
  return updateOne<Annotation>(tables.annotations, id, annotation);
}

export async function deleteAnnotation(id: number): Promise<Annotation | null> {
  return deleteOne<Annotation>(tables.annotations, id);
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
