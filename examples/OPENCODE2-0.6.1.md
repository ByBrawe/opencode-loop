# OpenCode Loop 0.6.1

Official OpenCode 2 plugin-definition release, paired with OpenCode Goal 1.3.40.

## V2 package and local entrypoints

The npm root/server entry and the explicit `./v2` entry now use
`@opencode/plugin` `Plugin.define({ id, setup })`. V1 `server()` compatibility
remains a separate implementation rather than an adapter that translates V1 hooks.

A native local install uses the same contract. It creates
`plugins/opencode-loop/index.js` as the real V2 entrypoint and keeps the generated
single-file runtime beside it as `native.js`, where it is a support module rather
than a second auto-discovered plugin. Upgrades remove the old root
`opencode-loop.ts`/JS copies; explicit `--legacy-v1` still installs the V1 path.

## Runtime and packaging

`@opencode/plugin@^2.0.18` is a production dependency and its required runtime
peer closure is locked for reproducible npm installs. Clean Windows package smoke
keeps all previous assertions but permits six minutes for the larger V2 dependency
graph to install.

The native prompt, command, scheduling, session-location, process-tree, Goal
ownership, compaction-safety and `--until` control-state protections from 0.6.0
remain unchanged.

## Paired Goal release

Goal 1.3.40 defines its server, native-only and TUI entries with the official V2
plugin APIs while preserving separate V1 compatibility. Loop publication is pinned
to Goal's immutable 1.3.40 source and refuses publication until that exact package
is visible on npm.

## Publication and verification

The main-only OIDC publisher requires Windows/Linux installed-package gates plus
normal exact-main CI and Native V2 CI. It builds the declared Goal source, installs
the actual Loop and Goal tarballs together, and exercises them on OpenCode 2.0.18.

After publication, registry latest, gitHead, exports, bins and integrity are checked.
A fresh npm consumer then installs Loop 0.6.1 and Goal 1.3.40 and re-runs joint
installation/options/uninstall, real native commands and the two-turn
single-session daemon before the GitHub v0.6.1 tag/release is created.

## Capability boundary

OpenCode 2.0.18's published plugin context still does not expose
`session.compact`; scheduled `/loop-compact` therefore rejects before durable job
creation while automatic compaction stays host-owned. Controlled-provider canaries
are functional verification, not live-model cost or endurance measurements.

Install the verified pair after registry publication:

```sh
npx -y @bybrawe/opencode-goal@1.3.40
npx -y @bybrawe/opencode-loop@0.6.1 --loop-only --without-loop-goals
```

Fully restart OpenCode after installation. Existing project state is preserved.
