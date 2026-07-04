export interface User {
  id: string; // uuid
  email: string;
  display_name?: string | null;
  created_at?: string;
}

export interface Pokemon {
  id: number;
  species: string;
  national_id?: number | null;
  nickname?: string | null;
  metadata?: Record<string, any>;
  created_at?: string;
}

export interface ResearchNote {
  id: string;
  author_id?: string | null;
  pokemon_id?: number | null;
  title: string;
  content?: string | null;
  metadata?: Record<string, any>;
  created_at?: string;
  updated_at?: string;
}

export interface Experiment {
  id: string;
  note_id: string;
  config: Record<string, any>;
  result?: Record<string, any> | null;
  status?: string;
  created_at?: string;
  finished_at?: string | null;
}
