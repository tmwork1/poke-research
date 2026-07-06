// DB の各テーブル行を表す型定義をまとめたファイル。
// 画面・API・インポーター間で共通に使う基礎型をここで揃える。
export interface User {
  id: string; // uuid
  email: string;
  display_name?: string | null;
  created_at?: string;
}

export interface Source {
  id: number;
  name: string;
  type?: string | null;
  origin_url?: string | null;
  metadata?: Record<string, any>;
  created_at?: string;
}

export interface Item {
  id: number;
  source_id?: number | null;
  external_url?: string | null;
  kind?: string | null;
  title?: string | null;
  authors?: string[] | null;
  summary?: string | null;
  published_at?: string | null;
  updated_at?: string | null;
  metadata?: Record<string, any>;
  version?: string | null;
  created_at?: string;
  /** bookmarks の INSERT/DELETE トリガー（migrations/013）で維持されるキャッシュ列。 */
  bookmarks_count?: number;
}

export interface Tag {
  id: number;
  name: string;
}

export interface Annotation {
  id: number;
  item_id: number;
  author_id?: string | null;
  kind?: string | null;
  value?: Record<string, any> | null;
  provenance?: Record<string, any> | null;
  created_at?: string;
}

export interface ItemRelation {
  from_item_id: number;
  to_item_id: number;
  relation_type: string;
  provenance?: Record<string, any> | null;
  created_at?: string;
}

export interface AuditLog {
  id: number;
  table_name: string;
  record_id?: number | null;
  action: string;
  actor?: string | null;
  before?: Record<string, any> | null;
  after?: Record<string, any> | null;
  created_at?: string;
}

