# Worker accounts and isolation

Each worker account needs its own sign-in that does not overwrite the others. `zc` gives every account a profile folder and starts `agy` with `--gemini_dir <profile>` and `GEMINI_FORCE_FILE_STORAGE=true`, so the OAuth token should stay inside that folder.

## The open question

The two projects this was built from report different things:

- **Pirun** (tested with agy 1.1.21) relies on exactly this setup and reports that accounts run side by side. It refuses to log in if agy would use the shared OS keyring.
- **zora-ai-orchestrator** (documented against agy 1.4.12 on Linux) reports that a separate `HOME` or `--gemini_dir` still talks to the host user's Secret Service over D-Bus, so every account becomes the same identity. Its fix was one Linux user per account plus a private D-Bus session.

Both are first-hand reports about different agy versions on different systems. Which one holds for **your** agy on **your** Ubuntu machine is something only a test can show. Windows was the main platform for Pirun's tests.

## Five-minute check (do it before adding a third account)

1. `zc account add g1`, sign in with Google account A. Exit agy.
2. `zc account add g2`, sign in with Google account B. Exit agy.
3. `zc account check`. Both should print OK, and **neither** should print the "no token file found" warning.
4. Look inside the profile folders (`zc account list` shows the state folder; profiles are under `profiles/g1` and `profiles/g2`). Each should contain `antigravity-cli/antigravity-oauth-token`.
5. Sign g1 in once more (`zc account login g1`) and check g2 again. If g2 now fails or the two accounts show identical quota windows, they share one identity.

If any step fails, the accounts are **not** isolated. Do not rotate real work across them.

## If they share an identity (Linux)

Use one OS user per account, each with its own D-Bus session, as `zora-ai-orchestrator` does (see `bin/zora-worker-launcher.sh` and the "Hardened Manual Setup" section of its README). That needs `sudo`, a narrow sudoers rule, and a launcher script. `zc` 0.1 does not automate it; it is the first item for the next version. Until then, the options are: run fewer accounts, use accounts on separate machines, or do the OS-user setup by hand and point `ZC_AGY` at a wrapper script that runs `agy` as that user.

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
