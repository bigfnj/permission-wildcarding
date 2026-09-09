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

// Regression: the guard read a settings.json it could not parse as a settings.json
// that grants nothing, so all 307 backup entries looked missing, the loss cleared
// the bulk-loss line, and it auto-restored the entire list against a file that was
// intact the whole time. Claude Code rewrites this file in place on every /model
// and /effort change, so the mid-write window is hit in normal use.
test('a settings.json that could not be read is unknown, not empty', () => {
  const unknown = assessPolicy({ live: null, backup: BACKUP });
  assert.equal(unknown.unreadable, true);
  assert.equal(unknown.restorable, 0, 'nothing is restorable from a state we did not observe');
  assert.equal(unknown.bulkLoss, false, 'and nothing is written');
  assert.deepEqual(unknown.missing, { allow: [], deny: [] });
  assert.deepEqual(unknown.shadowed, [], 'shadowing is a claim about a live surface we lack');

  // Omitting live entirely is the same unknown, not an implicit empty policy.
  assert.equal(assessPolicy({ backup: BACKUP }).bulkLoss, false);

  // An allow list that is genuinely empty still reads as the wipe it is.
  const wiped = assessPolicy({ live: { permissions: { allow: [], deny: [] } }, backup: BACKUP });
  assert.equal(wiped.unreadable, false);
  assert.equal(wiped.restorable, 6);
  assert.equal(wiped.bulkLoss, true, 'a real wipe must still be repaired');
});

test('managed settings are looked for where an administrator would put them', () => {
  assert.match(managedSettingsPaths('win32')[0], /ClaudeCode[\\/]managed-settings\.json$/);
  assert.match(managedSettingsPaths('darwin')[0], /Application Support[\\/]ClaudeCode[\\/]managed-settings\.json$/);
  assert.match(managedSettingsPaths('linux')[0], /etc[\\/]claude-code[\\/]managed-settings\.json$/);
  // Windows moved: 2.1.245 probes Program Files (measured from its own debug log),
  // older builds used ProgramData. Both are watched, current location first.
  const windows = managedSettingsPaths('win32');
  assert.equal(windows.length, 2);
  assert.match(windows[0], /Program Files[\\/]ClaudeCode[\\/]managed-settings\.json$/);
  assert.match(windows[1], /ProgramData[\\/]ClaudeCode[\\/]managed-settings\.json$/);
  // policy-limits.json rides along, so the server-delivered case is watched too.
  assert.equal(policySignalPaths('win32').length, 3);
});

// This test used to be unable to fail, which is worse than not existing: it
// named the exact drift it could not detect. It asserted only that two
// implementations AGREE, so any input where both were wrong passed, and none of
// its eight cases could separate them. The two shapes that can are the ones the
// managed policy actually uses: the `:*` spelling, which the managed file uses
// exclusively (see src/managed-policy.js), and a bare command against a lone
// trailing ` *`. Both are now here, and every case carries the ABSOLUTE
// expected answer, so agreement on a wrong answer is a failure.
test('the guard matcher agrees with the review matcher, and both are right', () => {
  const other = require('../vscode-extension/autoLearnUi').permissionMatches;
  const cases = [
    ['Bash(git status *)', 'Bash(git *)', true],
    ['Bash(rg --files *)', 'Bash(rg *)', true],
    ['Bash(rm *)', 'Bash(rm *)', true],
    ['Bash(whoami *)', 'Bash(git *)', false],
    ['WebFetch(domain:example.com)', 'WebFetch(*)', true],
    ['mcp__figma__get_file', 'mcp__figma__*', true],
    ['Bash(a+b)', 'Bash(a+b)', true],
    ['Bash(x)', '[', false],
    // The colon spelling. A managed `ask` is written this way, and a matcher
    // blind to it reports a shadowed grant as healthy.
    ['Bash(docker ps)', 'Bash(docker:*)', true],
    ['Bash(head -n 5 x)', 'Bash(head:*)', true],
    ['Bash(git push origin main)', 'Bash(git push:*)', true],
    ['Bash(gitk)', 'Bash(git:*)', false],
    // The bare-command allowance: a lone trailing ` *` also matches the prefix
    // alone, and only while it is the rule's ONLY wildcard.
    ['Bash(git)', 'Bash(git *)', true],
    ['Bash(ls)', 'Bash(ls *)', true],
    ['Bash(git)', 'Bash(git * --x *)', false],
  ];
  for (const [permission, rule, expected] of cases) {
    assert.equal(
      permissionMatches(permission, rule), expected,
      `guard matcher wrong on ${permission} vs ${rule}`,
    );
    assert.equal(
      other(permission, rule), expected,
      `review matcher wrong on ${permission} vs ${rule}`,
    );
  }
});
