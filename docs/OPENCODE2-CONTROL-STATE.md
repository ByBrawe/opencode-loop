# Native Goal/Loop control-state completion boundary

A Goal objective, queued contract or archived state may contain the exact string
configured by another session's Loop --until option. Recursively reading that
string is not evidence that the Loop task has finished.

The shared V1/V2 workspace marker scanner now skips these exact control roots:
.opencode/goals, .opencode/goal-locks, .opencode/goal-handoff-locks,
.opencode/goal-sequences, and .opencode/opencode-loop. Goal's native handoff
lease directory is also excluded from Goal progress by companion commit
16a276bb219a512d9a7d2a4dd8b6883eb76b9b54.

The explicit .opencode/opencode-loop/until.txt completion marker remains
supported, as do ordinary progress.md, project-owned .opencode/commands and
similarly named non-control directories. The exclusion is not a blanket ban
on all .opencode files. There is no state-schema or completion-tool change.

scripts/control-plane-until-test.mjs has six control-state negatives and four
positive compatibility cases. The candidate workflow requires the original
scanner to fail before applying the correction, then runs the full suites,
production tarballs and real native-host checks against the exact Goal companion.
All three distributed Loop bundles must be rebuilt from this shared module.
This audit does not claim a measured live-model performance gain or an npm release.
