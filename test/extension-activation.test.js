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

// Three lifecycle leaks the audit found, none of which any test could see.
// Kept as its own mock rather than sharing the one above: a lifecycle test
// needs to count creations and disposals, and duplicating a mock is far cheaper
// than breaking the activation test that already works.
test('activation does not leak channels, watchers or timers', async () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'permission-wildcarding-leak-'));
  const commands = new Map();
  const channels = [];
  const watchers = [];
  const timers = { created: 0, cleared: 0 };
  let folderHandler;

  // A policy that cannot be parsed reports `degraded`, which is the cheapest
  // fixture that gets past the early returns in showAutoLearnBlocked and
  // actually reaches the output channel.
  fs.mkdirSync(path.join(tempHome, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(tempHome, '.claude', 'remote-settings.json'), '{ not json');

  const vscode = {
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    RelativePattern: class RelativePattern {
      constructor(base, pattern) { this.base = base; this.pattern = pattern; }
    },
    StatusBarAlignment: { Right: 2, Left: 1 },
    ThemeColor: class ThemeColor { constructor(id) { this.id = id; } },
    Uri: { file: (fsPath) => ({ fsPath }) },
    commands: {
      registerCommand(id, handler) { commands.set(id, handler); return disposable(); },
      executeCommand() {},
    },
    window: {
      createStatusBarItem() { return { hide() {}, show() {}, dispose() {} }; },
      createOutputChannel(name) {
        const channel = { name, disposed: false, appendLine() {}, clear() {}, show() {}, dispose() { this.disposed = true; } };
        channels.push(channel);
        return channel;
      },
      registerWebviewViewProvider() { return disposable(); },
      setStatusBarMessage() {}, showErrorMessage() {},
      showInformationMessage() {}, showWarningMessage() {},
    },
    workspace: {
      isTrusted: true,
      workspaceFolders: [{ uri: { fsPath: path.join(tempHome, 'workspace') } }],
      createFileSystemWatcher(pattern) {
        const watcher = {
          pattern, disposed: false,
          onDidChange() {}, onDidCreate() {}, onDidDelete() {},
          dispose() { this.disposed = true; },
        };
        watchers.push(watcher);
        return watcher;
      },
      getConfiguration() {
        return { get: (key, fallback) => fallback, inspect: () => ({}), update: async () => {} };
      },
      onDidChangeConfiguration() { return disposable(); },
      onDidChangeWorkspaceFolders(handler) { folderHandler = handler; return disposable(); },
    },
  };

  const extensionPath = require.resolve('../vscode-extension/extension');
  const rootSrc = path.resolve(__dirname, '..', 'src');
  const originalLoad = Module._load;
  const realSetTimeout = global.setTimeout;
  const realClearTimeout = global.clearTimeout;
  global.setTimeout = (...args) => { timers.created += 1; return realSetTimeout(...args); };
  global.clearTimeout = (...args) => { timers.cleared += 1; return realClearTimeout(...args); };
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

  let extension;
  try {
    delete require.cache[extensionPath];
    extension = require(extensionPath);
    const context = { subscriptions: [] };
    extension.activate(context);

    // One channel for the extension, not one per invocation. Three sites used
    // to create one every time and never dispose it, including a palette
    // command with no call limit.
    await commands.get('permission-wildcarding.autoLearnShowBlocked')();
    await commands.get('permission-wildcarding.autoLearnShowBlocked')();
    await commands.get('permission-wildcarding.autoLearnShowBlocked')();
    assert.equal(channels.length, 1, 'the output channel is created once, not per call');

    // A folder change re-attaches the local watchers. Each one used to be
    // pushed into context.subscriptions as well as the local list, and only
    // the local list was drained, so the array grew for the life of the window.
    assert.equal(typeof folderHandler, 'function', 'the folder handler is registered');
    const subscriptionsAfterActivate = context.subscriptions.length;
    const watchersAfterActivate = watchers.length;
    for (let round = 0; round < 5; round += 1) folderHandler();
    assert.equal(context.subscriptions.length, subscriptionsAfterActivate,
      'context.subscriptions does not grow with every folder change');
    assert.ok(watchers.length > watchersAfterActivate, 'new watchers really were created');
    assert.equal(watchers.filter((w) => !w.disposed).length, watchersAfterActivate,
      'every superseded watcher was disposed rather than pinned');

    const clearedBefore = timers.cleared;
    await extension.deactivate();
    assert.ok(channels.every((channel) => channel.disposed), 'the channel is disposed');

    // VS Code disposes `context.subscriptions` itself after deactivate; the
    // extension never touches that array. Simulating it is the only way to
    // check that the ONE subscription registered for the local watchers really
    // drains the live list.
    for (const item of context.subscriptions) {
      if (typeof item?.dispose === 'function') item.dispose();
    }
    assert.equal(watchers.filter((w) => !w.disposed).length, 0,
      'the single drain subscription disposes whatever is currently attached');
    // Seven clearTimeout calls, up from five. The five that were always there
    // are debounceTimer, policyBounce, localDrainBounce, memBounce and
    // autoLearnBounce; the two added are gatesBounce, whose callback spawns
    // Python, and the deferred recall check, whose handle was never captured at
    // all. autoLearnTimer is a clearInterval and so is not in this count.
    assert.ok(timers.cleared - clearedBefore >= 7,
      `deactivate cleared ${timers.cleared - clearedBefore} timeouts, expected at least 7`);
  } finally {
    // Unconditional, and it has to be. When an assertion above fails,
    // deactivate never runs, and the deferred recall check then fires ten
    // seconds later and SPAWNS PYTHON against a torn-down extension, which
    // hangs the test runner instead of reporting a failure. That is the leak
    // this test exists to catch, so the test must not depend on the leak being
    // absent in order to report on it.
    try { await extension?.deactivate?.(); } catch { /* already down */ }
    global.setTimeout = realSetTimeout;
    global.clearTimeout = realClearTimeout;
    Module._load = originalLoad;
    delete require.cache[extensionPath];
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});
