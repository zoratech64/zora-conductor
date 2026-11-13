export const TASK_TEMPLATE = `---
id: T-001
title: Short name
allowed:
  - src/example/
verify:
  - npm test
minutes: 30
# ecc:
#   - skill:dart-flutter-patterns
#   - agent:flutter-reviewer
---
Objective: one sentence.

Decisions (final; the worker does not reopen them): approach, names, patterns, behavior.

Per file:
- path/to/file: what to change (symbols, line anchors) and the expected result.

Read first: files the worker must read besides the ones it edits (keep short).

Do not: files, behavior or refactors that are out of scope.

Done when: observable acceptance criteria and tests.

If blocked: report the contradiction or missing dependency with file and line evidence; do not guess or widen scope.

Verification: the manager (zc) runs the verify commands above; the worker cannot run commands.
`;
