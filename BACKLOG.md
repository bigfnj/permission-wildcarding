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

The allow/deny backup is mirrored off-tree. Added 2026-09-09 after the event
below: the primary copy at `~/.claude/backups/allow-list.latest.json` sits inside
the directory it exists to survive the reset of, which is why the 423 live entries
came back that day on the extension's in-memory copy rather than off disk. It now
dual-writes to `~/.permission-wildcarding/allow-list.latest.json`, overridable via
`permissionWildcarding.backupMirrorPath` for another volume; restore reads the
primary and falls back to the mirror.

Mutation-tested rather than merely green, since three of the four assertions are
about a second file that a naive implementation writes anyway: dropping the mirror
write kills 3 tests, dropping the read fallback kills exactly the recovery test,
and replacing the fallback with a **union** kills exactly the stale-mirror test —
that last one added because the fallback-not-union decision was initially
untested, and a union would resurrect a deliberately pruned entry. Suite 290
tests, 289 pass, 1 POSIX-only skip, 0 fail.

## Open

### Nothing at all protects the transcript or memory corpora

Same event, and this is the expensive half. `~/.claude/projects/**/*.jsonl` went
to **7 files / 6 MB**, oldest 18:57 that day — and the sharpest measure of that
is in this file: the `state.candidates` entry below recorded **710 cursors
against exactly 710 files** on 2026-09-09, hours earlier. So 710 transcripts
became 7. The corpus behind every measurement this project has published (largest
single transcript 70.4 MB, 6,870 observations, 249 runs) is gone. The file-memory
corpus went to one memory with zero standing orders, taking the 6 compiled gates
with it.

Two knock-on effects worth knowing before trusting anything derived from state:
the learner rebuilt from what survives, so `candidates` is 50 where that entry
says 285, and `observationHashes` is 352 where it was capped at 20,000. **Every
numeric trigger in this file is now far from firing for the wrong reason** — not
because the pressure eased, but because the evidence was deleted.

`recall.py` already supports `RECALL_MEMORY_DIR`, so pointing the *reader* off-tree
is supported. It does not solve it alone: Claude Code writes memories to
`~/.claude/projects/<workspace>/memory/` and that path is not configurable, so
durability needs the directory itself to live elsewhere (a junction to a git repo
on `D:` keeps both defaults intact and survives a reset as data plus one junction
to recreate). The corpus is private, so it must not go in this public repo.

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

**Trigger: revisit when a split family would cross the threshold on its combined
count while both halves sit below it.** Largest split seen is 15 runs, and
nothing is currently blocked by it.

### State file growth: cap `state.candidates`

Corrected 2026-09-09. The earlier version of this entry named cursors as the
uncapped structure and that was wrong: `scan()` replaces `state.cursors`
wholesale from a set built only from files found on disk, so a deleted
transcript's cursor is dropped. Mutation-tested (3 transcripts, 3 cursors;
delete 2, rescan, 1 cursor) and confirmed live at 710 cursors against exactly
710 files, zero orphans. Cursors are also not the size driver:
`observationHashes` is 2.51 MB of a 3.56 MB file and sits exactly at its 20,000
cap, while cursors are 250 KB and candidates 111 KB.

`state.candidates` is the one persisted structure with no cap and no eviction:
no `delete` anywhere and no limit constant. The open-ended axes are
`webfetch:<host>`, one per domain ever fetched, and `mcp:<server>__<action>`.

**Trigger: revisit when the count passes 1000.** It is 285 today. Deferred
because eviction needs a decision about losing evidence, and a candidate is the
only record that a family was ever observed.

Also unbounded on disk, separately: `~/.claude/wildcarding/backups`, one `.bak`
per changed target per apply, referenced only for the newest set. 14 files,
99 KB, roughly 1.6 MB/year at the observed rate.

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

## Left from the 2026-09-09 audit

Five parallel read-only audits over the whole repo, measured on a real machine
(712 transcripts, ~920 MB; 317-entry allow list; 3.7 MB state file). Eight items
were closed by the v1.4.0 burn-down and removed from this file; what follows is
what was deliberately left.

### Prune `applied`/`reviewed` keys against the candidates

The v1.4.0 crash fix guards the read rather than removing the orphan, so a key
whose candidate `sanitizeState` dropped still sits in `applied.claude` and
`reviewed.claude` forever. `pruneObservationHashes` already does exactly this
reconciliation for observation hashes and is tested, so the shape is known.

Not done because dropping an applied key discards claims-registry provenance,
which is what stops one workspace revoking another's grant. **Trigger: do it if
an orphaned key is ever observed causing anything beyond the crash that is now
guarded.**

### Two things the burn-down proved about this file's own claims

Worth keeping because both were wrong here for a while:

- The drift-test entry said `test/policy-guard.test.js` compared against a third
  hand-copy in `autoLearnUi.js`. That was true once; commit `5566628` replaced
  it with a delegation, so the test did reach the canonical matcher and STILL
  could not fail, because all eight of its cases happened to agree. A test can
  be vacuous without being wired wrong.
- The Codex entry said ~40% of resolvable evidence was discarded, from a probe
  that counted output payloads. Re-measured with the real parser: 30 of 6,870
  observations, 28 of them failures, and no candidate changed disposition. Count
  the thing the code counts, not the thing that looks like it.

### A single transcript will eventually exceed the 512 MB string limit

`parseHistorySlice` does `buffer.toString('utf8')` on a whole file, which throws
`ERR_STRING_TOO_LONG` past `MAX_STRING_LENGTH` (536,870,888 on Node 24). Largest
transcript measured is 70.4 MB and a session file only grows. Peak RSS is roughly
4x file size (286 MB while scanning that one file; 508 MB for a full-corpus
pass), because the code holds the Buffer, then the whole string, then a split
array of every line. An `onObservation` callback instead of one returned array
would cap the retained half; streaming by line would cap the transient half.

**Trigger: revisit when any single transcript passes 200 MB.** Largest is
70.4 MB today, so there is roughly 7x headroom, and the fix is a rewrite of the
code path every other feature depends on.

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
