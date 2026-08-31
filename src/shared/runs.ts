import type { RunRecord } from './types';

// ---------------------------------------------------------------------------
// Run history: every full replay is recorded locally (chrome.storage.local),
// capped per scenario so failure screenshots don't eat the storage quota.
// Not synced — a run is a fact about *this* browser at *that* time.
// ---------------------------------------------------------------------------

const K_RUNS = 'po-cake:runs';
export const MAX_RUNS_PER_SCENARIO = 10;

async function loadAll(): Promise<RunRecord[]> {
  const v = await chrome.storage.local.get(K_RUNS);
  return Array.isArray(v[K_RUNS]) ? (v[K_RUNS] as RunRecord[]) : [];
}

async function saveAll(runs: RunRecord[]): Promise<void> {
  await chrome.storage.local.set({ [K_RUNS]: runs });
}

/** Runs for one scenario, newest first. */
export async function loadRuns(scenarioId: string): Promise<RunRecord[]> {
  const all = await loadAll();
  return all.filter((r) => r.scenarioId === scenarioId).sort((a, b) => b.startedAt - a.startedAt);
}

/** Append a run and drop the oldest beyond the per-scenario cap. Returns the scenario's runs. */
export async function appendRun(run: RunRecord): Promise<RunRecord[]> {
  const all = await loadAll();
  const others = all.filter((r) => r.scenarioId !== run.scenarioId);
  const mine = [run, ...all.filter((r) => r.scenarioId === run.scenarioId)]
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, MAX_RUNS_PER_SCENARIO);
  await saveAll([...others, ...mine]);
  return mine;
}

export async function clearRuns(scenarioId: string): Promise<void> {
  const all = await loadAll();
  await saveAll(all.filter((r) => r.scenarioId !== scenarioId));
}
