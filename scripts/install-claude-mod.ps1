<#
  Installs the Phile workspace mod for Claude Code, in one step:
    1. builds phile-agent (Phile's Rust core as agent tools), or reuses one Phile's installer already shipped
    2. copies it to %LOCALAPPDATA%\Phile\bin
    3. registers this folder as a Claude Code plugin marketplace and installs the "phile" mod
    4. writes an MCP config snippet so other agent apps (Antigravity, Cursor, Claude Desktop) can use the same tools
  Run again any time to update. -Uninstall removes the mod and the binary.
#>
param([switch]$Uninstall)
$ErrorActionPreference = 'Stop'
$Repo = Split-Path -Parent $PSScriptRoot
$BinDir = Join-Path $env:LOCALAPPDATA 'Phile\bin'
$Exe = Join-Path $BinDir 'phile-agent.exe'

function Step($m) { Write-Host "`n> $m" -ForegroundColor Cyan }
function Done($m) { Write-Host "  ok  $m" -ForegroundColor Green }
function Fail($m) { Write-Host "  !!  $m" -ForegroundColor Red; exit 1 }

$claude = Get-Command claude -ErrorAction SilentlyContinue

if ($Uninstall) {
  Step 'Removing the Phile mod'
  if ($claude) {
    & claude plugin uninstall phile@phile 2>$null | Out-Null
    & claude plugin marketplace remove phile 2>$null | Out-Null
  }
  Remove-Item -Force -ErrorAction SilentlyContinue $Exe
  Done 'Removed. Phile itself is untouched.'
  exit 0
}

Step 'Getting phile-agent (Phile''s file engine for agents)'
New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
$shipped = @(
  (Join-Path $env:LOCALAPPDATA 'Phile\phile-agent.exe'),
  (Join-Path $Repo 'phile-agent.exe')
) | Where-Object { Test-Path $_ } | Select-Object -First 1
$cargo = Get-Command cargo -ErrorAction SilentlyContinue
if ($cargo) {
  Push-Location $Repo
  try { & cargo build --release -p phile-agent; if ($LASTEXITCODE -ne 0) { throw 'cargo build failed' } }
  finally { Pop-Location }
  Copy-Item -Force (Join-Path $Repo 'target\release\phile-agent.exe') $Exe
} elseif ($shipped) {
  Copy-Item -Force $shipped $Exe
} else {
  Fail 'Rust is not installed and no phile-agent.exe was found. Install Phile from the Releases page (it ships phile-agent), or install Rust from https://rustup.rs, then run this again.'
}
$ver = (& $Exe version | ConvertFrom-Json).version
Done "phile-agent $ver at $Exe"

Step 'Installing the mod into Claude Code'
if (-not $claude) {
  Fail 'Claude Code (the "claude" command) was not found. Install it from https://claude.com/claude-code, then run this again.'
}
& claude plugin marketplace add "$Repo" 2>&1 | Out-Host
& claude plugin marketplace update phile 2>&1 | Out-Host
& claude plugin install phile@phile 2>&1 | Out-Host
if ($LASTEXITCODE -ne 0) { & claude plugin update phile@phile 2>&1 | Out-Host }
Done 'Mod installed (it reads from this folder, so a git pull plus /reload-plugins updates it).'

Step 'Writing an MCP config for other agent apps'
$mcp = @{ mcpServers = @{ phile = @{ command = $Exe; args = @('mcp') } } } | ConvertTo-Json -Depth 5
$mcpPath = Join-Path $env:LOCALAPPDATA 'Phile\mcp.json'
Set-Content -Path $mcpPath -Value $mcp -Encoding UTF8
Done "Paste $mcpPath into Antigravity / Cursor / Claude Desktop MCP settings to use Phile there too."

Write-Host "`nAll set. Start Claude Code in any folder and type /ag" -ForegroundColor Green
