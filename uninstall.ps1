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

# ConvertFrom-Json -AsHashtable is PowerShell 6+ ONLY, so under Windows
# PowerShell 5.1 — the shell README.md names for this script — this threw on a
# perfectly healthy file and reported "could not be parsed". It failed CLOSED,
# so nothing was ever lost here (unlike install.ps1, which failed open and ate
# the config), but the Windows uninstall was simply unavailable in the
# documented shell while claiming the file was corrupt.
#
# Duplicated from install.ps1 rather than shared: these two scripts have to run
# from a bare checkout with nothing loaded, which is why they are standalone.
function ConvertTo-OrderedDict {
    param($InputObject)
    if ($null -eq $InputObject) { return $null }
    # IDictionary before IEnumerable: a hashtable is both, and enumerating one
    # yields DictionaryEntry rather than its values.
    if ($InputObject -is [System.Collections.IDictionary]) {
        $out = [ordered]@{}
        foreach ($key in @($InputObject.Keys)) { $out[$key] = ConvertTo-OrderedDict $InputObject[$key] }
        return $out
    }
    if ($InputObject -is [System.Management.Automation.PSCustomObject]) {
        $out = [ordered]@{}
        foreach ($prop in $InputObject.PSObject.Properties) { $out[$prop.Name] = ConvertTo-OrderedDict $prop.Value }
        return $out
    }
    # A string is IEnumerable too, and must stay a scalar.
    if ($InputObject -is [System.Collections.IEnumerable] -and $InputObject -isnot [string]) {
        # The comma keeps a one-element result an array instead of unwrapping it.
        return ,@(foreach ($item in $InputObject) { ConvertTo-OrderedDict $item })
    }
    return $InputObject
}

$raw = Get-Content $settingsPath -Raw
if ([string]::IsNullOrWhiteSpace($raw)) {
    # Present but empty is somebody else's mid-write window, not "no hooks".
    Write-Host "[FAIL] $settingsPath is present but empty - left untouched." -ForegroundColor Red
    Write-Host "       That is usually a file being written right now. Re-run in a moment." -ForegroundColor Red
    exit 1
}
try {
    $cfg = ConvertTo-OrderedDict ($raw | ConvertFrom-Json)
} catch {
    Write-Host "[FAIL] $settingsPath could not be parsed - left untouched." -ForegroundColor Red
    Write-Host "       Nothing was changed. Fix or move the file, then re-run." -ForegroundColor Red
    exit 1
}

$installed = @()
if ($cfg -is [System.Collections.IDictionary] -and $cfg.Contains("hooks") `
        -and $cfg["hooks"] -is [System.Collections.IDictionary] `
        -and $cfg["hooks"].Contains("PostToolUse")) {
    $installed = @($cfg["hooks"]["PostToolUse"])
}

$target = ConvertTo-HookPath $hookCmd
$kept = @()
$removed = 0
# Removed PER HOOK, not per entry. Dropping the whole entry took any hook that
# happened to share its `hooks` array with ours — somebody else's tool, deleted
# silently by our uninstaller. src/permissions.js:unregisterApproveHook already
# filters per hook; these two scripts were the ones that did not.
foreach ($entry in $installed) {
    if (-not ($entry -is [System.Collections.IDictionary]) -or -not $entry.Contains("hooks")) {
        $kept += $entry
        continue
    }
    $mine = @()
    $survivors = @()
    foreach ($h in @($entry["hooks"])) {
        if ((ConvertTo-HookPath $h.command) -eq $target) { $mine += $h } else { $survivors += $h }
    }
    if ($mine.Count -eq 0) { $kept += $entry; continue }
    $removed += $mine.Count
    # An entry that held only ours goes; one that held a neighbour keeps it,
    # with its matcher and any other fields intact.
    if ($survivors.Count -gt 0) {
        $entry["hooks"] = $survivors
        $kept += $entry
    }
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
# A copy before an unlocked, non-atomic write to the file the whole project
# treats as fragile. An uninstall is exactly when a user wants a way back.
Copy-Item $settingsPath ($settingsPath + ".pre-uninstall-backup") -Force
[System.IO.File]::WriteAllText($settingsPath, $cfgJson + "`n")
Write-Host "[OK] removed $removed wildcard-perms PostToolUse hook(s) from ~/.claude/settings.json" -ForegroundColor Green
Write-Host "Allow-list entries stay as they are - this removes the hook, not your permissions." -ForegroundColor Cyan
