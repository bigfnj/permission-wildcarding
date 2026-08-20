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

function harness(tempHome) {
  const created = [];
  const statusText = [];
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
    commands: { registerCommand: () => disposable() },
    languages: { createDiagnosticCollection: () => ({ set() {}, clear() {}, dispose() {} }) },
    window: {
      createOutputChannel: () => ({ appendLine() {}, clear() {}, show() {}, dispose() {} }),
      createStatusBarItem: () => ({
        show() {}, hide() {}, dispose() {},
        set text(value) { statusText.push(value); },
        get text() { return statusText[statusText.length - 1]; },
      }),
      onDidChangeActiveTextEditor: () => disposable(),
    },
    workspace: {
      getConfiguration: () => ({ get: (key, fallback) => fallback }),
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
  return { loaded, created, statusText, intervals, restore };
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
