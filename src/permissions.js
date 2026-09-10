'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { ruleMatches, sameRule } = require('./permission-match');
// NOTE: `./managed-policy` is deliberately NOT required here. It is reachable from
// exactly one function, maxLayers(), and requiring it at module scope cost the
// PostToolUse hook 2.3 ms on EVERY tool call for a module the hook never reaches.
// See the lazy require inside maxLayers, and the same reasoning written out at
// bin/wildcard-perms:11-26.

// Rename codes that are transient on Windows: another process (Claude Code
// writing settings.json, Defender/Search indexer scanning the temp file, or a
// second wildcarding writer) held a handle at the instant of the atomic swap.
const RETRYABLE_RENAME_CODES = new Set(['EPERM', 'EACCES', 'EBUSY', 'ETXTBSY']);

// Block the calling thread briefly without a dependency. Only hit on the rare
// Windows EPERM retry path, so the short stall is acceptable.
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Atomically replace `target` with `content`.
//
// On Windows, fs.renameSync maps to MoveFileEx(REPLACE_EXISTING), which fails
// with EPERM/EACCES/EBUSY whenever another process holds the destination (or
// the newly written temp) open — a structural race here because Claude Code
// itself writes settings.json, and that write is what triggers wildcarding.
// Retry the rename with backoff (as write-file-atomic / graceful-fs do), then
// fall back to an in-place write so a transient lock never silently drops the
// update. Cleans up its own temp file on every path.
function writeFileAtomicSync(target, content) {
  // Unique per-writer temp name so the hook and the VS Code extension (or two
  // extension hosts) never collide on one shared *.wc.tmp.
  const tmp = `${target}.${process.pid}.${Math.random().toString(36).slice(2)}.wc.tmp`;
  fs.writeFileSync(tmp, content, 'utf8');

  const MAX_ATTEMPTS = 10;
  let lastErr;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      fs.renameSync(tmp, target);
      return;
    } catch (err) {
      lastErr = err;
      if (!RETRYABLE_RENAME_CODES.has(err.code)) break;
      sleepSync(20 * (attempt + 1)); // 20,40,…,200ms — ~1.1s total worst case
    }
  }

  // Rename kept failing: the target stayed held for the whole window. Write in
  // place as a last resort — non-atomic, but settings.json is small and losing
  // the update is worse than a brief window where a reader might see a partial
  // file (both readers here already tolerate a failed parse).
  try {
    fs.writeFileSync(target, content, 'utf8');
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

// ── generalization ────────────────────────────────────────────────────────────
//
// Design (v1.3+): collapse every command-tool approval to its command ROOT
// (depth-1), so one approval silences that command everywhere — including inside
// compound commands and pipelines, which Claude Code decomposes and checks per
// sub-command. There are no per-command depth rules and no noGeneralize
// carve-outs: destructive commands wildcard like everything else. The safety
// boundary is `permissions.deny` (always wins, evaluated per sub-command), not
// this generalizer. Both Bash(...) and PowerShell(...) are generalized.

// Tools whose argument is a shell command line we key on by its first token.
const COMMAND_TOOLS = new Set(['Bash', 'PowerShell']);
const MIXED_FAMILY_ROOTS = new Set([
  'cargo', 'choco', 'docker', 'dotnet', 'gh', 'git', 'go', 'helm', 'kubectl',
  'npm', 'npx', 'pip', 'pip3', 'pnpm', 'winget', 'yarn',
]);

// PowerShell tokens that begin a script construct rather than a plain command.
// A first-token wildcard on these is meaningless, so we leave them verbatim.
const PS_SCRIPT_KEYWORDS = new Set([
  'foreach', 'for', 'if', 'while', 'do', 'switch', 'try', 'function', 'filter',
  'begin', 'process', 'end', 'param', 'return', 'trap', 'class', 'enum', 'using',
]);

// True when the wildcard is a trailing scope wildcard, i.e. the arg already ends
// in `*` ("git *", "ext=\"/c/…\" *", "Read(*)"). Claude Code writes these itself
// for prefix-style approvals; they are already generalized, and re-tokenizing a
// quoted path here would shatter it into junk ("\"/c/Program *"). Leave them.
function isScopeWildcarded(arg) {
  return /\*\s*$/.test(arg);
}

// Strip leading `VAR=value` environment prefixes (quoted or bare) so the command
// itself is what we key on. "GITHUB_TOKEN=xxx git push" → "git push";
// "CUDA_HOME=/usr/local/cuda nvcc x.cu" → "nvcc x.cu".
function stripEnvPrefixes(cmd) {
  const re = /^[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+/;
  let rest = cmd.trim();
  while (re.test(rest)) rest = rest.replace(re, '');
  return rest;
}

// Generalize a shell command to a root wildcard, retaining one subcommand for
// mixed-capability dispatchers such as git and package managers.
function generalizeCommandArg(arg, tool) {
  const stripped = stripEnvPrefixes(arg);
  // A quoted/path executable cannot be represented safely by the legacy
  // first-token wildcard. Leave it exact; Auto Learn can review a normalized
  // family without ever producing malformed `"C:\Program *` permissions.
  if (/^["']/.test(stripped) || /^(?:\.{0,2}[\\/]|[A-Za-z]:[\\/])/.test(stripped)) {
    return `${tool}(${arg})`;
  }
  const first = stripped.split(/\s+/)[0] || '';
  if (!first) return `${tool}(${arg})`; // nothing to key on — leave verbatim
  const parts = stripped.split(/\s+/);
  const normalized = first.toLowerCase().replace(/\.(?:cmd|exe)$/i, '');
  if (MIXED_FAMILY_ROOTS.has(normalized)) {
    const subcommand = parts[1] || '';
    if (!/^[A-Za-z0-9][\w.-]*$/.test(subcommand)) return `${tool}(${arg})`;
    return `${tool}(${first} ${subcommand} *)`;
  }
  return `${tool}(${first} *)`;
}

// Generalize a PowerShell arg. The `& "app.exe" …` call form collapses to a
// single "run any & invocation" wildcard; plain command/cmdlet names collapse to
// their root; script-like constructs (variables, keywords, subexpressions) are
// left verbatim because a first-token wildcard would be nonsense there.
function generalizePowerShellArg(arg) {
  const t = arg.trim();
  // `&` can launch any dynamically chosen executable. A root-wide call-
  // operator wildcard is effectively arbitrary execution, so keep it exact.
  if (/^&\s/.test(t)) return `PowerShell(${arg})`;
  const first = t.split(/\s+/)[0] || '';
  const isSimpleCommand =
    /^[A-Za-z][\w.-]*$/.test(first) && !PS_SCRIPT_KEYWORDS.has(first.toLowerCase());
  return isSimpleCommand ? generalizeCommandArg(arg, 'PowerShell') : `PowerShell(${arg})`;
}

// Generalize a single permission entry.
function generalizePermission(perm) {
  const m = perm.match(/^([A-Za-z][A-Za-z0-9:_-]*)\((.+)\)$/s);
  if (!m) return perm; // bare tool (WebSearch), mcp__server__tool, or odd format

  const [, tool, arg] = m;
  if (isScopeWildcarded(arg)) return perm; // already a trailing-scope wildcard
  if (!COMMAND_TOOLS.has(tool)) return perm; // Read / Edit / WebFetch / Skill / …

  return tool === 'PowerShell'
    ? generalizePowerShellArg(arg)
    : generalizeCommandArg(arg, tool);
}

// ── legacy history-mining compatibility helper ──────────────────────────────────
//
// Convert a command string already verified by the caller into a clean root
// wildcard. This helper does not read transcripts or prove that a command ran.
// Cross-agent Auto Learn performs request/result correlation, outcome tracking,
// risk classification, and policy export in the dedicated auto-learn modules.
// Returns `Tool(root *)` for a clean single-command root, or null for shell
// keywords, paths, quoted programs, env-var prefixes, call forms, and scripts.

// Bash reserved words / shell grammar that can begin a line but are not commands
// to wildcard (`for i in …` must not seed `Bash(for *)`). PowerShell's equivalents
// are already handled by generalizePowerShellArg via PS_SCRIPT_KEYWORDS.
const BASH_SCRIPT_KEYWORDS = new Set([
  'for', 'while', 'until', 'do', 'done', 'if', 'then', 'elif', 'else', 'fi',
  'case', 'esac', 'select', 'function', 'time', 'coproc', 'in',
  'declare', 'typeset', 'local', 'set', 'unset', 'eval', 'exec',
]);

function mineWildcard(tool, command) {
  if (!COMMAND_TOOLS.has(tool)) return null;
  const arg = String(command == null ? '' : command);
  if (!arg.trim()) return null;

  const perm = tool === 'PowerShell'
    ? generalizePowerShellArg(arg)
    : generalizeCommandArg(arg, tool);

  // Only a clean single-root wildcard `Tool(<root> *)` qualifies. Anything the
  // generalizer left verbatim (a script/keyword form) fails this shape.
  const m = perm.match(/^(Bash|PowerShell)\((\S+) \*\)$/);
  if (!m) return null;
  const [, t, root] = m;

  // Root must be a bare command name — rejects paths (/…, C:\…), quoted programs,
  // and the `& *` call form (whose root would be `&`).
  if (!/^[A-Za-z][\w.-]*$/.test(root)) return null;
  if (t === 'Bash' && BASH_SCRIPT_KEYWORDS.has(root.toLowerCase())) return null;

  return `${t}(${root} *)`;
}

// Returns true if `specific` is fully matched by `wildcard` (glob: * = anything).
function isCoveredBy(specific, wildcard) {
  // Identity is not coverage, and `Tool(cmd:*)` is the same rule as
  // `Tool(cmd *)`, so the two spellings are identity too rather than one
  // covering the other.
  if (sameRule(specific, wildcard)) return false;
  return ruleMatches(wildcard, specific);
}

// ── coverage index ────────────────────────────────────────────────────────────
//
// The two coverage scans below were 99.8% of processAllowList, which the hook
// pays on every tool call: 348,588 RegExp.test() calls per pass at 423 entries,
// ~52 ms of a 56 ms pass, and quadratic on a list that only ever grows
// (measured: 100 entries 3.0 ms, 423 entries 52.7 ms, 841 entries 254.2 ms).
//
// This index does NOT reimplement matching. It NARROWS the candidate set, and
// `isCoveredBy` — untouched — still decides every answer. So a false positive
// costs one extra regex and changes nothing, and only a false NEGATIVE could
// alter a result. That asymmetry is the whole safety argument, and it is why the
// differential test in test/cover-index.test.js can assert byte-identical
// cover-sets rather than merely "looks right".
//
// Indexable means `Tool(<literal> *)` or `Tool(<literal>:*)` with NO glob inside
// the literal. Established empirically against the real matcher:
//
//   no     Bash(gi *)     vs Bash(git status)   <- matching is token-aware
//   MATCH  Bash(git *)    vs Bash(git status)
//   MATCH  Bash(git *)    vs Bash(git)          <- the trailing star matches empty
//   MATCH  Bash(g* *)     vs Bash(git status)   <- a glob INSIDE a token matches
//   MATCH  Bash(mkfs* *)  vs Bash(mkfs.ext4 /dev/sda)
//
// The last two cannot be found by any literal-prefix lookup, so a rule whose
// literal contains a glob goes to the linear fallback. `Bash(mkfs* *)` is not
// hypothetical — it ships in the starter pack's deny half.
const RULE_SHAPE = /^([A-Za-z][A-Za-z0-9:_-]*)\((.*)\)$/s;
const KEY_SEP = '\u0000';

function coverIndexKey(rule) {
  const parts = RULE_SHAPE.exec(rule);
  if (!parts) return null;
  const [, tool, arg] = parts;
  if (!/\*\s*$/.test(arg)) return null;                  // not a trailing-scope wildcard
  // The star must sit on a TOKEN BOUNDARY, i.e. be preceded by whitespace or a
  // colon, or be the whole argument. `Bash(rm -rf /*)` fails this: stripping its
  // star leaves `rm -rf /`, which is not a prefix of `rm -rf /home` at any
  // whitespace boundary, so a lookup would miss it — a false negative, the one
  // error class that can change an answer. The differential test caught exactly
  // this case before it shipped. Such rules go to the linear fallback.
  const head = arg.replace(/\*\s*$/, '');
  if (head !== '' && !/[\s:]$/.test(head)) return null;
  const literal = head.replace(/[\s:]+$/, '');
  if (/[*?]/.test(literal)) return null;                 // glob inside the literal
  return `${tool}${KEY_SEP}${literal}`;
}

// Every key a candidate could be covered by: the tool-wide key, then the
// candidate's own argument truncated at each token boundary. Sliced from the
// ORIGINAL string rather than rebuilt from split tokens, so runs of internal
// whitespace and quoted paths keep their exact bytes — rebuilding with single
// spaces would miss `Bash("C:\Program  Files\x.exe" *)` and a miss is the one
// error class that matters here.
//
// A COLON is a token boundary here for the same reason it is one in
// coverIndexKey: `Skill(dataviz:*)` indexes under `Skill\0dataviz`, so a lookup
// that only broke at whitespace generated `Skill\0` and `Skill\0dataviz:report`
// and never reached that bucket. The two functions have to agree on what a
// boundary is, or the rule is both indexed AND unreachable — it is not in the
// linear fallback either, so nothing else looks at it. That shipped: five
// oracle-confirmed false negatives, including the three colon-form Skill
// wildcards in patterns/starter-pack.json and the documented
// `WebFetch(domain:*)`. Extra keys cost only a bucket probe, because
// isCoveredBy still decides every answer; a MISSING key changes the answer.
function coverLookupKeys(specific) {
  const parts = RULE_SHAPE.exec(specific);
  if (!parts) return [];
  const [, tool, arg] = parts;
  const keys = [`${tool}${KEY_SEP}`];
  for (let i = 0; i <= arg.length; i += 1) {
    if (i === arg.length || /[\s:]/.test(arg[i])) {
      keys.push(`${tool}${KEY_SEP}${arg.slice(0, i).replace(/[\s:]+$/, '')}`);
    }
  }
  return keys;
}

// `covers(specific)` answers "does anything in this pool cover it", and
// `coveredBy(specific)` returns the covering entries, both with the same result
// the full scan would give.
function createCoverIndex(pool) {
  const indexed = new Map();
  const fallback = [];
  for (const rule of pool) {
    // A rule with no `*` cannot cover anything, so it belongs in neither the
    // buckets nor the fallback. escapeLiteral (permission-match.js:59-61)
    // escapes every regex metacharacter INCLUDING `?` and excluding `*`, and
    // the only `*` -> `.*` expansion is at :94 — so a star-free rule compiles
    // to a fully anchored literal that matches nothing but itself, and
    // isCoveredBy already excludes identity via sameRule.
    //
    // This is not a micro-optimisation. On the live 424-entry list 20 of the 23
    // unindexable rules are star-free (`Skill(dataviz)`, `Edit`, `Write`,
    // `WebSearch`, one-off literal commands), and because the fallback is
    // consulted for EVERY candidate they absorbed 8,480 of prunePermissions'
    // 10,153 isCoveredBy calls — 83% of the work, for a guaranteed `false`.
    // Measured: cold processAllowList 12.38 -> 8.85 ms per hook call, warm
    // 3.82 -> 2.45 ms per dashboard refresh. It also retires the growth mode
    // that mattered: star-free entries are what a real allow list accumulates,
    // and with them gone the fallback is 3 rules with no growth axis, so a
    // 3,200-entry list goes from 1,190 ms to 15.6 ms.
    if (!rule.includes('*')) continue;
    const key = coverIndexKey(rule);
    if (key === null) { fallback.push(rule); continue; }
    const bucket = indexed.get(key);
    if (bucket) bucket.push(rule); else indexed.set(key, [rule]);
  }
  const narrow = (specific) => {
    const out = [];
    for (const key of coverLookupKeys(specific)) {
      const bucket = indexed.get(key);
      if (bucket) out.push(...bucket);
    }
    // A rule with a glob in its literal is unreachable by lookup, so the
    // fallback is always consulted. It is small in practice — 27 of 423 here.
    out.push(...fallback);
    return out;
  };
  return {
    covers: (specific) => narrow(specific).some((rule) => isCoveredBy(specific, rule)),
    coveredBy: (specific) => narrow(specific).filter((rule) => isCoveredBy(specific, rule)),
    stats: () => ({ indexed: indexed.size, fallback: fallback.length }),
  };
}

// Remove entries that are fully covered by a broader entry in the same list.
//
// The index is built once per call rather than per entry, which is what turns
// the quadratic scan linear. Identity is preserved by isCoveredBy itself
// (`sameRule` first), so an entry can never prune itself — the old `i !== j`
// index inequality was only equivalent to string inequality because
// processAllowList dedupes through a Set first, and relying on that coincidence
// here would break the moment a caller passed a list with duplicates.
function prunePermissions(allows) {
  const index = createCoverIndex(allows);
  return allows.filter((perm) => !index.covers(perm));
}

// Full pipeline: generalize → deduplicate → prune.
function processAllowList(allows) {
  if (!Array.isArray(allows) || allows.length === 0) return allows;

  const existingScopes = allows.filter((permission) => /\*\s*\)$/.test(permission));
  // Indexed once for the whole map, not re-scanned per entry. The old
  // `scope !== permission` guard is dropped as redundant rather than lost:
  // isCoveredBy defers to sameRule first, so an entry never covers itself, and
  // that holds for the `Tool(cmd:*)` / `Tool(cmd *)` spellings too — they are the
  // same rule rather than one covering the other.
  const scopeIndex = createCoverIndex(existingScopes);
  const generalized = [...new Set(allows.map((permission) => {
    if (scopeIndex.covers(permission)) {
      return permission;
    }
    return generalizePermission(permission);
  }))];
  return prunePermissions(generalized);
}

// ── bypass toggle ─────────────────────────────────────────────────────────────
//
// A personal "skip every prompt" switch — our own version of Claude Code's
// bypassPermissions mode, flipped by writing `permissions.defaultMode` in
// settings.json. It is NOT permanent: turning it ON stashes the previous mode in
// a sidecar file so turning it OFF restores exactly what you had.
//
// bypassPermissions is the widest suppression Claude Code exposes — it captures
// every tool, every Bash/PowerShell command, every unapproved/MCP tool, and the
// compound/`$(...)`/subshell cases wildcarding can't reach. What it does NOT
// touch (by Claude Code's design, not ours): your `permissions.deny` rules still
// BLOCK matching commands, and Claude Code's hard circuit breakers (rm -rf / and
// ~ removals, incl. command-substitution forms) always fire. Those are the only
// things left standing at max, and both are safety floors rather than prompts.
//
// defaultMode is read at session start / context rollover, so a flip takes full
// effect on the next Claude Code window reload rather than instantly mid-turn.
const BYPASS_MODE = 'bypassPermissions';
const FALLBACK_MODE = 'default'; // restore target when no stashed mode exists
const BYPASS_STATE_FILE = path.join(os.homedir(), '.claude', 'backups', 'wildcarding-bypass.json');

function readBypassState() {
  try { return JSON.parse(fs.readFileSync(BYPASS_STATE_FILE, 'utf8')) || {}; }
  catch { return {}; }
}

function writeBypassState(state) {
  // Best-effort — a lost stash only degrades the OFF restore to FALLBACK_MODE.
  try {
    fs.mkdirSync(path.dirname(BYPASS_STATE_FILE), { recursive: true });
    writeFileAtomicSync(BYPASS_STATE_FILE, JSON.stringify(state, null, 2) + '\n');
  } catch { /* ignore */ }
}

// The active permission mode, defaulting to Claude Code's own baseline.
function currentMode(settings) {
  return settings?.permissions?.defaultMode ?? FALLBACK_MODE;
}

function isBypassOn(settings) {
  return currentMode(settings) === BYPASS_MODE;
}

// NOTE: a second `function withMode` used to be declared further down this file,
// and because both were module-scope function declarations the LATER one won for
// every caller — including applyBypass below, which reads as though it uses the
// one that stood here. The two were not equivalent: this one always wrote
// `defaultMode`, the surviving one deletes the key when mode is null "rather
// than writing a value the user never had". So bypass-off has always taken the
// deleting behaviour, which is the correct one, decided by declaration order
// rather than by choice. The dead declaration is removed; the survivor and its
// comment are the single definition now.

// Compute the settings object for turning bypass on/off. Side effect: stashes the
// previous mode (on) or reads it back (off) via the sidecar so the toggle round-
// trips. Returns { changed, settings, from, to }; `changed` is false for a no-op
// (already in the requested state), leaving the stash untouched.
function applyBypass(settings, on) {
  const from = currentMode(settings);
  if (on) {
    if (from === BYPASS_MODE) return { changed: false, settings, from, to: from };
    writeBypassState({ savedMode: from, savedAt: new Date().toISOString() });
    return { changed: true, from, to: BYPASS_MODE, settings: withMode(settings, BYPASS_MODE) };
  }
  if (from !== BYPASS_MODE) return { changed: false, settings, from, to: from };
  const saved = readBypassState().savedMode;
  const to = (typeof saved === 'string' && saved && saved !== BYPASS_MODE) ? saved : FALLBACK_MODE;
  return { changed: true, from, to, settings: withMode(settings, to) };
}

// ── MAX mode: "skip everything" without touching defaultMode ────────────────────
//
// Two INDEPENDENT layers, so they fail in different ways and cover each other:
//
//   Layer 1 — blanket allow-list wildcards. Inject Bash(*)/PowerShell(*) + the
//     file/web tool-wide grants + a per-server mcp__<server>__* for every MCP
//     server already seen in the allow list. This is the normal, sanctioned
//     permission path, so it keeps working even where an org disables user hooks
//     (allowManagedHooksOnly) and cannot be shut off by disableBypassPermissionsMode.
//     Bash(*) matches the WHOLE command string, so compound / $(...) / subshell
//     cases clear too. Gap: allow can't express a global mcp__*, so a brand-new
//     MCP server (or a new tool type) isn't covered by this layer alone.
//
//   Layer 2 — a PreToolUse auto-approve hook (matcher "*") that returns
//     permissionDecision:"allow" for every tool call. Covers ALL tools, including
//     MCP servers you've never approved and future tool types — closing Layer 1's
//     gap. Being a user hook, it's the layer an org "managed hooks only" policy
//     would disable, which is exactly why Layer 1 exists as the fallback.
//
// Neither layer touches permissions.deny or Claude Code's hard circuit breakers:
// deny ALWAYS wins (a hook "allow" cannot override a deny rule), so the killswitch
// holds at max. Enabling MAX snapshots the pre-MAX allow list so OFF restores it
// exactly. Like all hook/mode changes, the approve hook loads at session start, so
// a flip takes effect on the next window reload.

// Layer 1 — blanket allow set (tool-wide grants that are stable under the wildcarder).
const MAX_ALLOW_CORE = ['Bash(*)', 'PowerShell(*)', 'Read(*)', 'Edit', 'Write', 'WebFetch(*)', 'WebSearch'];
const MAX_MARKERS = ['Bash(*)', 'PowerShell(*)']; // presence of both == Layer 1 active
const MAX_STATE_FILE = path.join(os.homedir(), '.claude', 'backups', 'wildcarding-max.json');

// Layer 2 — the auto-approve hook. Written to a stable, location-independent path
// so the CLI and the installed VSIX register the identical hook. Extensionless
// scripts have no Windows association, so the command is `node "<path>"`.
const APPROVE_DIR     = path.join(os.homedir(), '.claude', 'wildcarding');
const APPROVE_SCRIPT  = path.join(APPROVE_DIR, 'approve-all.js');
const APPROVE_COMMAND = `node "${APPROVE_SCRIPT.replace(/\\/g, '/')}"`;
const APPROVE_MARKER  = 'approve-all'; // substring identifying our hook command

const APPROVE_SCRIPT_SOURCE = `'use strict';
// permission-wildcarding MAX mode — PreToolUse auto-approve hook.
// Returns permissionDecision:"allow" for every tool call, skipping the prompt.
// SAFE BY DESIGN: Claude Code still enforces permissions.deny and its hard
// circuit breakers regardless of this decision — a hook "allow" cannot override
// a deny rule. Managed by permission-wildcarding; remove via MAX mode OFF.
let done = false;
function emit() {
  if (done) return; done = true;
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      permissionDecisionReason: 'permission-wildcarding MAX mode',
    },
  }));
  process.exit(0);
}
// Drain stdin (Claude Code sends tool context we don't need) then emit; a short
// fallback timer guarantees we answer even if 'end' never arrives.
try { process.stdin.resume(); process.stdin.on('data', () => {}); process.stdin.on('end', emit); process.stdin.on('error', emit); } catch { emit(); }
setTimeout(emit, 800);
`;

function readMaxState() {
  try { return JSON.parse(fs.readFileSync(MAX_STATE_FILE, 'utf8')) || {}; }
  catch { return {}; }
}

// Returns whether the snapshot actually landed. It used to swallow the failure
// and return nothing, and its "best-effort" comment was borrowed from
// writeBypassState below — where a lost stash genuinely only degrades the OFF
// restore to FALLBACK_MODE. Here the consequence is total: enableMaxAllow goes on
// to prune every specific entry under Bash(*), and with no snapshot to read back
// disableMaxAllow computes `restored = kept`, leaving the user the 7 blanket
// entries and nothing else. `readMaxState` returns {} for both "never written"
// and "corrupt", so that call site cannot tell the difference either.
function writeMaxState(state) {
  try {
    fs.mkdirSync(path.dirname(MAX_STATE_FILE), { recursive: true });
    writeFileAtomicSync(MAX_STATE_FILE, JSON.stringify(state, null, 2) + '\n');
    return true;
  } catch { return false; }
}

// Servers to blanket-wildcard, derived from mcp__<server>__… entries already in
// the allow list. `mcp__` is the prefix; the server name runs to the next `__`.
function detectMcpServers(allow) {
  const servers = new Set();
  for (const p of Array.isArray(allow) ? allow : []) {
    const m = /^mcp__(.+?)__/.exec(p);
    if (m) servers.add(m[1]);
  }
  return [...servers];
}

function buildMaxAllowSet(allow) {
  return [...MAX_ALLOW_CORE, ...detectMcpServers(allow).map((s) => `mcp__${s}__*`)];
}

function withAllow(settings, allow) {
  return { ...settings, permissions: { ...(settings?.permissions ?? {}), allow } };
}

// Auto mode routes every decision through Claude Code's classifier, and it drops
// any allow entry that would bypass that classifier. Measured against 2.1.238 and
// 2.1.245: in auto mode `Bash(*)`, `PowerShell(*)` and every interpreter root
// (bash, python, node, npx, ssh, xargs, lua, and their PowerShell twins) load with
// "Ignoring dangerous permission … (bypasses classifier)"; in default mode the
// same list loads intact.
//
// So MAX cannot keep its promise in auto mode. Worse, it would still collapse the
// specific entries it replaced, leaving a shorter allow list *and* no blanket to
// stand in for it — strictly worse than never touching MAX. The mode therefore
// travels with the toggle, and comes back when MAX goes off.
const CLASSIFIER_MODE = 'auto';
const MAX_MODE = 'default';

function classifierModeOn(settings) {
  return settings?.permissions?.defaultMode === CLASSIFIER_MODE;
}

// `mode === null` removes the key rather than writing a value the user never had.
function withMode(settings, mode) {
  const permissions = { ...(settings?.permissions ?? {}) };
  if (mode === null || mode === undefined) delete permissions.defaultMode;
  else permissions.defaultMode = mode;
  return { ...settings, permissions };
}

function isMaxAllowOn(settings) {
  const allow = settings?.permissions?.allow;
  return Array.isArray(allow) && MAX_MARKERS.every((m) => allow.includes(m));
}

// Layer 1 enable: snapshot the current allow list, then inject the blanket set
// (processAllowList prunes the now-redundant specific entries under Bash(*)).
function enableMaxAllow(settings) {
  if (isMaxAllowOn(settings)) return { changed: false, settings };
  const current = Array.isArray(settings?.permissions?.allow) ? settings.permissions.allow : [];
  const previousMode = settings?.permissions?.defaultMode ?? null;
  // Refuse rather than proceed. The next line prunes every specific entry the
  // blanket set covers, and only this snapshot can bring them back — so a
  // silently failed write turns MAX-on into permanent loss of the whole allow
  // list. Reported as a reason the caller can surface, not thrown, because every
  // caller of applyMax already renders a `{ changed, ... }` result.
  if (!writeMaxState({ allowSnapshot: current, defaultMode: previousMode, savedAt: new Date().toISOString() })) {
    return { changed: false, settings, error: 'max-snapshot-failed' };
  }
  const merged = processAllowList([...new Set([...current, ...buildMaxAllowSet(current)])]);
  const switchedMode = classifierModeOn(settings);
  const next = switchedMode
    ? withMode(withAllow(settings, merged), MAX_MODE)
    : withAllow(settings, merged);
  return { changed: true, settings: next, switchedMode: switchedMode ? CLASSIFIER_MODE : null };
}

// Layer 1 disable: restore the pre-MAX snapshot *and* keep anything granted
// while MAX was on — an Auto Learn application, or a permission Claude Code
// persisted from a real approval. Restoring the snapshot alone silently dropped
// those, which also left the Auto Learn claims registry describing entries that
// no longer existed.
//
// A plain set-difference cannot replace the snapshot: enableMaxAllow already
// pruned the specific entries away under Bash(*), so the originals only survive
// in the snapshot. Union the two — snapshot order first, later grants appended.
function disableMaxAllow(settings) {
  if (!isMaxAllowOn(settings)) return { changed: false, settings };
  const current = Array.isArray(settings?.permissions?.allow) ? settings.permissions.allow : [];
  const state = readMaxState();
  const snap = state.allowSnapshot;
  const blanket = new Set(buildMaxAllowSet(current));
  const kept = current.filter((p) => !blanket.has(p));
  const restored = Array.isArray(snap) ? [...new Set([...snap, ...kept])] : kept;
  // Hand the permission mode back too, but only if it is still the one MAX put
  // there. A mode the user changed by hand while MAX was on is theirs to keep.
  const restoreMode = Object.prototype.hasOwnProperty.call(state, 'defaultMode')
    && settings?.permissions?.defaultMode === MAX_MODE;
  const next = restoreMode
    ? withMode(withAllow(settings, restored), state.defaultMode)
    : withAllow(settings, restored);
  return { changed: true, settings: next, restoredMode: restoreMode ? state.defaultMode : null };
}

// Write Layer 2's hook script to its stable path (idempotent).
function ensureApproveScript() {
  try {
    fs.mkdirSync(APPROVE_DIR, { recursive: true });
    fs.writeFileSync(APPROVE_SCRIPT, APPROVE_SCRIPT_SOURCE, 'utf8');
    return true;
  } catch { return false; }
}

function isApproveHookOn(settings) {
  const entries = settings?.hooks?.PreToolUse;
  if (!Array.isArray(entries)) return false;
  return entries.some((e) =>
    Array.isArray(e?.hooks) && e.hooks.some((h) => typeof h?.command === 'string' && h.command.includes(APPROVE_MARKER))
  );
}

// Layer 2 enable: write the script and register a matcher:"*" PreToolUse hook.
function registerApproveHook(settings) {
  if (isApproveHookOn(settings)) return { changed: false, settings };
  ensureApproveScript();
  const hooks = { ...(settings?.hooks ?? {}) };
  const pre = Array.isArray(hooks.PreToolUse) ? [...hooks.PreToolUse] : [];
  pre.push({ matcher: '*', hooks: [{ type: 'command', command: APPROVE_COMMAND }] });
  hooks.PreToolUse = pre;
  return { changed: true, settings: { ...settings, hooks } };
}

// Layer 2 disable: drop any PreToolUse entry that references our approve hook,
// and prune emptied entries. Leaves every other PreToolUse hook untouched.
function unregisterApproveHook(settings) {
  if (!isApproveHookOn(settings)) return { changed: false, settings };
  const hooks = { ...(settings?.hooks ?? {}) };
  const pre = (Array.isArray(hooks.PreToolUse) ? hooks.PreToolUse : [])
    .map((e) => ({ ...e, hooks: (e.hooks ?? []).filter((h) => !(typeof h?.command === 'string' && h.command.includes(APPROVE_MARKER))) }))
    .filter((e) => Array.isArray(e.hooks) && e.hooks.length > 0);
  if (pre.length) hooks.PreToolUse = pre; else delete hooks.PreToolUse;
  return { changed: true, settings: { ...settings, hooks } };
}

// MAX is "on" if either layer is active (a partial state still reads as on so the
// toggle cleans up both). Fully on == both layers.
function isMaxOn(settings) {
  return isApproveHookOn(settings) || isMaxAllowOn(settings);
}

// MAX mode has two layers, and the hook layer can be registered yet never run:
// with `allowManagedHooksOnly` set, a user hook fires only on an event the
// managed policy itself defines, and a policy that defines only PostToolUse
// silently drops a PreToolUse hook. Reporting `hook: true` in that case would
// claim a control that is not running, so the state is named instead.
//
// `hookBlocked` is a policy declaration rather than an observation. Enforcement
// has changed across policy versions, so confirm with a canary before relying
// on it in either direction.
function maxLayers(settings, options = {}) {
  // Required here, not at module scope. This is the ONLY function in the file that
  // touches managed policy, and nothing on the hook's common path calls it — the
  // callers are `--max status` and three sites in the extension, which is a
  // long-lived process where the load is paid once. Measured cold in fresh
  // interleaved processes: requiring src/permissions.js costs 4.803 ms with this
  // eager, 2.476 ms with it stubbed out, so the hook was paying ~2.3 ms per tool
  // call for a module it never used.
  //
  // At the top of the function rather than inside the `else` below: readPolicy is
  // conditional, but hookEventAllowed two lines down is not.
  const { readPolicy, hookEventAllowed } = require('./managed-policy');
  const policy = options.managedPolicy !== undefined
    ? options.managedPolicy
    : readPolicy({ home: options.home, policyPath: options.managedPolicyPath });
  const hook = isApproveHookOn(settings);
  const permitted = hookEventAllowed(policy, 'PreToolUse');
  return {
    allow: isMaxAllowOn(settings),
    hook,
    hookBlocked: hook && !permitted,
    hookEventPermitted: permitted,
    policyPresent: Boolean(policy && policy.present),
  };
}

// Turn both layers on/off in a single settings transform.
function applyMax(settings, on) {
  let s = settings, changed = false, switchedMode = null, restoredMode = null, error = null;
  // Returns whether the sequence may continue. A refusal has to STOP it, not
  // merely contribute nothing: MAX-on that went on to register the approve hook
  // after the allow snapshot failed would report a layer it never established,
  // which is precisely the failure maxLayers' own comment warns about — "claiming
  // a control that is not running".
  const step = (res) => {
    if (res.error) { error = res.error; return false; }
    if (!res.changed) return true;
    s = res.settings; changed = true;
    if (res.switchedMode) switchedMode = res.switchedMode;
    if (res.restoredMode !== undefined && res.restoredMode !== null) restoredMode = res.restoredMode;
    return true;
  };
  if (on) {
    if (step(enableMaxAllow(s))) step(registerApproveHook(s));
  } else {
    if (step(disableMaxAllow(s))) step(unregisterApproveHook(s));
  }
  return { changed, settings: s, switchedMode, restoredMode, ...(error ? { error } : {}) };
}

module.exports = {
  generalizePermission, mineWildcard, BASH_SCRIPT_KEYWORDS,
  isCoveredBy, createCoverIndex, prunePermissions, processAllowList, writeFileAtomicSync,
  BYPASS_MODE, BYPASS_STATE_FILE, currentMode, isBypassOn, applyBypass, readBypassState,
  CLASSIFIER_MODE, MAX_MODE, classifierModeOn,
  MAX_ALLOW_CORE, MAX_MARKERS, MAX_STATE_FILE, APPROVE_SCRIPT, APPROVE_COMMAND,
  detectMcpServers, buildMaxAllowSet, isMaxAllowOn, enableMaxAllow, disableMaxAllow,
  ensureApproveScript, isApproveHookOn, registerApproveHook, unregisterApproveHook,
  isMaxOn, maxLayers, applyMax,
};
