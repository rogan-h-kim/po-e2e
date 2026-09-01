import { useEffect, useRef, useState } from 'react';
import type { Step, StepResult } from '../shared/types';

interface Props {
  index: number;
  step: Step;
  result?: StepResult;
  running: boolean;
  /** A replay is in flight - single-step play is disabled meanwhile. */
  busy: boolean;
  /** Read-only: no menu actions that change the step. */
  readOnly: boolean;
  isFirst: boolean;
  isLast: boolean;
  /** This row is the one being edited (the form renders below it). */
  editing: boolean;
  onEdit: () => void;
  onPlay: () => void;
  onRemove: () => void;
  onHighlight: () => void;
  onMove: (delta: -1 | 1) => void;
}

const fmtDuration = (ms: number) => (ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`);

/** One line in the 재생 목록: number, description, status on the right, and a ⋯ menu. */
export function StepRow({
  index,
  step,
  result,
  running,
  busy,
  readOnly,
  isFirst,
  isLast,
  editing,
  onEdit,
  onPlay,
  onRemove,
  onHighlight,
  onMove,
}: Props) {
  const [menu, setMenu] = useState(false);
  const [showShot, setShowShot] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenu(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [menu]);

  const status = running ? 'running' : result ? (result.ok ? 'ok' : 'fail') : 'idle';
  const statusText = running
    ? '실행 중'
    : result
      ? result.ok
        ? result.durationMs != null
          ? fmtDuration(result.durationMs)
          : '성공'
        : '실패'
      : '재생 안 됨';
  const warning = 'selector' in step ? step.selector.warning : undefined;
  const item = (label: string, fn: () => void, opts: { danger?: boolean; disabled?: boolean } = {}) => (
    <button
      className={`menu-item ${opts.danger ? 'danger' : ''}`}
      disabled={opts.disabled}
      onClick={() => {
        setMenu(false);
        fn();
      }}
    >
      {label}
    </button>
  );

  return (
    <li className={`row ${status} ${editing ? 'editing' : ''}`}>
      <div className="row-main" onClick={readOnly ? undefined : onEdit} role={readOnly ? undefined : 'button'}>
        <span className="row-num">{index}</span>
        <span className="row-text" title={step.description}>
          {step.description}
        </span>
        <span className={`row-status ${status}`}>{statusText}</span>
        <div className="menu-wrap" ref={menuRef} onClick={(e) => e.stopPropagation()}>
          <button className="row-more" aria-label="더 보기" onClick={() => setMenu((v) => !v)}>
            ⋯
          </button>
          {menu && (
            <div className="menu">
              {item('이 단계만 실행', onPlay, { disabled: busy })}
              {'selector' in step && item('화면에서 강조', onHighlight)}
              {!readOnly && item('편집', onEdit)}
              {!readOnly && item('위로', () => onMove(-1), { disabled: isFirst })}
              {!readOnly && item('아래로', () => onMove(1), { disabled: isLast })}
              {!readOnly && item('삭제', onRemove, { danger: true })}
            </div>
          )}
        </div>
      </div>
      {(warning || result?.error) && (
        <div className="row-sub">
          {warning && <div className="row-warn">⚠ {warning}</div>}
          {result?.error && (
            <div className="row-err">
              {result.error}
              {result.screenshot && (
                <button className="link" onClick={() => setShowShot((v) => !v)}>
                  {showShot ? '스크린샷 닫기' : '실패 시점 스크린샷'}
                </button>
              )}
            </div>
          )}
          {showShot && result?.screenshot && <img className="row-shot" src={result.screenshot} alt="실패 시점 화면" />}
        </div>
      )}
    </li>
  );
}
