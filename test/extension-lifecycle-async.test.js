'use strict';

// deactivate() cleared seven timeouts and an interval and then hoped. A cleared
// timer stops work that has not STARTED; it says nothing about work in flight,
// and this extension has four kinds of it:
//
//   - four execFile children (up to 180s), none of them retained, so nothing
//     could be killed. One of those callbacks chains into ensureGates() →
//     setGatesAll(), i.e. it rewrites the user's CLAUDE.md / AGENTS.md from a
//     torn-down host.
//   - a sticky `deactivating` flag inside the Auto Learn worker runner, whose
//     public API has no reset, retained across a same-realm re-activate — so
//     every later Auto Learn operation rejected, permanently.
//   - `autoLearnBusy` left true, which short-circuits every later scan.
//
// Its own mocks, again: this needs to count spawns, kills and watcher callbacks,
// and the standing decision in this suite (test/extension-activation.test.js:113)
// is that duplicating a mock is cheaper than breaking one that works.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { EventEmitter } = require('node:events');

const extensionPath = require.resolve('../vscode-extension/extension');

function disposable() { return { dispose() {} }; }

function tick(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

// Resolves like the real worker: one result message, then exit.
class FakeWorker extends EventEmitter {
  constructor() {
    super();
    setImmediate(() => {
      this.emit('message', { ok: true, result: {} });
      this.emit('exit', 0);
    });
  }

  terminate() { return Promise.resolve(0); }
}

function harness(tempHome, options = {}) {
  const commands = new Map();
  const watchers = [];
  const spawns = [];
  const statuses = [];
  const errors = [];
  const infos = [];
  const settings = { ...(options.settings || {}) };

  const vscode = {
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    ProgressLocation: { Notification: 15 },
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
      setStatusBarMessage(message) { statuses.push(String(message)); },
      showErrorMessage(message) { errors.push(String(message)); },
      showInformationMessage(message) { infos.push(String(message)); return Promise.resolve(undefined); },
      showWarningMessage(message) { return Promise.resolve(undefined); },
      withProgress(_options, task) { return task({ report() {} }, { onCancellationRequested() {} }); },
    },
    workspace: {
      isTrusted: true,
      workspaceFolders: [{ uri: { fsPath: path.join(tempHome, 'workspace') } }],
      createFileSystemWatcher(pattern) {
        const handlers = { change: [], create: [], delete: [] };
        const watcher = {
          pattern,
          onDidChange(cb) { handlers.change.push(cb); return disposable(); },
          onDidCreate(cb) { handlers.create.push(cb); return disposable(); },
          onDidDelete(cb) { handlers.delete.push(cb); return disposable(); },
          dispose() {},
          fire(kind, argument) { for (const cb of handlers[kind]) cb(argument); },
        };
        watchers.push(watcher);
        return watcher;
      },
      getConfiguration() {
        return {
          get: (key, fallback) => (key in settings ? settings[key] : fallback),
          inspect: () => ({}),
          update: async (key, value) => { settings[key] = value; },
        };
      },
      onDidChangeConfiguration() { return disposable(); },
      onDidChangeWorkspaceFolders() { return disposable(); },
    },
  };

  const rootSrc = path.resolve(__dirname, '..', 'src');
  const originalLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (request === 'vscode') return vscode;
    if (request === 'os') return { ...os, homedir: () => tempHome };
    if (request === 'child_process' && parent?.filename === extensionPath) {
      // Every spawn is captured with the ChildProcess handle the extension gets
      // back, so a test can assert what deactivate did to it and then deliver
      // the callback the way a real child would on its way out.
      return {
        execFile(file, args, execOptions, callback) {
          const child = {
            kills: 0,
            on() {},
            kill() { child.kills += 1; return true; },
          };
          spawns.push({ file, args, options: execOptions, callback, child });
          return child;
        },
      };
    }
    if (request === './autoLearnWorkerRunner' && parent?.filename === extensionPath) {
      // The real runner — the sticky `deactivating` flag is the thing under test
      // — driven by a fake worker so no thread is started.
      const real = originalLoad.call(this, request, parent, isMain);
      return {
        createAutoLearnWorkerRunner: (runnerOptions) => real.createAutoLearnWorkerRunner({
          ...runnerOptions, workerFactory: () => new FakeWorker(),
        }),
      };
    }
    if (parent?.filename === extensionPath && request.startsWith('./src/')) {
      return originalLoad.call(this, path.join(rootSrc, request.slice('./src/'.length)), parent, isMain);
    }
    if (request === './memoryLint' && parent?.filename === extensionPath) {
      return {
        MemoryLint: class MemoryLint { activate() {} },
        memoryReport: () => (options.memoryDir
          ? {
            conf: { enabled: true, dir: options.memoryDir, lineBudget: 300, totalBudget: 12000 },
            dir: options.memoryDir,
            report: {
              tokens: 10, bytes: 40, fileCount: 1, over: [], broken: [], unresolved: [],
            },
          }
          : { conf: {}, dir: null, report: null }),
        discoverDirs: () => (options.memoryDir ? [options.memoryDir] : []),
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  // Not just the extension: the shared src/ modules capture `os` at require
  // time, and their exported helpers default to `os.homedir()` at CALL time — so
  // a second harness in the same file would keep resolving the FIRST harness's
  // mocked home, look for instruction files in a directory that no longer
  // exists, and pass by testing nothing.
  const purge = () => {
    const extensionDir = path.dirname(extensionPath) + path.sep;
    for (const key of Object.keys(require.cache)) {
      if (key.startsWith(rootSrc + path.sep) || key.startsWith(extensionDir)) {
        delete require.cache[key];
      }
    }
  };

  purge();
  const extension = require(extensionPath);
  extension.activate({ subscriptions: [] });
  return {
    commands,
    errors,
    extension,
    infos,
    settings,
    spawns,
    statuses,
    watcherFor(name) {
      const hit = watchers.find((watcher) => watcher.pattern?.pattern === name);
      assert.ok(hit, `no watcher registered for ${name}`);
      return hit;
    },
    reactivate() { extension.activate({ subscriptions: [] }); },
    // Always, even when a test already deactivated to observe the teardown: a
    // second call is a no-op, and an activation left running keeps a
    // reconciliation interval alive and the test process with it.
    async dispose() {
      await extension.deactivate();
      Module._load = originalLoad;
      purge();
    },
  };
}

function tempHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'permission-wildcarding-lifecycle-'));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.claude', 'settings.json'),
    JSON.stringify({ permissions: { allow: ['Bash(rg *)'], deny: [] } }, null, 2) + '\n');
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

// A memory dir with something embeddable in it and no cache, which is what makes
// the recall index read as stale and lets the background sync spawn.
function memoryCorpus(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'permission-wildcarding-memory-'));
  fs.writeFileSync(path.join(dir, 'note.md'), '# note\n\nsomething to embed\n');
  fs.writeFileSync(path.join(dir, 'MEMORY.md'), '# index\n');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// The two passive probes recall spawns are gated on, satisfied with empty files
// so the gate opens on any platform and nothing real is ever executed.
function fakeRecallEnvironment(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'permission-wildcarding-toolbox-'));
  const python = path.join(root, 'python', '.venv', 'Scripts', 'python.exe');
  fs.mkdirSync(path.dirname(python), { recursive: true });
  fs.writeFileSync(python, '');
  const models = path.join(root, 'models');
  fs.mkdirSync(models, { recursive: true });
  fs.writeFileSync(path.join(models, 'bge-small.onnx'), '');
  fs.writeFileSync(path.join(models, 'bge-small.vocab.txt'), '');
  const previous = { toolbox: process.env.CODEX_TOOLBOX, models: process.env.RECALL_MODEL_DIR };
  process.env.CODEX_TOOLBOX = root;
  process.env.RECALL_MODEL_DIR = models;
  t.after(() => {
    if (previous.toolbox === undefined) delete process.env.CODEX_TOOLBOX;
    else process.env.CODEX_TOOLBOX = previous.toolbox;
    if (previous.models === undefined) delete process.env.RECALL_MODEL_DIR;
    else process.env.RECALL_MODEL_DIR = previous.models;
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { python };
}

test('a python child that outlives the extension is killed, and says nothing after', async (t) => {
  const home = tempHome(t);
  const corpus = memoryCorpus(t);
  fakeRecallEnvironment(t);
  const app = harness(home, { memoryDir: corpus });
  try {
    // A MEMORY.md write is what schedules the background recall sync (memBounce,
    // 350ms), and the sync is the cheapest of the four spawn sites to reach.
    app.watcherFor('MEMORY.md').fire('change', { fsPath: path.join(corpus, 'MEMORY.md') });
    await tick(450);
    assert.equal(app.spawns.length, 1, 'the sync spawned recall.py');
    const spawn = app.spawns[0];
    assert.ok(spawn.args.includes('--list'), 'the background sync is the incremental build');
    assert.equal(spawn.child.kills, 0);

    await app.extension.deactivate();
    assert.equal(spawn.child.kills, 1, 'deactivate kills the child it started');

    // What the kill actually produces: the callback still fires. It must not
    // report, and it must not push to a dashboard that is being torn down.
    app.statuses.length = 0;
    app.errors.length = 0;
    spawn.callback(Object.assign(new Error('Command failed'), { signal: 'SIGTERM' }), '', '');
    spawn.callback(null, '', '');
    assert.deepEqual(app.statuses, [], 'a torn-down extension reports nothing');
    assert.deepEqual(app.errors, []);
  } finally {
    await app.dispose();
  }
});

// The behavioural test above covers one of the four sites. This covers the other
// three cheaply, and fails when a fifth spawn is added without retaining it.
test('every execFile in the extension hands its child over to be killable', () => {
  const source = fs.readFileSync(extensionPath, 'utf8');
  const spawns = source.match(/(?<![\w.])execFile\(/g) || [];
  const tracked = source.match(/trackChild\(execFile\(/g) || [];
  assert.equal(spawns.length, 4, 'the four known spawn sites');
  assert.equal(tracked.length, 4, 'each one retained via trackChild, or deactivate cannot kill it');
});

test('a gate refresh cannot rewrite the instruction files after deactivate', async (t) => {
  const home = tempHome(t);
  const userText = '# My global instructions\n\nAlways use the toolbox python.\n';
  const claudeMd = path.join(home, '.claude', 'CLAUDE.md');
  fs.writeFileSync(claudeMd, userText);
  fs.writeFileSync(
    path.join(home, '.claude', 'gates.generated.md'),
    '## Standing gates (1 memories, managed)\n\n- **File edits.** Apply directly.\n');

  const app = harness(home, { settings: { 'gates.enabled': true } });
  try {
    // Precondition: this is a live gates install, so a post-deactivate write is
    // something the guard prevents rather than something nothing was doing.
    assert.notEqual(fs.readFileSync(claudeMd, 'utf8'), userText,
      'activation installed the managed block');

    fs.writeFileSync(claudeMd, userText);
    await app.extension.deactivate();

    // The compiled-gates watcher is the reachable half of the worst of the four:
    // the compile callback lands here too, and this is what writes.
    app.watcherFor('gates.generated.md').fire('change', { fsPath: 'gates.generated.md' });
    assert.equal(fs.readFileSync(claudeMd, 'utf8'), userText,
      'a torn-down extension must not touch the user\'s instruction file');
  } finally {
    await app.dispose();
  }
});

test('the Auto Learn busy latch does not survive a teardown', async (t) => {
  const home = tempHome(t);
  const app = harness(home, { settings: { 'autoLearn.enabled': true } });
  try {
    // Deactivate with a scan in flight. The latch is set synchronously and the
    // scan then yields, which is the window a reload lands in.
    const inFlight = app.commands.get('permission-wildcarding.autoLearnScan')();
    await app.extension.deactivate();

    app.reactivate();
    app.statuses.length = 0;

    // Deliberately not awaited before the assertion: "already running" is
    // emitted synchronously, and letting the abandoned scan settle first would
    // clear the latch for us and hide the defect.
    const second = app.commands.get('permission-wildcarding.autoLearnScan')();
    assert.ok(!app.statuses.some((message) => message.includes('already running')),
      'the busy latch did not survive the teardown');

    await second;
    await inFlight;
  } finally {
    await app.dispose();
  }
});

test('a same-realm re-activate gets a fresh Auto Learn worker runner', async (t) => {
  const home = tempHome(t);
  const app = harness(home, { settings: { 'autoLearn.enabled': true } });
  try {
    // A completed scan, so the runner instance exists and deactivate really
    // drains and flags it — `deactivating` is sticky and {run, deactivate,
    // stats} offers no way back.
    await app.commands.get('permission-wildcarding.autoLearnScan')();
    await app.extension.deactivate();

    app.reactivate();
    app.errors.length = 0;
    app.infos.length = 0;
    await app.commands.get('permission-wildcarding.autoLearnScan')();

    assert.ok(!app.errors.some((message) => /deactivating/.test(message)),
      'a retained runner rejects every later operation, forever');
    assert.ok(app.infos.some((message) => message.startsWith('Auto Learn:')),
      'the scan after re-activation actually ran');
  } finally {
    await app.dispose();
  }
});
