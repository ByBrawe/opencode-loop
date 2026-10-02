# OpenCode Loop 0.6.4

OpenCode 2 configuration canonicalization patch, paired with OpenCode Goal 1.3.43.

## One native plugin list

OpenCode 2.0.21's runtime schema uses the plural `plugins` field and its
normalizer accepts the legacy singular `plugin` field for compatibility. Loop
now persists the same normalization during a native V2 install.

For valid legacy entries:

- strings stay strings;
- `[package, options]` tuples become `{ "package": "...", "options": { ... } }`;
- migrated legacy entries retain their order ahead of existing native entries;
- Loop's own registration is de-duplicated and pinned to the exact package version;
- the old `plugin` property is removed when it becomes empty.

Malformed or unrecognized legacy entries are preserved. Loop does not rewrite
unrelated `provider`, `providers`, `model`, or other user configuration.

## Deterministic runtime dependency

The production `@opencode/plugin` dependency is pinned to exact 2.0.18. This
prevents npm dependency drift from silently changing Loop's V2 runtime contract.

## Upgrade

```sh
npx -y @bybrawe/opencode-goal@1.3.43
npx -y @bybrawe/opencode-loop@0.6.4 --loop-only --without-loop-goals
```

Then fully restart OpenCode and verify:

```text
/goal status
/loop-help
/loop-doctor
```

The update preserves Loop project state and user-authored command files.
