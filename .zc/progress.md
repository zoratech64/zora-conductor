# Progress log

One line per accepted task: date, task id, run id, commit.
- 2026-11-15 T-003 run 20261115071339-tkcs: prompt-size measurement script; baseline in .zc/baseline-pre.json
- 2026-11-15 T-004 runs 20261115072122-77ar (VERIFY_FAILED, test fixture) + repair 20261115072833-5kou (OK): worker rule selection, whole-file budget, result.eccRules
- 2026-11-15 T-005 runs 20261115073147-cbtb (VERIFY_FAILED, old assertion) + repair 20261115073712-shrw (OK): task verify is additive to project verify; result.verifyPlan
- 2026-11-15 T-006 run 20261115073901-1rek (OK): zc accept stages only a verified run's paths (dogfooded for this commit)
- 2026-11-15 T-007 run 20261115074642-b311 (OK): manager skill/reviewer consistency (risk-based review, verify gate, zc accept)
- 2026-11-15 T-008 run 20261115075111-20o7 (OK): measure.mjs runs/compare report; post-change prompt sizes in .zc/measure-post.json
- 2026-11-15 T-009 run 20261115080206-t7me (OK): audit fixes - accept scope check, single all-or-nothing git add, alreadyStaged warning, lock message, argv-exact verify dedupe
- 2026-11-15 T-010 run 20261115083559-v6np (OK): zc accept refuses when unrelated paths are already staged; lock doc covers accept
- 2026-11-15 T-013 manager edit, no run: resync .zc/MANAGER-RULES.md with orchestrate skill Rules section; drop obsolete Phase 1 user decisions
- 2026-11-15 T-014 (commit b5bd2ef): keep security.md and testing.md in worker prompts; error if they do not fit
- 2026-11-15 T-015 manager edit, no run (commit 5f4c46d): Phase 1 run report and prompt comparison in .zc/measure-phase1-runs.json
- 2026-11-15 T-016 run 20261115160552-mclt (OK): measure.mjs rulesTruncated derived from selectEccRules omitted list
- 2026-11-15 T-017 run 20261115164037-vqq7 (OK): measure.mjs compare --key reads one prompt-size section of combined files
- 2026-11-15 T-018 runs 20261115165835-7ul7 (OK, review found verify-written files inherited) + repair 20261115171413-w1ku (OK): repair scope check covers only the repair's own changes; result.inherited
- 2026-11-15 T-019 run 20261115180018-qb6o (OK): repair tasks declare cause/causeNote, recorded as result.repairCause; CLI refuses --repair without cause; chained-repair test
- 2026-11-15 T-020 run 20261115184429-kxny (OK): measure.mjs runs reports repairCauses per group (repair runs by repairCause.kind, unrecorded for none); contract required adding the new note to the pinned notes test
