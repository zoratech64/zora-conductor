# Progress log

One line per accepted task: date, task id, run id, commit.
- 2026-11-15 T-003 run 20261115071339-tkcs: prompt-size measurement script; baseline in .zc/baseline-pre.json
- 2026-11-15 T-004 runs 20261115072122-77ar (VERIFY_FAILED, test fixture) + repair 20261115072833-5kou (OK): worker rule selection, whole-file budget, result.eccRules
- 2026-11-15 T-005 runs 20261115073147-cbtb (VERIFY_FAILED, old assertion) + repair 20261115073712-shrw (OK): task verify is additive to project verify; result.verifyPlan
- 2026-11-15 T-006 run 20261115073901-1rek (OK): zc accept stages only a verified run's paths (dogfooded for this commit)
- 2026-11-15 T-007 run 20261115074642-b311 (OK): manager skill/reviewer consistency (risk-based review, verify gate, zc accept)
- 2026-11-15 T-008 run 20261115075111-20o7 (OK): measure.mjs runs/compare report; post-change prompt sizes in .zc/measure-post.json
- 2026-11-15 T-009 run 20261115080206-t7me (OK): audit fixes - accept scope check, single all-or-nothing git add, alreadyStaged warning, lock message, argv-exact verify dedupe
