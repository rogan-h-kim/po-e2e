import type {
  Command,
  ContentRequest,
  LocateResponse,
  AssertResponse,
  SimpleResponse,
} from '../shared/messages';
import { RUNTIME } from '../shared/messages';
import type { KeyName, Selector, Step, StepResult, TextMatch } from '../shared/types';

// ---------------------------------------------------------------------------
// Background service worker.
//  - Routes side-panel commands to the active tab's content script.
//  - Owns the CDP (chrome.debugger) connection and dispatches *trusted* input
//    events for replay — this is what gives high-accuracy reproduction.
// ---------------------------------------------------------------------------

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});

async function activeTabId(): Promise<number> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.id) throw new Error('활성 탭을 찾을 수 없어요.');
  return tab.id;
}

function toContent<T>(tabId: number, req: ContentRequest): Promise<T> {
  return chrome.tabs.sendMessage(tabId, req) as Promise<T>;
}

/**
 * Make sure the content script is alive in the tab. If the tab was open before
 * the extension loaded/reloaded, the declared content script never ran — so we
 * ping it and inject on demand. This is the usual cause of "recording saves
 * nothing".
 */
async function ensureContent(tabId: number): Promise<void> {
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'PING' } as ContentRequest);
    return; // already there
  } catch {
    const files = chrome.runtime.getManifest().content_scripts?.[0]?.js ?? [];
    if (!files.length) throw new Error('주입할 content script를 찾지 못했어요.');
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files });
    } catch (e) {
      throw new Error(
        `이 페이지에는 주입할 수 없어요 (chrome:// 내부 페이지·웹스토어 등일 수 있음). ${(e as Error).message}`,
      );
    }
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Sleep without letting the service worker die. MV3 shuts the worker down after
 * ~30s with no extension API activity, and a bare setTimeout doesn't count as
 * activity — so a long `wait` step would silently kill the replay. Sleeping in
 * short chunks and touching a cheap extension API between them resets the timer.
 */
const KEEPALIVE_CHUNK_MS = 5000;
async function keptAliveSleep(ms: number) {
  let remaining = ms;
  while (remaining > 0) {
    const chunk = Math.min(remaining, KEEPALIVE_CHUNK_MS);
    await sleep(chunk);
    remaining -= chunk;
    if (remaining > 0) await chrome.runtime.getPlatformInfo();
  }
}

// ---- CDP helpers -------------------------------------------------------------
async function cdpAttach(tabId: number) {
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
  } catch (e) {
    // Already attached is fine; rethrow anything else.
    if (!String((e as Error).message).includes('already attached')) throw e;
  }
}

function cdp(tabId: number, method: string, params?: object): Promise<unknown> {
  return chrome.debugger.sendCommand({ tabId }, method, params);
}

async function cdpDetach(tabId: number) {
  try {
    await chrome.debugger.detach({ tabId });
  } catch {
    /* ignore */
  }
}

/** JPEG data URL of the visible tab, or undefined if the capture fails. */
async function screenshot(tabId: number): Promise<string | undefined> {
  try {
    const res = (await cdp(tabId, 'Page.captureScreenshot', { format: 'jpeg', quality: 55 })) as {
      data: string;
    };
    return `data:image/jpeg;base64,${res.data}`;
  } catch {
    return undefined;
  }
}

async function trustedClick(tabId: number, x: number, y: number) {
  await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await cdp(tabId, 'Input.dispatchMouseEvent', {
    type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1,
  });
  await cdp(tabId, 'Input.dispatchMouseEvent', {
    type: 'mouseReleased', x, y, button: 'left', buttons: 1, clickCount: 1,
  });
}

/** Resolved once; the OS never changes while the worker lives. */
const isMac: Promise<boolean> = chrome.runtime
  .getPlatformInfo()
  .then((info) => info.os === 'mac')
  .catch(() => false);

/**
 * Select-all in the focused field so insertText replaces instead of appends.
 * Windows/Linux: Ctrl+A. macOS: ⌘A — and because synthetic CDP key events skip
 * the OS's key→editing-command mapping, the 'selectAll' editing command must
 * be attached explicitly (this is what Playwright does on Mac too). Without it,
 * Ctrl+A on a Mac just moves the caret to the line start and the typed value
 * ends up prepended to the old one.
 */
async function selectAll(tabId: number) {
  const mac = await isMac;
  // CDP modifiers bitmask: Alt = 1, Ctrl = 2, Meta/Command = 4, Shift = 8.
  const key = {
    key: 'a',
    code: 'KeyA',
    windowsVirtualKeyCode: 65,
    nativeVirtualKeyCode: 65,
    modifiers: mac ? 4 : 2,
    ...(mac ? { commands: ['selectAll'] } : {}),
  };
  await cdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', ...key });
  await cdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', ...key });
}

async function trustedType(tabId: number, x: number, y: number, text: string) {
  await trustedClick(tabId, x, y); // focus
  await selectAll(tabId); // replace existing content
  await cdp(tabId, 'Input.insertText', { text });
}

/** CDP key descriptors. Keys that produce text (Enter → "\r") must be sent as
 *  `keyDown` with `text`, otherwise as `rawKeyDown` — same rule Playwright uses. */
const KEY_CODES: Record<KeyName, { code: string; vk: number; text?: string }> = {
  Enter: { code: 'Enter', vk: 13, text: '\r' },
  Escape: { code: 'Escape', vk: 27 },
  Tab: { code: 'Tab', vk: 9 },
  Backspace: { code: 'Backspace', vk: 8 },
  ArrowUp: { code: 'ArrowUp', vk: 38 },
  ArrowDown: { code: 'ArrowDown', vk: 40 },
  ArrowLeft: { code: 'ArrowLeft', vk: 37 },
  ArrowRight: { code: 'ArrowRight', vk: 39 },
};

async function trustedKey(tabId: number, key: KeyName) {
  const k = KEY_CODES[key];
  const base = { key, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk };
  await cdp(tabId, 'Input.dispatchKeyEvent', {
    type: k.text ? 'keyDown' : 'rawKeyDown',
    ...base,
    ...(k.text ? { text: k.text, unmodifiedText: k.text } : {}),
  });
  await cdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}

// ---- Navigation --------------------------------------------------------------
const NAV_TIMEOUT_MS = 15000;

/** Resolve once the tab reports `status: 'complete'`, or after the timeout —
 *  the next step's askContent() retry covers a page that is still settling. */
function waitForTabLoad(tabId: number): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => {
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      resolve();
    };
    const listener = (id: number, info: chrome.tabs.TabChangeInfo) => {
      if (id === tabId && info.status === 'complete') finish();
    };
    chrome.tabs.onUpdated.addListener(listener);
    const timer = setTimeout(finish, NAV_TIMEOUT_MS);
  });
}

async function navigate(tabId: number, url: string) {
  const loaded = waitForTabLoad(tabId); // subscribe before triggering the load
  await chrome.tabs.update(tabId, { url });
  await loaded;
}

// ---- Step execution ----------------------------------------------------------

/** How long a step keeps looking for its element / waiting for a condition before failing. */
const STEP_TIMEOUT_MS = 8000;
const RETRY_INTERVAL_MS = 250;

/**
 * Run `attempt` until `accept` is satisfied or STEP_TIMEOUT_MS elapses. A throw
 * inside `attempt` counts as a failed try, not a fatal error. On timeout the
 * last answer is returned so the caller can report the underlying reason.
 */
async function pollUntil<T>(attempt: () => Promise<T>, accept: (res: T) => boolean): Promise<T> {
  const deadline = Date.now() + STEP_TIMEOUT_MS;
  let last: T | undefined;
  let lastError: string | undefined;
  for (;;) {
    try {
      last = await attempt();
      if (accept(last)) return last;
    } catch (e) {
      lastError = (e as Error).message;
    }
    if (Date.now() >= deadline) break;
    await sleep(RETRY_INTERVAL_MS);
  }
  if (last) return last;
  throw new Error(`페이지가 응답하지 않아요 (${STEP_TIMEOUT_MS / 1000}초 대기). ${lastError ?? ''}`.trim());
}

/**
 * Ask the content script something, retrying until `accept` is satisfied.
 *
 * Why retry: a click can navigate the tab. The old page's content script dies
 * with the page, and the new page's one only appears once the document is
 * idle — so a fixed settle delay would race the page load and the next step
 * would fail with "Receiving end does not exist". Re-running ensureContent()
 * on every attempt covers full navigations; retrying on a "not found" answer
 * covers SPA routing and late-rendered elements.
 */
function askContent<T>(tabId: number, req: ContentRequest, accept: (res: T) => boolean): Promise<T> {
  return pollUntil(async () => {
    await ensureContent(tabId);
    return toContent<T>(tabId, req);
  }, accept);
}

const locate = (tabId: number, selector: Selector) =>
  askContent<LocateResponse>(tabId, { type: 'LOCATE', selector }, (r) => r.ok);

const assert = (tabId: number, req: ContentRequest) =>
  askContent<AssertResponse>(tabId, req, (r) => r.pass);

/** Check the tab URL (polled, since SPA routers update it a beat after the click). */
async function assertUrl(tabId: number, expected: string, match: TextMatch): Promise<AssertResponse> {
  const res = await pollUntil(
    async () => {
      const tab = await chrome.tabs.get(tabId);
      const url = tab.url ?? '';
      const pass = match === 'exact' ? url === expected : url.includes(expected);
      return { ok: true, pass, error: pass ? undefined : `현재 URL: ${url || '(없음)'}` };
    },
    (r) => r.pass,
  );
  return res;
}

const fail = (step: Step, error: string): StepResult => ({ stepId: step.id, ok: false, error });

async function runStep(tabId: number, step: Step): Promise<StepResult> {
  try {
    switch (step.type) {
      case 'navigate':
        await navigate(tabId, step.url);
        return { stepId: step.id, ok: true };

      case 'wait':
        await keptAliveSleep(step.ms);
        return { stepId: step.id, ok: true };

      case 'click': {
        const loc = await locate(tabId, step.selector);
        if (!loc.ok || loc.x == null || loc.y == null) return fail(step, loc.error || '요소 없음');
        await trustedClick(tabId, loc.x, loc.y);
        return { stepId: step.id, ok: true };
      }

      case 'input': {
        const loc = await locate(tabId, step.selector);
        if (!loc.ok || loc.x == null || loc.y == null) return fail(step, loc.error || '요소 없음');
        await trustedType(tabId, loc.x, loc.y, step.value);
        return { stepId: step.id, ok: true };
      }

      case 'select': {
        const res = await askContent<SimpleResponse>(
          tabId,
          { type: 'SELECT', selector: step.selector, value: step.value, label: step.label },
          (r) => r.ok,
        );
        return res.ok ? { stepId: step.id, ok: true } : fail(step, res.error || '옵션을 선택하지 못했어요.');
      }

      case 'key':
        await trustedKey(tabId, step.key);
        return { stepId: step.id, ok: true };

      case 'assertVisible': {
        const res = await assert(tabId, { type: 'ASSERT_VISIBLE', selector: step.selector });
        return res.pass ? { stepId: step.id, ok: true } : fail(step, res.error || '요소가 보이지 않아요.');
      }

      case 'assertHasText': {
        const res = await assert(tabId, { type: 'ASSERT_HAS_TEXT', selector: step.selector });
        return res.pass ? { stepId: step.id, ok: true } : fail(step, res.error || '영역에 텍스트가 없어요.');
      }

      case 'assertText': {
        const res = await assert(tabId, {
          type: 'ASSERT_TEXT',
          selector: step.selector,
          text: step.text,
          match: step.match,
        });
        return res.pass ? { stepId: step.id, ok: true } : fail(step, res.error || '텍스트가 일치하지 않아요.');
      }

      case 'assertValue': {
        const res = await assert(tabId, { type: 'ASSERT_VALUE', selector: step.selector, value: step.value });
        return res.pass ? { stepId: step.id, ok: true } : fail(step, res.error || '값이 일치하지 않아요.');
      }

      case 'assertUrl': {
        const res = await assertUrl(tabId, step.url, step.match);
        return res.pass ? { stepId: step.id, ok: true } : fail(step, res.error || 'URL이 일치하지 않아요.');
      }
    }
  } catch (e) {
    return fail(step, (e as Error).message);
  }
}

/**
 * Tabs with a replay in flight. Two concurrent loops on one tab would interleave
 * their input events and the first to finish would detach the debugger from
 * under the other — so a second PLAY/PLAY_STEP for a busy tab is refused.
 */
const playingTabs = new Set<number>();

async function playSteps(steps: Step[], continueOnFailure = false) {
  const startedAt = Date.now();
  const tabId = await activeTabId();
  if (playingTabs.has(tabId)) throw new Error('이 탭에서 이미 재생 중이에요. 끝날 때까지 기다려 주세요.');
  playingTabs.add(tabId);
  const results: StepResult[] = [];
  try {
    await ensureContent(tabId);
    await cdpAttach(tabId);
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      RUNTIME.emit({ type: 'PLAY_STEP_START', stepId: step.id, index: i, total: steps.length });
      const t0 = Date.now();
      const result = await runStep(tabId, step);
      result.durationMs = Date.now() - t0;
      if (!result.ok) result.screenshot = await screenshot(tabId);
      results.push(result);
      RUNTIME.emit({ type: 'PLAY_PROGRESS', result, index: i, total: steps.length });
      if (!result.ok && !continueOnFailure) break;
      await sleep(300); // small settle between steps
    }
  } finally {
    await cdpDetach(tabId);
    playingTabs.delete(tabId);
  }
  RUNTIME.emit({ type: 'PLAY_DONE', results, startedAt, finishedAt: Date.now() });
}

// ---- Command router (from side panel) ----------------------------------------
chrome.runtime.onMessage.addListener((msg: Command, _sender, sendResponse) => {
  (async () => {
    try {
      switch (msg.type) {
        case 'START_INSPECT':
        case 'STOP_INSPECT':
        case 'START_RECORD':
        case 'STOP_RECORD':
        case 'HIGHLIGHT': {
          const tabId = await activeTabId();
          await ensureContent(tabId);
          await toContent(tabId, msg as ContentRequest);
          sendResponse({ ok: true });
          break;
        }
        case 'PLAY':
          await playSteps(msg.steps, msg.continueOnFailure);
          sendResponse({ ok: true });
          break;
        case 'PLAY_STEP':
          await playSteps([msg.step]);
          sendResponse({ ok: true });
          break;
        default:
          sendResponse({ ok: false });
      }
    } catch (e) {
      sendResponse({ ok: false, error: (e as Error).message });
    }
  })();
  return true; // async response
});
