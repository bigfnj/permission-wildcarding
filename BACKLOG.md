# Backlog

Open items with the evidence that justifies them, so a later session does not
re-derive the reasoning. Anything measured says so and names the date; anything
unverified says that too. Closed items are removed rather than archived, since
git holds the history.

## Verified working, nothing to do

Auto Learn applies. Both symptoms that opened the 2026-09-02/03 work are gone,
confirmed on a real machine 2026-09-03: `~/.codex/rules/permission-wildcarding.rules`
written with 43 `prefix_rule` entries, state `applied.claude` 23 and
`applied.codex` 50, `lastApplication` set across `claude`, `claude-claims` and
`codex`, Review count back to 0.

## Open

### The claims registry can claim an entry the allow list no longer holds

After an apply, the wildcarding pass prunes any new entry a broader existing rule
already covers. Measured 2026-09-03: 12 entries written, 8 pruned
(`Bash(git diff *)` under `Bash(git *)`, `PowerShell(dotnet run *)` under
`PowerShell(dotnet *)`, and so on), leaving `claude-policy-claims.json` claiming
8 permissions absent from `settings.json`.

Impact today is nil: every pruned family is still allowed through its parent, and
Undo releases claims rather than restoring bytes, so a claim for an absent entry
is a no-op. It would matter only if the parent were later removed, at which point
the child would not return. Fix would be to reconcile claims against the file
after the wildcarding pass, or to record the covering parent alongside the claim.

### Non-interactive runs refuse every output redirection

Measured 2026-09-03, Claude Code 2.1.258. Four `-p` probes were refused with
"Output redirection to '<path>' was blocked … may only write to files in the
allowed working directories", including a target inside the session's own working
directory that the refusal itself listed as allowed. The identical redirect
succeeded in an interactive session. Reads as `-p` failing closed because it
cannot prompt, with a message naming the wrong reason. Not this project's bug;
recorded because it invalidates any redirect experiment run through `-p`.

### Claude Code's built-in read-only command set is not fully known

`hostname` ran with no matching allow entry and no prompt, so the built-in set is
wider than the 14 commands `docs/claude-code-permissions.md` lists from the docs.
The list is used to argue which pack entries are redundant, so it is worth
pinning down before acting on that argument again. `scripts/auto-mode-audit.js`
is the wrong tool (it reads load-time warnings); this needs a per-command probe.

### `.exe` spellings split a family's evidence

`git.exe status` keys as `powershell:git.exe status`, separate from
`powershell:git status`, with its own permission string. Risk classification
already normalizes `.exe` away, so only the key and prefix differ, and runs
spread across the two spellings each count toward their own threshold. Largest
such family observed: 15 runs. Costs nothing while `PowerShell(& *)` covers the
call-operator form those invocations use. Fix would unify the family for evidence
while still emitting both permission spellings.

### State file growth is unbounded in one dimension

2.9 MB at last check: ~13.5k observation hashes against a 20,000 cap, ~790
cursors with no cap, 234 candidates. Measured cost is 14 ms to parse and 9 ms to
serialize, so this is not urgent. Cursors are the only uncapped structure; they
accumulate one entry per transcript file ever seen and never shrink when a
transcript is deleted. Revisit if the file passes roughly 20 MB.

### An older copy of the tool silently drops new state fields

Found 2026-09-09 while smoke-testing `managedHits` on a real machine: the table
was populated by `--learn hits`, then emptied twice within minutes.

Cause is `persistentState`, which serializes a whitelist of known keys. That is
the right shape for rejecting junk, but it means any copy of the tool older than
a field round-trips the state and writes it back without that field. This machine
had **three** extension versions installed at once (1.2.6, 1.2.7, 1.2.8), each
activating its own watcher and periodic scan against the same state file, so an
older bundled copy kept clobbering the newer field. The advisory lock does not
help: each writer is individually correct and takes the lock properly.

Severity is low because the field is derived, not authoritative, and one
`--learn hits` rebuilds it. It matters for anything that is NOT reconstructible,
so a future field that records a human decision (`derivedGuidance.accepted` is
already one) would be lost the same way with no way back. Two candidate fixes:
carry unknown top-level keys through `persistentState` untouched, or refuse to
save when the on-disk `version` is newer than the running code. The second is
stricter and would have surfaced the multi-install problem immediately.

Worth noting separately that multiple installed extension versions is itself
worth guarding against, since each one scans on its own timer.

## From the 2026-09-09 audit

Five parallel read-only audits over the whole repo. Everything here was verified
by reading the code, and the numbers were measured on a real machine (712
transcripts, ~920 MB; 316-entry allow list; 3.7 MB state file). Defects in that
session's own new code were fixed in the same session and are not listed.

### The hook recompiles ~192k regexes per tool call

Highest-impact item found, and the cheapest to fix. `ruleMatches`
(`src/permission-match.js:60`) ends in `new RegExp(...)` with no cache, and
`normalizeRule` runs three times per call. `processAllowList` then does two
quadratic passes over the allow list (`src/permissions.js:204-216`).

Measured on a real 316-entry list: **495-508 ms and 192,150 RegExp compilations
per `PostToolUse` hook run**, which then usually writes nothing because the list
is already optimal. A prototype cache (rule string to compiled RegExp, plus a
`normalizeRule` memo, both inside `permission-match.js`) gave **25 ms and 316
compilations with byte-identical output**. Roughly 15 lines, one file, no call
sites change; `test/permission-match.test.js` and
`test/permissions-regressions.test.js` already guard the behaviour. Needs a cap
on the cache, since the key space is rule strings.

Same fix also covers: the dashboard, which runs that 500 ms pass on every
`refresh()` (~30 call sites, synchronous on the extension host,
`vscode-extension/extension.js:2587`); `runWildcarding()` at `:2058`, which
`activate()` calls synchronously; and the scan's probe matcher, measured at
484,351 compilations across a full corpus pass.

Whole-hook budget today is ~575 ms per tool call: 50 node startup, 20 requires,
500 `processAllowList`, 4 the policy lock. Two more items on that path, both
small: `bin/wildcard-perms` top-level-requires `codex-max`, `agent-guidance` and
`agent-gates` plus `spawnSync`, none of which the hook path uses (~12 ms;
`learn()` already lazy-requires and says why), and `finish()` takes the policy
lock before checking whether the project has a `settings.local.json` at all
(3.7 ms per call, and zero such files exist across the measured project tree).

### `coversPrefix` treats a `*` token as a literal, so a blanket managed rule is invisible

`rulePrefix` (`src/managed-policy.js:35`) strips only a *trailing* ` *` or `:*`,
so a bare `*` specifier survives as the literal token `"*"` and `coversPrefix`
compares it as text. Measured: with managed `deny: ["Bash(*)"]`, the permission
`Bash(git status *)` assesses `effective` and `overridingRule` returns null,
while `shadowedByManaged` in `policy-guard.js` correctly names the deny. On a
"deny all Bash, allow specific" org policy the learner would propose and write
grants that can never fire. Worse, `rulePrefix("Bash( *)")` and
`rulePrefix("Bash(:*)")` both return null, so `readPolicy`'s `.filter(Boolean)`
drops those rules from the policy entirely.

### The drift test cannot fail for the drift it names

`src/policy-guard.js:78` hand-inlines a matcher that does not do the `:*` to
` *` normalization and does not give the trailing-`*` bare-command allowance,
both of which `permission-match.js` exists to centralize, and which
`managed-policy.js:17` notes the managed file uses *exclusively*. Measured
disagreements: `permissionMatches("Bash(docker ps)", "Bash(docker:*)")` is
false where the canonical matcher says true; same for `Bash(head -n 5 x)` against
`Bash(head:*)` and `Bash(git)` against `Bash(git *)`. So `shadowedByManaged`
reports a shadowed allow entry as healthy.

`test/policy-guard.test.js:187` claims to guard exactly this ("the guard matcher
does not drift from the review matcher") but compares `policy-guard`'s copy
against a *third* hand-copy in `vscode-extension/autoLearnUi.js`, never against
`permission-match.ruleMatches`, and none of its eight cases uses the `:*`
spelling. The two copies agree with each other while both diverge from the
canonical one. This is the "a control that cannot fail is not a control" case in
its purest form and should be fixed before the matcher itself.

### Two-fifths of resolvable Codex evidence is discarded

`structuredResultStatus` (`src/history-adapters.js:153-158`) uses a
single-quote-only character class (`/[']exit_code[']/`) where `['"]` was meant,
and the bare `/\bexit_code\s*[:=]/` cannot match `"exit_code":0` because the
closing quote sits between key and colon. `explicitNestedShellStatuses:565` only
looks for `Exit code: N`.

Measured on a real `~/.codex/sessions` (last 40 rollouts, 3,365 outputs): 949
carry `Exit code:` and parse, **690 say `Script completed` / `Script failed` and
parse as `unknown`**, 476 are genuinely still running. `auto-learn-manager.js`
then drops every `unknown` as not-evidence, so roughly 40% of the resolvable
Codex signal never reaches a candidate.

### One transient file error aborts an entire scan

In `scanHistoryFiles`, the primary `readRange` calls sit at
`src/history-adapters.js:936,944,951` while the per-file `try` does not open
until `:954`. The scanner enumerates all files up front and then reads them over
a measured 9.7 s, so a transcript deleted, locked by AV, or hitting EMFILE inside
that window throws out of `scan()` and out of `locked()`, and `save(state)` never
runs. Confirmed by injecting EBUSY on the middle of three files: the scan threw
and zero cursors were returned. Every already-parsed file's progress is
discarded, and the extension's exponential backoff then stretches to 60 minutes,
so Auto Learn quietly stops learning.

Related: a file whose *parse* fails gets no cursor at all when it has no prior
one (`:985-988` writes only `if (prior)`), so it is re-read in full on every
scan forever, and a per-file error does not trip the backoff, so nothing
surfaces but a count in `lastScanStats.errors`.

### `inert` withholding is display-only; apply writes the grant anyway

`clone` (`src/auto-learn-manager.js:662`) excludes `'claude'` from
`eligibleTargets` when the verdict is `inert`, but `applyUnlocked` never consults
policy: the only gate is `claudeEligible`, which just asks whether a permission
string rendered. `scan()` in `auto-safe` mode calls `applyUnlocked` directly,
bypassing `clone` entirely, as does `--learn apply`. So with managed
`ask: ["Bash(docker:*)"]` and an auto-safe `Bash(docker exec *)` candidate, the
listing says `eligibleTargets: []` and `settings.json` gets the entry.
`docs/claude-code-permissions.md` claims inert families are withheld;
`test/managed-policy.test.js:72-111` asserts only `eligibleTargets`, never the
write.

### `--learn apply` can die with a raw TypeError

`renderClaudePermissions` (`src/auto-learn-manager.js:983`) guards
`state.candidates[key]?.autoSafe` with an optional chain and then uses the same
possibly-absent value unguarded on the right of the `||`. Reachable because
`sanitizeState` drops a candidate its validator rejects while keeping every key
in `applied.claude`/`reviewed.claude` verbatim. Measured: throws
`Cannot read properties of undefined (reading 'claudePermission')`. The Codex
sibling at `:997` tolerates it and returns false.

### Extension lifecycle leaks

- `registerLocalWatchers` (`vscode-extension/extension.js:1542`) pushes each
  watcher into both a local array and `context.subscriptions`, and only the local
  array is drained on re-attach. `attach()` re-runs on every workspace-folder
  change, so `context.subscriptions` accumulates disposed watchers until
  deactivate. `memoryLint.js:174-198` has the correct pattern.
- Three sites create an `OutputChannel` per invocation and never dispose it
  (`:345`, `:1109`, `:1332`), one of them a palette command with no call limit.
  `memoryLint.js:141` shows the intended one-channel-in-activate pattern.
- `deactivate()` clears six timers and misses two: `gatesBounce` (`:1769`, whose
  callback spawns Python) and the anonymous `setTimeout(autoSyncRecallIfStale,
  10000)` at `:1712`, whose handle is never captured.

### Corrections to this file's own growth baseline

Measured, so the earlier entry above should be read against these:

- **Cursors do shrink.** `scan()` replaces `state.cursors` wholesale from a set
  built only from files found on disk. Mutation-tested: 3 transcripts gave 3
  cursors, deleting 2 and rescanning gave 1. Live: 710 cursors against exactly
  710 files, zero orphans. Each entry is 352 bytes, not ~60 (two SHA-256 hex
  digests).
- **Cursors are not the size driver.** `observationHashes` is 2.51 MB of the
  3.56 MB file (67%) and is sitting exactly at its 20,000 cap. Cursors are 250 KB
  (7%), candidates 111 KB (3%).
- **`state.candidates` is the one uncapped structure that never shrinks.** No
  `delete` anywhere and no limit. The open-ended axes are `webfetch:<host>` (one
  per domain ever fetched) and `mcp:<server>__<action>`. 285 entries today.
- Also unbounded on disk: `~/.claude/wildcarding/backups`, one `.bak` per changed
  target per apply, referenced only for the newest set. 14 files, 99 KB, so about
  1.6 MB/year at the observed rate.

### A single transcript will eventually exceed the 512 MB string limit

`parseHistorySlice` does `buffer.toString('utf8')` on a whole file, which throws
`ERR_STRING_TOO_LONG` past `MAX_STRING_LENGTH` (536,870,888 on Node 24). Largest
transcript measured is 70.4 MB and a session file only grows. Peak RSS is roughly
4x file size (286 MB while scanning that one file; 508 MB for a full-corpus
pass), because the code holds the Buffer, then the whole string, then a split
array of every line. An `onObservation` callback instead of one returned array
would cap the retained half; streaming by line would cap the transient half.

### Small, confirmed, no urgency

- Dead: `mineWildcard` (`src/permissions.js:171`), `readConfig`
  (`src/codex-max.js:107`), `readAllow` (`vscode-extension/extension.js:120`),
  the exported alias `DEFAULT_POLICY_LOCK_STALE_MS`, and the option keys
  `claudeHistoryPath` / `codexHistoryPath` / `validateCodexRules` (one occurrence
  repo-wide each).
- `manager.getStatus()` / `getCandidates()` / `list()` fallbacks in
  `extension.js:891,898,938` can never run: they are aliases of the functions
  checked first, and no test injects a partial mock.
- `verdicts.unknown` can no longer be non-zero, and the whole `verdicts` object
  is read by no production code (only `--learn status` JSON and tests).
- `--guidance off` sweeps only the shell-style block, and the install/uninstall
  scripts never touch instruction files, so an accepted derived block is orphaned
  after an uninstall with no command that removes it.
- The Codex validator's temp file is created before the `try` whose `finally`
  unlinks it (`src/auto-learn-manager.js:496`), so a failed write orphans it.
- `policyCache` has no invalidation path from the managed-policy watcher, so
  `status()` reports a stale verdict between a policy change and the next scan.
- `rebuildManagedHits` is not in `auto-learn-worker.js`'s allowed operations, so
  a UI-triggered rebuild would block the extension host.

### Inert bookkeeping candidates

Around a quarter of candidates are complex with no permission, so they can never
render a rule, never appear in Review, and cost no prompts: shell keywords
(`for`, `done`) and quoted-executable basenames. Masking is not at fault, checked
against bash heredocs and both PowerShell here-string forms. Cosmetic only.

## Deferred by the maintainer

### The 13 blanket wrapper grants in the starter pack

`Bash(bash|sh|python|python3|node|npx|pwsh|powershell *)`, `PowerShell(& *)`,
`PowerShell(python|python3|powershell|node *)`. Each is an arbitrary-execution
grant, the learner refuses to propose these exact shapes, and the Codex exporter
rejects one of them as "too broad" while the Claude seed installs it. Left in
place on the maintainer's call 2026-09-03. Note that auto mode discards most of
this class at load, so they are inert there and live in manual, which is the mode
MAX switches to.

### An audit of a live allow list

Turning the same measurement on a real ~300-entry list to report which entries
are broader than the evidence supports. Offered and deferred.
