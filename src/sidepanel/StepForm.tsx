import { useState } from 'react';
import {
  KEY_NAMES,
  type KeyName,
  type Selector,
  type Step,
  type StepDraft,
  type StepType,
  type TextMatch,
} from '../shared/types';
import { defaultDescription, describeSelector } from '../shared/describe';
import { uid } from '../shared/uid';

/** Step kinds the form can build, in menu order, with the label a user sees. */
export const STEP_KINDS: { type: StepType; label: string; needsElement: boolean }[] = [
  { type: 'click', label: '클릭', needsElement: true },
  { type: 'input', label: '입력', needsElement: true },
  { type: 'select', label: '옵션 선택 (드롭다운)', needsElement: true },
  { type: 'key', label: '키 입력', needsElement: false },
  { type: 'navigate', label: '페이지 이동', needsElement: false },
  { type: 'wait', label: '대기', needsElement: false },
  { type: 'assertVisible', label: '확인 · 요소가 보임', needsElement: true },
  { type: 'assertHasText', label: '확인 · 텍스트가 나타남', needsElement: true },
  { type: 'assertText', label: '확인 · 텍스트 포함/일치', needsElement: true },
  { type: 'assertValue', label: '확인 · 입력값', needsElement: true },
  { type: 'assertUrl', label: '확인 · URL', needsElement: false },
];

export const needsElement = (t: StepType) => STEP_KINDS.find((k) => k.type === t)?.needsElement ?? false;

interface Props {
  /** Existing step to edit, or null to add a new one. */
  step: Step | null;
  /** Initial values for a new step (type, selector picked before the form opened, current URL). */
  initial?: { type?: StepType; selector?: Selector; url?: string };
  /** Selector delivered by the inspector while this form is open. */
  picked: Selector | null;
  picking: boolean;
  onPick: () => void;
  onSave: (step: Step) => void;
  onCancel: () => void;
}

/** The "무엇을?" form: one place to add or edit any kind of step. */
export function StepForm({ step, initial, picked, picking, onPick, onSave, onCancel }: Props) {
  const [type, setType] = useState<StepType>(step?.type ?? initial?.type ?? 'click');
  // The inspector's pick (App clears it when the form opens/closes) wins over what the form started with.
  const [initialSelector] = useState<Selector | null>(
    step && 'selector' in step ? step.selector : (initial?.selector ?? null),
  );
  const selector = picked ?? initialSelector;
  const [url, setUrl] = useState(step && 'url' in step ? step.url : (initial?.url ?? ''));
  const [value, setValue] = useState(step && 'value' in step ? step.value : '');
  const [label, setLabel] = useState(step?.type === 'select' ? (step.label ?? '') : '');
  const [key, setKey] = useState<KeyName>(step?.type === 'key' ? step.key : 'Enter');
  const [ms, setMs] = useState(step?.type === 'wait' ? String(step.ms) : '1000');
  const [text, setText] = useState(step?.type === 'assertText' ? step.text : '');
  const [match, setMatch] = useState<TextMatch>(
    step && 'match' in step ? step.match : 'contains',
  );
  const [description, setDescription] = useState(step?.description ?? '');
  const [customDesc, setCustomDesc] = useState(step ? step.description !== defaultDescription(step) : false);

  const elementRequired = needsElement(type);
  const draft = (): StepDraft | null => {
    switch (type) {
      case 'click':
      case 'assertVisible':
      case 'assertHasText':
        return selector ? { type, selector } : null;
      case 'input':
        return selector ? { type, selector, value } : null;
      case 'assertValue':
        return selector ? { type, selector, value } : null;
      case 'select':
        return selector ? { type, selector, value: value || label, label: label || undefined } : null;
      case 'assertText':
        return selector && text.trim() ? { type, selector, text: text.trim(), match } : null;
      case 'key':
        return { type, key };
      case 'navigate':
        return url.trim() ? { type, url: url.trim() } : null;
      case 'assertUrl':
        return url.trim() ? { type, url: url.trim(), match } : null;
      case 'wait': {
        const n = Number(ms);
        return Number.isFinite(n) && n >= 0 ? { type, ms: n } : null;
      }
    }
  };
  const d = draft();
  const canSave = d !== null;

  const save = () => {
    if (!d) return;
    const next = { ...d, id: step?.id ?? uid(), description: '' } as Step;
    next.description = customDesc && description.trim() ? description.trim() : defaultDescription(next);
    onSave(next);
  };

  const field = (labelText: string, input: React.ReactNode) => (
    <label className="f">
      <span className="f-label">{labelText}</span>
      {input}
    </label>
  );

  return (
    <div className="step-form" onKeyDown={(e) => e.key === 'Escape' && onCancel()}>
      {field(
        '무엇을?',
        <select value={type} disabled={!!step} onChange={(e) => setType(e.target.value as StepType)}>
          {STEP_KINDS.map((k) => (
            <option key={k.type} value={k.type}>
              {k.label}
            </option>
          ))}
        </select>,
      )}

      {elementRequired &&
        field(
          '어느 요소를?',
          <div className="f-row">
            <span className={`f-value ${selector ? '' : 'muted'}`}>
              {selector ? describeSelector(selector) : '아직 선택 안 함'}
            </span>
            <button className="btn sm" onClick={onPick} disabled={picking}>
              {picking ? '페이지에서 클릭하세요…' : selector ? '다시 선택' : '화면에서 선택'}
            </button>
          </div>,
        )}
      {elementRequired && selector?.warning && <p className="f-warn">⚠ {selector.warning}</p>}

      {(type === 'navigate' || type === 'assertUrl') &&
        field(
          type === 'navigate' ? '어디로?' : '어떤 URL이어야?',
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" />,
        )}
      {type === 'assertUrl' && matchField(match, setMatch)}
      {(type === 'input' || type === 'assertValue') &&
        field(
          type === 'input' ? '무엇을 입력?' : '어떤 값이어야?',
          <input value={value} onChange={(e) => setValue(e.target.value)} placeholder="입력할 값" />,
        )}
      {type === 'select' &&
        field(
          '어떤 옵션을?',
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="옵션에 보이는 글자" />,
        )}
      {type === 'select' && field('(선택) 옵션 value', <input value={value} onChange={(e) => setValue(e.target.value)} />)}
      {type === 'assertText' &&
        field('어떤 텍스트가?', <input value={text} onChange={(e) => setText(e.target.value)} placeholder="포함되어야 할 텍스트" />)}
      {type === 'assertText' && matchField(match, setMatch)}
      {type === 'key' &&
        field(
          '어떤 키를?',
          <select value={key} onChange={(e) => setKey(e.target.value as KeyName)}>
            {KEY_NAMES.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>,
        )}
      {type === 'wait' &&
        field('얼마나? (ms)', <input type="number" min={0} step={100} value={ms} onChange={(e) => setMs(e.target.value)} />)}

      {step &&
        field(
          '설명',
          <input
            value={customDesc ? description : defaultDescription(step)}
            onChange={(e) => {
              setCustomDesc(true);
              setDescription(e.target.value);
            }}
          />,
        )}

      <div className="f-actions">
        <button className="btn primary" disabled={!canSave} onClick={save}>
          {step ? '저장' : '추가'}
        </button>
        <button className="btn ghost" onClick={onCancel}>
          취소
        </button>
      </div>
    </div>
  );
}

function matchField(match: TextMatch, set: (m: TextMatch) => void) {
  return (
    <label className="f">
      <span className="f-label">비교 방식</span>
      <select value={match} onChange={(e) => set(e.target.value as TextMatch)}>
        <option value="contains">포함하면 통과</option>
        <option value="exact">정확히 일치해야 통과</option>
      </select>
    </label>
  );
}
