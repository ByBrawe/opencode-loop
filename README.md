# OpenCode Loop

**Idle-safe auto-continue, scheduled OpenCode work, and background loops.**

OpenCode Loop adds `/loop`, scheduled prompt/command/shell jobs, compact scheduling, verification/checkpoints, and the `opencode-loopd` background daemon.

> **Current stable release: `0.5.36`.**

## Install or update

Recommended:

```bash
npx -y @bybrawe/opencode-loop@latest
```

Run the same command again to update. Then **fully restart OpenCode** and verify:

```text
/loop-help
/loop-doctor
```

Install/update Loop and the dedicated Goals companion together:

```bash
npx -y @bybrawe/opencode-loop@latest --with-goals --without-loop-goals
```

`--without-loop-goals` removes only Loop's older experimental `/loop-goal*` command files. It keeps normal `/loop`, command/shell scheduling, daemon support, and the separate `/goal` plugin.

Install only Loop and skip companion network work:

```bash
npx -y @bybrawe/opencode-loop@latest --loop-only
```

Global npm alternative:

```bash
npm install -g @bybrawe/opencode-loop@latest
opencode-loop
```

To uninstall:

```bash
npx -y @bybrawe/opencode-loop@latest --uninstall
```

or, for a global install:

```bash
opencode-loop --uninstall
npm uninstall -g @bybrawe/opencode-loop
```

Project Loop state under `.opencode/opencode-loop/` is intentionally preserved by uninstall.

## The mental model

Loop separates two ideas:

1. **When does work become due?** Idle, a timer, a watch trigger, or `/loop-now`.
2. **When is it safe to dispatch?** Only when the session is actually idle and no active tool/child work would overlap it.

A timer expiring does **not** intentionally inject a second model turn on top of an active one. Due work waits for idle.

## Quick start

### Keep saying “continue” whenever the assistant stops

```text
/loop continue
```

Turkish shorthand works naturally too:

```text
/loop devam et
```

Explicit equivalent:

```text
/loop idle continue
```

This is an **unlimited idle loop** by default. When the assistant finishes and the session becomes safely idle, Loop sends the prompt again. When that turn finishes, it does the same again, until you pause/stop it or a configured limit is reached.

For very short continuation prompts such as `continue`, `keep going`, or `devam et`, Loop adds project-continuation guidance: treat the turn as continuation of the current repository/conversation, inspect relevant files/TODO/progress/git state as needed, find the next unfinished step, avoid redoing completed work, and verify meaningful changes when practical.

For project work, a strong default is:

```text
/loop --safe --ask-never --progress-file progress.md devam et
```

Create a starter progress file first if needed:

```text
/loop-init
```

### Repeat every 5 minutes

```text
/loop every 5m continue the project
```

This waits five minutes before the first run, then becomes due every five minutes. If the timer expires while OpenCode is busy, it waits for the next safe idle boundary rather than stacking prompts.

### Do it once after 5 minutes

```text
/loop after 5m continue once
```

Alias:

```text
/loop in 5m continue once
```

This is a one-shot delayed job. Five minutes passing makes it due; it still waits for idle before dispatching.

### Legacy compact syntax remains supported

```text
/loop 5m continue the project
```

For backward compatibility, this form starts on the next safe idle boundary and then follows a five-minute interval.

Delay its first run explicitly:

```text
/loop 5m --no-now continue the project
```

Legacy idle form is still valid:

```text
/loop 0s continue
```

For the exact schedule truth table and edge cases, see [docs/SCHEDULING.md](./docs/SCHEDULING.md).

## Schedule summary

| Command | Meaning | First dispatch | Repeats |
|---|---|---|---|
| `/loop continue` | auto-continue on idle | next safe idle | every idle |
| `/loop idle continue` | explicit idle loop | next safe idle | every idle |
| `/loop every 5m continue` | recurring timer | after 5m, then idle | yes |
| `/loop after 5m continue` | delayed one-shot | after 5m, then idle | no |
| `/loop in 5m continue` | delayed one-shot alias | after 5m, then idle | no |
| `/loop 5m continue` | legacy recurring form | next safe idle | yes |
| `/loop 5m --no-now continue` | legacy delayed-first recurring | after 5m, then idle | yes |
| `/loop 0s continue` | legacy idle form | next safe idle | every idle |

## Understand an unfamiliar project and keep going

A useful first loop for an unfamiliar repository is:

```text
/loop-init
/loop --safe --ask-never --progress-file progress.md Understand the existing project architecture and current state first. Inspect relevant source, tests, docs, TODOs, git status, and recent work. Record useful state in progress.md, choose the next unfinished safe improvement, implement it, verify it, update progress.md, and continue from there on later idle turns.
```

Once the project state is established, this is enough:

```text
/loop --safe --ask-never --progress-file progress.md devam et
```

The short continuation form is deliberately interpreted as “resume this project”, not “invent a new task from scratch”.

## Other job types

Schedule an OpenCode slash command:

```text
/loop-command 200m /compact
```

Run a real shell command:

```text
/loop-shell 10m npm test
```

Ask a recurring quality-control prompt:

```text
/loop-ask 1h did you run tests, typecheck, and build? If not, run them and fix errors.
```

Watch a path:

```text
/loop --watch progress.md inspect the updated progress and continue
```

Prompt, command, shell, compact, and watch jobs use the same idle-safe scheduling path but different execution transports.

## Core commands

| Command | Purpose |
|---|---|
| `/loop <prompt>` | Add/update an unlimited idle prompt loop |
| `/loop idle <prompt>` | Explicit idle-loop form |
| `/loop every <duration> <prompt>` | Recurring timer, first run delayed |
| `/loop after <duration> <prompt>` | One-shot delayed prompt |
| `/loop in <duration> <prompt>` | Alias for `after` |
| `/loop <duration> <prompt>` | Backward-compatible compact interval form |
| `/loop-command <interval> <slash-command>` | Schedule an OpenCode command |
| `/loop-cmd <interval> <slash-command>` | Alias for `/loop-command` |
| `/loop-ask <interval> <question>` | Schedule a recurring check/question |
| `/loop-shell <interval> <command>` | Schedule a shell command |
| `/loop-status` | Show jobs plus schedule/state |
| `/loop-now [id/name/all]` | Mark selected jobs due now; still waits for idle |
| `/loop-pause [id/name/all]` | Pause jobs |
| `/loop-resume [id/name/all]` | Resume jobs |
| `/loop-remove [id/name/all]` | Remove jobs |
| `/loop-clear` | Remove all jobs for the current session |
| `/loop-logs` | Show recent scheduler/runtime events |
| `/loop-doctor` | Diagnose session/state/scheduling problems |
| `/loop-init` | Create a starter `progress.md` |
| `/loop-export` | Export current-session Loop state |

## Useful flags

Lifecycle and limits:

```text
--name <name>
--max-runs <n>
--max-runtime <duration>
--max-failures <n>
--timeout <duration>
--no-now
--now
```

Safety and verification:

```text
--safe
--ask-never
--no-overlap
--verify "npm test"
--preflight "npm install"
--postrun "git status --short"
--pause-on-verify-fail
```

Project context:

```text
--progress-file progress.md
--prompt-file loop-prompt.md
--include-file ARCHITECTURE.md
--batch 5
--compact-every 20
--watch progress.md
```

Checkpoints:

```text
--checkpoint-only
--git-checkpoint
```

`--git-checkpoint` may stage/commit work; use it only when intentional.

## Status and diagnostics

`/loop-status` reports both the **schedule definition** and the **current scheduler state**. Examples:

```text
schedule=every idle | state=waiting for idle
schedule=every 5m, first after 5m | state=due in 3m
schedule=once after 5m | state=due; waiting for idle
```

This is intentional: “due” is a clock fact, while “waiting for idle” is an admission/safety fact.

### If a job says enabled but never runs

The problematic shape is typically:

```text
enabled=true
paused=false
runCount=0
lastRunAt=0
```

Some OpenCode TUI versions can leave `session.status` at `busy`/`retry` after a plugin command acknowledgement. Loop cross-checks that stale state against the chronological message tail before the first Loop run too. It recovers only when the latest assistant message is actually completed and no active tool/child work is known. A genuinely unfinished assistant turn, latest user turn, active tool, busy child, or unknown completion remains busy.

Recovery is logged as:

```text
status-message-idle-recovery
```

Busy retries are also written as throttled `deferred` events so `loop.log` does not misleadingly contain only the original `add` line.

Use:

```text
/loop-status
/loop-logs
/loop-doctor
```

### Session-bound state

Normal plugin Loop jobs are session-bound and stored under:

```text
.opencode/opencode-loop/<session-id>.json
```

A new OpenCode session does not silently inherit another session's jobs. `/loop-doctor` reports other persisted session files that still contain enabled jobs, including jobs that have never run, so an old loop is visible instead of appearing lost.

For work that must continue after the TUI/session closes, use `opencode-loopd`.

## Loop and dedicated OpenCode Goals

They can be installed together. Recommended split:

- use **`/goal`** for durable outcome-driven work, evidence, verification, restart recovery, and semantic completion;
- use **`/loop`**, `/loop-command`, `/loop-shell`, and `opencode-loopd` for scheduling/repetition/background infrastructure.

A prompt-producing Loop and an active dedicated `/goal` should not both own autonomous continuation of the **same session**. The runtime therefore blocks a new prompt Loop when it detects an active dedicated Goal for that session.

Recommended choices are to finish/pause the Goal or use a separate session. Advanced users can deliberately override the guard with:

```text
/loop --allow-goal-overlap continue
```

That escape hatch can create competing autonomous turns; use it only when that is intentional.

Loop's older experimental `/loop-goal*` commands remain available for compatibility unless installed with `--without-loop-goals`. For new strongly verified Goal work, prefer:

```bash
npx -y @bybrawe/opencode-goal@latest
```

## Recommended development loop

```text
/loop --name dev --ask-never --safe --no-overlap --batch 5 --compact-every 200m --checkpoint-only --progress-file progress.md Treat progress.md as the project state. Continue with the next unfinished TODO, implement it, mark completed items, add useful follow-up TODOs, run tests/lint/build when available, and keep going while work remains.
```

Test/fix loop:

```text
/loop --name testfix --ask-never --safe --verify "npm test" --max-failures 3 Continue from progress.md. If tests fail, analyze the failure, fix it, and run the tests again.
```

## Background daemon

The normal `/loop` plugin is session-bound. `opencode-loopd` pins one exact OpenCode session for daemon iterations and can keep scheduling outside the normal interactive Loop timer lifecycle.

```bash
opencode-loopd --project . --every 5m --prompt-file loop-prompt.md
```

Immediate daemon cadence:

```bash
opencode-loopd --project . --every 0s --prompt "continue from progress.md and implement the next unfinished TODO"
```

Pin a session and limit runs:

```bash
opencode-loopd --project . --session ses_xxx --every 5m --max-runs 20 --timeout 30m --prompt-file loop-prompt.md
```

Windows Task Scheduler:

```powershell
opencode-loopd install-task --project "C:\path\to\project" --every 10m --prompt-file loop-prompt.md --name OpenCodeLoop
opencode-loopd uninstall-task --name OpenCodeLoop
```

## State and checkpoints

Runtime state and logs:

```text
.opencode/opencode-loop/
.opencode/opencode-loop/loop.log
```

Patch checkpoints:

```text
.opencode/opencode-loop/checkpoints/
```

Add `.opencode/opencode-loop/` to `.gitignore` if runtime state should not be committed.

## Permissions

For unattended work, avoid permanently allowing every shell command. Grant routine read/edit/test operations while keeping destructive commands on ask/deny. `--safe` reduces risk but does not replace OpenCode permission configuration.

## Package and compatibility

```text
@bybrawe/opencode-loop
```

Stable package peer range:

```text
@opencode-ai/plugin >=1.4.0 <2
```

The repository contains experimental OpenCode 2 work, but the stable package does not claim full OpenCode 2 parity.

See [docs/SCHEDULING.md](./docs/SCHEDULING.md) for the scheduling contract and [CHANGELOG.md](./CHANGELOG.md) for release history.

## License

MIT
