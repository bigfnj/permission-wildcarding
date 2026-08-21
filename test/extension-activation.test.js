'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

function disposable() { return { dispose() {} }; }

test('extension activates with mocked VS Code and deactivates without live policy access', async () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'permission-wildcarding-extension-'));
  const commands = new Map();
  const watchers = [];
  const warnings = [];
  let autoLearnEnabled = true;
  let configurationHandler;
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
      createStatusBarItem() {
        return { hide() {}, show() {}, dispose() {} };
      },
      registerWebviewViewProvider() { return disposable(); },
      setStatusBarMessage() {},
      showErrorMessage() {},
      showInformationMessage() {},
      showWarningMessage(message) { warnings.push(message); },
    },
    workspace: {
      isTrusted: true,
      workspaceFolders: [{ uri: { fsPath: path.join(tempHome, 'workspace') } }],
      createFileSystemWatcher(pattern) {
        const watcher = {
          pattern, onDidChange() {}, onDidCreate() {}, onDidDelete() {}, dispose() {},
        };
        watchers.push(watcher);
        return watcher;
      },
      getConfiguration() {
        return {
          get: (key, fallback) => key === 'autoLearn.enabled' ? autoLearnEnabled : fallback,
          inspect: () => ({}), update: async () => {},
        };
      },
      onDidChangeConfiguration(handler) {
        configurationHandler = handler;
        return disposable();
      },
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

  try {
    delete require.cache[extensionPath];
    const extension = require(extensionPath);
    const context = { subscriptions: [] };
    extension.activate(context);
    assert.equal(commands.has('permission-wildcarding.scanHistory'), true);
    assert.equal(commands.has('permission-wildcarding.autoLearnScan'), true);
    assert.equal(commands.has('permission-wildcarding.autoLearnWhy'), true);
    assert.equal(commands.has('permission-wildcarding.autoLearnReview'), true);
    assert.equal(commands.has('permission-wildcarding.autoLearnApplySafe'), true);
    assert.ok(watchers.length >= 3);
    assert.doesNotThrow(() => configurationHandler({
      affectsConfiguration: (name) => name === 'permissionWildcarding.autoLearn',
    }));
    autoLearnEnabled = false;
    await commands.get('permission-wildcarding.autoLearnReview')();
    await commands.get('permission-wildcarding.autoLearnApplySafe')();
    assert.deepEqual(warnings.slice(-2), [
      'Auto Learn is disabled in settings. Enable it before reviewing candidates.',
      'Auto Learn is disabled in settings. Enable it before applying policy.',
    ]);
    await extension.deactivate();
  } finally {
    Module._load = originalLoad;
    delete require.cache[extensionPath];
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});
