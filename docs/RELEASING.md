# Releasing zora-conductor

This is the release process for maintainers. The project roadmap is the authority for the gates below; if the two ever disagree, the roadmap wins and this file is corrected.

## The one rule to remember

**A tag is public and installable the moment it is pushed.** The repository is public, so anyone can install a pushed tag with `npm install github:zoratech64/zora-conductor#<tag>` or add it as a Claude Code plugin marketplace, before any GitHub Release exists, while the release is still a draft, and even if the release workflow fails. Everything that must be true of a release is therefore checked **before** the tag is pushed.

## Versions

- One version for the CLI and the Claude plugin. It is written in three places that must match: `package.json`, `.claude-plugin/plugin.json`, and the `zc` entry in `.claude-plugin/marketplace.json`. `npm run check` fails if they differ.
- Format: `X.Y.Z`, or `X.Y.Z-alpha.N`, `X.Y.Z-beta.N` or `X.Y.Z-rc.N` for pre-releases. Build metadata (`+...`) is not used.
- Tag name: `v` + the version, for example `v0.2.0-alpha.1`.
- Before 1.0.0, a minor release may contain an approved breaking change; it is marked **Breaking** in the changelog with migration guidance. From 1.0.0, a breaking change needs a major version, and removals are announced with a warning at least one minor version earlier.

## 1. Before tagging

The tag ruleset (see "Tag ruleset" below) must already exist and show **Active** before any release tag is pushed, including the first one. Then all of these must pass on the exact commit that will be tagged:

1. The version is set in all three manifest files, and `npm run check` passes (syntax, version and third-party notices check).
2. `CHANGELOG.md` has a section for this version: what changed, every breaking change marked **Breaking**, and migration guidance for each.
3. `npm test` passes locally.
4. The required CI jobs are green on this commit: Ubuntu and Windows, Node 22 and 24. macOS jobs run for information only and never make macOS "supported". The `ci` workflow (`.github/workflows/ci.yml`) runs this matrix on every push; on Linux it fails if the permission tests were skipped.
5. The release gate for this kind of release is met (see "Release gates" below). Pre-releases before Gate 1 skip the gate but must carry the testing-only notes.
6. You have decided the release notes: for a pre-release, the testing-only label and the platform status (see section 4).

## 2. Create and push the tag

Create an annotated tag on the checked commit and push only that tag:

```bash
git tag -a v0.2.0-alpha.1 -m "zora-conductor 0.2.0-alpha.1"
git push origin v0.2.0-alpha.1
```

From this point the tag is public.

## 3. The release workflow prepares a draft

When a `v*` tag is pushed, the release workflow runs the required CI jobs, fails if the tag does not match the package version, and creates a **draft** GitHub Release with this version's changelog section. It never publishes. The workflow is `.github/workflows/release.yml`; it runs its own copy of the CI matrix, and only the job that creates the draft has write access.

- For `-alpha`, `-beta` and `-rc` tags the notes start with a testing-only block: "For testing only.", the platform status and known limitations. It is written from a template, not from test results, and is marked for the maintainer to verify (and correct) before publishing.
- The workflow does not tick **Set as a pre-release**; the maintainer does that when publishing (section 4).
- It fails, without creating anything, if a release for the tag already exists.

**Dry run before tagging:** GitHub → Actions → release → Run workflow, on the branch of the commit you will tag. It runs the same checks and tests, shows the release notes it would use, and never creates, edits or publishes a release.

If the workflow fails after the push, the tag stays as it is. Fix the problem and release the next version (for example `alpha.2`); never move or reuse the tag.

## 4. Review and publish by hand

A maintainer reviews the draft and publishes it manually:

- **Pre-releases** (`-alpha`, `-beta`, `-rc`): tick **Set as a pre-release**. The notes start with "For testing only." and state the platform status exactly as tested, for example: "Linux tested. Windows and macOS untested." They also list known gaps (for example: "The Claude plugin does not yet run a project-local CLI.").
- **Final releases**: publish as a normal release only when the matching gate below has passed. The notes state the platform status exactly as tested; a platform without a real-machine test is called "untested".
- Never publish account emails, names, IDs, tokens, usernames or machine names in release notes; test reports linked from a release must follow the redaction rules used for platform testing.

## Tags are permanent

- A pushed tag is never moved, deleted or reused, even if it was a mistake, and even if its GitHub Release is still a draft or was never published. Fix forward with a new version.
- Users pin tags; the npm lockfile records the commit behind a tag, and a moved tag would silently change what a fresh install gets.

## Tag ruleset (one-time setup, before the first tag)

Protect release tags with a GitHub tag ruleset so the rule above is enforced, not just written down. Create it, and verify that its enforcement status shows **Active**, before the first release tag is pushed. As of this writing, no such ruleset has been verified on this repository.

In the repository settings, under **Rules → Rulesets**, create a new **tag ruleset**:

- **Enforcement status:** Active.
- **Target tags:** pattern `v*`.
- **Rules:** **Restrict updates**, **Restrict deletions** and **Block force pushes**. Together these stop a pushed `v*` tag from being moved or deleted.
- **Bypass list:** leave empty for these rules, so nobody, including maintainers, can move or delete a release tag.

Rulesets are available for public repositories on GitHub Free. Rule details: [Available rules for rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets).

## Release gates

Every item is pass or fail on the release commit; one failure blocks the release.

### Pre-releases before Gate 1 (`v0.2.0-alpha.N`)

- Sections 1–4 above, including the testing-only label and exact platform status. Every such tag stays a GitHub Pre-release.

### Gate 1: first public preview (`v0.2.0`)

- [ ] Tag matches all three manifest versions; a GitHub Release with the changelog is published.
- [ ] Required CI jobs green (Ubuntu and Windows, Node 22 and 24), with the permission tests executed on Linux; macOS results published but not counted as support.
- [ ] On a clean Ubuntu machine, a fresh Flutter project and a fresh NestJS project each go from `npm install github:…#v0.2.0` to an accepted real task using only the README.
- [ ] The CLI and the Claude plugin install from the same tag, on Linux and Windows, proven two ways: the installed version reported by Claude Code and the manifests, and the installed source matching the tag's commit and files.
- [ ] The plugin runs the project-local CLI from that tag through the project's own package manager (npm, pnpm, Yarn), with no PATH setup, on Linux and Windows.
- [ ] `zc init` on Flutter's unmodified project template leaves a tree that dispatch accepts.
- [ ] Monorepos work from `zc init` to an accepted task without wrapper scripts: a Flutter app in a subfolder, npm workspaces, pnpm workspaces, Yarn 4 workspaces with `node_modules`, and Yarn 4 with Plug'n'Play (no `node_modules` folder ever created, only Yarn commands used), with NestJS and Next.js apps.
- [ ] `zc --version` and `zc doctor` report the CLI version, a plugin/CLI version mismatch, the install type and any `.gitignore` gap.
- [ ] Updating to the next tag and rolling back to this one both work and are documented.
- [ ] Multi-account use is off by default and opt-in, and no failure of any kind (quota, rate limit, sign-in, licence, server, other) switches accounts automatically; tests prove a second ready account is never started.
- [ ] Windows is called supported only after a real-machine end-to-end test; Windows multi-account only with reliable evidence of each account's signed-in identity, before and after reopening the worker CLI. Otherwise "untested" or "unsupported". macOS is "untested".
- [ ] The third-party notices inventory is complete, with nothing unresolved.
- [ ] The README states the platform status exactly as tested, the account policy, the tested `agy` version, and the security boundary: zora-conductor validates scope logically and recovers afterwards; it does not prevent access at the operating-system level.
- [ ] The manager-only rule is described as a guarantee only if it is enforced; otherwise as an instruction.
- [ ] No published test report contains account emails, names, IDs, tokens, usernames or machine names.
- [ ] Every existing execution-control and recovery test passes, unchanged in meaning (except the account-switching tests, which change with the account policy).

### Gate 2: stable `v1.0.0`

- [ ] Everything in Gate 1.
- [ ] The release smoke test passed on real Windows and macOS machines, or those platforms stay explicitly "untested" in the README.
- [ ] Contract tests from real `agy` output on every supported platform.
- [ ] Config schema enforcement and `zc migrate` shipped, with a tested migration and rollback.
- [ ] A fresh user completes setup from the docs alone.
- [ ] Security, contributing and upgrading docs are published, and security reports have a private channel.
- [ ] Two consecutive preview releases with no breaking change and no data-loss bug reported.
- [ ] The compatibility promises are written into the docs.
