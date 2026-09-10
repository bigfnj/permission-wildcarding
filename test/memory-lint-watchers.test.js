'use strict';

// The memory store moves whenever the working root is renamed, because Claude Code
// derives the project slug from the working directory. A watcher can only report on a
// directory that existed when it was created, so a move kills every watcher at once and
// leaves nothing able to say so. These tests pin the two halves of the answer: the
// watcher set is rebuilt from discovery, and a periodic reconcile exists as the backstop.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

function disposable() { return { dispose() {} }; }

function harness(tempHome, overrides = {}) {
  const created = [];
  const statusText = [];
  // Command ids are recorded, not discarded: whether a command is registered
  // at all is the difference between a working palette entry and "command
  // not found", and it depends on config.
  const registered = [];
  const info = [];
  const vscode = {
    RelativePattern: class RelativePattern {
      constructor(base, pattern) { this.base = base; this.pattern = pattern; }
    },
    StatusBarAlignment: { Left: 1, Right: 2 },
    ThemeColor: class ThemeColor { constructor(id) { this.id = id; } },
    Uri: { file: (fsPath) => ({ fsPath }) },
    Range: class Range { constructor(a, b, c, d) { Object.assign(this, { a, b, c, d }); } },
    Diagnostic: class Diagnostic { constructor(range, message) { Object.assign(this, { range, message }); } },
    DiagnosticSeverity: { Warning: 1, Information: 2 },
    commands: {
      // Throws on a duplicate id, because the real API does. The empty stub that
      // was here let a double registration pass unnoticed while it broke
      // activate() on the default configuration.
      registerCommand: (id) => {
        if (registered.includes(id)) throw new Error(`command '${id}' already exists`);
        registered.push(id);
        return disposable();
      },
    },
    languages: { createDiagnosticCollection: () => ({ set() {}, clear() {}, dispose() {} }) },
    window: {
      createOutputChannel: () => ({ appendLine() {}, clear() {}, show() {}, dispose() {} }),
      createStatusBarItem: () => ({
        show() {}, hide() {}, dispose() {},
        set text(value) { statusText.push(value); },
        get text() { return statusText[statusText.length - 1]; },
      }),
      onDidChangeActiveTextEditor: () => disposable(),
      // Recorded, not stubbed empty: with the lint disabled the report has
      // nowhere to write, so what it TELLS the user is the whole behaviour.
      showInformationMessage: (message) => { info.push(message); return Promise.resolve(); },
    },
    workspace: {
      getConfiguration: () => ({
        get: (key, fallback) => (Object.prototype.hasOwnProperty.call(overrides, key)
          ? overrides[key] : fallback),
      }),
      createFileSystemWatcher(pattern) {
        const watcher = {
          pattern, disposed: false,
          onDidChange() {}, onDidCreate() {}, onDidDelete() {},
          dispose() { this.disposed = true; },
        };
        created.push(watcher);
        return watcher;
      },
      onDidSaveTextDocument: () => disposable(),
      onDidOpenTextDocument: () => disposable(),
    },
  };
  const modulePath = require.resolve('../vscode-extension/memoryLint');
  const originalLoad = Module._load;
  const intervals = [];
  const originalSetInterval = global.setInterval;
  Module._load = function load(request, parent, isMain) {
    if (request === 'vscode') return vscode;
    if (request === 'os') return { ...os, homedir: () => tempHome };
    return originalLoad.call(this, request, parent, isMain);
  };
  global.setInterval = (fn, ms) => { intervals.push({ fn, ms }); return { unref() {} }; };
  delete require.cache[modulePath];
  const loaded = require(modulePath);
  const restore = () => {
    Module._load = originalLoad;
    global.setInterval = originalSetInterval;
    delete require.cache[modulePath];
  };
  return { loaded, created, statusText, intervals, registered, info, restore };
}

function writeStore(dir, indexBody) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'MEMORY.md'), indexBody, 'utf8');
}

test('the watcher set follows the store when it moves to a new project slug', () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-lint-move-'));
  const oldDir = path.join(tempHome, '.claude', 'projects', 'd---old', 'memory');
  const newDir = path.join(tempHome, '.claude', 'projects', 'd---new', 'memory');
  writeStore(oldDir, '# Memory Index\n\n- [one](one.md) — hook\n');
  fs.writeFileSync(path.join(oldDir, 'one.md'), 'body\n', 'utf8');

  const h = harness(tempHome);
  try {
    const lint = new h.loaded.MemoryLint();
    lint.activate({ subscriptions: [] });

    assert.equal(lint.watchers.size, 1, 'one watcher for the store that exists');
    assert.equal(lint.watchers.has(oldDir), true);
    const first = h.created[0];

    // The move: the whole store relocates to a different slug, exactly as a renamed
    // working root does. Nothing about the old directory survives.
    fs.mkdirSync(path.dirname(newDir), { recursive: true });
    fs.renameSync(oldDir, newDir);
    fs.rmSync(path.join(tempHome, '.claude', 'projects', 'd---old'), { recursive: true, force: true });

    lint.refresh();

    assert.equal(lint.watchers.has(oldDir), false, 'the dead watcher is dropped');
    assert.equal(first.disposed, true, 'and actually disposed, not just forgotten');
    assert.equal(lint.watchers.has(newDir), true, 'a watcher is created for the new store');
    assert.equal(lint.watchers.size, 1);
  } finally {
    h.restore();
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});

test('a periodic reconcile is registered, so a move with no live watcher still repaints', () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-lint-reconcile-'));
  const oldDir = path.join(tempHome, '.claude', 'projects', 'd---old', 'memory');
  const newDir = path.join(tempHome, '.claude', 'projects', 'd---new', 'memory');
  // 2 lines over a 40-char budget in the old store, none in the new one, so the gauge
  // text alone proves which store the reading came from.
  writeStore(oldDir, '# Memory Index\n\n- [x](x.md) — ' + 'y'.repeat(80) + '\n');

  const h = harness(tempHome);
  try {
    const lint = new h.loaded.MemoryLint();
    lint.activate({ subscriptions: [] });
    const before = lint.status.text;
    assert.match(before, /mem: \d+/);

    assert.equal(h.intervals.length, 1, 'exactly one reconcile timer');
    assert.equal(h.intervals[0].ms, 5 * 60 * 1000);

    fs.mkdirSync(path.dirname(newDir), { recursive: true });
    fs.renameSync(oldDir, newDir);
    fs.rmSync(path.join(tempHome, '.claude', 'projects', 'd---old'), { recursive: true, force: true });
    fs.writeFileSync(path.join(newDir, 'MEMORY.md'), '# Memory Index\n\n- [x](x.md) — short\n', 'utf8');

    // No watcher can fire here — the directory it watched is gone. The timer is the
    // only thing left that can notice, which is the whole point of it existing.
    h.intervals[0].fn();

    assert.equal(lint.watchers.has(newDir), true);
    assert.notEqual(lint.status.text, before, 'the gauge repainted instead of freezing');
  } finally {
    h.restore();
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});

test('disabling the lint releases every watcher it was holding', () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-lint-disable-'));
  const dir = path.join(tempHome, '.claude', 'projects', 'd---only', 'memory');
  writeStore(dir, '# Memory Index\n\n- [one](one.md) — hook\n');

  const h = harness(tempHome);
  try {
    const lint = new h.loaded.MemoryLint();
    lint.activate({ subscriptions: [] });
    assert.equal(lint.watchers.size, 1);
    lint.disposeWatchers();
    assert.equal(lint.watchers.size, 0);
    assert.equal(h.created.every((w) => w.disposed), true);
  } finally {
    h.restore();
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});

// The debounce timer used to be armed by schedule() and cleared by nothing. A
// MEMORY.md write within 300 ms of a reload left it live, and it then fired
// refresh() after every subscription had been disposed — clearing a disposed
// DiagnosticCollection, hiding a disposed StatusBarItem, and calling
// syncWatchers(), which creates a watcher per discovered dir into a map nothing
// would ever drain again. Two guards, so this test asserts both.
test('the debounce timer is cleared on teardown, and cannot build watchers after it', () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-lint-debounce-'));
  const dir = path.join(tempHome, '.claude', 'projects', 'd---work', 'memory');
  writeStore(dir, '# Memory Index\n\n- [one](one.md) — hook\n');
  fs.writeFileSync(path.join(dir, 'one.md'), 'body\n', 'utf8');

  const h = harness(tempHome);
  // Stubbed locally rather than in the shared harness: the other tests here do
  // not arm a debounce, and a global timer stub they did not ask for is exactly
  // the kind of shared-fixture coupling that makes one failure look like three.
  const realSetTimeout = global.setTimeout;
  const realClearTimeout = global.clearTimeout;
  const armed = [];
  let cleared = 0;
  global.setTimeout = (fn, ms) => { const handle = { fn, ms }; armed.push(handle); return handle; };
  global.clearTimeout = (handle) => { if (handle) cleared += 1; };
  try {
    const lint = new h.loaded.MemoryLint();
    const subscriptions = [];
    lint.activate({ subscriptions });
    const watchersAfterActivate = h.created.length;
    assert.ok(watchersAfterActivate > 0, 'precondition: activation discovered the store');

    // An external write to MEMORY.md, 300 ms before the user reloads the window.
    lint.schedule();
    assert.equal(armed.length, 1, 'precondition: schedule() armed the debounce');

    // The reload: VS Code disposes every registered subscription.
    for (const subscription of subscriptions) subscription.dispose();
    assert.ok(cleared > 0, 'teardown has to clear the debounce, not only the interval');

    // Belt and brace. Clearing stops a callback being scheduled; it cannot
    // recall one already dispatched, so refresh() must also refuse to run.
    armed[0].fn();
    assert.equal(h.created.length, watchersAfterActivate,
      'a post-teardown refresh must not create another watcher per discovered dir');
  } finally {
    global.setTimeout = realSetTimeout;
    global.clearTimeout = realClearTimeout;
    h.restore();
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});

// package.json declares permission-wildcarding.lintMemory with no `when` clause
// and a null commandPalette section, so the palette entry exists whatever
// memory.enabled says. Registration used to sit AFTER the enabled check, so
// with the feature off the command's only discoverable entry point raised
// "command not found" — a declared-but-unwired command, not a missing feature.
test('lintMemory stays registered when the lint is disabled, and says so', () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-lint-off-'));
  const dir = path.join(tempHome, '.claude', 'projects', 'd---off', 'memory');
  writeStore(dir, '# Memory Index\n\n- [one](one.md) — hook\n');

  const h = harness(tempHome, { 'memory.enabled': false });
  try {
    const lint = new h.loaded.MemoryLint();
    lint.activate({ subscriptions: [] });

    assert.ok(h.registered.includes('permission-wildcarding.lintMemory'),
      'the command package.json advertises must exist even with the lint off');
    // ...and the feature really is off, so this is not just "enabled ignored".
    assert.equal(lint.watchers.size, 0, 'no watchers when disabled');
    assert.equal(h.intervals.length, 0, 'no reconcile timer when disabled');
    assert.equal(lint.diags, null, 'no diagnostic collection when disabled');

    // Invoking it must report, not throw: activate() never built this.channel
    // on the disabled path, and showReport() used to dereference it.
    assert.doesNotThrow(() => lint.showReport());
    assert.match(h.info.join(' '), /memory lint is off/,
      'it has to name the reason, not fail silently or report an empty index');
  } finally {
    h.restore();
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});

// The ENABLED path, which is the default and was the one left broken. Moving the
// command registration above the `enabled` check left the original in place, and
// VS Code throws on a duplicate id — so activate() threw partway through, the
// caller logged it to the console, and the reconcile timer, the watcher disposer
// and the initial refresh never ran. The gauge and the diagnostics never
// appeared, in the configuration almost everyone uses.
//
// The sibling test above only drove memory.enabled=false, where the second
// registration is unreachable. That is why it passed while this was broken.
test('activate completes on the default configuration, registering the command once', () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-lint-enabled-'));
  const dir = path.join(tempHome, '.claude', 'projects', 'd---on', 'memory');
  writeStore(dir, '# Memory Index\n\n- [one](one.md) — hook\n');
  fs.writeFileSync(path.join(dir, 'one.md'), 'body\n', 'utf8');

  const h = harness(tempHome); // no overrides, so memory.enabled defaults to true
  try {
    const lint = new h.loaded.MemoryLint();
    const subscriptions = [];
    // The whole point: this must not throw.
    assert.doesNotThrow(() => lint.activate({ subscriptions }),
      'a duplicate command registration makes VS Code throw and aborts activate');

    assert.equal(
      h.registered.filter((id) => id === 'permission-wildcarding.lintMemory').length, 1,
      'registered exactly once — twice throws, zero leaves the palette entry dead',
    );
    // Everything after the throw point, which is what silently never ran.
    assert.equal(h.intervals.length, 1, 'the reconcile timer is armed');
    assert.ok(lint.diags, 'the diagnostic collection exists');
    assert.equal(lint.watchers.size, 1, 'the initial refresh ran and built a watcher');
    assert.ok(h.statusText.length > 0, 'and the status-bar gauge was painted');
  } finally {
    h.restore();
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});

// `memory.enabled` is a Settings-UI toggle, and everything below activate()'s
// enabled check is built once at activation or never. Flipping it false -> true
// therefore needed a window reload, and the disabled path has no reconcile timer
// to cover for that. extension.js's config listener made this worse rather than
// better for a while: it refreshed the dashboard CARD, whose data is re-read on
// every call, so the card went live while the linter stayed inert — the UI
// asserting the feature was on when it was off.
test('enabling the lint at runtime builds it, without a window reload', () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-lint-enable-'));
  const dir = path.join(tempHome, '.claude', 'projects', 'd---on', 'memory');
  writeStore(dir, '# Memory Index\n\n- [one](one.md) — ' + 'y'.repeat(80) + '\n');
  fs.writeFileSync(path.join(dir, 'one.md'), 'body\n', 'utf8');

  // Mutable, so the test can flip the setting the way the Settings UI does.
  const overrides = { 'memory.enabled': false };
  const h = harness(tempHome, overrides);
  try {
    const lint = new h.loaded.MemoryLint();
    lint.activate({ subscriptions: [] });

    // Disabled: the command exists, and nothing else does.
    assert.equal(h.registered.length, 1, 'the palette entry is always registered');
    assert.equal(lint.diags, null, 'no diagnostic collection yet');
    assert.equal(lint.status, null, 'no gauge yet');
    assert.equal(h.intervals.length, 0, 'and no reconcile timer');

    overrides['memory.enabled'] = true;
    lint.reconfigure();

    assert.ok(lint.diags, 'the diagnostic collection is built on demand');
    assert.ok(lint.status, 'and the gauge');
    assert.equal(h.intervals.length, 1, 'and the reconcile timer is armed');
    assert.equal(lint.watchers.size, 1, 'and a watcher exists for the store');
    assert.ok(h.statusText.some((t) => /mem: \d+/.test(t)), 'and the gauge was painted');
    assert.equal(h.registered.length, 1, 'the command is still registered exactly once');
  } finally {
    h.restore();
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});

test('disabling the lint at runtime releases it, and a second flip does not rebuild twice', () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-lint-toggle-'));
  const dir = path.join(tempHome, '.claude', 'projects', 'd---on', 'memory');
  writeStore(dir, '# Memory Index\n\n- [one](one.md) — hook\n');
  fs.writeFileSync(path.join(dir, 'one.md'), 'body\n', 'utf8');

  const overrides = {};   // enabled defaults to true
  const h = harness(tempHome, overrides);
  try {
    const lint = new h.loaded.MemoryLint();
    lint.activate({ subscriptions: [] });
    assert.equal(lint.watchers.size, 1);
    const firstDiags = lint.diags;

    overrides['memory.enabled'] = false;
    lint.reconfigure();
    assert.equal(lint.watchers.size, 0, 'the watchers are released, not just ignored');

    overrides['memory.enabled'] = true;
    lint.reconfigure();
    // initialize() is idempotent: a second build would strand the first
    // collection, gauge and interval with nothing able to dispose them.
    assert.equal(lint.diags, firstDiags, 'the same collection, not a second one');
    assert.equal(h.intervals.length, 1, 'still exactly one reconcile timer');
    assert.equal(lint.watchers.size, 1, 'and the watcher is back');
  } finally {
    h.restore();
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});

test('reconfigure does nothing once the instance is torn down', () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-lint-torndown-'));
  const dir = path.join(tempHome, '.claude', 'projects', 'd---on', 'memory');
  writeStore(dir, '# Memory Index\n\n- [one](one.md) — hook\n');

  const overrides = {};
  const h = harness(tempHome, overrides);
  try {
    const lint = new h.loaded.MemoryLint();
    const subscriptions = [];
    lint.activate({ subscriptions });
    // What VS Code does at deactivate.
    for (const sub of subscriptions) sub.dispose();
    assert.equal(lint.disposed, true);

    // A configuration event can still arrive here — the listener is disposed,
    // but an already-dispatched callback is not recalled. Rebuilding into a
    // disposed context would leak a watcher per discovered dir into a map
    // nothing will ever drain again.
    lint.reconfigure();

    assert.equal(lint.watchers.size, 0, 'no watcher was created after teardown');
    assert.equal(h.intervals.length, 1, 'and no second reconcile timer');
  } finally {
    h.restore();
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});
