# Native OpenCode 2 installation and CLI migration

This describes source/main changes, not a new npm release. The joint migration
plan in OPENCODE2-MIGRATION.md still has runtime, parity and release audit work.

## Goal installer

Installation defaults to the native `plugins` configuration and the plugin's
native `/goal` command. No OpenCode executable is launched to guess a dialect
from PATH. This also works before the host has been installed.

- `opencode-goal --native-v2` explicitly selects V2.
- `opencode-goal --legacy-v1` explicitly selects the V1 configuration and its
  managed `commands/goal.md` bridge.
- An explicit mode wins over `OPENCODE_GOAL_HOST_VERSION`. The environment
  variable remains an explicit target-dialect hint for older companion
  installers; it is not evidence of an installed host version. Invalid or
  unsupported values fail before install/update writes.
- Help, version, uninstall and invalid-option handling do not probe the host.

Updating a Goal package pin preserves native object options, including `false`,
nested values and additional registration fields. Conflicting object
registrations are rejected rather than silently selecting one. Multi-config
updates stage every candidate before changing the originals. Explicit uninstall
can still remove conflicting registrations without choosing their options.
User-owned `goal.md` remains unchanged in native mode. The V1
`[package, options]` tuple is converted to `{ package, options }` for V2 in
both installers; an explicit V1 update preserves the tuple. Malformed owned
tuples and conflicting duplicate options fail before writes. Unrelated
plugin registrations are not converted.

## Combined installation

Loop supplies its chosen dialect to the Goal companion, including when an older
Goal package is still the published latest version. A native Loop install cannot
accidentally select a V1 Goal bridge because an old binary appears first on PATH.
`--legacy-v1 --with-goals` selects V1 for both installers.

Loop's `--without-loop-goals` cleanup removes packaged/recognized bridge files,
not arbitrary user-authored files with the same names. Loop uninstall leaves the
Goal companion and project Goal state intact.

## Native Loop daemon

The daemon selects `OPENCODE_BIN` (alias `OPENCODE_BINARY`) explicitly, or probes
`opencode` then `opencode2` for a 2.x version. V1 requires `--legacy-v1`. An explicit
binary cannot silently fall back to a different installation.

The native CLI still supports `run` and `session list`. The adapter passes
`--server` consistently to both operations, filters automatic session selection
to the current directory/worktree, rejects malformed session output, and pins
subsequent iterations to the same session. A `--` separator keeps prompt text
from becoming CLI options. No permission auto-approval flags are added.

A V2 CLI client failure or timeout stops automatic replay. The native server may
still own the admitted execution after its client exits; inspect that session
before restarting the daemon. Legacy retry behavior stays on the explicit V1
path. Pulse-check never dispatches work; unavailable CLI telemetry is reported
and it can fall back to persisted Goal timestamps.

## Regression coverage

Goal's `test/installer-native-mode.test.mjs` covers default/explicit modes,
invalid targets, option preservation, custom commands and conflicting
multi-config updates. Loop's `scripts/native-cli-test.mjs` is included in the
existing daemon test suite. The joint installer test executes both actual
installers through a local npm test driver without network package resolution.
The native CI adds an exact OpenCode 2.0.18 daemon canary with a deterministic
local provider: two turns, one newly created and pinned native session.

The real-host CLI canary and production tarball gates run in CI. Their job
results, rather than the existence of the tests, establish compatibility.

## Official references

Read the V2 pages, not the legacy `/docs/plugins` examples. These references
are a migration contract, not proof that every phase in this repository is done.

- [V1 plugin migration](https://opencode.ai/v2/docs/build/plugins/migrate-v1):
  entrypoints, hooks, tools, lifecycle and package exports.
- [V2 plugin API](https://opencode.ai/v2/docs/build/plugins): synchronous,
  replayable transforms; prompt admission; native hooks; events and cleanup.
- [General migration](https://opencode.ai/v2/docs/migrate-v1): keep supported
  configuration and project files; native V2 configuration is optional.
- [Plugin configuration and management](https://opencode.ai/v2/docs/plugins):
  native registrations, CLI plugin management and reload behavior.
- [Pinned 2.0.18 CLI contract](https://github.com/anomalyco/opencode/blob/v2.0.18/packages/cli/src/commands/commands.ts)
  and [session list projection](https://github.com/anomalyco/opencode/blob/v2.0.18/packages/cli/src/commands/handlers/session/list.ts):
  `run`, `session list`, `--server`, and worktree-aware session filtering.

The official guide says V1 and V2 now share the `opencode` command. Do not infer
an API generation from a filename; the daemon probes the selected executable.
Documentation/search caches can show earlier beta examples. Validate API fields
against the exact host tag and a real-host canary before adopting them.
