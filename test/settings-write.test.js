'use strict';

// The rebasing writer, now shared by the extension and the CLI.
//
// The defect it exists to prevent: a writer reads settings.json, spends time
// computing, then spreads its stale snapshot back over the file. Claude Code
// rewrites that file in place on every /model, /effort and approval, so whatever
// landed in between is reverted. These tests inject exactly that interleaving —
// the caller's snapshot and the file on disk deliberately disagree — which a
// naive `{ ...settings, permissions: { ...allow } }` spread cannot survive.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  createSettingsWriter, readSettingsState,
  SETTINGS_ABSENT, SETTINGS_PRESENT, SETTINGS_UNREADABLE, SETTINGS_UNREADABLE_CODE,
} = require('../src/settings-write');

function tempSettings(t, value) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'permission-wildcarding-write-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const file = path.join(home, 'settings.json');
  if (value !== undefined) fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
  return {
    file,
    read: () => JSON.parse(fs.readFileSync(file, 'utf8')),
    writer: (options) => createSettingsWriter({ settingsPath: file, ...options }),
  };
}

test('a field added after the caller read is not reverted by the write', (t) => {
  // What the caller saw when it started.
  const snapshot = { model: 'claude-opus-5', permissions: { allow: ['Bash(git status)'] } };
  const env = tempSettings(t, snapshot);

  // What landed while the caller was computing: a new model, a brand-new deny
  // rule, and an approval the caller never saw.
  env.writer().readSettingsState();
  fs.writeFileSync(env.file, JSON.stringify({
    model: 'claude-sonnet-5',
    effortLevel: 'high',
    hooks: { PostToolUse: [{ matcher: 'Bash' }] },
    permissions: {
      allow: ['Bash(git status)', 'Bash(npm test)'],
      deny: ['Bash(rm -rf /*)'],
    },
  }, null, 2) + '\n');

  // The caller's intent, computed against its OWN stale snapshot.
  env.writer().writeAllow(snapshot, ['Bash(git *)']);

  const after = env.read();
  assert.equal(after.model, 'claude-sonnet-5', 'a concurrent model change must survive');
  assert.equal(after.effortLevel, 'high', 'a field the snapshot never had must survive');
  assert.deepEqual(after.hooks, { PostToolUse: [{ matcher: 'Bash' }] },
    'the hook registration must survive — losing it disables this tool silently');
  assert.deepEqual(after.permissions.deny, ['Bash(rm -rf /*)'],
    'deny is the safety boundary: a concurrent rule must never be dropped');
  assert.ok(after.permissions.allow.includes('Bash(git *)'), 'the caller\'s addition lands');
  assert.ok(after.permissions.allow.includes('Bash(npm test)'),
    'an approval that arrived after the snapshot must survive');
});

test('a removal is replayed, so a deliberate prune still prunes', (t) => {
  // The other half of the contract: rebasing must not mean "ignore the caller".
  const snapshot = { permissions: { allow: ['Bash(git *)', 'Bash(rg *)'] } };
  const env = tempSettings(t, snapshot);
  fs.writeFileSync(env.file, JSON.stringify({
    permissions: { allow: ['Bash(git *)', 'Bash(rg *)', 'Bash(fd *)'] },
  }, null, 2) + '\n');

  env.writer().writeAllow(snapshot, ['Bash(git *)']);

  const allow = env.read().permissions.allow;
  assert.ok(!allow.includes('Bash(rg *)'), 'the entry the caller removed is gone');
  assert.ok(allow.includes('Bash(fd *)'), 'the entry it never saw is untouched');
});

test('an empty deny key is never invented', (t) => {
  const snapshot = { permissions: { allow: ['Bash(rg *)'] } };
  const env = tempSettings(t, snapshot);
  env.writer().writeAllow(snapshot, ['Bash(rg *)', 'Bash(fd *)']);
  assert.equal(Object.prototype.hasOwnProperty.call(env.read().permissions, 'deny'), false,
    'writing an empty deny key would misrepresent the user policy as having a boundary');
});

test('an unparseable settings.json is refused, not written over', (t) => {
  const env = tempSettings(t);
  fs.writeFileSync(env.file, '{ "permissions": ');  // caught mid-write

  assert.equal(readSettingsState(env.file).state, SETTINGS_UNREADABLE);
  assert.throws(
    () => env.writer().writeAllow({}, ['Bash(rg *)']),
    (err) => err.code === SETTINGS_UNREADABLE_CODE,
    'refusing is the whole point: the snapshot is often {} on this path, so writing '
      + 'would leave a settings.json holding nothing but permissions',
  );
  assert.equal(fs.readFileSync(env.file, 'utf8'), '{ "permissions": ', 'the file is untouched');
});

test('absent and unreadable are told apart', (t) => {
  const env = tempSettings(t);
  assert.equal(readSettingsState(env.file).state, SETTINGS_ABSENT,
    'absent means the backup should step in');
  fs.writeFileSync(env.file, '{}');
  assert.equal(readSettingsState(env.file).state, SETTINGS_PRESENT);
});

test('the injected write hook receives what actually landed', (t) => {
  // The extension passes its high-water-mark backup here. It has to be handed the
  // REBASED lists, not the caller's intent, or the backup records a file that was
  // never written.
  const snapshot = { permissions: { allow: ['Bash(rg *)'] } };
  const env = tempSettings(t, snapshot);
  fs.writeFileSync(env.file, JSON.stringify({
    permissions: { allow: ['Bash(rg *)', 'Bash(fd *)'], deny: ['Bash(mkfs* *)'] },
  }, null, 2) + '\n');

  const seen = [];
  env.writer({ onWrite: (allow, deny) => seen.push({ allow, deny }) })
    .writeAllow(snapshot, ['Bash(rg *)', 'Bash(git *)']);

  assert.equal(seen.length, 1, 'the hook fires once, after a successful write');
  assert.ok(seen[0].allow.includes('Bash(fd *)'), 'it sees the rebased allow list');
  assert.deepEqual(seen[0].deny, ['Bash(mkfs* *)'], 'and the deny list it must not lose');
  assert.deepEqual(seen[0].allow, env.read().permissions.allow,
    'what the hook records and what is on disk cannot disagree');
});
