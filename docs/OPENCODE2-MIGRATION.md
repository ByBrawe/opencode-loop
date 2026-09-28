# OpenCode 2 migration plan: Goal and Loop

Baseline: Goal 8688252; Loop 35e4f96. Target contract for this batch: OpenCode 2.0.18.
This is a source/main plan, not an npm publication announcement or a claim of complete feature parity.

## Rules

- Work on main only. Preserve existing history; no force-push or new feature branches.
- Native V2 uses its own admission, inbox, execution, tool and compaction surfaces.
- Preserve project-local state, Goal IDs/revisions/evidence/budgets, and one continuation owner.
- Prompt hooks are pre-admission and retryable, not an exactly-once persistence boundary.
- Keep V1 compatibility explicit and isolated. Do not migrate a store merely because V2 offers a storage API.
- Finish a coherent source/test batch before reviewing CI collectively. Never remove a safety assertion to turn CI green.
- Close only issues with a matching implementation and test evidence. Publication is a separate step.

## Phases and acceptance

| Phase | Work in both repositories | Acceptance | Status |
| --- | --- | --- | --- |
| 1. Native package boundary | Remove eager V1 runtime imports from V2 server entries; provide explicit /v2 and /v1 exports; retain lazy legacy delegation | Import real source/bundled/installed V2 entries with V1 resolution deliberately rejected; input/options/errors remain intact for explicit V1 calls | Implemented in this batch; validated before commit |
| 2. Installation and CLI | Audit plugins object options, JSONC/multiple configs, combined Goal+Loop install, native local files, daemon/CLI executable detection and help text | Clean install/update/uninstall on Windows/Linux; preserve custom files and options; exercise actual V2 CLI | Pending full audit |
| 3. Runtime boundaries | Audit foreground admission, event generations, compaction ordering, retry/timeout, subscription teardown and disposal failures | Both terminal event orders; duplicate/replayed events; no abort of native compaction; no overlapping continuation or leaked registration | Pending additional audit |
| 4. Goal parity and handoff | Recheck completion evidence, waiting-user/Plan/delegated-task gates, telemetry/budget accounting, unit rotation and crash phases | Same Goal identity/evidence/usage across handoff; one owner after restart; final unit does not rotate; stale proofs cannot complete | Existing implementation; re-audit planned |
| 5. Loop command/policy parity | Compare every documented command and option against the native path, including shell/command aliases, watches, stop conditions, preflight/verify/postrun and checkpoints | Feature matrix with real tests; unsupported combinations rejected before durable job creation | Pending full audit |
| 6. Joint validation and release | Test current main+main and pinned supported hosts; production tarballs; update docs/version/release notes once scope is complete | Batch CI + independent package loading + joint real-host canaries; distinguish deterministic local-provider evidence from live-model field testing | Pending final sign-off |

## First batch

Both server facades previously imported V1 before a V2 host could invoke setup.
The native-entry regression test reproduces that failure using an ESM resolver
which explicitly rejects the V1 SDK and legacy implementation entry. The same
test must pass after the change, including inside an installed production tarball.

Goal retains its public API exports and shared default function identity. Its V1
implementation is moved without behavioral edits behind a typed lazy loader.
Its new /v2 entry exposes only native setup; /v1 retains the existing library API.
Pure verifier proof helpers are shared without importing the V1 tool SDK; both
adapters retain the same exported functions and unavailable-error identity.

Loop uses a sibling runtime URL so bundling cannot inline the legacy import.
The small src/v1.js shim delegates to the standalone legacy bundle. Explicit
--legacy-v1 local installation uses that standalone bundle, not a facade that
requires adjacent package files. The native local installation is unchanged.

The legacy dependency manifest is deliberately retained in this batch for
compatibility. Import isolation does not claim that all V1 packages have been
removed from npm dependency resolution. That packaging policy requires separate
compatibility/release review. No Goal or Loop persistence schema is changed.

## Evidence

- scripts/native-entry-test.mjs: native import isolation plus per-host lazy legacy delegation and error propagation.
- Goal: test/native-entry.test.mjs and the production-only scripts/package-smoke.mjs consumer.
- Loop: scripts/package-native-smoke.mjs and native-v2-ci on Windows and Linux.
- Validation runs must also pass the existing regression suites and an exact OpenCode 2.0.18 real-host canary before committing.

## Known follow-up checks (not claimed resolved)

- Loop README still contains historical experimental-V2 wording; reconcile it against a complete native feature matrix, not a blanket parity assertion.
- Audit default CLI/daemon host selection separately from plugin entry loading.
- Recheck V2 handoff and dedicated-Goal reservation together against both final main heads.
- Retain historical closed-issue evidence; do not equate a closed issue with completion of this entire migration plan.
