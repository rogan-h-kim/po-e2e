import type { RunRecord } from '../shared/types';

interface Props {
  runs: RunRecord[];
  /** Which run's results are currently shown on the step list, if any. */
  selectedId: string | null;
  onSelect: (run: RunRecord) => void;
  onClear: () => void;
}

const fmtTime = (t: number) =>
  new Date(t).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

const fmtDuration = (ms: number) => (ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`);

/** Collapsible list of past replays for the active scenario (newest first). */
export function RunHistory({ runs, selectedId, onSelect, onClear }: Props) {
  if (!runs.length) return null;
  return (
    <details className="runs">
      <summary>
        실행 기록 ({runs.length}) · 최근 {runs[0].ok ? '✅ 성공' : '❌ 실패'}
      </summary>
      <ul>
        {runs.map((r) => {
          const passed = r.results.filter((x) => x.ok).length;
          return (
            <li key={r.id}>
              <button
                className={`run-row ${r.id === selectedId ? 'selected' : ''}`}
                title="이 실행의 결과를 단계 목록에 표시"
                onClick={() => onSelect(r)}
              >
                <span className="run-main">
                  {r.ok ? '✅' : '❌'} {fmtTime(r.startedAt)} · {passed}/{r.stepCount} 통과 ·{' '}
                  {fmtDuration(r.finishedAt - r.startedAt)}
                </span>
                {r.failedStep && <span className="run-fail">실패: {r.failedStep}</span>}
              </button>
            </li>
          );
        })}
      </ul>
      <button className="btn sm ghost" onClick={onClear}>
        기록 삭제
      </button>
    </details>
  );
}
