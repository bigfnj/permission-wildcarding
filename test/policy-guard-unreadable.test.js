'use strict';

// Regression: the guard treated "settings.json could not be read" as "settings.json
// grants nothing". Claude Code rewrites that file in place (every /model, /effort,
// approval) and re-saves policy-limits.json several times per start, so a watcher
// event landing inside a write is ordinary. On this machine it produced a report of
// 307 missing entries and an unprompted restore of the whole backup, against a file
// that Claude Code's own log shows was intact before and after.
//
// These drive the real commands and the real activation path against a throwaway
// home, so what is asserted is what a user would see.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

function disposable() { return { dispose() {} }; }

function harness(tempHome) {
  const commands = new Map();
  const shown = { info: [], warning: [], error: [], status: [] };
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
      createOutputChannel() { return { appendLine() {}, clear() {}, show() {}, dispose() {} }; },
      registerWebviewViewProvider() { return disposable(); },
      setStatusBarMessage(message) { shown.status.push(message); },
      showErrorMessage(message) { shown.error.push(message); return Promise.resolve(undefined); },
      showInformationMessage(message) { shown.info.push(message); return Promise.resolve(undefined); },
      showWarningMessage(message) { shown.warning.push(message); return Promise.resolve(undefined); },
    },
    workspace: {
      isTrusted: true,
      workspaceFolders: [{ uri: { fsPath: path.join(tempHome, 'workspace') } }],
      createFileSystemWatcher(pattern) {
        return { pattern, onDidChange() {}, onDidCreate() {}, onDidDelete() {}, dispose() {} };
      },
      getConfiguration() {
        return {
          // Auto Learn off: these are about the guard, not the learner.
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

  delete require.cache[extensionPath];
  const extension = require(extensionPath);
  extension.activate({ subscriptions: [] });
  return {
    commands,
    shown,
    async dispose() {
      await extension.deactivate();
      Module._load = originalLoad;
      delete require.cache[extensionPath];
    },
  };
}

const BACKUP = {
  allow: ['Bash(git *)', 'Bash(rg *)', 'Bash(tokei *)', 'Bash(jq *)', 'Bash(fd *)', 'Bash(bat *)'],
  deny: ['Bash(rm -rf /*)', 'Bash(mkfs* *)'],
};

// A half-written file, which is what a watcher event can catch: Claude Code
// truncates settings.json and writes it again in place.
const TRUNCATED = '{\n  "permissions": {\n    "allow": [\n      "Bash(gi';

function setup(t) {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'permission-wildcarding-unreadable-'));
  fs.mkdirSync(path.join(tempHome, '.claude', 'backups'), { recursive: true });
  t.after(() => fs.rmSync(tempHome, { recursive: true, force: true }));
  const settingsPath = path.join(tempHome, '.claude', 'settings.json');
  fs.writeFileSync(
    path.join(tempHome, '.claude', 'backups', 'allow-list.latest.json'),
    JSON.stringify(BACKUP, null, 2) + '\n');
  return { tempHome, settingsPath };
}

test('a settings.json caught mid-write is not reported as a wipe', async (t) => {
  const env = setup(t);
  fs.writeFileSync(env.settingsPath, TRUNCATED);

  const app = harness(env.tempHome);
  try {
    // activate() runs the guard directly, which is the path that fired on this
    // machine. The backup holds 8 entries and the file appears to hold none.
    assert.deepEqual(app.shown.warning, [], 'no loss to report from a state we could not read');
    assert.deepEqual(app.shown.info, [], 'and nothing to announce restoring');
    assert.equal(fs.readFileSync(env.settingsPath, 'utf8'), TRUNCATED,
      'the mid-write file must be left exactly as found');
  } finally {
    await app.dispose();
  }
});

test('an unreadable settings.json is never written over, even on an explicit restore', async (t) => {
  const env = setup(t);
  fs.writeFileSync(env.settingsPath, TRUNCATED);

  const app = harness(env.tempHome);
  try {
    await app.commands.get('permission-wildcarding.restoreBackup')();
    assert.equal(fs.readFileSync(env.settingsPath, 'utf8'), TRUNCATED,
      'restoring over an unparseable file would drop every key it holds');
    assert.equal(app.shown.warning.length, 1, 'the user is told why nothing happened');
    assert.match(app.shown.warning[0], /could not be parsed/);
    assert.deepEqual(app.shown.info, [], 'and is not told it was restored');
  } finally {
    await app.dispose();
  }
});

// The other half of the same bug: a write that rebases onto a fallback snapshot
// when the real file cannot be parsed produces a settings.json holding nothing but
// `permissions`, dropping model, effortLevel, hooks and env with it.
test('a drain refuses to rebase onto an unparseable settings.json', async (t) => {
  const env = setup(t);
  fs.writeFileSync(env.settingsPath, TRUNCATED);
  const localDir = path.join(env.tempHome, 'workspace', '.claude');
  fs.mkdirSync(localDir, { recursive: true });
  fs.writeFileSync(path.join(localDir, 'settings.local.json'),
    JSON.stringify({ permissions: { allow: ['Bash(pytest *)'] } }, null, 2) + '\n');

  const app = harness(env.tempHome);
  try {
    await app.commands.get('permission-wildcarding.drainLocal')();
    assert.equal(fs.readFileSync(env.settingsPath, 'utf8'), TRUNCATED,
      'the fallback rebase would have written a settings.json holding only permissions');
    assert.deepEqual(app.shown.error, [], 'a transient mid-write is not an error to shout about');
    assert.ok(app.shown.status.some((message) => /mid-write/.test(message)),
      'a click still gets an answer, and the drain retries');
    // The local entry is not consumed, so a later pass can still promote it.
    const local = JSON.parse(fs.readFileSync(path.join(localDir, 'settings.local.json'), 'utf8'));
    assert.deepEqual(local.permissions.allow, ['Bash(pytest *)']);
  } finally {
    await app.dispose();
  }
});

// The recovery case the backup exists for has to keep working: a policy refresh
// that removes the file, or empties it, is a real loss and still auto-repairs.
test('an absent settings.json still restores from the backup', async (t) => {
  const env = setup(t);

  const app = harness(env.tempHome);
  try {
    const after = JSON.parse(fs.readFileSync(env.settingsPath, 'utf8'));
    assert.deepEqual(after.permissions.allow.sort(), [...BACKUP.allow].sort(),
      'nothing on disk means nothing to lose, so the backup steps in');
    assert.deepEqual(after.permissions.deny, BACKUP.deny);
    assert.equal(app.shown.warning.length, 1, 'one notification for one event');
    assert.match(app.shown.warning[0], /re-asserted 8 entries that went missing/);
    assert.deepEqual(app.shown.info, [], 'the restore does not raise a second toast');
  } finally {
    await app.dispose();
  }
});

test('an emptied settings.json restores, and the count is what landed on disk', async (t) => {
  const env = setup(t);
  fs.writeFileSync(env.settingsPath,
    JSON.stringify({ permissions: { allow: ['Bash(git *)'], deny: [] }, model: 'claude-opus-5' }, null, 2) + '\n');

  const app = harness(env.tempHome);
  try {
    const after = JSON.parse(fs.readFileSync(env.settingsPath, 'utf8'));
    assert.equal(after.model, 'claude-opus-5', 'unrelated keys survive a restore');
    assert.equal(after.permissions.allow.length, BACKUP.allow.length);
    // Bash(git *) was already live, so 7 entries actually arrived, not 8.
    assert.match(app.shown.warning[0], /re-asserted 7 entries that went missing/);
  } finally {
    await app.dispose();
  }
});
