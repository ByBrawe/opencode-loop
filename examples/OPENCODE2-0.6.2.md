# OpenCode Loop 0.6.2

OpenCode 2 migration-guide conformance release, paired with OpenCode Goal 1.3.42.

## Public V2 plugin context

The native runtime treats `ctx.location.directory` as the only plugin-instance
project location. `ctx.options` remains plugin configuration and is not accepted as
a project-directory fallback.

Per-session scope is verified through public `session.get` location data, so a
session from another worktree/project cannot borrow this plugin instance's state.

## V2 plugin and installation contract

The npm root/server and explicit `./v2` entries use
`@opencode/plugin` `Plugin.define({ id, setup })`. Native installs use plural
`plugins` configuration and the V2 plugins layout. Explicit `--legacy-v1` remains
a separate compatibility path; V1 hooks and SDK request shapes are not the default
V2 runtime.

Native prompt/compaction hooks, command transforms and the event subscription are
registered through V2 domains and disposed on unload. The event stream is cancelled
with an abort signal before local resources and registrations are drained.

## Capability boundary

Loop does not probe undocumented `session.shell`, `session.compact` or
`session.inbox` properties. Scheduled shell execution is a bounded Loop-managed
local process. Manual scheduled compaction remains unsupported on the OpenCode
2.0.18 public plugin contract and is rejected before durable job creation; automatic
compaction remains host-owned.

## Paired Goal release

Publication is pinned to OpenCode Goal 1.3.42 from immutable source
`7a952fc4c3ae51baad8e633db27ecf84cbdc1559` and refuses to continue until that
exact package is visible on npm.

## Verification

The publisher requires Windows/Linux native regressions, exact-main CI and Native V2
CI, production tarball installation, joint Goal+Loop installation/options/uninstall,
real native commands and the two-turn single-session daemon on OpenCode 2.0.18.

Install the verified pair after registry publication:

```sh
npx -y @bybrawe/opencode-goal@1.3.42
npx -y @bybrawe/opencode-loop@0.6.2 --loop-only --without-loop-goals
```

Fully restart OpenCode after installation. Existing project Goal/Loop state and
user-owned files are preserved.
