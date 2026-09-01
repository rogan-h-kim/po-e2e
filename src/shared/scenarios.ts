import type { Release, Scenario, Step, Suite } from './types';
import { DEFAULT_SUITE_ID } from './types';
import { SEED_VERSION, SEED_SCENARIOS } from './seed';

// ---------------------------------------------------------------------------
// Local store (chrome.storage.local). Two kinds of scenario live here:
//
//  • Drafts - this browser's own scenarios. Anyone can create and edit them;
//    they never leave the browser unless exported. Fully offline.
//  • Team - a mirror of the published team set from Supabase, grouped into
//    suites. Runners only read it (it is replaced on refresh); publishers edit
//    it locally and publish changed scenarios as a new release of their suite.
//    `snapshot` is the last state we received from / published to the server,
//    so unpublished changes can be detected by comparing against it, and a
//    refresh can re-apply them on top of what others published (see rebase).
// ---------------------------------------------------------------------------

const K_DRAFTS = 'po-cake:scenarios'; // pre-refactor key: existing local scenarios simply become drafts
const K_ACTIVE = 'po-cake:activeId';
const K_LEGACY_STEPS = 'po-cake:steps'; // even older single-scenario format
const K_SEEDVER = 'po-cake:seedVersion';
const K_TEAM = 'po-cake:team';
const K_TEAM_SNAPSHOT = 'po-cake:teamSnapshot';
const K_TEAM_SUITES = 'po-cake:teamSuites';
const K_TEAM_RELEASES = 'po-cake:teamReleases';
const K_ACTIVE_SUITE = 'po-cake:activeSuite';
const K_CONTINUE = 'po-cake:continueOnFailure';
/** Keys from earlier models; removed on first load. */
const K_OBSOLETE = [
  'po-cake:syncMeta',
  'po-cake:viewerMode',
  'po-cake:supabase',
  'po-cake:teamRelease',
  'po-cake:varOverrides',
];

export function makeScenario(name: string, steps: Step[] = []): Scenario {
  const now = Date.now();
  return { id: crypto.randomUUID(), name, steps, createdAt: now, updatedAt: now };
}

export function makeSuite(name: string, id = crypto.randomUUID()): Suite {
  const now = Date.now();
  return { id, name, archived: false, folders: [], createdAt: now, updatedAt: now };
}

// ---- Drafts --------------------------------------------------------------------

export interface DraftState {
  drafts: Scenario[];
  activeId: string | null;
}

export async function loadDrafts(): Promise<DraftState> {
  const v = await chrome.storage.local.get([K_DRAFTS, K_ACTIVE, K_LEGACY_STEPS, K_SEEDVER]);
  let drafts: Scenario[] = Array.isArray(v[K_DRAFTS]) ? v[K_DRAFTS] : [];

  // One-time migration from the old single-scenario key.
  if (drafts.length === 0 && Array.isArray(v[K_LEGACY_STEPS]) && v[K_LEGACY_STEPS].length) {
    drafts = [makeScenario('기본 시나리오', v[K_LEGACY_STEPS] as Step[])];
    await chrome.storage.local.remove(K_LEGACY_STEPS);
    await saveDrafts(drafts);
  }

  // Seed: scenarios baked into the build (for installs without team sharing).
  const storedSeedVer = typeof v[K_SEEDVER] === 'number' ? v[K_SEEDVER] : 0;
  if (SEED_VERSION > storedSeedVer && SEED_SCENARIOS.length) {
    const map = new Map(drafts.map((s) => [s.id, s]));
    for (const seed of SEED_SCENARIOS) map.set(seed.id, structuredClone(seed));
    drafts = [...map.values()];
    await chrome.storage.local.set({ [K_DRAFTS]: drafts, [K_SEEDVER]: SEED_VERSION });
  }

  await chrome.storage.local.remove(K_OBSOLETE);

  const activeId = typeof v[K_ACTIVE] === 'string' ? v[K_ACTIVE] : null;
  return { drafts, activeId };
}

export async function saveDrafts(drafts: Scenario[]): Promise<void> {
  await chrome.storage.local.set({ [K_DRAFTS]: drafts });
}

export async function saveActiveId(activeId: string | null): Promise<void> {
  await chrome.storage.local.set({ [K_ACTIVE]: activeId });
}

// ---- Team mirror ---------------------------------------------------------------

export interface TeamState {
  suites: Suite[];
  team: Scenario[];
  snapshot: Scenario[];
  /** Latest release per suite id. */
  releases: Record<string, Release>;
}

export async function loadTeam(): Promise<TeamState & { activeSuiteId: string }> {
  const v = await chrome.storage.local.get([K_TEAM, K_TEAM_SNAPSHOT, K_TEAM_SUITES, K_TEAM_RELEASES, K_ACTIVE_SUITE]);
  return {
    suites: Array.isArray(v[K_TEAM_SUITES]) ? v[K_TEAM_SUITES] : [],
    team: Array.isArray(v[K_TEAM]) ? v[K_TEAM] : [],
    snapshot: Array.isArray(v[K_TEAM_SNAPSHOT]) ? v[K_TEAM_SNAPSHOT] : [],
    releases: v[K_TEAM_RELEASES] && typeof v[K_TEAM_RELEASES] === 'object' ? v[K_TEAM_RELEASES] : {},
    activeSuiteId: typeof v[K_ACTIVE_SUITE] === 'string' ? v[K_ACTIVE_SUITE] : DEFAULT_SUITE_ID,
  };
}

export async function saveTeam(state: TeamState): Promise<void> {
  await chrome.storage.local.set({
    [K_TEAM]: state.team,
    [K_TEAM_SNAPSHOT]: state.snapshot,
    [K_TEAM_SUITES]: state.suites,
    [K_TEAM_RELEASES]: state.releases,
  });
}

export async function saveActiveSuite(id: string): Promise<void> {
  await chrome.storage.local.set({ [K_ACTIVE_SUITE]: id });
}

/** What counts as "the same scenario" for change detection (timestamps excluded). */
const fingerprint = (s: Scenario) =>
  JSON.stringify({ name: s.name, steps: s.steps, suiteId: s.suiteId, folder: s.folder ?? '' });

export interface TeamChanges {
  added: string[];
  changed: string[];
  deleted: string[];
}

/** Diff the working team set against the last published snapshot. */
export function teamChanges(team: Scenario[], snapshot: Scenario[]): TeamChanges {
  const base = new Map(snapshot.map((s) => [s.id, fingerprint(s)]));
  const added: string[] = [];
  const changed: string[] = [];
  for (const s of team) {
    const prev = base.get(s.id);
    if (prev === undefined) added.push(s.id);
    else if (prev !== fingerprint(s)) changed.push(s.id);
  }
  const current = new Set(team.map((s) => s.id));
  const deleted = snapshot.filter((s) => !current.has(s.id)).map((s) => s.id);
  return { added, changed, deleted };
}

export const countChanges = (c: TeamChanges) => c.added.length + c.changed.length + c.deleted.length;

/** Ids in `changes` that belong to `suiteId` (deleted ids are looked up in the snapshot). */
export function changesForSuite(changes: TeamChanges, suiteId: string, team: Scenario[], snapshot: Scenario[]): TeamChanges {
  const inSuite = (list: Scenario[]) => new Set(list.filter((s) => s.suiteId === suiteId).map((s) => s.id));
  const t = inSuite(team);
  const sn = inSuite(snapshot);
  return {
    added: changes.added.filter((id) => t.has(id)),
    changed: changes.changed.filter((id) => t.has(id)),
    deleted: changes.deleted.filter((id) => sn.has(id)),
  };
}

// ---- Rebase: keep my unpublished changes on top of what others published ------

export interface Conflict {
  id: string;
  /** My version, or null if I deleted it. */
  mine: Scenario | null;
  /** The server's version, or null if someone else deleted it. */
  theirs: Scenario | null;
}

export interface Rebase {
  /** Server state with my non-conflicting changes re-applied. Conflicts resolve to the server side here. */
  merged: Scenario[];
  conflicts: Conflict[];
}

/**
 * Three-way merge at scenario granularity: `snapshot` is the common base,
 * `team` is mine, `server` is theirs. A scenario only I touched keeps my
 * version; one only they touched takes theirs; one we both touched (or one
 * side deleted while the other edited) is a conflict for the user to decide.
 */
export function rebase(team: Scenario[], snapshot: Scenario[], server: Scenario[]): Rebase {
  const base = new Map(snapshot.map((s) => [s.id, s]));
  const mine = new Map(team.map((s) => [s.id, s]));
  const theirs = new Map(server.map((s) => [s.id, s]));
  const fp = (s: Scenario | undefined) => (s ? fingerprint(s) : undefined);
  const result = new Map(theirs);
  const conflicts: Conflict[] = [];
  const changes = teamChanges(team, snapshot);

  for (const id of changes.added) {
    const t = theirs.get(id);
    if (!t || fp(t) === fp(mine.get(id))) result.set(id, mine.get(id)!);
    else conflicts.push({ id, mine: mine.get(id)!, theirs: t });
  }
  for (const id of changes.changed) {
    const m = mine.get(id)!;
    const t = theirs.get(id);
    if (!t) conflicts.push({ id, mine: m, theirs: null }); // they deleted, I edited
    else if (fp(t) === fp(base.get(id)) || fp(t) === fp(m)) result.set(id, m); // untouched by them, or same edit
    else conflicts.push({ id, mine: m, theirs: t });
  }
  for (const id of changes.deleted) {
    const t = theirs.get(id);
    if (!t) continue; // already gone
    if (fp(t) === fp(base.get(id))) result.delete(id); // they didn't touch it
    else conflicts.push({ id, mine: null, theirs: t }); // I deleted, they edited
  }
  return { merged: [...result.values()], conflicts };
}

/** Apply the user's choice for one conflict onto a merged list. */
export function resolveConflict(merged: Scenario[], c: Conflict, keepMine: boolean): Scenario[] {
  if (!keepMine) return merged; // server side is already what `merged` holds
  const without = merged.filter((s) => s.id !== c.id);
  return c.mine ? [...without, c.mine] : without;
}

// ---- Replay option -------------------------------------------------------------

export async function loadContinueOnFailure(): Promise<boolean> {
  const v = await chrome.storage.local.get(K_CONTINUE);
  return v[K_CONTINUE] === true;
}

export async function saveContinueOnFailure(on: boolean): Promise<void> {
  await chrome.storage.local.set({ [K_CONTINUE]: on });
}
