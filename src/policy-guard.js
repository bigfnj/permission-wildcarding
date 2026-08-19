'use strict';

// Policy guard — keep prior approvals friction-free when managed policy lands.
//
// Org policy can tighten at any time on a corporate machine, and it does not
// necessarily arrive as a file: a console-managed org configures restrictions
// server-side, where the only local trace is ~/.claude/policy-limits.json — or
// none at all. So the trigger is "approvals stopped being there", which is
// source-agnostic, with the policy files watched as additional signals.
//
// Two things can happen to accumulated approvals, and only one is recoverable:
//
//   1. Entries go MISSING, because the refresh reset settings.json. The backup
//      has them; re-asserting restores them. This is worth fixing automatically.
//
//   2. Entries get SHADOWED, because managed deny/ask rules outrank a user allow
//      entry. Nothing user-side can beat that — it is Claude Code's precedence,
//      by design. Re-writing the entry does not help and re-writing it in a loop
//      helps less. This is worth *reporting*, never fighting.
//
// Conflating the two is how a recovery feature turns into a write loop, so the
// two are computed separately and only the first one writes.

const os = require('os');
const path = require('path');
// The wildcarder's own coverage test, so "missing" means the same thing here as
// it does to the pass that writes the list. Sharing it is what keeps a broader
// live wildcard (Bash(*), or a generalized Bash(git *)) from reading as a loss.
const { isCoveredBy } = require('./permissions');

// Server-delivered org policy. This is the one that actually exists on a
// console-managed machine: restrictions are configured in the organization's
// role settings and land here as a cache, with no managed-settings.json ever
// appearing on disk. Watching only for the admin-dropped file is how a guard
// ends up watching nothing at all.
function policyLimitsPath(home = os.homedir()) {
  return path.join(home, '.claude', 'policy-limits.json');
}

function policyRestrictions(limits) {
  const restrictions = limits?.restrictions;
  if (!restrictions || typeof restrictions !== 'object') return [];
  return Object.entries(restrictions)
    .filter(([, value]) => value && value.allowed === false)
    .map(([name]) => name)
    .sort();
}

// Every local signal that org policy exists or changed, in one list.
function policySignalPaths(platform = process.platform, home = os.homedir()) {
  return [...managedSettingsPaths(platform, home), policyLimitsPath(home)];
}

// Where an administrator drops managed settings, per platform.
function managedSettingsPaths(platform = process.platform, home = os.homedir()) {
  if (platform === 'win32') {
    const programData = process.env.PROGRAMDATA || 'C:\\ProgramData';
    return [path.join(programData, 'ClaudeCode', 'managed-settings.json')];
  }
  if (platform === 'darwin') {
    return [path.join('/Library', 'Application Support', 'ClaudeCode', 'managed-settings.json')];
  }
  return [path.join('/etc', 'claude-code', 'managed-settings.json'), path.join(home, '.claude', 'managed-settings.json')];
}

// Deliberately a second, independent copy of the matcher in autoLearnUi.js: a
// bug in one should not silently propagate into the other, and a drift test
// asserts the two still agree. A rule is a glob over the permission string.
function permissionMatches(permission, rule) {
  if (typeof permission !== 'string' || typeof rule !== 'string') return false;
  if (permission === rule) return true;
  const pattern = rule.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  try { return new RegExp(`^${pattern}$`).test(permission); }
  catch { return false; }
}

function list(value) {
  return Array.isArray(value) ? value.filter((entry) => typeof entry === 'string') : [];
}

// What the backup holds that the live policy no longer *grants*. This is the
// only thing the guard will write back.
//
// "No longer grants" is not the same as "no longer present verbatim". A backup
// entry is still granted if a broader live wildcard covers it — which is the
// normal state, not damage: the wildcarding pass generalizes `Bash(git status *)`
// into `Bash(git *)`, and MAX collapses every specific entry under `Bash(*)`.
// A verbatim set-difference reads all of those as missing and, once the count
// crosses the bulk-loss line, auto-"restores" them on every settings.json change
// — the churn that makes MAX look like it re-enables itself. So an entry counts
// as missing only when neither present verbatim nor covered by a live wildcard.
// deny stays verbatim: a missing killswitch rule is a real gap even if a broader
// deny exists, and re-asserting a redundant deny is harmless (deny is unioned).
function missingFromLive(live, backup) {
  const liveAllow = list(live?.permissions?.allow);
  const liveAllowSet = new Set(liveAllow);
  const liveDeny = new Set(list(live?.permissions?.deny));
  const stillGranted = (entry) =>
    liveAllowSet.has(entry) || liveAllow.some((live) => isCoveredBy(entry, live));
  return {
    allow: list(backup?.allow).filter((entry) => !stillGranted(entry)),
    deny: list(backup?.deny).filter((entry) => !liveDeny.has(entry)),
  };
}

// Which of my allow entries a managed deny/ask rule now outranks. Reported, not
// fought: managed policy wins over a user allow entry by design, so re-asserting
// these would change nothing and re-asserting them on every policy change would
// spin. `deny` shadowing blocks outright; `ask` restores the prompt.
function shadowedByManaged(managed, permissions) {
  const denyRules = list(managed?.permissions?.deny);
  const askRules = list(managed?.permissions?.ask);
  const shadowed = [];
  for (const permission of list(permissions)) {
    const deny = denyRules.find((rule) => permissionMatches(permission, rule));
    if (deny) { shadowed.push({ permission, decision: 'deny', rule: deny }); continue; }
    const ask = askRules.find((rule) => permissionMatches(permission, rule));
    if (ask) shadowed.push({ permission, decision: 'ask', rule: ask });
  }
  return shadowed;
}

// Managed policy can also switch off the layer MAX mode relies on. Layer 1
// (blanket allow wildcards) is ordinary permission data and survives; layer 2
// (the PreToolUse approve hook) is a user hook and does not.
function managedCapabilities(managed) {
  return {
    userHooksDisabled: managed?.allowManagedHooksOnly === true,
    bypassDisabled: managed?.disableBypassPermissionsMode === true ||
      managed?.permissions?.disableBypassPermissionsMode === true,
    forcedDefaultMode: typeof managed?.permissions?.defaultMode === 'string'
      ? managed.permissions.defaultMode : null,
  };
}

// Whether a loss looks like a policy wipe rather than a deliberate removal.
//
// The trigger that matters is not "a policy file changed" — org policy can
// arrive server-side with no local file at all — but "approvals stopped being
// there". That signal is source-agnostic and catches every cause: a managed
// refresh, a role change pushed from the console, a bad edit, a reinstall.
//
// It must not fight the user, though. Pruning one entry with the ✕ button is an
// instruction, not damage. The prune drops the entry from the backup too, so it
// never reappears here; this threshold is the second line of defence for the
// other ways a couple of entries can legitimately go missing.
const BULK_LOSS_MINIMUM = 5;
const BULK_LOSS_FRACTION = 0.1;

function isBulkLoss(missingCount, backupSize, options = {}) {
  const minimum = Number.isFinite(options.minimum) ? options.minimum : BULK_LOSS_MINIMUM;
  const fraction = Number.isFinite(options.fraction) ? options.fraction : BULK_LOSS_FRACTION;
  if (missingCount <= 0) return false;
  return missingCount >= Math.max(minimum, Math.ceil(backupSize * fraction));
}

// One assessment, so callers never have to decide which half is actionable.
function assessPolicy({ live, backup, managed, limits, claimed } = {}) {
  const missing = missingFromLive(live, backup);
  const surface = claimed
    ? list(claimed)
    : [...new Set([...list(live?.permissions?.allow), ...list(backup?.allow)])];
  const restorable = missing.allow.length + missing.deny.length;
  const backupSize = list(backup?.allow).length + list(backup?.deny).length;
  return {
    missing,
    restorable,
    bulkLoss: isBulkLoss(restorable, backupSize),
    shadowed: shadowedByManaged(managed, surface),
    capabilities: managedCapabilities(managed),
    restrictions: policyRestrictions(limits),
  };
}

module.exports = {
  managedSettingsPaths,
  policyLimitsPath,
  policySignalPaths,
  policyRestrictions,
  permissionMatches,
  missingFromLive,
  shadowedByManaged,
  managedCapabilities,
  isBulkLoss,
  assessPolicy,
};
