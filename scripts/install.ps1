$ErrorActionPreference = "Stop"

$ConfigDir = if ($env:OPENCODE_CONFIG_DIR) { $env:OPENCODE_CONFIG_DIR } else { Join-Path $env:USERPROFILE ".config\opencode" }
$PluginDir = Join-Path $ConfigDir "plugins"
$CommandDir = Join-Path $ConfigDir "commands"
$Root = Split-Path -Parent $PSScriptRoot

New-Item -ItemType Directory -Force -Path $PluginDir | Out-Null
New-Item -ItemType Directory -Force -Path $CommandDir | Out-Null

$PackageFile = Join-Path $ConfigDir "package.json"
if (Test-Path $PackageFile) {
  try {
    $PackageJson = Get-Content -Raw -Path $PackageFile | ConvertFrom-Json
    if (-not $PackageJson.dependencies) {
      $PackageJson | Add-Member -MemberType NoteProperty -Name dependencies -Value ([pscustomobject]@{})
    }
    if (-not $PackageJson.dependencies.PSObject.Properties["@opencode-ai/plugin"]) {
      $PackageJson.dependencies | Add-Member -MemberType NoteProperty -Name "@opencode-ai/plugin" -Value ">=1.4.0"
      $PackageJson | ConvertTo-Json -Depth 20 | Set-Content -Path $PackageFile -Encoding UTF8
    }
  } catch {
    Write-Warning "Could not update $PackageFile. Add '@opencode-ai/plugin': '>=1.4.0' if OpenCode cannot load the local plugin."
  }
} else {
  '{"dependencies":{"@opencode-ai/plugin":">=1.4.0"}}' | Set-Content -Path $PackageFile -Encoding UTF8
}

Copy-Item -Force (Join-Path $Root "src\index.js") (Join-Path $PluginDir "opencode-loop.ts")
Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path $PluginDir "opencode-loop.js")
Copy-Item -Force (Join-Path $Root "commands\*.md") $CommandDir

Write-Host "Installed OpenCode Loop plugin." -ForegroundColor Green
Write-Host "Plugin:   $PluginDir\opencode-loop.ts"
Write-Host "Commands: $CommandDir\loop*.md"
Write-Host "Restart OpenCode, then run: /loop-help"
