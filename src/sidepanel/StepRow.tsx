import { useState } from 'react';
import { KEY_NAMES, type KeyName, type Step, type StepResult, type TextMatch } from '../shared/types';

/** Fields a user may change on an existing step (type and selector stay fixed). */
export type StepPatch = Partial<{
  description: string;
  url: string;
  value: string;
  label: string;
  key: KeyName;
  ms: number;
  text: string;
  match: TextMatch;
}>;

interface Props {
  index: number;
  step: Step;
  result?: StepResult;
  running: boolean;
  /** A full replay is in flight — single-step play is disabled meanwhile. */
  busy: boolean;
  viewer: boolean;
  isFirst: boolean;
  isLast: boolean;
  onPlay: () => void;
  onRemove: () => void;
  onHighlight: () => void;
  onEdit: (patch: StepPatch) => void;
  onMove: (delta: -1 | 1) => void;
}

const TYPE_ICON: Record<Step['type'], string> = {
  navigate: '🌐',
  click: '👆',
  input: '⌨️',
  select: '🔽',
  key: '⏎',
  wait: '⏱️',
  assertVisible: '👁️',
  assertHasText: '📝',
  assertText: '🔍',
  assertValue: '🔤',
  assertUrl: '🔗',
};

const fmtDuration = (ms: number) => (ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`);

export function StepRow({
  index,
  step,
  result,
  running,
  busy,
  viewer,
  isFirst,
  isLast,
  onPlay,
  onRemove,
  onHighlight,
  onEdit,
  onMove,
}: Props) {
  const [editing, setEditing] = useState(false);
  const [showShot, setShowShot] = useState(false);
  const status = editing ? 'editing' : running ? 'running' : result ? (result.ok ? 'ok' : 'fail') : 'idle';
  const warning = 'selector' in step ? step.selector.warning : undefined;

  return (
    <li className={`step ${status}`}>
      <span className="num">{index}</span>
      <span className="icon">{TYPE_ICON[step.type]}</span>
      <div className="body">
        <div className="desc" title={step.description}>
          {step.description}
          {result?.durationMs != null && <span className="step-time"> {fmtDuration(result.durationMs)}</span>}
        </div>
        {warning && <div className="step-warn">⚠ {warning}</div>}
        {result?.error && !editing && (
          <div className="step-err">
            {result.error}
            {result.screenshot && (
              <button className="mini" onClick={() => setShowShot((v) => !v)}>
                {showShot ? '📷 스크린샷 닫기' : '📷 실패 시점 스크린샷'}
              </button>
            )}
          </div>
        )}
        {showShot && result?.screenshot && !editing && (
          <img className="step-shot" src={result.screenshot} alt="실패 시점 화면" />
        )}
        {editing && (
          <StepEditor
            step={step}
            isFirst={isFirst}
            isLast={isLast}
            onMove={onMove}
            onSave={(patch) => {
              onEdit(patch);
              setEditing(false);
            }}
            onCancel={() => setEditing(false)}
          />
        )}
      </div>
      <div className="actions">
        {'selector' in step && (
          <button className="mini" title="화면에서 강조" onClick={onHighlight}>
            🔎
          </button>
        )}
        <button className="mini" title={busy ? '전체 재생 중' : '이 단계만 실행'} disabled={busy} onClick={onPlay}>
          ▶
        </button>
        {!viewer && (
          <>
            <button
              className="mini"
              title="편집 · 순서 이동"
              onClick={() => setEditing((v) => !v)}
              aria-pressed={editing}
            >
              ✎
            </button>
            <button className="mini danger" title="삭제" onClick={onRemove}>
              ✕
            </button>
          </>
        )}
      </div>
    </li>
  );
}

function StepEditor({
  step,
  isFirst,
  isLast,
  onMove,
  onSave,
  onCancel,
}: {
  step: Step;
  isFirst: boolean;
  isLast: boolean;
  onMove: (delta: -1 | 1) => void;
  onSave: (patch: StepPatch) => void;
  onCancel: () => void;
}) {
  const [description, setDescription] = useState(step.description);
  const [url, setUrl] = useState(step.type === 'navigate' || step.type === 'assertUrl' ? step.url : '');
  const [value, setValue] = useState(
    step.type === 'input' || step.type === 'select' || step.type === 'assertValue' ? step.value : '',
  );
  const [label, setLabel] = useState(step.type === 'select' ? (step.label ?? '') : '');
  const [key, setKey] = useState<KeyName>(step.type === 'key' ? step.key : 'Enter');
  const [ms, setMs] = useState(step.type === 'wait' ? String(step.ms) : '');
  const [text, setText] = useState(step.type === 'assertText' ? step.text : '');
  const [match, setMatch] = useState<TextMatch>(
    step.type === 'assertText' || step.type === 'assertUrl' ? step.match : 'contains',
  );

  const save = () => {
    const patch: StepPatch = {};
    if (description !== step.description) patch.description = description;
    switch (step.type) {
      case 'navigate':
        if (url.trim() && url.trim() !== step.url) patch.url = normalizeUrl(url);
        break;
      case 'assertUrl':
        if (url.trim() !== step.url) patch.url = url.trim();
        if (match !== step.match) patch.match = match;
        break;
      case 'input':
      case 'assertValue':
        if (value !== step.value) patch.value = value;
        break;
      case 'select':
        if (value !== step.value) patch.value = value;
        if (label !== (step.label ?? '')) patch.label = label;
        break;
      case 'key':
        if (key !== step.key) patch.key = key;
        break;
      case 'wait': {
        const n = Number(ms);
        if (Number.isFinite(n) && n >= 0 && n !== step.ms) patch.ms = n;
        break;
      }
      case 'assertText':
        if (text !== step.text) patch.text = text;
        if (match !== step.match) patch.match = match;
        break;
    }
    onSave(patch);
  };

  const matchSelect = (
    <label>
      비교 방식
      <select value={match} onChange={(e) => setMatch(e.target.value as TextMatch)}>
        <option value="contains">포함</option>
        <option value="exact">정확히 일치</option>
      </select>
    </label>
  );

  return (
    <div className="step-edit" onKeyDown={(e) => e.key === 'Escape' && onCancel()}>
      {(step.type === 'navigate' || step.type === 'assertUrl') && (
        <label>
          URL
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" />
        </label>
      )}
      {step.type === 'assertUrl' && matchSelect}
      {(step.type === 'input' || step.type === 'select' || step.type === 'assertValue') && (
        <label>
          {step.type === 'select' ? '옵션 value' : step.type === 'assertValue' ? '기대하는 값' : '입력값'}
          <input value={value} onChange={(e) => setValue(e.target.value)} />
        </label>
      )}
      {step.type === 'select' && (
        <label>
          옵션 표시 텍스트 (value가 안 맞을 때 이걸로 찾음)
          <input value={label} onChange={(e) => setLabel(e.target.value)} />
        </label>
      )}
      {step.type === 'assertText' && (
        <>
          <label>
            기대하는 텍스트
            <input value={text} onChange={(e) => setText(e.target.value)} />
          </label>
          {matchSelect}
        </>
      )}
      {step.type === 'key' && (
        <label>
          키
          <select value={key} onChange={(e) => setKey(e.target.value as KeyName)}>
            {KEY_NAMES.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </label>
      )}
      {step.type === 'wait' && (
        <label>
          대기 시간(ms)
          <input type="number" min={0} value={ms} onChange={(e) => setMs(e.target.value)} />
        </label>
      )}
      <label>
        설명
        <input value={description} onChange={(e) => setDescription(e.target.value)} />
      </label>
      <div className="step-edit-actions">
        <button className="small primary" onClick={save}>
          저장
        </button>
        <button className="small ghost" onClick={onCancel}>
          취소
        </button>
        <button className="small ghost" title="위로" disabled={isFirst} onClick={() => onMove(-1)}>
          ↑ 위로
        </button>
        <button className="small ghost" title="아래로" disabled={isLast} onClick={() => onMove(1)}>
          ↓ 아래로
        </button>
      </div>
    </div>
  );
}

/** Add https:// when the user typed a bare host. */
export function normalizeUrl(input: string): string {
  const s = input.trim();
  return /^[a-z][a-z0-9+.-]*:/i.test(s) ? s : `https://${s}`;
}
