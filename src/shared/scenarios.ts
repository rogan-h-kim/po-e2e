import type { Scenario, Step } from './types';
import { SEED_VERSION, SEED_SCENARIOS } from './seed';

// ---------------------------------------------------------------------------
// Local scenario store (chrome.storage.local). Holds MANY named scenarios plus
// the currently-active one. Works fully offline; Supabase sync is layered on top.
// ---------------------------------------------------------------------------

const K_SCENARIOS = 'po-cake:scenarios';
const K_ACTIVE = 'po-cake:activeId';
const K_LEGACY_STEPS = 'po-cake:steps'; // previous single-scenario format
const K_SEEDVER = 'po-cake:seedVersion'; // last-applied built-in seed version
const K_VIEWER = 'po-cake:viewerMode'; // run-only mode (hides recording/editing)

export function makeScenario(name: string, steps: Step[] = []): Scenario {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    name,
    steps,
    createdAt: now,
    updatedAt: now,
  };
}

export interface LocalState {
  scenarios: Scenario[];
  activeId: string | null;
}

export async function loadScenarios(): Promise<LocalState> {
  const v = await chrome.storage.local.get([K_SCENARIOS, K_ACTIVE, K_LEGACY_STEPS, K_SEEDVER]);
  let scenarios: Scenario[] = Array.isArray(v[K_SCENARIOS]) ? v[K_SCENARIOS] : [];

  // One-time migration from the old single-scenario `po-cake:steps` key.
  if (scenarios.length === 0 && Array.isArray(v[K_LEGACY_STEPS]) && v[K_LEGACY_STEPS].length) {
    scenarios = [makeScenario('기본 시나리오', v[K_LEGACY_STEPS] as Step[])];
    await chrome.storage.local.remove(K_LEGACY_STEPS);
    await saveScenarios({ scenarios, activeId: scenarios[0].id });
  }

  // Seed: on first install, or when the bundled seed version is newer than what
  // this browser last applied, merge the built-in scenarios in. Seeded ids are
  // overwritten (the build is the source of truth for them); the user's own
  // extra scenarios are preserved. This is how a redistributed build pushes the
  // author's latest scenarios to everyone.
  const storedSeedVer = typeof v[K_SEEDVER] === 'number' ? v[K_SEEDVER] : 0;
  if (SEED_VERSION > storedSeedVer && SEED_SCENARIOS.length) {
    const map = new Map(scenarios.map((s) => [s.id, s]));
    for (const seed of SEED_SCENARIOS) map.set(seed.id, structuredClone(seed));
    scenarios = [...map.values()];
    await chrome.storage.local.set({ [K_SCENARIOS]: scenarios, [K_SEEDVER]: SEED_VERSION });
  }

  let activeId = typeof v[K_ACTIVE] === 'string' ? v[K_ACTIVE] : null;
  if (!activeId || !scenarios.some((s) => s.id === activeId)) {
    activeId = scenarios[0]?.id ?? null;
  }
  return { scenarios, activeId };
}

// ---------------------------------------------------------------------------
// Run-only ("viewer") mode. When on, the side panel hides all recording and
// editing controls so shared users can only run pre-made scenarios. Stored
// per-browser in chrome.storage.local.
// ---------------------------------------------------------------------------

export async function loadViewerMode(): Promise<boolean> {
  const v = await chrome.storage.local.get(K_VIEWER);
  return v[K_VIEWER] === true;
}

export async function saveViewerMode(on: boolean): Promise<void> {
  await chrome.storage.local.set({ [K_VIEWER]: on });
}

// Replay option: keep running after a failed step (collect every failure in
// one run) instead of stopping at the first one.
const K_CONTINUE = 'po-cake:continueOnFailure';

export async function loadContinueOnFailure(): Promise<boolean> {
  const v = await chrome.storage.local.get(K_CONTINUE);
  return v[K_CONTINUE] === true;
}

export async function saveContinueOnFailure(on: boolean): Promise<void> {
  await chrome.storage.local.set({ [K_CONTINUE]: on });
}

export async function saveScenarios(state: LocalState): Promise<void> {
  await chrome.storage.local.set({
    [K_SCENARIOS]: state.scenarios,
    [K_ACTIVE]: state.activeId,
  });
}

/** Merge two scenario sets, keeping the newer copy of each id (last-write-wins). */
export function mergeByUpdatedAt(local: Scenario[], remote: Scenario[]): Scenario[] {
  const map = new Map<string, Scenario>();
  for (const s of local) map.set(s.id, s);
  for (const r of remote) {
    const existing = map.get(r.id);
    if (!existing || r.updatedAt > existing.updatedAt) map.set(r.id, r);
  }
  return [...map.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

// ---------------------------------------------------------------------------
// Per-scenario sync status. `syncMeta` records, per id, the `updatedAt` value at
// the moment it was last successfully synced (per-browser, NOT shared).
// `remoteMeta` is the remote's `updatedAt` per id from the last pull.
// ---------------------------------------------------------------------------

export type SyncStatus = 'local-only' | 'dirty' | 'synced' | 'remote-newer';

const K_SYNCMETA = 'po-cake:syncMeta';

export async function loadSyncMeta(): Promise<Record<string, number>> {
  const v = await chrome.storage.local.get(K_SYNCMETA);
  return (v[K_SYNCMETA] as Record<string, number>) ?? {};
}

export async function saveSyncMeta(meta: Record<string, number>): Promise<void> {
  await chrome.storage.local.set({ [K_SYNCMETA]: meta });
}

export function computeStatus(
  s: Scenario,
  syncMeta: Record<string, number>,
  remoteMeta: Record<string, number>,
): SyncStatus {
  const remote = remoteMeta[s.id];
  if (remote !== undefined && remote > s.updatedAt) return 'remote-newer';
  const synced = syncMeta[s.id];
  if (synced === undefined) return 'local-only';
  if (s.updatedAt > synced) return 'dirty';
  return 'synced';
}

export const STATUS_META: Record<
  SyncStatus,
  { label: string; short: string; color: string; dot: string }
> = {
  'local-only': { label: '로컬 전용 · 아직 안 올림', short: '미업로드', color: '#3b82f6', dot: '🔵' },
  dirty: { label: '변경됨 · 올리기 필요', short: '변경됨', color: '#f59e0b', dot: '🟡' },
  synced: { label: '동기화됨', short: '동기화됨', color: '#10b981', dot: '🟢' },
  'remote-newer': { label: '원격이 최신 · 불러오기 필요', short: '원격최신', color: '#a855f7', dot: '🟣' },
};
