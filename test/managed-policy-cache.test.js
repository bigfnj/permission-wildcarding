'use strict';

// The managed policy is cached per manager so a listing does not re-read it once
// per candidate. It used to be cached for the manager's LIFETIME, and the
// extension holds one manager across policy changes with nothing watching the
// policy file, so `status()` kept reporting the pre-change verdict until some
// unrelated event happened to rebuild the manager.
//
// mtime is set explicitly with utimesSync rather than raced against the
// filesystem, the same way the policy-lock test does it: neither platform's
// timestamp granularity should decide whether this passes.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createAutoLearnManager } = require('../src/auto-learn-manager');

const PERMISSION = 'Bash(curl *)';

function setup(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'permission-wildcarding-polcache-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  const policyPath = path.join(home, '.claude', 'remote-settings.json');
  let stamp = Date.now() / 1000;
  const writePolicy = (permissions) => {
    fs.writeFileSync(policyPath, `${JSON.stringify({ permissions }, null, 2)}\n`);
    // Advance mtime deliberately, well past any filesystem granularity.
    stamp += 10;
    fs.utimesSync(policyPath, stamp, stamp);
  };
  const manager = createAutoLearnManager({
    home,
    threshold: 3,
    statePath: path.join(home, '.claude', 'wildcarding', 'auto-learn-state.test.json'),
    codexRulesPath: path.join(home, '.codex', 'rules', 'permission-wildcarding.rules'),
  });
  return { home, manager, policyPath, writePolicy };
}

test('a policy change is picked up without rebuilding the manager', (t) => {
  const env = setup(t);

  env.writePolicy({ deny: ['Bash(curl:*)'] });
  assert.equal(env.manager.explainManaged(PERMISSION).verdict, 'inert',
    'a managed deny covering the permission makes a user grant inert');

  // Same manager, same process. Only the file changed.
  env.writePolicy({ allow: ['Bash(curl:*)'] });
  assert.equal(env.manager.explainManaged(PERMISSION).verdict, 'redundant',
    'once the managed policy allows it, the user grant is redundant, not inert');
});

test('a policy that appears later invalidates the absent verdict', (t) => {
  const env = setup(t);

  // The normal console-managed case: no managed-settings file at all. `absent`
  // has to be a cached key rather than a cache miss, or every call re-reads --
  // and it still has to invalidate when a file shows up.
  assert.equal(env.manager.explainManaged(PERMISSION).policy, 'absent');
  assert.equal(env.manager.explainManaged(PERMISSION).verdict, 'unknown');

  env.writePolicy({ deny: ['Bash(curl:*)'] });
  const after = env.manager.explainManaged(PERMISSION);
  assert.equal(after.policy, 'present');
  assert.equal(after.verdict, 'inert');
});

test('an injected policy is never re-read from disk', (t) => {
  const env = setup(t);
  // A file that says the opposite of the injected object, to prove which one wins.
  env.writePolicy({ deny: ['Bash(curl:*)'] });

  const injected = createAutoLearnManager({
    home: env.home,
    threshold: 3,
    statePath: path.join(env.home, '.claude', 'wildcarding', 'injected-state.test.json'),
    codexRulesPath: path.join(env.home, '.codex', 'rules', 'permission-wildcarding.rules'),
    managedPolicy: {
      path: env.policyPath,
      present: true,
      unreadable: false,
      error: null,
      ask: [],
      allow: [],
      deny: [],
      raw: { ask: [], allow: [], deny: [] },
      hookEvents: [],
      managedHooksOnly: false,
    },
  });

  // The injected policy has no rules, so the permission is effective. If the
  // stat path touched an injected policy, this would read the file's deny and
  // report `inert` instead.
  assert.equal(injected.explainManaged(PERMISSION).verdict, 'effective');
  env.writePolicy({ allow: ['Bash(curl:*)'] });
  assert.equal(injected.explainManaged(PERMISSION).verdict, 'effective',
    'a caller-supplied policy object must survive any number of file changes');
});
