<#
  Behavioural tests for install.ps1 and uninstall.ps1.

  These exist because the installers are the highest-blast-radius files in the
  repo and had no test of any kind. install.ps1 replaced the user's entire
  settings.json with nothing but its own hook entry: `ConvertFrom-Json
  -AsHashtable` is PowerShell 6+ only, under Windows PowerShell 5.1 it throws,
  the catch only WARNED, and the write went ahead. Reproduced on 5.1.26100.7019
  against a config holding model, effortLevel, env, permissions.allow,
  permissions.deny and a third-party SessionStart hook: all six gone, exit code
  0, "[OK]" printed. It deleted its own hook registration along with the policy.

  RUN THIS UNDER powershell.exe, NOT ONLY pwsh. That is the whole point. Both
  installers parse clean under 5.1 -- [Parser]::ParseFile reports no errors --
  so the defect is invisible to every check that does not actually execute on
  5.1. test/installers.test.js covers install.sh and uninstall.sh for real and
  can only guard the .ps1 pair statically, which is why this file exists.

  The seam: install.ps1 and uninstall.ps1 read the home directory from
  [System.Environment]::GetFolderPath("UserProfile"), which ignores
  $env:USERPROFILE, so it cannot be redirected from outside. Each script is
  therefore copied into a sandbox with that ONE line rewritten and the copy is
  what runs -- every line that touches the config is verbatim. An earlier
  version of this harness did not understand that and ran the real installer
  against the live ~/.claude five times; nothing was lost only because the hook
  was already registered, which short-circuits before the write.

  Exit code is 0 only when every case passed, so scripts/verify-release.ps1 can
  fold the whole file into one Check on $LASTEXITCODE.
#>

# Continue, not Stop: a failing case must be reported and the run must go on, the
# same contract verify-release.ps1 uses.
$ErrorActionPreference = 'Continue'
$repo = Split-Path -Parent $PSScriptRoot

$script:results = @()
function Add-Result {
    param([string]$Case, [bool]$Pass, [string]$Detail)
    $script:results += [pscustomobject]@{ case = $Case; pass = $Pass; detail = $Detail }
}

# powershell.exe is Windows-only, and every case below spawns the child through it
# deliberately -- pwsh would hide the defect these tests exist for.
if (-not $IsWindows -and $PSVersionTable.PSEdition -eq 'Core') {
    Write-Host "installers: skipped -- powershell.exe (Windows PowerShell 5.1) is not available on this platform"
    exit 0
}

$HOME_NEEDLE = '$userProfile = [System.Environment]::GetFolderPath("UserProfile")'

function Get-Installer {
    param([string]$Name)
    $path = Join-Path $repo $Name
    if (-not (Test-Path $path)) { return $null }
    $source = Get-Content $path -Raw
    if (-not $source.Contains($HOME_NEEDLE)) { return $null }
    return $source
}

function New-Box {
    <#  A sandbox holding a .claude\settings.json and a copy of the script under
        test with its home directory repointed at the sandbox. $Content is a
        scriptblock taking the hook path, because the script under test derives
        that path from its OWN location -- a fixture naming the repo's path would
        never match, which cost one debugging round the first time. #>
    param([string]$Source, [scriptblock]$Content, [switch]$NoFile, [string]$ScriptName = 'under-test.ps1')
    $box = Join-Path $env:TEMP ('pw-inst-' + [guid]::NewGuid().ToString('N'))
    $null = New-Item -Path (Join-Path $box '.claude') -ItemType Directory -Force
    $hookPath = (Join-Path $box 'bin\wildcard-perms') -replace '\\', '/'
    if (-not $NoFile) {
        [System.IO.File]::WriteAllText((Join-Path $box '.claude\settings.json'), (& $Content $hookPath))
    }
    $script = Join-Path $box $ScriptName
    [System.IO.File]::WriteAllText($script, $Source.Replace($HOME_NEEDLE, ('$userProfile = ' + "'" + $box + "'")))
    return @{
        dir      = $box
        script   = $script
        settings = Join-Path $box '.claude\settings.json'
        hook     = $hookPath
    }
}

function Invoke-Box {
    # "n" on stdin answers install.ps1's starter-pack prompt, so nothing is seeded.
    param($Box)
    $out = ('n' | & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $Box.script 2>&1) | Out-String
    return @{ output = $out; code = $LASTEXITCODE }
}

function Get-RealHookCommand {
    <#  The exact hook command install.ps1 writes into THIS sandbox, obtained by
        running it rather than by reconstructing the path.

        Why this exists: a fixture cannot derive the hook path from $env:TEMP and
        expect it to match. On a GitHub runner %TEMP% is an 8.3 short path
        (C:\Users\RUNNER~1\...) while PowerShell canonicalises
        $MyInvocation.MyCommand.Path — which is what both installers derive
        $scriptDir from — to the LONG form. The two spellings never matched, so
        every uninstall case that depends on recognising our own hook failed on CI
        and passed locally, where %TEMP% has no 8.3 component. Asking the installer
        is both spelling-proof and a truer round trip: it is the same string a real
        install would leave behind. #>
    param([string]$InstallSource, [string]$BoxDir)
    $probe = Join-Path $BoxDir 'install-probe.ps1'
    [System.IO.File]::WriteAllText($probe,
        $InstallSource.Replace($HOME_NEEDLE, ('$userProfile = ' + "'" + $BoxDir + "'")))
    $null = ('n' | & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $probe 2>&1)
    $written = Join-Path $BoxDir '.claude\settings.json'
    if (-not (Test-Path $written)) { return $null }
    $cfg = Get-Content $written -Raw | ConvertFrom-Json
    $cmd = @($cfg.hooks.PostToolUse)[0].hooks[0].command
    # Leave the sandbox as the caller found it: no settings.json, no probe.
    Remove-Item $written -Force -ErrorAction SilentlyContinue
    Remove-Item ($written + '.pre-install-backup') -Force -ErrorAction SilentlyContinue
    Remove-Item $probe -Force -ErrorAction SilentlyContinue
    return $cmd
}

$HEALTHY = {
    param($hook)
    '{
  "model": "claude-opus-5",
  "effortLevel": "high",
  "env": { "FOO": "bar" },
  "permissions": {
    "allow": ["Bash(git status *)", "Bash(rg *)", "Read(*)"],
    "deny": ["Bash(rm -rf /*)"]
  },
  "hooks": {
    "SessionStart": [ { "hooks": [ { "type": "command", "command": "other-tool" } ] } ]
  }
}'
}

# ── install.ps1 ───────────────────────────────────────────────────────────────

$install = Get-Installer 'install.ps1'
if (-not $install) {
    Add-Result 'install.ps1 is testable' $false "missing, or the home-directory line moved -- update `$HOME_NEEDLE"
} else {

    # 1. A healthy file. Every key survives and the hook is added beside the neighbour.
    $box = New-Box -Source $install -Content $HEALTHY
    $r = Invoke-Box $box
    $after = Get-Content $box.settings -Raw | ConvertFrom-Json
    $names = $after.PSObject.Properties.Name
    $kept = @('model', 'effortLevel', 'env', 'permissions') | Where-Object { $names -contains $_ }
    $allow = if ($after.permissions.allow) { @($after.permissions.allow).Count } else { 0 }
    $deny = if ($after.permissions.deny) { @($after.permissions.deny).Count } else { 0 }
    $hookNames = @($after.hooks.PSObject.Properties.Name)
    Add-Result 'install: keeps every key it found' `
    ($r.code -eq 0 -and $kept.Count -eq 4 -and $allow -eq 3 -and $deny -eq 1 `
            -and ($hookNames -contains 'SessionStart') -and ($hookNames -contains 'PostToolUse')) `
        "kept=$($kept.Count)/4 allow=$allow deny=$deny hooks=$($hookNames -join '+')"
    Remove-Item -Recurse -Force $box.dir

    # 2. Unparseable: refuse, change nothing, exit non-zero.
    $broken = { param($hook) '{ "model": "x", "permissions": { "allow": [ ' }
    $box = New-Box -Source $install -Content $broken
    $r = Invoke-Box $box
    Add-Result 'install: refuses an unparseable settings.json' `
    ($r.code -ne 0 -and (Get-Content $box.settings -Raw) -eq (& $broken $box.hook) `
            -and $r.output -match 'could not be parsed') `
        "exit=$($r.code)"
    Remove-Item -Recurse -Force $box.dir

    # 3. Zero bytes is somebody else's mid-write window, not "no config yet".
    $box = New-Box -Source $install -Content { param($hook) '' }
    $r = Invoke-Box $box
    Add-Result 'install: refuses a zero-byte settings.json' `
    ($r.code -ne 0 -and (Get-Item $box.settings).Length -eq 0 -and $r.output -match 'present but empty') `
        "exit=$($r.code)"
    Remove-Item -Recurse -Force $box.dir

    # 4. Absent is the legitimate first run and must still work.
    $box = New-Box -Source $install -NoFile
    $r = Invoke-Box $box
    $fresh = if (Test-Path $box.settings) { Get-Content $box.settings -Raw | ConvertFrom-Json } else { $null }
    Add-Result 'install: creates an absent settings.json' `
    ($r.code -eq 0 -and $null -ne $fresh -and @($fresh.hooks.PostToolUse).Count -eq 1) `
        "exit=$($r.code) created=$(Test-Path $box.settings)"
    Remove-Item -Recurse -Force $box.dir

    # 5. Idempotent.
    $box = New-Box -Source $install -Content $HEALTHY
    $null = Invoke-Box $box
    $r = Invoke-Box $box
    $after = Get-Content $box.settings -Raw | ConvertFrom-Json
    Add-Result 'install: run twice does not double-register' `
    (@($after.hooks.PostToolUse).Count -eq 1 -and $r.output -match 'already registered') `
        "PostToolUse=$(@($after.hooks.PostToolUse).Count)"
    Remove-Item -Recurse -Force $box.dir

    # 6. Key order preserved, so the write is not a gratuitous diff in a file the
    #    user reads. This is what the ordered-dictionary conversion buys.
    $box = New-Box -Source $install -Content $HEALTHY
    $null = Invoke-Box $box
    $order = ((Get-Content $box.settings -Raw | ConvertFrom-Json).PSObject.Properties.Name) -join ','
    Add-Result 'install: preserves key order' `
    ($order -eq 'model,effortLevel,env,permissions,hooks') "order=$order"
    Remove-Item -Recurse -Force $box.dir

    # 7. The backup holds the bytes as FOUND, not the object being written -- the
    #    easy mistake is to serialise $cfg, which by then already has the new hook.
    $box = New-Box -Source $install -Content $HEALTHY
    $null = Invoke-Box $box
    $bk = $box.settings + '.pre-install-backup'
    Add-Result 'install: pre-write backup is the original bytes' `
    ((Test-Path $bk) -and (Get-Content $bk -Raw) -notmatch 'PostToolUse' `
            -and (Get-Content $bk -Raw) -match 'SessionStart') `
        "exists=$(Test-Path $bk)"
    Remove-Item -Recurse -Force $box.dir
}

# ── uninstall.ps1 ─────────────────────────────────────────────────────────────

$uninstall = Get-Installer 'uninstall.ps1'
if (-not $uninstall) {
    Add-Result 'uninstall.ps1 is testable' $false "missing, or the home-directory line moved -- update `$HOME_NEEDLE"
} elseif (-not $install) {
    Add-Result 'uninstall.ps1 is testable' $false 'install.ps1 is needed to learn the real hook spelling'
} else {

    # A sandbox whose fixture is built from the hook command install.ps1 actually
    # writes, so nothing here assumes a path spelling. See Get-RealHookCommand.
    function New-UninstallBox {
        param([scriptblock]$Content)
        $box = New-Box -Source $uninstall -NoFile
        $real = Get-RealHookCommand -InstallSource $install -BoxDir $box.dir
        if (-not $real) { return $null }
        [System.IO.File]::WriteAllText($box.settings, (& $Content $real))
        $box.real = $real
        return $box
    }

    # $real is the full command install.ps1 writes, e.g. `node "C:/.../wildcard-perms"`.
    # ConvertTo-Json quotes and escapes it for embedding, so the fixtures never
    # hand-build that string. $bareOf recovers just the path, which is the spelling
    # install.sh registers.
    $bareOf = { param($cmd) ($cmd -replace '^node\s+"?', '') -replace '"$', '' }

    # 1. Removes only ours, from among a sibling entry and a separate hook group.
    #    This is the case that could not run at all under 5.1 before the fix.
    $withHook = {
        param($real)
        '{
  "model": "claude-opus-5",
  "permissions": { "allow": ["Bash(rg *)"], "deny": [] },
  "hooks": {
    "SessionStart": [ { "hooks": [ { "type": "command", "command": "other-tool" } ] } ],
    "PostToolUse": [
      { "matcher": "Bash|PowerShell", "hooks": [ { "type": "command", "command": ' + (ConvertTo-Json $real) + ' } ] },
      { "matcher": "Bash", "hooks": [ { "type": "command", "command": "someone-elses-hook" } ] }
    ]
  }
}'
    }
    $box = New-UninstallBox -Content $withHook
    if (-not $box) {
        Add-Result 'uninstall: removes only our hook' $false 'could not learn the installed hook command'
    } else {
        $r = Invoke-Box $box
        $after = Get-Content $box.settings -Raw | ConvertFrom-Json
        $ptu = @($after.hooks.PostToolUse)
        Add-Result 'uninstall: removes only our hook' `
        ($r.code -eq 0 -and $ptu.Count -eq 1 -and $ptu[0].hooks[0].command -eq 'someone-elses-hook' `
                -and $null -ne $after.hooks.SessionStart -and $after.model -eq 'claude-opus-5' `
                -and @($after.permissions.allow).Count -eq 1) `
            "PostToolUse=$($ptu.Count) survivor=$($ptu[0].hooks[0].command)"
        Remove-Item -Recurse -Force $box.dir
    }

    # 2. The bare-path spelling install.sh writes, not install.ps1's `node "..."`.
    $bare = {
        param($real)
        '{ "model": "x", "hooks": { "PostToolUse": [ { "matcher": "Bash", "hooks": [ { "type": "command", "command": ' `
            + (ConvertTo-Json (($real -replace '^node\s+"?', '') -replace '"$', '')) + ' } ] } ] } }'
    }
    $box = New-UninstallBox -Content $bare
    if (-not $box) {
        Add-Result 'uninstall: matches the bare-path spelling too' $false 'could not learn the installed hook command'
    } else {
        $r = Invoke-Box $box
        $after = Get-Content $box.settings -Raw | ConvertFrom-Json
        Add-Result 'uninstall: matches the bare-path spelling too' `
        ($r.code -eq 0 -and -not ($after.PSObject.Properties.Name -contains 'hooks')) `
            "keys=$($after.PSObject.Properties.Name -join ',')"
        Remove-Item -Recurse -Force $box.dir
    }

    # 3. A third-party hook sharing OUR entry's hooks array. Removing the whole
    #    entry deleted somebody else's tool, silently.
    $shared = {
        param($real)
        '{ "model": "x", "hooks": { "PostToolUse": [ { "matcher": "Bash", "hooks": [ { "type": "command", "command": ' `
            + (ConvertTo-Json $real) + ' }, { "type": "command", "command": "neighbour-tool" } ] } ] } }'
    }
    $box = New-UninstallBox -Content $shared
    if (-not $box) {
        Add-Result 'uninstall: keeps a co-located third-party hook' $false 'could not learn the installed hook command'
    } else {
        $r = Invoke-Box $box
        $after = Get-Content $box.settings -Raw | ConvertFrom-Json
        $ptu = @($after.hooks.PostToolUse)
        Add-Result 'uninstall: keeps a co-located third-party hook' `
        ($r.code -eq 0 -and $ptu.Count -eq 1 -and @($ptu[0].hooks).Count -eq 1 `
                -and $ptu[0].hooks[0].command -eq 'neighbour-tool' -and $ptu[0].matcher -eq 'Bash') `
            "hooks=$(@($ptu[0].hooks).Count) survivor=$($ptu[0].hooks[0].command) matcher=$($ptu[0].matcher)"
        Remove-Item -Recurse -Force $box.dir
    }

    # 4. Nothing of ours registered: say so, change nothing, exit 0.
    $none = { param($hook) '{ "model": "x", "hooks": { "SessionStart": [ { "hooks": [ { "type": "command", "command": "other" } ] } ] } }' }
    $box = New-Box -Source $uninstall -Content $none
    $r = Invoke-Box $box
    Add-Result 'uninstall: reports when there was nothing to remove' `
    ($r.code -eq 0 -and (Get-Content $box.settings -Raw) -eq (& $none $box.hook) `
            -and $r.output -match 'nothing removed') `
        "exit=$($r.code)"
    Remove-Item -Recurse -Force $box.dir

    # 5. Unparseable: refuse. Fails closed, so nothing was ever lost here -- but it
    #    used to report "could not be parsed" for a HEALTHY file under 5.1.
    $brokenU = { param($hook) '{ "hooks": { "PostToolUse": [ ' }
    $box = New-Box -Source $uninstall -Content $brokenU
    $r = Invoke-Box $box
    Add-Result 'uninstall: refuses an unparseable settings.json' `
    ($r.code -ne 0 -and (Get-Content $box.settings -Raw) -eq (& $brokenU $box.hook) `
            -and $r.output -match 'left untouched') `
        "exit=$($r.code)"
    Remove-Item -Recurse -Force $box.dir

    # 6. Zero bytes: refuse, and say which it was.
    $box = New-Box -Source $uninstall -Content { param($hook) '' }
    $r = Invoke-Box $box
    Add-Result 'uninstall: refuses a zero-byte settings.json' `
    ($r.code -ne 0 -and $r.output -match 'present but empty') "exit=$($r.code)"
    Remove-Item -Recurse -Force $box.dir

    # 7. No file at all is not a failure.
    $box = New-Box -Source $uninstall -NoFile
    $r = Invoke-Box $box
    Add-Result 'uninstall: an absent settings.json is not a failure' `
    ($r.code -eq 0 -and $r.output -match 'no hook to remove') "exit=$($r.code)"
    Remove-Item -Recurse -Force $box.dir

    # 8. A copy exists after a real removal. An uninstall is exactly when a user
    #    wants a way back.
    $box = New-UninstallBox -Content $withHook
    if (-not $box) {
        Add-Result 'uninstall: takes a pre-write backup' $false 'could not learn the installed hook command'
    } else {
        $r = Invoke-Box $box
        $bk = $box.settings + '.pre-uninstall-backup'
        Add-Result 'uninstall: takes a pre-write backup' `
        ((Test-Path $bk) -and (Get-Content $bk -Raw) -match 'someone-elses-hook') `
            "exists=$(Test-Path $bk) removalExit=$($r.code)"
        Remove-Item -Recurse -Force $box.dir
    }
}

# ── report ────────────────────────────────────────────────────────────────────

Write-Host ("installers, child running under powershell.exe (parent: PowerShell $($PSVersionTable.PSVersion))")
foreach ($r in $script:results) {
    Write-Host ('  {0}  {1,-52} {2}' -f $(if ($r.pass) { 'PASS' } else { 'FAIL' }), $r.case, $r.detail)
}
$failed = @($script:results | Where-Object { -not $_.pass }).Count
$total = @($script:results).Count
Write-Host ''
Write-Host ("{0} pass, {1} fail" -f ($total - $failed), $failed)
if ($failed -gt 0) { exit 1 }
exit 0
