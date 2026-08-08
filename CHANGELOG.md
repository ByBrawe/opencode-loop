# Changelog

## 0.5.24

- Cross-check stale OpenCode `busy`/`retry` status against the chronological session tail and only recover early when the latest assistant message has a real `time.completed`; an explicitly unfinished assistant tail is never force-finalized.
- Track scheduled compaction through OpenCode's native `experimental.session.compacting` hook and `session.compacted` event, while retaining idle/status fallbacks for older hosts.
- Serialize `--compact-every` as its own compaction phase so the next loop prompt/shell action cannot overlap an in-progress compaction; older hosts that only report idle also finalize this phase without running normal verify/postrun hooks.
- Fix headless/server compact fallback for current OpenCode by supplying the required `providerID`, `modelID`, and `auto: false` payload to `session.summarize`.
- Add deterministic regressions for completed-vs-running assistant tails, native compaction completion, compact/action serialization, and current summarize payloads.

## 0.5.23

- Track non-blocking `session.prompt` and `session.shell` dispatch promises instead of treating every fire-and-forget request as successfully started.
- Recover a rejected scheduler dispatch immediately: clear only the matching active run token, invalidate cached busy status, persist the failure, honor `--max-failures`, and reschedule through the normal scheduler path.
- Never replay a rejected prompt automatically; this avoids duplicate turns when OpenCode status/events are delayed or multiple instances are involved.
- Added a deterministic regression test for delayed prompt rejection and verified the error remains observable in plugin logs.

## 0.5.22

- Hardened compatibility with current OpenCode 1.18.15 while preserving the existing `>=1.4.0` peer range.
- Handled loop commands now also set `output.noReply = true`; OpenCode 1.18.x safely ignores the unknown field, while hosts that add the proposed `noReply` hook support can skip the acknowledgement model turn automatically.
- Added Bun runtime loading coverage so CI exercises the runtime OpenCode actually uses to load plugins, not only Node syntax/tests.
- Added explicit minimum-peer coverage against `@opencode-ai/plugin@1.4.0` and scheduled testing against the latest published OpenCode plugin package.
- Kept the v0.5.21 server-plugin acknowledgement fallback for current OpenCode versions where `command.execute.before` cannot cancel the prompt turn.

## 0.5.21

- Verified server-plugin compatibility against OpenCode 1.18.15 and updated the development plugin dependency accordingly.
- Stopped clearing `command.execute.before` output parts. Current OpenCode still creates a command prompt turn for server-plugin slash commands, so control commands keep the valid tool-denied `opencode-loop-local` acknowledgement instead of producing an empty message.
- Prefer the current `session.compact` TUI command value while retaining `session_compact` and `session.summarize` as compatibility fallbacks.
- Fixed the comprehensive preflight failure test to use a cross-platform shell-safe Node expression.
- Added Ubuntu and Windows pull-request CI, and hardened npm publishing with full tests, tag/version verification, and `npm pack --dry-run`.
- Retained the v0.5.20 Windows state-write retry hardening and deterministic EPERM/partial-read regressions.

## 0.5.20

- Fixed Windows TUI loop state writes failing with `EPERM` / `EEXIST` when renaming a project-local `*.tmp` over an existing session state file. Heartbeat and due-timer updates no longer drop jobs when antivirus, IDE indexers, or OpenCode snapshots briefly lock the destination.
- Write atomic state payloads under the OS temp directory first, then replace the target with rename plus a copy/unlink fallback and short retries, so project trees no longer accumulate `opencode-loop/*.tmp` files that OpenCode tried to git-snapshot.

## 0.5.19

- Made the asynchronous goal prompt smoke test wait for the observable SDK call instead of assuming a single event-loop tick is always sufficient under load.

## 0.5.18

- Fixed package-based installs loading stale OpenCode cache entries after npm had installed a newer release. The installer now pins an existing package config entry to its exact installed version while preserving JSONC comments.
- Fixed Goal Mode mistaking delayed updates for its own scheduler-created user message as a real user interruption. Loop-owned message IDs remain recognized without hiding a distinct user message.
- Added a dedicated `opencode-loopd` regression suite for literal argument passing, BOM prompt files, model/agent forwarding, finite-run exit codes, invalid options, and Windows scheduled-task lifecycle behavior.
- Made finite daemon runs propagate OpenCode failures instead of reporting exit code 0, and reject invalid `--max-runs` values and missing project directories.
- Added `--model` and `--agent` forwarding to daemon and scheduled-task runs.
- Fixed Windows Task Scheduler installation failing when `/TR` exceeded its 261-character limit. Scheduled tasks now use a short launcher plus a task-specific JSON config under the local app-data directory, and uninstall removes both artifacts.
- Made Task Scheduler command launch failures return a nonzero exit code instead of silently succeeding.
- Added non-mutating `--help` and `--version` handling to the `opencode-loop` installer CLI.

## 0.5.17

- Prevented OpenCode project bootstrap deadlocks by deferring local SDK logging and session discovery until after plugin hooks are returned.
- Added a tool-denied `opencode-loop-local` command agent for all 30 slash commands, preventing local status/control commands from spawning tools or background subagents; scheduled work restores the normal agent/model context.
- Made the installer detect package-based plugin configuration in JSON or JSONC and remove duplicate local plugin copies instead of loading two schedulers.
- Fixed watched jobs so file changes actually trigger them, while unchanged paths remain dormant.
- Fixed preset parsing for explicit `0s`, flag-only presets, and custom `/loop-testfix` commands.
- Fixed command-event deduplication so compatibility events are suppressed without swallowing intentional repeated commands.
- Hardened safe shell detection for PowerShell and `rm` variants, removed the `npm run format` false positive, and paused invalid synchronous actions instead of retrying them indefinitely.
- Added comprehensive parser, preset, lifecycle, watch, safety, routing, goal, installer, JSONC, and initialization regression coverage.

## 0.5.16

- Treat active OpenCode tools, shell calls, and foreground or background subtasks as busy even if the parent session receives an idle/status event while they are still running.
- Prevent stale active-run recovery from finalizing a loop turn while any tracked tool call remains active.
- Added regression coverage proving that a due loop waits for long-running tools and background child sessions, then resumes only after that work finishes and the parent session becomes idle.

## 0.5.15

- Hardened experimental Goal Mode completion: agent tool completion now requires concrete evidence instead of accepting empty or generic claims.
- Required configured goal `--check` commands to pass before agent-tool completion, unless the user explicitly opts out or manually marks the goal done.
- Added a no-progress guard for goals. Goals pause after 3 turns without recorded meaningful progress by default, configurable with `--max-no-progress`.
- Paused active goals when a real user message arrives, so new user intent wins before the next automatic continuation.
- Preferred the OpenCode plugin SDK's `{ body }`, `{ path: { id }, body }`, and `{ query }` argument shapes while keeping flat and older path-key fallbacks.
- Added the resolved working directory and workspace-relative path rules to Goal Mode prompts so agents do not accidentally target filesystem-root paths.
- Increased Goal Mode's default active-turn recovery window to 3 minutes so slow model/tool turns are not finalized as stale after 20 seconds.
- Added plugin disposal cleanup for heartbeat, idle, due, watchdog, and active-run timers.
- Added an automated smoke test for SDK call order, Goal Mode prompts, evidence rejection, and successful completion state.
- Updated local installers to create or update config `package.json` with `@opencode-ai/plugin`, needed by local `.ts` plugins that import `tool()`.
- Updated Goal Mode status/report output and README guidance for the new guards.

## 0.5.14

- Guarded active-run finalization so heartbeat and retry checks do not treat a still-running assistant turn as finished.
- Made loop state writes atomic and backed up corrupt state files before falling back to an empty state.
- Changed `opencode-loopd` to pass prompts as process arguments instead of shell strings, preserving quotes in inline prompts.
- Stripped UTF-8 BOMs from daemon prompt files before sending them to OpenCode.
- Removed the package plugin entry from the example config to avoid duplicate loading after the recommended local installer path.

## 0.5.13

- Wrapped experimental goal tools with `tool()` and Zod schemas for current OpenCode tool validation.
- Added `@opencode-ai/plugin` as a dev dependency so fresh clones can resolve the tool helper during local development.

## 0.5.12

- Fixed local plugin installs to write `opencode-loop.ts`, matching OpenCode local plugin discovery.
- Removed stale `opencode-loop.js` local plugin copies during install to avoid duplicate or outdated local plugin loads.
- Made the PowerShell source installer honor `OPENCODE_CONFIG_DIR`, matching the npm and shell installers.
- Fixed `opencode-loopd` to pass the prompt to `opencode run` as the positional message instead of the non-existent `--prompt` flag.
- Added a short retry backoff for failing `opencode-loopd --every 0s` runs.
- Normalized command arguments from array/object forms so `opencode run --command loop ...` can schedule jobs like TUI slash commands.
- Stripped whole-argument quote wrappers before parsing loop durations, fixing quoted `opencode run --command loop "1h ..."` invocations.
- Fixed a goal finalization reassignment so the generated local TypeScript plugin parses under Bun.
- Fixed the Windows Task Scheduler helper script path used by `opencode-loopd install-task`.
- Tried current OpenCode SDK `{ path, body }` and `{ query }` argument shapes before older fallback shapes.

## 0.5.11

- Added a watchdog loop in addition to one-shot due timers, so recurring jobs keep checking due work even if OpenCode misses an idle event or a due timeout gets effectively stuck behind a stale busy state.
- Added stronger stale-active-run recovery. If a plugin-injected run is still marked active after the recovery window, the scheduler treats it as finished, finalizes it, and continues without waiting for another manual command such as `/loop-status`.
- Refreshed session status with workspace-aware calls before trusting cached busy/retry state.
- Kept `/compact` routing from v0.5.9: `session_compact` first, then `session.compact`, then summarize fallback.
- This targets the observed case where `/loop 1m ...` only continued after manually running `/loop-status`.

## 0.5.9

- Fixed stale-busy recovery for TUI sessions. Cached `busy` / `retry` status is now short-lived, so due jobs no longer get stuck at `due in every idle` after `/loop-status` or other short custom-command turns.
- Improved due-timer behavior when OpenCode misses or delays the final idle event after a command turn.
- Fixed `/compact` routing for current OpenCode TUI builds by trying `session_compact` first, then `session.compact`, then the session summarize fallback.
- Kept the command markdown templates short; OpenCode still creates a tiny `OK` turn for custom commands because markdown commands are prompt templates.

## 0.5.8

- Added a real due timer for TUI loop jobs, so delayed jobs can wake without waiting for another OpenCode event.
- Fixed `/loop 1m --no-now ...` style jobs so the first delayed run can fire on time when OpenCode is idle.
- Fixed scheduled action types such as `/loop-ask`, `/loop-command`, and `/loop-shell` so 0s and delayed jobs are scheduled even when their default mode is `--no-now`.
- Added busy retry behavior: if a due timer expires while OpenCode is busy, the job waits and retries instead of interrupting the active turn.
- Reschedules due timers after add, stop, pause, resume, run completion, goal pause/resume/clear, and post-run verification.
- Shortened command markdown templates so unavoidable custom command turns reply `OK` instead of producing misleading status text.
- Kept Experimental Goal Mode marked experimental.

## 0.5.7

- Added experimental Goal Mode with `/loop-goal <objective>`.
- Added goal lifecycle commands: `/loop-goal-status`, `/loop-goal-pause`, `/loop-goal-resume`, `/loop-goal-clear`, `/loop-goal-done`, and `/loop-goal-blocked`.
- Added local goal tools exposed to the agent: `opencode_loop_goal_complete`, `opencode_loop_goal_blocked`, and `opencode_loop_goal_progress`.
- Added goal acceptance criteria with repeated `--acceptance` / `--success` flags.
- Added post-turn goal check commands with repeated `--check` flags.
- Added `--complete-when-checks-pass` for goals that should automatically stop once all configured checks pass.
- Added `--max-turns` alias for goal run limits.
- Added goal reports under `.opencode/opencode-loop/goals/` and optional `--evidence-file`.
- Updated README with simple examples explaining prompt loops, command loops, shell loops, scheduled checks, and experimental persistent goals.

## 0.5.6

- Added clearer README examples for prompt loops, scheduled question loops, OpenCode slash-command loops, shell loops, first-run timing, and idle-safe behavior.
- Stabilized `/loop-command 200m /compact` by routing `/compact` and `/summarize` through OpenCode TUI compact handling instead of treating them as custom prompt commands.
- Clarified that command loops wait for idle and should be used for slash commands such as `/compact`.
- Kept fallback compatibility with older SDK-style calls where possible.

## 0.5.5

- Added explicit loop action types for prompt loops, scheduled question/check loops, OpenCode slash-command loops, and shell-command loops.
- Added `/loop-command` and `/loop-cmd` for scheduled OpenCode commands such as `/compact`. These wait for the first interval by default and run only when OpenCode is idle.
- Added `/loop-ask` for recurring check prompts such as “did you run tests, tsc --noEmit, and build?” It waits for the first interval by default.
- Added `/loop-prompt` to force prompt mode.
- Added `/loop-shell` for recurring shell commands.
- Added `/loop` type flags: `--prompt`, `--ask`, `--command`, `--cmd`, `--slash`, `--shell`, and `--compact`.
- Clarified README examples for scheduled `/compact`, hourly quality checks, and idle-safe timing.
- Added `publishConfig.access=public` and normalized npm bin paths.

## 0.5.4

- Fixed compatibility with recent OpenCode SDK/TUI call shapes.
- Updated session prompt, shell, and toast calls for current OpenCode while keeping backwards-compatible fallbacks.
- Added `session.status` idle gating and debounce so loop runs wait for OpenCode to become idle and do not stack on busy/queued turns.
- Improved runtime logging for prompt/shell/toast failures.
- Fixed the known update-related symptoms where `/loop` could appear queued, stay at `runs=0`, or only work intermittently after OpenCode updates.

## 0.5.0

- Added `opencode-loopd` background daemon for long-running loops outside the OpenCode TUI.
- Added `opencode-loopd install-task` and `opencode-loopd uninstall-task` helpers for Windows Task Scheduler.
- Updated README to clearly explain the difference between session-bound TUI loops and background daemon loops.
- Added npm bin entry for `opencode-loopd`.
- Updated package check script to validate the daemon script.

## 0.4.4

- Made the npm install path the primary README installation method now that the package is published as `@bybrawe/opencode-loop`.
- Clarified that `npx -y @bybrawe/opencode-loop` installs both the plugin file and `/loop-*` command markdown files.
- Moved the OpenCode `plugin` array config to an optional/advanced section because config-only loading may not install slash command markdown files.
- Removed maintainer/publish-oriented instructions from the user-facing install flow.


## 0.4.3

- Fixed duplicate loop creation by making /loop replace/upsert the default loop instead of appending duplicate jobs.
- Added --multi for users who intentionally want multiple independent loops in one session.
- Added --replace as an explicit alias for the default upsert behavior.
- Made command markdown files no-op/silent so the model is less likely to explain the command or create scheduler files.
- Hardened the continuation prompt to avoid scheduling, documentation search, and command explanation loops.
- Clarified that the plugin is session/TUI-bound and does not keep running after OpenCode, the terminal, or the machine disconnects.

## 0.4.2

- Changed npm package name to scoped package `@bybrawe/opencode-loop`.
- Fixed README npm/OpenCode config examples to use `"plugin": ["@bybrawe/opencode-loop"]`.
- Added an npm `bin` installer so `npx -y @bybrawe/opencode-loop` can copy plugin and command files into the OpenCode config directory.
- Clarified that `opencode-loop` and `@bybrawe/opencode-loop` are different npm package names.

## 0.4.1

- Fixed installation docs for GitHub/local installs.
- Clarified that `plugin`: [`opencode-loop`] only works after npm publishing.
- Added manual global install and project-local install instructions.
- Added verification and troubleshooting steps for `/loop-help` and `/loop-doctor`.

## 0.4.0

- Public repository metadata updated for `ByBrawe/opencode-loop`.
- Package renamed to `opencode-loop`.
- README rewritten in English for public GitHub discovery and SEO.
- Added `--prompt-file` for long reusable prompts.
- Added `--include-file` for extra context files.
- Added `--max-runtime` for total runtime limits.
- Added `--max-failures` and `--pause-on-verify-fail` for failure control.
- Added `--postrun` and `--notify` hooks.
- Added `--dry-run` preview mode.
- Added `/loop-doctor`, `/loop-init`, and `/loop-export` commands.
- Improved max-runs finalization so the final run can still verify/checkpoint.
- Improved state cleanup for non-assistant actions such as `/compact`.
- Kept all examples project-neutral and English.

## 0.3.1

- Converted public examples to English.
- Removed private/project-specific language from README.
- Added public `progress.md` workflow examples.

## 0.3.0

- Added SEO-oriented README for OpenCode loop / Claude Code style loop use cases.
- Added `/loop-help` and `/loop-logs`.
- Added `--verify`, `--preflight`, `--stop-file`, and `--progress-file`.

## 0.2.0

- Added max runs, timeout, until, compact scheduling, tests, checkpoints, branch setup, safe mode, batch mode, quiet mode, ask-never mode, watch mode, and preset commands.

## 0.1.0

- Initial local OpenCode loop plugin.
