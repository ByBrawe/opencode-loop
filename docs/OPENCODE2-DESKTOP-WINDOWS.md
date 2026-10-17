# Windows OpenCode Desktop: native Loop and Goal commands

This guide diagnoses the case where OpenCode 2 terminal TUI lists `/loop` and
`/goal` but **Windows Desktop says no matching item**. It is **not** fixed by
reinstalling the legacy Loop `/loop-goal*` commands or copying `goal.md`.

## Why this distinction matters

OpenCode 2.0.29's Desktop composer populates the slash list from its active
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

- [Desktop composer v2.0.29](https://github.com/anomalyco/opencode/blob/v2.0.29/packages/app/src/composer/model.ts)
- [Reactive client command refresh v2.0.29](https://github.com/anomalyco/opencode/blob/v2.0.29/packages/client/src/solid/data.ts)
- [Desktop server sync v2.0.29](https://github.com/anomalyco/opencode/blob/v2.0.29/packages/app/src/runtime/server/sync.tsx)
- [Native server command registry v2.0.29](https://github.com/anomalyco/opencode/blob/v2.0.29/packages/core/src/command.ts)
- [GUI extension root v2.0.29](https://github.com/anomalyco/opencode/blob/v2.0.29/packages/app/src/runtime/extension/root.tsx)
- [Desktop/TUI slash parity issue #49803](https://github.com/anomalyco/opencode/issues/49803)
- [Desktop plugin UI surface request #43132](https://github.com/anomalyco/opencode/issues/43132)

## Read-only local command-registry probe

On Loop versions that include `--desktop-diagnostics`, run this in PowerShell
(while Desktop is open, from the **same directory** shown in Desktop):

```powershell
npx -y @bybrawe/opencode-loop@latest --desktop-diagnostics --workspace (Get-Location).Path
```

The command does **not** reinstall either plugin. Its output also compares
the safe live version from `/api/info` with the local `service.json` version;
a mismatch flags stale registration or a different process, **not proof of the
Desktop-connected server's version**. It scans only the presence of
package references in known global config files (not the secrets), and probes the
locally registered OpenCode service at `~/.local/state/opencode/service.json`,
without disclosing its password or full response. It refuses a non-loopback
service URL; remote or WSL Desktop connections must be checked from their own
environment. To probe another **local** endpoint explicitly:

```powershell
npx -y @bybrawe/opencode-loop@latest --desktop-diagnostics --server http://127.0.0.1:4096 --workspace (Get-Location).Path
```

To compare the terminal project with the **parent directory opened in Desktop**
(using the same local server and no installs):

```powershell
npx -y @bybrawe/opencode-loop@latest --desktop-diagnostics --workspace (Get-Location).Path --compare-workspace (Split-Path (Get-Location).Path -Parent)
```

A comparison showing `/loop: true /goal: true` in the child but both false
in the Desktop directory proves that this server publishes different command
catalogs for the two locations. It does not by itself establish that Desktop is
connected to the same server. Do not move or rewrite global plugin config
based solely on this comparison.

Use `OPENCODE_PASSWORD` in the environment if that explicit local server needs
authentication. Do not paste the server registration file, password, full config
or auth headers into issues or chat. The auto-discovered service may still be a
different server than the Desktop window's selected remote; the result is
diagnostic evidence, not proof of a GUI bug.


## Compare an explicit second local backend (main-only diagnostic)

On OpenCode 2.0.30 Windows, the background service uses port `45278`
**by default** ([upstream #55547](https://github.com/anomalyco/opencode/pull/55547)).
That port is a **candidate**, not proof of which host the Desktop window chose.
The `main` branch diagnostic now supports a second read-only localhost
backend comparison, using the *same requested workspace* for both catalogs:

```powershell
# Run the local Loop repository's main-branch script, not npm 0.6.8.
node scripts/install-with-goals.mjs --desktop-diagnostics --workspace (Get-Location).Path --compare-server http://127.0.0.1:45278 --json
```

Use this command only from a checkout of `ByBrawe/opencode-loop`. Once the
feature is published, the installed `opencode-loop --desktop-diagnostics`
entry may be used instead. The published `0.6.8` installer does **not**
implement `--compare-server`.

The primary probe uses the existing local `service.json` registration; the
second URL is **always explicit and restricted to loopback**. The registered
service password is **never forwarded to a different endpoint**. For an
authenticated explicit second host, set `OPENCODE_PASSWORD` only in your own
PowerShell environment; do not post its value or response headers. Redirects
are refused, even when the destination is localhost.

A result such as `primary /loop: true /goal: true` and
`compared /loop: false /goal: false` proves that those two local **servers**
publish different command catalogs for the **same selected directory**.
It still does **not** prove the Desktop window uses the second URL: confirm
Desktop's local/remote/WSL connection first. Missing registration credentials,
a 401 response, an unloaded plugin, or another directory can also produce a
different result. No prompt is submitted and neither installer runs.

OpenCode 2.0.30 also includes [#55710](https://github.com/anomalyco/opencode/pull/55710),
which opens PowerShell in the chosen project directory on Windows. This
reduces the chance of comparing `blog-seo` with `blog-seo/code-repo`,
but does **not** implement third-party GUI TUI slots or automatically fix
missing native slash commands.

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


## Verified OpenCode V2.0.29 command-refresh contract (2026-10-15)

A source-level audit of **tag v2.0.29** corrects the older 2.0.22 hypothesis
below: `packages/client/src/solid/data.ts` **already handles location-scoped
`command.updated`** events by invalidating and re-fetching
`data.location.command`. The Desktop composer in `packages/app/src/composer/model.ts`
consumes precisely that reactive catalog. The app's
`packages/app/src/runtime/server/sync.tsx` does **not** separately queue
`command.updated`, but that is **not by itself evidence of a cache bug**.
Adding another unconditional refresh could duplicate requests.

The source still ignores **locationless** `command.updated` in the client
data-layer path, but the native location-owned command service publishes
updates through its location bus. We have **no captured Desktop event trace**
proving that missing location is occurring in this incident. The old
`ByBrawe/opencode` fork patch `0d7e938` is an unmerged investigative
candidate, **not** a verified fix; do not apply it based solely on the absence
of an event handler in `server/sync.tsx`.

There is now a built-in GUI extension host in V2, but its
`runtime/extension/root.tsx` explicitly loads **built-in renderer definitions
only** as of v2.0.29; third-party `.ocdx` GUI renderers are not shipped yet.
Do **not** assume a package's `./tui` sidebar runs in Desktop. Conversely,
Loop and Goal register **server-owned commands** using
`ctx.command.transform`; the Desktop should list them if the **actual
Desktop-connected** server's `GET /api/command` for its selected directory
contains them. These are distinct capabilities.

The practical branch point remains:

1. If the Desktop-connected `GET /api/command` lacks either command, compare
   its project directory, actual backend version, and plugin activation with
   the TUI. A local-service probe alone cannot identify a remote, WSL, or
   Desktop-private sidecar server.
2. If that **same** Desktop-connected endpoint lists both commands while the
   Desktop composer does not, capture a redacted GUI sync repro and file it
   upstream. Do not submit blind duplicate command-refresh patches or install
   fake Markdown command templates that would mask native execution.
3. OpenCode dev merged [#55710](https://github.com/anomalyco/opencode/pull/55710)
   on 15 October to launch **Open in → PowerShell** in the actual project folder.
   This commit is **not part of v2.0.29** and does **not** itself repair slash
   suggestions. Until a subsequent release contains it, open the exact
   `code-repo` directory manually in PowerShell/Desktop.

**Scope:** This is source and automated native host evidence, not a confirmed
reproduction of the user's Windows Desktop window. Neither an OpenCode 2
upgrade nor this diagnostic should be reported as a verified GUI fix without
that exact app/backend/connection test.
