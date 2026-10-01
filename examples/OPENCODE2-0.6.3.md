# OpenCode Loop 0.6.3

OpenCode 2 installer dependency-resolution fix, paired with OpenCode Goal 1.3.42.

## What changed

OpenCode Loop now installs natively as an exact published package registration:

```json
{
  "plugins": [
    "@bybrawe/opencode-loop@0.6.3"
  ]
}
```

The default V2 installer no longer copies a loose global
`~/.config/opencode/plugins/opencode-loop` package directory.

This fixes the reproduced OpenCode 2.0.21 startup failure:

```text
Cannot find package '@opencode/plugin' imported from
.../.config/opencode/plugins/opencode-loop/index.js
```

The V2 entrypoint still uses the official `@opencode/plugin`
`Plugin.define({ id, setup })` contract. The difference is distribution:
OpenCode now resolves the entrypoint and `@opencode/plugin` from the same
published package dependency graph.

## Upgrade behavior

Running the 0.6.3 installer over 0.6.1/0.6.2 automatically:

- adds or pins the exact Loop package in plural `plugins`;
- removes known loose `plugins/opencode-loop`, `opencode-loop.ts` and
  `opencode-loop.js` copies;
- preserves unrelated plugin registrations and object options;
- preserves project state under `.opencode/opencode-loop/`;
- keeps explicit `--legacy-v1` behavior isolated.

## Paired Goal release

Publication remains paired with OpenCode Goal 1.3.42 from immutable source
`1dd58abf1e7c08594c2085883e28acea3dbe0418`.

## Verification

The release gate runs Windows/Linux installer regressions, package smoke tests,
exact-main CI, native V2 CI and the production Goal+Loop host pair before npm
publication.

Install or update:

```sh
npx -y @bybrawe/opencode-goal@1.3.42
npx -y @bybrawe/opencode-loop@0.6.3 --loop-only --without-loop-goals
```

Then fully restart OpenCode and verify:

```text
/goal status
/loop-help
/loop-doctor
```

If OpenCode itself reports that managed service port 49374 is already in use,
that is a host service collision rather than this plugin dependency bug. Stop or
reconfigure the OpenCode service before testing the commands.
