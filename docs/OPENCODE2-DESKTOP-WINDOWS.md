# Windows OpenCode Desktop: native Loop and Goal commands

This guide diagnoses the case where OpenCode 2 terminal TUI lists `/loop` and
`/goal` but **Windows Desktop says no matching item**. It is **not** fixed by
reinstalling the legacy Loop `/loop-goal*` commands or copying `goal.md`.

## Why this distinction matters

OpenCode 2.0.22's Desktop composer populates the slash list from its active
**location server** via `data.location.command.list({ directory: sdk().directory })`.
Both plugins register native server commands using `ctx.command.transform`.
A TUI showing both is evidence of its own host registration, **not proof that
the Desktop window is connected to the same server and directory**.

The Desktop may launch/adopt a bundled-version background service rather than
the `opencode` executable started by PowerShell. Client-side `./tui` plugin
commands and sidebar slots are different: those UI extensions do not currently
have a matching Desktop plugin surface. Native server commands should still
appear **when the Desktop's own location command registry contains them**.

Authoritative upstream references:

- [Desktop composer v2.0.22](https://github.com/anomalyco/opencode/blob/v2.0.22/packages/app/src/composer/model.ts)
- [Desktop background service v2.0.22](https://github.com/anomalyco/opencode/blob/v2.0.22/packages/desktop/src/main/service/background-service.ts)
- [Server command registry v2.0.22](https://github.com/anomalyco/opencode/blob/v2.0.22/packages/core/src/command.ts)
- [Desktop/TUI slash parity issue #49803](https://github.com/anomalyco/opencode/issues/49803)
- [Desktop plugin UI surface request #43132](https://github.com/anomalyco/opencode/issues/43132)

## Diagnostic checklist (Windows)

1. Keep both packages **independently installed**. Verify that the individual
   installer outputs point to the expected global config (normally
   `C:\Users\<account>\.config\opencode\opencode.json`):

   ```powershell
   npx -y @bybrawe/opencode-loop@latest
   npx -y @bybrawe/opencode-goal@latest
   ```

   Loop must not install/update the dedicated Goal package during the Loop command.

2. In PowerShell, confirm the actual CLI version and the two global package
   registrations. Do not publish full config files with tokens or API keys:

   ```powershell
   opencode --version
   Get-Command opencode | Select-Object Source
   $cfg = Join-Path $env:USERPROFILE ".config\opencode"
   Select-String -Path "$cfg\opencode.json","$cfg\opencode.jsonc" -Pattern '@bybrawe/opencode-(loop|goal)' -ErrorAction SilentlyContinue
   ```

3. In Desktop, open **the identical directory** used in the TUI. For example,
   `...\blog-seo\code-repo` is different from opening its parent
   `...\blog-seo` (where `code-repo` appears as a folder). Project-local
   configuration and plugin discovery depend on the selected location.

4. Check the Desktop app's **About/version** and current server/connection
   selection (local, remote, or WSL if offered). A different bundled server,
   remote location or WSL config can have a different plugin registry. A TUI
   running `2.0.22` does **not** establish the Desktop backend version.

5. **Quit Desktop completely** through its application/tray Exit control, then
   reopen the same project. Closing only the window may leave the background
   service in place. Check the Desktop plugin failure/status view if exposed.
   An unrelated auth plugin failing is not evidence that Goal or Loop failed.

6. Type `/loop` and `/goal` separately into the Desktop composer.
   Do **not** submit an unknown slash command to the model as a workaround.

## Interpret the result

| Desktop result | Next investigation |
| --- | --- |
| Neither `/loop` nor `/goal` listed | Desktop server/config/directory/activation, not a missing Markdown bridge |
| Only one listed | That plugin's configured package/version and server activation failures |
| Both listed, execution fails | Desktop command submission and the server command executor |
| TUI sees both but Desktop's `GET /command` for its directory does not | Compare both servers, directory headers and config discovery roots |
| Desktop's `GET /command` contains both but suggestions are empty | Desktop composer sync/cache/UI bug; report to OpenCode upstream |

The OpenCode 2 native canary already asserts that both `loop` and `goal` are
present in one real server registry when both packages are loaded. It does
**not** cover the user's separate Windows Electron window or its connection.
Do not claim a GUI bug is fixed until a genuine Desktop reproduction passes.

**Evidence needed to finish the diagnosis:** Desktop application/backend version,
selected server mode, exact Desktop-opened project path, plugin status, and
whether Desktop itself shows `/loop` and `/goal` after a full quit/reopen.
Redact host credentials and user tokens from logs.
