# OpenCode Loop 0.6.7

OpenCode 2 native reliability and package parity patch, tested alongside **separately installed** OpenCode Goal 1.3.48.

## Changes

- Protect per-session Loop state across multiple OpenCode processes with file locks, fail-closed corrupt-file reads, crash/dead-owner lock recovery and atomic writes on Windows/Linux.
- Restore manual native compaction with the public OpenCode 2 `session.compact` capability, requiring its exact manual compaction input ID, completion and terminal. Reject unsupported hosts without corrupting scheduled work.
- Provide read-only Windows Desktop native `/loop` and `/goal` command-catalog diagnostics and explicit project-directory comparisons. This is **not** a claim that Windows Desktop GUI autocomplete is fixed upstream.
- Bound Loop+Goal Windows cold-server startup probes and separate unresponsive host bootstrap from real Loop/Goal ownership conflicts.
- Align native `/loop-help` with the current V2 compaction contract.

## Install independently

```powershell
npx -y @bybrawe/opencode-loop@0.6.7
npx -y @bybrawe/opencode-goal@1.3.48
```

A normal Loop install touches Loop only; it never installs or updates the dedicated Goal package. Legacy `/loop-goal*` commands stay opt-in, and existing state is preserved.

## Verification

When npm confirms publication, fully restart OpenCode and run `/loop-help`, `/loop-doctor`, `/goal status` in terminal TUI. For Windows Desktop use the [read-only diagnostic](../docs/OPENCODE2-DESKTOP-WINDOWS.md) without adding Markdown slash-command bridges.

Required release gates: immutable Goal source, Windows/Ubuntu package regressions, exact-main CI, installed-pair real host and clean npm consumer checks. GitHub tag and release creation require separate repository authorization, which may fail independently of verified npm publication.
