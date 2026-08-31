import type { Scenario } from '../shared/types';
import { type SyncStatus, STATUS_META } from '../shared/scenarios';

interface Props {
  scenarios: Scenario[];
  activeId: string | null;
  statuses: Record<string, SyncStatus>;
  teamShareOn: boolean;
  viewer: boolean;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onRename: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}

export function ScenarioBar({
  scenarios,
  activeId,
  statuses,
  teamShareOn,
  viewer,
  onSelect,
  onCreate,
  onRename,
  onDuplicate,
  onDelete,
}: Props) {
  const activeStatus = activeId ? statuses[activeId] : undefined;

  return (
    <div className="scenario-bar">
      <div className="scenario-row">
        <select
          className="scenario-select"
          value={activeId ?? ''}
          onChange={(e) => onSelect(e.target.value)}
          disabled={!scenarios.length}
        >
          {!scenarios.length && <option value="">시나리오 없음</option>}
          {scenarios.map((s) => {
            const st = statuses[s.id];
            const suffix = teamShareOn && st ? ` · ${STATUS_META[st].short}` : '';
            return (
              <option key={s.id} value={s.id}>
                {s.name} · {s.steps.length}단계{suffix}
              </option>
            );
          })}
        </select>
        {!viewer && (
          <div className="scenario-actions">
            <button className="mini" title="새 시나리오" onClick={onCreate}>
              ＋
            </button>
            <button className="mini" title="이름 변경" onClick={onRename} disabled={!activeId}>
              ✎
            </button>
            <button className="mini" title="복제" onClick={onDuplicate} disabled={!activeId}>
              ⧉
            </button>
            <button className="mini danger" title="삭제" onClick={onDelete} disabled={!activeId}>
              🗑
            </button>
          </div>
        )}
      </div>
      {teamShareOn && activeStatus && (
        <div className="scenario-status" style={{ color: STATUS_META[activeStatus].color }}>
          {STATUS_META[activeStatus].dot} {STATUS_META[activeStatus].label}
        </div>
      )}
    </div>
  );
}
