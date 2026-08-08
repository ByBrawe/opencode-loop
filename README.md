# OpenCode Loop

**Claude Code style auto-continue + persistent Goal Mode for OpenCode.**

OpenCode Loop adds a practical `/loop` command and `opencode-loopd` daemon to OpenCode so an agent can keep working after each idle turn instead of waiting for you to type “continue” again. It also includes experimental `/loop-goal` for outcome-driven work that keeps pursuing a goal across idle turns until it is proven complete, blocked, paused, or stopped by safety limits.

It is useful for long coding sessions, `progress.md` workflows, TODO automation, test-fix loops, periodic `/compact`, checkpoints, safe autonomous development, persistent goals, and background OpenCode continuation jobs.

Repository: **ByBrawe/opencode-loop**  
NPM package name: **@bybrawe/opencode-loop**

## Goal Mode: pursue an outcome, not a timer

Normal loops answer “what should run again?” **Goal Mode answers “what result should the agent keep pursuing until it is actually done?”**

```text
/loop-goal --check "npm test" --complete-when-checks-pass fix the failing tests without weakening coverage
```

Goal Mode is experimental, but it is designed as a first-class workflow:

- **Persistent objective:** the goal survives across idle turns instead of relying on a fixed timer.
- **Evidence-gated completion:** the agent cannot finish with a generic “done”; completion needs concrete evidence.
- **Verification gates:** `--check`, acceptance criteria, and `--complete-when-checks-pass` can define what “finished” means.
- **Safety against runaway work:** user interruption, no-progress guards, max turns, and max runtime can pause or stop the goal.
- **Inspectable progress:** Goal Mode records progress/evidence and can write a goal report under `.opencode/opencode-loop/goals/`.

Use `/loop` for recurring or timer-driven work. Use `/loop-goal` when you care about an **outcome** and want OpenCode to keep working toward it until the result is verified or genuinely blocked.

See [Goal Mode: persistent objectives](#goal-mode-persistent-objectives) for the full command guide and examples.

### Scheduler heartbeat note

v0.5.11 includes a referenced heartbeat scheduler. This is important in OpenCode TUI because local command hooks are event-driven: a normal `/loop-status` command can wake the plugin, but a timer-only loop should not depend on a user typing another command. The heartbeat periodically checks active loop jobs, clears stale completed runs, and starts due work only when the session appears idle.


## Current status

**v0.5.24 uses OpenCode's native compaction lifecycle, serializes compact-before-run work, fixes current headless summarize payloads, and validates stale `busy` recovery against a genuinely completed assistant tail.** **v0.5.23 adds immediate, token-safe recovery when a scheduler prompt/shell dispatch is rejected, without automatically replaying the prompt.** **v0.5.22 adds forward-compatible OpenCode command handling plus Bun and peer-range compatibility CI.** **v0.5.21 targets current OpenCode 1.18.x compatibility and safer releases.** Server-plugin control commands keep their locked-down acknowledgement prompt instead of creating an empty command message, `/compact` prefers the current `session.compact` TUI command, and CI now covers Ubuntu and Windows before publishing. **v0.5.20 fixes Windows TUI state writes.** Session job state is written through the OS temp directory with rename plus copy/unlink fallback and short retries, so antivirus locks and OpenCode snapshots no longer drop `/loop` jobs with `EPERM` on rename. **v0.5.19** hardens Goal Mode, package updates, and the background daemon: package installs are pinned to the installed version so OpenCode cannot keep loading an older cached release, scheduler-created goal messages no longer self-interrupt on delayed updates, finite daemon failures return nonzero, model/agent selection is supported, Windows scheduled tasks use a short launcher that stays below the `/TR` limit, and asynchronous release verification is reliable under load.

The known update-related symptoms from older builds are fixed:

- `/loop` looks queued but the job stays at `runs=0`
- a loop job is replaced but does not fire after OpenCode becomes idle
- repeated `/loop` commands create confusing queued turns
- prompt, shell, or toast calls silently fail after OpenCode SDK changes
- `/compact` accidentally being treated as a normal agent prompt
- intermittent `Tool execution aborted` behavior caused by triggering a new turn too early
- experimental `/loop-goal` support for goal-driven work that continues until complete, blocked, paused, cleared, or paused by no-progress/user-interrupt guards
- `--no-now` interval jobs not waking until another OpenCode event happens
- `/loop-ask`, `/loop-command`, and `/loop-shell` being configured but not reliably firing on their own

The TUI loop is still intentionally session-bound: it runs while OpenCode is open and the current session emits status/idle events. For long-running background work after closing the terminal or OpenCode, use `opencode-loopd`.

## v0.5.19 quick behavior guide

OpenCode Loop has two triggers now:

1. **Idle/status events** from OpenCode. These are used when OpenCode finishes a turn.
2. **A real due timer** inside the plugin. This wakes delayed jobs even when no new OpenCode event happens.

All TUI jobs are still idle-safe. If the timer expires while OpenCode is busy, or while a tool/background child session is still executing, the job does not interrupt the active turn. It waits and retries until that work finishes and the parent session becomes idle.

Simple examples:

```text
/loop 0s continue the project
```

Run every time OpenCode becomes idle.

```text
/loop 1m --no-now continue the project
```

Wait 1 minute first, then run when OpenCode is idle.

```text
/loop-command 200m /compact
```

Run OpenCode compact about every 200 minutes, but only when OpenCode is idle.

```text
/loop-ask 1h did you run tests, tsc --noEmit, and build? If not, run them and fix errors.
```

Ask a recurring quality-control question every hour.

```text
/loop-shell 10m npm test
```

Run a shell command every 10 minutes when idle.

```text
/loop-goal --max-turns 5 --check "npm run build" --complete-when-checks-pass make the project build cleanly
```

Experimental persistent goal mode: keep working until the goal is complete, blocked, paused, cleared, or a safety limit is reached.

> Note: OpenCode custom command markdown still creates an assistant turn for slash commands. v0.5.17 routes that acknowledgement through the installed `opencode-loop-local` agent, which denies tools and subagents. The real scheduled iteration explicitly restores the normal coding agent/model, so a status or control command cannot launch background exploration or leave later loop work tool-disabled.

## Why this exists

Claude Code users often rely on a loop-like workflow where the agent finishes one step, then immediately continues with the next step.

OpenCode is powerful, but long-running autonomous workflows usually need extra control around:

- auto-continue after idle
- compact / summarize scheduling
- `progress.md` and TODO-driven development
- test verification after each turn
- patch checkpoints
- maximum runtime limits
- failure limits
- background daemon execution
- Windows Task Scheduler support
- safety prompts and destructive command guards

OpenCode Loop is designed for developers searching for:

- OpenCode loop
- OpenCode Claude Code loop
- OpenCode auto continue
- OpenCode Goal Mode
- OpenCode persistent goal
- Codex `/goal` style workflow for OpenCode
- OpenCode continue automatically
- OpenCode `/loop` command
- OpenCode compact scheduler
- OpenCode Ralph loop alternative
- Claude Code style loop for OpenCode
- autonomous coding loop for OpenCode
- progress.md TODO automation for OpenCode
- OpenCode background daemon
- OpenCode loop daemon
- OpenCode Windows Task Scheduler loop

## Features

> The TUI `/loop` command is session-bound. It runs while OpenCode is open and the session receives idle/status events. If the terminal closes, the machine sleeps, the process is killed, or the provider connection is lost for a long time, the TUI loop cannot continue in the background. For long-running loops, use `opencode-loopd` daemon mode.

- **Claude Code style auto-continue** with `/loop 0s ...`.
- **TUI loop mode** with `/loop`, active while OpenCode is open.
- **Background daemon mode** with `opencode-loopd` for long-running loops outside the OpenCode TUI.
- **Windows Task Scheduler helper** with `opencode-loopd install-task`.
- **One-shot scheduled runs** for periodic continuation jobs.
- **Interval loops** for prompts, slash commands, and shell commands.
- **Prompt-file support** with `--prompt-file loop-prompt.md` for long reusable instructions.
- **Prompt-file daemon support** with `opencode-loopd --prompt-file loop-prompt.md`.
- **Include extra context files** with `--include-file`.
- **progress.md workflow** with `--progress-file progress.md`.
- **Large TODO support** with `--batch`.
- **Compact scheduling** with `/loop 200m /compact` or `--compact-every`.
- **Verification loops** with `--verify "npm test"`.
- **Preflight checks** with `--preflight "npm install"`.
- **Post-run commands** with `--postrun`.
- **Failure control** with `--max-failures` and `--pause-on-verify-fail`.
- **Runtime control** with `--max-runtime 6h`.
- **Run limit support** with `--max-runs`.
- **Wait-before-first-run support** with `--no-now` for TUI loops and `--sleep-first` for daemon mode.
- **Checkpoints** with `--checkpoint-only` or `--git-checkpoint`.
- **Safe mode** with `--safe` and prompt-level destructive command warnings.
- **Branch setup** with `--branch ai-loop`.
- **Stop controls** with `--stop-file STOP_LOOP`, `--until`, `/loop-stop`, `/loop-pause`, `/loop-resume`, and `/loop-remove`.
- **Watch mode** with `--watch progress.md`.
- **Experimental Goal Mode** with persistent objectives, evidence-gated completion, acceptance criteria, verification checks, no-progress guards, and goal reports.
- **Diagnostics** with `/loop-doctor`.
- **Starter progress file** with `/loop-init`.
- **State export** with `/loop-export`.

## Installation

### Recommended: install from npm

Use the npm installer from any shell: Windows PowerShell, Windows CMD, macOS, or Linux.

```bash
npx -y @bybrawe/opencode-loop@latest
```

The installer copies the slash command files and the tool-denied local command agent into your OpenCode config directory. If `@bybrawe/opencode-loop` is already present in the OpenCode `plugin` array, that package entry remains authoritative, is pinned to the installer's exact version to bypass stale OpenCode package caches, and duplicate local plugin copies are removed. Otherwise it installs `opencode-loop.ts` locally and ensures the config directory has the `@opencode-ai/plugin` dependency required by `tool()`.

Windows target paths:

```text
%USERPROFILE%\.config\opencode\plugins\opencode-loop.ts
%USERPROFILE%\.config\opencode\commands\loop*.md
%USERPROFILE%\.config\opencode\agents\opencode-loop-local.md
```

macOS / Linux target paths:

```text
~/.config/opencode/plugins/opencode-loop.ts
~/.config/opencode/commands/loop*.md
~/.config/opencode/agents/opencode-loop-local.md
```

Then fully restart OpenCode and run:

```text
/loop-help
/loop-doctor
```

The npm package also installs the `opencode-loopd` CLI for background loops:

```bash
opencode-loopd --help
```

### Why `npx` is the recommended npm install

OpenCode can load npm plugins from the `plugin` array in `opencode.json`, but OpenCode slash commands are discovered from command definitions such as markdown files in a `commands/` directory or command entries in config.

The `npx` installer installs both parts:

- the OpenCode plugin file
- the `/loop-*` command markdown files
- the tool-denied `opencode-loop-local` acknowledgement agent

The installer automatically avoids loading both the package entry and a local plugin copy. It can therefore be rerun safely after switching installation styles.

### Optional: OpenCode config package entry

If you want OpenCode to load the npm plugin package directly, add the scoped package name to your OpenCode config:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@bybrawe/opencode-loop"]
}
```

Use the scoped package name exactly as shown.

`opencode-loop` without `@bybrawe/` is a different npm package name.

If `/loop` does not appear after using only the config method, run the installer once:

```bash
npx -y @bybrawe/opencode-loop
```

If you later remove `@bybrawe/opencode-loop` from the `plugin` array, rerun the installer so it restores the local plugin copy.

### Install from GitHub

Use this if you want to install from source instead of npm.

Windows PowerShell:

```powershell
git clone https://github.com/ByBrawe/opencode-loop.git
cd opencode-loop
powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1
```

macOS / Linux / Git Bash:

```bash
git clone https://github.com/ByBrawe/opencode-loop.git
cd opencode-loop
chmod +x ./scripts/install.sh
./scripts/install.sh
```

Then restart OpenCode and run:

```text
/loop-help
/loop-doctor
```

### Manual global install

Windows PowerShell:

```powershell
mkdir "$env:USERPROFILE\.config\opencode\plugins" -Force
mkdir "$env:USERPROFILE\.config\opencode\commands" -Force
mkdir "$env:USERPROFILE\.config\opencode\agents" -Force
copy .\src\index.js "$env:USERPROFILE\.config\opencode\plugins\opencode-loop.ts"
copy .\commands\*.md "$env:USERPROFILE\.config\opencode\commands\"
copy .\agents\*.md "$env:USERPROFILE\.config\opencode\agents\"
```

macOS / Linux:

```bash
mkdir -p ~/.config/opencode/plugins ~/.config/opencode/commands ~/.config/opencode/agents
cp ./src/index.js ~/.config/opencode/plugins/opencode-loop.ts
cp ./commands/*.md ~/.config/opencode/commands/
cp ./agents/*.md ~/.config/opencode/agents/
```

### Project-local install

Use this when you want the plugin to be available only inside one repository.

```bash
mkdir -p .opencode/plugins .opencode/commands .opencode/agents
cp ./src/index.js .opencode/plugins/opencode-loop.ts
cp ./commands/*.md .opencode/commands/
cp ./agents/*.md .opencode/agents/
```

On Windows PowerShell:

```powershell
mkdir .opencode\plugins -Force
mkdir .opencode\commands -Force
mkdir .opencode\agents -Force
copy .\src\index.js .opencode\plugins\opencode-loop.ts
copy .\commands\*.md .opencode\commands\
copy .\agents\*.md .opencode\agents\
```

### Verify installation

After restarting OpenCode, run:

```text
/loop-help
/loop-doctor
```

If the commands do not appear:

1. Make sure OpenCode was fully restarted.
2. Check that `opencode-loop.ts` exists in the OpenCode plugin directory.
3. Check that `loop.md`, `loop-help.md`, and the other command files exist in the OpenCode commands directory.
4. Check that `opencode-loop-local.md` exists in the OpenCode agents directory.
5. Run `npx -y @bybrawe/opencode-loop` again to reinstall the command and agent files.

## Quick start

### The examples most people need

Auto-continue every time OpenCode finishes a turn:

```text
/loop 0s continue from progress.md and implement the next unfinished TODO
```

Run now, then continue every 1 minute when OpenCode is idle:

```text
/loop 1m continue the project
```

Wait 1 minute before the first run, then continue every 1 minute when idle:

```text
/loop 1m --no-now continue the project
```

Run OpenCode compact every 200 minutes, but only when OpenCode is idle:

```text
/loop-command 200m /compact
```

Ask a recurring check question every hour:

```text
/loop-ask 1h did you run tests, tsc --noEmit, and build? If not, run them and fix any error.
```

Run a real shell command every 10 minutes when idle:

```text
/loop-shell 10m npm test
```

Goal Mode: keep working until the objective is actually done, blocked, paused, or cleared:

```text
/loop-goal finish the feature, run tsc --noEmit and build, fix every error, and stop only when everything passes
```

### What “when idle” means

OpenCode Loop is idle-safe. It does **not** intentionally start a new agent turn while OpenCode is already busy. Active tool calls and running child sessions also count as busy, even if OpenCode emits a premature idle/status signal for the parent during long-running background work.

Example:

```text
/loop 5m continue the project
```

If 5 minutes pass while OpenCode is still working, the job becomes due but waits. As soon as OpenCode becomes idle, the loop sends the prompt. This avoids queued turns, aborted tools, and overlapping responses.

### Prompt loops vs command loops

Use a prompt loop when you want to ask or instruct the agent:

```text
/loop 1h check if tests, tsc --noEmit, and build pass. If not, fix them.
```

Use a command loop when the action starts with `/` and should be executed as an OpenCode command:

```text
/loop-command 200m /compact
```

Do not use this for compacting:

```text
/loop 200m /compact
```

That can look like a chat prompt in older versions or unclear setups. Prefer `/loop-command 200m /compact` or the shortcut below:

```text
/loop-compact 200m
```

### Goal Mode: persistent objectives

Goal Mode is experimental. Use it when you do **not** want a timer such as "every 5 minutes". Use it when you want OpenCode to keep pursuing a result until it is complete or blocked.

Basic goal:

```text
/loop-goal fix the TypeScript build errors. Run tsc --noEmit and npm run build. Stop only when both pass.
```

What happens:

1. The goal is saved as the active experimental goal.
2. OpenCode starts working immediately by default.
3. When OpenCode becomes idle, the plugin checks whether the goal is still active.
4. If the goal is not complete or blocked, the plugin injects the next Goal Mode continuation prompt.
5. The agent is instructed to call a local goal tool when it has real progress, completion evidence, or a blocked reason.

Goal Mode is idle-safe. If OpenCode is busy, it waits. It does not intentionally start another turn on top of a running turn.

Completion guards:

- The agent tool cannot mark a goal complete with empty or generic evidence. Evidence should mention commands, files, checks, results, or code inspection details.
- If a goal has `--check` commands, agent-tool completion requires the latest configured checks to pass by default.
- `/loop-goal-done` is still a manual user override when you want to mark the goal complete yourself.
- Goal Mode pauses when a real user message arrives, so a new instruction can take control before the next automatic continuation.
- Goal Mode pauses after 3 turns without recorded meaningful progress by default. Change this with `--max-no-progress <n>`, or disable it with `--max-no-progress 0`.
- Each Goal Mode prompt includes the resolved project directory and requires workspace-relative file paths.
- A running goal turn gets 3 minutes by default before stale-run recovery can finalize it. This avoids overlapping or prematurely closing slower model/tool turns.

Simple status and control commands:

```text
/loop-goal-status
/loop-goal-pause
/loop-goal-resume
/loop-goal-clear
```

You can also use subcommands through `/loop-goal`:

```text
/loop-goal status
/loop-goal pause
/loop-goal resume
/loop-goal clear
```

Manual completion or blocked state:

```text
/loop-goal-done shipped the feature and all checks pass
/loop-goal-blocked missing API key for the staging provider
```

Goal with acceptance criteria:

```text
/loop-goal --acceptance "tsc --noEmit passes" --acceptance "npm run build passes" --acceptance "no new TODO hacks" fix all build errors
```

Goal with automatic check commands after each assistant turn:

```text
/loop-goal --check "npm run typecheck" --check "npm run build" fix every TypeScript and build error
```

Goal that automatically stops when all configured checks pass:

```text
/loop-goal --check "npm run typecheck" --check "npm run build" --complete-when-checks-pass make the project build cleanly
```

Goal that gives the agent more attempts before the no-progress guard pauses it:

```text
/loop-goal --max-no-progress 6 --check "npm test" fix the failing tests and keep evidence in the goal report
```

Goal with a safety/runtime limit:

```text
/loop-goal --max-turns 20 --max-runtime 3h --check "npm test" fix the failing tests without destructive commands
```

Goal Mode writes a report under:

```text
.opencode/opencode-loop/goals/
```

You can choose a report file:

```text
/loop-goal --evidence-file goal-report.md --check "npm test" make tests pass and document the result
```

Goal Mode is inspired by persistent-objective workflows such as Codex `/goal`, but this package implements it at the OpenCode plugin layer. It is intentionally marked experimental because model tool-calling behavior and OpenCode plugin APIs may change.

### Safer development loop

```text
/loop 0s --name dev --ask-never --safe --no-overlap --batch 5 --compact-every 200m --checkpoint-only --progress-file progress.md Treat progress.md as the main project state file. Continue with the next unfinished TODO, implement it, mark completed items with [x], add useful follow-up TODOs when you discover them, run tests/lint/build when available, and keep going while work remains.
```

### Test-fix loop

```text
/loop 0s --name testfix --ask-never --safe --verify "npm test" Continue from progress.md. If tests fail, analyze the failure, fix it, and run the tests again.
```

## Background daemon

The `/loop` command is session-bound. It works while OpenCode is open and the current session emits idle/status events.

If you close OpenCode, restart the terminal, lose connection, or your PC sleeps, the TUI loop will not keep running.

For long-running loops, use the daemon:

```bash
opencode-loopd --project . --every 5m --prompt-file loop-prompt.md
```

Run immediately after each OpenCode turn:

```bash
opencode-loopd --project . --every 0s --prompt "continue from progress.md and implement the next unfinished TODO"
```

Limit runs:

```bash
opencode-loopd --project . --every 5m --max-runs 20 --prompt-file loop-prompt.md
```

Select the OpenCode model and agent explicitly:

```bash
opencode-loopd --project . --every 0s --max-runs 1 --model opencode/big-pickle --agent build --prompt-file loop-prompt.md
```

When `--max-runs` is finite, the daemon exits with the final OpenCode run's nonzero status so scripts and CI can detect failures.

Wait before the first run:

```bash
opencode-loopd --project . --every 10m --sleep-first --prompt-file loop-prompt.md
```

Use an inline prompt:

```bash
opencode-loopd --project . --every 0s --prompt "continue from progress.md and implement the next unfinished TODO"
```

Example `loop-prompt.md`:

```md
Continue from progress.md and implement the next unfinished TODO.

Rules:
- Do not ask questions.
- Make reasonable assumptions.
- Mark completed TODO items with [x].
- Add useful follow-up TODOs when needed.
- Run tests/lint/build when available.
- Do not run destructive commands such as git reset, git clean, rm -rf, force push, deploy, or production migrations.
- Keep going while work remains.
```

## Windows Task Scheduler

You can create a Windows scheduled task that runs a one-shot daemon job every N minutes.

Install a scheduled task:

```powershell
opencode-loopd install-task --project "C:\path\to\project" --every 10m --prompt-file loop-prompt.md --name OpenCodeLoop
```

You can also pass `--model <provider/model>` and `--agent <name>`. The installer stores long task options in a task-specific JSON file and registers only a short launcher with Task Scheduler, avoiding Windows' 261-character `/TR` limit. `uninstall-task` removes that launcher and JSON config after the task is deleted.

Remove it:

```powershell
opencode-loopd uninstall-task --name OpenCodeLoop
```

Check existing tasks:

```powershell
Get-ScheduledTask | Where-Object { $_.TaskName -like "*OpenCode*" }
```

For active development, a visible terminal running daemon mode is usually easier to monitor:

```powershell
opencode-loopd --project "C:\path\to\project" --every 0s --prompt-file loop-prompt.md
```

## Multiple loops and duplicate protection

By default, `/loop ...` uses an upsert/replace behavior. Running `/loop 5m ...` again replaces the existing default loop instead of creating duplicate jobs.

Use `--name` to manage separate named loops, or `--multi` when you intentionally want multiple loops with the same shape:

```text
/loop 5m --name dev continue from progress.md
/loop 200m --name compact /compact
/loop 10m --multi !npm test
```

## Core commands

| Command | Purpose |
|---|---|
| `/loop <interval> <prompt>` | Add an idle/interval prompt loop |
| `/loop-command <interval> <slash-command>` | Schedule an OpenCode slash command such as `/compact` |
| `/loop-cmd <interval> <slash-command>` | Alias for `/loop-command` |
| `/loop-ask <interval> <prompt/question>` | Schedule a recurring question/check prompt; first run waits for the interval by default |
| `/loop-prompt <interval> <prompt>` | Force prompt mode, even when you want explicit prompt-loop naming |
| `/loop-shell <interval> <shell-command>` | Schedule a shell command loop |
| `/loop-goal <objective>` | Start experimental persistent Goal Mode |
| `/loop-goal-status` | Show experimental goal state |
| `/loop-goal-pause` | Pause the active experimental goal |
| `/loop-goal-resume` | Resume the active experimental goal |
| `/loop-goal-clear` | Clear experimental goals |
| `/loop-goal-done <summary>` | Manually mark the active goal complete |
| `/loop-goal-blocked <reason>` | Manually mark the active goal blocked |
| `/loop-help` | Show usage help inside OpenCode |
| `/loop-status` | Show active loop jobs |
| `/loop-logs` | Show recent loop log entries |
| `/loop-now [id/name/number/all]` | Run loop job(s) immediately |
| `/loop-pause [id/name/number/all]` | Pause loop job(s) |
| `/loop-resume [id/name/number/all]` | Resume loop job(s) |
| `/loop-remove [id/name/number/all]` | Remove loop job(s) |
| `/loop-stop [id/name/number/all]` | Alias for remove/stop |
| `/loop-clear` | Remove all loop jobs for the current session |
| `/loop-doctor` | Diagnose plugin/session state |
| `/loop-init [file]` | Create a starter `progress.md` or another progress file |
| `/loop-export` | Export current loop state as JSON |

## Preset commands

| Command | Purpose |
|---|---|
| `/loop-dev 0s` | General autonomous OpenCode development loop |
| `/loop-progress 0s` | Follow `progress.md` and TODOs |
| `/loop-safe-dev 0s` | Safe dev loop with ask-never, batch 5, and patch checkpoints |
| `/loop-testfix 0s "npm test"` | Run, fix, and re-run tests |
| `/loop-compact 200m` | Compact loop shortcut |

## Intervals

```text
0s     run whenever OpenCode becomes idle, like Claude Code auto-continue
5m     run every 5 minutes when idle
200m   run every 200 minutes when idle
1h     run every hour when idle
```

The plugin is **idle-driven**. It checks jobs when OpenCode becomes idle, so it avoids intentionally starting a second agent turn on top of an active one.

If the interval expires while OpenCode is busy, the loop becomes due and waits. It runs on the next idle event.

## Loop types

OpenCode Loop has separate types for prompts, OpenCode slash commands, and shell commands. This matters because `/compact` should be executed as an OpenCode command, not sent to the agent as text.

| Type | Use | Example | First run |
|---|---|---|---|
| Prompt loop | Ask or instruct the agent repeatedly | `/loop 1h check whether tests, tsc --noEmit, and build pass` | Now by default |
| Scheduled question | Ask/check on a timer | `/loop-ask 1h did you run tests and build?` | After the interval by default |
| Slash-command loop | Run OpenCode commands like `/compact` | `/loop-command 200m /compact` | After the interval by default |
| Shell loop | Run real terminal commands | `/loop-shell 10m npm test` | After the interval by default |
| Experimental goal | Keep pursuing an outcome until complete/blocked | `/loop-goal make build pass` | Now by default |

You can still force the type on `/loop`:

```text
/loop 200m --command /compact
/loop 10m --shell npm test
/loop 1h --prompt did you run tests, tsc --noEmit, and build?
```

## Actions

### Prompt action

```text
/loop 0s continue from progress.md. Work on the next unfinished TODO. Mark completed items with [x].
```

### Prompt file action

Use this when the prompt is too long for a single command line:

```text
/loop 0s --prompt-file loop-prompt.md
```

Example `loop-prompt.md`:

```md
Continue from progress.md.
Do not ask questions unless truly blocked.
Make reasonable assumptions and keep working.
Complete TODOs in order and mark finished items with [x].
Add useful follow-up TODOs when you discover them.
Run tests, lint, or build when available.
Do not run destructive commands, force pushes, production deploys, or database resets.
```

### Include extra context files

```text
/loop 0s --include-file ARCHITECTURE.md --include-file progress.md continue with the next implementation task
```

### Slash command action

Use `/loop-command` when the action should be executed as an OpenCode command instead of sent to the agent as text.

```text
/loop-command 200m /compact
/loop-command 15m /review current changes
```

`/compact` and `/summarize` are treated specially and routed to OpenCode's TUI compact action. Custom command templates such as `/review` are routed through OpenCode's session command API. If OpenCode is busy when the interval expires, the command waits and runs when the session becomes idle.

Equivalent forced type on `/loop`:

```text
/loop 200m --command /compact
```

For most users, the clearer form is preferred:

```text
/loop-command 200m /compact
```

### Shell action

Use `/loop-shell` for real terminal commands.

```text
/loop-shell 10m npm test
/loop-shell 30m pnpm lint
```

Equivalent forced type on `/loop`:

```text
/loop 10m --shell npm test
```

Shell actions starting with `!` or `$` run through the OpenCode shell tool.

## Flags

### `--name <name>`

Name a loop so you can manage it later.

```text
/loop 0s --name dev continue from progress.md
/loop-pause dev
/loop-resume dev
/loop-stop dev
```

### `--max-runs <n>`

Stop after N runs.

```text
/loop 5m --max-runs 20 continue from progress.md
```

### `--max-runtime <duration>`

Stop after total runtime from loop creation.

```text
/loop 0s --max-runtime 6h continue from progress.md
```

### `--timeout <duration>`

Best-effort abort after a single run timeout.

```text
/loop 0s --timeout 30m continue from progress.md
```

### `--max-failures <n>`

Pause after repeated verify/postrun failures.

```text
/loop 0s --verify "npm test" --max-failures 3 continue from progress.md and fix test failures
```

### `--pause-on-verify-fail`

Pause immediately after the first verify failure.

```text
/loop 0s --verify "npm test" --pause-on-verify-fail continue from progress.md
```

### `--until <text>`

Stop when a marker appears in common state files such as `progress.md`, `TODO.md`, or `.opencode/opencode-loop/until.txt`.

```text
/loop 5m --until ALL_DONE continue from progress.md
```

### `--stop-file <file>`

Stop when a file appears. This is a simple manual kill switch.

```text
/loop 0s --stop-file STOP_LOOP continue from progress.md
```

Create `STOP_LOOP` in the project root to stop that job.

### `--no-overlap` and `--allow-overlap`

`--no-overlap` is the default. It prevents a new run from being triggered while a previous run is still considered active.

```text
/loop 5m --no-overlap continue from progress.md
```

### `--compact-every <n|duration>`

Compact before a run every N runs or every duration.

```text
/loop 0s --compact-every 20 continue from progress.md
/loop 0s --compact-every 200m continue from progress.md
```

### `--test "<command>"`

Adds a test instruction to prompt actions.

```text
/loop 0s --test "npm test" continue from progress.md
```

### `--verify "<command>"`

Runs a real shell verification command after each assistant turn. If it fails, the next loop prompt includes the failure summary so the agent can fix it.

```text
/loop 0s --verify "npm test" continue from progress.md and fix any failing tests
```

### `--preflight "<command>"`

Runs a real shell command before each loop turn. If it fails, the loop pauses.

```text
/loop 0s --preflight "npm install" continue from progress.md
```

### `--postrun "<command>"`

Runs a shell command after each assistant turn and verification.

```text
/loop 0s --postrun "git status --short" continue from progress.md
```

### `--notify "<command>"`

Runs a shell command when a loop stops or pauses due to a control condition. The command can use `{job}` and `{reason}` placeholders.

```text
/loop 0s --max-runtime 6h --notify "echo {job} stopped because {reason}" continue from progress.md
```

### `--checkpoint-only`

Save `git status` and `git diff --binary` snapshots under:

```text
.opencode/opencode-loop/checkpoints/<session>/
```

### `--git-checkpoint`

Save a patch checkpoint and attempt to commit all changes after each completed run.

```text
/loop 0s --git-checkpoint continue from progress.md
```

Use carefully. It runs `git add -A` and `git commit` when changes exist.

### `--branch <name>`

Switch to a branch before the first run, or create it if it does not exist.

```text
/loop 0s --branch ai-loop continue from progress.md
```

### `--safe`

Adds safety instructions to prompt actions and blocks obviously destructive shell actions.

```text
/loop 0s --safe continue from progress.md
```

Safe mode warns against or blocks patterns such as `git reset`, `git clean`, `rm -rf`, `git push`, `terraform destroy`, destructive delete commands, and production deploys.

### `--batch <n>`

Tell the agent to process at most N TODO items per run.

```text
/loop 0s --batch 5 continue from progress.md
```

### `--quiet`

Tell the agent to keep replies short.

```text
/loop 0s --quiet continue from progress.md
```

### `--ask-never`

Tell the agent not to ask questions and to make reasonable assumptions.

```text
/loop 0s --ask-never continue from progress.md
```

### `--progress-file <file>`

Tell the agent which state file to treat as the main progress/TODO source.

```text
/loop 0s --progress-file progress.md continue from the progress file
```

### `--watch <file>`

Run when watched file metadata changes. This is still checked on idle events.

```text
/loop --watch progress.md continue after progress.md changes
/loop 5m --watch progress.md continue when progress.md changes or the interval is due
```

You can pass multiple `--watch` flags.

### `--dry-run`

Parse and preview a loop without saving it.

```text
/loop 0s --dry-run --ask-never continue from progress.md
```

### `--now` and `--no-now`

By default `/loop` prompt jobs are due immediately. Use `--no-now` to wait for the first interval.

```text
/loop 1h --no-now did you run tests, tsc --noEmit, and build?
```

Command-style shortcuts such as `/loop-command`, `/loop-ask`, and `/loop-shell` wait for the first interval by default. Use `--now` if you want them to run immediately too.

```text
/loop-command 200m /compact
/loop-command 200m --now /compact
```

## Recommended recipes

### Claude Code style auto-continue loop

```text
/loop 0s --name dev --ask-never --safe --no-overlap --batch 5 --compact-every 200m --checkpoint-only --progress-file progress.md Treat progress.md as the main project state file. Continue with the next unfinished TODO, implement it, mark completed items with [x], add useful follow-up TODOs when you discover them, run tests/lint/build when available, and keep going while work remains.
```

### Long-running autonomous development loop

```text
/loop 0s --name dev --ask-never --safe --no-overlap --compact-every 20 --timeout 45m --max-runtime 6h --max-failures 3 --stop-file STOP_LOOP --checkpoint-only Continue from progress.md. Do not ask questions. Make reasonable assumptions. Complete TODOs in order, mark finished items with [x], add useful new ideas to progress.md, and keep going while work remains.
```

### Daemon-based long-running development loop

```bash
opencode-loopd --project . --every 5m --prompt-file loop-prompt.md
```

### Test-fix loop

```text
/loop 0s --name testfix --ask-never --safe --verify "npm test" --max-failures 3 Continue from progress.md. If tests fail, analyze the failure, fix it, and run the tests again.
```

### Compact loop

```text
/loop-command 200m /compact
```

This compacts every 200 minutes when OpenCode is idle. It does not interrupt an active agent turn.

### Scheduled quality-check question

```text
/loop-ask 1h did you run tests, tsc --noEmit, and build? If not, run them now and fix errors.
```

This asks the agent every hour when idle. If the hour passes while the agent is working, the question waits and is sent after the current turn finishes.

### Prompt file loop

```text
/loop 0s --name dev --prompt-file loop-prompt.md --checkpoint-only --max-runtime 6h
```

## Suggested OpenCode permission config

Full `permission: "allow"` is convenient but risky. For safer long loops, keep destructive commands as ask/deny.

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
      "pnpm test*": "allow",
      "pnpm lint*": "allow",
      "git push*": "ask",
      "git reset*": "ask",
      "git clean*": "deny",
      "rm *": "deny",
      "del *": "ask",
      "rmdir *": "ask"
    },
    "external_directory": "ask"
  }
}
```

## State files

Session loop state is stored under:

```text
.opencode/opencode-loop/
```

Patch checkpoints are stored under:

```text
.opencode/opencode-loop/checkpoints/
```

Recent plugin events are appended to:

```text
.opencode/opencode-loop/loop.log
```

Add `.opencode/opencode-loop/` to project `.gitignore` when possible. Runtime state is rewritten often, and on Windows file locks from scanners or snapshot tools can interrupt in-place renames. Since v0.5.20 the plugin writes state payloads via the OS temp directory with a rename/copy fallback so jobs survive those locks; gitignoring the directory still keeps noise out of commits.

## Example progress.md

Create one with:

```text
/loop-init
```

Example content:

```md
# Progress

## Current Goal
Improve the application in small safe steps.

## Agent Rules
- Do not ask questions unless truly blocked.
- Make reasonable assumptions and continue.
- Work on unfinished TODOs in order.
- Mark completed TODOs with [x].
- Add new bugs, ideas, or follow-up tasks as TODOs.
- Run tests/lint/build when available.
- Do not run destructive commands, force pushes, production deploys, or database resets.

## Active TODO
- [ ] Review the project structure and identify the next safe improvement.
- [ ] Fix the highest-priority failing test.
- [ ] Improve the user-facing error state in the main flow.

## Completed
- [x] Added initial project notes.

## Backlog Ideas
- [ ] Add a smoke test for the critical path.
- [ ] Improve developer setup documentation.

## Blocked
- None.
```

## Changelog highlights

### v0.5.20

- Fixed Windows `EPERM` / `EEXIST` failures when rewriting `.opencode/opencode-loop/ses_*.json` during heartbeat and due-timer updates.
- Atomic state payloads are staged outside the project so OpenCode no longer git-snapshots `opencode-loop/*.tmp` pathspecs.

### v0.5.17

- Added a tool-denied local command agent and restored the normal coding agent/model for scheduled iterations.
- Prevented package/local duplicate plugin loading and deferred bootstrap SDK calls to avoid project startup deadlocks.
- Fixed watched jobs, preset parsing, repeated-command deduplication, safe-shell patterns, and invalid-action retry storms.
- Added comprehensive command, lifecycle, installer, JSONC, scheduler, and safety regression tests.

### v0.5.16

- Treat active tools, shell calls, and running foreground/background child sessions as busy even when the parent session appears idle.
- Prevent stale-run recovery from enqueueing another continuation while tracked background work is still active.
- Added regression tests for long-running tool calls and background child sessions.

### v0.5.15

- Hardened experimental Goal Mode completion with concrete evidence, passing-check requirements, no-progress pausing, and user-message interruption.
- Preferred OpenCode plugin SDK `{ body }`, `{ path: { id }, body }`, and `{ query }` shapes before compatibility fallbacks.
- Added explicit workspace path guidance, safer 3-minute active-turn recovery, timer disposal cleanup, and an automated Goal Mode smoke test.
- Made local installers add the `@opencode-ai/plugin` dependency needed by local `.ts` plugins.

### v0.5.13

- Wrapped experimental goal tools with OpenCode's `tool()` helper and Zod schemas for current OpenCode tool validation.
- Added `@opencode-ai/plugin` as a development dependency so fresh clones can resolve the tool helper.

### v0.5.12

- Changed local installs to write `opencode-loop.ts` and remove stale `opencode-loop.js` copies.
- Fixed OpenCode CLI command argument parsing, current SDK call shapes, and `opencode-loopd` prompt passing.

### v0.5.7

- Added experimental Goal Mode with `/loop-goal <objective>`.
- Added goal lifecycle commands and local goal tools so the agent can report real progress, completion evidence, or blocked state.
- Added repeated `--acceptance`, `--success`, and `--check` flags for goal criteria and verification.
- Added `--complete-when-checks-pass`, `--max-turns`, and `--evidence-file` for controlled goal workflows.
- Goal reports are written under `.opencode/opencode-loop/goals/` by default.

### v0.5.6

- Added clearer README examples for prompt loops, scheduled question loops, command loops, shell loops, first-run timing, and idle-safe behavior.
- Stabilized `/loop-command 200m /compact` by routing compact/summarize through OpenCode TUI compact handling instead of treating it as a custom prompt command.
- Clarified that command loops wait for idle and should be used for slash commands such as `/compact`.

### v0.5.5

- Added explicit loop action types: prompt, scheduled question, OpenCode slash command, and shell command.
- Added `/loop-command` / `/loop-cmd` for commands such as `/compact`; these wait for the first interval by default.
- Added `/loop-ask` for recurring checks such as "did you run tests, tsc --noEmit, and build?"; it waits for the first interval by default.
- Added `/loop-shell` for recurring shell commands.
- Added `--prompt`, `--ask`, `--command`, `--cmd`, `--slash`, `--shell`, and `--compact` type flags for `/loop`.
- Clarified idle behavior: if a job becomes due while OpenCode is busy, it waits and runs on the next idle event.

### v0.5.4

- Fixed compatibility with recent OpenCode SDK/TUI call shapes.
- Updated prompt, shell, and toast calls for current OpenCode while keeping backwards-compatible fallbacks.
- Added `session.status` idle gating and debounce so loop runs do not stack on top of busy/queued agent turns.
- Improved logging around prompt/shell/toast failures instead of silently swallowing important runtime errors.
- Fixed the known update-related symptoms where `/loop` could appear queued, stay at `runs=0`, or only work intermittently.

### v0.5.1

- Cleaned up README installation docs.
- Removed duplicate npm install section.
- Removed unresolved merge conflict markers.
- Added clearer daemon mode documentation.
- Added Windows Task Scheduler examples.
- Added daemon usage examples for `--every`, `--max-runs`, `--sleep-first`, and `--prompt-file`.

### v0.5.0

- Added `opencode-loopd` background daemon.
- Added Windows Task Scheduler helper.
- Documented TUI loop vs daemon loop.
- Added background long-running loop examples.

### v0.4.3

- Added duplicate loop protection.
- Quieted command markdown files.

## Notes and limits

- The TUI plugin is idle-driven. It does not run a background daemon while OpenCode is busy.
- The TUI `/loop` command stops when OpenCode closes, the terminal closes, the machine sleeps, or the session stops emitting idle events.
- For long-running work outside the TUI, use `opencode-loopd`.
- `--timeout` is best-effort and relies on OpenCode's abort API.
- `--verify`, `--preflight`, `--postrun`, and `--notify` run shell commands, so configure OpenCode permissions carefully.
- `--until` scans common state files and a limited number of markdown/text/json/yaml files to avoid walking huge projects.
- `--safe` reduces risk but does not replace careful OpenCode permissions.
- For truly unattended multi-hour work, use a disposable branch or worktree and checkpoint patches.

## License

MIT
