# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Po-Cake is a Chrome extension (Manifest V3) — a no-code E2E test recorder for deployed sites. It records user interactions as steps using accessibility-based selectors and replays them as **trusted input events via CDP** (`chrome.debugger`), so replayed events are indistinguishable from real user input. UI text is in Korean.

## Commands

```bash
npm run build      # tsc --noEmit + eslint + vite build → dist/
npm run dev        # HMR dev mode (crxjs)
npm run typecheck  # tsc --noEmit only
npm run lint       # eslint only (flat config in eslint.config.js)
```

There are no tests configured. To test manually: `npm run build`, then load `dist/` as an unpacked extension at `chrome://extensions` (developer mode).

The manifest is generated from `manifest.config.ts` by `@crxjs/vite-plugin` — edit that file, not a manifest.json.

## Architecture

Three extension contexts communicate via typed messages defined in `src/shared/messages.ts` (the single source of truth for the protocol):

- **Side panel** (`src/sidepanel/`, React): recording/replay/step-management UI. Sends `Command`s to the background; receives broadcast `Event`s via `chrome.runtime.onMessage`.
- **Content script** (`src/content/`): element picking/highlighting, selector generation, recording listeners, and locating elements (returns viewport x/y coordinates). Receives `ContentRequest`s (request/response via `chrome.tabs.sendMessage`).
- **Background service worker** (`src/background/index.ts`): routes side-panel commands to the active tab, owns the CDP connection, and is the replay engine. For click/input steps it asks the content script to `LOCATE` the element, then dispatches trusted mouse/key events at those coordinates via `Input.dispatchMouseEvent` / `Input.insertText`. Every content request during replay goes through `askContent()`, which re-runs `ensureContent()` and retries until the element is found (or `STEP_TIMEOUT_MS` elapses) — this is what lets a step survive the page navigation triggered by the previous step.

Shared helpers live in `src/shared/`: `uid.ts` (step ids), `describe.ts` (`describeSelector` — the one human-readable selector label used by both the content script and the side panel).

Message flow: SidePanel → `Command` → Background → `ContentRequest` → Content; Content/Background broadcast `Event`s back via `RUNTIME.emit()`. When adding a step type or message, update the unions in `shared/messages.ts` and `shared/types.ts` first — all three contexts switch on them, and `defaultDescription()` in `shared/describe.ts` plus `TYPE_ICON`/`StepEditor` in `sidepanel/StepRow.tsx` must learn the new type too.

Step types: `navigate` (tabs.update + wait for `status: complete`), `click`/`input` (LOCATE → CDP mouse/insertText), `select` (content sets `<select>.value` and fires input/change — the one non-trusted step, because native select popups can't be driven via CDP), `key` (CDP `Input.dispatchKeyEvent`, Enter carries `text: ""`), `wait`, and assertions `assertVisible`, `assertHasText` (any text), `assertText` (contains/exact), `assertValue` (form control value), `assertUrl` (tab URL, checked in the background via `chrome.tabs.get`). Every assertion is polled through `pollUntil()` for up to `STEP_TIMEOUT_MS`, so it doubles as a wait.

Replay diagnostics: the background emits `PLAY_STEP_START` (side panel highlights the running row), stamps `durationMs` on every result and a JPEG `screenshot` (CDP `Page.captureScreenshot`) on failed ones. `PLAY` accepts `continueOnFailure`; the side panel persists that toggle in `storage.local`. Full runs (not single-step plays) are saved by the side panel via `shared/runs.ts` — local only, capped at `MAX_RUNS_PER_SCENARIO` per scenario because of the screenshots. Recording auto-inserts a `navigate` to the current URL when it starts on an empty scenario; keydown recording flushes the focused field's value first so Enter replays after the typed text, and skips IME composition keystrokes.

### Selector strategy (`src/content/selector.ts`)

Priority: `testid` → `role+name` → `text` → `css`. CSS fallback carries a `warning`; non-unique matches get an `nth` index plus a warning. Role/accessible-name computation is an approximation of ARIA (explicit `role` attr, else implicit-by-tag), not the full spec.

### Persistence & sync

- `src/shared/scenarios.ts`: local multi-scenario store in `chrome.storage.local`, with one-time migration from the legacy single-scenario key. Fully offline.
- `src/sidepanel/supabase.ts`: optional team sharing layered on top. Config resolution: per-browser override in `storage.local` (entered via ⚙ settings) wins over build-time defaults baked in from `.env` (`VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` / `VITE_SUPABASE_TABLE`). Sync merges local and remote by `updatedAt` (last-write-wins per scenario id).

### Gotchas

- Tabs opened before the extension loaded/reloaded have no content script; the background's `ensureContent()` pings and injects on demand — go through it rather than messaging a tab directly. Because the manifest also injects at `document_idle`, a document can end up with the script loaded twice; `src/content/index.ts` guards with `window.__poCakeContentLoaded` so only the first instance answers messages.
- `content_scripts` runs with `all_frames: false` — elements inside iframes can't be recorded or replayed.
- The background keeps a per-tab replay lock (`playingTabs`) and refuses a second PLAY/PLAY_STEP for a busy tab — the side panel surfaces that as an alert. Long `wait` steps go through `keptAliveSleep()`, which pings an extension API every 5s so the MV3 worker isn't shut down mid-run (a bare setTimeout doesn't count as activity).
- `input` replay clears the field with a select-all keystroke that is platform-specific: Ctrl+A on Windows/Linux, ⌘A plus the explicit `commands: ['selectAll']` CDP param on macOS (synthetic events bypass the OS editing-command mapping, so the modifier alone does nothing there). See `selectAll()` in the background.
- Replay intentionally shows Chrome's "is debugging this browser" banner — that's the CDP attach and is required for trusted events, not a bug.
- The Supabase anon key is deliberately shippable in the client; access control relies on the table's RLS policy (setup SQL is in README.md).
