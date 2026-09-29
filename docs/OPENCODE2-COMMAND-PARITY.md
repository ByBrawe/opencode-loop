# Native command parity audit

The native plugin now registers all ten non-Goal V1 presets through the same
`presetDefaults`, `normalizeLoopScheduleArgs` and `parseLoopArgs` used by V1. This avoids reconstructing flags
from a guessed first duration token and preserves each preset's name, kind,
safety flags, default action, verification command and first-run timing.

| Preset | Shared default behavior |
| --- | --- |
| loop-dev | Project development, progress.md and no-question guidance |
| loop-testfix | Test/fix prompt, safety guidance and npm test verification |
| loop-progress | Safe progress.md continuation |
| loop-safe-dev | Safe bounded batches and checkpoint guidance |
| loop-prompt | Immediate prompt, subject to explicit schedule flags |
| loop-ask | Deferred question/check prompt |
| loop-command, loop-cmd | Deferred native slash command |
| loop-shell | Deferred bounded local/native shell command |
| loop-compact | Deferred 200-minute compaction preset, only when the host exposes session.compact |

Explicit every/after schedules and --now/--no-now still go through the shared
parser. A zero-delay deferred preset gets an idle-safe timer after the local
command returns; it does not require an unrelated model turn to start.
Unsupported compaction or overlap is rejected before durable job creation.
OpenCode 2.0.18 does not expose session.compact in its published plugin context,
so registering the preset is not a claim that this host can execute it.

`/loop-init [path]` is now a native direct command. It shares the V1 progress
file template, creates only a missing project-local file with exclusive create,
requires existing parent directories and preserves existing bytes. Parent
symlink/junction escapes and .git/.opencode control-plane targets are rejected.
Its acknowledgement uses resume:false and cannot start a model or Loop job.
This path check is not a sandbox against concurrent hostile filesystem changes.
V1 initialization behavior itself is unchanged; only the template is extracted.

Evidence: scripts/native-presets-test.mjs checks parser parity for all presets,
leading flags/no duration, first-run wake, unsupported capabilities, native
initialization, concurrent creation, byte preservation and path boundaries.
The real 2.0.18 joint-host canary requires every preset in the actual registry,
executes nine deferred presets, verifies native progress initialization and
preservation, and checks that this work makes no additional Loop model calls.

This closes the command-registration gap, not every remaining migration phase.
Legacy loop-goal commands remain intentionally separate from the dedicated
native Goal plugin. Full policy/handoff/release acceptance remains tracked in
OPENCODE2-MIGRATION.md. No package version or persistence schema is changed.

## Real-host schedule regression

The first candidate's real-host canary caught a missing normalization layer:
`every 1h` was being retained as task text and the preset stayed at zero delay.
The corrected native path uses the V1 schedule normalizer before the low-level
flag parser. Plain prompts and idle/every/after/in work; explicit after/in
remain delayed one-shot even with --now or conflicting --max-runs values.
Invalid durations fail before job creation. Native Goal ownership remains
non-overridable, so --allow-goal-overlap is explicitly rejected.

The testfix command adjustment is now one pure helper shared with V1. A custom
command updates both the verification command and the test-fixing instruction;
a custom --verify with the default instruction updates that instruction too.
Additional independent schedule expectations ensure the test oracle cannot
hide a broken lower-level parser behind comparison with itself.
