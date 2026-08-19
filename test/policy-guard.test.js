'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  managedSettingsPaths, permissionMatches, missingFromLive, shadowedByManaged,
  managedCapabilities, assessPolicy,
  policyLimitsPath, policySignalPaths, policyRestrictions, isBulkLoss,
} = require('../src/policy-guard');

const BACKUP = {
  allow: ['Bash(git *)', 'Bash(rg *)', 'Bash(rm *)', 'Bash(tokei *)'],
  deny: ['Bash(rm -rf /*)', 'Bash(mkfs* *)'],
};

test('only entries the live policy actually lost are candidates for re-assert', () => {
  const live = { permissions: { allow: ['Bash(git *)', 'Bash(rg *)'], deny: ['Bash(mkfs* *)'] } };
  assert.deepEqual(missingFromLive(live, BACKUP), {
    allow: ['Bash(rm *)', 'Bash(tokei *)'],
    deny: ['Bash(rm -rf /*)'],
  });
  // Nothing lost means nothing written — this is what stops the guard from
  // spinning against a policy that keeps rewriting the same file.
  const intact = { permissions: { allow: BACKUP.allow, deny: BACKUP.deny } };
  assert.deepEqual(missingFromLive(intact, BACKUP), { allow: [], deny: [] });
});

// The bug that made MAX look like it re-enabled itself: MAX collapses every
// specific entry under Bash(*)/PowerShell(*), and the wildcarder generalizes
// Bash(git status *) into Bash(git *). A verbatim set-difference reads all of the
// now-covered specifics as "missing", crosses the bulk-loss line, and auto-
// restores on every settings.json change. An entry a live wildcard still grants
// is not missing.
test('a backup entry a broader live wildcard covers is not counted as missing', () => {
  const backup = {
    allow: ['Bash(git status *)', 'Bash(git log *)', 'Bash(rg *)', 'PowerShell(Get-Date *)'],
    deny: [],
  };
  // MAX on: the whole allow list has collapsed to the blanket markers.
  const maxed = { permissions: { allow: ['Bash(*)', 'PowerShell(*)'], deny: [] } };
  assert.deepEqual(missingFromLive(maxed, backup), { allow: [], deny: [] },
    'Bash(*)/PowerShell(*) cover every specific — nothing is lost');
  assert.equal(assessPolicy({ live: maxed, backup }).bulkLoss, false,
    'so no auto-restore fires while MAX is on');

  // A narrower generalization also covers its own specifics.
  const generalized = { permissions: { allow: ['Bash(git *)', 'Bash(rg *)', 'PowerShell(Get-Date *)'], deny: [] } };
  assert.deepEqual(missingFromLive(generalized, backup).allow, [],
    'Bash(git *) covers Bash(git status *) and Bash(git log *)');

  // But a genuine loss is still a loss: losing Bash(*) leaves nothing to cover rg.
  const partial = { permissions: { allow: ['Bash(git *)'], deny: [] } };
  assert.deepEqual(missingFromLive(partial, backup).allow, ['Bash(rg *)', 'PowerShell(Get-Date *)'],
    'entries no live wildcard covers are still missing');
});

test('managed deny and ask are reported as unrecoverable, not queued for rewrite', () => {
  const managed = { permissions: {
    deny: ['Bash(rm *)'],
    ask: ['Bash(git push *)'],
  } };
  const shadowed = shadowedByManaged(managed, ['Bash(rm *)', 'Bash(git push *)', 'Bash(rg *)']);
  assert.deepEqual(shadowed, [
    { permission: 'Bash(rm *)', decision: 'deny', rule: 'Bash(rm *)' },
    { permission: 'Bash(git push *)', decision: 'ask', rule: 'Bash(git push *)' },
  ]);
  // deny outranks ask, so a permission matching both reports the blocking one.
  const both = { permissions: { deny: ['Bash(rm *)'], ask: ['Bash(rm *)'] } };
  assert.deepEqual(shadowedByManaged(both, ['Bash(rm *)']),
    [{ permission: 'Bash(rm *)', decision: 'deny', rule: 'Bash(rm *)' }]);
});

test('a managed wildcard shadows the narrower entries beneath it', () => {
  const managed = { permissions: { deny: ['Bash(docker *)'] } };
  const shadowed = shadowedByManaged(managed, ['Bash(docker compose *)', 'Bash(docker run *)']);
  assert.equal(shadowed.length, 2);
  assert.ok(shadowed.every((entry) => entry.rule === 'Bash(docker *)'));
});

test('the two halves are assessed separately, and only one of them writes', () => {
  const live = { permissions: { allow: ['Bash(git *)'], deny: [] } };
  const managed = { permissions: { deny: ['Bash(rm *)'] }, allowManagedHooksOnly: true };
  const assessment = assessPolicy({ live, backup: BACKUP, managed });

  // Recoverable: present in the backup, gone from live.
  assert.equal(assessment.restorable, 5);
  assert.ok(assessment.missing.allow.includes('Bash(tokei *)'));
  assert.ok(assessment.missing.deny.includes('Bash(rm -rf /*)'));

  // Not recoverable: managed policy outranks a user allow entry by design, so
  // re-asserting Bash(rm *) would change nothing.
  assert.deepEqual(assessment.shadowed.map((entry) => entry.permission), ['Bash(rm *)']);

  assert.equal(assessment.capabilities.userHooksDisabled, true);
});

test('managed capabilities name what a policy can switch off under MAX', () => {
  assert.deepEqual(managedCapabilities({
    allowManagedHooksOnly: true,
    permissions: { defaultMode: 'default', disableBypassPermissionsMode: true },
  }), { userHooksDisabled: true, bypassDisabled: true, forcedDefaultMode: 'default' });
  assert.deepEqual(managedCapabilities({}),
    { userHooksDisabled: false, bypassDisabled: false, forcedDefaultMode: null });
  assert.deepEqual(managedCapabilities(undefined),
    { userHooksDisabled: false, bypassDisabled: false, forcedDefaultMode: null });
});

// The original guard watched only for an admin-dropped managed-settings.json.
// On a console-managed org that file never appears: restrictions are configured
// server-side and surface locally as ~/.claude/policy-limits.json, so a guard
// keyed to the admin file watches nothing at all.
test('server-delivered restrictions are a policy signal, not just the admin file', () => {
  assert.match(policyLimitsPath('/home/u'), /\.claude[\\/]policy-limits\.json$/);
  assert.ok(policySignalPaths('win32', '/home/u').some((p) => /policy-limits\.json$/.test(p)),
    'the server-delivered cache must be watched');
  assert.ok(policySignalPaths('win32', '/home/u').some((p) => /managed-settings\.json$/.test(p)),
    'the admin-dropped file must still be watched');

  // The real shape: restrictions keyed by capability with { allowed: false }.
  assert.deepEqual(policyRestrictions({ restrictions: {
    allow_remote_control: { allowed: false },
    allow_workflows: { allowed: false },
    something_permitted: { allowed: true },
  } }), ['allow_remote_control', 'allow_workflows']);
  assert.deepEqual(policyRestrictions({}), []);
  assert.deepEqual(policyRestrictions(undefined), []);
});

// Auto-repair must not fight a deliberate removal. Pruning one entry is an
// instruction; losing most of the list is damage.
test('only a bulk loss is repaired without asking', () => {
  assert.equal(isBulkLoss(1, 292), false, 'one pruned entry is not damage');
  assert.equal(isBulkLoss(4, 292), false);
  assert.equal(isBulkLoss(30, 292), true);
  assert.equal(isBulkLoss(292, 292), true, 'a full wipe is unambiguous');
  assert.equal(isBulkLoss(0, 292), false, 'nothing lost is never a repair');
  // Small backups still need an absolute floor, or every edit looks like a wipe.
  assert.equal(isBulkLoss(2, 4), false);
  assert.equal(isBulkLoss(5, 4), true);

  const live = { permissions: { allow: ['Bash(git *)'], deny: [] } };
  assert.equal(assessPolicy({ live, backup: BACKUP }).bulkLoss, true);
  const nearlyIntact = { permissions: { allow: BACKUP.allow.slice(0, 3), deny: BACKUP.deny } };
  assert.equal(assessPolicy({ live: nearlyIntact, backup: BACKUP }).bulkLoss, false);
});

test('managed settings are looked for where an administrator would put them', () => {
  assert.match(managedSettingsPaths('win32')[0], /ClaudeCode[\\/]managed-settings\.json$/);
  assert.match(managedSettingsPaths('darwin')[0], /Application Support[\\/]ClaudeCode[\\/]managed-settings\.json$/);
  assert.match(managedSettingsPaths('linux')[0], /etc[\\/]claude-code[\\/]managed-settings\.json$/);
});

// The matcher here is a deliberate second copy of the one in autoLearnUi.js, so
// a bug in one cannot silently propagate. Duplication only helps while both
// agree — same rule the two auto-safe gates follow.
test('the guard matcher does not drift from the review matcher', () => {
  const other = require('../vscode-extension/autoLearnUi').permissionMatches;
  const cases = [
    ['Bash(git status *)', 'Bash(git *)'],
    ['Bash(rg --files *)', 'Bash(rg *)'],
    ['Bash(rm *)', 'Bash(rm *)'],
    ['Bash(whoami *)', 'Bash(git *)'],
    ['WebFetch(domain:example.com)', 'WebFetch(*)'],
    ['mcp__figma__get_file', 'mcp__figma__*'],
    ['Bash(a+b)', 'Bash(a+b)'],
    ['Bash(x)', '['],
  ];
  for (const [permission, rule] of cases) {
    assert.equal(
      permissionMatches(permission, rule), other(permission, rule),
      `matchers disagree on ${permission} vs ${rule}`,
    );
  }
});
