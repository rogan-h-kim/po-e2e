import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { Command, Event } from "../shared/messages";
import type {
  RunRecord,
  Scenario,
  Selector,
  Step,
  StepDraft,
  StepResult,
} from "../shared/types";
import {
  loadDrafts,
  saveDrafts,
  saveActiveId,
  makeScenario,
  loadContinueOnFailure,
  saveContinueOnFailure,
} from "../shared/scenarios";
import { loadRuns, appendRun, clearRuns, loadLatestRuns } from "../shared/runs";
import { defaultDescription } from "../shared/describe";
import { uid } from "../shared/uid";
import { StepRow } from "./StepRow";
import { StepForm } from "./StepForm";
import { MoreMenu } from "./MoreMenu";
import { RunHistory } from "./RunHistory";
import { SuiteHeader } from "./SuiteHeader";
import { ScenarioListTab, NO_FOLDER } from "./ScenarioListTab";
import { PublishTab } from "./PublishTab";
import { SettingsTab } from "./SettingsTab";
import type { SuiteRun } from "./SuiteRunPanel";
import { useTeam } from "./useTeam";

type Tab = "list" | "publish" | "settings";
/** The step form is either adding at an index or editing an existing step. */
type FormState =
  | { mode: "add"; index: number; selector?: Selector }
  | { mode: "edit"; id: string }
  | null;

async function send(
  command: Command,
): Promise<{ ok: boolean; error?: string } | undefined> {
  try {
    return await chrome.runtime.sendMessage(command);
  } catch {
    return undefined;
  }
}

export default function App() {
  // ---- scenarios: the published team set (via useTeam) and this browser's drafts ----
  const team = useTeam();
  const { setTeam } = team; // useState setter - referentially stable
  const [drafts, setDrafts] = useState<Scenario[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [tab, setTab] = useState<Tab>("list");
  /** Inside the 시나리오 tab: the list, or one scenario opened from it (← goes back). */
  const [view, setView] = useState<"list" | "detail">("list");

  const [inspecting, setInspecting] = useState(false);
  const [recording, setRecording] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [results, setResults] = useState<Record<string, StepResult>>({});
  const [runningId, setRunningId] = useState<string | null>(null);
  const [runningScenarioId, setRunningScenarioId] = useState<string | null>(
    null,
  );
  const [continueOnFailure, setContinueOnFailure] = useState(false);
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [latest, setLatest] = useState<Record<string, RunRecord>>({});
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [picked, setPicked] = useState<Selector | null>(null);
  const [form, setForm] = useState<FormState>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [suiteRun, setSuiteRun] = useState<SuiteRun | null>(null);
  /** True while a multi-scenario run is in flight (PLAY_DONE then means "one of many"). */
  const suiteRunningRef = useRef(false);
  const formRef = useRef<FormState>(null);
  useEffect(() => {
    formRef.current = form;
  }, [form]);

  const activeIdRef = useRef<string | null>(null);
  useEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);
  const teamIdsRef = useRef<Set<string>>(new Set());
  /** Every scenario we know, for looking up steps when a run for some id finishes. */
  const scenariosRef = useRef<Map<string, Scenario>>(new Map());
  useEffect(() => {
    teamIdsRef.current = new Set(team.team.map((s) => s.id));
    scenariosRef.current = new Map(
      [...team.team, ...drafts].map((s) => [s.id, s]),
    );
  }, [team.team, drafts]);

  const activeTeam = useMemo(
    () => team.team.find((s) => s.id === activeId) ?? null,
    [team.team, activeId],
  );
  const activeDraft = useMemo(
    () => drafts.find((s) => s.id === activeId) ?? null,
    [drafts, activeId],
  );
  const active = activeTeam ?? activeDraft;
  const activeIsDraft = activeDraft !== null;
  /** Drafts are always editable; team scenarios only by a signed-in publisher. */
  const canEdit = active !== null && (activeIsDraft || team.isPublisher);
  const steps = active?.steps ?? [];
  const activeChanged =
    !!activeId &&
    (team.suiteChanges.added.includes(activeId) ||
      team.suiteChanges.changed.includes(activeId));

  // ---- load once ----
  useEffect(() => {
    (async () => {
      const [{ drafts: d, activeId: aid }, cof, lat] = await Promise.all([
        loadDrafts(),
        loadContinueOnFailure(),
        loadLatestRuns(),
      ]);
      setDrafts(d);
      setActiveId(aid);
      setContinueOnFailure(cof);
      setLatest(lat);
      setLoaded(true);
    })();
  }, []);

  // ---- persist ----
  useEffect(() => {
    if (loaded) saveDrafts(drafts);
  }, [drafts, loaded]);
  useEffect(() => {
    if (loaded) saveActiveId(activeId);
  }, [activeId, loaded]);

  // ---- drop a selection that no longer exists (deleted, or suite switched) ----
  useEffect(() => {
    if (!loaded || !team.loaded || activeId === null) return;
    const exists =
      team.suiteScenarios.some((s) => s.id === activeId) ||
      drafts.some((s) => s.id === activeId);
    if (exists) return;
    const t = setTimeout(() => {
      setActiveId(null);
      setView("list");
    }, 0);
    return () => clearTimeout(t);
  }, [loaded, team.loaded, team.suiteScenarios, drafts, activeId]);

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

  // ---- mutate a scenario wherever it lives (team working copy or drafts) ----
  const updateScenario = useCallback(
    (id: string, fn: (s: Scenario) => Scenario) => {
      const apply = (list: Scenario[]) =>
        list.map((s) => (s.id === id ? fn(s) : s));
      if (teamIdsRef.current.has(id)) setTeam(apply);
      else setDrafts(apply);
    },
    [setTeam],
  );
  const updateActiveSteps = useCallback(
    (updater: (s: Step[]) => Step[]) => {
      const id = activeIdRef.current;
      if (id)
        updateScenario(id, (s) => ({
          ...s,
          steps: updater(s.steps),
          updatedAt: Date.now(),
        }));
    },
    [updateScenario],
  );
  const appendStep = useCallback(
    (step: Step) => updateActiveSteps((s) => [...s, step]),
    [updateActiveSteps],
  );
  const insertStep = (index: number, step: Step) =>
    updateActiveSteps((s) => [...s.slice(0, index), step, ...s.slice(index)]);
  const replaceStep = (step: Step) =>
    updateActiveSteps((list) => list.map((s) => (s.id === step.id ? step : s)));
  const moveStep = (id: string, delta: -1 | 1) =>
    updateActiveSteps((list) => {
      const i = list.findIndex((s) => s.id === id);
      const j = i + delta;
      if (i < 0 || j < 0 || j >= list.length) return list;
      const next = [...list];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  const removeStep = (id: string) =>
    updateActiveSteps((s) => s.filter((x) => x.id !== id));

  const currentTabUrl = async (): Promise<string> => {
    const [t] = await chrome.tabs.query({
      active: true,
      lastFocusedWindow: true,
    });
    return t?.url ?? "";
  };

  // ---- events from content/background ----
  useEffect(() => {
    const handler = (msg: Event) => {
      switch (msg.type) {
        case "ELEMENT_PICKED":
          setInspecting(false);
          // The open form takes the pick; with no form open, start adding a click step at the end.
          if (formRef.current) setPicked(msg.selector);
          else {
            const n =
              scenariosRef.current.get(activeIdRef.current ?? "")?.steps
                .length ?? 0;
            setForm({ mode: "add", index: n, selector: msg.selector });
          }
          break;
        case "STEP_RECORDED":
          appendStep(msg.step);
          break;
        case "INSPECT_ENDED":
          setInspecting(false);
          break;
        case "RECORD_ENDED":
          setRecording(false);
          break;
        case "PLAY_STEP_START":
          setRunningId(msg.stepId);
          break;
        case "PLAY_PROGRESS":
          setResults((r) => ({ ...r, [msg.result.stepId]: msg.result }));
          break;
        case "SUITE_SCENARIO_START":
          setRunningScenarioId(msg.scenarioId);
          setResults({});
          setSelectedRunId(null);
          setSuiteRun(
            (run) =>
              run && {
                ...run,
                items: run.items.map((it) =>
                  it.id === msg.scenarioId ? { ...it, status: "running" } : it,
                ),
              },
          );
          break;
        case "PLAY_DONE": {
          setRunningId(null);
          const sc = msg.scenarioId
            ? scenariosRef.current.get(msg.scenarioId)
            : undefined;
          if (!sc) {
            setPlaying(false); // single-step play - nothing to record
            break;
          }
          const firstFail = msg.results.find((r) => !r.ok);
          const passedSteps = msg.results.filter((r) => r.ok).length;
          const ok = !firstFail && msg.results.length === sc.steps.length;
          const failedStep = firstFail
            ? sc.steps.find((s) => s.id === firstFail.stepId)?.description
            : undefined;
          const record: RunRecord = {
            id: crypto.randomUUID(),
            scenarioId: sc.id,
            startedAt: msg.startedAt,
            finishedAt: msg.finishedAt,
            stepCount: sc.steps.length,
            ok,
            results: msg.results,
            failedStep,
          };
          appendRun(record).then((list) => {
            if (activeIdRef.current === sc.id) setRuns(list);
          });
          setLatest((m) => ({ ...m, [sc.id]: record }));
          if (activeIdRef.current === sc.id) setSelectedRunId(record.id);
          if (!suiteRunningRef.current) {
            setPlaying(false);
            setRunningScenarioId(null);
          }
          setSuiteRun(
            (run) =>
              run && {
                ...run,
                items: run.items.map((it) =>
                  it.id === sc.id
                    ? {
                        ...it,
                        status: ok ? "ok" : "fail",
                        passedSteps,
                        totalSteps: sc.steps.length,
                        failedStep,
                        durationMs: msg.finishedAt - msg.startedAt,
                      }
                    : it,
                ),
              },
          );
          break;
        }
        case "SUITE_DONE":
          suiteRunningRef.current = false;
          setPlaying(false);
          setRunningScenarioId(null);
          setSuiteRun((run) => run && { ...run, finishedAt: Date.now() });
          break;
      }
    };
    chrome.runtime.onMessage.addListener(handler);
    return () => chrome.runtime.onMessage.removeListener(handler);
  }, [appendStep]);

  // ---- scenario actions ----
  const openScenario = (id: string) => {
    if (!id) return;
    setActiveId(id);
    setResults({});
    setRunningId(null);
    setSelectedRunId(null);
    setForm(null);
    setPicked(null);
    setRenaming(null);
    setTab("list");
    setView("detail");
    loadRuns(id).then((list) => {
      if (list[0]) {
        setSelectedRunId(list[0].id);
        setResults(
          Object.fromEntries(list[0].results.map((r) => [r.stepId, r])),
        );
      }
    });
  };
  const createDraft = () => {
    const sc = makeScenario("새 시나리오");
    setDrafts((prev) => [...prev, sc]);
    openScenario(sc.id);
    setRenaming(sc.name);
  };
  const commitRename = () => {
    if (!active || renaming === null) return;
    const name = renaming.trim();
    if (name && name !== active.name)
      updateScenario(active.id, (s) => ({ ...s, name, updatedAt: Date.now() }));
    setRenaming(null);
  };
  /** Copies always land in drafts - that is how a runner takes a team scenario and tweaks it. */
  const duplicateScenario = () => {
    if (!active) return;
    const copy = makeScenario(
      `${active.name} (복사본)`,
      structuredClone(active.steps),
    );
    setDrafts((prev) => [...prev, copy]);
    openScenario(copy.id);
  };
  const deleteScenario = async () => {
    if (!active || !canEdit) return;
    const warn = activeIsDraft
      ? `"${active.name}"을(를) 삭제할까요?`
      : `팀 시나리오 "${active.name}"을(를) 삭제할까요?\n\n로컬에서 먼저 지워지고, 다음 공유 때 팀 전체에서 사라집니다.`;
    if (!confirm(warn)) return;
    const id = active.id;
    clearRuns(id);
    if (activeIsDraft) setDrafts((prev) => prev.filter((s) => s.id !== id));
    else setTeam((prev) => prev.filter((s) => s.id !== id));
    setActiveId(null);
    setView("list");
  };
  /** Publisher only: move a draft into the active suite (published on the next 게시). */
  const promoteDraft = () => {
    if (!activeDraft || !team.isPublisher || !team.activeSuite) return;
    const choices = team.folders.length
      ? `\n폴더: ${team.folders.join(", ")}\n(비워두면 미분류)`
      : "\n(폴더가 없으면 미분류로 들어가요)";
    const folder = prompt(
      `"${activeDraft.name}"을(를) 버전 "${team.activeSuite.name}"에 넣어요.${choices}`,
      team.folders[0] ?? "",
    );
    if (folder === null) return;
    const f = folder.trim();
    if (f && !team.folders.includes(f)) team.addFolder(f);
    const sc: Scenario = {
      ...activeDraft,
      suiteId: team.activeSuiteId,
      folder: f || undefined,
      updatedAt: Date.now(),
    };
    setDrafts((prev) => prev.filter((s) => s.id !== sc.id));
    setTeam((prev) => [...prev, sc]);
  };
  const setFolder = (folder: string) => {
    if (!active || activeIsDraft || !team.isPublisher) return;
    updateScenario(active.id, (s) => ({
      ...s,
      folder: folder || undefined,
      updatedAt: Date.now(),
    }));
  };

  // ---- inspect / record ----
  const startInspect = async () => {
    if (inspecting) return;
    setInspecting(true);
    const res = await send({ type: "START_INSPECT" });
    if (res && res.ok === false) {
      setInspecting(false);
      alert(
        `요소 선택을 시작할 수 없어요.\n${res.error ?? ""}\n\n대상 탭을 새로고침(F5) 후 다시 시도하세요.`,
      );
    }
  };
  const stopInspect = () => {
    if (!inspecting) return;
    send({ type: "STOP_INSPECT" });
    setInspecting(false);
  };
  const toggleRecord = async () => {
    if (recording) {
      send({ type: "STOP_RECORD" });
      setRecording(false);
      return;
    }
    setForm(null);
    setRecording(true);
    const res = await send({ type: "START_RECORD" });
    if (res && res.ok === false) {
      setRecording(false);
      alert(
        `화면에서 만들기를 시작할 수 없어요.\n${res.error ?? ""}\n\n대상 탭을 새로고침(F5) 후 다시 시도하세요.`,
      );
      return;
    }
    // An empty scenario gets the page it was recorded on as its first step, so
    // whoever replays it lands on the right page regardless of where they start.
    if (steps.length === 0) {
      const url = await currentTabUrl();
      if (/^https?:/.test(url)) appendStep(makeStep({ type: "navigate", url }));
    }
  };

  // ---- step form ----
  const [formUrl, setFormUrl] = useState("");
  const openAdd = async (index: number) => {
    if (!canEdit) return;
    stopInspect();
    setPicked(null);
    setFormUrl(await currentTabUrl());
    setForm({ mode: "add", index });
  };
  const openEdit = (id: string) => {
    if (!canEdit) return;
    stopInspect();
    setPicked(null);
    setForm((f) =>
      f?.mode === "edit" && f.id === id ? null : { mode: "edit", id },
    );
  };
  const closeForm = () => {
    stopInspect();
    setPicked(null);
    setForm(null);
  };
  const saveForm = (step: Step) => {
    if (!form) return;
    if (form.mode === "add") insertStep(form.index, step);
    else replaceStep(step);
    closeForm();
  };

  // ---- play ----
  const startFailed = (
    res: { ok: boolean; error?: string } | undefined,
    what: string,
  ) => {
    if (res && res.ok === false) {
      suiteRunningRef.current = false;
      setPlaying(false);
      setRunningScenarioId(null);
      setSuiteRun(null);
      alert(`${what}을 시작할 수 없어요.\n${res.error ?? ""}`);
    }
  };
  const runScenario = (id: string) => {
    const sc = scenariosRef.current.get(id);
    if (!sc || !sc.steps.length) return;
    if (activeIdRef.current === id) setResults({});
    setSelectedRunId(null);
    setSuiteRun(null);
    setForm(null);
    setPlaying(true);
    setRunningScenarioId(id);
    send({
      type: "PLAY",
      steps: sc.steps,
      continueOnFailure,
      scenarioId: id,
    }).then((res) => startFailed(res, "실행"));
  };
  const playOne = async (step: Step) => {
    const res = await send({ type: "PLAY_STEP", step });
    if (res && res.ok === false)
      alert(`단계를 실행할 수 없어요.\n${res.error ?? ""}`);
  };
  const runMany = (ids: string[], label: string) => {
    const list = ids
      .map((id) => scenariosRef.current.get(id))
      .filter((s): s is Scenario => !!s && s.steps.length > 0);
    if (!list.length) return;
    setResults({});
    setSelectedRunId(null);
    setPlaying(true);
    suiteRunningRef.current = true;
    setSuiteRun({
      suiteName: label,
      startedAt: Date.now(),
      items: list.map((s) => ({
        id: s.id,
        name: s.name,
        status: "pending",
        passedSteps: 0,
        totalSteps: s.steps.length,
      })),
    });
    setTab("list");
    setView("list");
    send({
      type: "PLAY_SUITE",
      scenarios: list.map((s) => ({ id: s.id, steps: s.steps })),
      continueOnFailure,
    }).then((res) => startFailed(res, "전체 실행"));
  };
  const changeContinueOnFailure = (on: boolean) => {
    setContinueOnFailure(on);
    saveContinueOnFailure(on);
  };
  const showRun = (run: RunRecord) => {
    setSelectedRunId(run.id);
    setResults(Object.fromEntries(run.results.map((r) => [r.stepId, r])));
  };
  const clearRunHistory = async () => {
    if (!active || !confirm("이 시나리오의 실행 기록을 모두 지울까요?")) return;
    await clearRuns(active.id);
    setRuns([]);
    setSelectedRunId(null);
    setLatest((m) => {
      const n = { ...m };
      delete n[active.id];
      return n;
    });
  };

  // ---- import / export (single scenario as JSON; imports become drafts) ----
  const exportJson = () => {
    if (!active) return;
    const blob = new Blob([JSON.stringify(active, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${active.name.replace(/\s+/g, "-")}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };
  const importJson = (file: File) => {
    file.text().then((t) => {
      try {
        const parsed = JSON.parse(t);
        const st: Step[] = Array.isArray(parsed)
          ? parsed
          : Array.isArray(parsed.steps)
            ? parsed.steps
            : null;
        if (!st) throw new Error("steps 없음");
        const name =
          typeof parsed.name === "string"
            ? parsed.name
            : file.name.replace(/\.json$/, "");
        const sc = makeScenario(name, st);
        setDrafts((prev) => [...prev, sc]);
        openScenario(sc.id);
      } catch {
        alert("올바른 시나리오 파일이 아니에요.");
      }
    });
  };

  const tabs: { id: Tab; label: string }[] = [
    { id: "list", label: "시나리오" },
    ...(team.isPublisher
      ? [
          {
            id: "publish" as Tab,
            label: team.pendingCount ? `공유 ${team.pendingCount}` : "공유",
          },
        ]
      : []),
    { id: "settings", label: "설정" },
  ];
  const showDetail = tab === "list" && view === "detail" && active !== null;

  const insertLine = (index: number, always = false) =>
    canEdit && !playing ? (
      <li key={`ins-${index}`} className={`insert ${always ? "always" : ""}`}>
        <button onClick={() => openAdd(index)}>＋ 여기에 단계 추가</button>
      </li>
    ) : null;

  const formAt = (index: number) =>
    form?.mode === "add" && form.index === index ? (
      <li key="form-add">
        <StepForm
          step={null}
          initial={{ selector: form.selector, url: formUrl }}
          picked={picked}
          picking={inspecting}
          onPick={startInspect}
          onSave={saveForm}
          onCancel={closeForm}
        />
      </li>
    ) : null;

  return (
    <div className="app">
      <header className="top">
        <h1>Po-Cake</h1>
        {playing && <span className="playing-pill">실행 중</span>}
      </header>

      {team.enabled && <SuiteHeader team={team} />}

      <nav className="tabs" role="tablist">
        {tabs.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            className={tab === t.id ? "on" : ""}
            onClick={() => {
              setTab(t.id);
              if (t.id === "list") setView("list");
            }}
          >
            {t.label}
          </button>
        ))}
      </nav>

      <main className="tab-body">
        {tab === "list" && !showDetail && (
          <ScenarioListTab
            team={team}
            drafts={drafts}
            latest={latest}
            activeId={activeId}
            playing={playing}
            runningScenarioId={runningScenarioId}
            suiteRun={suiteRun}
            onOpen={openScenario}
            onRunScenario={runScenario}
            onRunMany={runMany}
            onCreateDraft={createDraft}
            onCloseSuiteRun={() => setSuiteRun(null)}
          />
        )}

        {showDetail && active && (
          <div className="edit-tab">
            <div className="edit-head">
              <button
                className="icon-btn"
                title="목록으로"
                onClick={() => setView("list")}
              >
                ←
              </button>
              <span className={`chip ${activeIsDraft ? "muted" : ""}`}>
                {activeIsDraft
                  ? "내 시나리오"
                  : (active.folder ?? team.activeSuite?.name ?? "팀")}
              </span>
              {renaming !== null ? (
                <input
                  className="title-input"
                  autoFocus
                  value={renaming}
                  onChange={(e) => setRenaming(e.target.value)}
                  onBlur={commitRename}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commitRename();
                    if (e.key === "Escape") setRenaming(null);
                  }}
                />
              ) : (
                <span
                  className="title"
                  title={canEdit ? "클릭해서 이름 변경" : active.name}
                  onClick={() => canEdit && setRenaming(active.name)}
                  style={canEdit ? { cursor: "text" } : undefined}
                >
                  {active.name}
                </span>
              )}
              <MoreMenu
                items={[
                  {
                    label: "이름 변경",
                    onClick: () => setRenaming(active.name),
                    hidden: !canEdit,
                  },
                  { label: "내 시나리오로 복제", onClick: duplicateScenario },
                  {
                    label: "팀 시나리오로 옮기기",
                    onClick: promoteDraft,
                    hidden: !(team.isPublisher && activeIsDraft),
                  },
                  {
                    label: "이 시나리오만 공유",
                    onClick: () => team.publish([active.id]),
                    hidden: !(
                      team.isPublisher &&
                      !activeIsDraft &&
                      activeChanged
                    ),
                    disabled: team.busy,
                  },
                  { label: "내보내기 (JSON)", onClick: exportJson },
                  {
                    label: "삭제",
                    onClick: deleteScenario,
                    danger: true,
                    hidden: !canEdit,
                  },
                ]}
              />
            </div>

            {(activeChanged ||
              (team.isPublisher && !activeIsDraft) ||
              !canEdit) && (
              <div className="edit-meta">
                {activeChanged && <span className="chip warn">공유 안 됨</span>}
                {team.isPublisher && !activeIsDraft && (
                  <label>
                    폴더{" "}
                    <select
                      value={active.folder ?? NO_FOLDER}
                      onChange={(e) => setFolder(e.target.value)}
                    >
                      <option value={NO_FOLDER}>미분류</option>
                      {team.folders.map((f) => (
                        <option key={f} value={f}>
                          {f}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                {!canEdit && (
                  <span>
                    읽기 전용 - 고치려면 ⋯ 메뉴에서 내 시나리오로 복제하세요
                  </span>
                )}
              </div>
            )}

            {recording && (
              <div className="recording-bar">
                <span className="dot" />
                화면에서 만드는 중 - 페이지에서 클릭·입력하면 단계가 쌓여요
                <button
                  className="btn sm"
                  style={{ marginLeft: "auto" }}
                  onClick={toggleRecord}
                >
                  중지
                </button>
              </div>
            )}

            <div className="section-label">단계</div>
            {steps.length === 0 && !form ? (
              <p className="empty">
                {canEdit
                  ? "아직 단계가 없어요. 아래에서 화면에서 만들기를 누르거나 단계를 추가하세요."
                  : "이 시나리오에는 단계가 없어요."}
              </p>
            ) : null}
            <ol className="list">
              {formAt(0)}
              {steps.map((step, i) => (
                <Fragment key={step.id}>
                  <StepRow
                    index={i + 1}
                    step={step}
                    result={results[step.id]}
                    running={step.id === runningId}
                    busy={playing}
                    readOnly={!canEdit || playing}
                    isFirst={i === 0}
                    isLast={i === steps.length - 1}
                    editing={form?.mode === "edit" && form.id === step.id}
                    onEdit={() => openEdit(step.id)}
                    onPlay={() => playOne(step)}
                    onRemove={() => removeStep(step.id)}
                    onHighlight={() =>
                      "selector" in step &&
                      send({ type: "HIGHLIGHT", selector: step.selector })
                    }
                    onMove={(delta) => moveStep(step.id, delta)}
                  />
                  {form?.mode === "edit" && form.id === step.id && (
                    <li key={`form-${step.id}`}>
                      <StepForm
                        step={step}
                        picked={picked}
                        picking={inspecting}
                        onPick={startInspect}
                        onSave={saveForm}
                        onCancel={closeForm}
                      />
                    </li>
                  )}
                  {i < steps.length - 1 && insertLine(i + 1)}
                  {i < steps.length - 1 && formAt(i + 1)}
                </Fragment>
              ))}
              {steps.length > 0 && formAt(steps.length)}
              {!(form?.mode === "add" && form.index === steps.length) &&
                insertLine(steps.length, true)}
            </ol>

            {runs.length > 0 && <div className="section-label">실행 기록</div>}
            <RunHistory
              runs={runs}
              selectedId={selectedRunId}
              onSelect={showRun}
              onClear={clearRunHistory}
            />

            <div className="section-label">실행 설정</div>
            <label className="switch">
              <input
                type="checkbox"
                checked={continueOnFailure}
                onChange={(e) => changeContinueOnFailure(e.target.checked)}
              />
              실패해도 계속 실행
            </label>
          </div>
        )}

        {tab === "publish" && team.isPublisher && (
          <PublishTab team={team} onOpen={openScenario} />
        )}

        {tab === "settings" && (
          <SettingsTab
            team={team}
            continueOnFailure={continueOnFailure}
            onContinueChange={changeContinueOnFailure}
            canExport={!!active}
            onExport={exportJson}
            onImport={importJson}
          />
        )}
      </main>

      {showDetail && active && (
        <footer className="bar">
          {canEdit && (
            <button
              className="btn ghost"
              disabled={playing || recording}
              onClick={() => openAdd(steps.length)}
            >
              ＋ 단계 추가
            </button>
          )}
          {canEdit && (
            <button
              className={`btn ghost ${recording ? "danger" : ""}`}
              disabled={playing}
              onClick={toggleRecord}
            >
              {recording ? "■ 만들기 중지" : "● 화면에서 만들기"}
            </button>
          )}
          <button
            className="btn ghost"
            disabled={!steps.length || playing || recording}
            onClick={() => runScenario(active.id)}
          >
            ▶ 전체 실행
          </button>
          {team.isPublisher && !activeIsDraft && activeChanged && (
            <button
              className="btn primary"
              disabled={team.busy || playing}
              onClick={() => team.publish([active.id])}
            >
              공유
            </button>
          )}
        </footer>
      )}
    </div>
  );
}

/** Build a step with a fresh id and the standard description. */
function makeStep(partial: StepDraft): Step {
  const step = { ...partial, id: uid(), description: "" } as Step;
  step.description = defaultDescription(step);
  return step;
}
