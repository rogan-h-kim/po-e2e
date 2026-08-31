// ---------------------------------------------------------------------------
// Selector: how we point at an element on the page.
// Priority (most stable → least): testid > role+name > text > css.
// A `warning` marks a low-accuracy / maintenance-fragile selector (Cake style).
// ---------------------------------------------------------------------------
export type Selector =
  | { strategy: 'testid'; testid: string; warning?: string }
  | { strategy: 'role'; role: string; name: string; nth?: number; warning?: string }
  | { strategy: 'text'; text: string; nth?: number; warning?: string }
  | { strategy: 'css'; css: string; warning?: string };

export type StepType =
  | 'navigate'
  | 'click'
  | 'input'
  | 'select'
  | 'key'
  | 'wait'
  | 'assertVisible'
  | 'assertHasText'
  | 'assertText'
  | 'assertValue'
  | 'assertUrl';

/** Keys a `key` step can press. Recording captures Enter/Escape/Tab; the rest are added by hand. */
export const KEY_NAMES = [
  'Enter',
  'Escape',
  'Tab',
  'Backspace',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
] as const;
export type KeyName = (typeof KEY_NAMES)[number];

/** How an expected string is compared: as a substring, or the whole (whitespace-normalised) value. */
export type TextMatch = 'contains' | 'exact';

interface StepBase {
  id: string;
  type: StepType;
  description: string;
}

/** Load a URL in the tab and wait for the page to finish loading. Usually the
 *  first step of a scenario — it makes the scenario reproducible from anywhere. */
export interface NavigateStep extends StepBase {
  type: 'navigate';
  url: string;
}

export interface ClickStep extends StepBase {
  type: 'click';
  selector: Selector;
}

export interface InputStep extends StepBase {
  type: 'input';
  selector: Selector;
  value: string;
}

/** Choose an option in a <select>. `value` is the option's value attribute;
 *  `label` is its visible text (kept for the description and as a fallback match). */
export interface SelectStep extends StepBase {
  type: 'select';
  selector: Selector;
  value: string;
  label?: string;
}

/** Press a single key on whatever currently has focus (Enter to submit, Esc to close, …). */
export interface KeyStep extends StepBase {
  type: 'key';
  key: KeyName;
}

export interface WaitStep extends StepBase {
  type: 'wait';
  ms: number;
}

export interface AssertVisibleStep extends StepBase {
  type: 'assertVisible';
  selector: Selector;
}

/** Assert that a region contains some (non-empty) visible text — the content
 *  doesn't matter, only that *something* appeared there. */
export interface AssertHasTextStep extends StepBase {
  type: 'assertHasText';
  selector: Selector;
}

/** Assert that a region's visible text contains / equals the expected text. */
export interface AssertTextStep extends StepBase {
  type: 'assertText';
  selector: Selector;
  text: string;
  match: TextMatch;
}

/** Assert that a form control's current value equals the expected value. */
export interface AssertValueStep extends StepBase {
  type: 'assertValue';
  selector: Selector;
  value: string;
}

/** Assert the tab's URL contains / equals the expected URL. */
export interface AssertUrlStep extends StepBase {
  type: 'assertUrl';
  url: string;
  match: TextMatch;
}

export type Step =
  | NavigateStep
  | ClickStep
  | InputStep
  | SelectStep
  | KeyStep
  | WaitStep
  | AssertVisibleStep
  | AssertHasTextStep
  | AssertTextStep
  | AssertValueStep
  | AssertUrlStep;

/** A step without its id/description — what recording and the side panel build before makeStep() fills them in.
 *  Distributes over the union so each variant keeps its own fields (plain Omit<Step, …> would not). */
export type StepDraft = Step extends infer S ? (S extends Step ? Omit<S, 'id' | 'description'> : never) : never;

export interface Scenario {
  id: string;
  name: string;
  steps: Step[];
  createdAt: number;
  updatedAt: number;
  /** Team scenarios belong to a suite; drafts have none. */
  suiteId?: string;
  /** One-level grouping inside the suite (a feature area: "AI Draft", "home", …). Undefined = 미분류. */
  folder?: string;
}

/**
 * A suite groups the team scenarios for one product version (or one team).
 * Runners pick a suite and run one scenario or the whole set; releases are
 * numbered per suite.
 */
export interface Suite {
  id: string;
  name: string;
  archived: boolean;
  /** Folder names in display order (so empty folders exist and order is stable). */
  folders: string[];
  createdAt: number;
  updatedAt: number;
}

export const DEFAULT_SUITE_ID = 'main';

export interface StepResult {
  stepId: string;
  ok: boolean;
  error?: string;
  /** Wall-clock time the step took, including any element-wait retries. */
  durationMs?: number;
  /** JPEG data URL of the tab at the moment of failure (failed steps only). */
  screenshot?: string;
}

/** A published version of one suite (one row in the `releases` table). */
export interface Release {
  suiteId: string;
  version: number;
  publishedAt: number;
  publishedBy: string | null;
  /** Scenario ids added/changed/deleted in this release. */
  changedIds: string[];
}

/** One full replay of a scenario, kept locally (not synced) for later diagnosis. */
export interface RunRecord {
  id: string;
  scenarioId: string;
  startedAt: number;
  finishedAt: number;
  /** Number of steps in the scenario at the time of the run. */
  stepCount: number;
  ok: boolean;
  results: StepResult[];
  /** Description of the first failed step, for the history list. */
  failedStep?: string;
}
