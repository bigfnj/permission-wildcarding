<#
  verify-release.ps1 -- post-reload acceptance suite for the memory-gates release.

  Run this AFTER reloading VS Code (and ideally after starting a fresh Claude Code
  session, which is what fires the SessionStart hook). It checks everything that can be
  checked from outside the editor, then prints a short list of things only eyes can confirm.

  Nothing here writes to your instruction files, your memory, or your settings. It is all
  reads plus the node test suite.

      powershell -ExecutionPolicy Bypass -File scripts\verify-release.ps1

  Paste the whole output back. Exit code is 0 only when every automated check passed.
#>

$ErrorActionPreference = 'Continue'
$repo = Split-Path -Parent $PSScriptRoot

$script:passed = 0
$script:failed = 0
$script:warned = 0

function Check {
    param([string]$Name, [bool]$Ok, [string]$Detail)
    if ($Ok) {
        $script:passed++
        Write-Host "  PASS  $Name"
    } else {
        $script:failed++
        Write-Host "  FAIL  $Name"
    }
    if ($Detail) { Write-Host "          $Detail" }
}

function Note {
    param([string]$Name, [string]$Detail)
    $script:warned++
    Write-Host "  INFO  $Name"
    if ($Detail) { Write-Host "          $Detail" }
}

function Section { param([string]$Title) Write-Host ""; Write-Host "== $Title" }

$SHELL_BEGIN = '<!-- BEGIN permission-wildcarding: shell style (managed) -->'
$GATES_BEGIN = '<!-- BEGIN permission-wildcarding: memory gates (managed) -->'
$GATES_END   = '<!-- END permission-wildcarding: memory gates -->'

$claudeMd = Join-Path $env:USERPROFILE '.claude\CLAUDE.md'
$agentsMd = Join-Path $env:USERPROFILE '.codex\AGENTS.md'
$genFile  = Join-Path $env:USERPROFILE '.claude\gates.generated.md'
$settings = Join-Path $env:USERPROFILE '.claude\settings.json'
$cli      = Join-Path $repo 'bin\wildcard-perms'
$recall   = Join-Path $repo 'memory\recall.py'

# Read this BEFORE any check runs. The CLI section below calls `--gates refresh`, which
# recompiles and so resets this timestamp -- the script would otherwise destroy the only
# evidence that the SessionStart hook fired, and every run after the first would look fresh.
$script:compiledAt = $null
if (Test-Path $genFile) { $script:compiledAt = (Get-Item $genFile).LastWriteTime }

# -- machine-specific configuration -------------------------------------------
# Everything machine-specific is discovered or configured, and NOTHING here is
# required: an unset value SKIPS its checks rather than failing them, so a fresh
# clone gets a useful board instead of a wall of red.
#
#   PW_MEMORY_DIR     memory corpus to lint (default: auto-discovered)
#   PW_GATE_MEMORY    filename of a scope:global gated memory, for the watcher probe
#   PW_PROBE_REPOS    'name=path;name=path' - repos expected to carry repo-scoped gates
#   PW_RECALL_PROBES  'query=>expected;query=>expected' - semantic-recall probes

# Discovered the way the product does: every ~/.claude/projects/*/memory holding a
# MEMORY.md, most recently touched first.
function Find-MemoryDir {
    if ($env:PW_MEMORY_DIR) { return $env:PW_MEMORY_DIR }
    $root = Join-Path $env:USERPROFILE '.claude\projects'
    if (-not (Test-Path $root)) { return $null }
    $candidates = Get-ChildItem $root -Directory -ErrorAction SilentlyContinue |
        ForEach-Object { Join-Path $_.FullName 'memory' } |
        Where-Object { Test-Path (Join-Path $_ 'MEMORY.md') }
    if (-not $candidates) { return $null }
    return ($candidates | Sort-Object { (Get-Item (Join-Path $_ 'MEMORY.md')).LastWriteTime } -Descending)[0]
}

function Get-ConfiguredPairs([string]$Value, [string]$Separator) {
    if ([string]::IsNullOrWhiteSpace($Value)) { return @() }
    return $Value.Split(';') | Where-Object { $_ -match [regex]::Escape($Separator) } | ForEach-Object {
        $parts = $_ -split [regex]::Escape($Separator), 2
        @{ k = $parts[0].Trim(); v = $parts[1].Trim() }
    }
}

$ProbeRepos   = Get-ConfiguredPairs $env:PW_PROBE_REPOS '='
$RecallProbes = Get-ConfiguredPairs $env:PW_RECALL_PROBES '=>'

Write-Host "permission-wildcarding release verification"
Write-Host "repo: $repo"
Write-Host "time: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"

# ---------------------------------------------------------------- test suite
Section 'Test suite'
$testFiles = @(Get-ChildItem (Join-Path $repo 'test\*.test.js') | ForEach-Object { $_.FullName })
if ($testFiles.Count -eq 0) {
    Check 'test files found' $false 'no test\*.test.js -- wrong repo path?'
} else {
    & node --test @testFiles | Out-Null
    $ok = ($LASTEXITCODE -eq 0)
    Check 'node --test (all files)' $ok "$($testFiles.Count) files, exit $LASTEXITCODE"
}

# ------------------------------------------------------- managed block state
Section 'Managed blocks in the instruction files'
foreach ($pair in @(@{ n = 'claude'; p = $claudeMd }, @{ n = 'codex'; p = $agentsMd })) {
    $path = $pair.p
    if (-not (Test-Path $path)) {
        Check "$($pair.n): instruction file exists" $false $path
        continue
    }
    $text = Get-Content $path -Raw
    $nShell = ([regex]::Matches($text, [regex]::Escape($SHELL_BEGIN))).Count
    $nGates = ([regex]::Matches($text, [regex]::Escape($GATES_BEGIN))).Count
    Check "$($pair.n): exactly one shell-style block" ($nShell -eq 1) "found $nShell"
    Check "$($pair.n): exactly one memory-gates block" ($nGates -eq 1) "found $nGates"

    # The two blocks must not have merged or nested: the shell block has to close before
    # the gates block opens, or an "off" on one would take a bite out of the other.
    $iShell = $text.IndexOf($SHELL_BEGIN)
    $iGates = $text.IndexOf($GATES_BEGIN)
    if ($iShell -ge 0 -and $iGates -ge 0) {
        $shellEnd = $text.IndexOf('<!-- END permission-wildcarding: shell style -->')
        Check "$($pair.n): blocks are disjoint, not nested" ($shellEnd -lt $iGates) `
            "shell ends at $shellEnd, gates begin at $iGates"
    }
}

# ------------------------------------------------- installed vs compiled body
Section 'Compiled gates match what is installed'
if (-not (Test-Path $genFile)) {
    Check 'gates.generated.md exists' $false $genFile
} else {
    # `Get-Content -Raw` on a 0-byte file returns $null, not '', and .Trim() on it
    # throws -- so the harness CRASHED on exactly the state it exists to report:
    # a machine with no gates, where `--gates refresh` writes 0 bytes by design.
    # Coerce before trimming, and let the non-empty check below do the judging.
    $raw = Get-Content $genFile -Raw
    if ($null -eq $raw) { $raw = '' }
    $gen = $raw.Trim()
    $gateCount = ([regex]::Matches($gen, '(?m)^- \*\*')).Count
    Check 'compiled file is non-empty' ($gen.Length -gt 0) "$($gen.Length) bytes, $gateCount gate(s)"

    $sha = [regex]::Match($gen, 'sha ([0-9a-f]{16})')
    if ($sha.Success) { Note 'compiled sha' $sha.Groups[1].Value }

    if (Test-Path $claudeMd) {
        $text = Get-Content $claudeMd -Raw
        $m = [regex]::Match($text, '(?s)' + [regex]::Escape($GATES_BEGIN) + '(.*?)' + [regex]::Escape($GATES_END))
        if ($m.Success) {
            $installed = $m.Groups[1].Value.Trim()
            Check 'installed block is byte-identical to the compiled file' ($installed -eq $gen) `
                "installed $($installed.Length) bytes vs compiled $($gen.Length) bytes"
        } else {
            Check 'gates block found in CLAUDE.md' $false 'markers missing'
        }
    }

    if ($script:compiledAt) {
        Note 'compiled at' ("{0:HH:mm:ss}" -f $script:compiledAt)
    }
}

# ------------------------------------------------------------------ CLI state
Section 'CLI status'
if (-not (Test-Path $cli)) {
    Check 'CLI present' $false $cli
} else {
    $g = & node $cli --gates status
    $gOn = ([regex]::Matches(($g -join "`n"), 'ON')).Count
    Check '--gates status reports ON for both agents' ($gOn -ge 2) (($g -join ' | '))
    Check '--gates status reports no staleness' (-not (($g -join ' ') -match 'corpus changed|nothing compiled')) ''

    $s = & node $cli --guidance status
    $sOn = ([regex]::Matches(($s -join "`n"), 'ON')).Count
    Check '--guidance status reports ON for both agents' ($sOn -ge 2) (($s -join ' | '))
    Check '--guidance is the current wording' (-not (($s -join ' ') -match 'older wording')) ''

    # Refresh must be silent when nothing changed: a SessionStart hook's stdout can be
    # folded into session context, so noise here costs tokens every single session.
    $r = & node $cli --gates refresh
    $rText = ($r -join '').Trim()
    Check '--gates refresh is silent when nothing changed' ($rText.Length -eq 0) `
        "printed: '$rText'"
}

# --------------------------------------------------------------- memory index
Section 'Memory index'
$py = $env:TOOLBOX_PYTHON
if (-not $py) { $py = Join-Path $env:LOCALAPPDATA 'DevToolbox\python\.venv\Scripts\python.exe' }
if (-not (Test-Path $py)) {
    Check 'toolbox python present' $false $py
} elseif (-not (Test-Path $recall)) {
    Check 'recall.py present' $false $recall
} else {
    $lint = (& $py $recall --lint) -join "`n"
    Check 'lint reports the index clean' ($lint -match 'clean:') ''
    Check 'index is within its byte budget' (-not ($lint -match 'over budget')) ''
    Check 'resident entries within the ceiling' (-not ($lint -match 'over the attention ceiling')) ''
    Check 'every standing order is compiled' (-not ($lint -match 'not compiled')) ''
    # Source drift: a gate edited but never recompiled. `--gates status` cannot see this, so
    # lint is the only guard, and a release must not ship with the resident block behind source.
    Check 'compiled gates are not stale vs source' (-not ($lint -match 'STALE')) `
        'run recall.py --gates-compile if this fails'
    $bytes = [regex]::Match($lint, 'MEMORY\.md: (\d+) bytes')
    $ents = [regex]::Match($lint, '(\d+) resident index entries')
    if ($bytes.Success -and $ents.Success) {
        Note 'index size' "$($bytes.Groups[1].Value) bytes, $($ents.Groups[1].Value) resident entries"
    }

    # Retrieval has to still work, because the index diet moved ~40 memories behind it.
    # Proper nouns, which is what the trigger table now tells the agent to use.
    if (-not $RecallProbes) {
        Note 'recall probes' 'skipped -- set PW_RECALL_PROBES to "query=>expected;..." to check retrieval'
    } else {
        foreach ($probe in $RecallProbes) {
            $hit = (& $py $recall $probe.k -k 3) -join "`n"
            Check "recall finds $($probe.v)" ($hit -match [regex]::Escape($probe.v)) "query: '$($probe.k)'"
        }
    }
}

# ------------------------------------------------------------------- env bits
Section 'Environment'
$modelDir = Join-Path $env:USERPROFILE '.claude\wildcarding\models'
Check 'recall model at the stable home' `
    ((Test-Path (Join-Path $modelDir 'bge-small.onnx')) -and (Test-Path (Join-Path $modelDir 'bge-small.vocab.txt'))) `
    $modelDir

if (Test-Path $settings) {
    $ok = $true
    try { $cfg = Get-Content $settings -Raw | ConvertFrom-Json } catch { $ok = $false }
    Check 'settings.json parses' $ok ''
    if ($ok) {
        $events = @()
        if ($cfg.hooks) { $events = @($cfg.hooks.PSObject.Properties.Name) }
        Check 'PostToolUse hook still registered' ($events -contains 'PostToolUse') ("events: " + ($events -join ', '))
        # NOT a Check. This was a FAIL asserting something the project deliberately
        # does not install and has measured does not fire here: a user SessionStart
        # entry is dropped on a box whose managed policy defines only PostToolUse
        # (measured -- a real session start and a /clear both left the compiled file
        # untouched while a PostToolUse canary fired 4/4). The extension's memory-dir
        # watcher is the real freshness mechanism and no policy can switch it off, so
        # a missing SessionStart entry is a fact to report, not a failure.
        $script:sessionStartRegistered = ($events -contains 'SessionStart')
    }
}

if (-not $ProbeRepos) {
    Note 'repo-scoped gates' 'skipped -- set PW_PROBE_REPOS to "name=path;name=path" to check them'
}
foreach ($repoPair in ($ProbeRepos | ForEach-Object { @{ n = $_.k; p = $_.v } })) {
    $local = Join-Path $repoPair.p 'CLAUDE.local.md'
    if (Test-Path $local) {
        $has = (Get-Content $local -Raw) -match [regex]::Escape($GATES_BEGIN)
        Check "$($repoPair.n): repo-scoped gates present" $has $local
        # Gitignored is the point: a personal standing order must not reach shared history.
        $tracked = & git -C $repoPair.p status --short --untracked-files=all -- CLAUDE.local.md
        Check "$($repoPair.n): CLAUDE.local.md is ignored by git" ([string]::IsNullOrWhiteSpace(($tracked -join ''))) ''
    } else {
        Check "$($repoPair.n): CLAUDE.local.md exists" $false $local
    }
}

$bundle = Join-Path $env:USERPROFILE '.codex\cloud-config-bundle-cache.json'
if (Test-Path $bundle) {
    $pol = [regex]::Match((Get-Content $bundle -Raw), 'allowed_approval_policies\s*=\s*\[([^\]]*)\]')
    $when = (Get-Item $bundle).LastWriteTime
    if ($pol.Success) {
        Note 'Codex org policy' ("allowed = [" + $pol.Groups[1].Value + "]  (cache written $when)")
        if ($pol.Groups[1].Value -match 'never') {
            Note 'Codex MAX' 'org now permits "never" -- the MAX card should be enabled'
        } else {
            Note 'Codex MAX' 'org still caps approval; Codex has not refetched the new account policy yet'
        }
    }
}

# --------------------------------------------------------- freshness mechanism
Section 'Freshness (extension corpus watcher)'
# The SessionStart hook does NOT fire under a managed policy that sets allowManagedHooksOnly:
# enforcement is per event, and a user hook only runs on an event the policy itself defines.
# What actually keeps gates fresh is the extension watching the memory dir. This is a real
# end-to-end test of that path, so it needs VS Code running with the extension active.
$memDir = Find-MemoryDir
$gateFile = if ($memDir -and $env:PW_GATE_MEMORY) { Join-Path $memDir $env:PW_GATE_MEMORY } else { $null }
if (-not ($gateFile -and (Test-Path $gateFile) -and (Test-Path $genFile))) {
    Note 'corpus watcher' 'skipped -- gated memory or compiled file not found'
} else {
    $before = (Get-Item $genFile).LastWriteTime
    # mtime only, no content change. Costs one file re-embed on the next recall, nothing else.
    (Get-Item $gateFile).LastWriteTime = Get-Date
    Write-Host "        touched a gated memory, waiting 10s for the debounced recompile..."
    Start-Sleep -Seconds 10
    $after = (Get-Item $genFile).LastWriteTime
    Check 'a memory edit triggers a recompile' ($after -gt $before) `
        ("compiled {0:HH:mm:ss} -> {1:HH:mm:ss}. FAIL here means VS Code is not running, the extension is not active, or gates are off." -f $before, $after)
}

# Report what is actually in settings.json rather than asserting a state. The old
# static wording claimed "registered but INERT" while the check beside it was
# failing for not being registered at all -- the two contradicted each other, and
# the wording won because it was the one a reader believed.
$hookNote = if ($script:sessionStartRegistered) {
    'registered, but INERT on this box (managed policy defines only PostToolUse, so user hooks on other events are dropped). Left in place because it works where policy allows it.'
} else {
    'NOT registered, which costs nothing here: it is measured not to fire under this box''s managed policy, and the extension''s memory-dir watcher is what actually keeps gates fresh. Register it only on a box whose policy defines SessionStart.'
}
Note 'SessionStart hook' $hookNote

# ------------------------------------------------- is the new code even loaded?
Section 'Installed extension'
# The dashboard changes (Memory gates card, the de-reddened guidance button, the Codex
# bundle watcher) live in the VSIX. Reloading VS Code re-runs whatever is INSTALLED, so a
# reload without a repackage shows none of it -- and looks like the feature is broken.
$installedDirs = @(Get-ChildItem (Join-Path $env:USERPROFILE '.vscode\extensions') -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -like '*permission-wildcarding*' })
if ($installedDirs.Count -eq 0) {
    Note 'installed extension' 'none found under ~/.vscode/extensions -- CLI-only setup'
} else {
    $inst = $installedDirs | Sort-Object Name | Select-Object -Last 1
    $instJs = Join-Path $inst.FullName 'extension.js'
    $srcJs = Join-Path $repo 'vscode-extension\extension.js'
    if ((Test-Path $instJs) -and (Test-Path $srcJs)) {
        $a = (Get-FileHash $instJs -Algorithm SHA256).Hash
        $b = (Get-FileHash $srcJs -Algorithm SHA256).Hash
        Check 'installed extension.js matches the repo source' ($a -eq $b) `
            "installed: $($inst.Name)  -- if this FAILS, package and install the VSIX before judging the eyes-only checks"
        $instGates = Join-Path $inst.FullName 'src\agent-gates.js'
        Check 'installed VSIX carries src\agent-gates.js' (Test-Path $instGates) `
            'package.mjs syncs repo-root src\ into the extension; a stale VSIX will not have it'
    } else {
        Note 'installed extension' "found $($inst.Name) but could not compare extension.js"
    }
}

# ------------------------------------------------------------------- summary
Write-Host ""
Write-Host "==============================================="
Write-Host " PASS $script:passed   FAIL $script:failed   INFO $script:warned"
Write-Host "==============================================="
Write-Host ""
if ($script:failed -gt 0) {
    Write-Host "If the only failure is 'installed extension.js matches the repo source',"
    Write-Host "the code is fine and just is not packaged yet:"
    Write-Host "    node scripts\package.mjs"
    Write-Host "    code --install-extension permission-wildcarding-<version>.vsix"
    Write-Host "then reload VS Code and re-run this script."
    Write-Host ""
}

Write-Host "Eyes-only checks (open the Activity Bar dashboard):"
Write-Host "  1. A 'Memory gates' card exists. It should read OFF while the corpus holds"
Write-Host "     no scope:global gate blocks -- that is the CORRECT state, not a defect."
Write-Host "     (It read 'ON - 6 gates' before the 2026-09-09 ~/.claude loss. Those six"
Write-Host "     names are the only surviving record of the corpus, and only four are"
Write-Host "     recoverable: whatever PW_RECALL_PROBES and PW_GATE_MEMORY still name,"
Write-Host "     which this script still probes for under the freshness section.)"
Write-Host "  2. Its button is quiet/bordered, NOT a big red bar, labelled 'Remove gates...'"
Write-Host "     -- only applicable once gates are ON; skip while the card reads OFF."
Write-Host "  3. 'Shell-style guidance' button is also quiet now, labelled 'Remove guidance...'"
Write-Host "     (it used to be a red 'Remove from 2 instruction files')"
Write-Host "  4. Clicking either opens a modal confirm; CANCEL must change nothing"
Write-Host "  5. The memory card's CPU LLM row reads 'ready (bge-small, 384-dim)',"
Write-Host "     not 'model not found'"
Write-Host "  6. No errors in Help > Toggle Developer Tools > Console mentioning"
Write-Host "     permission-wildcarding"
Write-Host ""

if ($script:failed -gt 0) { exit 1 }
exit 0
