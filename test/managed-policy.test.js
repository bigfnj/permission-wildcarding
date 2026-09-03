'use strict';

// Managed settings outrank user settings and evaluate ask before allow, so a
// family a managed ask covers cannot be granted from here: the rule lands and
// the prompt survives. Before this the tool could not see the policy at all,
// so it counted such a grant as a win.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { readPolicy, assessPermission, hookEventAllowed } = require('../src/managed-policy');
const { maxLayers } = require('../src/permissions');
const { createAutoLearnManager } = require('../src/auto-learn-manager');

function policyHome(t, policy) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'permission-wildcarding-policy-'));
  t.after(() => { try { fs.rmSync(home, { recursive: true, force: true }); } catch {} });
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  if (policy !== undefined) {
    fs.writeFileSync(path.join(home, '.claude', 'remote-settings.json'),
      typeof policy === 'string' ? policy : JSON.stringify(policy, null, 2));
  }
  return home;
}

// The managed file uses the colon spelling exclusively, which is the whole
// reason this goes through the shared matcher instead of a local regex.
const MANAGED = {
  permissions: {
    ask: ['Bash(git push:*)', 'Bash(docker:*)', 'Bash(git remote add:*)', 'Read(**/.env*)'],
    allow: ['Bash(head:*)', 'Bash(git status:*)'],
    deny: ['Bash(rm -rf /:*)'],
  },
  allowManagedHooksOnly: true,
  hooks: { PostToolUse: [] },
};

test('a colon-form managed rule is understood, and verdicts follow precedence', (t) => {
  const policy = readPolicy({ home: policyHome(t, MANAGED) });
  assert.equal(policy.present, true);
  assert.equal(policy.ask.length, 3, 'Read(...) is not a command rule');

  // Every command the grant matches also matches the ask rule.
  assert.equal(assessPermission(policy, 'Bash(docker exec *)'), 'inert');
  assert.equal(assessPermission(policy, 'Bash(git push *)'), 'inert');
  // The grant is broader than the ask rule, so only part of it is lost.
  assert.equal(assessPermission(policy, 'Bash(git remote *)'), 'partial');
  // A managed allow means the grant was never needed.
  assert.equal(assessPermission(policy, 'Bash(head *)'), 'redundant');
  // Nothing to say.
  assert.equal(assessPermission(policy, 'Bash(rg *)'), 'effective');
  // Managed rules name the Bash tool, so PowerShell is untouched by them.
  assert.equal(assessPermission(policy, 'PowerShell(docker exec *)'), 'effective');
});

test('an absent policy is not an empty policy, and an unreadable one says so', (t) => {
  const absent = readPolicy({ home: policyHome(t, undefined) });
  assert.equal(absent.present, false);
  assert.equal(absent.unreadable, false);
  assert.equal(assessPermission(absent, 'Bash(docker *)'), 'unknown');

  const broken = readPolicy({ home: policyHome(t, '{ not json') });
  assert.equal(broken.present, false);
  assert.equal(broken.unreadable, true);
  assert.ok(broken.error);
  assert.equal(assessPermission(broken, 'Bash(docker *)'), 'unknown');
});

test('an inert family is withheld from Claude but still offered to Codex', (t) => {
  const home = policyHome(t, MANAGED);
  const statePath = path.join(home, '.claude', 'wildcarding', 'auto-learn-state.json');
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), `${JSON.stringify({ permissions: { allow: [] } }, null, 2)}\n`);
  const family = (key, tokens, permission) => ({
    key, tool: 'Bash', kind: 'shell', shell: 'bash', root: tokens[0], prefix: tokens,
    claudePermission: permission, risk: 'read-only', baseAutoSafe: false, complex: false,
    reasons: ['known-read-only-command'], sources: ['claude'],
    counts: { success: 5, failed: 0, unknown: 0, total: 5 },
  });
  fs.writeFileSync(statePath, `${JSON.stringify({
    version: 1, mode: 'recommend', threshold: 3,
    candidates: {
      'bash:docker exec': family('bash:docker exec', ['docker', 'exec'], 'Bash(docker exec *)'),
      'bash:head': family('bash:head', ['head'], 'Bash(head *)'),
    },
    observationHashes: {}, cursors: {},
    applied: { claude: [], codex: [] }, reviewed: { claude: [], codex: [] },
    codexTargets: {}, managedClaude: {}, lastScanAt: null, lastScanStats: null, lastApplication: null,
  }, null, 2)}\n`);

  const manager = createAutoLearnManager({
    home, threshold: 3,
    codexRulesPath: path.join(home, '.codex', 'rules', 'permission-wildcarding.rules'),
  });
  const listed = manager.listCandidates();
  const docker = listed.find((c) => c.key === 'bash:docker exec');
  const head = listed.find((c) => c.key === 'bash:head');

  assert.equal(docker.policy, 'inert');
  assert.equal(docker.eligibleTargets.includes('claude'), false, 'a managed ask beats a user allow');
  assert.equal(docker.eligibleTargets.includes('codex'), true, 'Codex policy is a separate file');

  // The check is targeted, not a blanket withholding.
  // Only 'inert' is withheld. A redundant grant is harmless and stays offered,
  // because managed policy is a cache and may not be there tomorrow.
  assert.equal(head.policy, 'redundant');
  assert.equal(head.eligibleTargets.includes('claude'), true);
});

test('MAX mode reports a hook the managed policy will drop', (t) => {
  const settings = {
    hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'node "x/approve-all.js"' }] }] },
  };
  const blocked = maxLayers(settings, { home: policyHome(t, MANAGED) });
  assert.equal(blocked.hook, true, 'the hook is registered');
  assert.equal(blocked.hookEventPermitted, false, 'but PreToolUse is not a managed hook event');
  assert.equal(blocked.hookBlocked, true, 'so MAX must say the layer cannot run');

  // A policy that does define the event, and no policy at all, both permit it.
  const permissive = policyHome(t, { allowManagedHooksOnly: true, hooks: { PreToolUse: [], PostToolUse: [] } });
  assert.equal(maxLayers(settings, { home: permissive }).hookBlocked, false);
  assert.equal(maxLayers(settings, { home: policyHome(t, undefined) }).hookBlocked, false);
  assert.equal(hookEventAllowed(readPolicy({ home: policyHome(t, undefined) }), 'PreToolUse'), true);

  // An unregistered hook is not "blocked", it is simply off.
  assert.equal(maxLayers({}, { home: policyHome(t, MANAGED) }).hookBlocked, false);
});
