# Release acceptance checklist: next release

Status: target approved by the user on 2026-11-15: `v0.2.0-alpha.3` = Phase 1 + hardening P0. Written against `main` at `14eb14b`.

## How this checklist works

- It defines when the current phase of work is finished. Every item is pass or fail, and each pass needs evidence: a commit, a run id, a command's output or a link.
- The release ships when every item in sections A to D passes, except items marked DEFERRED (approved). Nothing else blocks it.
- A new task is written only if it closes a failing item here. Any other idea, finding or improvement goes to section E (deferred) with one line. It does not get a task in this phase.
- Changing this list (adding, removing or moving an item between "blocks" and "deferred") needs the user's approval, recorded in the change log at the end.
- `docs/RELEASING.md` stays the authority for how to tag and publish. This file only chooses what must be true before that procedure starts.
- No item may be waived. In particular, these must be completed before release: every P0 security item (A2 to A5), CI (B3), independent review (B5), tag protection verification (C4), changelog (C1), version bump (C2) and README (C3).
- The work to close these items follows the existing manager rules unchanged: one worker at a time, in place, through ZC; the manager writes contracts and reviews; nothing is committed, pushed, merged or tagged without the user's explicit approval.

## Decision: what is the next release?

Decided (user, 2026-11-15): **`v0.2.0-alpha.3`**, a testing-only pre-release containing Phase 1 (T-001 to T-020, done) and the hardening phase's **P0** items. Its reasons:
- The hardening spec rates F1 (verify runs after every integrity check) and F8 (git metadata unprotected, reproduced code execution) **High**. Both are reachable today without real accounts. A third alpha that knowingly ships them makes no sense once they are known and partly fixed.
- P1/P2 hardening and the Gate 1 items need real machines, real `agy` runs and installation testing, which is a different kind of work. They are the next milestone (section E), not this one.

Rejected alternatives: (b) release `alpha.3` now with Phase 1 only and the P0 items listed as known issues; (c) skip `alpha.3` and work straight toward Gate 1 `v0.2.0`, which has no near-term end point.

## A. Scope

P0 rule: every P0 hardening item (A2 to A5) is a release blocker until it is on `main` **and** an independent read-only review (zc-reviewer or equivalent, not the worker and not the manager's own review alone) has confirmed the fix against the hardening spec's acceptance criteria. "PASS on branch" or "fixed, not reviewed" does not count. The P0 findings covered are F1 (ZCH-001), F8 (ZCH-011), F6 (ZCH-002) and the documentation of the safety boundary (ZCH-003).

| # | Item | Status | Evidence / gap |
|---|---|---|---|
| A1 | Phase 1 tasks T-001 to T-020 committed on `main` | PASS | `.zc/progress.md`; latest `a0d6195`, `14eb14b` |
| A2 | ZCH-001 post-verify integrity re-check | OPEN (fixed on branch, not on `main`, not independently verified) | `63bc634`; on `integrate/alpha3` (amended by T-021 `0bf2168`). Independent review 1 (2026-11-16): FAIL, 1 High + 1 Medium (verify edits to changed or inherited files went unchecked; same-`allowed` repair took over verify output), both reproduced; fixed by T-022 `7f1018b`. Needs independent review 2 and `main` |
| A3 | ZCH-011 git metadata integrity, all steps 011-A to 011-E | OPEN | 011-A `8d0bde5`. Correction 2026-11-16: `146553f` contains only the ZCH-011B contract, no baseline code, so 011-B to 011-E are not started. Also covers independent review 1 findings 3 (a git timeout or no-hooks-dir failure during dispatch leaves no `result.json`; spec 11.2/A9 expects `NEEDS_HUMAN`) and 5 (the no-hooks directory is shared across projects, spec 11.2 says per project). |
| A4 | ZCH-002 bounded cooldowns | OPEN | not started |
| A5 | ZCH-003 honest safety documentation (README and ARCHITECTURE state what zc does and does not guarantee) | OPEN | depends on A2 and A3 |
| A6 | `hardening/zch` integrated into `main`, with the user's approval of merge or rebase | OPEN | branch forked at `adafef0` (alpha.1). `main` is 23 commits ahead of that point. Both sides changed `src/dispatch.mjs` (+73 on the branch, +109 on main), so expect conflicts. The first hardening task should be integration, before any more ZCH work. Update 2026-11-15: merged on `integrate/alpha3` (`edc7223`, user chose merge), reconciled by T-021 (`0bf2168`), suite green; passes when `main` is fast-forwarded. |

## B. Quality gates (on the exact release commit)

| # | Item | Status | Evidence / gap |
|---|---|---|---|
| B1 | `npm test` passes locally | PASS at `a0d6195` | 190 pass, 0 fail, 6 skip (Windows platform skips); re-run on the release commit |
| B2 | `npm run check` passes (syntax, versions, notices) | PASS at `a0d6195` | re-run on the release commit |
| B3 | CI green: Ubuntu and Windows, Node 22 and 24; Linux permission tests executed | UNKNOWN | `main` is 11 commits ahead of `origin`, so CI has not run on any of them. Needs a push, which needs user authorization |
| B4 | Every pre-existing test passes unchanged in meaning; the staged-change and content-verified rollback tests pass unchanged | PASS so far | re-check after A6 |
| B5 | Independent read-only review (zc-reviewer or equivalent) of the integrated hardening work finds no unresolved Critical or High finding | OPEN | hardening spec §I.8 |
| B6 | No test writes inside the repository | UNKNOWN | hardening spec §I.2; check with `git status` after a full `npm test` |

## C. Documentation and release mechanics

| # | Item | Status | Evidence / gap |
|---|---|---|---|
| C1 | `CHANGELOG.md` `Unreleased` lists every behavioural change since alpha.2 and becomes the `0.2.0-alpha.3` section | OPEN | Phase 1 entries present; hardening entries to add |
| C2 | Version `0.2.0-alpha.3` in all three manifests (`package.json`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`) | OPEN | `npm run check` enforces the match |
| C3 | README states platform status exactly as tested, the tested `agy` version and known limitations | OPEN | verify against the current README; the security boundary text comes from A5 |
| C4 | GitHub tag ruleset for `v*` shows **Active** | UNKNOWN | `docs/RELEASING.md` says it was never verified; required before any tag. User action in GitHub settings |
| C5 | Release workflow dry run on the release commit shows the expected notes | OPEN | Actions → release → Run workflow |
| C6 | Manager documents in sync: `.zc/MANAGER-RULES.md`, `.zc/tasks/TEMPLATE.md`, `skills/orchestrate/SKILL.md` | PASS at `20ee9ea` | re-check if hardening changes the skill (the branch touches `SKILL.md`) |

## D. Open measurement and investigation items

| # | Item | Status | Evidence / gap |
|---|---|---|---|
| D1 | T-001 prompt drift explained: a fresh measurement gives 19423 bytes, `.zc/measure-post.json` records 19394 | CLOSED, evidence-limited (user approved 2026-11-18). Cause NOT identified | Verified: `measure.mjs prompt .zc/tasks/T-001.md` gives 19394 bytes (eccRulesChars 12456) at 42a25e3, 9b23489, b5bd2ef, 5f4c46d, 503ca11, edc7223, bd8c3a1 and the current tree. NOT verified: the 19423 measurement. It is not reproducible, and the run records of T-016 to T-022 that could show its prompt are missing from the run store. No zc defect was found that explains it. The original pass condition (cause identified) is NOT met; closure rests on not reproducible plus no defect found. See `.zc/progress.md` 2026-11-18 |
| D2 | Run-count discrepancy explained: `measure.mjs runs --split 2026-11-15T08:50:17Z` on this project's run store now gives 7 before / 7 after, while `.zc/measure-phase1-runs.json` (T-015) records 12 before / 5 after | CLOSED, evidence-limited (user approved 2026-11-18). Cause of the 7/7 reading NOT identified | Verified 2026-11-18: the same command now gives 12 before / 14 after, 1 unreadable (20261116090737-s8j3, interrupted, no result.json, not counted). 12 before equals the T-015 record. After was 5 at T-015; the 9 readable runs added since (q1uv, 7v0c, nmtq, mr04, 5tk3, ere1, 9c2h, vf6j, 6ofj) make 14 (an inference from run ids and counts, not a replay of T-015's data). NOT verified: the earlier 7/7 reading. It is not reproducible, no record of the directory, command or time used for it exists, and no zc defect was found. T-015's 12/5 is treated as correct for its time; no correction note added. The original pass condition (cause identified) is NOT met |
| D3 | Phase 1 re-measurement after at least 10 post-split runs | DEFERRED (approved 2026-11-15) | 7 post-split runs today (the count itself depends on D2); moved to section E |

## E. Deferred to the next milestone (does not block this release)

- Hardening P1/P2: ZCH-004 lock takeover, ZCH-005 accounts lock, ZCH-006 stream-parsed result, ZCH-007 signal handling, ZCH-008 worker environment allowlist, ZCH-009 account lease, ZCH-010 real `agy` verification.
- All of `docs/RELEASING.md` Gate 1 (`v0.2.0`): clean-machine Flutter and NestJS runs, same-tag plugin and CLI install, project-local CLI, monorepos, update and rollback, real-machine Windows test.
- Gate 1 account policy (multi-account off by default, no automatic switching) conflicts with the current automatic failover described in README. This is a product decision for the Gate 1 milestone.
- Hardening appendix items: unpinned ECC install default, `DENIED` vs `.zc/` precedence, `allowed: ['**']`, Windows `resolveSpawn` quoting test.
- Independent review 1 finding 4 (Low): the ECC installer (`src/ecc.mjs`) runs git directly, without the hardened `git()`. It runs in a temp folder, outside the dispatch threat model.
- Independent review 1 finding 6 (Low): small 011-A deviations: `.git` pointer and worktree files stored as text, not bytes; no `identity: 'path-only'` marker; no test for a symlinked git directory (A5).
- Phase 1 re-measurement (D3), once 10 or more post-split runs exist. The discrepancy investigation (D2) is not deferred.

No other item enters this release. Unrelated improvements found along the way go here with one line.

## Proposed task order to finish (for approval one task at a time)

1. Integrate `hardening/zch` into `main` (A6). This is a manager Git operation, done only with your approval.
2. D1 drift and D2 run-count investigations (read-only, manager, no worker).
3. Independent review of ZCH-001 and ZCH-011-A as integrated (P0 rule for A2).
4. ZCH-011 steps B to E (A3), each independently reviewed and committed before the next.
5. ZCH-002 (A4), independently reviewed.
6. ZCH-003 (A5), independently reviewed, then C1 and C3.
7. Independent review of the whole integrated release candidate (B5), then B6.
8. Release preparation: C2, then a push for CI (B3), C4, C5, and `docs/RELEASING.md` from there. Push, tag and publish each need your explicit authorization.

## Change log

- 2026-11-15: drafted. The user approved target `v0.2.0-alpha.3` = Phase 1 (T-001 to T-020) + all hardening P0; P1/P2 and Gate 1 deferred. User requirements added: the 7/7 vs 12/5 discrepancy is a blocking investigation (D2, split from the deferred re-measurement D3); P0 items block until on `main` and independently verified; CI, independent review, tag protection, changelog, version bump and README are not waivable; no commit without approval; manager/worker rules and one-worker execution unchanged; no scope expansion. The user approved the checklist and the D3 deferral.
- 2026-11-16: A2 and A3 evidence updated after independent review 1; A3 now also covers review findings 3 and 5; findings 4 and 6 added to section E. Approved by the user.
- 2026-11-18: D1 and D2 closed as evidence-limited at the user's explicit approval. Neither is described as verified: both causes remain unidentified and the pass condition "cause identified" is not met. Approved by the user.
