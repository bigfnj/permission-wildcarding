'use strict';

// The backup exists to survive a managed-settings refresh that resets
// settings.json. Restoring the allow list alone hands every permission back with
// the deny list — the boundary MAX mode, bypass mode and auto-safe all defer to —
// still missing, which is worse than not restoring. These drive the real commands
// through the extension against a throwaway home.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

function disposable() { return { dispose() {} }; }

// Purge extension.js AND every src/ module it pulls in. See the long note in
// test/extension-activation.test.js: `delete require.cache[extensionPath]` alone
// leaves every src/ module holding the FIRST harness's `os` stub, so a later
// activation in this file resolves `home = os.homedir()` defaults to an earlier
// test's temp home — which t.after has already deleted, so the write re-creates
// it and leaks a directory into %TEMP% on every run.
function purgeProjectModules(extensionPath, rootSrc) {
  const extensionDir = path.dirname(extensionPath) + path.sep;
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(rootSrc + path.sep) || key.startsWith(extensionDir)) {
      delete require.cache[key];
    }
  }
}

function harness(tempHome) {
  const commands = new Map();
  const vscode = {
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    RelativePattern: class RelativePattern {
      constructor(base, pattern) { this.base = base; this.pattern = pattern; }
    },
    StatusBarAlignment: { Right: 2 },
    ThemeColor: class ThemeColor { constructor(id) { this.id = id; } },
    Uri: { file: (fsPath) => ({ fsPath }) },
    commands: {
      registerCommand(id, handler) { commands.set(id, handler); return disposable(); },
      executeCommand() {},
    },
    window: {
      createStatusBarItem() { return { hide() {}, show() {}, dispose() {} }; },
      registerWebviewViewProvider() { return disposable(); },
      setStatusBarMessage() {},
      showErrorMessage() {},
      showInformationMessage() { return Promise.resolve(undefined); },
      showWarningMessage() { return Promise.resolve(undefined); },
    },
    workspace: {
      isTrusted: true,
      workspaceFolders: [{ uri: { fsPath: path.join(tempHome, 'workspace') } }],
      createFileSystemWatcher(pattern) {
        return { pattern, onDidChange() {}, onDidCreate() {}, onDidDelete() {}, dispose() {} };
      },
      getConfiguration() {
        return {
          // Auto Learn off: these tests are about the backup, not the learner.
          get: (key, fallback) => (key === 'autoLearn.enabled' ? false : fallback),
          inspect: () => ({}),
          update: async () => {},
        };
      },
      onDidChangeConfiguration() { return disposable(); },
      onDidChangeWorkspaceFolders() { return disposable(); },
    },
  };

  const extensionPath = require.resolve('../vscode-extension/extension');
  const rootSrc = path.resolve(__dirname, '..', 'src');
  const originalLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (request === 'vscode') return vscode;
    if (request === 'os') return { ...os, homedir: () => tempHome };
    if (parent?.filename === extensionPath && request.startsWith('./src/')) {
      return originalLoad.call(this, path.join(rootSrc, request.slice('./src/'.length)), parent, isMain);
    }
    if (request === './memoryLint' && parent?.filename === extensionPath) {
      return {
        MemoryLint: class MemoryLint { activate() {} },
        memoryReport: () => ({ conf: {}, dir: null, report: null }),
        discoverDirs: () => [],
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  purgeProjectModules(extensionPath, rootSrc);
  const extension = require(extensionPath);
  extension.activate({ subscriptions: [] });
  return {
    commands,
    extension,
    async dispose() {
      await extension.deactivate();
      Module._load = originalLoad;
      purgeProjectModules(extensionPath, rootSrc);
    },
  };
}

function setup(t) {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'permission-wildcarding-backup-'));
  fs.mkdirSync(path.join(tempHome, '.claude'), { recursive: true });
  t.after(() => fs.rmSync(tempHome, { recursive: true, force: true }));
  const settingsPath = path.join(tempHome, '.claude', 'settings.json');
  const backupPath = path.join(tempHome, '.claude', 'backups', 'allow-list.latest.json');
  // The off-tree mirror's default, resolved against the mocked home so these
  // stay hermetic — nothing here may touch the real ~/.permission-wildcarding.
  const mirrorPath = path.join(tempHome, '.permission-wildcarding', 'allow-list.latest.json');
  return {
    tempHome,
    settingsPath,
    backupPath,
    mirrorPath,
    write: (value) => fs.writeFileSync(settingsPath, JSON.stringify(value, null, 2) + '\n'),
    read: () => JSON.parse(fs.readFileSync(settingsPath, 'utf8')),
  };
}

const DENY = ['Bash(rm -rf /*)', 'Bash(mkfs* *)', 'Bash(dd * of=/dev/*)'];

test('a policy wipe restores the deny list, not just the allow list', async (t) => {
  const env = setup(t);
  env.write({ permissions: { allow: ['Bash(git status *)', 'Bash(rg *)'], deny: DENY } });

  const app = harness(env.tempHome);
  try {
    // Populates the backup from live settings.
    await app.commands.get('permission-wildcarding.runNow')();

    const saved = JSON.parse(fs.readFileSync(env.backupPath, 'utf8'));
    assert.deepEqual(saved.deny, DENY, 'the backup must capture deny, not only allow');

    // An org policy refresh resets settings.json.
    env.write({ permissions: { allow: [], deny: [] } });
    await app.commands.get('permission-wildcarding.restoreBackup')();

    const after = env.read().permissions;
    assert.deepEqual(after.allow, ['Bash(git status *)', 'Bash(rg *)']);
    assert.deepEqual(after.deny, DENY, 'restoring allow without deny leaves no killswitch');
  } finally {
    await app.dispose();
  }
});

test('a pre-1.12 allow-only backup still restores, and upgrades in place', async (t) => {
  const env = setup(t);
  env.write({ permissions: { allow: [], deny: DENY } });
  // The legacy on-disk shape is a bare array.
  fs.mkdirSync(path.dirname(env.backupPath), { recursive: true });
  fs.writeFileSync(env.backupPath, JSON.stringify(['Bash(tokei *)'], null, 2) + '\n');

  const app = harness(env.tempHome);
  try {
    await app.commands.get('permission-wildcarding.restoreBackup')();
    const after = env.read().permissions;
    assert.deepEqual(after.allow, ['Bash(tokei *)'], 'legacy array must still be readable');
    assert.deepEqual(after.deny, DENY, 'a legacy backup must not clear a live deny list');

    // The write path upgrades the file to the { allow, deny } shape.
    const saved = JSON.parse(fs.readFileSync(env.backupPath, 'utf8'));
    assert.equal(Array.isArray(saved), false);
    assert.deepEqual(saved.allow, ['Bash(tokei *)']);
    assert.deepEqual(saved.deny, DENY);
  } finally {
    await app.dispose();
  }
});

test('settings with no deny key never gain an empty one', async (t) => {
  const env = setup(t);
  env.write({ permissions: { allow: ['Bash(git status *)'] } });

  const app = harness(env.tempHome);
  try {
    await app.commands.get('permission-wildcarding.runNow')();
    await app.commands.get('permission-wildcarding.restoreBackup')();
    assert.equal(
      Object.prototype.hasOwnProperty.call(env.read().permissions, 'deny'), false,
      'writing an empty deny key would misrepresent the user policy',
    );
  } finally {
    await app.dispose();
  }
});

// Regression: MAX on → backup grows to include Bash(*)/PowerShell(*) → MAX off →
// backup still had the blanket entries → policy guard reported them as "missing" →
// "Re-assert them" silently re-enabled MAX.
test('turning MAX off purges blanket entries from the backup', async (t) => {
  const env = setup(t);
  const userPerms = ['Bash(git status *)', 'Bash(rg *)'];
  env.write({ permissions: { allow: userPerms, deny: DENY } });

  const app = harness(env.tempHome);
  try {
    // Seed the backup with the user's real permissions.
    await app.commands.get('permission-wildcarding.runNow')();

    // Turn MAX on: blanket wildcards land in settings.json.
    await app.commands.get('permission-wildcarding.toggleMax')();
    const maxSettings = env.read().permissions;
    assert.ok(maxSettings.allow.includes('Bash(*)'), 'MAX on must add Bash(*)');

    // The file watcher would normally trigger a backup here.  Simulate it by
    // running the wildcarding pass so the blanket entries make it into the backup.
    await app.commands.get('permission-wildcarding.runNow')();
    const backupWhileMax = JSON.parse(fs.readFileSync(env.backupPath, 'utf8'));
    assert.ok(backupWhileMax.allow.includes('Bash(*)'), 'backup must capture MAX entries');

    // Turn MAX off: the fix must purge the blanket entries from the backup.
    await app.commands.get('permission-wildcarding.toggleMax')();
    const backupAfterMax = JSON.parse(fs.readFileSync(env.backupPath, 'utf8'));
    assert.ok(!backupAfterMax.allow.includes('Bash(*)'),   'Bash(*) must leave the backup on MAX off');
    assert.ok(!backupAfterMax.allow.includes('PowerShell(*)'), 'PowerShell(*) must leave the backup on MAX off');
    // The user's real permissions must still be in the backup.
    for (const p of userPerms) {
      assert.ok(backupAfterMax.allow.includes(p), `user permission ${p} must survive in backup`);
    }
  } finally {
    await app.dispose();
  }
});

// The purge above is right about Bash(*) and PowerShell(*) and used to be wrong
// about everything else in the MAX set. Read(*), Edit, Write, WebFetch(*),
// WebSearch and every mcp__<server>__* are ordinary grants that people hold
// without ever touching MAX — restoreFromBackup says so itself: "The full MAX set
// (Read(*), Edit, Write, …) is legitimately used outside MAX too, so only the two
// markers that uniquely signal MAX-on are excluded." One MAX round trip forgot
// the user's copies of them, and a backup entry that is silently dropped is only
// discovered on the day it was needed.
test('MAX off forgets what MAX added, not the same entries the user already had', async (t) => {
  const env = setup(t);
  // Four of these overlap the MAX blanket set and belong to the user.
  const held = ['Read(*)', 'Edit', 'WebSearch', 'mcp__context7__*'];
  const userPerms = ['Bash(git status *)', 'Bash(rg *)', ...held];
  env.write({ permissions: { allow: userPerms, deny: DENY } });

  const app = harness(env.tempHome);
  try {
    await app.commands.get('permission-wildcarding.runNow')();
    await app.commands.get('permission-wildcarding.toggleMax')();
    // The watcher would do this; run the pass so the blanket set reaches the backup.
    await app.commands.get('permission-wildcarding.runNow')();
    const whileMax = JSON.parse(fs.readFileSync(env.backupPath, 'utf8')).allow;
    assert.ok(whileMax.includes('Write'), 'precondition: MAX added Write and the backup caught it');

    await app.commands.get('permission-wildcarding.toggleMax')();
    const live = env.read().permissions.allow;
    const saved = JSON.parse(fs.readFileSync(env.backupPath, 'utf8')).allow;

    // MAX-off restores the pre-MAX snapshot, so these are live again — an entry
    // that is live and absent from the high-water mark is unrecoverable.
    for (const permission of held) {
      assert.ok(live.includes(permission), `precondition: ${permission} is live after MAX off`);
      assert.ok(saved.includes(permission), `${permission} is the user's and keeps its backup cover`);
    }
    // What MAX itself introduced is gone from settings.json, so it must be gone
    // from the backup too or the guard re-asserts it and MAX comes back on.
    for (const added of ['Bash(*)', 'PowerShell(*)', 'Write', 'WebFetch(*)']) {
      assert.ok(!live.includes(added), `precondition: MAX off removed ${added}`);
      assert.ok(!saved.includes(added), `${added} was MAX's, so it leaves the backup`);
    }
  } finally {
    await app.dispose();
  }
});

// Second layer of defense: even if Bash(*)/PowerShell(*) somehow end up in the
// backup (stale file, pre-fix version), restoreFromBackup must never silently
// write them back, because MAX is an explicit mode choice, not a permission.
test('restore never re-enables MAX even if backup holds the markers', async (t) => {
  const env = setup(t);
  const userPerms = ['Bash(git status *)', 'Bash(rg *)'];
  env.write({ permissions: { allow: userPerms, deny: DENY } });

  // Manually poison the backup with MAX markers — simulates a stale pre-fix file.
  fs.mkdirSync(path.dirname(env.backupPath), { recursive: true });
  fs.writeFileSync(env.backupPath, JSON.stringify({
    allow: [...userPerms, 'Bash(*)', 'PowerShell(*)'],
    deny: DENY,
  }) + '\n');

  const app = harness(env.tempHome);
  try {
    await app.commands.get('permission-wildcarding.restoreBackup')();
    const after = env.read().permissions;
    assert.ok(!after.allow.includes('Bash(*)'),      'Bash(*) must never be restored');
    assert.ok(!after.allow.includes('PowerShell(*)'), 'PowerShell(*) must never be restored');
    for (const p of userPerms) {
      assert.ok(after.allow.includes(p), `legitimate permission ${p} must still be restored`);
    }
  } finally {
    await app.dispose();
  }
});

// ── the off-tree mirror ─────────────────────────────────────────────────────────
// Observed 2026-09-09: every directory under ~/.claude was recreated, so the
// primary backup went with the thing it exists to protect. These cover the
// recovery that failure needs, and the two ways a second copy goes wrong.

test('the backup is mirrored outside ~/.claude', async (t) => {
  const env = setup(t);
  env.write({ permissions: { allow: ['Bash(git status *)', 'Bash(rg *)'], deny: DENY } });

  const app = harness(env.tempHome);
  try {
    await app.commands.get('permission-wildcarding.runNow')();

    const mirrored = JSON.parse(fs.readFileSync(env.mirrorPath, 'utf8'));
    assert.deepEqual(mirrored.deny, DENY, 'the mirror must carry deny, not only allow');
    assert.deepEqual(mirrored, JSON.parse(fs.readFileSync(env.backupPath, 'utf8')),
      'the two copies must be byte-identical, or restore depends on which one is read');
    // The whole point: outside the directory whose reset it survives.
    assert.ok(!env.mirrorPath.startsWith(path.join(env.tempHome, '.claude')),
      'a mirror inside ~/.claude protects against nothing');
  } finally {
    await app.dispose();
  }
});

test('losing all of ~/.claude still restores, from the mirror', async (t) => {
  const env = setup(t);
  const userPerms = ['Bash(git status *)', 'Bash(rg *)'];
  env.write({ permissions: { allow: userPerms, deny: DENY } });

  const app = harness(env.tempHome);
  try {
    await app.commands.get('permission-wildcarding.runNow')();
    assert.ok(fs.existsSync(env.mirrorPath), 'precondition: the mirror was written');

    // The actual failure, not a settings rewrite: the directory is recreated,
    // so settings.json AND backups/ are gone together.
    fs.rmSync(path.join(env.tempHome, '.claude'), { recursive: true, force: true });
    fs.mkdirSync(path.join(env.tempHome, '.claude'), { recursive: true });
    env.write({ permissions: { allow: [], deny: [] } });
    assert.ok(!fs.existsSync(env.backupPath), 'precondition: the primary backup is gone');

    await app.commands.get('permission-wildcarding.restoreBackup')();

    const after = env.read().permissions;
    for (const p of userPerms) {
      assert.ok(after.allow.includes(p), `${p} must come back from the mirror`);
    }
    assert.deepEqual(after.deny, DENY, 'deny must travel with allow off the mirror too');
  } finally {
    await app.dispose();
  }
});

test('a pruned entry leaves the mirror too, and cannot come back', async (t) => {
  const env = setup(t);
  env.write({ permissions: { allow: ['Bash(git status *)', 'Bash(rg *)'], deny: DENY } });

  const app = harness(env.tempHome);
  try {
    await app.commands.get('permission-wildcarding.runNow')();
    await app.commands.get('permission-wildcarding.toggleMax')();
    await app.commands.get('permission-wildcarding.runNow')();
    assert.ok(JSON.parse(fs.readFileSync(env.mirrorPath, 'utf8')).allow.includes('Bash(*)'),
      'precondition: the mirror captured the blanket entry');

    // MAX off purges the blanket entries. If the purge skipped the mirror, the
    // high-water mark would survive off-tree and the next restore would hand it
    // straight back -- so assert on the mirror, not the primary.
    await app.commands.get('permission-wildcarding.toggleMax')();
    const mirrored = JSON.parse(fs.readFileSync(env.mirrorPath, 'utf8'));
    assert.ok(!mirrored.allow.includes('Bash(*)'), 'Bash(*) must leave the mirror on MAX off');
    assert.ok(!mirrored.allow.includes('PowerShell(*)'),
      'PowerShell(*) must leave the mirror on MAX off');
    assert.ok(mirrored.allow.includes('Bash(rg *)'), 'a real permission must survive the purge');
  } finally {
    await app.dispose();
  }
});

// The reason readBackup falls back rather than unioning. A stale mirror is the
// normal state after upgrading from a version that wrote only the primary, or
// after the mirror path changes -- and a union read would treat whatever it still
// holds as part of the high-water mark, handing back the entry the user pruned.
// Asserts the absolute answer (the entry stays gone), not that two reads agree.
test('a stale mirror cannot resurrect an entry pruned from the primary', async (t) => {
  const env = setup(t);
  env.write({ permissions: { allow: [], deny: DENY } });

  // Primary is authoritative and no longer holds the pruned entry.
  fs.mkdirSync(path.dirname(env.backupPath), { recursive: true });
  fs.writeFileSync(env.backupPath,
    JSON.stringify({ allow: ['Bash(rg *)'], deny: DENY }, null, 2) + '\n');
  // The mirror lagged and still does.
  fs.mkdirSync(path.dirname(env.mirrorPath), { recursive: true });
  fs.writeFileSync(env.mirrorPath,
    JSON.stringify({ allow: ['Bash(rg *)', 'Bash(curl *)'], deny: DENY }, null, 2) + '\n');

  const app = harness(env.tempHome);
  try {
    await app.commands.get('permission-wildcarding.restoreBackup')();
    const after = env.read().permissions;
    assert.ok(after.allow.includes('Bash(rg *)'), 'the primary\'s entries must restore');
    assert.ok(!after.allow.includes('Bash(curl *)'),
      'a stale mirror entry must not come back: the primary, when present, is the whole answer');
  } finally {
    await app.dispose();
  }
});
