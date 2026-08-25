'use strict';

// The --gates argv wiring, exercised through the real CLI against a throwaway home so
// nothing lands in the developer's ~/.claude. The block logic is covered in
// agent-gates.test.js; what is tested here is the part only argv can get wrong: that
// `refresh` behaves as a SessionStart hook must (quiet, non-zero-exit-free, idempotent),
// that a bad verb is rejected, and that `off` leaves a coexisting guidance block alone.

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CLI = path.resolve(__dirname, '..', 'bin', 'wildcard-perms');
const COMPILED = '## Standing gates (1 memories, managed)\n\n- **Test gate.** Pass: nothing.';

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

// A home with an instruction file and a pre-compiled gates file, so `--gates on` has
// something real to install without this test needing python.
function tempHome(t, { compiled = COMPILED } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'permission-wildcarding-gates-'));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), '{}\n');
  fs.writeFileSync(path.join(home, '.claude', 'CLAUDE.md'), '# Mine\n');
  if (compiled !== null) {
    fs.writeFileSync(path.join(home, '.claude', 'gates.generated.md'), compiled + '\n');
  }
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

const claudeMd = (home) => fs.readFileSync(path.join(home, '.claude', 'CLAUDE.md'), 'utf8');

test('CLI --gates on installs, and status reports it', (t) => {
  const home = tempHome(t);

  const status = runCli(home, ['--gates', 'status']);
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /OFF/);

  const on = runCli(home, ['--gates', 'on']);
  assert.equal(on.status, 0, on.stderr);
  assert.match(on.stdout, /ON/);
  assert.match(claudeMd(home), /BEGIN permission-wildcarding: memory gates/);
  assert.ok(claudeMd(home).startsWith('# Mine\n'), 'user text keeps its place');
  assert.match(runCli(home, ['--gates', 'status']).stdout, /ON/);
});

test('CLI --gates off is a byte-for-byte round trip', (t) => {
  const home = tempHome(t);
  const before = claudeMd(home);
  runCli(home, ['--gates', 'on']);
  const off = runCli(home, ['--gates', 'off']);
  assert.equal(off.status, 0, off.stderr);
  assert.equal(claudeMd(home), before);
});

// The SessionStart contract. A hook's stdout can be folded into session context, so an
// unchanged refresh has to say nothing at all, and it must never exit non-zero just
// because there was no work to do.
test('CLI --gates refresh is quiet and exit-0 when nothing changed', (t) => {
  const home = tempHome(t);
  runCli(home, ['--gates', 'on']);

  const first = runCli(home, ['--gates', 'refresh']);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.stdout.trim(), '', 'an unchanged refresh must print nothing');
  // This home has no memory dir, which is a normal state and must not surface a Python
  // traceback: a hook that vomits a stack trace on every session start is worse than useless.
  assert.doesNotMatch(first.stderr, /Traceback|FileNotFoundError/,
    'a missing memory dir must be handled, not thrown');

  const second = runCli(home, ['--gates', 'refresh']);
  assert.equal(second.status, 0);
  assert.equal(second.stdout.trim(), '', 'still quiet on a repeat');
  assert.match(claudeMd(home), /BEGIN permission-wildcarding: memory gates/);
});

test('CLI --gates with nothing compiled refuses and says which command to run', (t) => {
  const home = tempHome(t, { compiled: null });
  const on = runCli(home, ['--gates', 'on']);
  assert.equal(on.status, 1);
  assert.match(on.stderr, /--gates-compile/);
  assert.equal(claudeMd(home), '# Mine\n', 'a refused install writes nothing');
});

test('CLI --gates rejects an unknown verb with usage', (t) => {
  const home = tempHome(t);
  const bad = runCli(home, ['--gates', 'enable']);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /usage: wildcard-perms --gates on\|off\|status\|refresh/);
  assert.equal(claudeMd(home), '# Mine\n');
});

// Both managed blocks share one file, so the CLI-level guarantee is that neither switch
// can disturb the other. This is the same property agent-gates.test.js asserts on the pure
// functions, checked here through the two real subcommands.
test('CLI --gates off leaves a coexisting guidance block byte-identical', (t) => {
  const home = tempHome(t);
  runCli(home, ['--guidance', 'on']);
  const withGuidance = claudeMd(home);
  assert.match(withGuidance, /BEGIN permission-wildcarding: shell style/);

  runCli(home, ['--gates', 'on']);
  assert.match(claudeMd(home), /BEGIN permission-wildcarding: shell style/);

  runCli(home, ['--gates', 'off']);
  assert.equal(claudeMd(home), withGuidance, 'guidance survived a gates off, unchanged');

  runCli(home, ['--gates', 'on']);
  runCli(home, ['--guidance', 'off']);
  assert.match(claudeMd(home), /BEGIN permission-wildcarding: memory gates/,
    'gates survived a guidance off');
});
