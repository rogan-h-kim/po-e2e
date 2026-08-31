import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Command, Event } from '../shared/messages';
import {
  KEY_NAMES,
  type RunRecord,
  type Scenario,
  type Selector,
  type Step,
  type StepDraft,
  type StepResult,
} from '../shared/types';
import {
  loadScenarios,
  saveScenarios,
  makeScenario,
  mergeByUpdatedAt,
  loadSyncMeta,
  saveSyncMeta,
  computeStatus,
  loadViewerMode,
  saveViewerMode,
  loadContinueOnFailure,
  saveContinueOnFailure,
  type SyncStatus,
} from '../shared/scenarios';
import { loadRuns, appendRun, clearRuns } from '../shared/runs';
import { defaultDescription, describeSelector } from '../shared/describe';
import { uid } from '../shared/uid';
import type { SyncCounts } from './SyncBar';
import {
  type SupabaseConfig,
  loadConfig,
  hasStoredConfig,
  pullRemote,
  pushRemote,
  deleteRemote,
} from './supabase';
import { StepRow, normalizeUrl, type StepPatch } from './StepRow';
import { ScenarioBar } from './ScenarioBar';
import { SyncBar } from './SyncBar';
import { RunHistory } from './RunHistory';

async function send(command: Command): Promise<{ ok: boolean; error?: string } | undefined> {
  try {
    return await chrome.runtime.sendMessage(command);
  } catch {
    return undefined;
  }
}

export default function App() {
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const [inspecting, setInspecting] = useState(false);
  const [recording, setRecording] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [results, setResults] = useState<Record<string, StepResult>>({});
  const [runningId, setRunningId] = useState<string | null>(null);
  const [continueOnFailure, setContinueOnFailure] = useState(false);
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  /** Set while a full replay is in flight so PLAY_DONE knows what to record. */
  const runRef = useRef<{ scenarioId: string; steps: Step[] } | null>(null);
  const [pending, setPending] = useState<Selector | null>(null);
  const [viewer, setViewer] = useState(false);

  const [config, setConfig] = useState<SupabaseConfig | null>(null);
  const [configFromEnv, setConfigFromEnv] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncStatus, setSyncStatus] = useState('');
  const [syncMeta, setSyncMeta] = useState<Record<string, number>>({});
  const [remoteMeta, setRemoteMeta] = useState<Record<string, number>>({});
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null);

  const activeIdRef = useRef<string | null>(null);
  useEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);

  const active = useMemo(() => scenarios.find((s) => s.id === activeId) ?? null, [scenarios, activeId]);
  const steps = active?.steps ?? [];

  // ---- load once ----
  useEffect(() => {
    (async () => {
      const [{ scenarios: sc, activeId: aid }, cfg, stored, meta, vm, cof] = await Promise.all([
        loadScenarios(),
        loadConfig(),
        hasStoredConfig(),
        loadSyncMeta(),
        loadViewerMode(),
        loadContinueOnFailure(),
      ]);
      setSyncMeta(meta);
      setViewer(vm);
      setContinueOnFailure(cof);
      let list = sc;
      let id = aid;
      if (list.length === 0) {
        const def = makeScenario('새 시나리오');
        list = [def];
        id = def.id;
      }
      setScenarios(list);
      setActiveId(id);
      setConfig(cfg);
      setConfigFromEnv(!!cfg && !stored);
      setLoaded(true);
    })();
  }, []);

  // ---- persist ----
  useEffect(() => {
    if (loaded) saveScenarios({ scenarios, activeId });
  }, [scenarios, activeId, loaded]);
  useEffect(() => {
    if (loaded) saveSyncMeta(syncMeta);
  }, [syncMeta, loaded]);

  // ---- run history for the active scenario ----
  useEffect(() => {
    let cancelled = false;
    (activeId ? loadRuns(activeId) : Promise.resolve([])).then((r) => {
      if (!cancelled) setRuns(r);
    });
    return () => {
      cancelled = true;
    };
  }, [activeId]);

  // ---- per-scenario sync status ----
  const statuses = useMemo<Record<string, SyncStatus>>(
    () => Object.fromEntries(scenarios.map((s) => [s.id, computeStatus(s, syncMeta, remoteMeta)])),
    [scenarios, syncMeta, remoteMeta],
  );
  const counts = useMemo<SyncCounts>(() => {
    const c: SyncCounts = { localOnly: 0, dirty: 0, synced: 0, remoteNewer: 0 };
    for (const s of scenarios) {
      const st = statuses[s.id];
      if (st === 'local-only') c.localOnly++;
      else if (st === 'dirty') c.dirty++;
      else if (st === 'synced') c.synced++;
      else if (st === 'remote-newer') c.remoteNewer++;
    }
    return c;
  }, [scenarios, statuses]);

  // ---- mutate the active scenario's steps ----
  // Reads the active id through a ref so these stay referentially stable and
  // the message listener below can be registered once.
  const updateActiveSteps = useCallback((updater: (s: Step[]) => Step[]) => {
    const id = activeIdRef.current;
    setScenarios((prev) =>
      prev.map((s) => (s.id === id ? { ...s, steps: updater(s.steps), updatedAt: Date.now() } : s)),
    );
  }, []);
  const appendStep = useCallback(
    (step: Step) => updateActiveSteps((s) => [...s, step]),
    [updateActiveSteps],
  );
  /** Apply an edit; regenerate the description unless the user had customised it. */
  const editStep = (id: string, patch: StepPatch) =>
    updateActiveSteps((list) =>
      list.map((s) => {
        if (s.id !== id) return s;
        const wasDefault = s.description === defaultDescription(s);
        const next = { ...s, ...patch } as Step;
        if (patch.description === undefined && wasDefault) next.description = defaultDescription(next);
        return next;
      }),
    );
  const moveStep = (id: string, delta: -1 | 1) =>
    updateActiveSteps((list) => {
      const i = list.findIndex((s) => s.id === id);
      const j = i + delta;
      if (i < 0 || j < 0 || j >= list.length) return list;
      const next = [...list];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });

  const currentTabUrl = async (): Promise<string> => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    return tab?.url ?? '';
  };

  // ---- events from content/background ----
  useEffect(() => {
    const handler = (msg: Event) => {
      switch (msg.type) {
        case 'ELEMENT_PICKED':
          setPending(msg.selector);
          setInspecting(false);
          break;
        case 'STEP_RECORDED':
          appendStep(msg.step);
          break;
        case 'INSPECT_ENDED':
          setInspecting(false);
          break;
        case 'RECORD_ENDED':
          setRecording(false);
          break;
        case 'PLAY_STEP_START':
          setRunningId(msg.stepId);
          break;
        case 'PLAY_PROGRESS':
          setResults((r) => ({ ...r, [msg.result.stepId]: msg.result }));
          break;
        case 'PLAY_DONE': {
          setPlaying(false);
          setRunningId(null);
          const run = runRef.current;
          runRef.current = null;
          if (!run) break; // single-step play — not a run
          const firstFail = msg.results.find((r) => !r.ok);
          const record: RunRecord = {
            id: crypto.randomUUID(),
            scenarioId: run.scenarioId,
            startedAt: msg.startedAt,
            finishedAt: msg.finishedAt,
            stepCount: run.steps.length,
            ok: !firstFail && msg.results.length === run.steps.length,
            results: msg.results,
            failedStep: firstFail
              ? run.steps.find((s) => s.id === firstFail.stepId)?.description
              : undefined,
          };
          appendRun(record).then((list) => {
            if (activeIdRef.current === run.scenarioId) setRuns(list);
          });
          setSelectedRunId(record.id);
          break;
        }
      }
    };
    chrome.runtime.onMessage.addListener(handler);
    return () => chrome.runtime.onMessage.removeListener(handler);
  }, [appendStep]);

  // ---- scenario actions ----
  const selectScenario = (id: string) => {
    setActiveId(id);
    setResults({});
    setRunningId(null);
    setSelectedRunId(null);
    setPending(null);
  };
  const createScenario = () => {
    const name = prompt('새 시나리오 이름', `시나리오 ${scenarios.length + 1}`);
    if (!name) return;
    const sc = makeScenario(name);
    setScenarios((prev) => [...prev, sc]);
    setActiveId(sc.id);
  };
  const renameScenario = () => {
    if (!active) return;
    const name = prompt('시나리오 이름 변경', active.name);
    if (!name) return;
    setScenarios((prev) =>
      prev.map((s) => (s.id === active.id ? { ...s, name, updatedAt: Date.now() } : s)),
    );
  };
  const duplicateScenario = () => {
    if (!active) return;
    const copy = makeScenario(`${active.name} (복사본)`, structuredClone(active.steps));
    setScenarios((prev) => [...prev, copy]);
    setActiveId(copy.id);
  };
  const deleteScenario = async () => {
    if (!active) return;
    // A scenario "exists remotely" only if it was ever synced (not 🔵 local-only).
    const existsRemotely = config != null && statuses[active.id] !== 'local-only';
    const warn = existsRemotely
      ? `"${active.name}" 시나리오를 삭제할까요?\n\n⚠️ 팀 공유 저장소에서도 삭제되어 팀원 모두에게서 사라집니다.`
      : `"${active.name}" 시나리오를 삭제할까요?\n(아직 안 올렸으므로 이 브라우저에서만 삭제됩니다.)`;
    if (!confirm(warn)) return;
    const id = active.id;
    clearRuns(id);
    const rest = scenarios.filter((s) => s.id !== id);
    setScenarios(rest.length ? rest : [makeScenario('새 시나리오')]);
    setActiveId((rest[0] ?? null)?.id ?? null);
    setSyncMeta((m) => {
      const next = { ...m };
      delete next[id];
      return next;
    });
    if (existsRemotely) {
      try {
        await deleteRemote(config!, id);
      } catch {
        /* ignore remote delete failure */
      }
    }
  };

  // ---- inspect / record ----
  const toggleInspect = async () => {
    if (inspecting) {
      send({ type: 'STOP_INSPECT' });
      setInspecting(false);
      return;
    }
    setPending(null);
    setInspecting(true);
    const res = await send({ type: 'START_INSPECT' });
    if (res && res.ok === false) {
      setInspecting(false);
      alert(`요소 선택을 시작할 수 없어요.\n${res.error ?? ''}\n\n대상 탭을 새로고침(F5) 후 다시 시도하세요.`);
    }
  };
  const toggleRecord = async () => {
    if (recording) {
      send({ type: 'STOP_RECORD' });
      setRecording(false);
      return;
    }
    setRecording(true);
    const res = await send({ type: 'START_RECORD' });
    if (res && res.ok === false) {
      setRecording(false);
      alert(`녹화를 시작할 수 없어요.\n${res.error ?? ''}\n\n대상 탭을 새로고침(F5) 후 다시 시도하세요.`);
      return;
    }
    // An empty scenario gets the page it was recorded on as its first step, so
    // whoever replays it lands on the right page regardless of where they start.
    if (steps.length === 0) {
      const url = await currentTabUrl();
      if (/^https?:/.test(url)) appendStep(makeStep({ type: 'navigate', url }));
    }
  };

  // ---- step add from pending selection ----
  const addAssertTextFromPending = () => {
    if (!pending) return;
    const text = prompt('영역에 포함되어야 할 텍스트');
    if (text === null || !text.trim()) return;
    appendStep(makeStep({ type: 'assertText', selector: pending, text: text.trim(), match: 'contains' }));
    setPending(null);
  };
  const addAssertValueFromPending = () => {
    if (!pending) return;
    const value = prompt('입력 요소가 가져야 할 값');
    if (value === null) return;
    appendStep(makeStep({ type: 'assertValue', selector: pending, value }));
    setPending(null);
  };
  const addAssertUrl = async () => {
    const url = prompt('URL에 포함되어야 할 문자열 (예: /orders/done)', await currentTabUrl());
    if (!url?.trim()) return;
    appendStep(makeStep({ type: 'assertUrl', url: url.trim(), match: 'contains' }));
  };
  const addStepFromPending = (type: 'click' | 'assertVisible' | 'assertHasText') => {
    if (!pending) return;
    appendStep(makeStep({ type, selector: pending }));
    setPending(null);
  };
  const addInputFromPending = () => {
    if (!pending) return;
    const value = prompt('입력할 값을 적어주세요');
    if (value === null) return;
    appendStep(makeStep({ type: 'input', selector: pending, value }));
    setPending(null);
  };
  const addSelectFromPending = () => {
    if (!pending) return;
    const label = prompt('선택할 옵션의 표시 텍스트(또는 value)를 적어주세요');
    if (label === null) return;
    appendStep(makeStep({ type: 'select', selector: pending, value: label, label }));
    setPending(null);
  };
  const addWait = () => {
    const ms = Number(prompt('대기 시간(ms)', '1000')) || 1000;
    appendStep(makeStep({ type: 'wait', ms }));
  };
  const addNavigate = async () => {
    const url = prompt('이동할 URL', await currentTabUrl());
    if (!url?.trim()) return;
    appendStep(makeStep({ type: 'navigate', url: normalizeUrl(url) }));
  };
  const addKey = () => {
    const raw = prompt(`누를 키 (${KEY_NAMES.join(', ')})`, 'Enter')?.trim();
    if (!raw) return;
    const key = KEY_NAMES.find((k) => k.toLowerCase() === raw.toLowerCase());
    if (!key) {
      alert(`지원하지 않는 키예요: ${raw}`);
      return;
    }
    appendStep(makeStep({ type: 'key', key }));
  };

  // ---- play ----
  const playAll = () => {
    if (!steps.length || !active) return;
    setResults({});
    setSelectedRunId(null);
    setPlaying(true);
    runRef.current = { scenarioId: active.id, steps };
    send({ type: 'PLAY', steps, continueOnFailure }).then((res) => {
      // The background refuses a PLAY while the tab is busy (or the tab can't
      // be reached). No PLAY_DONE will come, so unwind the UI here.
      if (res && res.ok === false) {
        runRef.current = null;
        setPlaying(false);
        alert(`재생을 시작할 수 없어요.\n${res.error ?? ''}`);
      }
    });
  };
  const changeContinueOnFailure = (on: boolean) => {
    setContinueOnFailure(on);
    saveContinueOnFailure(on);
  };
  /** Show a past run's results on the step list (steps deleted since are simply skipped). */
  const showRun = (run: RunRecord) => {
    setSelectedRunId(run.id);
    setResults(Object.fromEntries(run.results.map((r) => [r.stepId, r])));
  };
  const clearRunHistory = async () => {
    if (!active || !confirm('이 시나리오의 실행 기록을 모두 지울까요?')) return;
    await clearRuns(active.id);
    setRuns([]);
    setSelectedRunId(null);
  };
  const playOne = async (step: Step) => {
    const res = await send({ type: 'PLAY_STEP', step });
    if (res && res.ok === false) alert(`단계를 실행할 수 없어요.\n${res.error ?? ''}`);
  };
  const removeStep = (id: string) => updateActiveSteps((s) => s.filter((x) => x.id !== id));
  const changeViewer = (on: boolean) => {
    setViewer(on);
    saveViewerMode(on);
  };

  // ---- import / export (single active scenario as JSON) ----
  const fileRef = useRef<HTMLInputElement>(null);
  const exportJson = () => {
    if (!active) return;
    const blob = new Blob([JSON.stringify(active, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${active.name.replace(/\s+/g, '-')}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };
  const importJson = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    file.text().then((t) => {
      try {
        const parsed = JSON.parse(t);
        const sc: Scenario = Array.isArray(parsed)
          ? makeScenario(file.name.replace(/\.json$/, ''), parsed)
          : { ...parsed, id: crypto.randomUUID(), updatedAt: Date.now() };
        setScenarios((prev) => [...prev, sc]);
        setActiveId(sc.id);
      } catch {
        alert('올바른 시나리오 파일이 아니에요.');
      }
    });
    e.target.value = '';
  };

  // ---- sync ----
  const withSync = async (label: string, fn: () => Promise<void>) => {
    if (!config) return;
    setSyncing(true);
    setSyncStatus(`${label} 중…`);
    try {
      await fn();
    } catch (e) {
      setSyncStatus(`실패: ${(e as Error).message}`);
    } finally {
      setSyncing(false);
    }
  };
  const doPull = () =>
    withSync('불러오기', async () => {
      const remote = await pullRemote(config!);
      const merged = mergeByUpdatedAt(scenarios, remote);
      const rMeta = Object.fromEntries(remote.map((r) => [r.id, r.updatedAt]));
      // Mark as synced only where local now equals remote (local wasn't newer).
      const meta = { ...syncMeta };
      for (const m of merged) {
        if (rMeta[m.id] !== undefined && m.updatedAt <= rMeta[m.id]) meta[m.id] = m.updatedAt;
      }
      setRemoteMeta(rMeta);
      setSyncMeta(meta);
      setScenarios(merged);
      if (!merged.some((s) => s.id === activeId)) setActiveId(merged[0]?.id ?? null);
      setLastSyncedAt(Date.now());
      setSyncStatus(`불러오기 완료 · 원격 ${remote.length}개 병합`);
    });
  const doPush = () =>
    withSync('올리기', async () => {
      await pushRemote(config!, scenarios);
      const meta = { ...syncMeta };
      const rMeta = { ...remoteMeta };
      for (const s of scenarios) {
        meta[s.id] = s.updatedAt;
        rMeta[s.id] = s.updatedAt;
      }
      setSyncMeta(meta);
      setRemoteMeta(rMeta);
      setLastSyncedAt(Date.now());
      setSyncStatus(`올리기 완료 · ${scenarios.length}개 업로드`);
    });
  const doSync = () =>
    withSync('동기화', async () => {
      const remote = await pullRemote(config!);
      const merged = mergeByUpdatedAt(scenarios, remote);
      await pushRemote(config!, merged);
      // After a two-way sync everything matches remote → all synced.
      const meta: Record<string, number> = {};
      const rMeta: Record<string, number> = {};
      for (const m of merged) {
        meta[m.id] = m.updatedAt;
        rMeta[m.id] = m.updatedAt;
      }
      setSyncMeta(meta);
      setRemoteMeta(rMeta);
      setScenarios(merged);
      if (!merged.some((s) => s.id === activeId)) setActiveId(merged[0]?.id ?? null);
      setLastSyncedAt(Date.now());
      setSyncStatus(`동기화 완료 · ${merged.length}개`);
    });

  return (
    <div className="app">
      <header>
        <h1>🍰 Po-Cake</h1>
        <span className="sub">접근성 기반 E2E 레코더</span>
      </header>

      <ScenarioBar
        scenarios={scenarios}
        activeId={activeId}
        statuses={statuses}
        teamShareOn={!!config}
        viewer={viewer}
        onSelect={selectScenario}
        onCreate={createScenario}
        onRename={renameScenario}
        onDuplicate={duplicateScenario}
        onDelete={deleteScenario}
      />

      <SyncBar
        config={config}
        usingDefault={configFromEnv}
        syncing={syncing}
        status={syncStatus}
        counts={counts}
        lastSyncedAt={lastSyncedAt}
        viewer={viewer}
        onConfigChange={(cfg, fromEnv) => {
          setConfig(cfg);
          setConfigFromEnv(fromEnv);
        }}
        onViewerChange={changeViewer}
        onPush={doPush}
        onPull={doPull}
        onSync={doSync}
      />

      {!viewer && (
        <section className="toolbar">
          <button className={inspecting ? 'active' : ''} onClick={toggleInspect}>
            {inspecting ? '요소 선택 중… (취소)' : '＋ 요소 선택'}
          </button>
          <button className={recording ? 'rec' : ''} onClick={toggleRecord}>
            {recording ? '● 녹화 중지' : '● 녹화 시작'}
          </button>
          <button onClick={addNavigate}>＋ 페이지 이동</button>
          <button onClick={addKey}>＋ 키 입력</button>
          <button onClick={addWait}>＋ 대기</button>
          <button onClick={addAssertUrl}>＋ URL 검증</button>
        </section>
      )}

      {pending && (
        <div className="pending">
          <div className="pending-label">선택됨: {describeSelector(pending)}</div>
          {pending.warning && <div className="warn">⚠ {pending.warning}</div>}
          <div className="pending-actions">
            <button onClick={() => addStepFromPending('click')}>클릭</button>
            <button onClick={addInputFromPending}>입력</button>
            <button onClick={addSelectFromPending}>옵션 선택</button>
            <button onClick={() => addStepFromPending('assertVisible')}>보임 검증</button>
            <button onClick={() => addStepFromPending('assertHasText')}>텍스트 나타남</button>
            <button onClick={addAssertTextFromPending}>텍스트 포함 검증</button>
            <button onClick={addAssertValueFromPending}>값 검증</button>
            <button className="ghost" onClick={() => setPending(null)}>
              취소
            </button>
          </div>
        </div>
      )}

      <section className="steps">
        {steps.length === 0 ? (
          <p className="empty">
            {viewer ? (
              '이 시나리오에는 단계가 없어요. 위에서 다른 시나리오를 선택하세요.'
            ) : (
              <>
                아직 단계가 없어요. <b>녹화 시작</b>으로 클릭·입력을 자동 기록하거나, <b>요소 선택</b>으로 하나씩
                추가하세요.
              </>
            )}
          </p>
        ) : (
          <ol>
            {steps.map((step, i) => (
              <StepRow
                key={step.id}
                index={i + 1}
                step={step}
                result={results[step.id]}
                running={step.id === runningId}
                busy={playing}
                viewer={viewer}
                isFirst={i === 0}
                isLast={i === steps.length - 1}
                onPlay={() => playOne(step)}
                onRemove={() => removeStep(step.id)}
                onHighlight={() => 'selector' in step && send({ type: 'HIGHLIGHT', selector: step.selector })}
                onEdit={(patch) => editStep(step.id, patch)}
                onMove={(delta) => moveStep(step.id, delta)}
              />
            ))}
          </ol>
        )}
        <RunHistory runs={runs} selectedId={selectedRunId} onSelect={showRun} onClear={clearRunHistory} />
      </section>

      <footer>
        <button className="primary" disabled={!steps.length || playing} onClick={playAll}>
          {playing ? '재생 중…' : '▶ 전체 재생'}
        </button>
        <label className="continue-toggle" title="실패한 단계가 있어도 끝까지 실행해 모든 실패를 한 번에 확인">
          <input
            type="checkbox"
            checked={continueOnFailure}
            onChange={(e) => changeContinueOnFailure(e.target.checked)}
          />
          실패 시 계속
        </label>
        {!viewer && (
          <div className="footer-right">
            <button className="ghost small" onClick={exportJson} disabled={!active}>
              내보내기
            </button>
            <button className="ghost small" onClick={() => fileRef.current?.click()}>
              불러오기
            </button>
            <input ref={fileRef} type="file" accept="application/json" hidden onChange={importJson} />
          </div>
        )}
      </footer>
    </div>
  );
}
/** Build a step with a fresh id and the standard description. */
function makeStep(partial: StepDraft): Step {
  const step = { ...partial, id: uid(), description: '' } as Step;
  step.description = defaultDescription(step);
  return step;
}
