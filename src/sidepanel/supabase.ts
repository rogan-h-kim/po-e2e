import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Scenario, Step } from '../shared/types';

// ---------------------------------------------------------------------------
// Supabase-backed team sharing. The user pastes their project URL + anon key
// (both are safe to ship in a client; table access is guarded by RLS). We
// upsert/select a single `scenarios` table.
// ---------------------------------------------------------------------------

export interface SupabaseConfig {
  url: string;
  anonKey: string;
  table: string;
}

const K_CFG = 'po-cake:supabase';
export const DEFAULT_TABLE = 'scenarios';

/** Config baked in at build time via .env (VITE_SUPABASE_*). */
export function getEnvConfig(): SupabaseConfig | null {
  const url = import.meta.env.VITE_SUPABASE_URL;
  const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
  if (!url || !anonKey) return null;
  return { url, anonKey, table: import.meta.env.VITE_SUPABASE_TABLE || DEFAULT_TABLE };
}

/** Whether this browser has a user-entered override (via the ⚙ settings). */
export async function hasStoredConfig(): Promise<boolean> {
  const v = await chrome.storage.local.get(K_CFG);
  const cfg = v[K_CFG] as SupabaseConfig | undefined;
  return !!(cfg && cfg.url && cfg.anonKey);
}

/** Effective config: a per-browser override wins, else the build-time default. */
export async function loadConfig(): Promise<SupabaseConfig | null> {
  const v = await chrome.storage.local.get(K_CFG);
  const cfg = v[K_CFG] as SupabaseConfig | undefined;
  if (cfg && cfg.url && cfg.anonKey) return cfg;
  return getEnvConfig();
}

export async function saveConfig(cfg: SupabaseConfig): Promise<void> {
  await chrome.storage.local.set({ [K_CFG]: cfg });
}

export async function clearConfig(): Promise<void> {
  await chrome.storage.local.remove(K_CFG);
}

/** Trim whitespace and strip a trailing slash / accidental /rest/v1 from the URL. */
export function normalizeConfig(cfg: SupabaseConfig): SupabaseConfig {
  return {
    url: cfg.url
      .trim()
      .replace(/\/+$/, '') // trailing slashes
      .replace(/\/rest\/v1\/?$/, ''), // accidental REST path
    anonKey: cfg.anonKey.trim(),
    table: cfg.table.trim() || DEFAULT_TABLE,
  };
}

function client(cfg: SupabaseConfig): SupabaseClient {
  const c = normalizeConfig(cfg);
  return createClient(c.url, c.anonKey, {
    auth: { persistSession: false },
  });
}

interface Row {
  id: string;
  name: string;
  steps: Step[];
  created_at: number;
  updated_at: number;
}

function toRow(s: Scenario): Row {
  return {
    id: s.id,
    name: s.name,
    steps: s.steps,
    created_at: s.createdAt,
    updated_at: s.updatedAt,
  };
}

function toScenario(r: Row): Scenario {
  return {
    id: r.id,
    name: r.name,
    steps: Array.isArray(r.steps) ? r.steps : [],
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

/** Quick connectivity/table check. Throws with a helpful message on failure. */
export async function testConnection(cfg: SupabaseConfig): Promise<void> {
  const c = normalizeConfig(cfg);
  const { error } = await client(c).from(c.table).select('id').limit(1);
  if (error) throw new Error(error.message);
}

export async function pullRemote(cfg: SupabaseConfig): Promise<Scenario[]> {
  const c = normalizeConfig(cfg);
  const { data, error } = await client(c).from(c.table).select('*');
  if (error) throw new Error(error.message);
  return (data as Row[]).map(toScenario);
}

export async function pushRemote(cfg: SupabaseConfig, scenarios: Scenario[]): Promise<void> {
  if (!scenarios.length) return;
  const c = normalizeConfig(cfg);
  const { error } = await client(c)
    .from(c.table)
    .upsert(scenarios.map(toRow), { onConflict: 'id' });
  if (error) throw new Error(error.message);
}

export async function deleteRemote(cfg: SupabaseConfig, id: string): Promise<void> {
  const c = normalizeConfig(cfg);
  const { error } = await client(c).from(c.table).delete().eq('id', id);
  if (error) throw new Error(error.message);
}

/** SQL the user runs once in Supabase to create the table + a permissive policy. */
export const SETUP_SQL = `-- Po-Cake: run once in Supabase SQL editor
create table if not exists scenarios (
  id text primary key,
  name text not null,
  steps jsonb not null default '[]',
  created_at bigint not null,
  updated_at bigint not null
);

alter table scenarios enable row level security;

-- Internal team: allow the anon key full access.
-- Tighten this later with Supabase Auth if needed.
create policy "po_cake_anon_all" on scenarios
  for all using (true) with check (true);`;
