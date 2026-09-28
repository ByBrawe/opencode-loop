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
| 0 | Inventory both main branches, public entries and official V2 APIs | Baseline plus complete capability matrix | Baseline done; full matrix pending |
| 1 | Plugin lifetime, reload and admission safety | Negative regression then passing native and full suites | First Loop and Goal increments implemented |
| 2 | Every command/option, scheduler, daemon and installer | Explicit native support or actionable rejection for each surface | Pending |
| 3 | Goal completion, recovery, per-unit handoff and Loop coexistence | No second owner; budgets/evidence preserved | Existing tests retained; expanded joint matrix pending |
| 4 | V2 options, diagnostics, tool progress and user-facing docs | Docs and diagnostics match actual capabilities | Pending |
| 5 | Batch Windows/Linux, installed-package and real-host validation | Exact final heads green; publish separately with registry proof | Pending |

## First Loop increment

- Native local and package entries share the canonical @bybrawe/opencode-loop ID.
- The installed-tarball entry test now asserts that exact ID, not just its type.
- Diagnostic log write failures cannot escape fire-and-forget error callbacks.
- Three permanent regressions cover idle-stream cancellation, shared cleanup
  with exhaustive release after errors, and canonical native identity.

The current main had already fixed subscription cancellation and exhaustive
cleanup when the regression workflow ran. Those two tests passed BEFORE this
patch, so their implementation was preserved rather than overwritten. The
identity test failed on the original source and passed after the ID fix.
All shipping bundles were rebuilt, then check, test and clean installed-package
smoke were run. This is not a complete V1/V2 feature-parity claim.

## Remaining Loop audit

Audit every legacy command and option against the native implementation,
including daemon execution, session/worktree scoping, failure/retry behavior,
stop files, watch mode, verification/checkpoints and scheduled compaction.
Never infer completion or permission from message text. Missing capability
must be visible, not silently emulated with an unrelated legacy call.

## Joint constraints

Goal owns unfinished sessions; Loop cannot supply a second continuation.
Handoff state and verification evidence remain authoritative. Do not rewrite
old session histories to conceal compaction errors. Keep unrelated issues
open; a green test run is not proof that npm has been published.

## References

- https://opencode.ai/v2/docs/build/plugins/migrate-v1
- https://opencode.ai/v2/docs/build/plugins/
- https://github.com/ByBrawe/opencode-goal/blob/main/docs/opencode2-migration-plan.md
