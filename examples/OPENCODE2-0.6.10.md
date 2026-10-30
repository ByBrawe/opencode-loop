# OpenCode Loop 0.6.10 — standalone native OpenCode 2 release

Released after exact-main CI and registry verification only. Source merge or a passing PR is **not** proof that npm publication completed.

## What's new
- **Independent Loop**: `npx -y @bybrawe/opencode-loop@0.6.10` installs Loop only, and `--uninstall` unregisters Loop only. `--with-goals` and `--with-loop-goals` now return an error before changing config. The separate `@bybrawe/opencode-goal` package is not installed, updated or removed by Loop.
- **Native OpenCode Goal 2.2.x safety**: when a built-in `/goal` is active or paused, Loop uses the host's public, read-only `opencode.goal` RPC to defer autonomous Loop admission in that session. Unknown states fail closed. The previous ByBrawe Goal's on-disk guard remains for installed clients; old files do not reserve sessions after that package is confirmed absent. These checks mitigate overlap but do not constitute an atomic scheduling guarantee; use separate sessions for separate autonomous jobs.
- **Native read-only TUI sidebar**: status RPC, session switching, safe read-only status rendering. Thanks to **[@zhek](https://github.com/zhek)** for the original [#165](https://github.com/ByBrawe/opencode-loop/pull/165) contribution, integrated as [#190](https://github.com/ByBrawe/opencode-loop/pull/190).
- **Cleaner installation**: explicit `OPENCODE_CONFIG` override recognized on removal; JSONC user comments and unrelated plugins preserved; dropped unnecessary V1-SDK npm peer to prevent clean consumer resolver conflicts.

## Install or remove

```powershell
npx -y @bybrawe/opencode-loop@0.6.10
# Later, if desired:
npx -y @bybrawe/opencode-loop@0.6.10 --uninstall
```

Quit and reopen the OpenCode backend, then check `/loop-doctor` and `/loop-status` in the same project/workspace. If an explicit config is used, set `OPENCODE_CONFIG` or `OPENCODE_CONFIG_DIR` accordingly when removing. Project history under `.opencode/opencode-loop` is preserved.

OpenCode 2.2.x has a built-in `/goal`; seeing it after uninstalling our third-party Goal is expected and does not mean the removed package is still present.

## Explicit limitations
- The Loop TUI sidebar has OpenTUI 0.5.14/0.7.0 render tests, but **remote/split-cache CLI auto-discovery** is still tracked upstream and in [#191](https://github.com/ByBrawe/opencode-loop/issues/191). Its absence must never stop the scheduler.
- Windows Desktop/Web GUI native slash-command discovery is **not proven** ([#169](https://github.com/ByBrawe/opencode-loop/issues/169)); the OpenTUI renderer is not the Desktop GUI.
- Multi-agent Goal/Loop scheduling is not atomic across independent plugins; avoid running both autonomous engines in the same session.
- Historical `v0.6.6` tag permission issue [#168](https://github.com/ByBrawe/opencode-loop/issues/168) is separate release bookkeeping and is not silently claimed fixed.
- Publication must pass strict clean npm consumer, package manifest, source-to-Bun-bundle parity, Windows/Linux/macOS host test and immutable npm registry identity gates.
