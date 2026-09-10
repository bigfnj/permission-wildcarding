'use strict';

// Hook mode — the PostToolUse path, which had no test coverage at all despite
// being the highest-frequency writer of settings.json on a real machine.
//
// It used to read the file, spend ~57 ms in processAllowList, then spread its
// stale snapshot back with no lock and no re-read. Claude Code rewrites that file
// in place on every /model, /effort and approval, so the common casualty was
// model / effortLevel / hooks. The pass is also required to be silent and to exit
// 0 whatever happens: it runs after every single tool call, and a noisy or
// non-zero hook is paid constantly.

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CLI = path.resolve(__dirname, '..', 'bin', 'wildcard-perms');

// The real CLI in hook mode: no arguments, the event as JSON on stdin. `input`
// is what no existing test supplied, which is why this path was never entered.
function runHook(home, event) {
  const root = path.parse(home).root;
  return spawnSync(process.execPath, [CLI], {
    cwd: home, encoding: 'utf8', windowsHide: true,
    input: JSON.stringify(event ?? {}),
    env: {
      ...process.env, HOME: home, USERPROFILE: home,
      HOMEDRIVE: root.replace(/[\\/]$/, ''), HOMEPATH: home.slice(root.length - 1),
    },
  });
}

function tempHome(t, settings) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'permission-wildcarding-hook-'));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.claude', 'settings.json'),
    JSON.stringify(settings, null, 2) + '\n',
  );
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

const settingsOf = (home) => JSON.parse(
  fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'),
);

test('the hook generalizes without disturbing anything else in the file', (t) => {
  const home = tempHome(t, {
    model: 'claude-opus-5',
    effortLevel: 'high',
    hooks: { PostToolUse: [{ matcher: 'Bash|PowerShell', hooks: [{ type: 'command', command: 'node x' }] }] },
    permissions: {
      allow: ['Bash(git status)', 'Bash(git diff)', 'Bash(rg foo)', 'Bash(rg bar)'],
      deny: ['Bash(rm -rf /*)'],
    },
  });

  const result = runHook(home, { cwd: home });
  assert.equal(result.status, 0, `hook must always exit 0; stderr: ${result.stderr}`);

  const after = settingsOf(home);
  // The two documented shapes, pinned together: a fixed-purpose tool collapses to
  // its root, while a mixed-capability dispatcher keeps the subcommand boundary —
  // so `rg` becomes one entry and `git` stays two.
  assert.ok(after.permissions.allow.includes('Bash(rg *)'),
    'a fixed-purpose command generalizes to its root');
  assert.ok(after.permissions.allow.includes('Bash(git status *)'),
    'a dispatcher keeps its subcommand: Bash(git *) would grant push, reset and clean too');
  assert.ok(!after.permissions.allow.includes('Bash(git *)'),
    'and must NOT collapse to the root');
  assert.equal(after.model, 'claude-opus-5');
  assert.equal(after.effortLevel, 'high');
  assert.deepEqual(after.permissions.deny, ['Bash(rm -rf /*)'],
    'the safety boundary survives its own tool rewriting the file');
  assert.deepEqual(after.hooks.PostToolUse[0].matcher, 'Bash|PowerShell',
    'losing the hook registration would silently disable this tool');
});

test('a held policy lock stops the write, silently and with exit 0', (t) => {
  // The write used to take NO lock, so it landed regardless of who held it —
  // able to interleave with Auto Learn's settings write and its claims write,
  // which is the exact failure src/policy-lock.js exists to prevent. Now the
  // changed path is lock-guarded, and losing the race must cost nothing: the
  // next tool call fires the hook again and the pass is idempotent.
  const before = ['Bash(git status)', 'Bash(git diff)', 'Bash(git log)'];
  const home = tempHome(t, { permissions: { allow: before } });
  const lockPath = path.join(home, '.claude', 'wildcarding', 'auto-learn-policy.lock');
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  // This test process is alive, so the lock is never reclaimed as stale.
  fs.writeFileSync(lockPath, JSON.stringify({
    pid: process.pid, owner: 'test-owner', at: new Date().toISOString(),
  }) + '\n');

  const result = runHook(home, { cwd: home });
  assert.equal(result.status, 0, 'a busy lock is not an error on the hook path');
  assert.equal(result.stderr, '', `the hook path is quiet by design; got: ${result.stderr}`);
  assert.deepEqual(settingsOf(home).permissions.allow, before,
    'nothing may be written while another policy writer holds the lock');
});

test('an already-optimal list is left alone, with no output', (t) => {
  // The common case by a wide margin — measured at 404 of 423 entries already
  // generalized on a real machine. It must not write, and must not lock.
  const allow = ['Bash(git *)', 'Bash(rg *)'];
  const home = tempHome(t, { permissions: { allow } });
  const file = path.join(home, '.claude', 'settings.json');
  const beforeMtime = fs.statSync(file).mtimeMs;

  const result = runHook(home, { cwd: home });
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '', 'a no-op pass says nothing');
  assert.deepEqual(settingsOf(home).permissions.allow, allow);
  assert.equal(fs.statSync(file).mtimeMs, beforeMtime,
    'a fixed point must not be rewritten — the file is not touched at all');
});

test('a settings.json caught mid-write is left alone, silently', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'permission-wildcarding-hook-'));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const file = path.join(home, '.claude', 'settings.json');
  const partial = '{ "permissions": { "allow": ["Bash(git ';
  fs.writeFileSync(file, partial);

  const result = runHook(home, { cwd: home });
  assert.equal(result.status, 0, 'still exits 0');
  assert.equal(result.stderr, '',
    'a SyntaxError here is somebody else\'s atomic write in progress, not news — '
      + 'it used to print, because a SyntaxError has no .code and failed the ENOENT test');
  assert.equal(fs.readFileSync(file, 'utf8'), partial, 'and the half-written file is untouched');
});

test('a missing settings.json is not an error either', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'permission-wildcarding-hook-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const result = runHook(home, { cwd: home });
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
});

// ── the two verbs that do not go through the rebasing writer ─────────────────

// `--max` and `--bypass` build their whole output from `readSettings() ?? {}`
// and then write the WHOLE object. readSettings collapses "absent" and
// "unreadable" into null, so an unparseable file — the zero-byte window of
// somebody else's write, routine here — became `{}` and the write replaced the
// user's entire settings.json with just the key the verb touched.
//
// `--max on` was the worst of the two: applyMax records the allow-list snapshot
// as a side effect, so it wrote an EMPTY snapshot over the real one and `--max
// off` could then restore nothing. The CLI keeps no high-water backup, so on a
// CLI-only install there was no way back.
function runVerb(home, args) {
  const root = path.parse(home).root;
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: home, encoding: 'utf8', windowsHide: true,
    env: {
      ...process.env, HOME: home, USERPROFILE: home,
      HOMEDRIVE: root.replace(/[\/]$/, ''), HOMEPATH: home.slice(root.length - 1),
    },
  });
}

function brokenHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'permission-wildcarding-broken-'));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  // Truncated mid-array, exactly as a reader sees it inside a non-atomic write.
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'),
    '{ "model": "claude-opus-5", "permissions": { "allow": [ ');
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

for (const verb of ['--max', '--bypass']) {
  test(`${verb} on refuses an unreadable settings.json instead of replacing it`, (t) => {
    const home = brokenHome(t);
    const settingsPath = path.join(home, '.claude', 'settings.json');
    const before = fs.readFileSync(settingsPath, 'utf8');

    const run = runVerb(home, [verb, 'on']);

    assert.notEqual(run.status, 0, 'a refusal has to be visible in the exit code');
    assert.match(run.stderr, /refused/, run.stderr || run.stdout);
    assert.equal(fs.readFileSync(settingsPath, 'utf8'), before,
      'the bytes are untouched, so the damaged file stays recoverable');
  });
}

test('--max on does not record an empty allow snapshot over a real one', (t) => {
  const home = brokenHome(t);
  const snapshot = path.join(home, '.claude', 'backups', 'wildcarding-max.json');
  fs.mkdirSync(path.dirname(snapshot), { recursive: true });
  // A real snapshot from a previous, healthy MAX-on. Overwriting this with []
  // is what makes the loss permanent: `--max off` restores from here.
  const real = JSON.stringify({ allowSnapshot: ['Bash(git *)', 'Bash(rg *)'] }, null, 2) + '\n';
  fs.writeFileSync(snapshot, real);

  const run = runVerb(home, ['--max', 'on']);

  assert.notEqual(run.status, 0);
  assert.equal(fs.readFileSync(snapshot, 'utf8'), real,
    'the snapshot is the only thing that can restore the allow list');
});

test('--max and --bypass still work on an absent settings.json, which is the legitimate case', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'permission-wildcarding-fresh-'));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  // The refusal must key on "present but unreadable", not on "no settings yet",
  // or a first run is broken.
  const run = runVerb(home, ['--bypass', 'on']);
  assert.equal(run.status, 0, run.stderr);
  const after = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'));
  assert.equal(after.permissions.defaultMode, 'bypassPermissions');
});


// ── the concurrency the toggles used to lose ─────────────────────────────────
//
// `--max` and `--bypass` used to read settings.json, compute a whole new object,
// and write it back. They hold the policy lock, and the lock is irrelevant:
// Claude Code never takes it and rewrites this file on every /model, /effort and
// approval. So anything that landed between the read and the write was reverted.
// Nothing in the suite covered that — every existing test writes the file once
// and never moves it underneath a running verb.
//
// The seam is a Node `--require` preload, NOT an env var the product checks. The
// shim monkey-patches fs.readFileSync inside the child and returns STALE bytes
// for the first read of settings.json only, so the process behaves exactly as it
// would if Claude Code had written between its first read and its write. Nothing
// in bin/wildcard-perms knows it is under test; the only coupling is "settings
// .json is read via fs.readFileSync", which is true at src/settings-write.js and
// at the CLI's own readSettings.
function staleReadShim(t, stalePayload) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'permission-wildcarding-shim-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const shim = path.join(dir, 'stale-first-read.js');
  fs.writeFileSync(shim, [
    "const fs = require('fs');",
    "const real = fs.readFileSync;",
    `const stale = ${JSON.stringify(stalePayload)};`,
    'let served = false;',
    // Only readFileSync, and only for that basename, so the sidecar reads and
    // writeFileAtomicSync's own I/O are untouched.
    'fs.readFileSync = function patched(target, ...rest) {',
    "  if (!served && typeof target === 'string' && target.endsWith('settings.json')) {",
    '    served = true;',
    "    return rest[0] === 'utf8' || rest[0]?.encoding === 'utf8' ? stale : Buffer.from(stale);",
    '  }',
    '  return real.call(this, target, ...rest);',
    '};',
  ].join('\n'));
  return shim;
}

function runVerbWithShim(home, shim, args) {
  const root = path.parse(home).root;
  return spawnSync(process.execPath, ['--require', shim, CLI, ...args], {
    cwd: home, encoding: 'utf8', windowsHide: true,
    env: {
      ...process.env, HOME: home, USERPROFILE: home,
      HOMEDRIVE: root.replace(/[\\/]$/, ''), HOMEPATH: home.slice(root.length - 1),
    },
  });
}

test('--bypass keeps a key that landed between its read and its write', (t) => {
  // On disk: what Claude Code wrote while the verb was working.
  const home = tempHome(t, {
    model: 'claude-opus-5',
    effortLevel: 'high',
    permissions: { allow: ['Bash(git status *)', 'Bash(npm test)'], deny: ['Bash(rm -rf /*)'] },
  });
  // What the verb's FIRST read returns: an older file, missing all of that.
  const stale = JSON.stringify({ permissions: { allow: ['Bash(git status *)'] } }, null, 2) + '\n';

  const run = runVerbWithShim(home, staleReadShim(t, stale), ['--bypass', 'on']);
  assert.equal(run.status, 0, run.stderr);

  const after = settingsOf(home);
  assert.equal(after.permissions.defaultMode, 'bypassPermissions', 'the toggle took effect');
  // Reverted code writes the stale object: no model, no effortLevel, no deny, and
  // one fewer approval.
  assert.equal(after.model, 'claude-opus-5', 'model survived');
  assert.equal(after.effortLevel, 'high', 'effortLevel survived');
  assert.deepEqual(after.permissions.deny, ['Bash(rm -rf /*)'], 'deny survived');
  assert.ok(after.permissions.allow.includes('Bash(npm test)'),
    'and the approval that landed in the window survived');
});

test('--max on snapshots the list as it is now, not as its first read saw it', (t) => {
  const home = tempHome(t, {
    model: 'claude-opus-5',
    permissions: { allow: ['Bash(git status *)', 'Bash(npm test)'] },
  });
  const stale = JSON.stringify({ permissions: { allow: ['Bash(git status *)'] } }, null, 2) + '\n';

  const run = runVerbWithShim(home, staleReadShim(t, stale), ['--max', 'on']);
  assert.equal(run.status, 0, run.stderr);

  // The snapshot is the only thing that can restore the list, so what it captured
  // is the whole question. Taken from the stale read, `Bash(npm test)` would be
  // absent from it AND pruned from the live list by the blanket set — gone for
  // good, which is exactly the loss this change was made to stop.
  const snapshot = JSON.parse(
    fs.readFileSync(path.join(home, '.claude', 'backups', 'wildcarding-max.json'), 'utf8'));
  assert.ok(snapshot.allowSnapshot.includes('Bash(npm test)'),
    'the snapshot came from the freshest read');
  assert.equal(settingsOf(home).model, 'claude-opus-5', 'and unrelated keys survived the write');
});
