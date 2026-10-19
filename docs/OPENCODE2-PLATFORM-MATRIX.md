# OpenCode 2 platform evidence matrix

This is a verification map, **not a claim that every GUI and architecture works**. Use the exact versions printed by each job instead of assuming npm latest is immutable.

| Environment | Automated evidence | Not yet proven |
| --- | --- | --- |
| Ubuntu Linux CLI/native server | Native V2 CI, real moving OpenCode 2 with Loop + separate Goal, stable pinned 2.0.18 host | Desktop GUI |
| Windows hosted x64 CLI/native server | Native V2 CI, bundle/package regression, session/state/lock tests, exFAT-style synthetic coverage | Windows Desktop-connected server and its composer; see [#169](https://github.com/ByBrawe/opencode-loop/issues/169) |
| macOS hosted runner (actual CPU printed by CI) | [macOS V2 Compatibility](../.github/workflows/v2-macos-compatibility.yml): Node/Bun source parity, npm tests, package smoke, latest V2 Loop+Goal real host | macOS Desktop UI; architectures not represented by runner |
| Windows real exFAT volume | Reporter's actual OpenCode 2.0.27 + Loop 0.6.8 + Goal 1.3.49 reproduction passed | Different volumes/versions |
| WSL (Windows + Linux configurations) | Not executed as a WSL integration test | Host/plugin config, filesystem boundary, Desktop connection |
| Windows ARM64 | Not executed on a native ARM64 runner/device | Package installation, native binary, CLI/Desktop |
| Desktop local bundled backend vs remote backend | Read-only two-server command catalog diagnostics and unit tests | Physical Desktop suggestions **and actual command execution** in both backends |

## Minimal real-user reproduction

1. Record the exact OpenCode CLI and Desktop backend versions and each installed Loop/Goal npm package version.
2. Fully exit and restart OpenCode. Verify the **selected project folder**, not just a parent workspace.
3. Run the native /loop-doctor, /loop-status and /goal status commands in the same session/project. Create a bounded one-shot Loop test; confirm admission, completion and persisted state.
4. On Desktop, compare the Desktop-connected server's /api/command catalog with a CLI server for the **same directory**; use [the Windows diagnostic guide](OPENCODE2-DESKTOP-WINDOWS.md).
5. Distinguish: (a) command absent from server, (b) present in server but not UI autocomplete, (c) visible but fails execution. Do not install Markdown shadow commands to make autocomplete appear fixed.
6. For long-running Goals, separately exercise restart/re-arm and active/paused/waiting ownership. Do not run prompt-producing Loop and dedicated Goal concurrently in the same session.

## macOS project paths

On macOS, /var/folders may be a symlink alias of /private/var/folders. Native OpenCode 2 CLI expects PWD to identify the **physical** working directory. Loop's opencode-loopd canonicalizes the V2 PWD; the daemon preserves explicit V1 behavior. Regression checks compare fs.realpath() identities rather than two different spellings of the same folder.

A CI success proves only its recorded runner/host/package versions. A failure is a compatibility finding and must not be suppressed by removing or skipping the test.
