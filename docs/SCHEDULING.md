# OpenCode Loop scheduling semantics

Loop is an **idle-safe continuation and scheduling layer**. It is not intended to stack model turns while OpenCode is already working.

The key rule is simple:

> A job may become **due** because of idle state, a timer, a watch trigger, or `/loop-now`, but a prompt/command/shell action is dispatched only when the session is safe to use.

That means a timer expiring does **not** imply a second assistant turn is injected on top of a busy turn. Due work waits for idle.

## The four useful forms

### 1. Continue forever whenever the assistant stops

```text
/loop continue
```

or:

```text
/loop devam et
```

or explicitly:

```text
/loop idle continue
```

This is the normal Claude Code-style continuation loop.

Semantics:

- schedule mode: `idle`
- first run: next safe idle boundary
- later runs: every later safe idle boundary
- run limit: unlimited unless `--max-runs` / `--max-runtime` is supplied
- overlap: disabled by default

If the assistant finishes a turn, Loop sends the prompt again. If that next turn finishes, Loop sends it again, and so on until the job is paused/stopped, a configured limit is reached, or the host/session goes away.

Short continuation prompts such as `continue`, `keep going`, and `devam et` receive extra project-continuation guidance. The agent is told to treat the turn as continuation of the existing conversation/repository, inspect relevant files/TODO/progress/git state as needed, choose the next unfinished step, and avoid redoing completed work.

**Plain `/loop devam et` is intentionally infinite.** A model saying "done" does not silently change that contract.

If you explicitly want **continue until the project is actually done**, say so:

```text
/loop devam et bitene kadar devam tamamen projeyi bitir
```

Completion-bounded idle loops add two safeguards:

- before declaring terminal completion, the agent is instructed to perform a fresh verification pass;
- Loop auto-pauses only after **two consecutive current assistant turns** both say the project/work is complete **and** that no work remains. A reply that names a next/remaining task resets the terminal signal.

This avoids post-completion spam without weakening the deliberately infinite `/loop devam et` form.

For a real project, a stronger version is:

```text
/loop --safe --ask-never --progress-file progress.md devam et
```

Initialize the progress file first if needed:

```text
/loop-init
```

### 2. Repeat every N minutes

```text
/loop every 5m continue the project
```

Semantics:

- schedule mode: `interval`
- first run: after 5 minutes
- later runs: every 5 minutes according to the Loop due clock
- if due while OpenCode is busy: wait until idle, then run once
- missed busy intervals are not intentionally stacked into multiple prompts

Use this when you really mean a recurring timer.

You can still use the older compact form:

```text
/loop 5m continue the project
```

For backward compatibility, the compact form starts on the next safe idle boundary and then uses the 5-minute interval. To delay the first legacy-form run, use:

```text
/loop 5m --no-now continue the project
```

The explicit `every 5m` form is recommended because its first-run behavior is obvious.

### 3. Do something once after a delay

```text
/loop after 5m continue once
```

Alias:

```text
/loop in 5m continue once
```

Semantics:

- schedule mode: `once`
- first/only due time: 5 minutes after creation
- dispatch: only when the session is idle
- run limit: one

If the five minutes expire while a model/tool/subtask is still running, the one-shot job waits. It does not interrupt the active turn.

The legacy equivalent is roughly:

```text
/loop 5m --no-now --max-runs 1 continue once
```

### 4. Run when a watched path changes

```text
/loop --watch progress.md inspect the new progress and continue
```

Watch jobs remain dormant until their watch condition is triggered, then use the same idle-safe dispatch path.

## Schedule truth table

| Command | Mode | First dispatch | Repeats? |
|---|---|---|---|
| `/loop continue` | idle | next safe idle | yes, every idle |
| `/loop idle continue` | idle | next safe idle | yes, every idle |
| `/loop every 5m continue` | interval | after 5m, then first safe idle | yes |
| `/loop after 5m continue` | once | after 5m, then first safe idle | no |
| `/loop in 5m continue` | once | after 5m, then first safe idle | no |
| `/loop 5m continue` | legacy interval | next safe idle | yes |
| `/loop 5m --no-now continue` | legacy interval | after 5m, then first safe idle | yes |
| `/loop 0s continue` | legacy idle | next safe idle | yes, every idle |

## What “idle-safe” means

Before dispatching a Loop-owned turn, the runtime checks:

1. no Loop run is already being dispatched for the session;
2. OpenCode is not reporting a live running or retrying turn that still owns the session;
3. no active tool call is known for the session;
4. no busy descendant/subtask session is known;
5. `noOverlap` / active-run guards allow another turn;
6. the job is still enabled, unpaused, and within its configured limits.

If any of those checks fail, the job remains due and Loop retries later.

## Network/provider outage recovery

A provider/network outage is different from an ordinary stale `busy` acknowledgement.

When OpenCode reports:

```text
session.status = retry
```

Loop treats the host as the current turn owner. It does **not** age that status into `idle`, and it does not inject another prompt on top of the retrying request.

Likewise, if `session.status()` itself cannot be read because the network is down, Loop fails closed as busy/unknown rather than assuming idle.

For Loop-owned turns:

- transient errors such as `fetch failed`, connection loss/reset, DNS/transient socket failures, request timeouts, 429, and retryable 5xx/provider-unavailable errors are classified as infrastructure failures;
- a failed infrastructure attempt does **not** consume the logical `runCount` or ordinary `failureCount`;
- if that failed attempt had temporarily reached `--max-runs`, the job is re-enabled after the refund;
- retries use exponential backoff (5s, 10s, 20s, 40s, capped at 60s);
- if an explicit OpenCode `retry` remains stuck for 2 minutes, Loop aborts only the **Loop-owned active turn**, refunds that logical run, and returns it to backoff scheduling.

The watchdog never aborts an unrelated foreground/user retry when no Loop-owned active run exists.

Useful log events include:

```text
network-dispatch-error
network-action-error
provider-retry-recovery
```

This makes an outage visible without converting it into either a dead job or overlapping autonomous turns.

## Stale `busy` recovery

Some OpenCode TUI builds can leave `session.status` at `busy` after a plugin command acknowledgement even though the assistant message is already completed. This can otherwise produce the classic symptom:

```text
Loop added
runCount = 0
lastRunAt = 0
```

The runtime cross-checks stale `busy` with the chronological session tail **before the first Loop run too**.

Recovery is conservative:

- latest assistant tail has a real completion timestamp -> stale `busy` may be recovered to idle;
- latest assistant tail is unfinished -> remain busy;
- latest message is user/non-assistant -> remain busy;
- active tool or busy child session -> remain busy;
- unknown completion -> remain busy;
- provider `retry` -> **never** use stale-busy age recovery; wait for host completion/idle or the Loop-owned retry watchdog;
- status API read failed -> remain conservative; do not infer idle.

A stale-busy recovery is written to `loop.log` as:

```text
status-message-idle-recovery
```

## Busy deferral logging

When a due job cannot run because the session is still busy, Loop emits throttled diagnostics instead of silently leaving only the original `add` line.

Typical event:

```text
deferred reason=session-busy source=due
```

The log is throttled so a 5-second busy retry does not flood `loop.log`.

Inspect recent events with:

```text
/loop-logs
```

## `/loop-status`

Status separates the schedule definition from its current state.

Examples:

```text
schedule=every idle | state=waiting for idle
schedule=every 5m, first after 5m | state=due in 3m
schedule=once after 5m | state=due; waiting for idle
```

This distinction is important: **due** is a timing fact; **waiting for idle/retry** is an admission/safety fact.

## `/loop-doctor` and session-bound jobs

Normal plugin Loop jobs are session-bound and persist under:

```text
.opencode/opencode-loop/<session-id>.json
```

Starting a new OpenCode session does not move old Loop jobs into the new session.

`/loop-doctor` reports:

- current session ID;
- number of current-session jobs;
- whether a dedicated `/goal` state is detected for the same session;
- other persisted session state files that still contain enabled jobs;
- how many of those jobs have never run.

This makes an old enabled job visible instead of looking like the current session mysteriously lost it.

For work that must keep running after the TUI/session closes, use `opencode-loopd`; the normal plugin scheduler is intentionally session-bound.

## Dedicated `/goal` coexistence

Loop and OpenCode Goals can be installed together, but they should not both own autonomous continuation of the same session.

If dedicated `/goal` is currently `active`, Loop blocks a new prompt-producing `/loop` job in that same session by default:

```text
Prompt loop not added: dedicated /goal already owns continuation in this session.
```

Recommended choices:

- let `/goal` own autonomous continuation and use Loop only in another session;
- pause/finish the Goal before starting a prompt Loop;
- use scheduled shell/command work only when you understand possible file/verification races.

An explicit escape hatch exists for advanced use:

```text
/loop --allow-goal-overlap continue
```

Use that only when duplicate autonomous turn ownership is intentional.

## Recommended “understand this project and keep going” workflow

For an unfamiliar repository:

```text
/loop-init
```

Then:

```text
/loop --safe --ask-never --progress-file progress.md Understand the existing project architecture and current state first. Inspect the relevant source, tests, docs, TODOs, git status, and recent work. Record the useful state in progress.md, choose the next unfinished safe improvement, implement it, verify it, update progress.md, and continue from there on later idle turns.
```

After the project state is established, a short continuation loop is enough:

```text
/loop --safe --ask-never --progress-file progress.md devam et
```

Because `devam et` is recognized as continuation shorthand, later turns are instructed to resume the existing project rather than start a new interpretation from scratch.

If the desired contract is to stop when the project is demonstrably complete, make that explicit instead:

```text
/loop --safe --ask-never --progress-file progress.md devam et bitene kadar; projeyi bitir
```

## Stopping and limits

Idle loops are intentionally unlimited by default. Bound them when needed:

```text
/loop --max-runs 20 continue
/loop --max-runtime 6h continue
/loop every 5m --max-failures 3 continue
```

Control commands:

```text
/loop-pause
/loop-resume
/loop-stop
/loop-clear
/loop-now
```

`/loop-now` marks a job due immediately but still uses the idle-safe scheduler; it does not re-enter the model from inside the control-command hook.
