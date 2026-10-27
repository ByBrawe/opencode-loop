# OpenCode Loop 0.6.9

## Native OpenCode 2 checklist completion guard (#174)

Loop now supports **opt-in host-verified checklist completion** for user-owned project Markdown files. This addresses the real user report in which all tasks in TASK.md were checked but an intentionally unlimited idle Loop kept running.

Example:

~~~text
/loop --progress-file TASK.md --until-checklist-complete --verify "npm test" finish remaining project work
~~~

The **--until-checklist-complete** flag is explicit: an ordinary **--progress-file** is context only and does **not** change the existing unlimited Loop continuation contract. At a safe scheduling boundary, the host reads the Markdown file and requires at least one task checkbox with **zero unchecked tasks**. It ignores fenced code/quoted/commented examples. Missing, unsafe, symlinked, outside-project, control-plane, empty/unreadable or oversized paths never authorize completion; Loop pauses visibly instead.

When **--verify** is present, completion requires the host's successful verification recorded for the **exact SHA-256 content** of the checklist file. If TASK.md changes after a successful verification, the old result cannot stop the updated task. This is a file-content consistency check, **not** independent semantic evidence that untested work was correct.

Both native V2 and explicit V1 compatibility runtimes use the guard. Deterministic parser/filesystem, safe idle prompt suppression, stale-verification, bundle parity and Loop+Goal coexistence tests are required release gates.

## Native stop controls and OpenCode 2 diagnostics

Invoke /loop-stop or /loop-clear as a **real user slash command**. An AI assistant merely printing /loop-clear does not invoke the host command. /loop-status shows the opt-in checklist state and actionable stop information for active jobs.

Read-only Windows Desktop diagnostics can compare the CLI backend and an explicit localhost Desktop backend across two workspace directories, but the original Desktop GUI command discovery issue [#169](https://github.com/ByBrawe/opencode-loop/issues/169) is **not** claimed fixed until field replay.

## Package installation and verification

~~~text
npx -y @bybrawe/opencode-loop@0.6.9
npx -y @bybrawe/opencode-goal@1.3.49
~~~

Install packages separately; Loop never silently installs or updates dedicated Goal. Fully quit and restart OpenCode, verify /loop-doctor, /loop-status, /goal status, and a short bounded Loop run in the intended project directory. Only rely on the new flag after 0.6.9 is present in the npm registry and the full published-package consumer workflow has succeeded. If publication fails, do not treat the GitHub source commit as an npm release.

This release does **not** claim all Windows Desktop/WSL/ARM64 GUI scenarios are solved.
