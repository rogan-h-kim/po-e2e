import type { Selector, Step, TextMatch } from './types';

/** Human-readable one-line description of a selector, used in step labels and the UI. */
export function describeSelector(selector: Selector): string {
  switch (selector.strategy) {
    case 'testid':
      return `[${selector.testid}]`;
    case 'role':
      return `${roleLabel(selector.role)} "${selector.name}"`;
    case 'text':
      return `"${selector.text}"`;
    case 'css':
      return selector.css;
  }
}

const matchLabel = (m: TextMatch) => (m === 'exact' ? '일치' : '포함');

/**
 * The auto-generated description for a step. Recording and the side panel both
 * use this, and the step editor regenerates it when a value changes unless the
 * user has overwritten the description by hand.
 */
export function defaultDescription(step: Step): string {
  switch (step.type) {
    case 'navigate':
      return `${step.url} 로 이동`;
    case 'click':
      return `${describeSelector(step.selector)} 클릭`;
    case 'input':
      return `${describeSelector(step.selector)}에 "${step.value}" 입력`;
    case 'select':
      return `${describeSelector(step.selector)}에서 "${step.label || step.value}" 선택`;
    case 'key':
      return `${step.key} 키 입력`;
    case 'wait':
      return `${step.ms}ms 대기`;
    case 'assertVisible':
      return `${describeSelector(step.selector)} 보임 확인`;
    case 'assertHasText':
      return `${describeSelector(step.selector)}에 텍스트 나타남 확인`;
    case 'assertText':
      return `${describeSelector(step.selector)}에 "${step.text}" ${matchLabel(step.match)} 확인`;
    case 'assertValue':
      return `${describeSelector(step.selector)} 값이 "${step.value}"인지 확인`;
    case 'assertUrl':
      return `URL에 "${step.url}" ${matchLabel(step.match)} 확인`;
  }
}

const ROLE_LABELS: Record<string, string> = {
  button: '버튼',
  link: '링크',
  textbox: '입력창',
  searchbox: '검색창',
  checkbox: '체크박스',
  radio: '라디오',
  combobox: '콤보박스',
  heading: '제목',
  tab: '탭',
  img: '이미지',
};

function roleLabel(role: string): string {
  return ROLE_LABELS[role] || role;
}
