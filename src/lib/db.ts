import supabase from './supabase';
import type { Pokemon, ResearchNote, User, Experiment } from './db-types';

export const tables = {
  users: 'users',
  pokemon: 'pokemon',
  research_notes: 'research_notes',
  experiments: 'experiments',
} as const;

export async function fetchAllPokemon(): Promise<Pokemon[]> {
  const { data, error } = await supabase
    .from<Pokemon>(tables.pokemon)
    .select('*');
  if (error) throw error;
  return data || [];
}

export async function insertPokemon(p: Omit<Pokemon, 'id' | 'created_at'>): Promise<Pokemon> {
  const { data, error } = await supabase
    .from<Pokemon>(tables.pokemon)
    .insert([p])
    .select()
    .single();
  if (error) throw error;
  return data as Pokemon;
}

export async function getPokemonById(id: number): Promise<Pokemon | null> {
  const { data, error } = await supabase
    .from<Pokemon>(tables.pokemon)
    .select('*')
    .eq('id', id)
    .single();
  if (error) {
    if ((error as any).status === 406 || (error as any).status === 404) return null;
    throw error;
  }
  return data || null;
}

export async function upsertResearchNote(note: Partial<ResearchNote>): Promise<ResearchNote> {
  const payload = { ...note } as any;
  const { data, error } = await supabase
    .from<ResearchNote>(tables.research_notes)
    .upsert(payload)
    .select()
    .single();
  if (error) throw error;
  return data as ResearchNote;
}

export async function listExperimentsByStatus(status = 'pending'): Promise<Experiment[]> {
  const { data, error } = await supabase
    .from<Experiment>(tables.experiments)
    .select('*')
    .eq('status', status);
  if (error) throw error;
  return data || [];
}

export default {
  fetchAllPokemon,
  insertPokemon,
  getPokemonById,
  upsertResearchNote,
  listExperimentsByStatus,
};
