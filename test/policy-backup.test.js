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

  delete require.cache[extensionPath];
  const extension = require(extensionPath);
  extension.activate({ subscriptions: [] });
  return {
    commands,
    extension,
    async dispose() {
      await extension.deactivate();
      Module._load = originalLoad;
      delete require.cache[extensionPath];
    },
  };
}

function setup(t) {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'permission-wildcarding-backup-'));
  fs.mkdirSync(path.join(tempHome, '.claude'), { recursive: true });
  t.after(() => fs.rmSync(tempHome, { recursive: true, force: true }));
  const settingsPath = path.join(tempHome, '.claude', 'settings.json');
  const backupPath = path.join(tempHome, '.claude', 'backups', 'allow-list.latest.json');
  return {
    tempHome,
    settingsPath,
    backupPath,
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
