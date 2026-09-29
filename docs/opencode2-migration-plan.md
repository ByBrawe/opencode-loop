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
| 2 | Every command/option, scheduler, daemon and installer | Native implementation for each supported surface | Native presets retained; session-location guard implemented; per-option edge cases remain under audit |
| 3 | Goal completion, recovery, per-unit handoff and Loop coexistence | No second owner; budgets/evidence preserved | Existing tests retained; expanded joint matrix pending |
| 4 | V2 options, diagnostics, tool progress and user-facing docs | Docs and diagnostics match actual capabilities | Native Goal sidebar and scoped RPC implemented; other diagnostic edges remain under audit |
| 5 | Batch Windows/Linux, installed-package and real-host validation | Exact final heads green; publish separately with registry proof | Current-increment checks wired; whole-migration gate remains open |

## Initial feature matrix

| Surface | Code observed | Remaining work |
| --- | --- | --- |
| Package and local V2 entry | `src/source/server.js`, `src/source/native.js` | Canonical identity fixed; retain production-package and no-V1-import checks |
| Loop lifecycle commands | `opencode2/commands.js`, `native-plugin.js` | Native lifecycle commands and presets registered; complete per-option edge audit |
| Shell, command and compaction schedules | Explicit native registrations in `native-plugin.js` | Verify capability rejection and correlated completion for each action |
| Scheduling and verification | `native-runtime.js`, `native-policy.js` | Audit every flag, watch/stop files, checkpoints and hard limits against V1 behavior |
| Event subscription and plugin cleanup | AbortSignal plus exhaustive shared cleanup already in main | Permanent cleanup regressions retained; native session location checked before queued work |
| CLI daemon | `scripts/loopd.mjs` selects native host through `scripts/opencode-host.mjs` | Native CLI canary retained; verify reconnect, remote location and session-selection failure cases |
| Joint installer | `native-install-pair-test.mjs` in native CI | Actual companion Goal installer, object options and duplicate registrations |
| Dedicated Goal coexistence | Native Goal reservation and paired host canary | Expand waiting-user, handoff, interrupted/restarted and foreign-session cases |
| Goal terminal UI | Companion native `setup(context)` / `ui.slot` with server-only status RPC | No CLI-local Goal filesystem fallback; actual renderer and scoped-server tests retained |

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
Native V2 CI now pins Goal `4fe29ee4c53fc58cec1ebb1d37b6a6261b5d911a` so the
joint installer and host tests include the native sidebar, read-only RPC and
handoff lifetime fix. A configured test is not itself a passing result;
inspect the exact run.

## Next implementation order

1. Finish the full command/option mapping. Preserve documented functionality
   or state a deliberate support boundary; never silently accept an option
   that has no native effect.
2. Retain the companion native sidebar and read-only RPC tests across local,
   remote-addressed and different-worktree sessions.
3. Expand session/worktree scoping, retry, verification, compaction and handoff
   race coverage on both sides of the shared continuation-owner boundary.
4. Batch final Windows/Linux, installed-package, CLI daemon and paired real-host
   checks. Review issues and publish only against separately verified results.

## Session-location increment

Native commands now resolve their session through `session.get` before
reading or writing project files. Commands such as `loop-init` reject missing,
foreign-directory and wrong-workspace sessions rather than using the plugin
instance's directory as a guess. Native hooks and public events use the same
scope check; queued commands and timers recheck it before executing.

Four regressions reproduced the original wrong-directory write and verify
local success, failed lookup/identity checks and canceled foreign-scope work
without rewriting the saved job. The native preset fixture now supplies the
real session lookup contract instead of weakening the production guard.

All three shipping bundles were rebuilt. Check, the complete regression suite,
installed-package smoke and the actual OpenCode 2.0.18 Loop canary passed in
[scope validation](https://github.com/ByBrawe/opencode-loop/actions/runs/36502932356)
before product commit `abc728dc93478050c3fa3d013947553e0a75765f`.
See [session location safety](opencode2-session-location.md) for the exact
guarantees, including the limit that arbitrary concurrent filesystem moves
are not transactionally locked across every asynchronous operation.

The paired-host CI also retains the full-contract three-session handoff and
adds the native Goal RPC test in two locations. Its actual current-head result
must be checked in CI, not inferred from this plan. npm publication is not part
of this increment.

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
