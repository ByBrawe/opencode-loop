# OpenCode Loop

**Claude Code-style auto-continue, scheduled OpenCode work, and background loops.**

OpenCode Loop adds `/loop`, scheduled prompt/command/shell jobs, compact scheduling, safe long-running continuation helpers, and the `opencode-loopd` background daemon.

> **Current release: `0.5.31`.** Loop also contains an older experimental `/loop-goal` mode, but for strong persistent Goal contracts and host-verified completion, use the separate **OpenCode Goals** plugin described below.

## Install or update

Choose either installation method below.

### Option 1 — one-command install with `npx` (recommended)

```bash
npx -y @bybrawe/opencode-loop@latest
```

Run the same command again whenever you want to update. If **OpenCode Goals is already installed**, a normal Loop install/update also makes a best-effort call to the official `@bybrawe/opencode-goal@latest` installer so the companion Goal plugin does not silently remain on an older release.

Install Loop and Goals together from scratch with:

```bash
npx -y @bybrawe/opencode-loop@latest --with-goals
```

Update/install only Loop and skip all Goals companion network work with:

```bash
npx -y @bybrawe/opencode-loop@latest --loop-only
```

`--with-goals` is explicit and fails if the requested Goals install/update fails. The automatic refresh of an already-installed Goals companion is best-effort: Loop still finishes its own update and prints a retry command if the companion registry/install step is temporarily unavailable.

### Option 2 — install with npm

Install OpenCode Loop globally so its installer and daemon commands are available:

```bash
npm install -g @bybrawe/opencode-loop@latest
opencode-loop
```

To update later:

```bash
npm install -g @bybrawe/opencode-loop@latest
opencode-loop
```

If you want the global Loop installer to install Goals too, run:

```bash
opencode-loop --with-goals
```

`npm install @bybrawe/opencode-loop` by itself only adds the Node package to the current project. For a normal OpenCode installation, use the global npm method above or the recommended `npx` installer.

The installer:

- installs/updates the OpenCode Loop plugin;
- installs the `/loop-*` slash-command definitions;
- installs the tool-denied `opencode-loop-local` command agent;
- keeps an existing npm plugin entry pinned to the installer’s exact version to avoid stale OpenCode package-cache resolution;
- removes duplicate old local Loop plugin copies when the package entry is authoritative;
- refreshes OpenCode Goals through **Goals' own official installer** when an existing managed Goals installation is detected;
- can explicitly install both packages with `--with-goals`, or skip companion network work with `--loop-only`.

Then **fully restart OpenCode** and verify:

```text
/loop-help
/loop-doctor
```

If Goals is installed too, also verify:

```text
/goal status
```

### Uninstall

If you use the `npx` installer:

```bash
npx -y @bybrawe/opencode-loop@latest --uninstall
```

If you installed OpenCode Loop globally with npm:

```bash
opencode-loop --uninstall
npm uninstall -g @bybrawe/opencode-loop
```

Run `opencode-loop --uninstall` before removing the global npm package so it can clean its OpenCode registrations and managed command files.

Uninstall removes known OpenCode Loop package registrations, local plugin files, `/loop-*` command markdown files, and the Loop local command agent while preserving unrelated OpenCode configuration. It **does not uninstall OpenCode Goals**; Goals remains separately managed by its own installer.

Project Loop state is intentionally preserved under:

```text
.opencode/opencode-loop/
```

Delete that directory yourself only when you intentionally want to erase saved Loop jobs, logs, checkpoints, or related local state. Restart OpenCode after uninstalling.

## Quick start

Auto-continue whenever OpenCode becomes idle:

```text
/loop 0s continue from progress.md and implement the next unfinished TODO
```

Run a prompt every 5 minutes when idle:

```text
/loop 5m continue the project
```

Wait before the first run:

```text
/loop 5m --no-now continue the project
```

Schedule an OpenCode command such as compaction:

```text
/loop-command 200m /compact
```

Run a real shell command on a schedule:

```text
/loop-shell 10m npm test
```

Ask a recurring quality-control question:

```text
/loop-ask 1h did you run tests, typecheck, and build? If not, run them and fix errors.
```

## What OpenCode Loop is for

Use Loop when the important question is **“what should run again, and when?”**

Typical uses:

- Claude Code-style auto-continue after idle;
- recurring coding prompts;
- progress.md / TODO workflows;
- scheduled `/compact` or other OpenCode commands;
- recurring tests/lint/build shell jobs;
- retry/fix loops with verification;
- patch checkpoints;
- maximum run/runtime/failure limits;
- prompt-file workflows;
- background work through `opencode-loopd`;
- Windows Task Scheduler integration.

Loop is idle-safe: if a job becomes due while the session is busy, active tools or child work are still running, the job waits instead of intentionally stacking another turn on top of the current one.

## For stronger persistent Goals, use OpenCode Goals

OpenCode Loop still includes the older **experimental** `/loop-goal` workflow. It is useful for compatibility and lightweight outcome-driven automation, but it is not the strongest Goal implementation in this project family.

For durable Goal Contracts, host-owned evidence, semantic verification, native Todo coordination, revision isolation, false-completion protection, restart recovery, Goal audit, budgets, and ordered Goals, install **OpenCode Goals**.

Convenient combined installer from Loop:

```bash
npx -y @bybrawe/opencode-loop@latest --with-goals
```

Or install Goals directly with its standalone installer:

```bash
npx -y @bybrawe/opencode-goal@latest
```

Or install its CLI globally with npm and run the installer:

```bash
npm install -g @bybrawe/opencode-goal@latest
opencode-goal
```

Then use:

```text
/goal <objective>
/goal status
/goal contract
/goal audit
```

### Can Loop and Goals be installed together?

Yes. `@bybrawe/opencode-loop` and `@bybrawe/opencode-goal` use different package names, commands, and project-state directories, so they can coexist in one OpenCode installation.

Recommended split:

- use **`/goal`** for persistent, strongly verified outcome completion;
- use **`/loop`**, `/loop-command`, `/loop-shell`, and `opencode-loopd` for scheduling/repetition/background infrastructure.

Do **not** run Loop’s `/loop-goal` and OpenCode Goals `/goal` against the same work in the same session. Both can autonomously continue on idle boundaries and can compete to start turns.

Likewise, avoid leaving a prompt-producing `/loop ...` job continuously injecting agent turns into a session while an OpenCode Goal is actively continuing. Use separate sessions or pause/remove that prompt loop until the Goal is done. Scheduled shell/command jobs should also be chosen carefully so they do not race files or verification.

Install both with one `npx` command:

```bash
npx -y @bybrawe/opencode-loop@latest --with-goals
```

Or install both globally with npm, then run the Loop installer with the companion flag:

```bash
npm install -g @bybrawe/opencode-loop@latest @bybrawe/opencode-goal@latest
opencode-loop --with-goals
```

Once Goals is managed in the OpenCode config, future normal `opencode-loop` / `npx ...opencode-loop@latest` updates also attempt to refresh Goals to its latest stable release. Use `--loop-only` when you intentionally do not want that companion refresh.

## Core commands

| Command | Purpose |
|---|---|
| `/loop <interval> <prompt>` | Add/update an idle/interval prompt loop |
| `/loop-command <interval> <slash-command>` | Schedule OpenCode slash commands |
| `/loop-cmd <interval> <slash-command>` | Alias for `/loop-command` |
| `/loop-ask <interval> <question>` | Schedule recurring quality/check prompts |
| `/loop-shell <interval> <command>` | Schedule a real shell command |
| `/loop-status` | Show active jobs |
| `/loop-now [id/name/all]` | Run selected jobs immediately |
| `/loop-pause [id/name/all]` | Pause jobs |
| `/loop-resume [id/name/all]` | Resume jobs |
| `/loop-remove [id/name/all]` | Remove jobs |
| `/loop-clear` | Remove all current-session Loop jobs |
| `/loop-doctor` | Diagnose Loop/OpenCode state |
| `/loop-init` | Create a starter `progress.md` |
| `/loop-export` | Export Loop state as JSON |
| `/loop-goal <objective>` | Start the older experimental Loop Goal Mode |

## Intervals and job types

Examples:

```text
0s     run whenever OpenCode becomes idle
5m     run every 5 minutes when idle
200m   run every 200 minutes when idle
1h     run every hour when idle
```

OpenCode Loop separates prompt, slash-command, and shell work because they should not be executed the same way.

| Type | Example |
|---|---|
| Prompt | `/loop 0s continue from progress.md` |
| Scheduled question | `/loop-ask 1h did you run tests?` |
| OpenCode command | `/loop-command 200m /compact` |
| Shell | `/loop-shell 10m npm test` |

Do not use a normal prompt loop when you mean to run `/compact`. Prefer:

```text
/loop-command 200m /compact
```

## Useful flags

### Naming and lifecycle

```text
/loop 0s --name dev continue the project
/loop-pause dev
/loop-resume dev
/loop-stop dev
```

### Limits

```text
--max-runs <n>
--max-runtime <duration>
--max-failures <n>
--timeout <duration>
```

### Verification and safety

```text
--verify "npm test"
--preflight "npm install"
--postrun "git status --short"
--pause-on-verify-fail
--safe
--ask-never
--no-overlap
```

### Context and TODO workflows

```text
--progress-file progress.md
--prompt-file loop-prompt.md
--include-file ARCHITECTURE.md
--batch 5
--compact-every 20
--watch progress.md
```

### Checkpoints

```text
--checkpoint-only
--git-checkpoint
```

`--git-checkpoint` may stage and commit work. Use it only when that behavior is intentional.

## Recommended development loop

```text
/loop 0s --name dev --ask-never --safe --no-overlap --batch 5 --compact-every 200m --checkpoint-only --progress-file progress.md Treat progress.md as the project state. Continue with the next unfinished TODO, implement it, mark completed items, add useful follow-up TODOs, run tests/lint/build when available, and keep going while work remains.
```

## Test-fix loop

```text
/loop 0s --name testfix --ask-never --safe --verify "npm test" --max-failures 3 Continue from progress.md. If tests fail, analyze the failure, fix it, and run the tests again.
```

## Background daemon

The normal `/loop` plugin is session-bound. If OpenCode closes, that TUI/session loop cannot keep running in the background. `opencode-loopd` resolves the session once at startup and pins that exact session for later iterations, so a newer unrelated session cannot steal the daemon. If no session exists, the daemon creates one and pins it before the second iteration. Each daemon run is bounded by `--timeout` (30 minutes by default; use `--timeout 0s` to disable).

For long-running background jobs use:

```bash
opencode-loopd --project . --every 5m --prompt-file loop-prompt.md
```

Run immediately on each daemon iteration:

```bash
opencode-loopd --project . --every 0s --prompt "continue from progress.md and implement the next unfinished TODO"
```

Select a model and agent:

```bash
opencode-loopd --project . --every 0s --max-runs 1 --timeout 30m --model provider/model --agent build --prompt-file loop-prompt.md
```

Pin a specific existing session when needed:

```bash
opencode-loopd --project . --session ses_xxx --every 5m --prompt-file loop-prompt.md
```

Limit total runs:

```bash
opencode-loopd --project . --every 5m --max-runs 20 --prompt-file loop-prompt.md
```

## Windows Task Scheduler

Install a scheduled daemon task:

```powershell
opencode-loopd install-task --project "C:\path\to\project" --every 10m --prompt-file loop-prompt.md --name OpenCodeLoop
```

Remove it:

```powershell
opencode-loopd uninstall-task --name OpenCodeLoop
```

## Experimental Loop Goal Mode

Loop’s original Goal Mode remains available for existing users:

```text
/loop-goal --check "npm test" --complete-when-checks-pass fix the failing tests
```

Controls:

```text
/loop-goal-status
/loop-goal-pause
/loop-goal-resume
/loop-goal-clear
/loop-goal-done <summary>
/loop-goal-blocked <reason>
```

It supports acceptance criteria, check commands, evidence text, no-progress guards, turn/runtime limits, and reports under:

```text
.opencode/opencode-loop/goals/
```

For new work where completion integrity matters, prefer the dedicated **OpenCode Goals** package instead:

```bash
npx -y @bybrawe/opencode-goal@latest
```

or:

```bash
npm install -g @bybrawe/opencode-goal@latest
opencode-goal
```

## State and checkpoints

Loop runtime state:

```text
.opencode/opencode-loop/
```

Patch checkpoints:

```text
.opencode/opencode-loop/checkpoints/
```

Recent plugin events:

```text
.opencode/opencode-loop/loop.log
```

Add `.opencode/opencode-loop/` to `.gitignore` when you do not want runtime noise committed.

## Suggested OpenCode permissions

For unattended loops, avoid granting every shell command permanently. Allow routine read/edit/test operations and keep destructive operations on ask/deny.

Example:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "permission": {
    "read": "allow",
    "grep": "allow",
    "glob": "allow",
    "todowrite": "allow",
    "edit": "allow",
    "bash": {
      "*": "ask",
      "git status*": "allow",
      "git diff*": "allow",
      "npm test*": "allow",
      "npm run test*": "allow",
      "npm run lint*": "allow",
      "git push*": "ask",
      "git reset*": "ask",
      "git clean*": "deny",
      "rm *": "deny"
    },
    "external_directory": "ask"
  }
}
```

`--safe` reduces risk but does not replace careful OpenCode permission configuration.

## Package

```text
@bybrawe/opencode-loop
```

The package also installs:

```bash
opencode-loop --help
opencode-loopd --help
```

See [CHANGELOG.md](./CHANGELOG.md) for release history.

## License

MIT
