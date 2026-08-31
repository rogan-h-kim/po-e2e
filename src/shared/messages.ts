import type { Selector, Step, StepResult, TextMatch } from './types';

// Commands: SidePanel -> Background (-> Content when needed)
export type Command =
  | { type: 'START_INSPECT' }
  | { type: 'STOP_INSPECT' }
  | { type: 'START_RECORD' }
  | { type: 'STOP_RECORD' }
  | { type: 'PLAY'; steps: Step[]; continueOnFailure?: boolean }
  | { type: 'PLAY_STEP'; step: Step }
  | { type: 'HIGHLIGHT'; selector: Selector };

// Events: Content -> Background -> SidePanel (broadcast via chrome.runtime)
export type Event =
  | { type: 'ELEMENT_PICKED'; selector: Selector }
  | { type: 'STEP_RECORDED'; step: Step }
  | { type: 'INSPECT_ENDED' }
  | { type: 'RECORD_ENDED' }
  | { type: 'PLAY_STEP_START'; stepId: string; index: number; total: number }
  | { type: 'PLAY_PROGRESS'; result: StepResult; index: number; total: number }
  | { type: 'PLAY_DONE'; results: StepResult[]; startedAt: number; finishedAt: number };

// Content-directed requests issued by Background (via chrome.tabs.sendMessage).
// These expect a response.
export type ContentRequest =
  | { type: 'PING' }
  | { type: 'START_INSPECT' }
  | { type: 'STOP_INSPECT' }
  | { type: 'START_RECORD' }
  | { type: 'STOP_RECORD' }
  | { type: 'LOCATE'; selector: Selector }
  | { type: 'SELECT'; selector: Selector; value: string; label?: string }
  | { type: 'ASSERT_VISIBLE'; selector: Selector }
  | { type: 'ASSERT_HAS_TEXT'; selector: Selector }
  | { type: 'ASSERT_TEXT'; selector: Selector; text: string; match: TextMatch }
  | { type: 'ASSERT_VALUE'; selector: Selector; value: string }
  | { type: 'HIGHLIGHT'; selector: Selector };

export interface SimpleResponse {
  ok: boolean;
  error?: string;
}

export interface LocateResponse extends SimpleResponse {
  x?: number;
  y?: number;
}

export interface AssertResponse {
  ok: boolean;
  /** Whether the assertion passed (element visible / region has text / …). */
  pass: boolean;
  error?: string;
}

export const RUNTIME = {
  /** Broadcast an event to all extension pages (side panel included). */
  emit(event: Event) {
    chrome.runtime.sendMessage(event).catch(() => {
      /* no listener (side panel closed) — ignore */
    });
  },
};
