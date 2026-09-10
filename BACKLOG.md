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

### processAllowList is quadratic, and it is now the whole hook cost

Measured 2026-09-09 on the 423-entry live list. The hook is **141.9 ms median**
(n=12), decomposing as ~50 ms bare node + 21.5 ms module load + **55.9 ms
processAllowList** + ~0.2 ms file I/O. Of that 55.9 ms the generalize+dedupe step
is **0.109 ms** and the two coverage scans are **~52 ms** —
`src/permissions.js:204-207` (prunePermissions) and `:214-220` (the generalize
gate), together **348,588 RegExp.test() calls per pass**.

The v1.4.0 memoization fixed *compilation* (423 compilations for 423 unique
rules, verified still holding). Execution was never touched and is now 99.8% of
the pass. It is textbook quadratic on a list that only grows — 316 to 423
historically — measured: n=100: 3.0 ms, 200: 10.7, 423: 52.7, 600: 111.6,
841: 254.2. Worse, the live list is already a fixed point (the pass deep-equals
its input), so the common hook call spends 56 ms proving nothing changed.

A prefix-index fix was prototyped and measured: 396 of 423 entries have the shape
`Tool(prefix *)`, which covers a specific iff it is a string prefix, so no regex
is needed. Index those in a Map, walk the candidate's own token prefixes, fall
back to the existing scan for the other 27 shapes. **55.94 ms to 4.31 ms (13x),
0 of 423 cover-set mismatches** against the full scan, no new state, no change to
the match-cache key. One subtlety to preserve: prunePermissions uses index
inequality `i !== j`, which only equals string inequality because the pass dedupes
through a Set first. The same helper serves the two other `isCoveredBy` pools
(`local-settings.js:73`, `policy-guard.js:117`).

**Deliberately NOT done in this session.** This is the coverage algorithm that
decides which of the user's permissions get pruned, in a tool whose whole job is
writing a security boundary. It was escalated to the owner rather than landed
alongside eleven other changes, and it wants its own change with an exhaustive
old-vs-new equivalence test over the real list plus generated shapes.

### The extension recomputes the same quadratic pass twice per settings write

`vscode-extension/extension.js:2145` (runWildcarding) computes processAllowList,
then `dashboard?.refresh()` at 2159/2163/2174/2193 reaches `:2674`, which
computes the identical value again: **2 x 56 ms per settings.json write**, on the
extension-host thread.

Same function, separate point: `refresh()` is the **only** handler in that file
with no bounce timer — memBounce, gatesBounce, policyBounce, localDrainBounce and
autoLearnBounce all exist — and it has ~35 call sites, several from watcher pairs
that fire together (codexWatcher onDidChange + onDidCreate at 1748-1749,
bundleWatcher x3 at 1762-1764). Each call also does ~10 synchronous file reads
and, via `localCardData()` at 2316, a full drain dry-run per workspace folder
holding a settings.local.json.

### The stat-keyed policy cache is paid per candidate, not per call

`src/auto-learn-manager.js:700` — `clone(item, known)` calls `managedPolicy()`,
and `candidatesFrom` (`:716`) maps clone over every candidate, so one
`status()`/`list()` does N stats where 1 would do. `apply()` calls it twice per
selected item (`:1117`, `:1120`). statSync measured at **36.2 us** here, so
~10.3 ms per listing at the historical 285 candidates, 1.8 ms at today's 50.

The stat-keying itself is correct and deliberate — it fixed a stale-verdict bug
in this same session. This is only about paying it once: hoist `managedPolicy()`
into candidatesFrom and pass the policy into clone.

### Scan re-reads and re-hashes the same 8 KB per unchanged file

`src/history-adapters.js:995-997`. `safeContinuation` reads head+tail (4096 B
each) and hashes both against the prior cursor; `cursorForFile` then calls
`fingerprintFile`, which reads **the same two ranges again and re-hashes them**.
On the unchanged path `stat.size === prior.size` and the hashes just matched, so
the new fingerprint is provably identical to the prior one and can be built from
it plus the stat already in hand, with zero I/O. Measured **131.3 us per file**,
so ~93 ms per scan at the 710-file corpus that used to exist. Runs on the
5-minute timer, every debounced transcript write, and every `--learn scan`.

### Buffer.byteLength per line is 30% of the JSONL parse

`src/history-adapters.js:120`, the hottest frame in the profile (26.0% self,
198 ms of a 764 ms scan). `parseJsonlRecords` already accepts a Buffer (`:113`)
and immediately stringifies it, discarding the byte-exact offsets it then spends
27 ms recovering. Splitting the Buffer on byte 10 makes offsets free and skips
decoding blank or unparseable lines: measured 90.8 ms to 60.1 ms over 19.5 MB /
8,148 lines. A contained subset of the deferred streaming-parser item (trigger: a
200 MB transcript), not a new direction, and it also cuts the peak retention
behind the 4x-RSS note.

### Smaller measured perf items, none urgent

- `src/policy-guard.js:117` — `missingFromLive`'s cover fallback is quadratic
  when backup entries are not present verbatim in live, which its own comment
  calls "the normal state". 0.13 ms today because the Set fast path hits;
  **15.5 ms** measured with no verbatim hits. Same prefix-index fix.
- `src/local-settings.js:73` — `grantedBy` does `allow.includes(entry)` (linear;
  should be a Set) plus a linear cover scan, per local entry, twice via
  `redundantUnder`. Drain path only.
- The drain path in `bin/wildcard-perms` reads settings.json 4 times and runs
  processAllowList twice per drain.
- `src/policy-exporters.js:537` (also 476, 677) — `new RegExp` inside a nested
  loop; five hoistable constants. Codex-validator path only.
- `src/managed-policy.js:164/184/185` — `[...deny, ...ask]` spread twice per
  assessed permission, and `coversPrefix:69` re-lowercases both sides of every
  token comparison when the rule side could be lowered once at rulePrefix time.
  4.48 to 2.36 ms per 285 candidates against 300 rules. Managed boxes only.

**Checked and NOT worth doing**, recorded so it is not re-derived: the
per-observation `aggregateObservations([obs])` at `auto-learn-manager.js:1369`
looks like a batch-function-in-a-loop but measured 53.29 ms vs 50.21 ms batched
over 1,422 observations (6%); `new RegExp` at `history-adapters.js:429` never
appears in the CPU profile; multiple `readSettings()` per extension event is
0.127 ms each and the freshness is deliberate and documented; the double
JSON.stringify compare is 0.038 ms; `memory/recall.py` has no hot-path issue,
since build_or_update already gates re-embedding on mtime+size.

### The extension can outlive its own async work

Four related findings from the 2026-09-09 leak audit, all CONFIRMED, none fixed —
they share one root cause and want one lifecycle guard rather than four patches.

- **No ChildProcess handle is ever retained** (`extension.js:788`, `:2492`,
  `:751`, `:1309`). Clearing the timers stops a spawn from *starting* after
  deactivate; it does nothing once the timer has fired. recallSyncTimer fires at
  T+10 s, so a reload at T+11 s leaves `execFile(python, [...],
  {timeout:180000})` running with its return value discarded — up to 180 s of
  Python outliving the extension, whose callback then touches a torn-down
  dashboard. Sharper for gates: gatesBounce to compileGates (60 s) to
  `.then(() => ensureGates())` to setGatesAll, which **writes the user's
  instruction files after deactivate**.
- **No teardown guard exists.** Grepping for deactivated/isDeactivating/
  shuttingDown hits comments only. `deactivate()` nulls outputChannel and nothing
  else: dashboard, statusBar, policyLock, autoLearnManager, autoLearnCardCache,
  autoLearnWorkerRunner and autoLearnBusy all survive. Within a session that is a
  stray toast and a postMessage into a dead webview. Across a same-realm
  re-activate it is worse: `deactivating` is sticky
  (`autoLearnWorkerRunner.js:13,73`) and the singleton is never nulled, so every
  later Auto Learn op rejects "Auto Learn is deactivating" **forever**, and a
  deactivate landing mid-scan leaves autoLearnBusy true so every later scan
  short-circuits. No test can see it: the activation tests delete the module from
  require.cache between cases.
- **The deactivation drain has no deadline** (`autoLearnWorkerRunner.js:79-82`).
  `await Promise.allSettled([...jobs])` runs *before* any terminate() and no
  layer sets a per-job timeout, so a worker wedged on a large transcript makes
  deactivate() never resolve — a stalled window reload — and the thread is never
  terminated because terminate() is only reached after the drain. Also
  `workers.delete()` lives only in the exit handler, so a worker that errors
  without exiting sits in the set for the session. **Deliberately not changed:**
  the drain is documented as existing so JS rollback stays available, and a
  deadline that cuts a policy write is worse than a slow reload. atomicWrite is
  temp+rename, so a terminated write leaves a temp file rather than a corrupt
  settings.json, which makes a generous deadline defensible — but it is a
  semantics change to teardown and wants its own decision.
- **Cancel targets the wrong request** (`extension.js:681-683`).
  `token.onCancellationRequested(() => activeReq?.destroy())` only ever holds the
  outermost httpsGetFollow return, while httpsGetFollow (`:626-639`) builds a
  fresh req per redirect and surfaces none of them. The comment at 620-623 says
  the model's /resolve/ URLs always 302, so **Cancel is a no-op on every real
  download** and the 32 MB transfer runs to completion. No deactivate path either.

### 42 dead export names, and 6 option keys with no supplier

Verified 2026-09-09 by loading every module and diffing declared exports against
all references across `src/`, `bin/`, `vscode-extension/` and `test/`. Every
internal import in this repo is destructured and there is no namespace-style
require of an internal module in production code, so textual absence really does
mean unused.

The functions themselves are live inside their own modules; only the
module.exports entry is dead, so removing the name is safe and free. Largest
concentration is `src/permissions.js` (14 of 33 exports), then `codex-max.js`
(4), `agent-guidance.js` (3), `memoryLint.js` (3), `autoLearnUi.js` (3), with
singles across agent-gates, local-settings, permission-match, recall-index,
derived-guidance, exec-resolve, tool-learn and mirror-pack. A separate set is
**test-only** — real consumers, just not public API — and should be labelled
rather than removed.

Six option keys are read with zero suppliers anywhere including tests, each
leaving an unreachable branch: `managedPolicyPath` (3 reads, 0 writes),
`defaultTool` (makes `history-adapters.js:662` an unreachable early return),
`priorCursors`, `busyMessage` (`policy-lock.js:43-45`), and `homeDir` /
`successThreshold` — the last two unreachable because `extension.js:887-888` sets
both spellings on the same object, so the `||` and `??` legs never fire.

Also unreachable: `extension.js:996-997` (`typeof manager?.overview ===
'function'` is always true, the same shape as the three fallbacks already
recorded here), `policy-exporters.js:650-652` (a mergeClaudeAllow overload shim
nobody calls with an object third argument) and `:658-661` (that third parameter
is vestigial in production; only a test passes a function).

Two corrections to this file's own claims: `list:` at
`auto-learn-manager.js:1549` has **zero** consumers anywhere, so it is dead on
both sides rather than merely an unreachable fallback; and "verdicts.unknown can
no longer be non-zero" is **half wrong** — the `!policy.present` path is provably
dead, but `managed-policy.js:162` (`!toolOf(permission)`) is reachable, because
sanitizeState truncates claudePermission to 768 chars, which can cut the closing
paren and fail RULE_SHAPE.

### Duplication worth collapsing

`permissionMatches` exists twice with **byte-identical** bodies —
`src/policy-guard.js:91-93` and `vscode-extension/autoLearnUi.js:111-113`, each
one line delegating to ruleMatches. `test/policy-guard.test.js:192` exists to
catch drift *between the two implementations*, and since neither has independent
logic left, that half of the test can no longer fail: it is now purely a
correctness test of ruleMatches. Collapsing autoLearnUi onto the policy-guard
export removes a wrapper and the pretense of a second implementation.

`policy-lock.js` carries two busy strings for one condition —
`POLICY_LOCK_BUSY_MESSAGE:20` and the default `busy()` at `:45` — and the thrown
`conflict.message` is discarded by every consumer (`extension.js:2079`, `:2250`,
`bin/wildcard-perms`), all of which substitute the constant. With the dead
`options.busyMessage` above, the whole indirection collapses to the constant.

(Not a defect, noted so nobody "fixes" it: the duplicated
AUTO_SUFFIX_CLOSED_ROOTS and the two SAFE_GIT lists are deliberate and
drift-tested, documented in both export comments.)

### Declared-but-unwired UI, and an uninstall that cannot uninstall

Cross-referenced 2026-09-09; the four headline diffs came back clean (18 of 18
commands registered, 4 of 4 menu entries resolve, 16 of 16 config keys read, 8 of
8 CLI verbs documented), so these are the residue.

- **`uninstall.sh` cannot undo `install.ps1`, and reports success anyway.**
  `install.ps1:15` writes the hook as `node "<path>"`; `uninstall.sh:19` filters
  on the **bare** path, so it can never match. Worse, the write and the
  "hook removed" message at `:25-26` are both **outside** the `if`, so it always
  claims success. There is no `uninstall.ps1` at all, yet `README.md:102-107`
  presents install.sh / uninstall.sh / install.ps1 as a matched set — Windows
  users have no working uninstall path.
- **Two config groups have no change listener.** affectsConfiguration covers
  autoLearn, localDrain and guidance only. Flipping
  `permissionWildcarding.gates.enabled` in the Settings UI does nothing until a
  reload, and `memoryLint.js` has **no** onDidChangeConfiguration at all, so the
  four `memory.*` keys are picked up only by the 5-minute reconcile or a
  save/open event.
- **Two dead webview switch arms**: `extension.js:2635` (autoLearnApply) and
  `:2637` (autoLearnMode) have no sender. All 16 `type:` literals were
  enumerated; the element ids alApply/alMode do not exist. Two dashboard buttons
  were removed and their handlers left behind. Both features remain
  palette-reachable, so this is dead dispatch, not lost functionality.
- **`extension.js:17-34` hard-requires `./src/*`**, which .gitignore excludes and
  scripts/package.mjs creates only at package time. Self-documented as a known
  asymmetry in `autoLearnUi.js:5-16` ("extension.js gets away with ./src/ only
  because its one test installs a Module._load hook"), and the same file handles
  the identical problem correctly for Python via a two-path probe. Low impact —
  no `.vscode/launch.json` exists, so a fresh checkout has no F5 path — but it is
  literally a require of a path absent from a clean clone.

### The release harness is gitignored, so its fixes are unversioned

`.gitignore:32` excludes `scripts/verify-release.ps1` because it hardcodes this
machine's corpus paths. Consequences, all realised: it had never been run for
v1.3.0, v1.4.0 or v1.4.1; nobody else can run it; and the four fixes made to it
on 2026-09-09 — an unreachable lint check, a self-contradicting SessionStart
note, a **crash** on a 0-byte compiled-gates file, and a stale eyes-only
expectation — live only on this box. Parameterize the machine-specific paths
(corpus root, the two probe repos, the gated-memory filename) and commit it.

### The dashboard has no test coverage at all

No test calls resolveWebviewView. WildcardingViewProvider is not exported
(`extension.js:3213` exports only activate/deactivate), and refresh() pulls in
processAllowList, a MEMORY.md read per store and a per-folder drain dry-run, so
it cannot be driven cheaply. That is a class with ~35 refresh call sites and
every user-facing control in it, verified only by eye. Exporting the provider (or
a factory) purely for test is the cheap unlock; the webview-disposal fix landed
2026-09-09 had to go in untested for exactly this reason.

### The memory convention and this project's lint disagree about `scope:`

`recall.py --lint` reports "type: feedback with no scope:" as actionable, since
the gates compiler cannot place such a memory. But the memory-authoring
convention Claude Code itself follows defines frontmatter as
name/description/metadata.type with **no `scope:` key**, so every feedback memory
written the normal way trips this check on arrival — observed immediately on
2026-09-09 with a newly written memory. Either the lint should treat a missing
scope on `feedback` as "not a gate, no action", or the convention needs to carry
scope. As it stands, the lint's one actionable finding class is guaranteed noise.

### Small, off-axis, confirmed

- `scripts/auto-mode-audit.js:95` deletes the sandbox before `:97-104` returns
  `sandbox` in the report, so report.sandbox names a deleted directory on every
  run without `--keep`.
- `src/policy-lock.js:92-96`: if openSync succeeds but writeFileSync/fsyncSync
  throws, removeOwnedLock cannot JSON.parse the empty file and returns false,
  orphaning the lock until the staleness path reclaims it.
- `package.json` declares `engines: node >=18`, but CI now tests 20 and 22 and
  node 18 is past end of life. Either raise the floor or test it.
- A work-domain email address appears as the author of 3 of 48 commits (all
  2026-08-21) in this **public** repo's history. Future commits are already safe:
  the global git identity is a personal address. Rewriting history was declined —
  it breaks the v1.4.1 tag and the published release SHA, and cannot un-publish
  what is already cloned, cached and forked. Recorded as the owner's decision to
  make, deliberately without restating the address here, since this file is
  public.

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
