'use strict';

// A single advisory lock guards every writer that touches agent policy files.
// Auto Learn and the extension's wildcarding pass both mutate
// ~/.claude/settings.json, and Auto Learn writes the claims registry in the
// same operation, so an interleaved write would leave the registry describing
// entries the other writer had already replaced.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const POLICY_LOCK_CODE = 'AUTO_LEARN_LOCKED';
const DEFAULT_STALE_MS = 10 * 60 * 1000;
// One canonical path for every writer — the extension, the CLI, and the Auto
// Learn manager's default. Derive it here rather than re-spelling it per caller,
// so a writer cannot end up holding a lock nobody else contends for.
const POLICY_LOCK_PATH = path.join(os.homedir(), '.claude', 'wildcarding', 'auto-learn-policy.lock');
const POLICY_LOCK_BUSY_MESSAGE =
  'Auto Learn is mid-scan — try again in a moment.';

function createPolicyLock(options = {}) {
  const lockPath = options.lockPath;
  if (!lockPath) throw new Error('A policy lock requires a lock path');
  const staleMs = Number.isFinite(options.staleMs) ? Math.max(0, options.staleMs) : DEFAULT_STALE_MS;
  const clock = typeof options.now === 'function' ? options.now : () => new Date().toISOString();
  const busy = typeof options.busyMessage === 'function'
    ? options.busyMessage
    : (target) => `Auto Learn is already running (lock: ${target})`;

  function removeOwnedLock(owner) {
    try {
      const metadata = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      if (metadata.owner !== owner) return false;
      fs.unlinkSync(lockPath);
      return true;
    } catch {
      return false;
    }
  }

  // Only reclaim a lock whose owner is provably gone, and only after confirming
  // the file did not change while that was being decided.
  function recoverLock() {
    try {
      const stat = fs.statSync(lockPath);
      const text = fs.readFileSync(lockPath, 'utf8');
      let metadata = {};
      try { metadata = JSON.parse(text); } catch {}
      const validPid = Number.isInteger(metadata.pid) && metadata.pid > 0;
      if (validPid) {
        let alive = true;
        try { process.kill(metadata.pid, 0); }
        catch (error) {
          if (error.code === 'ESRCH') alive = false;
          else return false;
        }
        if (alive) return false;
      } else if (Date.now() - stat.mtimeMs <= staleMs) {
        return false;
      }
      const before = { text, size: stat.size, mtimeMs: stat.mtimeMs, ino: stat.ino };
      const verifyStat = fs.statSync(lockPath);
      const verifyText = fs.readFileSync(lockPath, 'utf8');
      if (verifyStat.size !== before.size || verifyStat.mtimeMs !== before.mtimeMs ||
          verifyStat.ino !== before.ino || verifyText !== before.text) return false;
      fs.unlinkSync(lockPath);
      return true;
    } catch (error) {
      if (error.code === 'ENOENT') return true;
      return false;
    }
  }

  function locked(operation) {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    const owner = crypto.randomBytes(16).toString('hex');
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let fd;
      let created = false;
      let failure;
      try {
        fd = fs.openSync(lockPath, 'wx', 0o600);
        created = true;
        fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, owner, at: clock() }) + '\n', 'utf8');
        fs.fsyncSync(fd);
      } catch (error) {
        failure = error;
      } finally {
        if (fd !== undefined) try { fs.closeSync(fd); } catch {}
      }
      if (!failure) break;
      if (created) removeOwnedLock(owner);
      if (failure.code === 'EEXIST' && attempt === 0 && recoverLock()) continue;
      if (failure.code === 'EEXIST') {
        const conflict = new Error(busy(lockPath));
        conflict.code = POLICY_LOCK_CODE;
        throw conflict;
      }
      throw failure;
    }
    try { return operation(); }
    finally { removeOwnedLock(owner); }
  }

  return { locked, path: lockPath };
}

module.exports = {
  createPolicyLock,
  POLICY_LOCK_CODE,
  POLICY_LOCK_PATH,
  POLICY_LOCK_BUSY_MESSAGE,
  DEFAULT_POLICY_LOCK_STALE_MS: DEFAULT_STALE_MS,
};
