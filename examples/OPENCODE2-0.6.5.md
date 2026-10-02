# OpenCode Loop 0.6.5

OpenCode 2.0.22 SDK-contract patch, paired with OpenCode Goal 1.3.44.

## OpenCode 2.0.22 runtime contract

Loop's production `@opencode/plugin` dependency is pinned to exact 2.0.22. The
lockfile carries the matching `@opencode/{ai,client,protocol,schema,util}` runtime
closure so clean installs and release builds use the same native contract.

The moving real-host gate loads Loop main and the Goal companion together on
OpenCode 2.0.22. The exact OpenCode 2.0.18 native pair remains in CI as a
backwards-compatibility contract rather than being replaced by the current-host
check.

## Validation

The release candidate is gated by:

- Ubuntu and Windows native bundle/regression/package-smoke jobs;
- the real OpenCode 2 adapter;
- exact OpenCode 2.0.18 Loop+Goal coexistence;
- latest OpenCode 2.0.22 Loop+Goal coexistence;
- OpenCode 1 peer-compatibility tests.

## Upgrade

```sh
npx -y @bybrawe/opencode-goal@1.3.44
npx -y @bybrawe/opencode-loop@0.6.5 --loop-only --without-loop-goals
```

Then fully restart OpenCode and verify:

```text
/goal status
/loop-help
/loop-doctor
```

Loop state, installer canonicalization, V1 compatibility, and the host-owned
automatic compaction boundary are unchanged by this SDK patch.
