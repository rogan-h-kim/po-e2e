import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { DEFAULT_SUITE_ID, type Release, type Scenario, type Step, type Suite } from '../shared/types';

// ---------------------------------------------------------------------------
// Supabase-backed team sharing — publisher / runner model.
//
//  • Everyone with the build can READ the published suites (anon key).
//  • Only signed-in publishers can WRITE; that is enforced by the tables' RLS
//    policies (see SETUP_SQL), not by the UI.
//  • Connection settings come from the build (.env → import.meta.env). There is
//    no per-user configuration screen: runners install and it just works.
//
// Tables: suites (grouping + folders), scenarios (suite_id, folder),
// releases (one row per publish, numbered per suite), publishers (emails).
// ---------------------------------------------------------------------------

export interface SupabaseConfig {
  url: string;
  anonKey: string;
  table: string;
}

const DEFAULT_TABLE = 'scenarios';
const SUITES_TABLE = 'suites';
const RELEASES_TABLE = 'releases';
const PUBLISHERS_TABLE = 'publishers';

/** Config baked in at build time via .env (VITE_SUPABASE_*), or null for a fully offline build. */
export function getEnvConfig(): SupabaseConfig | null {
  const url = (import.meta.env.VITE_SUPABASE_URL ?? '').trim().replace(/\/+$/, '').replace(/\/rest\/v1$/, '');
  const anonKey = (import.meta.env.VITE_SUPABASE_ANON_KEY ?? '').trim();
  if (!url || !anonKey) return null;
  return { url, anonKey, table: (import.meta.env.VITE_SUPABASE_TABLE ?? '').trim() || DEFAULT_TABLE };
}

export const hasConfig = () => getEnvConfig() !== null;

/** supabase-js session storage backed by chrome.storage.local (the side panel has no reliable localStorage). */
const sessionStorage = {
  getItem: async (key: string) => {
    const v = await chrome.storage.local.get(key);
    return typeof v[key] === 'string' ? (v[key] as string) : null;
  },
  setItem: async (key: string, value: string) => {
    await chrome.storage.local.set({ [key]: value });
  },
  removeItem: async (key: string) => {
    await chrome.storage.local.remove(key);
  },
};

let cached: SupabaseClient | null = null;

function client(): SupabaseClient {
  if (cached) return cached;
  const cfg = getEnvConfig();
  if (!cfg) throw new Error('이 빌드에는 팀 공유 설정이 없어요 (.env의 VITE_SUPABASE_*).');
  cached = createClient(cfg.url, cfg.anonKey, {
    auth: {
      storage: sessionStorage,
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
    },
  });
  return cached;
}

const table = () => getEnvConfig()?.table ?? DEFAULT_TABLE;

function friendly(message: string): string {
  if (/invalid login credentials/i.test(message)) return '이메일 또는 비밀번호가 맞지 않아요.';
  if (/email not confirmed/i.test(message)) return '아직 확인되지 않은 계정이에요. Supabase 대시보드에서 확인 처리하세요.';
  if (/row-level security|permission denied|42501/i.test(message))
    return '게시 권한이 없어요. 이 계정의 이메일이 publishers 테이블에 있어야 합니다.';
  if (/relation .* does not exist|42P01|column .* does not exist|42703/i.test(message))
    return '테이블 구조가 달라요. Supabase SQL 편집기에서 설정 SQL을 다시 실행하세요.';
  return message;
}

const fail = (error: { message: string } | null) => {
  if (error) throw new Error(friendly(error.message));
};

// ---- Auth --------------------------------------------------------------------

export async function getSessionEmail(): Promise<string | null> {
  const { data } = await client().auth.getSession();
  return data.session?.user.email ?? null;
}

export async function signIn(email: string, password: string): Promise<string> {
  const { data, error } = await client().auth.signInWithPassword({ email, password });
  fail(error);
  return data.user?.email ?? email;
}

export async function signOut(): Promise<void> {
  await client().auth.signOut();
}

/** Whether this signed-in email is allowed to publish (has a row in `publishers`). */
export async function checkPublisher(email: string): Promise<boolean> {
  const { data, error } = await client().from(PUBLISHERS_TABLE).select('email').eq('email', email).limit(1);
  if (error) return false;
  return (data?.length ?? 0) > 0;
}

// ---- Rows --------------------------------------------------------------------

interface Row {
  id: string;
  name: string;
  steps: Step[];
  suite_id: string | null;
  folder: string | null;
  created_at: number;
  updated_at: number;
}

interface SuiteRow {
  id: string;
  name: string;
  archived: boolean;
  folders: string[] | null;
  created_at: number;
  updated_at: number;
}

interface ReleaseRow {
  suite_id: string;
  version: number;
  published_at: number;
  published_by: string | null;
  changed_ids: string[] | null;
}

const toRow = (s: Scenario): Row => ({
  id: s.id,
  name: s.name,
  steps: s.steps,
  suite_id: s.suiteId ?? DEFAULT_SUITE_ID,
  folder: s.folder ?? null,
  created_at: s.createdAt,
  updated_at: s.updatedAt,
});

const toScenario = (r: Row): Scenario => ({
  id: r.id,
  name: r.name,
  steps: Array.isArray(r.steps) ? r.steps : [],
  suiteId: r.suite_id ?? DEFAULT_SUITE_ID,
  folder: r.folder || undefined,
  createdAt: Number(r.created_at),
  updatedAt: Number(r.updated_at),
});

const toSuiteRow = (s: Suite): SuiteRow => ({
  id: s.id,
  name: s.name,
  archived: s.archived,
  folders: s.folders,
  created_at: s.createdAt,
  updated_at: s.updatedAt,
});

const toSuite = (r: SuiteRow): Suite => ({
  id: r.id,
  name: r.name,
  archived: !!r.archived,
  folders: Array.isArray(r.folders) ? r.folders.filter((f): f is string => typeof f === 'string') : [],
  createdAt: Number(r.created_at),
  updatedAt: Number(r.updated_at),
});

const toRelease = (r: ReleaseRow): Release => ({
  suiteId: r.suite_id,
  version: r.version,
  publishedAt: Number(r.published_at),
  publishedBy: r.published_by,
  changedIds: Array.isArray(r.changed_ids) ? r.changed_ids : [],
});

// ---- Team set ------------------------------------------------------------------

export interface TeamFetch {
  suites: Suite[];
  scenarios: Scenario[];
  /** Latest release per suite id. */
  releases: Record<string, Release>;
}

export async function fetchTeam(): Promise<TeamFetch> {
  const c = client();
  const [su, sc, rel] = await Promise.all([
    c.from(SUITES_TABLE).select('*').order('created_at'),
    c.from(table()).select('*').order('name'),
    c.from(RELEASES_TABLE).select('*').order('version', { ascending: false }).limit(500),
  ]);
  fail(su.error);
  fail(sc.error);
  fail(rel.error);
  const releases: Record<string, Release> = {};
  for (const r of (rel.data as ReleaseRow[]) ?? []) {
    if (!(r.suite_id in releases)) releases[r.suite_id] = toRelease(r); // rows arrive newest first
  }
  return {
    suites: ((su.data as SuiteRow[]) ?? []).map(toSuite),
    scenarios: ((sc.data as Row[]) ?? []).map(toScenario),
    releases,
  };
}

/**
 * Publish part of a suite as its next release: delete the removed ids, upsert
 * the given scenarios, then record the release. Requires a signed-in publisher
 * (RLS rejects everything else).
 */
export async function publishSuite(
  suiteId: string,
  upserts: Scenario[],
  removedIds: string[],
  publishedBy: string,
): Promise<Release> {
  const c = client();
  if (removedIds.length) fail((await c.from(table()).delete().in('id', removedIds)).error);
  if (upserts.length) fail((await c.from(table()).upsert(upserts.map(toRow), { onConflict: 'id' })).error);
  const latest = await c
    .from(RELEASES_TABLE)
    .select('version')
    .eq('suite_id', suiteId)
    .order('version', { ascending: false })
    .limit(1);
  fail(latest.error);
  const row: ReleaseRow = {
    suite_id: suiteId,
    version: ((latest.data?.[0] as { version?: number } | undefined)?.version ?? 0) + 1,
    published_at: Date.now(),
    published_by: publishedBy,
    changed_ids: [...upserts.map((s) => s.id), ...removedIds],
  };
  fail((await c.from(RELEASES_TABLE).insert(row)).error);
  return toRelease(row);
}

/** Suites are metadata, not versioned: a publisher's change is written immediately. */
export async function saveSuite(suite: Suite): Promise<void> {
  fail((await client().from(SUITES_TABLE).upsert(toSuiteRow(suite), { onConflict: 'id' })).error);
}

/** SQL the publisher runs once in the Supabase SQL editor. Safe to re-run. */
export const SETUP_SQL = `-- Po-Cake: run once in the Supabase SQL editor (publisher / runner model). Safe to re-run.

-- 1) Suites: a group of scenarios per product version (or team).
create table if not exists suites (
  id text primary key,
  name text not null,
  archived boolean not null default false,
  created_at bigint not null,
  updated_at bigint not null
);
alter table suites add column if not exists folders jsonb not null default '[]';
insert into suites (id, name, created_at, updated_at)
  values ('main', '기본', (extract(epoch from now()) * 1000)::bigint, (extract(epoch from now()) * 1000)::bigint)
  on conflict (id) do nothing;

-- 2) Published scenarios.
create table if not exists scenarios (
  id text primary key,
  name text not null,
  steps jsonb not null default '[]',
  created_at bigint not null,
  updated_at bigint not null
);
alter table scenarios add column if not exists suite_id text references suites(id);
alter table scenarios add column if not exists folder text;
update scenarios set suite_id = 'main' where suite_id is null;

-- 3) Who may publish. Add one row per publisher email.
create table if not exists publishers (email text primary key);
-- insert into publishers (email) values ('you@company.com');

-- 4) Release history: one row per publish, numbered per suite.
create table if not exists releases (
  suite_id text not null references suites(id),
  version int not null,
  published_at bigint not null,
  published_by text,
  changed_ids jsonb not null default '[]',
  primary key (suite_id, version)
);

alter table suites enable row level security;
alter table scenarios enable row level security;
alter table publishers enable row level security;
alter table releases enable row level security;

drop policy if exists "po_cake_anon_all" on scenarios;
drop policy if exists "scenarios_read" on scenarios;
drop policy if exists "scenarios_write" on scenarios;
drop policy if exists "suites_read" on suites;
drop policy if exists "suites_write" on suites;
drop policy if exists "publishers_self" on publishers;
drop policy if exists "releases_read" on releases;
drop policy if exists "releases_write" on releases;

create policy "suites_read" on suites for select using (true);
create policy "suites_write" on suites for all
  using (auth.email() in (select email from publishers))
  with check (auth.email() in (select email from publishers));

create policy "scenarios_read" on scenarios for select using (true);
create policy "scenarios_write" on scenarios for all
  using (auth.email() in (select email from publishers))
  with check (auth.email() in (select email from publishers));

-- A signed-in user may see only their own publisher row (used to detect the role).
create policy "publishers_self" on publishers for select using (auth.email() = email);

create policy "releases_read" on releases for select using (true);
create policy "releases_write" on releases for insert
  with check (auth.email() in (select email from publishers));

-- Also, in Authentication → Providers → Email: turn OFF "Enable sign ups",
-- then create publisher accounts under Authentication → Users → Add user.`;
