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

