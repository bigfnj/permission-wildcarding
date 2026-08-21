'use strict';

// The wiring, not the rules: src/local-settings.js and src/agent-guidance.js are
// unit-tested on their own, so these drive the real extension against a
// throwaway home and assert the parts only the extension owns — that a promoted
// entry goes through the rebasing writer (and so reaches the policy backup),
// that the local file is pruned, and that activation installs the shell-style
// block in CLAUDE.md without being asked twice.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

// The published marker contract, spelled out rather than imported on purpose:
// requiring src/ from the top of this file would cache a copy that captured the
// real `os` before the harness installed its mocked homedir, and the extension
// would then write to the developer's own ~/.claude. Never import src/ here.
const BEGIN = '<!-- BEGIN permission-wildcarding: shell style (managed) -->';

function disposable() { return { dispose() {} }; }

function harness(tempHome, { guidance = true, localDrain = true } = {}) {
  const commands = new Map();
  const messages = [];
  const warnings = [];
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
      showInformationMessage(message) { messages.push(message); },
      showWarningMessage(message) { warnings.push(message); return Promise.resolve(undefined); },
    },
    workspace: {
      isTrusted: true,
      workspaceFolders: [{ uri: { fsPath: path.join(tempHome, 'workspace') } }],
      createFileSystemWatcher(pattern) {
        return { pattern, onDidChange() {}, onDidCreate() {}, onDidDelete() {}, dispose() {} };
      },
      getConfiguration() {
        return {
          get: (key, fallback) => {
            if (key === 'autoLearn.enabled') return false; // not what these tests are about
            if (key === 'guidance.enabled') return guidance;
            if (key === 'localDrain.enabled') return localDrain;
            return fallback;
          },
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

  // Drop every cached shared module as well as the extension, so each one is
  // re-required under the mocked `os` above. A module that captured the real
  // homedir at first load would send this test's writes to the real ~/.claude.
  delete require.cache[extensionPath];
  for (const cached of Object.keys(require.cache)) {
    if (cached.startsWith(rootSrc + path.sep)) delete require.cache[cached];
  }
  const extension = require(extensionPath);
  extension.activate({ subscriptions: [] });
  return {
    commands,
    messages,
    warnings,
    async dispose() {
      await extension.deactivate();
      Module._load = originalLoad;
      delete require.cache[extensionPath];
    },
  };
}

function setup(t, { allow = [], deny = [], local = null } = {}) {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'permission-wildcarding-drain-'));
  t.after(() => fs.rmSync(tempHome, { recursive: true, force: true }));
  fs.mkdirSync(path.join(tempHome, '.claude'), { recursive: true });
  const settingsPath = path.join(tempHome, '.claude', 'settings.json');
  fs.writeFileSync(settingsPath, JSON.stringify({ permissions: { allow, deny } }, null, 2) + '\n');
  const localPath = path.join(tempHome, 'workspace', '.claude', 'settings.local.json');
  if (local) {
    fs.mkdirSync(path.dirname(localPath), { recursive: true });
    fs.writeFileSync(localPath, JSON.stringify({ permissions: { allow: local } }, null, 2) + '\n');
  }
  return {
    tempHome,
    settingsPath,
    localPath,
    claudeMd: path.join(tempHome, '.claude', 'CLAUDE.md'),
    backupPath: path.join(tempHome, '.claude', 'backups', 'allow-list.latest.json'),
    user: () => JSON.parse(fs.readFileSync(settingsPath, 'utf8')).permissions,
    localAllow: () => JSON.parse(fs.readFileSync(localPath, 'utf8')).permissions.allow,
  };
}

test('activation drains project-local approvals and the promotion reaches the backup', async (t) => {
  const env = setup(t, {
    allow: ['Bash(rg *)'],
    local: ['Bash(dotnet build src/App.csproj)', 'Bash(rg needle)', 'PowerShell($x = 1; ls)'],
  });

  const app = harness(env.tempHome);
  try {
    // The drain runs on activation, so by here the work is already done.
    const user = env.user();
    assert.ok(user.allow.includes('Bash(dotnet build *)'), 'portable family promoted to user scope');
    assert.deepEqual(env.localAllow(), ['PowerShell($x = 1; ls)'], 'only the script blob stays local');

    // Promoted through the extension's own writer, so the policy guard can
    // restore it after a managed-settings wipe like any other approval.
    const backup = JSON.parse(fs.readFileSync(env.backupPath, 'utf8'));
    assert.ok(backup.allow.includes('Bash(dotnet build *)'));

    // Idempotent: a second run has nothing to move and leaves both files alone.
    const before = fs.readFileSync(env.localPath, 'utf8');
    await app.commands.get('permission-wildcarding.drainLocal')();
    assert.equal(fs.readFileSync(env.localPath, 'utf8'), before);
  } finally {
    await app.dispose();
  }
});

test('a deny rule still outranks a local approval, which stays where it was', async (t) => {
  const env = setup(t, { allow: [], deny: ['Bash(rm *)'], local: ['Bash(rm -rf build)'] });
  const app = harness(env.tempHome);
  try {
    assert.deepEqual(env.user().allow, [], 'a denied family is never promoted');
    assert.deepEqual(env.localAllow(), ['Bash(rm -rf build)']);
  } finally {
    await app.dispose();
  }
});

test('MAX mode refuses the drain rather than emptying the local file', async (t) => {
  const env = setup(t, {
    allow: ['Bash(*)', 'PowerShell(*)'],
    local: ['Bash(dotnet build src/App.csproj)'],
  });
  const app = harness(env.tempHome);
  try {
    await app.commands.get('permission-wildcarding.drainLocal')();
    assert.deepEqual(env.localAllow(), ['Bash(dotnet build src/App.csproj)']);
    assert.ok(
      app.warnings.some((message) => message.includes('Claude MAX is ON')),
      'the refusal is explained rather than silent'
    );
  } finally {
    await app.dispose();
  }
});

test('activation installs the shell-style block, and the toggle takes it away', async (t) => {
  const env = setup(t, { allow: ['Bash(rg *)'] });
  fs.writeFileSync(env.claudeMd, '# My instructions\n', 'utf8');

  const app = harness(env.tempHome);
  try {
    const text = fs.readFileSync(env.claudeMd, 'utf8');
    assert.ok(text.startsWith('# My instructions\n'), 'the user text keeps its place');
    assert.ok(text.includes(BEGIN), 'guidance block installed');
    assert.equal(text.split(BEGIN).length - 1, 1);

    // The toggle reads the file state, so it removes what activation added.
    await app.commands.get('permission-wildcarding.toggleGuidance')();
    assert.equal(fs.readFileSync(env.claudeMd, 'utf8'), '# My instructions\n');
  } finally {
    await app.dispose();
  }
});

test('with guidance disabled, activation leaves CLAUDE.md alone', async (t) => {
  const env = setup(t, { allow: [] });
  fs.writeFileSync(env.claudeMd, '# Mine\n', 'utf8');
  const app = harness(env.tempHome, { guidance: false });
  try {
    assert.equal(fs.readFileSync(env.claudeMd, 'utf8'), '# Mine\n');
  } finally {
    await app.dispose();
  }
});

test('with the local drain disabled, activation promotes nothing', async (t) => {
  const env = setup(t, { allow: [], local: ['Bash(dotnet build src/App.csproj)'] });
  const app = harness(env.tempHome, { localDrain: false });
  try {
    assert.deepEqual(env.user().allow, []);
    assert.deepEqual(env.localAllow(), ['Bash(dotnet build src/App.csproj)']);
    // Still available on demand: the setting gates the automatic pass, not the button.
    await app.commands.get('permission-wildcarding.drainLocal')();
    assert.ok(env.user().allow.includes('Bash(dotnet build *)'));
  } finally {
    await app.dispose();
  }
});
