'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CLI = path.resolve(__dirname, '..', 'bin', 'wildcard-perms');

// Run the real CLI against a throwaway home, so MAX's sidecar snapshot and the
// approve hook land in the temp tree rather than the developer's ~/.claude.
function runCli(home, args) {
  const root = path.parse(home).root;
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: home, encoding: 'utf8', windowsHide: true,
    env: {
      ...process.env, HOME: home, USERPROFILE: home,
      HOMEDRIVE: root.replace(/[\\/]$/, ''), HOMEPATH: home.slice(root.length - 1),
    },
  });
}

function tempHome(t, allow) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'permission-wildcarding-max-'));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.claude', 'settings.json'),
    JSON.stringify({ permissions: { allow } }, null, 2) + '\n',
  );
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

const allowList = (home) => JSON.parse(
  fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'),
).permissions.allow;

// MAX-on prunes the real allow list away under Bash(*), so MAX-off has to union
// the sidecar snapshot with what is present now. Restoring the snapshot alone
// silently dropped anything granted in between — an Auto Learn application, or a
// permission Claude Code persisted from a real approval.
test('CLI --max round-trip keeps permissions granted while MAX was on', (t) => {
  const home = tempHome(t, ['Bash(git status *)', 'Bash(rg *)']);

  const on = runCli(home, ['--max', 'on']);
  assert.equal(on.status, 0, on.stderr || on.stdout);
  assert.ok(allowList(home).includes('Bash(*)'), 'MAX on should inject the blanket set');

  // A grant that lands while MAX is on.
  const settingsPath = path.join(home, '.claude', 'settings.json');
  const during = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  during.permissions.allow.push('Bash(tokei *)');
  fs.writeFileSync(settingsPath, JSON.stringify(during, null, 2) + '\n');

  const off = runCli(home, ['--max', 'off']);
  assert.equal(off.status, 0, off.stderr || off.stdout);

  const after = allowList(home);
  assert.deepEqual(after, ['Bash(git status *)', 'Bash(rg *)', 'Bash(tokei *)']);
  assert.equal(after.includes('Bash(*)'), false, 'no blanket marker may survive MAX off');
});

// The toggles are policy writers like any other, so they take the shared lock
// rather than racing Auto Learn's settings + claims-registry write.
test('CLI --max refuses to write while the policy lock is held', (t) => {
  const home = tempHome(t, ['Bash(git status *)']);
  const lockPath = path.join(home, '.claude', 'wildcarding', 'auto-learn-policy.lock');
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  // This test process is alive, so the lock is never reclaimed as stale.
  fs.writeFileSync(lockPath, JSON.stringify({
    pid: process.pid, owner: 'test-owner', at: new Date().toISOString(),
  }) + '\n');

  const result = runCli(home, ['--max', 'on']);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /Auto Learn is mid-scan/);
  assert.deepEqual(allowList(home), ['Bash(git status *)'], 'settings must be untouched');
});

test('CLI --learn honors explicit workspace partition and Codex off scope', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'permission-wildcarding-cli-'));
  const workspace = path.join(home, 'workspaces', 'sample');
  const settings = path.join(home, '.claude', 'settings.json');
  const codexRules = path.join(home, '.codex', 'rules', 'permission-wildcarding.rules');
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  fs.mkdirSync(path.dirname(codexRules), { recursive: true });
  fs.writeFileSync(settings, '{"permissions":{"allow":["ManualSentinel"]}}\n');
  fs.writeFileSync(codexRules, '# manual Codex sentinel\n');
  const settingsBefore = fs.readFileSync(settings, 'utf8');
  const codexBefore = fs.readFileSync(codexRules, 'utf8');
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  const root = path.parse(home).root;
  const result = spawnSync(process.execPath, [
    path.resolve(__dirname, '..', 'bin', 'wildcard-perms'),
    '--learn', 'status', '--mode', 'recommend',
    '--workspace', workspace, '--codex-scope', 'off',
  ], {
    cwd: path.dirname(workspace), encoding: 'utf8', windowsHide: true,
    env: {
      ...process.env, HOME: home, USERPROFILE: home,
      HOMEDRIVE: root.replace(/[\\/]$/, ''), HOMEPATH: home.slice(root.length - 1),
    },
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const status = JSON.parse(result.stdout);
  assert.equal(path.resolve(status.paths.claudeSettings), path.resolve(settings));
  assert.equal(status.paths.codexRules, null);
  assert.equal(path.dirname(status.paths.state), path.join(home, '.claude', 'wildcarding'));
  assert.match(path.basename(status.paths.state), /^auto-learn-state\.[0-9a-f]{16}\.json$/);
  assert.equal(fs.existsSync(status.paths.state), true);
  assert.equal(fs.readFileSync(settings, 'utf8'), settingsBefore);
  assert.equal(fs.readFileSync(codexRules, 'utf8'), codexBefore);
  assert.equal(fs.existsSync(
    path.join(workspace, '.codex', 'rules', 'permission-wildcarding.rules'),
  ), false);
});

// MAX-on snapshots the allow list, then prunes every specific entry the blanket
// set covers. That snapshot is the ONLY way MAX-off restores them, and the write
// used to be best-effort: it swallowed its failure and returned nothing, so the
// prune went ahead anyway. With no snapshot, disableMaxAllow computes
// `restored = kept` and leaves the user the blanket entries and nothing else —
// 423 permissions traded for 7. The comment justifying "best-effort" was borrowed
// from writeBypassState, where a lost stash really is benign.
test('CLI --max refuses to turn on when the snapshot cannot be written', (t) => {
  const home = tempHome(t, ['Bash(git status *)', 'Bash(rg *)']);
  // Make the snapshot's directory un-creatable by putting a FILE where it goes,
  // so mkdirSync throws. Portable, and no permission fiddling.
  fs.writeFileSync(path.join(home, '.claude', 'backups'), 'not a directory\n');

  const result = runCli(home, ['--max', 'on']);
  assert.equal(result.status, 1, `must refuse, not proceed; stdout: ${result.stdout}`);
  assert.match(result.stderr, /refused/, 'and say so');
  assert.doesNotMatch(result.stdout, /already ON/,
    '"already ON" would be the worst answer: MAX is off, the user thinks it is on, '
      + 'and the snapshot that alone could restore their list does not exist');
  assert.deepEqual(allowList(home), ['Bash(git status *)', 'Bash(rg *)'],
    'the allow list is untouched — nothing was pruned under a blanket that was never added');
  const settings = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'));
  assert.ok(!settings.hooks?.PreToolUse,
    'and the approve hook must not be registered either: a half-applied MAX reports a '
      + 'layer it never established');
});
