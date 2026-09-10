# Uninstall/Deregister the wildcard-perms PostToolUse hook for Claude Code on Windows.
#
# The counterpart install.ps1 has always shipped without one, so a Windows install had
# no working undo: uninstall.sh filters on the bare hook path, and install.ps1 registers
# `node "<forward-slash path>"` — Windows has no shebang support, and a bare extensionless
# path pops a "How do you want to open this file?" dialog on every hook fire — so the
# filter could never match. Either spelling can be the entry in settings.json on this
# machine, so this matches on the path rather than on the command that wraps it.

$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if ([string]::IsNullOrEmpty($scriptDir)) {
    $scriptDir = Get-Location
}
$hookCmd = Join-Path $scriptDir "bin\wildcard-perms"

$userProfile = [System.Environment]::GetFolderPath("UserProfile")
$settingsDir = Join-Path $userProfile ".claude"
$settingsPath = Join-Path $settingsDir "settings.json"

# One hook path, several spellings: `node "<path>"` or the bare path, backslashes or
# forward slashes, /d/repo (Git Bash) or D:/repo (PowerShell), any casing.
function ConvertTo-HookPath {
    param([object] $Value)

    $text = "$Value".Trim()
    if ($text -match '^node\s+(.+)$') {
        $text = $Matches[1].Trim().Trim('"').Trim("'")
    }
    $text = $text.Replace("\", "/")
    if ($text -match '^/([A-Za-z])/(.*)$') {
        $text = "$($Matches[1]):/$($Matches[2])"
    }
    return $text.TrimEnd("/").ToLowerInvariant()
}

if (-not (Test-Path $settingsPath)) {
    Write-Host "- no $settingsPath, so there is no hook to remove" -ForegroundColor Yellow
    exit 0
}

try {
    $cfg = Get-Content $settingsPath -Raw | ConvertFrom-Json -AsHashtable
} catch {
    Write-Host "[FAIL] $settingsPath could not be parsed - left untouched." -ForegroundColor Red
    exit 1
}

$installed = @()
if ($cfg -is [System.Collections.IDictionary] -and $cfg.ContainsKey("hooks") `
        -and $cfg["hooks"] -is [System.Collections.IDictionary] `
        -and $cfg["hooks"].ContainsKey("PostToolUse")) {
    $installed = @($cfg["hooks"]["PostToolUse"])
}

$target = ConvertTo-HookPath $hookCmd
$kept = @()
$removed = 0
foreach ($entry in $installed) {
    $isOurs = $false
    if ($entry -is [System.Collections.IDictionary] -and $entry.ContainsKey("hooks")) {
        foreach ($h in $entry["hooks"]) {
            if ((ConvertTo-HookPath $h.command) -eq $target) { $isOurs = $true }
        }
    }
    if ($isOurs) { $removed += 1 } else { $kept += $entry }
}

# Report what happened rather than success regardless: another checkout's hook, or a
# hook someone removed by hand, must not read as "removed".
if ($removed -eq 0) {
    Write-Host "- no wildcard-perms hook registered in $settingsPath; nothing removed" -ForegroundColor Yellow
    exit 0
}

if ($kept.Count -gt 0) {
    $cfg["hooks"]["PostToolUse"] = $kept
} else {
    $null = $cfg["hooks"].Remove("PostToolUse")
}
if ($cfg["hooks"].Keys.Count -eq 0) {
    $null = $cfg.Remove("hooks")
}

$cfgJson = ConvertTo-Json $cfg -Depth 100
[System.IO.File]::WriteAllText($settingsPath, $cfgJson + "`n")
Write-Host "[OK] removed $removed wildcard-perms PostToolUse hook(s) from ~/.claude/settings.json" -ForegroundColor Green
Write-Host "Allow-list entries stay as they are - this removes the hook, not your permissions." -ForegroundColor Cyan
