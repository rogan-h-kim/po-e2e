import type { Scenario } from './types';

// ---------------------------------------------------------------------------
// Built-in (seeded) scenarios baked into the build.
//
// How to use as the author:
//   1. Author scenarios in your browser as usual.
//   2. Use "내보내기" to export each scenario to a JSON file.
//   3. Paste each exported object into SEED_SCENARIOS below (it's a full
//      Scenario: { id, name, steps, createdAt, updatedAt }).
//   4. Bump SEED_VERSION by 1.
//   5. `npm run build` and share the new `dist/`.
//
// On load, every install whose stored seed version is older than SEED_VERSION
// gets these scenarios merged in. Seeded ids are OVERWRITTEN (the build is the
// source of truth for them), while any extra local scenarios are preserved.
// So re-distributing an updated build pushes your latest scenarios to everyone.
// ---------------------------------------------------------------------------

/** Bump this by 1 every time you change SEED_SCENARIOS. */
export const SEED_VERSION = 0;

export const SEED_SCENARIOS: Scenario[] = [
  // Example - replace with your own exported scenarios and bump SEED_VERSION:
  //
  // {
  //   id: 'fixed-login-flow',           // keep this id stable across builds
  //   name: '로그인 플로우',
  //   steps: [
  //     { id: 's1', type: 'click', selector: { strategy: 'role', role: 'textbox', name: '이메일' }, description: '이메일 입력창 클릭' },
  //     // ...
  //   ],
  //   createdAt: 0,
  //   updatedAt: 0,
  // },
];
