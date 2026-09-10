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

### Three writers still spread from their own read

Fixed for the hook, `--seed` and the drain's `mergeUserAllow`; NOT fixed for
`--max` and `--bypass` (`bin/wildcard-perms`, the two remaining `writeSettings`
call sites). Both compute a whole settings object from their own read and write it
back, so they revert anything that landed in between. They are lock-held, so they
are safe against Auto Learn and each other — the exposure is against Claude Code,
which never takes the lock and rewrites this file on every /model, /effort and
approval. Lower frequency than the hook, same class of loss. They do not fit
`writeAllow` directly because their output is a whole settings object rather than
an allow list; the fix is either a rebasing whole-object writer or reshaping them
to return an allow list.

### The extension writes a MAX refusal it never reports

`applyMax` now returns `{ changed: false, error: 'max-snapshot-failed' }` when the
allow snapshot cannot be written, and `applyMax` stops the sequence so the approve
hook is not registered for a MAX that was never established. The CLI reports it
and exits 1. The extension's toggle does `if (!res.changed) return` and never
inspects `error` (`vscode-extension/extension.js`, the `applyMax` call site), so
the user clicks MAX, nothing happens, and nothing says why. Harmless — MAX stays
off, which is the safe direction — but silent.

### The coverage index is data-dependent, and the fallback size is the thing to watch

Live split is 401 indexed / 22 fallback, which is why the pass is 6 ms. The
residual cost is O(n x fallback), because a rule with a glob inside a token cannot
be found by lookup and must be checked against every candidate. Measured on a
synthetic pool with roughly half the entries unindexable: n=841 36.7 ms, n=1600
157.6 ms — better than the old scan at every size, but not linear.

In this tool's steady state almost everything is a trailing-scope wildcard, so
this is comfortable. **Trigger: revisit if the fallback share passes ~20% of the
list**, which would mean either an influx of quoted-path entries or a starter-pack
change. `createCoverIndex(...).stats()` reports the split.

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

The error count is now non-zero when a root fails, but nothing says "the cursor
map was preserved because nothing was enumerated". A consumer tuning retry
backoff has to infer it. Related and pre-existing:
`lastScanStats.prunedObservations` is written by `scan()` and dropped by
`sanitizeState`, so it vanishes on reload.

### Killing a child can orphan its grandchild

`deactivate()` now kills the four tracked `execFile` children, but `recall.py`
re-execs itself into the toolbox venv (`RECALL_REEXEC=1`), so killing the
immediate child can leave the process that actually does the embedding running. A
process-group kill (`taskkill /T` on Windows) is what would make this certain.

### More module state survives deactivate

`deactivate()` now resets 4 of 25 module-level mutables rather than 1. Still
surviving: `autoLearnManager` (reused when its key is unchanged, which it is
across a same-realm re-activate, so a re-activated extension inherits the old
manager's in-memory state — the same class of bug as the worker runner, just not
yet observed to bite), `autoLearnNextRetryAt` (a backoff that persists across a
reload), `lockedRetries`, `localDrainRetries`, `recallRebuildAt`, `policyLock`,
`statusBar`.

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
