$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
$Installer = Join-Path $Root "scripts\install-node.mjs"
$Runtime = Get-Command node -ErrorAction SilentlyContinue
if (-not $Runtime) { $Runtime = Get-Command bun -ErrorAction SilentlyContinue }
if (-not $Runtime) { throw "OpenCode Loop source installation requires Node.js or Bun." }

& $Runtime.Source $Installer
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
