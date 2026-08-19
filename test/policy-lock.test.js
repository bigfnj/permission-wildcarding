'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createPolicyLock, POLICY_LOCK_CODE } = require('../src/policy-lock');

function tempLock(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'permission-wildcarding-lock-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'nested', 'auto-learn-policy.lock');
}

test('one holder at a time, and the lock is released on both paths', (t) => {
  const lockPath = tempLock(t);
  const first = createPolicyLock({ lockPath });
  const second = createPolicyLock({ lockPath });

  // Auto Learn and the wildcarding pass are separate lock objects over one path,
  // so the second writer must be told to back off rather than interleave.
  first.locked(() => {
    assert.ok(fs.existsSync(lockPath), 'the lock file exists while held');
    assert.throws(() => second.locked(() => {}), (error) => error.code === POLICY_LOCK_CODE);
  });
  assert.ok(!fs.existsSync(lockPath), 'released after the callback returns');

  assert.throws(() => first.locked(() => { throw new Error('write failed'); }), /write failed/);
  assert.ok(!fs.existsSync(lockPath), 'released after the callback throws');

  assert.equal(second.locked(() => 'ran'), 'ran');
});

test('a lock left by a dead process is reclaimed, a live one is not', (t) => {
  const lockPath = tempLock(t);
  const lock = createPolicyLock({ lockPath });
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });

  // A pid that cannot exist stands in for a crashed holder.
  fs.writeFileSync(lockPath, JSON.stringify({ pid: 2 ** 31 - 1, owner: 'gone' }) + '\n');
  assert.equal(lock.locked(() => 'reclaimed'), 'reclaimed');

  fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, owner: 'alive' }) + '\n');
  assert.throws(() => lock.locked(() => {}), (error) => error.code === POLICY_LOCK_CODE);
  assert.deepEqual(JSON.parse(fs.readFileSync(lockPath, 'utf8')).owner, 'alive',
    'a live holder keeps its lock file');
});

test('an ownerless lock is only reclaimed once it is stale', (t) => {
  const lockPath = tempLock(t);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, 'not json\n');

  const patient = createPolicyLock({ lockPath, staleMs: 10 * 60 * 1000 });
  assert.throws(() => patient.locked(() => {}), (error) => error.code === POLICY_LOCK_CODE);

  const impatient = createPolicyLock({ lockPath, staleMs: 0 });
  assert.equal(impatient.locked(() => 'reclaimed'), 'reclaimed');
});
