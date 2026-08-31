export type SuiteItemStatus = 'pending' | 'running' | 'ok' | 'fail';

export interface SuiteRunItem {
  id: string;
  name: string;
  status: SuiteItemStatus;
  passedSteps: number;
  totalSteps: number;
  failedStep?: string;
  durationMs?: number;
}

export interface SuiteRun {
  suiteName: string;
  startedAt: number;
  finishedAt?: number;
  items: SuiteRunItem[];
}

const ICON: Record<SuiteItemStatus, string> = { pending: '·', running: '⏳', ok: '✅', fail: '❌' };
const fmtDuration = (ms: number) => (ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`);

/** Live summary of a whole-suite run; each row selects that scenario's step list. */
export function SuiteRunPanel({
  run,
  selectedId,
  onSelect,
  onClose,
}: {
  run: SuiteRun;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onClose: () => void;
}) {
  const done = run.finishedAt != null;
  const passed = run.items.filter((i) => i.status === 'ok').length;
  const finished = run.items.filter((i) => i.status === 'ok' || i.status === 'fail').length;
  return (
    <div className="suite-run">
      <div className="suite-run-head">
        <span>
          {done ? (passed === run.items.length ? '✅' : '❌') : '⏳'} {run.suiteName} 전체 실행 · {passed}/
          {run.items.length} 통과
          {!done && ` · ${finished}/${run.items.length} 진행`}
          {done && run.finishedAt != null && ` · ${fmtDuration(run.finishedAt - run.startedAt)}`}
        </span>
        {done && (
          <button className="icon-btn" title="닫기" onClick={onClose}>
            ✕
          </button>
        )}
      </div>
      <ul>
        {run.items.map((it) => (
          <li key={it.id}>
            <button
              className={`suite-item ${it.status} ${it.id === selectedId ? 'selected' : ''}`}
              onClick={() => onSelect(it.id)}
            >
              <span className="suite-item-main">
                {ICON[it.status]} {it.name}
                {(it.status === 'ok' || it.status === 'fail') && (
                  <span className="suite-item-meta">
                    {' '}
                    {it.passedSteps}/{it.totalSteps}
                    {it.durationMs != null && ` · ${fmtDuration(it.durationMs)}`}
                  </span>
                )}
              </span>
              {it.failedStep && <span className="suite-item-fail">실패: {it.failedStep}</span>}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
