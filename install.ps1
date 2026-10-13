# Registers the InDesign MCP server with Claude Code (user scope) and Codex.
# Usage: powershell -ExecutionPolicy Bypass -File install.ps1 [-NoCodex] [-NoClaude]
param([switch]$NoCodex, [switch]$NoClaude)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$py = (Get-Command python -ErrorAction Stop).Source
if ($py -like '*WindowsApps*') { throw 'python resolves to the Microsoft Store stub; install Python 3.9+ from python.org.' }
$entry = Join-Path $root 'run_server.py'

if (-not $NoClaude -and (Get-Command claude -ErrorAction SilentlyContinue)) {
    $ErrorActionPreference = 'Continue'
    cmd /c "claude mcp remove -s user indesign >nul 2>&1"
    claude mcp add -s user indesign -- $py $entry
    $ErrorActionPreference = 'Stop'
    Write-Host 'Claude Code: registered "indesign" (user scope).'
}

if (-not $NoCodex) {
    $cfg = Join-Path $env:USERPROFILE '.codex\config.toml'
    if (Test-Path $cfg) {
        $text = Get-Content $cfg -Raw
        Copy-Item $cfg "$cfg.bak-indesign-$(Get-Date -Format yyyyMMddHHmmss)"
        $block = @"
[mcp_servers.indesign]
# Managed by InDesign MCP install.ps1
command = '$py'
args = ['$entry']
startup_timeout_sec = 20.0
tool_timeout_sec = 300.0
"@
        $pattern = '(?ms)^\[mcp_servers\.indesign\]\r?\n.*?(?=^\[|\z)'
        if ($text -match $pattern) { $text = [regex]::Replace($text, $pattern, ($block + "`r`n`r`n")) }
        else { $text = $text.TrimEnd() + "`r`n`r`n" + $block + "`r`n" }
        [IO.File]::WriteAllText($cfg, $text, (New-Object Text.UTF8Encoding $false))
        Write-Host "Codex: registered [mcp_servers.indesign] in $cfg (backup saved)."
    }
}
