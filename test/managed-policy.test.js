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

const { readPolicy, assessPermission, overridingRule, hookEventAllowed } = require('../src/managed-policy');
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

test('the rule that outranks a permission is named, with deny before ask', (t) => {
  const policy = readPolicy({ home: policyHome(t, MANAGED) });

  // The colon spelling is what the report has to print: it is the string the
  // reader will search the managed file for.
  assert.deepEqual(overridingRule(policy, 'Bash(docker exec *)'),
    { decision: 'ask', rule: 'Bash(docker:*)' });
  assert.deepEqual(overridingRule(policy, 'Bash(rm -rf / *)'),
    { decision: 'deny', rule: 'Bash(rm -rf /:*)' });

  // Nothing to report is null, not an empty object: a grant that works must
  // not show up in a list of grants that cannot.
  assert.equal(overridingRule(policy, 'Bash(rg *)'), null);
  assert.equal(overridingRule(policy, 'Bash(head *)'), null, 'a managed allow does not outrank');
  assert.equal(overridingRule(policy, 'PowerShell(docker exec *)'), null, 'managed rules name Bash');
  // Broader than the rule, so the rule does not cover every command it matches.
  assert.equal(overridingRule(policy, 'Bash(git remote *)'), null);

  // Not a command rule, so `rulePrefix` cannot model it and the whole
  // permission string is matched instead. The managed ask does carry
  // Read(**/.env*), and naming it is the point: a policy that gates Read and
  // Edit paths was previously assessed as `unknown` and reported as nothing.
  assert.deepEqual(overridingRule(policy, 'Read(**/.env*)'),
    { decision: 'ask', rule: 'Read(**/.env*)' });
  // A concrete path the managed glob covers, which is the shape a scan probes.
  assert.deepEqual(overridingRule(policy, 'Read(/srv/app/.env.local)'),
    { decision: 'ask', rule: 'Read(**/.env*)' });

  // Controls on the same path: matching nothing still reports nothing, and a
  // tool-level rule is broader than the glob rather than covered by it, so it
  // is not dead and must not be named.
  assert.equal(overridingRule(policy, 'WebFetch(domain:example.com)'), null);
  assert.equal(overridingRule(policy, 'mcp__context7__query-docs'), null);
  assert.equal(overridingRule(policy, 'Read'), null, 'a bare tool rule is broader, not dead');
  assert.equal(overridingRule(policy, 'Read(**/notes.md)'), null);
  assert.equal(overridingRule(policy, 'not a rule at all'), null);

  // Direction matters, and the vocabulary matches the command path: covered is
  // inert, covering is partial.
  assert.equal(assessPermission(policy, 'Read(**/.env*)'), 'inert');
  assert.equal(assessPermission(policy, 'Read'), 'partial');
  assert.equal(assessPermission(policy, 'Write'), 'effective', 'no managed Write rule exists');
  assert.equal(assessPermission(policy, 'not a rule at all'), 'unknown');

  // Precedence is deny, then ask, and a policy can carry both for one command.
  const both = readPolicy({
    home: policyHome(t, { permissions: { deny: ['Bash(docker:*)'], ask: ['Bash(docker:*)'] } }),
  });
  assert.deepEqual(overridingRule(both, 'Bash(docker exec *)'),
    { decision: 'deny', rule: 'Bash(docker:*)' });

  const absent = readPolicy({ home: policyHome(t, undefined) });
  assert.equal(overridingRule(absent, 'Bash(docker *)'), null);
});

// The verdict was already computed for every candidate and read by nothing, so
// a blocked family left Review silently while its prompts kept arriving. These
// two tests are the report that replaces the silence.
function reportHome(t, policy, allow) {
  const home = policyHome(t, policy);
  const statePath = path.join(home, '.claude', 'wildcarding', 'auto-learn-state.json');
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'),
    `${JSON.stringify({ permissions: { allow } }, null, 2)}\n`);
  const family = (key, tokens, permission, runs) => ({
    key, tool: 'Bash', kind: 'shell', shell: 'bash', root: tokens[0], prefix: tokens,
    claudePermission: permission, risk: 'read-only', baseAutoSafe: false, complex: false,
    reasons: ['known-read-only-command'], sources: ['claude'],
    counts: { success: runs, failed: 0, unknown: 0, total: runs },
  });
  fs.writeFileSync(statePath, `${JSON.stringify({
    version: 1, mode: 'recommend', threshold: 3,
    candidates: {
      // Run counts deliberately disagree with alphabetical order, so an
      // assertion on the ordering cannot be satisfied by sorting on the key.
      'bash:git push': family('bash:git push', ['git', 'push'], 'Bash(git push *)', 9),
      'bash:docker exec': family('bash:docker exec', ['docker', 'exec'], 'Bash(docker exec *)', 4),
      'bash:head': family('bash:head', ['head'], 'Bash(head *)', 5),
    },
    observationHashes: {}, cursors: {},
    applied: { claude: [], codex: [] }, reviewed: { claude: [], codex: [] },
    codexTargets: {}, managedClaude: {}, lastScanAt: null, lastScanStats: null, lastApplication: null,
  }, null, 2)}\n`);
  return { home, settingsPath: path.join(home, '.claude', 'settings.json') };
}

test('status reports which families a managed rule blocks, and which grants are already dead', (t) => {
  // Controls, so the report is shown to be selective: one live command grant,
  // and two non-command rules of the kind every real allow list carries. The
  // Read entry IS covered by the managed ask and must be reported: a managed
  // policy carries Read and Edit rules, and reporting only the command ones
  // left the largest real prompt source unnamed. The WebFetch entry is the
  // control for the same path, matching nothing and staying out of the list.
  const startingAllow = [
    'Bash(docker *)', 'Bash(rg *)', 'Bash(git push *)',
    'Read(**/.env*)', 'WebFetch(domain:example.com)',
  ];
  const { home, settingsPath } = reportHome(t, MANAGED, startingAllow);
  const manager = createAutoLearnManager({
    home, threshold: 3,
    codexRulesPath: path.join(home, '.codex', 'rules', 'permission-wildcarding.rules'),
  });
  const { managed } = manager.status();

  assert.equal(managed.policy, 'present');
  assert.equal(managed.degraded, false);
  assert.deepEqual(managed.verdicts,
    { inert: 2, partial: 0, redundant: 1, effective: 0, unknown: 0 });

  // Ordered by observed runs: the family costing the most prompts is the one
  // worth explaining first.
  assert.deepEqual(managed.inertFamilies.map((entry) => entry.key),
    ['bash:git push', 'bash:docker exec']);
  assert.deepEqual(managed.inertFamilies[0], {
    key: 'bash:git push', permission: 'Bash(git push *)', runs: 9,
    decision: 'ask', rule: 'Bash(git push:*)',
  });

  // Entries the user already wrote that the same rules outrank. `Bash(rg *)` is
  // live and must not appear, and neither must the WebFetch entry, which no
  // managed rule covers.
  assert.deepEqual(managed.deadAllowEntries, [
    { permission: 'Bash(docker *)', decision: 'ask', rule: 'Bash(docker:*)' },
    { permission: 'Bash(git push *)', decision: 'ask', rule: 'Bash(git push:*)' },
    { permission: 'Read(**/.env*)', decision: 'ask', rule: 'Read(**/.env*)' },
  ]);

  // Reported, never removed. The policy file is a client-refreshed cache, so
  // deleting a grant because a stale copy calls it dead is the worse failure.
  const after = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  assert.deepEqual(after.permissions.allow, startingAllow);
});

test('explainManaged answers for one pasted command, not just learned families', (t) => {
  const { home } = reportHome(t, MANAGED, []);
  const manager = createAutoLearnManager({ home, threshold: 3, codexRulesPath: null });

  // The command need not be a learned family: "why did this prompt?" is asked
  // about whatever the user just pasted.
  assert.deepEqual(manager.explainManaged('Bash(docker compose up *)'), {
    policy: 'present', degraded: false, verdict: 'inert',
    override: { decision: 'ask', rule: 'Bash(docker:*)' },
  });
  assert.deepEqual(manager.explainManaged('Bash(rg *)'), {
    policy: 'present', degraded: false, verdict: 'effective', override: null,
  });
  assert.equal(manager.explainManaged('Bash(head *)').verdict, 'redundant');

  const broken = reportHome(t, '{ not json', []);
  const degraded = createAutoLearnManager({ home: broken.home, threshold: 3, codexRulesPath: null })
    .explainManaged('Bash(docker exec *)');
  assert.equal(degraded.degraded, true);
  assert.equal(degraded.policy, 'unreadable');
  assert.equal(degraded.override, null, 'a policy that could not be read overrides nothing');
});

test('an unreadable managed policy reports degraded, not an all-clear', (t) => {
  const { home } = reportHome(t, '{ not json', ['Bash(docker *)']);
  const manager = createAutoLearnManager({
    home, threshold: 3,
    codexRulesPath: path.join(home, '.codex', 'rules', 'permission-wildcarding.rules'),
  });
  const { managed } = manager.status();

  assert.equal(managed.policy, 'unreadable');
  assert.equal(managed.degraded, true);
  assert.ok(managed.error, 'the parse failure is carried, not swallowed');
  // A zero here would read as "nothing is blocked" when the truth is "the check
  // could not run", which is the one confusion this block exists to prevent.
  assert.equal(managed.verdicts, null);
  assert.deepEqual(managed.inertFamilies, []);
  assert.deepEqual(managed.deadAllowEntries, []);

  // Absent is a third state, and it is not degraded: a machine with no managed
  // policy simply has no file.
  const clean = reportHome(t, undefined, ['Bash(docker *)']);
  const absent = createAutoLearnManager({ home: clean.home, threshold: 3 }).status().managed;
  assert.equal(absent.policy, 'absent');
  assert.equal(absent.degraded, false);
  assert.equal(absent.verdicts, null);
});
