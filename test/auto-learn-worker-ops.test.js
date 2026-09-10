'use strict';

// The worker's operation gate. It is an allowlist rather than a passthrough so a
// malformed message cannot invoke an arbitrary manager method on a background
// thread, which means every operation the UI may need has to be listed --
// omitting one leaves a caller choosing between a rejected worker and an
// in-process call that blocks the extension host.
//
// A temp home in every case, including the rejection tests: `run` builds the
// manager BEFORE it validates the operation, so a bare `{}` would point the
// manager at the real ~/.claude.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { run } = require('../src/auto-learn-worker');

function options(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'permission-wildcarding-worker-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  return {
    home,
    statePath: path.join(home, '.claude', 'wildcarding', 'auto-learn-state.test.json'),
    codexRulesPath: path.join(home, '.codex', 'rules', 'permission-wildcarding.rules'),
  };
}

test('rebuildManagedHits reaches the manager on the worker thread', (t) => {
  // No policy file, so the answer is fixed: readPolicy reports absent, there is
  // no probe matcher, and the rebuild clears rather than counting. Asserting the
  // absolute report rather than "it did not throw" -- a gate that rejected the
  // operation and a manager that returned nothing are not the same outcome.
  const result = run({ operation: 'rebuildManagedHits', options: options(t) });
  assert.equal(result.policy, 'absent');
  assert.equal(result.degraded, false);
  assert.equal(result.rules, 0);
  assert.equal(result.prompts, 0);
});

test('an unlisted manager method is refused before it runs', (t) => {
  // `status` exists on the manager and is deliberately NOT routed through the
  // worker: it is cheap, read-only, and the UI calls it synchronously. The gate
  // has to refuse a real method, not just a typo.
  assert.throws(
    () => run({ operation: 'status', options: options(t) }),
    /Unsupported Auto Learn worker operation: status/,
  );
});

test('an operation that does not exist at all is refused', (t) => {
  assert.throws(
    () => run({ operation: 'nope', options: options(t) }),
    /Unsupported Auto Learn worker operation: nope/,
  );
  // A missing operation must be refused too, or `data.operation` being undefined
  // would index the manager with `undefined` and fail as a TypeError instead.
  assert.throws(
    () => run({ options: options(t) }),
    /Unsupported Auto Learn worker operation: undefined/,
  );
});
