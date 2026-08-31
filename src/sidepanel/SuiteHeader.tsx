import type { Team } from './useTeam';

const fmtTime = (t: number) =>
  new Date(t).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

/** Always-visible suite picker with the published version and a refresh button. */
export function SuiteHeader({ team }: { team: Team }) {
  const { suites, release, busy, totalPending, status } = team;
  const live = suites.filter((s) => !s.archived);
  const archived = suites.filter((s) => s.archived);

  const refresh = () => {
    if (totalPending > 0) {
      const ok = confirm(
        `게시 안 된 변경 ${totalPending}개가 있어요.\n\n확인: 서버 내용을 받되 내 변경은 그 위에 유지\n취소: 아무것도 하지 않음`,
      );
      if (!ok) return;
    }
    team.refresh(false);
  };

  return (
    <div className="suite-header">
      <div className="suite-row">
        <select
          value={team.activeSuiteId}
          onChange={(e) => team.setActiveSuite(e.target.value)}
          disabled={suites.length === 0}
          title="제품 버전 (버전별 시나리오 세트)"
        >
          {suites.length === 0 && <option value={team.activeSuiteId}>버전 없음</option>}
          {live.length > 0 && (
            <optgroup label="버전">
              {live.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </optgroup>
          )}
          {archived.length > 0 && (
            <optgroup label="보관됨">
              {archived.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} (보관)
                </option>
              ))}
            </optgroup>
          )}
        </select>
        <span className="suite-version" title={release ? `게시: ${release.publishedBy ?? ''}` : ''}>
          {release ? `${release.version}번째 게시 · ${fmtTime(release.publishedAt)}` : '게시 없음'}
        </span>
        <button className="icon-btn" title="서버에서 다시 받기" disabled={busy} onClick={refresh}>
          {busy ? '…' : '↻'}
        </button>
      </div>
      {status && <div className="sync-status">{status}</div>}
    </div>
  );
}
