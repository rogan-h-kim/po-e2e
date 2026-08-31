import { useMemo, useState } from 'react';
import type { Scenario } from '../shared/types';
import type { Team } from './useTeam';
import { groupByFolder } from './folders';

type Kind = 'published' | 'added' | 'changed' | 'deleted';
interface Item extends Pick<Scenario, 'id' | 'name' | 'folder'> {
  kind: Kind;
}
const KIND: Record<Kind, { label: string; cls: string }> = {
  published: { label: '게시됨', cls: 'ok' },
  added: { label: '새 항목', cls: 'ok' },
  changed: { label: '변경됨', cls: 'warn' },
  deleted: { label: '삭제됨', cls: 'bad' },
};

/**
 * Publisher-only. The whole suite as a folder tree with each scenario's
 * publish state; tick changed ones and publish just those (or everything).
 * Below: product-version management.
 */
export function PublishTab({ team, onOpen }: { team: Team; onOpen: (id: string) => void }) {
  const { suiteChanges, snapshot, busy, pendingCount, totalPending, activeSuite } = team;
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const groups = useMemo(() => {
    const added = new Set(suiteChanges.added);
    const changed = new Set(suiteChanges.changed);
    const live: Item[] = team.suiteScenarios.map((s) => ({
      id: s.id,
      name: s.name,
      folder: s.folder,
      kind: added.has(s.id) ? 'added' : changed.has(s.id) ? 'changed' : 'published',
    }));
    const gone: Item[] = suiteChanges.deleted
      .map((id) => snapshot.find((s) => s.id === id))
      .filter((s): s is Scenario => !!s)
      .map((s) => ({ id: s.id, name: s.name, folder: s.folder, kind: 'deleted' as const }));
    return groupByFolder(team.folders, [...live, ...gone]);
  }, [team.suiteScenarios, team.folders, snapshot, suiteChanges]);

  const pendingIds = useMemo(
    () => new Set([...suiteChanges.added, ...suiteChanges.changed, ...suiteChanges.deleted]),
    [suiteChanges],
  );
  const picked = [...selected].filter((id) => pendingIds.has(id));
  const toggle = (id: string, on: boolean) =>
    setSelected((s) => {
      const n = new Set(s);
      if (on) n.add(id);
      else n.delete(id);
      return n;
    });
  const publishPicked = async () => {
    await team.publish(picked);
    setSelected(new Set());
  };

  const createSuite = () => {
    const name = prompt('새 버전 이름 (예: v2.4)');
    if (name?.trim()) team.createSuite(name.trim());
  };
  const renameSuite = () => {
    if (!activeSuite) return;
    const name = prompt('버전 이름 변경', activeSuite.name);
    if (name?.trim()) team.renameSuite(name.trim());
  };
  const duplicateSuite = () => {
    if (!activeSuite) return;
    const name = prompt(
      `"${activeSuite.name}"의 폴더와 시나리오를 복사해 새 버전을 만들어요. 새 버전 이름:`,
      `${activeSuite.name} 복사`,
    );
    if (name?.trim()) team.duplicateSuite(name.trim());
  };
  const toggleArchive = () => {
    if (!activeSuite) return;
    const next = !activeSuite.archived;
    if (
      confirm(
        next
          ? `"${activeSuite.name}"을(를) 보관할까요? 목록의 '보관됨' 그룹으로 내려가고 실행은 계속 가능해요.`
          : `"${activeSuite.name}"을(를) 다시 활성 버전으로 올릴까요?`,
      )
    )
      team.archiveSuite(next);
  };
  const discard = () => {
    if (confirm(`게시 안 된 변경 ${totalPending}개를 모두 버리고 서버 내용으로 되돌릴까요?`)) team.refresh(true);
  };

  return (
    <div className="publish-tab">
      <section className="block">
        <div className="block-head">
          <h3>
            {activeSuite?.name ?? '—'}
            <span className="muted"> · 게시 안 된 변경 {pendingCount}개</span>
          </h3>
        </div>

        {groups.length === 0 ? (
          <p className="hint">이 버전에는 아직 시나리오가 없어요. 시나리오 탭에서 초안을 만들어 승격하세요.</p>
        ) : (
          groups.map((g) => (
            <section key={g.folder || '__loose'} className="folder">
              <div className="folder-head">
                <span className="folder-toggle static">
                  {g.label} <span className="muted">{g.items.length}</span>
                </span>
              </div>
              <ul className="sc-list">
                {g.items.map((it) => {
                  const pending = it.kind !== 'published';
                  return (
                    <li key={it.id} className="sc-row">
                      <label className="check" title={pending ? '선택' : '변경 없음'}>
                        <input
                          type="checkbox"
                          checked={selected.has(it.id)}
                          disabled={!pending}
                          onChange={(e) => toggle(it.id, e.target.checked)}
                        />
                      </label>
                      <button
                        className="sc-main"
                        disabled={it.kind === 'deleted'}
                        onClick={() => onOpen(it.id)}
                        title={it.kind === 'deleted' ? '삭제 예정' : '열기'}
                      >
                        <span className={`sc-name ${it.kind === 'deleted' ? 'strike' : ''}`}>{it.name}</span>
                        <span className={`state ${KIND[it.kind].cls}`}>{KIND[it.kind].label}</span>
                      </button>
                    </li>
                  );
                })}
                {g.items.length === 0 && <li className="muted sc-empty">비어 있음</li>}
              </ul>
            </section>
          ))
        )}

        <div className="select-bar">
          {picked.length > 0 ? (
            <>
              <span className="select-count">{picked.length}개 선택</span>
              <button className="btn sm ghost" onClick={() => setSelected(new Set())}>
                해제
              </button>
              <button className="btn primary" disabled={busy} onClick={publishPicked}>
                선택 게시
              </button>
            </>
          ) : (
            <>
              <span className="muted select-hint">
                {pendingCount > 0 ? '변경된 항목을 체크해 일부만 게시할 수 있어요' : '모두 게시된 상태예요'}
              </span>
              {totalPending > 0 && (
                <button className="btn sm ghost danger" disabled={busy} onClick={discard} title="내 변경을 모두 버리고 서버 상태로">
                  되돌리기
                </button>
              )}
              <button className="btn primary" disabled={busy || pendingCount === 0} onClick={() => team.publish()}>
                모두 게시
              </button>
            </>
          )}
        </div>
        <p className="hint">
          게시하면 팀원이 다음에 패널을 열 때 받아요. 게시 전에 서버 최신본을 먼저 받아 내가 바꾼 시나리오만 그 위에 얹으므로 다른
          게시자의 작업을 덮어쓰지 않습니다.
        </p>
      </section>

      <section className="block">
        <h3>제품 버전</h3>
        <div className="block-actions">
          <button className="btn sm" onClick={createSuite}>
            ＋ 새 버전
          </button>
          <button className="btn sm" disabled={!activeSuite} onClick={renameSuite}>
            이름 변경
          </button>
          <button className="btn sm" disabled={!activeSuite} onClick={duplicateSuite}>
            복사해서 새 버전
          </button>
          <button className="btn sm" disabled={!activeSuite} onClick={toggleArchive}>
            {activeSuite?.archived ? '보관 해제' : '보관'}
          </button>
        </div>
        <p className="hint">
          제품 버전별 시나리오 세트예요 (예: v2.3, v2.4). 새 버전 테스트를 시작할 땐 "복사해서 새 버전"으로 폴더·시나리오를
          통째로 가져온 뒤 달라진 것만 고치세요. 폴더는 시나리오 탭에서 만듭니다.
        </p>
      </section>
    </div>
  );
}
