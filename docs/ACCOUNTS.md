# Worker accounts and isolation

Each worker account needs its own sign-in that does not overwrite the others. `zc` gives every account a profile folder and starts `agy` with `--gemini_dir <profile>` and `GEMINI_FORCE_FILE_STORAGE=true`, so the OAuth token should stay inside that folder.

## What was found on Ubuntu (agy 1.5.3)

`agy` keeps its Google login in the desktop keyring (Secret Service on your user D-Bus session), not in the `--gemini_dir` folder. Tested on a ThinkPad running Ubuntu:

- `zc account add g1` and `g2` both started already signed in as the same Google account, with no browser.
- Unsetting `DBUS_SESSION_BUS_ADDRESS` and using a private `HOME` did **not** help: agy still found the real session bus at `/run/user/<uid>/bus`.
- Running agy inside `dbus-run-session` with a private `HOME` and `XDG_RUNTIME_DIR` did give a signed-out agy (a fresh sign-in prompt).

So on Linux `zc` now runs every agy call (sign-in, check, dispatch) inside its own private D-Bus session, with `HOME` and `XDG_RUNTIME_DIR` under that account's profile folder. No sudo and no extra OS users. It needs the `dbus-run-session` command (`sudo apt install dbus`; `zc doctor` checks it). `ZC_ISOLATION=none` switches this off. Windows and macOS are unchanged and still unverified.

Accounts that were signed in before this change are not isolated: run `zc account remove g1`, `zc account remove g2`, then add them again.

## Check (do it before adding a third account)

1. `zc account add g1`: sign in with Google account A, then exit agy. When agy prints the sign-in URL, open it in a private browser window so the browser's own Google session does not pick the account for you.
2. `zc account add g2`: same, with account B.
3. `zc account check` must show both OK **in separate runs of zc**. That proves the login survives after the private session ends.
4. Compare the quota windows, or run `agy` by hand for each account and look at the signed-in email. Sign g1 in again later and make sure g2 is still its own account.

If step 3 fails (signed out on the next run), the private keyring is not persisting. Tell me the exact message and I will switch to a different storage approach.

## What `zc` does with account problems

| Signal from agy | What `zc` does |
|---|---|
| quota / rate limit | Cooldown (uses the reset time in the message, else 60 minutes, never longer than `defaults.maxCooldownMinutes`, 24 hours by default), switch to the next account |
| authentication required | Marks the account `needs-login`, switches. Fix with `zc account login <id>` |
| no Antigravity license | Marks the account `blocked`, switches |
| "location not supported" | Stops the whole run. Changing accounts cannot help, and `zc` will not try |
| model capacity (`No capacity available for model`; a bare 503 UNAVAILABLE stays a `server` error) | No cooldown, no rotation: waits 60 s, then 180 s (`defaults.capacityWaitSeconds`) with only the project lease held, then ends `NO_CAPACITY` (reason `model-capacity`) |
| network (`ENOTFOUND`, `EAI_AGAIN`, `ECONNRESET`, `ETIMEDOUT`, `fetch failed`) | No cooldown, no rotation: waits 30 s, then 120 s (`defaults.networkWaitSeconds`), then ends `NETWORK` (exit 2) |
| Google 5xx / empty reply | One rerun on the same account, then a 10 minute cooldown |

At most two waits happen per run (capacity and network together). They do not use up `defaults.maxAttempts`, they hold no account lease, and a Ctrl-C ends them at once.

A reset time in a message counts only if it is an absolute time with a timezone, or a relative time ("in 30 minutes"), and lies between now and `defaults.maxCooldownMinutes` ahead. Anything else, such as a date years away, is ignored and the default cooldown applies. A genuine weekly reset hint is therefore capped at 24 hours: the account is tried again once a day and cools down again if it is still out of quota.

`zc account reset <id>` clears a hold once you have confirmed the account is fine.

## Terms of use

Rotating between accounts that are genuinely yours, such as separate paid plans or a team's seats, is ordinary use. Spreading one person's usage across many free accounts to avoid per-person limits may break the provider's terms. Check them for your plan before relying on this.

## One Google account per profile (attestation)

`zc` cannot tell whether two profiles are signed in with the same Google account. Checked with agy 1.5.3 in a throwaway HOME (help and changelog only): there is no `whoami`, `account`, `auth` or `status` command, nothing documents an identity output, and sign-in modes vary (Google login, `GEMINI_API_KEY`, `AGY_ADC_AUTH`). The only identity-bearing file is the OAuth token, which `zc` never opens, hashes, decodes or compares (a test fails if `src/` names it). `installation_id` is per profile install and says nothing about the Google account.

So the rule is an operational restriction that you attest to, and `zc` enforces the attestation:

- `zc account add <id> --label <name>` and `zc account attest <id> --label <name>` need a non-secret label (use the Google email, or an alias). No confirmation prompt: `add` runs the sign-in straight away. `--confirm-unique-google-account` is still accepted and does nothing.
- A label already attested on another account is refused (this catches typing and copy mistakes).
- Accounts created before this rule start unattested and are never filled in automatically. `zc` enforces the attestation when it reserves an account for a dispatch: an account without a valid, unique, manual attestation is never selected (`account-unattested`, exit 3), and an account entry written by hand into `accounts.json` without one is refused the same way.

Limits, stated plainly: the attestation is a human claim that `zc` cannot verify. A false or deliberately different label defeats it. Two profiles on one Google account share one quota and break the one-lease-per-account guarantee, and `zc` can never prove that two labels are different people or accounts: it enforces "attested, with a label no other account uses", nothing more. Sign-in modes other than Google login are not covered. If agy ever gains a supported identity command, that is a follow-up, not something to adopt silently.

### Stale leases and known limits

`zc` frees a lease left by a dead dispatcher only when it can prove the worker is gone (dispatcher dead by pid, start time and boot id; no process on the profile; worker process group empty). Anything it cannot read keeps the lease. Limit: process identity is read from this machine's `/proc`. If the state directory is shared with a container or another PID namespace (distrobox, docker bind mount), a live dispatcher there is invisible, so do not share one state directory across PID namespaces.

## Account leases and the registry

Every dispatch reserves its account with a machine-wide lease kept in a small SQLite registry (`~/.local/state/zora-conductor-registry` on Linux, independent of `ZC_HOME`, so two different state folders still cannot use one profile twice). The lease key is the profile directory's device:inode; its real path is recorded with it. A dispatch also takes a `project:<key>` lease, so only one zc operation (dispatch, reject, accept, ack, recover) runs per project. Different projects run in parallel, up to `defaults.maxLiveProjects` (default 2).

- A lease is released only when `zc` has proven the worker gone (process group empty and no process that started after the worker uses the profile). If it cannot prove that, for example after a Ctrl-C, both leases are kept and the run is marked `INTERRUPTED` with `orphan: true`.
- A lease left by a dead dispatcher is cleared automatically only on proof: Linux, private profile isolation on, dispatcher dead (pid, start time, boot id), nothing using the profile, worker group empty. Anything unreadable, another platform or `ZC_ISOLATION=none` keeps the lease. Heartbeat age is shown by `zc status` and never decides anything.
- `zc status` lists leases and the most recent automatic releases.
- Leases cannot be taken over by hand. Use `zc recover` (below).

### Moving to the versioned accounts store

Older zc versions take no leases. To make sure they cannot run beside this version, `zc registry activate --apply` moves the accounts to `accounts.v1.json` and leaves a fail-closed stub in `accounts.json` (an older zc then sees no accounts). It refuses while a legacy dispatcher is live or any process is using an account profile, backs up the old file with a sha256 manifest under `<state>/backups/`, and never deletes anything. `zc registry status` shows the state: `legacy`, `active`, `interrupted`, `tampered` or `corrupt`. Without `--apply` it is a dry run. `zc registry downgrade --apply` restores the legacy layout. Do not run older zc copies in between.

### Recovering an interrupted run

`zc runs` shows `INTERRUPTED` (zc died or was stopped, the worker is gone) and `ORPHAN` (zc died, the worker may still run: do not touch the tree). To keep an interrupted run's files as its result:

```
zc recover <runId>          # dry run: prints the proof and the changed paths
zc recover <runId> --yes    # records the run as RECOVERED; no file is touched
```

It needs proof that the worker is gone and the same HEAD, git layout and no newer run. You attest that the printed paths are the worker's; `zc reject <runId>` then discards exactly them, and `zc accept` refuses a recovered run (it was never verified). Where `zc` cannot prove it (Windows, macOS, isolation off), check by hand that no `agy` process uses the profile and run `zc recover <runId> --release <account> --confirm "worker of <runId> on <account> is gone" --yes`. That releases only that run's leases.

## Platforms

| Platform | Account and project exclusivity | Crash recovery |
|---|---|---|
| Linux (primary, tested) | Leases plus `/proc` proof | Automatic when proven, otherwise `zc recover` |
| Windows, macOS | Leases only (pid check, no process proof) | A human decides: `zc recover --release` |

## Limits, stated plainly

- B1, process proof: reading `/proc` is a snapshot. A process in another PID namespace or one `zc` cannot read is "unknown" and keeps the lease.
- B2, identity: the attestation is a human claim. False or deliberately different labels defeat it, and `zc` never reads token files or claims to verify Google-account uniqueness.
- B3, sign-in: only Google login is covered. `GEMINI_API_KEY` or ADC sign-in modes are not.
