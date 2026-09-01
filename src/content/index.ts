import type {
  ContentRequest,
  LocateResponse,
  AssertResponse,
  SimpleResponse,
  Event,
} from '../shared/messages';
import type { KeyName, Selector, Step, StepDraft, TextMatch } from '../shared/types';
import { defaultDescription, describeSelector } from '../shared/describe';
import { uid } from '../shared/uid';
import { generateSelector, resolveTarget, findElement } from './selector';

// ---------------------------------------------------------------------------
// Content script: runs in the page. Responsible for the "easy" accuracy-neutral
// work - highlighting, selecting, recording, and locating elements. It never
// dispatches the real replay events itself (that's the background via CDP, for
// trusted events); it only reports coordinates. The one exception is <select>,
// which has no reliable trusted-input path, so it is set directly in the DOM.
// ---------------------------------------------------------------------------

let inspecting = false;
let recording = false;

// ---- Highlight overlay --------------------------------------------------------
const overlay = document.createElement('div');
Object.assign(overlay.style, {
  position: 'fixed',
  zIndex: '2147483647',
  pointerEvents: 'none',
  border: '2px solid #3b82f6',
  background: 'rgba(59,130,246,0.15)',
  borderRadius: '3px',
  display: 'none',
  transition: 'all 40ms linear',
} as CSSStyleDeclaration);

const label = document.createElement('div');
Object.assign(label.style, {
  position: 'fixed',
  zIndex: '2147483647',
  pointerEvents: 'none',
  padding: '2px 6px',
  font: '12px/1.4 -apple-system, system-ui, sans-serif',
  color: '#fff',
  background: '#3b82f6',
  borderRadius: '3px',
  display: 'none',
  maxWidth: '320px',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
} as CSSStyleDeclaration);

function mountOverlay() {
  if (!overlay.isConnected) document.documentElement.append(overlay, label);
}

function showHighlight(el: Element, text: string, color = '#3b82f6') {
  mountOverlay();
  const rect = el.getBoundingClientRect();
  overlay.style.borderColor = color;
  overlay.style.background = color === '#3b82f6' ? 'rgba(59,130,246,0.15)' : 'rgba(16,185,129,0.15)';
  overlay.style.display = 'block';
  overlay.style.left = `${rect.left}px`;
  overlay.style.top = `${rect.top}px`;
  overlay.style.width = `${rect.width}px`;
  overlay.style.height = `${rect.height}px`;
  label.style.background = color;
  label.style.display = 'block';
  label.style.left = `${rect.left}px`;
  label.style.top = `${Math.max(0, rect.top - 22)}px`;
  label.textContent = text;
}

function hideHighlight() {
  overlay.style.display = 'none';
  label.style.display = 'none';
}

/**
 * True once the extension has been reloaded/updated underneath this page. The
 * old script instance stays alive in the tab, but every chrome.* call from it
 * throws "Extension context invalidated" - so we go quiet instead of spamming
 * the extension's error list. A page reload (F5) brings in the fresh script.
 */
const contextGone = () => !chrome.runtime?.id;

function emit(event: Event) {
  if (contextGone()) return;
  try {
    chrome.runtime.sendMessage(event).catch(() => {});
  } catch {
    /* context invalidated between the check and the call */
  }
}

// ---- Inspect (manual element pick) -------------------------------------------
function onInspectMove(e: MouseEvent) {
  if (contextGone()) return stopInspect();
  const el = e.target as Element;
  if (!el || el === overlay || el === label) return;
  const target = resolveTarget(el);
  const selector = generateSelector(target);
  showHighlight(target, describeSelector(selector));
}

function onInspectClick(e: MouseEvent) {
  e.preventDefault();
  e.stopPropagation();
  const target = resolveTarget(e.target as Element);
  const selector = generateSelector(target);
  emit({ type: 'ELEMENT_PICKED', selector });
  stopInspect();
}

function startInspect() {
  if (inspecting) return;
  inspecting = true;
  document.addEventListener('mousemove', onInspectMove, true);
  document.addEventListener('click', onInspectClick, true);
  document.body.style.cursor = 'crosshair';
}

function stopInspect() {
  if (!inspecting) return;
  inspecting = false;
  document.removeEventListener('mousemove', onInspectMove, true);
  document.removeEventListener('click', onInspectClick, true);
  document.body.style.cursor = '';
  hideHighlight();
  emit({ type: 'INSPECT_ENDED' });
}

// ---- Recording (listen to real user actions) ---------------------------------

/** Value of each text field at the time we last recorded it, so one edit
 *  doesn't produce duplicate input steps (change → blur → Enter all arrive). */
const lastRecordedValue = new WeakMap<Element, string>();

const RECORDED_KEYS: ReadonlySet<string> = new Set<KeyName>(['Enter', 'Escape', 'Tab']);

function isTextField(el: Element): el is HTMLInputElement | HTMLTextAreaElement {
  const tag = el.tagName.toLowerCase();
  return (tag === 'input' || tag === 'textarea') && !isButtonLike(el);
}

function isButtonLike(el: Element): boolean {
  const type = (el.getAttribute('type') || '').toLowerCase();
  return ['button', 'submit', 'reset', 'checkbox', 'radio'].includes(type);
}

function record(partial: StepDraft) {
  const step = { ...partial, id: uid(), description: '' } as Step;
  step.description = defaultDescription(step);
  emit({ type: 'STEP_RECORDED', step });
}

function onRecordClick(e: MouseEvent) {
  if (contextGone()) return stopRecord();
  const target = resolveTarget(e.target as Element);
  // Skip clicks that only focus a field about to be typed into / picked from.
  if (isTextField(target) || target instanceof HTMLSelectElement) return;
  record({ type: 'click', selector: generateSelector(target) });
  flashRecorded(target);
}

/** Emit an input step for a text field if its value changed since last recorded. */
function recordInputIfChanged(el: HTMLInputElement | HTMLTextAreaElement) {
  if (lastRecordedValue.get(el) === el.value) return;
  lastRecordedValue.set(el, el.value);
  record({ type: 'input', selector: generateSelector(el), value: el.value });
  flashRecorded(el);
}

function onRecordChange(e: globalThis.Event) {
  const el = e.target as Element;
  if (el instanceof HTMLSelectElement) {
    const opt = el.selectedOptions[0];
    record({
      type: 'select',
      selector: generateSelector(el),
      value: el.value,
      label: opt ? opt.text.trim() : undefined,
    });
    flashRecorded(el);
    return;
  }
  if (isTextField(el)) recordInputIfChanged(el);
}

function onRecordKeydown(e: KeyboardEvent) {
  if (!RECORDED_KEYS.has(e.key)) return;
  // Korean/Japanese IME: Enter while composing only commits the composition.
  if (e.isComposing || e.keyCode === 229) return;
  // Enter in a text field submits before the field's change event would have
  // fired, so flush the typed value first - otherwise the key replays before the text.
  const target = e.target as Element;
  if (target && isTextField(target)) recordInputIfChanged(target);
  record({ type: 'key', key: e.key as KeyName });
}

function flashRecorded(el: Element) {
  showHighlight(el, '● 녹화됨', '#10b981');
  setTimeout(hideHighlight, 400);
}

function startRecord() {
  if (recording) return;
  recording = true;
  document.addEventListener('click', onRecordClick, true);
  document.addEventListener('change', onRecordChange, true);
  document.addEventListener('keydown', onRecordKeydown, true);
}

function stopRecord() {
  if (!recording) return;
  recording = false;
  document.removeEventListener('click', onRecordClick, true);
  document.removeEventListener('change', onRecordChange, true);
  document.removeEventListener('keydown', onRecordKeydown, true);
  emit({ type: 'RECORD_ENDED' });
}

// ---- Locate / select / assert (for replay) ----------------------------------
function locate(selector: Selector): LocateResponse {
  const el = findElement(selector);
  if (!el) return { ok: false, error: '요소를 찾지 못했어요.' };
  el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' as ScrollBehavior });
  const rect = el.getBoundingClientRect();
  const x = Math.round(Math.min(Math.max(rect.left + rect.width / 2, 1), window.innerWidth - 1));
  const y = Math.round(Math.min(Math.max(rect.top + rect.height / 2, 1), window.innerHeight - 1));
  showHighlight(el, describeSelector(selector), '#10b981');
  setTimeout(hideHighlight, 600);
  return { ok: true, x, y };
}

/** Pick a <select> option by value (or, failing that, by visible text) and fire
 *  the input/change events frameworks listen to. Not a trusted event, but a
 *  native <select> popup can't be driven reliably through CDP mouse input. */
function selectOption(selector: Selector, value: string, optLabel?: string): SimpleResponse {
  const el = findElement(selector);
  if (!el) return { ok: false, error: '요소를 찾지 못했어요.' };
  if (!(el instanceof HTMLSelectElement)) return { ok: false, error: '<select> 요소가 아니에요.' };
  const options = Array.from(el.options);
  const wanted = (optLabel ?? value).trim();
  const opt = options.find((o) => o.value === value) ?? options.find((o) => o.text.trim() === wanted);
  if (!opt) return { ok: false, error: `옵션 "${wanted}"을(를) 찾지 못했어요.` };
  el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' as ScrollBehavior });
  el.focus();
  el.value = opt.value;
  el.dispatchEvent(new window.Event('input', { bubbles: true }));
  el.dispatchEvent(new window.Event('change', { bubbles: true }));
  showHighlight(el, `"${opt.text.trim()}" 선택`, '#10b981');
  setTimeout(hideHighlight, 600);
  return { ok: true };
}

function isVisible(el: Element): boolean {
  const rect = el.getBoundingClientRect();
  const style = getComputedStyle(el);
  return (
    rect.width > 0 &&
    rect.height > 0 &&
    style.visibility !== 'hidden' &&
    style.display !== 'none' &&
    style.opacity !== '0'
  );
}

function assertVisible(selector: Selector): AssertResponse {
  const el = findElement(selector);
  if (!el) return { ok: true, pass: false };
  return { ok: true, pass: isVisible(el) };
}

/** Pass if the region is visible AND holds some non-whitespace text - used to
 *  check "something (anything) appeared here", regardless of the exact text. */
function assertHasText(selector: Selector): AssertResponse {
  const el = findElement(selector);
  if (!el) return { ok: true, pass: false, error: '영역을 찾지 못했어요.' };
  if (!isVisible(el)) return { ok: true, pass: false, error: '영역이 보이지 않아요.' };
  const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
  if (!text) return { ok: true, pass: false, error: '영역에 텍스트가 없어요.' };
  showHighlight(el, '텍스트 있음', '#10b981');
  setTimeout(hideHighlight, 600);
  return { ok: true, pass: true };
}

const normalizeText = (s: string | null | undefined) => (s || '').replace(/\s+/g, ' ').trim();

/** Pass if the region is visible and its text contains / equals `expected`. */
function assertText(selector: Selector, expected: string, match: TextMatch): AssertResponse {
  const el = findElement(selector);
  if (!el) return { ok: true, pass: false, error: '영역을 찾지 못했어요.' };
  if (!isVisible(el)) return { ok: true, pass: false, error: '영역이 보이지 않아요.' };
  const actual = normalizeText(el.textContent);
  const want = normalizeText(expected);
  const pass = match === 'exact' ? actual === want : actual.includes(want);
  if (!pass) {
    const shown = actual.length > 120 ? actual.slice(0, 120) + '…' : actual;
    return { ok: true, pass: false, error: `실제 텍스트: "${shown || '(비어 있음)'}"` };
  }
  showHighlight(el, '텍스트 일치', '#10b981');
  setTimeout(hideHighlight, 600);
  return { ok: true, pass: true };
}

/** Pass if a form control's current value equals `expected`. */
function assertValue(selector: Selector, expected: string): AssertResponse {
  const el = findElement(selector);
  if (!el) return { ok: true, pass: false, error: '요소를 찾지 못했어요.' };
  if (
    !(el instanceof HTMLInputElement) &&
    !(el instanceof HTMLTextAreaElement) &&
    !(el instanceof HTMLSelectElement)
  ) {
    return { ok: true, pass: false, error: '값을 가진 입력 요소가 아니에요.' };
  }
  if (el.value !== expected) return { ok: true, pass: false, error: `실제 값: "${el.value}"` };
  showHighlight(el, '값 일치', '#10b981');
  setTimeout(hideHighlight, 600);
  return { ok: true, pass: true };
}

// ---- Message router ----------------------------------------------------------
// The script can be injected twice into one document: once by the manifest
// declaration (document_idle) and once by the background's on-demand
// executeScript (see ensureContent). Only the first instance answers messages.
declare global {
  interface Window {
    __poCakeContentLoaded?: boolean;
  }
}
if (window.__poCakeContentLoaded) {
  console.debug('[po-cake] content script already loaded in this document; skipping');
} else {
  window.__poCakeContentLoaded = true;
  chrome.runtime.onMessage.addListener((msg: ContentRequest, _sender, sendResponse) => {
    switch (msg.type) {
      case 'PING':
        sendResponse({ ok: true });
        break;
      case 'START_INSPECT':
        startInspect();
        sendResponse({ ok: true });
        break;
      case 'STOP_INSPECT':
        stopInspect();
        sendResponse({ ok: true });
        break;
      case 'START_RECORD':
        startRecord();
        sendResponse({ ok: true });
        break;
      case 'STOP_RECORD':
        stopRecord();
        sendResponse({ ok: true });
        break;
      case 'LOCATE':
        sendResponse(locate(msg.selector));
        break;
      case 'SELECT':
        sendResponse(selectOption(msg.selector, msg.value, msg.label));
        break;
      case 'ASSERT_VISIBLE':
        sendResponse(assertVisible(msg.selector));
        break;
      case 'ASSERT_HAS_TEXT':
        sendResponse(assertHasText(msg.selector));
        break;
      case 'ASSERT_TEXT':
        sendResponse(assertText(msg.selector, msg.text, msg.match));
        break;
      case 'ASSERT_VALUE':
        sendResponse(assertValue(msg.selector, msg.value));
        break;
      case 'HIGHLIGHT': {
        const el = findElement(msg.selector);
        if (el) {
          showHighlight(el, describeSelector(msg.selector), '#f59e0b');
          setTimeout(hideHighlight, 1200);
        }
        sendResponse({ ok: !!el });
        break;
      }
      default:
        sendResponse({ ok: false });
    }
    return true; // keep the message channel open for async sendResponse
  });
}
