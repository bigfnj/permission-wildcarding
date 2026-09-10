# Install/Register wildcard-perms PostToolUse hook for Claude Code on Windows.

$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if ([string]::IsNullOrEmpty($scriptDir)) {
    $scriptDir = Get-Location
}
$hookCmd = Join-Path $scriptDir "bin\wildcard-perms"
# Use forward slashes for JSON path strings to make it extremely safe across environments
$hookCmdNormalized = $hookCmd.Replace("\", "/")
# Windows has no shebang support, so the extensionless Node script must be invoked
# via `node "<path>"`. Registering the bare path makes Windows show a
# "How do you want to open this file?" dialog on every hook fire.
$hookCommand = 'node "' + $hookCmdNormalized + '"'

$userProfile = [System.Environment]::GetFolderPath("UserProfile")
$settingsDir = Join-Path $userProfile ".claude"
$settingsPath = Join-Path $settingsDir "settings.json"

if (-not (Test-Path $settingsDir)) {
    # -Path, not -Value: New-Item -ItemType Directory takes the location as
    # -Path, so this silently did not create ~/.claude on a fresh machine —
    # the exact case the Test-Path guard above exists for.
    $null = New-Item -Path $settingsDir -ItemType Directory -Force
}

$cfg = @{}
if (Test-Path $settingsPath) {
    try {
        $cfg = Get-Content $settingsPath -Raw | ConvertFrom-Json -AsHashtable
    } catch {
        Write-Warning "Existing settings.json could not be parsed; starting with empty/new config."
    }
}

if (-not $cfg.ContainsKey("hooks")) {
    $cfg["hooks"] = @{}
}
if (-not $cfg["hooks"].ContainsKey("PostToolUse")) {
    $cfg["hooks"]["PostToolUse"] = @()
}

$already = $false
foreach ($entry in $cfg["hooks"]["PostToolUse"]) {
    if ($entry.ContainsKey("hooks")) {
        foreach ($h in $entry["hooks"]) {
            if ($h.command -eq $hookCommand -or $h.command -eq $hookCmdNormalized -or $h.command -eq $hookCmd) {
                $already = $true
                break
            }
        }
    }
}

if (-not $already) {
    # Add new PostToolUse entry
    $newHook = @{
        matcher = "Bash|PowerShell"
        hooks = @(
            @{
                type = "command"
                command = $hookCommand
            }
        )
    }
    $cfg["hooks"]["PostToolUse"] += $newHook
    $cfgJson = ConvertTo-Json $cfg -Depth 100
    [System.IO.File]::WriteAllText($settingsPath, $cfgJson + "`n")
    Write-Host "[OK] wildcard-perms registered as PostToolUse hook in ~/.claude/settings.json" -ForegroundColor Green
} else {
    Write-Host "[OK] wildcard-perms already registered as PostToolUse hook" -ForegroundColor Green
}

# Seed starter pack
$packPath = Join-Path $scriptDir "patterns\starter-pack.json"
if (Test-Path $packPath) {
    try {
        $pack = Get-Content $packPath -Raw | ConvertFrom-Json
        Write-Host "Starter pack: $scriptDir\patterns\starter-pack.md"
        Write-Host "Contains $($pack.Count) curated safely generalized permissions."
        
        $answer = Read-Host "Seed your allow list from the starter pack? (y/N)"
        if ($answer -match "^[Yy]([Ee][Ss])?$") {
            node "$hookCmd" --seed
        } else {
            Write-Host "Skipped seed - run manually at any time." -ForegroundColor Yellow
        }
    } catch {
        Write-Host "Starter pack check skipped"
    }
}

Write-Host "Done. Restart your Claude Code session to apply the hook." -ForegroundColor Cyan
