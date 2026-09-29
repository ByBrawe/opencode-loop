# Native session location safety

Native commands, including loop-init, verify the session through
session.get before reading/writing the plugin instance's project files.
A missing session, a different session ID, a different directory or
workspace, and a failed lookup are rejected without guessing a path.
The public event bridge and prompt/compaction hooks ignore foreign
locations. Queued commands and timer work recheck native location;
rejected scope clears timers without rewriting the old job snapshot.
Session-deleted events may retire in-memory state without a lookup.

The native plugin regression reproduced the original wrong-directory
loop-init write before applying this patch. Permanent tests cover that
rejection, valid local behavior, unavailable identity and queued work.
This does not authorize executing foreign worktrees from this instance,
or claim arbitrary concurrent filesystem moves are transactionally locked.

Official contract: https://opencode.ai/v2/docs/build/plugins/migrate-v1
