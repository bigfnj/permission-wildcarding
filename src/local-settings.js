'use strict';

// Project-local approvals — the half of the allow list nothing was watching.
//
// Claude Code persists an "always approve" into the *project's*
// `.claude/settings.local.json`, not the user-scope `settings.json` that the
// hook, the CLI and the extension all target. So the file that actually
// accumulates approvals was the one no pass ever generalized. Measured on a
// real repo: 167 entries, 68% of them already covered by a user-scope wildcard,
// and most of the rest multi-statement PowerShell blobs that can never match a
// second command. That file only grows, and every entry in it is a prompt the
// same command will still raise in the next project.
//
// This module drains it. Each local entry goes through the same generalization
// pass the hook uses; a *portable* command family is promoted to user scope,
// where one entry silences that family everywhere; the local entry is then
// removed only once the promotion is verified on disk. Anything the generalizer
// leaves verbatim — a script blob, an absolute-path executable, an MCP tool —
// stays local, because that is a grant only this checkout can justify.
//
// The order is not negotiable: promote, re-read, then prune. Pruning is judged
// against what the user-scope file *actually says after the write*, never
// against the list this pass intended to write, so a failed or policy-stripped
// promotion can never revoke a permission the user already had.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  generalizePermission, isCoveredBy, createCoverIndex, isMaxAllowOn, writeFileAtomicSync,
  BASH_SCRIPT_KEYWORDS,
} = require('./permissions');
// The same glob matcher the policy guard uses to decide whether managed policy
// outranks an entry. A deny rule beats a user allow entry, so a candidate it
// matches is not worth promoting — reusing the matcher keeps "would this even
// take effect" answered the same way in both places.
const { permissionMatches } = require('./policy-guard');

const LOCAL_RELATIVE = path.join('.claude', 'settings.local.json');

function localSettingsPath(workspaceRoot) {
  return path.join(workspaceRoot, LOCAL_RELATIVE);
}

// A promoted entry becomes a permission in *every* project, so the bar is
// portability rather than mere cleanliness: it must name a command family whose
// meaning does not depend on this checkout. `Tool(<root> *)` and the dispatcher
// form `Tool(<root> <sub> *)` qualify (either separator Claude Code writes).
// A path, a quoted program, an `&` call form, a shell keyword, a script blob —
// anything the generalizer leaves verbatim — does not, and neither does a
// non-shell family: `Read`/`Edit`/`Write` would mean inferring a directory rule
// from observed paths, and an MCP tool is opaque by construction. Those are
// review-only in `tool-learn.js` and they stay local here for the same reason.
const PROMOTABLE = /^(Bash|PowerShell)\(([A-Za-z][\w.-]*)(?:[ :]([A-Za-z0-9][\w.-]*))?[ :]\*\)$/;

// The user-scope permission a local entry would become, or null if it is not
// portable. Generalizing first is what turns `Bash(git status)` into
// `Bash(git status *)` and leaves a PowerShell script blob untouched.
function promotionFor(entry) {
  if (typeof entry !== 'string') return null;
  const match = PROMOTABLE.exec(generalizePermission(entry));
  if (!match) return null;
  const [permission, tool, root] = match;
  if (tool === 'Bash' && BASH_SCRIPT_KEYWORDS.has(root.toLowerCase())) return null;
  return permission;
}

// Already granted, by the same test the policy guard uses: present verbatim, or
// covered by a broader wildcard. `isCoveredBy` reports false for identity, so
// the verbatim check has to be explicit.
// `allow.includes` is linear and the cover scan behind it was too, both paid per
// local entry and twice over via redundantUnder. A Set plus the shared index
// makes each lookup constant-ish; isCoveredBy still decides coverage.
function grantedBy(entry, allow) {
  return grantedByIndex(allow)(entry);
}

// Memoized on the array identity, so a caller that asks about many entries
// against one allow list builds the index once. Callers that pass a fresh array
// each time simply get the old behaviour, correctly.
const grantedByCache = new WeakMap();
function grantedByIndex(allow) {
  const cached = grantedByCache.get(allow);
  if (cached) return cached;
  const verbatim = new Set(allow);
  const index = createCoverIndex(allow);
  const fn = (entry) => verbatim.has(entry) || index.covers(entry);
  grantedByCache.set(allow, fn);
  return fn;
}

// Phase 1 — what to add to user scope. Deliberately does not decide what to
// remove locally: that depends on what the user-scope write actually achieved.
function planPromotions({ localAllow = [], userAllow = [], userDeny = [] } = {}) {
  const promote = [];
  const denied = [];
  for (const entry of localAllow) {
    const candidate = promotionFor(entry);
    if (!candidate) continue;
    const rule = userDeny.find((deny) => permissionMatches(candidate, deny));
    if (rule) { denied.push({ entry, candidate, rule }); continue; }
    if (grantedBy(candidate, userAllow)) continue;
    if (!promote.includes(candidate)) promote.push(candidate);
  }
  return { promote, denied };
}

// An entry can be redundant in a way the glob test cannot see. An approval with
// no arguments — `Bash(git status)` — is not matched by the pattern its own
// generalization produces, because `Bash(git status *)` as a glob requires the
// space and something after it. When the family is granted and the entry differs
// from it only by that missing argument list, the entry is dead weight.
//
// The second test is deliberately narrow: the promoted family must key on the
// entry's *own* first token. `Bash(PYTHONUTF8=1 python -c x)` generalizes to
// `Bash(python *)` because env prefixes are stripped, but the command it grants
// starts with the prefix and so would not match that family — pruning it on the
// family's account would revoke a permission. Requiring the tokens to agree is
// what excludes exactly that case.
function redundantUnder(entry, allow) {
  if (grantedBy(entry, allow)) return true;
  const promotion = promotionFor(entry);
  if (!promotion || !grantedBy(promotion, allow)) return false;
  const inner = /^(?:Bash|PowerShell)\((.*)\)$/s.exec(entry)?.[1] ?? '';
  const root = /^(?:Bash|PowerShell)\(([^\s:]+)/.exec(promotion)?.[1] ?? '';
  const first = inner.trim().split(/\s+/)[0] ?? '';
  return !!first && first.toLowerCase() === root.toLowerCase();
}

// Phase 2 — which local entries are now redundant. Judged against the live
// user-scope list: an entry that list already grants is dead weight whether or
// not this pass is what put it there.
function partitionLocal(localAllow = [], effectiveUserAllow = []) {
  const prune = [];
  const keep = [];
  for (const entry of localAllow) {
    (redundantUnder(entry, effectiveUserAllow) ? prune : keep).push(entry);
  }
  return { prune, keep };
}

// One snapshot per workspace, keyed by a hash of its path so two checkouts never
// share a file. A high-water union like the allow-list backup: repeated drains
// keep the full record of what this project had approved, which is the only
// artifact left after the local file shrinks.
function localBackupPath(workspaceRoot, backupDir) {
  const hash = crypto.createHash('sha256').update(path.resolve(workspaceRoot)).digest('hex').slice(0, 12);
  return path.join(backupDir, `settings.local.${hash}.json`);
}

function backupLocalAllow(workspaceRoot, backupDir, allow) {
  try {
    const file = localBackupPath(workspaceRoot, backupDir);
    let previous = [];
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(parsed?.allow)) previous = parsed.allow;
    } catch { /* first drain, or an unreadable snapshot — start from what we have */ }
    const merged = [...new Set([...previous, ...allow])];
    fs.mkdirSync(backupDir, { recursive: true });
    writeFileAtomicSync(file, JSON.stringify({
      workspace: path.resolve(workspaceRoot),
      path: localSettingsPath(workspaceRoot),
      savedAt: new Date().toISOString(),
      allow: merged,
    }, null, 2) + '\n');
    return file;
  } catch {
    return null; // best-effort: pruning is already loss-free, this is the paper trail
  }
}

function emptyReport(file, extra) {
  return {
    path: file, exists: false, blocked: null, promote: [], promoted: [],
    denied: [], prune: [], pruned: [], kept: 0, changed: false, verified: true,
    backup: null, error: null, ...extra,
  };
}

// Drain one workspace.
//
// `readUserSettings` is called twice on purpose — once to plan, once after the
// write to see what landed. `applyUserAllow` belongs to the caller because the
// CLI and the extension merge into user scope differently (the extension rebases
// onto the newest file and refreshes its backup); this module never writes
// settings.json itself.
function drainLocalSettings({
  workspaceRoot,
  readUserSettings,
  applyUserAllow,
  dryRun = false,
  backupDir = path.join(os.homedir(), '.claude', 'backups'),
} = {}) {
  const file = localSettingsPath(workspaceRoot);

  let local;
  try {
    local = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    // ENOENT is the normal case: most projects have no local approvals at all.
    return emptyReport(file, { error: error.code === 'ENOENT' ? null : error.message });
  }

  const localAllow = Array.isArray(local?.permissions?.allow) ? local.permissions.allow : [];
  if (!localAllow.length) return emptyReport(file, { exists: true });

  const user = (typeof readUserSettings === 'function' ? readUserSettings() : null) ?? {};
  // MAX mode collapses user scope to `Bash(*)`/`PowerShell(*)`, which covers
  // every local entry. Draining against that would empty the local file, and
  // MAX-off restores only the user-scope snapshot — the project's own grants
  // would be gone for good. Refuse while the blanket layer is on.
  if (isMaxAllowOn(user)) {
    return emptyReport(file, { exists: true, blocked: 'max', kept: localAllow.length });
  }

  const userAllow = Array.isArray(user?.permissions?.allow) ? user.permissions.allow : [];
  const userDeny = Array.isArray(user?.permissions?.deny) ? user.permissions.deny : [];
  const { promote, denied } = planPromotions({ localAllow, userAllow, userDeny });

  if (dryRun) {
    const { prune, keep } = partitionLocal(localAllow, [...userAllow, ...promote]);
    return emptyReport(file, {
      exists: true, promote, denied, prune, kept: keep.length,
      changed: !!(promote.length || prune.length),
    });
  }

  if (promote.length) applyUserAllow(promote);

  // The truth is the file, not the intent. A promotion that did not land (a
  // failed write, managed policy stripping it) simply yields no coverage, so
  // nothing is pruned on its account.
  const after = (typeof readUserSettings === 'function' ? readUserSettings() : null) ?? {};
  const effective = Array.isArray(after?.permissions?.allow) ? after.permissions.allow : [];
  const landed = promote.filter((entry) => grantedBy(entry, effective));
  const { prune, keep } = partitionLocal(localAllow, effective);

  let backup = null;
  if (prune.length) {
    backup = backupLocalAllow(workspaceRoot, backupDir, localAllow);
    const permissions = { ...(local.permissions ?? {}), allow: keep };
    writeFileAtomicSync(file, JSON.stringify({ ...local, permissions }, null, 2) + '\n');
  }

  return {
    path: file,
    exists: true,
    blocked: null,
    promote,
    promoted: landed,
    denied,
    prune,
    pruned: prune,
    kept: keep.length,
    changed: !!(landed.length || prune.length),
    verified: landed.length === promote.length,
    backup,
    error: null,
  };
}

module.exports = {
  LOCAL_RELATIVE, PROMOTABLE,
  localSettingsPath, localBackupPath, promotionFor, grantedBy, redundantUnder,
  planPromotions, partitionLocal, drainLocalSettings,
};
