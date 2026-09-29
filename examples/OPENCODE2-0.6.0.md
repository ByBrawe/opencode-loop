# OpenCode Loop 0.6.0

Native OpenCode 2 release, paired with OpenCode Goal 1.3.39.

## Included behavior

The default installer uses the standalone native V2 entry and preserves plugin
object options. Explicit V1 compatibility remains available. Native prompt
admission, durable execution/compaction boundaries and exclusive Goal ownership
prevent a second continuation owner or aborts caused by synthetic user-role text.

All ten non-Goal presets share schedule parsing, including every/after/in and
delayed one-shot behavior. /loop-init creates only missing project-local progress
files, preserves existing bytes and rejects control-plane and symlink escapes.
Commands resolve their session's actual location rather than a different worktree.

Local scheduled shell work has bounded process-tree cleanup. Plugin teardown and
partial setup attempt all cleanup without hanging on the event subscription.
Goal live/archive/lease/queue state cannot satisfy --until; explicit until.txt and
user-owned project progress files remain valid markers.

Goal 1.3.39 adds the native sidebar, location-bound read-only status RPC, late-result
handoff guards and full-contract three-session checks. Goal IDs, evidence and
cumulative budgets remain durable across session rotation.

## Publication and verification

The release no longer creates a release branch. An explicit main release request
runs Windows/Linux bundle, test and installed-package gates; actual production
Loop and Goal tarballs are exercised together on OpenCode 2.0.18. Normal CI for the
same immutable commit must also pass. Only then does the existing OIDC publisher
publish 0.6.0. Existing npm versions must match their source SHA, not merely version.

Registry latest, gitHead, exports, bins and integrity are checked after publication.
A clean consumer installs both published packages from npm and re-runs native
installation, actual-host commands and the two-turn single-session daemon.
The GitHub tag/release follows those checks in a separate least-privilege job.

## Host capability boundaries

OpenCode 2.0.18 is the exact native integration baseline. Its published plugin
context does not expose session.compact, so scheduled /loop-compact is rejected
before durable job creation rather than silently ignored. Automatic compaction is
host-owned. Legacy Loop Goal records are preserved, not silently converted into
dedicated Goal contracts. Real-model cost and long-duration reliability are not
claimed by deterministic local-provider canaries.

Install the published pair after successful registry verification:

```sh
npx -y @bybrawe/opencode-loop@0.6.0 --with-goals --without-loop-goals
```

Fully restart OpenCode after installation. Existing project state is preserved.
