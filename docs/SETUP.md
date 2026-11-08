# Setup

Do these once per machine, then once per project. The steps are the same on Ubuntu and Windows except where marked.

## 1. Prerequisites

| Tool | Ubuntu | Windows |
|---|---|---|
| Node.js 22+ | `curl -fsSL https://deb.nodesource.com/setup_22.x \| sudo -E bash - && sudo apt install -y nodejs` | `winget install OpenJS.NodeJS.LTS` |
| Git | `sudo apt install -y git` | `winget install Git.Git` |
| Claude Code (signed in) | follow Anthropic's install guide, then `claude` once to sign in | same |
| Antigravity CLI (`agy`) | https://antigravity.google/docs/cli/install/ | same (installs `agy.exe`) |

Check: `node --version` (22 or newer), `git --version`, `claude --version`, `agy --version`.

If `agy` is installed somewhere unusual, set `ZC_AGY` to its full path.

## 2. Install ECC (the base)

Pick **one** method and stop there (ECC warns that stacking installs duplicates hooks and skills):

```
npx ecc-universal@2.2.3 setup
```

or inside Claude Code:

```
/plugin marketplace add https://github.com/affaan-m/ECC
/plugin install ecc@ecc
```

Review ECC's hooks before enabling them; its `minimal` profile has none. Confirm with `/plugin list`.

Then get a checkout of ECC for the worker rules (workers use Gemini, which does not run ECC's hooks, so `zc` pastes the rule packs into each worker prompt):

```
git clone https://github.com/affaan-m/ECC.git ~/ecc            # Windows: C:\tools\ecc
```

## 3. Install zora-conductor

```bash
git clone <this repo> zora-conductor
cd zora-conductor
npm test          # optional: automated tests, they use a fake agy
npm link          # puts `zc` on PATH
zc help
```

Ubuntu: if `npm link` complains about permissions, run `npm config set prefix ~/.local` once and make sure `~/.local/bin` is on your PATH.
Windows: run it from PowerShell. If `zc` is not found afterwards, open a new terminal.

Add the manager plugin in Claude Code (a local path or a Git URL both work):

```
/plugin marketplace add /path/to/zora-conductor
/plugin install zc@zora-conductor
```

You now have `/zc:orchestrate`, the `orchestrate` skill, and the `zc-reviewer` agent.

## 4. Add the Gemini accounts

Read [ACCOUNTS.md](ACCOUNTS.md) first, then:

```bash
zc account add g1      # opens agy; sign in with the Google account for this worker, then exit agy
zc account add g2
zc account list
zc account check       # confirms each sign-in and prints the remaining quota
```

State lives outside every project: `~/.local/state/zora-conductor` on Ubuntu, `%LOCALAPPDATA%\zora-conductor` on Windows. Override with `ZC_HOME`. Never commit it.

## 5. Set up a project

```bash
cd your-project            # must be a git repo with at least one commit
zc init
```

Edit `.zc/config.json`:

```json
{
  "version": 1,
  "verify": [["dart", "analyze"], ["flutter", "test"]],
  "defaults": { "onLimit": "reset" },
  "worker": { "permissions": "edit" },
  "ecc": { "path": "/home/you/ecc", "rulePacks": ["common", "dart"] }
}
```

`zc init` detects Flutter (`pubspec.yaml`) and Node/NestJS (`package.json`) and fills `verify` and `rulePacks` for you. Set `ecc.path` to your ECC checkout. Then commit it:

```bash
git add .zc && git commit -m "chore: add zc config"
zc doctor
```

## 6. First run

Start with something small and well-bounded.

```bash
zc dispatch --prompt "Add a README section describing the project layout" --allow README.md --dry-run   # look at the prompt
```

Then, in Claude Code inside the project:

```
/zc:orchestrate add input validation to the signup form
```

Claude plans with ECC, writes tasks under `.zc/tasks/`, dispatches them one at a time, reviews each result, and commits accepted ones to your current branch. Use a feature branch.

## Windows notes

- Quote paths in PowerShell, or use forward slashes.
- `npm`, `flutter` and `dart` are `.cmd` launchers. `zc` runs them through `cmd.exe` only after rejecting arguments that contain `& | < > ^ " %`. Put such logic in an npm script instead of the verify command.
- If sign-in opens a separate console window for agy, finish it there and exit agy.

## Ubuntu notes

- If sign-in fails with a keyring or D-Bus error on a server or SSH session, see the isolation section in [ACCOUNTS.md](ACCOUNTS.md).
- Headless server: the browser sign-in needs a display or a copied authorization code; do it once per account, then it stays signed in.
