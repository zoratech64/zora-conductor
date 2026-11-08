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
| quota / rate limit | Cooldown (uses the reset time in the message, else 60 minutes), switch to the next account |
| authentication required | Marks the account `needs-login`, switches. Fix with `zc account login <id>` |
| no Antigravity license | Marks the account `blocked`, switches |
| "location not supported" | Stops the whole run. Changing accounts cannot help, and `zc` will not try |
| Google 5xx / empty reply | One rerun on the same account, then a 10 minute cooldown |

`zc account reset <id>` clears a hold once you have confirmed the account is fine.

## Terms of use

Rotating between accounts that are genuinely yours, such as separate paid plans or a team's seats, is ordinary use. Spreading one person's usage across many free accounts to avoid per-person limits may break the provider's terms. Check them for your plan before relying on this.
