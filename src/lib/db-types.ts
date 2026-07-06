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
  /** 検索対象を広げるための本文テキスト（migrations/015）。妥当な長さに切り詰めて保存する。 */
  body?: string | null;
  /** リンク切れ検出（migrations/016）の直近判定。'ok' | 'broken'。未チェックの既存行も 'ok' 扱い。 */
  link_status?: string | null;
  /** 直近チェック時刻。未チェックなら null。 */
  link_checked_at?: string | null;
  /** 初めて到達不能の疑いを検出した時刻。ok に戻ったら null へ戻す。 */
  link_broken_since?: string | null;
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

