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

Tiers 1-3 of the 2026-09-09 audit are burned down, 2026-09-10. Thirteen entries
above were removed as closed; the commits carry the mutation results that justify
each. Headlines, all measured on this machine:

- **The hook locks and rebases.** It was the highest-frequency writer of
  settings.json and the only one that neither locked nor re-read. Two phases now:
  the unlocked read is a negative test only, and the changed path takes one lock
  covering both the write and the drain, discards the snapshot and recomputes
  inside it. Replaying the delta instead would have lost a permission outright —
  `Bash(npm test)` granted while MAX was on, marked removed by the stale pass and
  deleted after `--max off` deliberately preserved it. Interleaved measurement,
  n=14 each: min 157 / median 175 ms before AND after, so the common path is
  unchanged.
- **processAllowList: 57 -> 6 ms warm, 85.8 -> 11.6 ms cold** at 423 entries, and
  the same index now serves the other two coverage pools (policy-guard's worst
  case 15.5 -> 6.47 ms). `isCoveredBy` is untouched and still decides every
  answer; the index only narrows, so only a false negative could change a result.
  The differential test found one on its first run — `Bash(rm -rf /*)` has its
  star inside the last token — which is why token-misaligned rules go to the
  linear fallback.
- **Codex evidence is observable again.** `extractNestedShellCommands` accepted
  only `tools.shell_command` while `auto-learn.js` already knew `exec_command`, so
  current Codex transcripts yielded ZERO observations in every mode. Fixing the
  extractor alone was not enough: `customExecCanAttributeSuccess` matched the same
  narrow set, which would have left every call permanently `unknown` and
  `counts.success` at 0. Append-mode `cwd`/`session` are now re-seeded by reading
  forward to the first newline — a fixed-size read cannot work, because the real
  `session_meta` line is 22,095 bytes of Codex system prompt.
- **The extension no longer outlives its own async work.** One `deactivated` flag,
  released on re-activate; all four `execFile` children tracked and killed; the
  worker runner nulled and the busy latch cleared, so a same-realm re-activate is
  not permanently stuck rejecting "Auto Learn is deactivating".
- **The dashboard is under test at all** — 8 tests including a permanent backtick
  guard over the `_html` template literal, after three syntax breaks came from
  one. No production export was needed: capturing argument 2 of
  `registerWebviewViewProvider` was the whole unlock.
- **The release harness is committable**, parameterized by four environment
  variables with auto-discovery, and verified both configured (16 PASS) and
  entirely bare (14 PASS, 6 INFO) so a fresh clone gets skips rather than red.

Suite: **297 -> 337 passing**, 2 platform skips, 0 fail, CI green on ubuntu and
windows x node 20 and 22.

## Open

### ~~`--max` and `--bypass` still spread from their own read~~ — FIXED 2026-09-10

Closed, and the entry was incomplete: it named two callers when there were
**three**. The extension's `toggleMax` had the identical read-compute-write shape
and is the one this entry missed.

All three now go through `createSettingsWriter().writeTransform`, which re-reads,
runs the transform against that read, and **compare-and-swaps on the raw bytes**
with up to three attempts. The CAS is the part that matters and it is not what
this entry would have led someone to build: a rebase alone closes nothing here,
because the expensive work happens INSIDE the transform — `enableMaxAllow` runs
`processAllowList`, measured 9.61 ms cold at 435 entries — so the read-to-write
window survives any amount of rebasing. `auto-learn-manager` already used the CAS
pattern for its own transactional write.

`writeSettings` is deleted. Its two callers were these verbs, and removing the
primitive matters as much as fixing them.

Residual, deliberately left: `--max status` and `--bypass status` still use
`readSettings() ?? {}` and so report `OFF` for a file they could not parse. Not
destructive — no write — but a wrong answer stated confidently. One line each if
someone wants it.

**Do NOT file `auto-learn-manager`'s whole-object write as a fourth instance.**
It is a different shape: it verifies `unchanged()` twice and throws rather than
writing, holds the lock across read and write, and takes per-target backups.
Rebasing it would break its transaction, because `updateClaudeClaims` computes
the claims registry from the list it read.

### The coverage index's residual cost, and the trigger that replaced the old one

Live split is now 401 indexed / **3** fallback (2026-09-10), after star-free rules
were dropped from the pool entirely — they cannot cover anything, and 20 of the
previous 23 fallback entries were star-free. Cold `processAllowList` measured
~12.5 -> ~9.3 ms in matched processes.

The residual cost is O(n x fallback), because a rule with a glob INSIDE a token
(`Bash(g* *)`, `Bash(mkfs* *)`) cannot be found by a literal-prefix lookup. That
class is still quadratic — measured n=1600 at 238.5 ms — but it **cannot grow from
this tool's own operation**: `generalizePermission`/`mineWildcard` only emit
`Tool(root *)` with root matching `/^[A-Za-z][\w.-]*$/`, so no `*` can land inside
a token. The live count is 3, all `mcp__*__*`.

So the old "revisit if the fallback share passes ~20%" trigger is retired: the
number that could actually grow was the star-free count, and it is gone.
**New trigger: revisit only if `stats().fallback` exceeds ~25 entries**, which
would mean a starter-pack change or hand-written glob-in-token rules. Indexing
that class is possible (bucket on the mandatory literal prefix before the first
`*`, which the compiled regex is anchored on) but is not warranted at 3 entries.

Worth remembering how the one bug here got out: the index's whole safety argument
is that only a false NEGATIVE can change an answer, and a false negative shipped.
`coverIndexKey` treated `:` as a token boundary and `coverLookupKeys` did not, so
colon-form wildcards on non-command tools — including three `Skill(...)` entries in
`patterns/starter-pack.json` — were indexed under a key no lookup could generate,
and being indexed were not in the fallback either. The differential test's
generator only emitted `Bash`/`PowerShell`, where matching rewrites `:*` to ` *`,
so 300 random cases per run could not reach it. Fixed and covered three ways
2026-09-10. The lesson is about the CORPUS, not the code: a differential test is
only as good as the axes its generator actually varies.

### Codex: the non-nested `exec_command` shape is still unrecognized

`parseCodexJsonl` accepts only `shell_command` / `functions.shell_command` and
reads `args.command`. If Codex emits the unified-exec tool as a plain
`function_call` carrying `{cmd: ...}`, it yields no observation — the same defect
class as the nested extractor bug, on the other path. Left alone because there is
no verified sample of that shape; the fix is a name-set entry plus an `args.cmd`
fallback, two lines.

### Cursor pruning lost its only mechanism in one case

`state.cursors = {}` followed by repopulation WAS how cursors for deleted
transcripts got pruned. The blind-scan guard suspends that when a scan enumerates
zero files, which also covers a legitimately emptied root, so stale cursors linger
until a scan enumerates at least one file again. Harmless — they are consulted
only for files that exist — but the state file will not shrink in that case, and
there is no explicit pruning pass anywhere.

### sanitizeState has no version migration hook at all

`src/auto-learn-manager.js` never reads `raw.version`, so `VERSION` is write-only.
Whoever next needs a state reset will find the mechanism absent. This is not
hypothetical: it is why the Codex `session` fix accepted one bounded round of
re-counting rather than bumping the version — a bump resets nothing without new
migration code, and resetting `observationHashes` while keeping `counts` makes the
over-count worse.

### scan() does not report that it went blind

The error count is non-zero when a root fails, but nothing says "the cursor map
was preserved because nothing was enumerated". A consumer tuning retry backoff has
to infer it. The signal now exists in the data — walk failures carry
`scope: 'root'` as of 2026-09-10 — so surfacing it is a matter of adding a field
to `lastScanStats`, not of recovering information. Related and pre-existing:
`lastScanStats.prunedObservations` is written by `scan()` and dropped by
`sanitizeState`, so it vanishes on reload.

### Killing a child can orphan its grandchild

`deactivate()` now kills the four tracked `execFile` children, but `recall.py`
re-execs itself into the toolbox venv (`RECALL_REEXEC=1`), so killing the
immediate child can leave the process that actually does the embedding running. A
process-group kill (`taskkill /T` on Windows) is what would make this certain.

### Module state that still survives deactivate

Re-measured 2026-09-10: 28 module-level mutables, **9 reset** by `deactivate()`,
19 surviving. The five that held real memory are now dropped — `dashboard` and
`memoryLint` each retained the whole `ExtensionContext`, and
`autoLearnManager`/`autoLearnManagerKey`/`autoLearnCardCache` held parsed history
state, the largest thing this extension builds.

What remains is inert by inspection: eleven timer handles (`debounceTimer`,
`recallSyncTimer`, `memBounce`, `gatesBounce`, `autoLearnBounce`, `autoLearnTimer`,
`policyBounce`, `localDrainBounce`, `dashboardBounce`) which are all cleared above
— holding a dead handle costs nothing — plus scalars (`lockedRetries`,
`localDrainRetries`, `localDrainAt`, `recallRebuildAt`, `lastRun`,
`autoLearnLastError`, `autoLearnFailureCount`, `autoLearnNextRetryAt`) and two
disposed objects (`statusBar`, `policyLock`).

Two of the scalars have a real if minor effect across a same-realm re-activate:
`autoLearnNextRetryAt` carries a backoff over, and `autoLearnFailureCount` carries
the count that computes it. Not worth a change on its own; worth doing next time
this file is open.

### Test harnesses can silently assert against a frozen home

`src/*` modules capture `os` at require time and their exported helpers default
to `os.homedir()` at call time, so the SECOND harness in a test file resolves the
FIRST one's mocked home unless the file purges repo `src/` from `require.cache`.
Two files do (`local-drain-extension.test.js`, and now `dashboard-view.test.js`);
the others do not.

This already cost a real assertion. When the rebasing writer moved into
`src/settings-write.js`, the dashboard harness's scripted-read seam stopped
reaching it, and the affected test did not fail loudly — its precondition
silently became unreachable and the assertion after it went vacuous. **Audit the
remaining multi-harness test files for the same shape**; a test that cannot fail
is worse than one that does.

### restoreFromBackup still recomputes the pass twice

It runs its own `processAllowList` and then calls `refresh()`, which recomputes
it. Left alone when the watcher path was fixed, because this one is user-initiated
and rare rather than fired by a file watcher. Now cheap anyway at 6 ms, so this is
tidiness rather than performance.


### Managed-block removal can fuse the user's own lines

`src/agent-guidance.js:147-150`. Both newline sweeps eat every adjacent newline
and only the end-of-file case puts one back, against a file whose contract
(`:22-25`) is that the block is "removable without touching a byte of the user's
own text". Measured:

    CASE 1  off        -> "my own notesmore of my notes\n"     <- two user lines fused
    CASE 2  first off  -> "user preamble<!--GB-->\nGATES\n<!--GE-->\n"

Case 2 is `--guidance off` while gates or a derived block is installed, a
documented supported combination. Harmless on this box *today* only because the
live `~/.claude/CLAUDE.md` has the block at lines 1-31 with user content from 33,
so `start === 0`; any content added above the block, or any second block below
it, arms this.

Related, same file: `blockRange` (`:113-119`) takes `indexOf(begin)` then the
**first** `indexOf(end, start)`, with no guard against a body containing its own
END marker. The gates body is arbitrary user-corpus text and the derived body
embeds managed rule text, so a memory whose `<!-- gate -->` section documents
this feature — entirely plausible for someone whose memories are about their own
tooling — truncates the range; `apply(text, true)` then leaves the old body tail
plus an orphaned END marker in the file, accumulating on every toggle.

And there are **five unsynchronized writers** of that one file: CLI guidance
(`bin/wildcard-perms:422`), CLI gates (`:489`), extension guidance
(`extension.js:2367,2416`), extension gates (`:2531,2595`) and `decideDerived`
(`auto-learn-manager.js:921`). Only the last holds a lock, and it is the *policy*
lock, which none of the others take — so it buys nothing here. The extension also
recompiles gates automatically on a memory-dir change, so an automatic write can
race a manual `--guidance off`. Individually recoverable; combined with the two
findings above, a race can leave the file structurally broken. Note also that the
instruction-file backups are single-slot fixed names
(`agent-guidance.js:211`, `derived-guidance.js:308`), so two toggles in a row
overwrite the good copy with the bad one.

### Two unvalidated external inputs reach a policy or instruction file

- **Project `settings.local.json` is promoted to user scope with no trust gate on
  the CLI path.** `bin/wildcard-perms:252-266` to `src/local-settings.js:172-244`.
  `drainFromHook` takes `cwd` from the hook's stdin and promotes that project's
  local allow entries into **user-scope** allow on the next tool call. The
  extension refuses this for an untrusted workspace
  (`extension.js:2196-2201`, "an untrusted window reads but never writes"); the
  CLI has no equivalent, and VS Code trust has no CLI analogue. A repo that
  commits `.claude/settings.local.json` containing `Bash(curl *)`,
  `Bash(python *)` or `Bash(node *)` clears `PROMOTABLE` and lands in the user's
  global allow list, announced by one stderr line on a path that is "quiet by
  design". The module's bar is *portability*, never provenance. May be inherent,
  but it deserves a decision rather than an accident.
- **Managed rule text reaches CLAUDE.md unsanitized.**
  `src/derived-guidance.js:73` interpolates the rule into a code span in the block
  body. On the `inertFamilies` path the value is `String(rule)` straight from
  `~/.claude/remote-settings.json`, and `addCost`
  (`auto-learn-manager.js:787`) does **not** apply `clean()` while the sibling
  managedHits path at `:1391` does (`clean(observation.managedRule, 200)`). A
  rule containing a backtick, a newline or the END marker escapes the span or
  breaks the block. remote-settings.json is a local client-refreshed cache, so
  any local process that can write it can inject text into the user's instruction
  file, gated only on a human accepting the mitigation. Apply `clean()` on both.

### Interesting, off-axis

- **A URL reaches an observation, right next to invariant 1.**
  `src/tool-learn.js:26` returns `input.url` verbatim as `observation.command`.
  Invariant 1's assertion is `doesNotMatch(JSON.stringify(observations), /README/)`
  — about an observed *file* path — and would not catch a URL carrying a path,
  query string or token. It does not reach the state file (`candidate()` drops
  `command`) and `toolInvocation` reduces it to `host`, but the data invariant as
  tested is narrower than "no user data on an observation".
- **The writer writes a field the reader discards.** `scan()` sets
  `lastScanStats.prunedObservations` and `persistentState` writes it, but
  `sanitizeState:422-426` rebuilds only `{files, observations, errors}`. Harmless
  today, but it is the same whitelist-drift class the handoff calls out — and
  this time in the *current* version, not an older copy.
- **Auto Learn never consults the user's own deny list on the write path.**
  `applyUnlocked` checks the managed policy for `inert`
  (`auto-learn-manager.js:1103-1110`) but not `settings.permissions.deny`, so
  `--learn apply` writes an allow entry the user's own deny already blocks and
  reports it applied. `planPromotions` (`local-settings.js:84-85`) does check
  `userDeny` and withholds. Nothing unsafe — deny wins — but it is a dead entry
  and a misleading report, which is the class of bug the `inert` gate was added
  to fix.
- **`auto-mode-audit.js` cannot keep its "no credentials" promise.** `:77` passes
  `env: { ...process.env, CLAUDE_CONFIG_DIR: configDir }`. That redirects the
  config dir, not env-provided credentials, so with `ANTHROPIC_API_KEY` set the
  probe authenticates and makes a **real API call** with prompt `audit-<hex>` —
  contradicting its own lines 13-19. Strip the auth vars. Also `:52`'s JSON.parse
  is unguarded, and `:94` reads the module-level `args` from inside a
  parameterized function.
- **An invisible character is load-bearing.** `src/managed-policy.js:75` and
  `scripts/auto-mode-audit.js:52` contain the raw UTF-8 BOM bytes `EF BB BF`
  inside a regex literal rather than `\uFEFF`. Verified working, but every other
  site in the repo spells it `\uFEFF` (auto-learn-manager x5,
  policy-exporters:526). Any re-encode, normalizer or copy-paste breaks it
  silently.
- **Residual staleness in the stat-keyed caches.** `policyFingerprint`
  (`auto-learn-manager.js:621`) and `autoLearnStateStamp` (`extension.js:987`)
  key on `mtimeMs:size`, so a same-size rewrite inside timestamp granularity
  still returns a stale verdict. Far better than the lifetime cache it replaced;
  worth knowing the residual exists, since the managed policy is exactly the file
  that gets rewritten in place.
- **`mirrorBackupPath()` accepts `~` alone** (`extension.js:213-223`):
  `path.join(homedir(), '')` is the home directory itself, and the write then
  fails EISDIR and is swallowed. Cosmetic, but a configured `~` reads as valid.

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

### The deactivation drain has no deadline

The other three findings from the 2026-09-09 leak audit are now fixed — children
are tracked and killed, the `deactivated` flag exists and is checked in the three
schedulers as well as the async continuations, and the runner and busy latch are
reset. This one is deliberately left, and one new consequence of it is recorded
under the 2026-09-10 audit below.

- **The drain has no deadline** (`autoLearnWorkerRunner.js:79-82`).
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

### Declared-but-unwired UI

Cross-referenced 2026-09-09 and re-run 2026-09-10; the headline diffs come back
clean in both directions (19 of 19 commands registered, 4 of 4 menu entries
resolve, 16 of 16 config keys both read and declared, 8 of 8 CLI verbs
dispatched), so these are the residue.

Both the uninstall gap and the missing config listeners are now closed — verified
empirically 2026-09-10 under both PowerShell editions, including per-hook removal
that spares a co-located third-party hook, and `memory.enabled` taking effect both
ways without a window reload. What remains:

- **Two dead webview switch arms**: `extension.js:2814` (autoLearnApply) and
  `:2816` (autoLearnMode) have no sender. All `type:` literals were enumerated
  (16 senders, 18 arms); the element ids alApply/alMode do not exist. Two
  dashboard buttons were removed and their handlers left behind. Both features
  remain palette-reachable, so this is dead dispatch, not lost functionality.
- **`extension.js:17-34` hard-requires `./src/*`**, which .gitignore excludes and
  scripts/package.mjs creates only at package time. Self-documented as a known
  asymmetry in `autoLearnUi.js:5-16` ("extension.js gets away with ./src/ only
  because its one test installs a Module._load hook"), and the same file handles
  the identical problem correctly for Python via a two-path probe. Low impact —
  no `.vscode/launch.json` exists, so a fresh checkout has no F5 path — but it is
  literally a require of a path absent from a clean clone.

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

## From the 2026-09-10 five-agent audit

Five read-only agents were run over the day's work: regressions, dead code and
wiring, memory leaks and lifecycle, optimization, and correctness. Everything they
confirmed as a REGRESSION was fixed the same day and is not listed here. What
follows is what was confirmed and left. Note two of them independently found the
same two Tier-1 defects (the installers and the coverage index), which is worth
knowing when deciding how much to trust a single agent's report.

### The installers have no behavioural test on CI, only static guards

`test/installers.test.js` (new 2026-09-10) drives `install.sh`'s and
`uninstall.sh`'s real embedded ES modules, so the POSIX half is covered
everywhere. The PowerShell pair cannot be driven on a POSIX runner, so it gets
static guards instead: no `-AsHashtable` outside a `#Requires -Version 6`, and
both scripts must contain a refusal path. The behavioural PowerShell harnesses
exist but live in a session scratchpad and will be lost.

**Worth doing:** move them into `scripts/` and call them from
`verify-release.ps1`, or add a `windows-latest` CI job that runs them under
`powershell.exe` specifically — the defect they catch is invisible under `pwsh`.
The seam they need: `install.ps1` reads
`[System.Environment]::GetFolderPath("UserProfile")`, which ignores
`$env:USERPROFILE`, so the harness copies the script with that one line rewritten.
(An earlier version of that harness, before the seam was understood, ran the real
installer against the live `~/.claude` five times. Nothing was lost — the hook was
already registered, which short-circuits before the write — but it is the reason
the seam is documented here.)

### ~~`.gitattributes` is incomplete, and has not been applied to this tree~~ — FIXED 2026-09-10

Kept as a record because the count in the original entry was wrong and the second
half of the problem is a trap worth naming.

**It was FOUR uncovered shebang files, not three** — this entry missed
`memory/bench/bench_embed.py`. Measured CR bytes, working tree vs index, all four
with 0 in the index: `bin/wildcard-perms` 874, `memory/recall.py` 529,
`memory/bench/bench_embed.py` 446, `scripts/package.mjs` 55. The worst is
`bin/wildcard-perms`: `install.sh` chmod +x's it and registers its BARE PATH as
the hook command, so a CRLF copy on Linux gives
`env: 'node\r': No such file or directory` on **every tool call**.

`.gitattributes` now pins `*.sh`, `*.py`, `*.mjs` and `bin/wildcard-perms`
explicitly. Deliberately not `* text=auto`: the five tracked `.ps1` files have no
shebang, are Windows-only, and CRLF is correct for them — verified they still
report `text: unspecified`.

**The trap, for whoever hits this pattern again:** `git add --renormalize .` did
**not** fix the working tree. The index was already LF, so renormalize found
nothing to change and staged only `.gitattributes` itself. The working tree is
only rewritten on checkout, so it took `rm <files> && git checkout -- <files>`.
And `uninstall.sh` and `test/gates-stale.sh` were still CRLF in the tree despite
`*.sh eol=lf` having been added hours earlier — for exactly this reason. A sweep
of every `eol=lf` file now reports 0 CR across the tree.

### README claims that are now false

Checked line by line 2026-09-10:

- `README.md:36` — "`src/policy-lock.js` — the advisory lock **every** policy
  writer takes". Four `settings.json` writers take neither the lock nor
  `writeFileAtomicSync`: `install.sh`, `install.ps1`, `uninstall.sh`,
  `uninstall.ps1`. They are the only non-atomic, unlocked writers in the project.
- `README.md:70-73` — describes the pre-redesign panel ("an \"Active\" status
  card, live tallies, a **Wildcard Now** button ... a collapsible list"). The hero
  card, the stateful rows and `LIST_CAP = 12` are all undocumented.
- `README.md:541-568`, "The hook is fast now" — three problems: it still says
  `isCoveredBy` sits inside two **quadratic** passes; its quoted
  `min 103.5 / p50 109.8 ms` contradicts the interleaved
  `min 157 / median 175 ms` recorded elsewhere by ~60% with no note that they are
  different measurements; and it names `drainFromHook`, which no longer exists.
- `README.md:105-115` — presents the uninstallers under a ```powershell fence with
  no version requirement. True now, but only because `-AsHashtable` was removed.
- The CLI summary at `README.md:23-27` lists 7 of 10 verbs: `--codex-max` is
  missing (documented in its own section), and `--help`/`--version` are in
  `HELP_USAGE` but not in the README at all.

### Four test harnesses can still assert against a frozen home

The general form is already recorded above. The specific audit, 2026-09-10:
`dashboard-view.test.js`, `local-drain-extension.test.js` and
`extension-lifecycle-async.test.js` purge repo `src/` from `require.cache`.
`policy-backup.test.js`, `policy-guard-unreadable.test.js`,
`extension-activation.test.js` and `extension-managed-blocked.test.js` delete only
`extensionPath`.

Exactly five module-level paths leak from the first harness to every later one:

```
MAX_STATE_FILE       src/permissions.js:430
APPROVE_SCRIPT       src/permissions.js:435
BYPASS_STATE_FILE    src/permissions.js:351
POLICY_LOCK_PATH     src/policy-lock.js:19
CODEX_CONFIG         src/codex-max.js:35
```

**No assertion is vacuous today** — only `policy-backup.test.js` touches any of
them, and it survives because each test writes the MAX snapshot and reads it back
within itself while `writeMaxState`'s `mkdirSync(..., {recursive:true})` silently
recreates the deleted temp home. But every one of those tests is one early return
away from becoming vacuous, and the suite leaves stray directories in
`os.tmpdir()`.

### Assertions whose guarantee is narrower than their comment claims

None is vacuous — each has a nameable killing mutation — but the stated guarantee
is wider than the check:

- `test/dashboard-view.test.js:277` counts webview routes with
  `/case '[A-Za-z]+':\s*vscode\.commands\.executeCommand\(/g`. A route written
  as `case 'x': { ... }`, dispatched via a variable, or named with a digit is not
  counted, so "fails if a route is added untested" holds only for the current
  spelling.
- `test/extension-lifecycle-async.test.js:277` uses `/(?<![\w.])execFile\(/g`,
  which excludes `.execFile(` — a fifth spawn written `cp.execFile(` passes
  silently.
- `src/derived-guidance.js:57-63` says truncation is 200 chars, but the escaping
  runs AFTER `.slice(0, RULE_LIMIT)`, so `&lt;!--` expansion can push the output
  past 200. The test only measures `'x'.repeat(400)`, which never escapes.
- `test/settings-write.test.js:127` asserts `onWrite` fires once on success;
  nothing asserts it does NOT fire when `writeAllow` throws, and nothing asserts
  the CLI writer has no `onWrite` — that "deliberate rather than dropped" question
  rests entirely on a comment.
- `test/extension-lifecycle-async.test.js`'s `trackChild` check is a source-text
  scan for `trackChild(execFile(`, so a correct `const c = execFile(...);
  trackChild(c);` would fail it and a `spawn()` would slip past.

### Guidance removal still consumes one user newline at end of file

`src/agent-guidance.js:181-183` hardcodes `separator = '\n'` on the
end-of-file branch, while the install branch adds none when the file already ends
`\n\n`. Measured round trip: `"my own notes\n\n"` -> `"my own notes\n"`.
`test/agent-guidance.test.js:189-190` asserts this exact output, so it is a
deliberate-but-undocumented choice — the commit message claims byte-exactness.
Mid-file, start-of-file, adjacent-blocks and the CRLF install path all round-trip
exactly, and accumulation is stopped.

**Separate residual, no migration exists:** a file damaged by the pre-fix
inner-marker bug is not repaired. `blockRange` on a file containing
`...END ... BEGIN ...` returns null, so `has()` is false and `apply(text, true)`
appends a SECOND block, leaving the orphaned END above it and accumulating per
toggle. Only reachable for a user whose corpus quoted a marker before 2026-09-10.

### Optimization, measured and ranked

All from the 2026-09-10 pass. The hook's own sync I/O is clean — one
`readFileSync` (0.16 ms) and one `existsSync` (0.18 ms) on the common path, no
per-candidate I/O, no lock. Of a 66 ms process wall, ~50 ms is spawn + node boot
and not ours.

| Item | Measured | Frequency |
|---|---|---|
| ~~`require('./managed-policy')` is eager~~ **DONE 2026-09-10.** The figure here was wrong twice: 0.61 ms recorded, 2.3 ms predicted by a stub harness that also pre-cached `permission-match`. Measured after the change: `require('src/permissions')` 4.803 -> 3.529 ms, i.e. **1.27 ms** per hook call | 1.27 ms | per hook call |
| A fixed-point cache keyed on a CONTENT HASH of settings.json lets the hook skip the read, the module load and the pass | our-code p50 11.80 -> 2.46 ms; wall 62.3 -> 53.6 ms; 30/30 hits | per hook call |
| ~~`memoryReport()` runs TWICE per dashboard refresh~~ **DONE 2026-09-10.** "11.22 ms" was the COMBINED cost of both calls, not the saving — the second is much cheaper because the file cache and the JIT are warm. Measured directly, 11 interleaved fresh processes: one call 6.99 ms, two 9.92 ms, so hoisting saves **2.93 ms** and 25 fs syscalls | 2.93 ms | per refresh |
| `runWildcarding` takes the policy lock even on the unchanged path; the CLI hook was deliberately changed not to | lock cycle 3.72 ms of 9.60 ms, plus contention with Auto Learn | per settings.json write |

Two notes worth keeping. The fixed-point cache **needs a decision, not just
work**: it adds a new cache file on the hook path. Use a pure-JS hash, not
`crypto` — `require('crypto')` alone is 3.5 ms and ate 40% of the win. Every
failure mode is "miss -> full pass", and a forced-miss run measured 15.72 vs
18.28 ms, so there is no cold-path regression.

And the opposite conclusion for the extension, recorded so nobody applies the
hook's lesson by analogy: its eager requires are **not** worth making lazy.
Activation is 31.4 ms of requires plus 53.5 ms of `activate()`, paid once per
window at `onStartupFinished`.

### Dead exports and unreachable options, re-measured

The recorded "42 dead export names" still holds as a count; the composition moved
(`enableMaxAllow` gained a real consumer; `disableMaxAllow` and
`registerApproveHook` are now test-only rather than dead). 51 export names are
referenced only from `test/`. Newly confirmed 2026-09-10, all with zero code
references:

- `defaultSettingsPath` (`src/settings-write.js:125`) — used only internally at
  `:60`. Landed the same day it became dead.
- `createSettingsWriter`'s own fallbacks (`src/settings-write.js:59-60`): all
  three callers pass `settingsPath`, so both the `= {}` default and the
  `|| defaultSettingsPath()` leg are unreachable. `onWrite` IS supplied, by the
  extension only.
- `assessPolicy`'s `claimed` parameter (`src/policy-guard.js:190`, consumed
  `:195-196`) has no supplier anywhere; its branch is dead.
- `isBulkLoss`'s `options.minimum` / `options.fraction`
  (`src/policy-guard.js:173-175`) — every call site passes two arguments.
- `renderCodexRules`'s `options.version` and `options.header`
  (`src/policy-exporters.js:392-397`) — two dead keys and three dead arms across
  7 call sites.
- `options.claudeSettingsPath` (`src/auto-learn-manager.js:581`) — a fourth member
  of the already-recorded alias family; only the alias spelling is supplied.
- `applyClaude` / `applyCodex` (`src/auto-learn-manager.js:1578`) are test-only;
  production uses `apply`, and the worker's allow-list does not include them.
- `createCoverIndex(...).stats()` is test-only — a measurement hook, not API.

Proved clean, worth recording so it is not re-derived: **zero orphaned functions**
across 578 declarations in `src/`, `bin/`, `vscode-extension/` and `scripts/`, and
**zero broken imports** across 99 destructured `require` sites / 317 names.
19/19 commands, 4/4 menus, 16/16 config keys and 8/8 CLI verbs are wired in both
directions. `scripts/package.mjs` enumerates `src/` dynamically, so there is no
VSIX gap.

### Vestigial dashboard markup, with one visible consequence

`id="toggle"` (`extension.js:3205`) has no JS reader at all, and `id="chev"`
(`:3206`) is superseded by `head.querySelector('.chev')` (`:3234`). The leftover
`#chev` CSS rule (`:3008`, `width: 1em; font-size: 10px`) still wins on
specificity over `.chev` (`:3057`, `width: .8em; font-size: 9px`), so the
"Wildcards tracked" chevron renders visibly differently from every other row.
Also still open: two webview switch arms nothing can reach — `autoLearnApply`
(`:2814`) and `autoLearnMode` (`:2816`); 16 senders against 18 arms.

### Smaller confirmed items

- **`policy-lock` orphans a zero-byte lock for the full 10 minutes.**
  `locked()` creates the file with `openSync(..., 'wx')` and writes its metadata
  after. A process that dies in that window leaves a lock with no valid pid, so
  `recoverLock` falls to the `lockAgeMs(stat) < staleMs` branch and refuses to
  reclaim it for `DEFAULT_STALE_MS`. Low probability, and it fails closed
  (refusal, not corruption), but the fix is small: treat a zero-byte lock as
  reclaimable after a short grace rather than the full stale window.
- **The hook accumulates stdin without a bound.** `bin/wildcard-perms:92` is
  `input += chunk` with no cap, and a PostToolUse payload carries tool output.
  A cap with a graceful "no cwd, no drain" fallback costs nothing.
- **`run()` relies on `finish()` never returning.** `bin/wildcard-perms:211` is
  `if (!settings) finish(input, false);` with no `return`. Correct today because
  `finish` ends in `process.exit(0)` on all three paths; one added early return
  and execution falls through and calls `finish` twice. One word.
- **`wildcardUnderLock` ignores `writeAllow`'s `addedAllow`**
  (`bin/wildcard-perms:296-300`), computing `added`/`removed` from its own
  pre-write snapshot — the exact anti-pattern `src/settings-write.js:106-108`
  documents ten lines above it ("a caller that reports its own intent ends up
  announcing '+299 restored' over a file that already had them"). Only a stderr
  diagnostic.
- **The teardown flag can be cleared under a pending teardown.** `deactivate()`
  sets `deactivated = true`, then awaits a drain with no deadline; `activate()`
  sets it false. If VS Code's deactivate timeout expires first and a same-realm
  re-activate runs, the OLD deactivate's continuation then nulls the SUCCESSOR's
  runner without draining it. A second consequence of the recorded "no deadline"
  item. SUSPECTED — depends on VS Code await semantics not verifiable from here.
- **A junction to a large tree is now walked in full.**
  `src/history-adapters.js:915` queues `entry.isSymbolicLink()` children, which
  was the point (junctions), but the realpath set stops cycles, not breadth. And a
  transcript reachable by two link paths gets two cursors and two parses;
  `observationHashes` dedupes the observations, so only I/O and state size are
  wasted. SUSPECTED cost, not correctness.
- **`/cygdrive/d/...` is not normalized** by either uninstaller's path matcher.
  Every other spelling converges — I traced `node "D:/..."`, `/d/...`,
  backslashes and case. Cosmetic.

## From the 2026-09-10 optimization and correctness pass

Four phases landed (`1b41205..cd1f50c`): `managed-policy` off the hook path, the
dashboard's doubled memory report, the last three whole-object writers, and the
hook fixed-point cache. What follows is what was found and deliberately left.

### The dashboard's remaining duplicate reads

Deferred with a reason, not forgotten. `readSettings()` runs 3-4x per `_push`
(`extension.js` at the push itself, in `autoLearnCardData`, in `frictionState`,
and via `localCardData`'s `readUserSettings`) with the value already in hand at
the top. Hoisting it needs signature changes in three more functions and would
save ~0.3 ms — and `frictionState()` may legitimately want a fresh read, so
threading a stale one trades a sub-millisecond gain for a possible correctness
regression. Not worth it.

Likewise `CLAUDE.md` and `~/.codex/AGENTS.md` are read 2x each because
`guidanceCardData` and `gatesCardData` both walk `installedGuidanceTargets()`,
and `gates.generated.md` is read 3-5x because `gatesStatus` (`src/agent-gates.js`)
reads it twice in one expression when gates are installed.

**The hazard that makes these riskier than they look:** `compiledGateCount()`
calls `readCompiled()` with **no home argument** deliberately, per the
no-singleton discipline documented in `agent-gates.js` and `agent-guidance.js` —
paths are resolved at CALL time so a test with a mocked home reads the mocked
file. A hoisted compiled-text value must be home-bound or a mocked-home test
silently reads the real file and passes for the wrong reason.

### The fixed-point cache's known limits

Both accepted, both worth knowing before extending it.

**A code change that preserves BOTH mtime and size is invisible.** The version
segment stats `src/permissions.js` and `src/permission-match.js`. `git checkout`
sets a fresh mtime so the motivating case (bisecting the generalizer) is covered;
hashing the ~43 KB of source instead would close it for ~0.1 ms plus I/O.

**The key covers `processAllowList` and nothing else.** Verified that the allow
array plus the code in those two files is the complete input set —
`patterns/starter-pack.json` is read at exactly one place, inside `--seed`, and
no policy read feeds the pass. If the hit path is ever widened to skip anything
else (the local-settings drain, managed policy, the MAX markers), those inputs are
NOT in the key and a third stat is required. A hit currently skips only the
generalization pass; `finish()` is still reached on all five of `run()`'s tails,
so the drain gate is unaffected.

**If the extension ever adopts it**, the cache belongs in memory, not in the
shared file: the extension host is long-lived, and its copy of the generalizer is
the generated mirror `vscode-extension/src/`, not the root path the version
segment stats.

### `writeFileAtomicSync` has two small defects of its own

`src/permissions.js`: `lastErr` is assigned in the retry loop and **never read on
any path**, so a non-retryable rename failure falls silently into the in-place
write with the original error discarded. And the final `sleepSync(200)` is
wasted — attempt 9 fails, it sleeps, then the loop ends with no rename following,
so 200 ms of the 1100 ms worst case buys nothing.

Worth stating plainly since it now has a second consumer's worth of scrutiny:
that 1100 ms is `Atomics.wait`, an unyieldable thread block, and in the extension
it blocks the extension-host thread. It is why the fixed-point cache uses a plain
`fs.writeFileSync` instead.

### Corpus hygiene, owned by concurrent sessions

Not repo issues, recorded so the acceptance board's state is explained rather
than mysterious. As of 2026-09-10 the board is 27 PASS / 2 FAIL, and both
failures are in the shared memory corpus, edited by another session ~45 minutes
before this run:

- `ollama-api-gotchas.md` has `scope: global` with **no `<!-- gate -->` block**,
  so it is resident-eligible and never compiled — the exact `no_gate` condition.
  Either add a block or drop the scope.
- Three files (`deletion-forensics-enabled.md`, `devtoolbox-shim-recovery.md`,
  `pc-maintenance-deletion-history.md`) still link to
  `[[pc-maintenance-is-report-only]]`, which was renamed to
  `pc-maintenance-deletion-history`. A rename left the references behind.

Deliberately NOT fixed here: those files were being actively edited, and writing
into another session's in-flight work is the same class of defect this whole pass
was about.

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
