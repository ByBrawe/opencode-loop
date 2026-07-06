$ErrorActionPreference = "Stop"

$ConfigDir = if ($env:OPENCODE_CONFIG_DIR) { $env:OPENCODE_CONFIG_DIR } else { Join-Path $env:USERPROFILE ".config\opencode" }
$PluginDir = Join-Path $ConfigDir "plugins"
$CommandDir = Join-Path $ConfigDir "commands"
$Root = Split-Path -Parent $PSScriptRoot

New-Item -ItemType Directory -Force -Path $PluginDir | Out-Null
New-Item -ItemType Directory -Force -Path $CommandDir | Out-Null

Copy-Item -Force (Join-Path $Root "src\index.js") (Join-Path $PluginDir "opencode-loop.ts")
Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path $PluginDir "opencode-loop.js")
Copy-Item -Force (Join-Path $Root "commands\*.md") $CommandDir

Write-Host "Installed OpenCode Loop plugin." -ForegroundColor Green
Write-Host "Plugin:   $PluginDir\opencode-loop.ts"
Write-Host "Commands: $CommandDir\loop*.md"
Write-Host "Restart OpenCode, then run: /loop-help"
