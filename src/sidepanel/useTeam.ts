import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DEFAULT_SUITE_ID, type Release, type Scenario, type Suite } from '../shared/types';
import {
  loadTeam,
  saveTeam,
  saveActiveSuite,
  makeSuite,
  teamChanges,
  changesForSuite,
  countChanges,
  rebase,
  resolveConflict,
  type TeamChanges,
} from '../shared/scenarios';
import {
  hasConfig,
  getSessionEmail,
  signIn as sbSignIn,
  signOut as sbSignOut,
  checkPublisher,
  fetchTeam,
  publishSuite,
  saveSuite,
} from './supabase';

// ---------------------------------------------------------------------------
// Team scenario set: the local mirror of what is published (all suites), the
// publisher session, and the operations on it - refresh (server →
// local, re-applying my unpublished changes), publish (local → server as a
// new release of one suite), and suite management.
// ---------------------------------------------------------------------------

export interface Team {
  /** False for a build without Supabase settings - the team section is hidden. */
  enabled: boolean;
  loaded: boolean;
  email: string | null;
  isPublisher: boolean;

  suites: Suite[];
  activeSuiteId: string;
  activeSuite: Suite | null;
  setActiveSuite: (id: string) => void;

  /** Every team scenario across suites (the working copy). */
  team: Scenario[];
  setTeam: React.Dispatch<React.SetStateAction<Scenario[]>>;
  /** The active suite's scenarios, sorted by name. */
  suiteScenarios: Scenario[];
  /** Last state received from / published to the server (for showing deleted items). */
  snapshot: Scenario[];
  /** Folder names of the active suite: the suite's ordered list plus any folder a scenario still references. */
  folders: string[];
  addFolder: (name: string) => Promise<void>;
  renameFolder: (from: string, to: string) => Promise<void>;
  /** Remove a folder; its scenarios become 미분류 (unpublished change). */
  removeFolder: (name: string) => Promise<void>;
  /** Latest release of the active suite. */
  release: Release | null;

  /** Unpublished changes in the active suite. */
  suiteChanges: TeamChanges;
  pendingCount: number;
  /** Unpublished changes across all suites. */
  totalPending: number;

  busy: boolean;
  status: string;
  /** Pull the server state. My unpublished changes are re-applied on top unless `discardMine`. */
  refresh: (discardMine?: boolean) => Promise<void>;
  /** Publish the active suite's pending changes (all, or just `ids`) as its next release. */
  publish: (ids?: string[]) => Promise<void>;

  createSuite: (name: string) => Promise<void>;
  renameSuite: (name: string) => Promise<void>;
  archiveSuite: (archived: boolean) => Promise<void>;
  /** New suite with copies of the active suite's scenarios (copies are unpublished until ↑ 게시). */
  duplicateSuite: (name: string) => Promise<void>;

  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const byName = (a: Scenario, b: Scenario) => a.name.localeCompare(b.name, 'ko');

export function useTeam(): Team {
  const enabled = hasConfig();
  const [loaded, setLoaded] = useState(false);
  const [email, setEmail] = useState<string | null>(null);
  const [isPublisher, setIsPublisher] = useState(false);
  const [suites, setSuites] = useState<Suite[]>([]);
  const [activeSuiteId, setActiveSuiteId] = useState<string>(DEFAULT_SUITE_ID);
  const [team, setTeam] = useState<Scenario[]>([]);
  const [snapshot, setSnapshot] = useState<Scenario[]>([]);
  const [releases, setReleases] = useState<Record<string, Release>>({});
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');

  // Latest values for async operations (refresh/publish await network calls and must not read stale closures).
  const teamRef = useRef(team);
  const snapshotRef = useRef(snapshot);
  useEffect(() => {
    teamRef.current = team;
    snapshotRef.current = snapshot;
  }, [team, snapshot]);

  const activeSuite = useMemo(() => suites.find((s) => s.id === activeSuiteId) ?? null, [suites, activeSuiteId]);
  const suiteScenarios = useMemo(
    () => team.filter((s) => (s.suiteId ?? DEFAULT_SUITE_ID) === activeSuiteId).sort(byName),
    [team, activeSuiteId],
  );
  const folders = useMemo(() => {
    const out = [...(activeSuite?.folders ?? [])];
    for (const s of suiteScenarios) if (s.folder && !out.includes(s.folder)) out.push(s.folder);
    return out;
  }, [activeSuite, suiteScenarios]);
  const changes = useMemo(() => teamChanges(team, snapshot), [team, snapshot]);
  const suiteChanges = useMemo(
    () => changesForSuite(changes, activeSuiteId, team, snapshot),
    [changes, activeSuiteId, team, snapshot],
  );
  const pendingCount = countChanges(suiteChanges);
  const totalPending = countChanges(changes);
  const release = releases[activeSuiteId] ?? null;

  // ---- load the local mirror + session once ----
  useEffect(() => {
    (async () => {
      const t = await loadTeam();
      setSuites(t.suites);
      setTeam(t.team);
      setSnapshot(t.snapshot);
      setReleases(t.releases);
      setActiveSuiteId(t.activeSuiteId);
      if (enabled) {
        try {
          const e = await getSessionEmail();
          setEmail(e);
          if (e) setIsPublisher(await checkPublisher(e));
        } catch {
          /* no session - runner */
        }
      }
      setLoaded(true);
    })();
  }, [enabled]);

  // ---- persist ----
  useEffect(() => {
    if (loaded) saveTeam({ suites, team, snapshot, releases });
  }, [suites, team, snapshot, releases, loaded]);
  useEffect(() => {
    if (loaded) saveActiveSuite(activeSuiteId);
  }, [activeSuiteId, loaded]);

  // ---- keep the active suite valid (deferred: not a synchronous setState in an effect) ----
  useEffect(() => {
    if (!loaded || suites.length === 0 || suites.some((s) => s.id === activeSuiteId)) return;
    const t = setTimeout(() => setActiveSuiteId((suites.find((s) => !s.archived) ?? suites[0]).id), 0);
    return () => clearTimeout(t);
  }, [loaded, suites, activeSuiteId]);

  /** Fetch + rebase; returns the resulting working copy so callers can continue without waiting for a render. */
  const pull = useCallback(
    async (discardMine: boolean): Promise<{ team: Scenario[]; snapshot: Scenario[] }> => {
      const fetched = await fetchTeam();
      setSuites(fetched.suites);
      setReleases(fetched.releases);
      const mine = teamRef.current;
      const base = snapshotRef.current;
      const pending = countChanges(teamChanges(mine, base));
      if (discardMine || pending === 0) {
        setTeam(fetched.scenarios);
        setSnapshot(fetched.scenarios);
        setStatus(`서버에서 받음 · 버전 ${fetched.suites.length}개, 시나리오 ${fetched.scenarios.length}개`);
        return { team: fetched.scenarios, snapshot: fetched.scenarios };
      }
      const { merged, conflicts } = rebase(mine, base, fetched.scenarios);
      let result = merged;
      let kept = 0;
      for (const c of conflicts) {
        const name = (c.mine ?? c.theirs)!.name;
        const what = !c.mine ? '내가 삭제했는데 다른 게시자가 고쳤어요' : !c.theirs ? '내가 고쳤는데 다른 게시자가 삭제했어요' : '나도 고쳤고 다른 게시자도 고쳤어요';
        const keepMine = confirm(`"${name}" - ${what}.\n\n확인: 내 것 유지\n취소: 서버 것으로`);
        if (keepMine) kept++;
        result = resolveConflict(result, c, keepMine);
      }
      setTeam(result);
      setSnapshot(fetched.scenarios);
      const left = countChanges(teamChanges(result, fetched.scenarios));
      setStatus(
        `서버에서 받음 · 내 변경 ${left}개 유지${conflicts.length ? ` · 충돌 ${conflicts.length}개 중 ${kept}개 내 것 선택` : ''}`,
      );
      return { team: result, snapshot: fetched.scenarios };
    },
    [],
  );

  const refresh = useCallback(
    async (discardMine = false) => {
      if (!enabled) return;
      setBusy(true);
      try {
        await pull(discardMine);
      } catch (e) {
        setStatus(`불러오기 실패: ${(e as Error).message}`);
      } finally {
        setBusy(false);
      }
    },
    [enabled, pull],
  );

  // ---- auto refresh when the panel opens ----
  useEffect(() => {
    if (!loaded || !enabled) return;
    const t = setTimeout(() => refresh(false), 0);
    return () => clearTimeout(t);
  }, [loaded, enabled, refresh]);

  const publish = useCallback(
    async (ids?: string[]) => {
      if (!enabled || !email || !isPublisher) return;
      setBusy(true);
      try {
        // Rebase on the latest server state first so we never overwrite another publisher's work.
        const { team: t, snapshot: sn } = await pull(false);
        const ch = changesForSuite(teamChanges(t, sn), activeSuiteId, t, sn);
        const wanted = ids ? new Set(ids) : null;
        const pick = (list: string[]) => (wanted ? list.filter((id) => wanted.has(id)) : list);
        const upsertIds = new Set([...pick(ch.added), ...pick(ch.changed)]);
        const upserts = t.filter((s) => upsertIds.has(s.id));
        const removed = pick(ch.deleted);
        if (!upserts.length && !removed.length) {
          setStatus('게시할 변경이 없어요.');
          return;
        }
        const r = await publishSuite(activeSuiteId, upserts, removed, email);
        const removedSet = new Set(removed);
        setSnapshot([...sn.filter((s) => !removedSet.has(s.id) && !upsertIds.has(s.id)), ...upserts]);
        setReleases((prev) => ({ ...prev, [activeSuiteId]: r }));
        setStatus(`${r.version}번째 게시 완료 · 변경 ${upserts.length + removed.length}개`);
      } catch (e) {
        setStatus(`게시 실패: ${(e as Error).message}`);
      } finally {
        setBusy(false);
      }
    },
    [enabled, email, isPublisher, activeSuiteId, pull],
  );

  const writeSuite = useCallback(async (suite: Suite) => {
    setSuites((prev) => (prev.some((s) => s.id === suite.id) ? prev.map((s) => (s.id === suite.id ? suite : s)) : [...prev, suite]));
    try {
      await saveSuite(suite);
    } catch (e) {
      setStatus(`버전 저장 실패: ${(e as Error).message}`);
    }
  }, []);

  // ---- suites ----
  const createSuite = useCallback(
    async (name: string) => {
      if (!isPublisher) return;
      const s = makeSuite(name);
      await writeSuite(s);
      setActiveSuiteId(s.id);
    },
    [isPublisher, writeSuite],
  );
  const renameSuite = useCallback(
    async (name: string) => {
      if (!activeSuite || !isPublisher) return;
      await writeSuite({ ...activeSuite, name, updatedAt: Date.now() });
    },
    [activeSuite, isPublisher, writeSuite],
  );
  const archiveSuite = useCallback(
    async (archived: boolean) => {
      if (!activeSuite || !isPublisher) return;
      await writeSuite({ ...activeSuite, archived, updatedAt: Date.now() });
    },
    [activeSuite, isPublisher, writeSuite],
  );
  const addFolder = useCallback(
    async (name: string) => {
      if (!activeSuite || !isPublisher || !name.trim() || folders.includes(name.trim())) return;
      await writeSuite({ ...activeSuite, folders: [...folders, name.trim()], updatedAt: Date.now() });
    },
    [activeSuite, isPublisher, folders, writeSuite],
  );
  const renameFolder = useCallback(
    async (from: string, to: string) => {
      const next = to.trim();
      if (!activeSuite || !isPublisher || !next || next === from) return;
      await writeSuite({
        ...activeSuite,
        folders: folders.map((f) => (f === from ? next : f)),
        updatedAt: Date.now(),
      });
      setTeam((prev) =>
        prev.map((s) =>
          s.suiteId === activeSuite.id && s.folder === from ? { ...s, folder: next, updatedAt: Date.now() } : s,
        ),
      );
    },
    [activeSuite, isPublisher, folders, writeSuite],
  );
  const removeFolder = useCallback(
    async (name: string) => {
      if (!activeSuite || !isPublisher) return;
      await writeSuite({ ...activeSuite, folders: folders.filter((f) => f !== name), updatedAt: Date.now() });
      setTeam((prev) =>
        prev.map((s) =>
          s.suiteId === activeSuite.id && s.folder === name ? { ...s, folder: undefined, updatedAt: Date.now() } : s,
        ),
      );
    },
    [activeSuite, isPublisher, folders, writeSuite],
  );
  const duplicateSuite = useCallback(
    async (name: string) => {
      if (!activeSuite || !isPublisher) return;
      const s = { ...makeSuite(name), folders: [...folders] };
      await writeSuite(s);
      const now = Date.now();
      const copies = suiteScenarios.map((sc) => ({
        ...structuredClone(sc),
        id: crypto.randomUUID(),
        suiteId: s.id,
        createdAt: now,
        updatedAt: now,
      }));
      setTeam((prev) => [...prev, ...copies]);
      setActiveSuiteId(s.id);
      setStatus(`버전 "${name}" 생성 · 시나리오 ${copies.length}개 복사됨 (게시 전)`);
    },
    [activeSuite, isPublisher, suiteScenarios, folders, writeSuite],
  );

  // ---- auth ----
  const signIn = useCallback(async (mail: string, password: string) => {
    const e = await sbSignIn(mail, password);
    setEmail(e);
    const pub = await checkPublisher(e);
    setIsPublisher(pub);
    if (!pub) throw new Error('로그인은 됐지만 게시 권한이 없어요. publishers 테이블에 이 이메일을 추가하세요.');
  }, []);
  const signOut = useCallback(async () => {
    await sbSignOut();
    setEmail(null);
    setIsPublisher(false);
  }, []);

  return {
    enabled,
    loaded,
    email,
    isPublisher,
    suites,
    activeSuiteId,
    activeSuite,
    setActiveSuite: setActiveSuiteId,
    team,
    setTeam,
    suiteScenarios,
    snapshot,
    folders,
    addFolder,
    renameFolder,
    removeFolder,
    release,
    suiteChanges,
    pendingCount,
    totalPending,
    busy,
    status,
    refresh,
    publish,
    createSuite,
    renameSuite,
    archiveSuite,
    duplicateSuite,
    signIn,
    signOut,
  };
}
