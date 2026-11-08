# Third-party notices

zora-conductor is MIT licensed (see [LICENSE](LICENSE)), Copyright (c) 2026 ZoRa Tech. This file lists every piece of third-party material in the repository and classifies every other file as original. `npm run check` fails if a file under `vendor/` is not listed in the "Files under vendor/" section below (`scripts/check-notices.mjs`).

## Third-party material

### ECC rules (`vendor/ecc/`)

- **What:** the `common`, `dart` and `typescript` rule packs and the `rules/README.md` of ECC, copied unmodified. They are pasted into worker prompts as coding rules.
- **Source:** https://github.com/affaan-m/ECC
- **Version:** an untagged development snapshot, not an ECC release. The bundled files are byte-for-byte identical (ignoring line endings) to ECC commit `89bf930c9fd201a7f1e74ed03e03a7d4b99da0c9` on `main` (2026-10-11, the last upstream commit that changed them; `git describe`: `v2.2.3-674-g89bf930c`), and unchanged on ECC `main` up to at least commit `d2ef2680594f9a17526a6e1a2e18b3d242c5d17b` (2026-11-06). No ECC tag contained that commit as of `d2ef268`. ECC's own manifests at that commit still say version 2.2.3, but the files are **not** the `v2.2.3` release (tag commit `c05b2d6`): four files differ (`rules/README.md`, `rules/common/agents.md`, `rules/common/hooks.md`, `rules/common/performance.md`). `vendor/ecc/VERSION.txt` records the same.
- **Licence:** MIT.
- **Copyright:** Copyright (c) 2026 Affaan Mustafa.
- **Licence text:** `vendor/ecc/LICENSE`, shipped beside the material (the npm package includes `vendor/`).

The rest of ECC (skills, agents, commands, hooks) is not bundled. Users install it separately in Claude Code, or point `ecc.path` at their own ECC checkout; `zc ecc install` clones it from its upstream repository at run time.

## Files under vendor/

Every file under `vendor/` must be listed here.

- `vendor/ecc/LICENSE` — third-party (ECC), its licence text.
- `vendor/ecc/VERSION.txt` — original (zora-conductor's note on where the bundled rules came from: source, snapshot commit, release status, licence).
- `vendor/ecc/rules/README.md` — third-party (ECC).
- `vendor/ecc/rules/common/agents.md` — third-party (ECC).
- `vendor/ecc/rules/common/code-review.md` — third-party (ECC).
- `vendor/ecc/rules/common/coding-style.md` — third-party (ECC).
- `vendor/ecc/rules/common/development-workflow.md` — third-party (ECC).
- `vendor/ecc/rules/common/git-workflow.md` — third-party (ECC).
- `vendor/ecc/rules/common/hooks.md` — third-party (ECC).
- `vendor/ecc/rules/common/patterns.md` — third-party (ECC).
- `vendor/ecc/rules/common/performance.md` — third-party (ECC).
- `vendor/ecc/rules/common/security.md` — third-party (ECC).
- `vendor/ecc/rules/common/testing.md` — third-party (ECC).
- `vendor/ecc/rules/dart/coding-style.md` — third-party (ECC).
- `vendor/ecc/rules/dart/hooks.md` — third-party (ECC).
- `vendor/ecc/rules/dart/patterns.md` — third-party (ECC).
- `vendor/ecc/rules/dart/security.md` — third-party (ECC).
- `vendor/ecc/rules/dart/testing.md` — third-party (ECC).
- `vendor/ecc/rules/typescript/coding-style.md` — third-party (ECC).
- `vendor/ecc/rules/typescript/hooks.md` — third-party (ECC).
- `vendor/ecc/rules/typescript/patterns.md` — third-party (ECC).
- `vendor/ecc/rules/typescript/security.md` — third-party (ECC).
- `vendor/ecc/rules/typescript/testing.md` — third-party (ECC).

## Original material

Every file outside `vendor/` is original zora-conductor material, MIT licensed under [LICENSE](LICENSE). This was established by reading each file's content, not from its location:

- Code: `bin/`, `src/`, `scripts/`, `fixtures/`, `test/`.
- Claude Code plugin text: `skills/orchestrate/SKILL.md`, `agents/zc-reviewer.md`, `commands/orchestrate.md` — written for this project; compared with all of ECC, none of their lines of 40 or more characters appear there.
- Documentation: `README.md`, `CHANGELOG.md`, `docs/`, this file.
- Configuration: `package.json`, `.claude-plugin/`, `.github/workflows/`, `.gitignore`, `LICENSE`.

Notes from the review:

- `src/classify.mjs`, `fixtures/fake-agy.mjs` and some tests contain short error messages as printed by the Antigravity CLI (`agy`), so that its failures can be recognised. They are short factual strings, not copied code.
- `README.md` names `zora-ai-orchestrator` and `Pirun` as projects whose ideas were reused and states that no code was copied from them. Their sources were not available for a line-by-line comparison in this review; nothing in this repository carries their names, licences or copyright notices other than that README paragraph.
- The GitHub Actions used by the workflows (`actions/checkout`, `actions/setup-node`) are referenced, not bundled. zora-conductor has no npm dependencies.
