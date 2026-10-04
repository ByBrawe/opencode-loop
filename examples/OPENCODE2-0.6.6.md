# OpenCode Loop 0.6.6

Loop-only installation contract patch, paired for coexistence validation with OpenCode Goal 1.3.47.

## Default installation

A normal Loop install/update now touches **Loop only**:

```sh
npx -y @bybrawe/opencode-loop@0.6.6
```

It does not install, detect, refresh, migrate, or modify the dedicated OpenCode Goal package. Loop's older experimental `/loop-goal*` command files are omitted by default.

For durable outcome-driven work, install Goal independently:

```sh
npx -y @bybrawe/opencode-goal@1.3.47
```

Or explicitly opt into a combined install:

```sh
npx -y @bybrawe/opencode-loop@0.6.6 --with-goals
```

Legacy experimental Loop Goal commands remain available only when explicitly requested:

```sh
npx -y @bybrawe/opencode-loop@0.6.6 --with-loop-goals
```

## Validation contract

The release remains gated by Ubuntu/Windows regressions, production package smoke, the real OpenCode 2 adapter, exact OpenCode 2.0.18 compatibility, current-host coexistence, and immutable Goal companion source verification.

After installation, fully restart OpenCode and verify:

```text
/loop-help
/loop-doctor
```

If Goal is installed too:

```text
/goal status
```
