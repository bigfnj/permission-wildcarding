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

# ConvertFrom-Json -AsHashtable is PowerShell 6+ ONLY. Under Windows PowerShell
# 5.1 — the shell README.md names for this script — it threw, the catch below
# only warned, $cfg stayed empty, and the write further down replaced the user's
# entire settings.json with nothing but this hook. Reproduced on 5.1.26100.7019:
# model, effortLevel, env, permissions.allow, permissions.deny and a co-located
# third-party SessionStart hook all gone, exit code 0, "[OK]" printed. The
# installer deleted its own registration along with the policy.
#
# So: parse with plain ConvertFrom-Json, which exists everywhere, and convert the
# PSCustomObject tree to ordered dictionaries ourselves. Ordered, because
# ConvertTo-Json follows insertion order and a settings.json whose keys got
# shuffled is a gratuitous diff in a file the user reads.
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
        # The comma keeps a one-element result an array instead of unwrapping it,
        # so a single-hook PostToolUse does not serialise as an object.
        return ,@(foreach ($item in $InputObject) { ConvertTo-OrderedDict $item })
    }
    return $InputObject
}

$cfg = [ordered]@{}
if (Test-Path $settingsPath) {
    $raw = Get-Content $settingsPath -Raw
    # Empty is not the same as absent. A zero-byte read is the mid-write window
    # of somebody else's atomic write — routine, because Claude Code rewrites
    # this file on every /model, /effort and approval — and treating it as "no
    # config yet" is how a whole policy gets replaced by one hook.
    if ([string]::IsNullOrWhiteSpace($raw)) {
        Write-Host "[FAIL] $settingsPath is present but empty - refusing to write over it." -ForegroundColor Red
        Write-Host "       That is usually a file being written right now. Re-run in a moment." -ForegroundColor Red
        exit 1
    }
    try {
        $parsed = $raw | ConvertFrom-Json
    } catch {
        # Fail CLOSED, matching uninstall.sh's contract and the refusal in
        # src/settings-write.js. Present-but-unparseable is the one case where
        # starting from an empty config is destructive rather than merely wrong.
        Write-Host "[FAIL] $settingsPath could not be parsed - left untouched." -ForegroundColor Red
        Write-Host "       Nothing was changed. Fix or move the file, then re-run." -ForegroundColor Red
        exit 1
    }
    $cfg = ConvertTo-OrderedDict $parsed
    if ($null -eq $cfg -or $cfg -isnot [System.Collections.IDictionary]) {
        Write-Host "[FAIL] $settingsPath does not contain a JSON object - left untouched." -ForegroundColor Red
        exit 1
    }
}

# .Contains, not .ContainsKey: OrderedDictionary has only the former, and both
# it and Hashtable inherit it from IDictionary.
if (-not $cfg.Contains("hooks")) {
    $cfg["hooks"] = [ordered]@{}
}
if (-not $cfg["hooks"].Contains("PostToolUse")) {
    $cfg["hooks"]["PostToolUse"] = @()
}

$already = $false
foreach ($entry in @($cfg["hooks"]["PostToolUse"])) {
    if ($entry -is [System.Collections.IDictionary] -and $entry.Contains("hooks")) {
        foreach ($h in @($entry["hooks"])) {
            if ($h.command -eq $hookCommand -or $h.command -eq $hookCmdNormalized -or $h.command -eq $hookCmd) {
                $already = $true
                break
            }
        }
    }
}

if (-not $already) {
    # Add new PostToolUse entry
    $newHook = [ordered]@{
        matcher = "Bash|PowerShell"
        hooks = @(
            [ordered]@{
                type = "command"
                command = $hookCommand
            }
        )
    }
    $cfg["hooks"]["PostToolUse"] = @(@($cfg["hooks"]["PostToolUse"]) + $newHook)
    $cfgJson = ConvertTo-Json $cfg -Depth 100
    # A copy before the only unlocked, non-atomic write to this file in the
    # project. Everything in-process goes through writeFileAtomicSync; this
    # script cannot, so the next-best thing is somewhere to go back to.
    if (Test-Path $settingsPath) {
        Copy-Item $settingsPath ($settingsPath + ".pre-install-backup") -Force
    }
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
