# OpenCode 2 migration: Loop and Goal

Started: 2026-09-29. Work directly on main; do not create repair branches.
Initial inventory: Loop f4a7fedb47bfc03d7630eba6d708704d2d12517a and Goal da4b1c1745e4fa76cf38f982c9582adf880fc7eb.
Pinned real-host baseline: OpenCode 2.0.18; not a guarantee about every later host.

## Goal

Port behavior, not just package names. V2 execution uses native prompt,
command, tool, event and compaction boundaries. Keep the explicit V1 adapter
isolated and tested while supported; it must not initialize on V2.
Preserve project-local state, budgets, evidence and single-owner execution.

## Work plan and exit gates

| Phase | Work | Exit gate | Status |
| --- | --- | --- | --- |
| 0 | Inventory both main branches, public entries and official V2 APIs | Baseline plus complete capability matrix | Initial matrix below; full per-option audit pending |
| 1 | Plugin lifetime, reload and admission safety | Negative regression then passing native and full suites | First Loop and Goal increments implemented and tested |
| 2 | Every command/option, scheduler, daemon and installer | Native implementation for each supported surface | Existing native core retained; convenience commands and edge cases need audit |
| 3 | Goal completion, recovery, per-unit handoff and Loop coexistence | No second owner; budgets/evidence preserved | Existing tests retained; expanded joint matrix pending |
| 4 | V2 options, diagnostics, tool progress and user-facing docs | Docs and diagnostics match actual capabilities | In progress; Goal TUI port is explicitly pending |
| 5 | Batch Windows/Linux, installed-package and real-host validation | Exact final heads green; publish separately with registry proof | First-increment checks wired; whole-migration gate remains open |

## Initial feature matrix

| Surface | Code observed | Remaining work |
| --- | --- | --- |
| Package and local V2 entry | `src/source/server.js`, `src/source/native.js` | Canonical identity fixed; retain production-package and no-V1-import checks |
| Loop lifecycle commands | `opencode2/commands.js`, `native-plugin.js` | Native loop/pause/resume/stop/remove/clear/now/status/export/help/doctor/logs registered; audit every legacy alias and preset separately |
| Shell, command and compaction schedules | Explicit native registrations in `native-plugin.js` | Verify capability rejection and correlated completion for each action |
| Scheduling and verification | `native-runtime.js`, `native-policy.js` | Audit every flag, watch/stop files, checkpoints and hard limits against V1 behavior |
| Event subscription and plugin cleanup | AbortSignal plus exhaustive shared cleanup already in main | Permanent regressions retained; audit late callbacks and wrong-location events |
| CLI daemon | `scripts/loopd.mjs` selects native host through `scripts/opencode-host.mjs` | Existing native CLI canary retained; verify reconnect, remote location and session-selection failure cases |
| Joint installer | `native-install-pair-test.mjs` in native CI | Test the actual current Goal installer pin, object options and duplicate registrations |
| Dedicated Goal coexistence | Native Goal reservation and paired host canary | Expand waiting-user, handoff, interrupted/restarted and foreign-session cases |
| Goal terminal UI | Companion `src/tui/index.ts` still uses legacy `tui(api)`/`sidebar_content` | Separate V2 `setup(context)`/`ui.slot` port and safe remote read-only status path are required |

## First Loop increment: implemented and tested

- Native local and package entries share the canonical @bybrawe/opencode-loop ID.
- The installed-tarball entry test asserts that exact ID, not just its type.
- Diagnostic log write failures cannot escape fire-and-forget error callbacks.
- Three permanent regressions cover idle-stream cancellation, shared cleanup
  with exhaustive release after errors, and canonical native identity.

The current main had already fixed subscription cancellation and exhaustive
cleanup when the regression workflow ran. Those two tests passed BEFORE this
patch, so their implementation was preserved rather than overwritten. The
identity test failed on the original source and passed after the ID fix.

Verification: [Loop lifetime/identity pass](https://github.com/ByBrawe/opencode-loop/actions/runs/36500548173).
All shipping bundles were rebuilt, then check, the complete test suite, clean
installed-package smoke and pack dry-run passed before the source commit.
The one-shot write workflow removed itself after committing verified files.

Companion verification: [Goal admission/unload pass](https://github.com/ByBrawe/opencode-goal/actions/runs/36500333399).
Native V2 CI now pins Goal 2d5bff13009cde9d83d91b560b44502beef0db84 so the
joint installer and host tests include that lifetime fix, not an older Goal.
A configured test is not itself a passing result; inspect the exact run.

## Next implementation order

1. Finish the full command/option mapping, including legacy convenience aliases
   and presets. Preserve documented functionality or state a deliberate support
   boundary; never silently accept an option that has no native effect.
2. Port the companion Goal terminal entry to native V2, preserving read-only
   presentation and separating local from remote/worktree state.
3. Expand session/worktree scoping, retry, verification, compaction and handoff
   race coverage on both sides of the shared continuation-owner boundary.
4. Batch final Windows/Linux, installed-package, CLI daemon and paired real-host
   checks. Review issues and publish only against separately verified results.

## Joint constraints

Goal owns unfinished sessions; Loop cannot supply a second continuation.
Handoff state and verification evidence remain authoritative. Do not rewrite
old session histories to conceal compaction errors. Keep unrelated issues
open. A green test run is not npm publication or a measured real-provider
performance result. Do not replace tested durable storage merely to use a new API.

## References

- https://opencode.ai/v2/docs/build/plugins/migrate-v1
- https://opencode.ai/v2/docs/build/plugins/
- https://opencode.ai/v2/docs/build/plugins/cli/
- https://github.com/ByBrawe/opencode-goal/blob/main/docs/opencode2-migration-plan.md
