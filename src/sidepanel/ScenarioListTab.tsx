import { useMemo, useState } from 'react';
import type { RunRecord, Scenario } from '../shared/types';
import type { Team } from './useTeam';
import { SuiteRunPanel, type SuiteRun } from './SuiteRunPanel';
import { MoreMenu } from './MoreMenu';
import { groupByFolder, NO_FOLDER } from './folders';

export { NO_FOLDER } from './folders';

interface Props {
  team: Team;
  drafts: Scenario[];
  /** Most recent run per scenario id. */
  latest: Record<string, RunRecord>;
  activeId: string | null;
  playing: boolean;
  /** Scenario currently being replayed (single or as part of a suite run). */
  runningScenarioId: string | null;
  suiteRun: SuiteRun | null;
  onOpen: (id: string) => void;
  onRunScenario: (id: string) => void;
  onRunMany: (ids: string[], label: string) => void;
  onCreateDraft: () => void;
  onCloseSuiteRun: () => void;
}

const fmtTime = (t: number) =>
  new Date(t).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

/**
 * The runner's home: the active suite's scenarios grouped by folder, each with
 * its latest result and a checkbox — tick a few (or a whole folder) and run
 * just those. Drafts sit at the bottom. Publishers manage folders here.
 */
export function ScenarioListTab({
  team,
  drafts,
  latest,
  activeId,
  playing,
  runningScenarioId,
  suiteRun,
  onOpen,
  onRunScenario,
  onRunMany,
  onCreateDraft,
  onCloseSuiteRun,
}: Props) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const toggleFold = (name: string) =>
    setCollapsed((c) => {
      const n = new Set(c);
      if (n.has(name)) n.delete(name);
      else n.add(name);
      return n;
    });
  const setMany = (ids: string[], on: boolean) =>
    setSelected((s) => {
      const n = new Set(s);
      for (const id of ids) if (on) n.add(id);
      else n.delete(id);
      return n;
    });

  const groups = useMemo(() => groupByFolder(team.folders, team.suiteScenarios), [team.folders, team.suiteScenarios]);
  const changed = useMemo(
    () => new Set([...team.suiteChanges.added, ...team.suiteChanges.changed]),
    [team.suiteChanges],
  );
  const runnableIds = (list: Scenario[]) => list.filter((s) => s.steps.length > 0).map((s) => s.id);
  const allRunnable = runnableIds([...team.suiteScenarios, ...drafts]);
  const selectedRunnable = allRunnable.filter((id) => selected.has(id));
  const suiteSummary = useMemo(() => {
    const runs = team.suiteScenarios.map((s) => latest[s.id]).filter(Boolean);
    if (!runs.length) return null;
    const ok = runs.filter((r) => r.ok).length;
    return { ok, total: runs.length, last: Math.max(...runs.map((r) => r.startedAt)) };
  }, [team.suiteScenarios, latest]);

  const addFolder = () => {
    const name = prompt('새 폴더 이름 (기능 영역: 예 AI Draft, home, tray)');
    if (name?.trim()) team.addFolder(name.trim());
  };
  const renameFolder = (from: string) => {
    const to = prompt('폴더 이름 변경', from);
    if (to?.trim() && to.trim() !== from) team.renameFolder(from, to.trim());
  };
  const removeFolder = (name: string, count: number) => {
    const msg = count
      ? `폴더 "${name}"을(를) 지울까요? 안의 시나리오 ${count}개는 '미분류'로 이동합니다 (공유 전까지는 내 브라우저에만).`
      : `빈 폴더 "${name}"을(를) 지울까요?`;
    if (confirm(msg)) team.removeFolder(name);
  };

  const renderRow = (s: Scenario, isDraft: boolean) => {
    const run = latest[s.id];
    const running = s.id === runningScenarioId;
    const dot = running ? 'running' : run ? (run.ok ? 'ok' : 'fail') : '';
    const runnable = s.steps.length > 0;
    return (
      <li key={s.id} className={`sc-row ${s.id === activeId ? 'selected' : ''}`}>
        <label className="check" title={runnable ? '선택' : '단계가 없어 실행할 수 없어요'}>
          <input
            type="checkbox"
            checked={selected.has(s.id)}
            disabled={!runnable}
            onChange={(e) => setMany([s.id], e.target.checked)}
          />
        </label>
        <button className="sc-main" onClick={() => onOpen(s.id)} title="열기">
          <span className={`sc-dot ${dot}`} />
          <span className="sc-name">
            {s.name}
            {!isDraft && changed.has(s.id) && <span className="sc-badge">변경됨</span>}
            {!runnable && <span className="muted"> · 비어 있음</span>}
          </span>
          {running ? (
            <span className="sc-meta accent">실행 중</span>
          ) : (
            run && (
              <span className={`sc-meta ${run.ok ? '' : 'fail'}`}>
                {run.ok ? fmtTime(run.startedAt) : run.failedStep ? `실패 · ${run.failedStep}` : '실패'}
              </span>
            )
          )}
        </button>
        <button className="sc-play" title="이 시나리오만 실행" disabled={playing || !runnable} onClick={() => onRunScenario(s.id)}>
          ▶
        </button>
      </li>
    );
  };

  const renderFolderHead = ({
    name,
    list,
    foldKey,
    menu,
    extra,
  }: {
    name: string;
    list: Scenario[];
    foldKey: string;
    menu?: React.ReactNode;
    extra?: React.ReactNode;
  }) => {
    const ids = runnableIds(list);
    const picked = ids.filter((id) => selected.has(id)).length;
    const state = ids.length === 0 ? 'none' : picked === 0 ? 'none' : picked === ids.length ? 'all' : 'some';
    return (
      <div className="folder-head">
        <label className="check" title="폴더 전체 선택">
          <input
            type="checkbox"
            checked={state === 'all'}
            ref={(el) => {
              if (el) el.indeterminate = state === 'some';
            }}
            disabled={ids.length === 0}
            onChange={(e) => setMany(ids, e.target.checked)}
          />
        </label>
        <button className="folder-toggle" onClick={() => toggleFold(foldKey)}>
          {collapsed.has(foldKey) ? '▸' : '▾'} {name} <span className="muted">{list.length}</span>
        </button>
        {extra}
        {menu}
      </div>
    );
  };

  return (
    <div className="list-tab">
      {team.enabled && (
        <>
          <div className="list-head">
            <span className="list-title">
              {team.activeSuite?.name ?? ''}
              {suiteSummary && (
                <span className="muted" title={`마지막 실행 ${fmtTime(suiteSummary.last)}`}>
                  {' '}
                  · 최근 {suiteSummary.ok}/{suiteSummary.total} 통과
                </span>
              )}
            </span>
            {team.isPublisher && (
              <button className="btn sm ghost" onClick={addFolder}>
                ＋ 폴더
              </button>
            )}
          </div>

          {suiteRun && (
            <SuiteRunPanel run={suiteRun} selectedId={activeId} onSelect={onOpen} onClose={onCloseSuiteRun} />
          )}

          {groups.length === 0 && (
            <p className="empty">
              아직 시나리오가 없어요.
              {team.isPublisher ? ' 시나리오를 만들어 팀 시나리오로 옮기거나, 폴더를 먼저 만드세요.' : ' 공유 권한이 있는 사람이 공유하면 여기에 나타나요.'}
            </p>
          )}

          {groups.map((g) => (
            <section key={g.folder || '__loose'} className="folder">
              {renderFolderHead({
                name: g.label,
                list: g.items,
                foldKey: g.folder,
                menu: (
                  <MoreMenu
                    label={`${g.label} 메뉴`}
                    items={[
                      {
                        label: '이 폴더 전체 실행',
                        onClick: () => onRunMany(runnableIds(g.items), g.label),
                        disabled: playing || runnableIds(g.items).length === 0,
                      },
                      { label: '이름 변경', onClick: () => renameFolder(g.folder), hidden: !team.isPublisher || g.folder === NO_FOLDER },
                      {
                        label: '폴더 삭제',
                        onClick: () => removeFolder(g.folder, g.items.length),
                        danger: true,
                        hidden: !team.isPublisher || g.folder === NO_FOLDER,
                      },
                    ]}
                  />
                ),
              })}
              {!collapsed.has(g.folder) && (
                <ul className="sc-list">
                  {g.items.map((s) => renderRow(s, false))}
                  {g.items.length === 0 && <li className="muted sc-empty">비어 있음</li>}
                </ul>
              )}
            </section>
          ))}
        </>
      )}

      <section className="folder">
        {renderFolderHead({
          name: '내 시나리오',
          list: drafts,
          foldKey: '__drafts',
          extra: (
            <button className="btn sm ghost" onClick={onCreateDraft}>
              ＋ 시나리오 만들기
            </button>
          ),
        })}
        {!collapsed.has('__drafts') && (
          <ul className="sc-list">
            {drafts.map((s) => renderRow(s, true))}
            {drafts.length === 0 && (
              <li className="muted sc-empty">
                {team.enabled ? '팀 시나리오를 복제하거나 새로 만들면 여기 쌓여요.' : '＋ 시나리오 만들기로 시작하세요.'}
              </li>
            )}
          </ul>
        )}
      </section>

      <div className="select-bar">
        {selectedRunnable.length > 0 ? (
          <>
            <span className="select-count">{selectedRunnable.length}개 선택</span>
            <button className="btn sm ghost" onClick={() => setSelected(new Set())}>
              해제
            </button>
            <button
              className="btn primary"
              disabled={playing}
              onClick={() => onRunMany(selectedRunnable, `선택 ${selectedRunnable.length}개`)}
            >
              ▶ 선택 실행
            </button>
          </>
        ) : (
          <>
            <span className="muted select-hint">체크해서 원하는 것만 실행할 수 있어요</span>
            <button className="btn sm ghost" disabled={allRunnable.length === 0} onClick={() => setMany(allRunnable, true)}>
              모두 선택
            </button>
            <button
              className="btn primary"
              disabled={playing || runnableIds(team.suiteScenarios).length === 0}
              onClick={() => onRunMany(runnableIds(team.suiteScenarios), team.activeSuite?.name ?? '전체')}
            >
              ▶ 전체 실행
            </button>
          </>
        )}
      </div>
    </div>
  );
}
