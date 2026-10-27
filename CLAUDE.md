# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Po-Cake is a Chrome extension (Manifest V3) - a no-code E2E test recorder for deployed sites. It records user interactions as steps using accessibility-based selectors and replays them as **trusted input events via CDP** (`chrome.debugger`), so replayed events are indistinguishable from real user input. UI text is in Korean.

## Commands

```bash
npm run build      # tsc --noEmit + eslint + vite build → dist/
npm run dev        # HMR dev mode (crxjs)
npm run typecheck  # tsc --noEmit only
npm run lint       # eslint only (flat config in eslint.config.js)
```

There are no tests configured. To test manually: `npm run build`, then load `dist/` as an unpacked extension at `chrome://extensions` (developer mode).

The manifest is generated from `manifest.config.ts` by `@crxjs/vite-plugin` - edit that file, not a manifest.json.

## UI terminology (Korean)

Every user-visible string uses exactly these words - one word per concept, never a synonym. Code identifiers (`draft`, `publish`, `promote`, `record`, `play`, `publishers` table) keep their English names; only the Korean UI text changed.

| Concept | UI word | Do not use |
|---|---|---|
| a test (list of steps) | 시나리오 | - |
| one line of a scenario | 단계 | 재생 목록 |
| run a scenario / step | 실행 (전체 실행 · 선택 실행 · 이 단계만 실행) | 재생, 플레이 |
| recording: click the page to add steps | 화면에서 만들기 / 만들기 중지 | 녹화 |
| scenario only in this browser (`draft`) | 내 시나리오 | 초안 |
| scenario in the team suite | 팀 시나리오 | 게시됨 |
| move a draft into the team suite (`promote`) | 팀 시나리오로 옮기기 | 승격 |
| push pending team changes to Supabase (`publish`) | 공유 (선택 공유 · 모두 공유 · 공유 안 됨) | 게시 |
| someone in the `publishers` table | 공유 권한 (있음/없음) | 게시자 |
| a suite (`Suite`) | 버전 | 제품 버전, 스위트, 세트 |
| an assertion step | 확인 | 검증 |

## Architecture

Three extension contexts communicate via typed messages defined in `src/shared/messages.ts` (the single source of truth for the protocol):

- **Side panel** (`src/sidepanel/`, React; light Toss-style UI, tokens at the top of `styles.css`): tabs in `App.tsx` - 시나리오 (`ScenarioListTab`: suite scenarios grouped by folder + drafts, run one/folder/all; opening a scenario switches the tab's `view` to a detail screen rendered inline in App - steps, form, run history - with ← back), 공유 (`PublishTab`, publishers only: pending changes, suite management), 설정 (`SettingsTab`: account, replay option, import/export). Runners see two tabs, publishers three; tab labels never change. `SuiteHeader` (suite picker + ↻) sits above the tabs; `useTeam.ts` owns team state. Steps are added/edited through one form, `StepForm.tsx` ("무엇을?" type picker → per-type fields → "화면에서 선택" starts the inspector and the picked selector flows back in via the `picked` prop) - never through `prompt()`. Row actions live in a `MoreMenu` (⋯). The edit tab has a fixed bottom bar (＋ 단계 추가 · ● 화면에서 만들기 · ▶ 전체 실행 · 공유). Sends `Command`s to the background; receives broadcast `Event`s via `chrome.runtime.onMessage`.
- **Content script** (`src/content/`): element picking/highlighting, selector generation, recording listeners, and locating elements (returns viewport x/y coordinates). Receives `ContentRequest`s (request/response via `chrome.tabs.sendMessage`).
- **Background service worker** (`src/background/index.ts`): routes side-panel commands to the active tab, owns the CDP connection, and is the replay engine. For click/input steps it asks the content script to `LOCATE` the element, then dispatches trusted mouse/key events at those coordinates via `Input.dispatchMouseEvent` / `Input.insertText`. Every content request during replay goes through `askContent()`, which re-runs `ensureContent()` and retries until the element is found (or `STEP_TIMEOUT_MS` elapses) - this is what lets a step survive the page navigation triggered by the previous step.

Shared helpers live in `src/shared/`: `uid.ts` (step ids), `describe.ts` (`describeSelector` - the one human-readable selector label used by both the content script and the side panel).

Message flow: SidePanel → `Command` → Background → `ContentRequest` → Content; Content/Background broadcast `Event`s back via `RUNTIME.emit()`. When adding a step type or message, update the unions in `shared/messages.ts` and `shared/types.ts` first - all three contexts switch on them, and `defaultDescription()` in `shared/describe.ts` plus `TYPE_ICON`/`StepEditor` in `sidepanel/StepRow.tsx` must learn the new type too.

Step types: `navigate` (tabs.update + wait for `status: complete`), `click`/`input` (LOCATE → CDP mouse/insertText), `select` (content sets `<select>.value` and fires input/change - the one non-trusted step, because native select popups can't be driven via CDP), `key` (CDP `Input.dispatchKeyEvent`, Enter carries `text: "
"`), `wait`, and assertions `assertVisible`, `assertHasText` (any text), `assertText` (contains/exact), `assertValue` (form control value), `assertUrl` (tab URL, checked in the background via `chrome.tabs.get`). Every assertion is polled through `pollUntil()` for up to `STEP_TIMEOUT_MS`, so it doubles as a wait.

- Replay diagnostics: the background emits `PLAY_STEP_START` (side panel highlights the running row), stamps `durationMs` on every result and a JPEG `screenshot` (CDP `Page.captureScreenshot`) on failed ones. `PLAY` accepts `continueOnFailure`; the side panel persists that toggle in `storage.local`. Full runs (not single-step plays) are saved by the side panel via `shared/runs.ts` — local only, capped at `MAX_RUNS_PER_SCENARIO` per scenario because of the screenshots. Recording auto-inserts a `navigate` to the current URL when it starts on an empty scenario; keydown recording flushes the focused field's value first so Enter replays after the typed text, and skips IME composition keystrokes.

### Selector strategy (`src/content/selector.ts`)

Priority: `testid` → `role+name` → `text` → `css`. CSS fallback carries a `warning`; non-unique matches get an `nth` index plus a warning. Role/accessible-name computation is an approximation of ARIA (explicit `role` attr, else implicit-by-tag), not the full spec.

### Persistence & sharing (publisher / runner model)

## Two kinds of scenario, both in `chrome.storage.local` (`src/shared/scenarios.ts`). Team scenarios carry a one-level `folder` (feature area) inside their suite; `Suite.folders` keeps the ordered folder list so empty folders exist. Team scenarios are grouped into **suites** (`Suite`: one per product version or team; `DEFAULT_SUITE_ID = 'main'`), and releases are numbered per suite.

- \*_Drafts_- — this browser's own scenarios (key `po-cake:scenarios`, the pre-refactor key, so old local data simply became drafts). Anyone can create/edit them; they leave the browser only via JSON export. Seeded scenarios (`seed.ts`) land here.
- **Team** — a mirror of the published set from Supabase (`po-cake:team`) plus `teamSnapshot` (last state received from / published to the server) and `teamRelease` (`{version, publishedAt, publishedBy}`). `teamChanges(team, snapshot)` diffs the two to count unpublished changes.

## Roles are decided by Supabase Auth, enforced by RLS, and only _reflected_ by the UI:

- **Runner** (no session): reads team scenarios (auto-refreshed when the panel opens, replaced wholesale — no merge), runs them, edits drafts. `canEdit` in `App.tsx` is `activeIsDraft || isPublisher`-
- **Publisher** (signed in via ⚙, email present in the `publishers` table): edits team scenarios locally, promotes drafts (`↑`) into the active suite, manages suites (create/rename/duplicate/archive — written immediately via `saveSuite()`), and `[↑ 게시]` (or "이것만 게시" per scenario) publishes the active suite's pending changes as its next release (`publishSuite()`: delete removed ids → upsert changed → insert `releases` row with `changed_ids`).
- **Several publishers**: every refresh (and every publish, which refreshes first) is a three-way **rebase** at scenario granularity (`rebase()` in `scenarios.ts`: snapshot = base, local = mine, server = theirs). Scenarios only I touched keep my version, ones only they touched take theirs, both-touched ones are `Conflict`s the user resolves via `confirm()`. "되돌리기" is `refresh(true)` = discard mine.
- **Suite run**: `PLAY_SUITE` runs every scenario of the active suite on one debugger session; the background emits `SUITE_SCENARIO_START`, per-step events, `PLAY_DONE` with `scenarioId` for each, then `SUITE_DONE`. The side panel records a `RunRecord` per scenario and shows `SuiteRunPanel`. A failed scenario never stops the next one.

## Tables: `suites`, `scenarios` (`suite_id`), `releases` (pk `suite_id, version`), `publishers`. `src/sidepanel/supabase.ts`: connection settings come **only** from the build (`.env` → `import.meta.env.VITE_SUPABASE_*`); there is no per-user config screen. Without them the team section is hidden and the build is fully offline. The supabase-js session is persisted through a `chrome.storage.local` storage adapter. `src/sidepanel/useTeam.ts` owns session + mirror state; `TeamBar.tsx` is the status line and the sign-in modal (with `SETUP_SQL`).

Signups must be disabled in the Supabase project; publisher accounts are created in the dashboard. Reads are open to anyone holding the build (anon key) by design — never put secrets in scenario input values.

### Gotchas

-
- Tabs opened before the extension loaded/reloaded-have no content script; the background's `ensureContent()` pings and injects on demand — go through it rather than messaging a tab directly. Because the manifest also injects at `document_idle`, a document can end up with the script loaded twice; `src/content/index.ts` guards with `window.__poCakeContentLoaded` so only the first instance answers messages.
- `content_scripts` runs with `all_frames: false` — elements inside iframes can't be recorded or replayed.-
- The background keeps a per-tab replay lock (`playingTabs`) and refuses a second PLAY/PLAY_STEP for a busy tab — the side panel surfaces that as an alert. Long `wait` steps go through `keptAliveSleep()`, which pings an extension API every 5s so the MV3 worker isn't shut down mid-run (a bare setTimeout doesn't count as activity).
- `input` replay clears the field with a select-all keystroke that is pla-form-specific: Ctrl+A on Windows/Linux, ⌘A plus the explicit `commands: ['selectAll']` CDP param on macOS (synthetic events bypass the OS editing-command mapping, so the modifier alone does nothing there). See `selectAll()` in the background.
- Replay intentionally shows Chrome's "is debugging this browser" banner — that's the CDP attach and is required for trusted events, not a bug.
- The Supabase anon key is deliberately shippable in the client; what it can do is decided by RLS (`SETUP_SQL` in `supabase.ts`): select for everyone, writes only when `auth.email()` is in `publishers`. Don't add UI-only permission checks and assume they protect anything.
