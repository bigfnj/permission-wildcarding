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

// The reclaim boundary, made deterministic. The test above reaches it only by
// accident of timing: `stat.mtimeMs` carries sub-millisecond precision while
// `Date.now()` is whole milliseconds, so a just-written file can read as being
// from the future. Measured over 200 writes, the raw difference ranged from
// -1.07 ms to +1.09 ms and was zero or negative 111 times.
//
// On Windows the intervening `patient.locked()` attempt burns more than a
// millisecond of file operations, so the age is positive by the time it
// matters and the old `<=` comparison passed. On Linux those operations are
// fast enough that the age is still zero, which is why CI failed on v1.4.0 and
// v1.3.0 passed by luck. Setting mtime explicitly removes the lottery.
test('the reclaim boundary does not depend on sub-millisecond timing', (t) => {
  const lockPath = tempLock(t);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });

  const atAge = (ms) => {
    fs.writeFileSync(lockPath, 'not json\n');
    const when = new Date(Date.now() - ms);
    fs.utimesSync(lockPath, when, when);
  };

  // `staleMs: 0` must mean "reclaim immediately", so an age of exactly zero
  // reclaims. Under `<=` this returned false and the lock was never reclaimed.
  atAge(0);
  assert.equal(createPolicyLock({ lockPath, staleMs: 0 }).locked(() => 'now'), 'now');

  // A clock skew that puts the file in the future must not read as "fresh
  // forever" either; the age is clamped rather than left negative.
  atAge(-5000);
  assert.equal(createPolicyLock({ lockPath, staleMs: 0 }).locked(() => 'future'), 'future');

  // A lock younger than the window is still held, which is the whole point.
  atAge(0);
  assert.throws(() => createPolicyLock({ lockPath, staleMs: 60_000 }).locked(() => {}),
    (error) => error.code === POLICY_LOCK_CODE);
  atAge(59_000);
  assert.throws(() => createPolicyLock({ lockPath, staleMs: 60_000 }).locked(() => {}),
    (error) => error.code === POLICY_LOCK_CODE);

  // And older than the window is reclaimed.
  atAge(61_000);
  assert.equal(createPolicyLock({ lockPath, staleMs: 60_000 }).locked(() => 'stale'), 'stale');
});
