---
id: ZCH-011B-r1
title: Add the missing imports in the ZCH-011B tests
allowed:
  - test/gitmeta.test.mjs
verify:
  - npm test
  - npm run check
minutes: 10
cause: worker
causeNote: B2 and B4 use lstatSync and dirname, which test/gitmeta.test.mjs does not import
---
Objective: fix the only two failures of run 20261116081205-9c2h. `npm test` ends with 232 pass and 2 fail:
- `B2: hook mode change is detected and restored on POSIX`: `ReferenceError: lstatSync is not defined` (test/gitmeta.test.mjs:449).
- `B4: core.hooksPath change in config is caught as config change ...`: `ReferenceError: dirname is not defined` (test/gitmeta.test.mjs:499).

Decisions (final):
1. Add `lstatSync` to the existing `node:fs` import list (keep it alphabetical) and `dirname` to the existing `node:path` import. Do not add new import statements.
2. Change nothing else: no assertion, no test body, no other import. If another `ReferenceError` or failure remains after these two names, report its test name and message; do not fix it.

Acceptance criteria:
- The two failures are gone and `npm test` passes.
- This repair edits only test/gitmeta.test.mjs.

Do not: edit src/gitmeta.mjs or any other file, rename or reorder tests, change any assertion.
