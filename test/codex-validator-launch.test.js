'use strict';

// Every other Auto Learn test injects a codexValidator, so the real one had no
// coverage at all. It spawned the codex executable by bare name, which cannot
// launch an npm shim on Windows: the apply threw before writing anything, the
// grant was never recorded, and the candidate returned to the review list on
// every scan. These tests drive defaultCodexValidator through a stand-in codex
// placed on PATH in exactly that shim shape.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createAutoLearnManager } = require('../src/auto-learn-manager');

const windows = process.platform === 'win32';

function jsonl(...records) {
  return `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;
}

function bashCall(id, command) {
  return {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }],
    },
  };
}

function bashResult(id) {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: id, is_error: false, content: 'ok' }],
    },
  };
}

// A stand-in codex that answers execpolicy check the way the real one does,
// installed the way npm installs a CLI: a batch shim on Windows, a shebang
// script elsewhere.
function installFakeCodex(dir, name) {
  fs.mkdirSync(dir, { recursive: true });
  if (windows) {
    const shim = path.join(dir, `${name}.cmd`);
    fs.writeFileSync(shim, '@echo {"decision":"allow"}\r\n', 'utf8');
    return shim;
  }
  const shim = path.join(dir, name);
  fs.writeFileSync(shim, '#!/bin/sh\necho \'{"decision":"allow"}\'\n', 'utf8');
  fs.chmodSync(shim, 0o755);
  return shim;
}

function fixture(t, prefix) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `permission-wildcarding-${prefix}-`));
  t.after(() => { try { fs.rmSync(home, { recursive: true, force: true }); } catch {} });
  const history = path.join(home, '.claude', 'projects', 'p', 'session.jsonl');
  const settings = path.join(home, '.claude', 'settings.json');
  const rules = path.join(home, '.codex', 'rules', 'permission-wildcarding.rules');
  fs.mkdirSync(path.dirname(history), { recursive: true });
  fs.mkdirSync(path.dirname(rules), { recursive: true });
  fs.writeFileSync(settings, `${JSON.stringify({ permissions: { allow: [] } }, null, 2)}\n`);
  fs.writeFileSync(history, jsonl(
    { type: 'session_meta', payload: { id: 'v', cwd: 'D:\\work' } },
    bashCall('one', 'git status --short'),
    bashResult('one'),
    bashCall('two', 'git status --porcelain'),
    bashResult('two'),
    bashCall('three', 'git status --branch'),
    bashResult('three'),
  ));
  return { home, settings, rules };
}

function withPath(dir, run) {
  const before = process.env.PATH;
  process.env.PATH = `${dir}${path.delimiter}${before}`;
  try { return run(); } finally { process.env.PATH = before; }
}

test('the real validator launches a codex found on PATH and the grant is recorded', (t) => {
  const { home, rules } = fixture(t, 'validator-ok');
  const binDir = path.join(home, 'fakebin');
  installFakeCodex(binDir, 'wcfakecodex');

  const manager = createAutoLearnManager({
    home, threshold: 3, codexRulesPath: rules, codexExecutable: 'wcfakecodex',
  });
  manager.scan({ platform: 'win32' });

  const applied = withPath(binDir, () => manager.apply());
  assert.equal(applied.appliedCount, 1);
  assert.ok(applied.changedTargets.includes('codex'));
  assert.match(fs.readFileSync(rules, 'utf8'), /prefix_rule\(/);

  // The point of the whole thing: an accepted family stops being pending, so
  // it leaves the review list instead of coming back on the next scan.
  const after = manager.listCandidates().find((item) => item.key === 'bash:git status');
  assert.deepEqual(after.pendingTargets, []);
  assert.ok(after.appliedTo.includes('codex'));
});

test('an unlaunchable codex fails the apply closed and writes no rules', (t) => {
  const { home, rules } = fixture(t, 'validator-missing');
  const manager = createAutoLearnManager({
    home, threshold: 3, codexRulesPath: rules, codexExecutable: 'wc-no-such-codex-xyz',
  });
  manager.scan({ platform: 'win32' });

  assert.throws(() => manager.apply(), /codex/i);
  assert.equal(fs.existsSync(rules), false);
  const after = manager.listCandidates().find((item) => item.key === 'bash:git status');
  assert.ok(after.pendingTargets.includes('codex'), 'a failed apply must not claim the grant');
});

// A dashboard error with no remedy reads as the feature being broken. The
// codexExecutable setting had existed all along and nothing pointed at it, so
// the message names it, and names the CLI flag for the same reason.
test('an unreachable codex names the setting that fixes it', (t) => {
  const { home, rules } = fixture(t, 'validator-remedy');
  const manager = createAutoLearnManager({
    home, threshold: 3, codexRulesPath: rules, codexExecutable: 'wc-no-such-codex-xyz',
  });
  manager.scan({ platform: 'win32' });

  let message = '';
  try { manager.apply(); } catch (error) { message = error.message; }
  assert.match(message, /wc-no-such-codex-xyz/, 'says which name it looked for');
  assert.match(message, /permissionWildcarding\.autoLearn\.codexExecutable/, 'names the setting');
  assert.match(message, /--codex-executable/, 'names the CLI flag');
});

// The npm global prefix is not always on PATH, so the validator has to find a
// shim there too or the apply fails on a machine where codex plainly works.
test('the validator finds a codex in the npm prefix that PATH cannot see', { skip: !windows }, (t) => {
  const { home, rules } = fixture(t, 'validator-fallback');
  const npmDir = path.join(home, 'appdata', 'npm');
  installFakeCodex(npmDir, 'wcfakecodex2');

  const manager = createAutoLearnManager({
    home, threshold: 3, codexRulesPath: rules, codexExecutable: 'wcfakecodex2',
  });
  manager.scan({ platform: 'win32' });

  const beforeAppData = process.env.APPDATA;
  const beforePath = process.env.PATH;
  process.env.APPDATA = path.join(home, 'appdata');
  process.env.PATH = path.join(home, 'nothing-here');
  let applied;
  try { applied = manager.apply(); }
  finally {
    if (beforeAppData === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = beforeAppData;
    process.env.PATH = beforePath;
  }

  assert.equal(applied.appliedCount, 1);
  assert.ok(applied.changedTargets.includes('codex'));
  assert.match(fs.readFileSync(rules, 'utf8'), /prefix_rule\(/);
});
