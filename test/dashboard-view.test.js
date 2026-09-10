'use strict';

// The dashboard had no tests at all. It is the extension's whole UI — 18 message
// cases, a 15-helper work-up run on every one of ~35 refresh() call sites, and a
// hide/show identity check that decides whether the panel keeps working — and
// none of it was reachable from a test, because nothing ever called
// resolveWebviewView.
//
// It does not need a production export to become reachable:
// registerWebviewViewProvider(viewId, dashboard) is handed the live instance and
// every existing mock throws argument 2 away. Capturing it is the whole unlock.
// The view VS Code would pass is seven members wide (below), and _html() never
// touches its `webview` argument, so there is no asWebviewUri/cspSource to fake.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

function disposable() { return { dispose() {} }; }

// Longer than DASHBOARD_BOUNCE_MS: refresh() is debounced like every other
// handler in the extension, so a push lands on the next tick, not this one.
function settle(ms = 140) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Copied from test/policy-backup.test.js rather than shared. That is a standing
// decision in this suite (test/extension-activation.test.js:113-116: "Kept as its
// own mock rather than sharing the one above… duplicating a mock is far cheaper
// than breaking the activation test that already works"), and this file needs two
// things that one does not: the provider instance, and a count of how many times
// the quadratic allow-list pass runs.
function harness(tempHome) {
  const commands = new Map();
  const executed = [];
  const passes = { count: 0 };
  const settingsPath = path.join(tempHome, '.claude', 'settings.json');
  // One directive per read of settings.json, consumed in order, then
  // pass-through. Armed by a test via app.arm(); empty for every other test, so
  // reads go straight to disk.
  const reads = [];
  let provider = null;
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
      executeCommand(id) { executed.push(id); },
    },
    window: {
      createStatusBarItem() { return { hide() {}, show() {}, dispose() {} }; },
      registerWebviewViewProvider(_viewId, instance) { provider = instance; return disposable(); },
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
          // Auto Learn off: this is about the panel, not the learner.
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
  const settingsWritePath = require.resolve('../src/settings-write');
  const scriptedReaders = new Set([extensionPath, settingsWritePath]);
  const memoryReports = { count: 0 };
  const rootSrc = path.resolve(__dirname, '..', 'src');
  const originalLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (request === 'vscode') return vscode;
    if (request === 'os') return { ...os, homedir: () => tempHome };
    if (request === 'fs' && scriptedReaders.has(parent?.filename)) {
      // A seam for one specific, routine failure: Claude Code rewrites
      // settings.json in place on every approval, /model and /effort, so two
      // reads taken moments apart do not have to agree, and the second one can
      // land inside a write.
      //
      // Both modules on the write path are scripted, because the path spans two:
      // removeAllowEntry reads in extension.js, then writeAllow re-reads in
      // src/settings-write.js to rebase onto the newest copy. Scripting only the
      // extension's reads left the SECOND one hitting the real disk, so the
      // "write failed" precondition silently could not happen and the test
      // asserted nothing. Only readFileSync is replaced — writeFileAtomicSync
      // keeps the real fs, so the writes under test are genuine.
      const realFs = originalLoad.call(this, 'fs', parent, isMain);
      return {
        ...realFs,
        readFileSync(file, ...rest) {
          if (file === settingsPath && reads.length && reads.shift() === 'corrupt') {
            return '{ not json';
          }
          return realFs.readFileSync(file, ...rest);
        },
      };
    }
    if (parent?.filename === extensionPath && request === './src/permissions') {
      // Counted, not replaced. processAllowList is the expensive half of the
      // dashboard work-up (quadratic; ~57ms on the 423-entry list this was built
      // for) and it used to run twice per settings write — once in
      // runWildcarding, once again in the refresh that immediately followed.
      const real = originalLoad.call(this, path.join(rootSrc, 'permissions.js'), parent, isMain);
      return {
        ...real,
        processAllowList: (list) => { passes.count += 1; return real.processAllowList(list); },
      };
    }
    if (parent?.filename === extensionPath && request.startsWith('./src/')) {
      return originalLoad.call(this, path.join(rootSrc, request.slice('./src/'.length)), parent, isMain);
    }
    if (request === './memoryLint' && parent?.filename === extensionPath) {
      return {
        MemoryLint: class MemoryLint { activate() {} },
        // COUNTED, not just stubbed. The real memoryReport is 6.99 ms and 25 fs
        // syscalls against a live corpus, and _push used to call it twice for two
        // cards that need disjoint parts of one result. How many times it is
        // called is the whole property, and nothing else in the suite can see it.
        memoryReport: () => {
          memoryReports.count += 1;
          return { conf: {}, dir: null, report: null, gateSources: undefined };
        },
        discoverDirs: () => [],
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  // Drop every cached shared module as well as the extension, so each one is
  // re-required under the mocked `os` and the scripted `fs` above. A module that
  // captured either at first load keeps the FIRST test's temp home and the real
  // fs for the rest of the file — which is how the scripted 'corrupt' read
  // silently stopped reaching writeAllow's re-read once that moved into src/,
  // leaving the failure this test exists to check unable to happen.
  // local-drain-extension.test.js already does this, for the same reason.
  delete require.cache[extensionPath];
  for (const cached of Object.keys(require.cache)) {
    if (cached.startsWith(rootSrc + path.sep)) delete require.cache[cached];
  }
  const extension = require(extensionPath);
  extension.activate({ subscriptions: [] });
  return {
    commands,
    executed,
    extension,
    memoryReports,
    passes,
    arm(plan) { reads.length = 0; reads.push(...plan); },
    get provider() { return provider; },
    async dispose() {
      await extension.deactivate();
      Module._load = originalLoad;
      delete require.cache[extensionPath];
    },
  };
}

function setup(t) {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'permission-wildcarding-dashboard-'));
  fs.mkdirSync(path.join(tempHome, '.claude'), { recursive: true });
  t.after(() => fs.rmSync(tempHome, { recursive: true, force: true }));
  const settingsPath = path.join(tempHome, '.claude', 'settings.json');
  return {
    tempHome,
    settingsPath,
    write: (value) => fs.writeFileSync(settingsPath, JSON.stringify(value, null, 2) + '\n'),
    read: () => JSON.parse(fs.readFileSync(settingsPath, 'utf8')),
  };
}

// Exactly the seven members resolveWebviewView touches, and nothing else — so a
// new dependency on the real WebviewView API shows up here as a TypeError rather
// than as a silent pass.
function fakeView() {
  const posted = [];
  const on = {};
  const view = {
    visible: true,
    webview: {
      options: null,
      html: null,
      onDidReceiveMessage(cb) { on.message = cb; return disposable(); },
      postMessage(payload) { posted.push(payload); return Promise.resolve(true); },
    },
    onDidDispose(cb) { on.dispose = cb; return disposable(); },
    onDidChangeVisibility(cb) { on.visibility = cb; return disposable(); },
  };
  return { view, posted, on };
}

// Fifteen already-generalized families, so the wildcarding pass leaves them
// alone and the list on disk is the list under test. Three more than the cap.
const NATO = [
  'alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel',
  'india', 'juliett', 'kilo', 'lima', 'mike', 'november', 'oscar',
];
const FIFTEEN = NATO.map((word) => `Bash(${word} *)`);

test('resolveWebviewView wires the webview and pushes one debounced payload', async (t) => {
  const env = setup(t);
  env.write({ permissions: { allow: ['Bash(git status *)'], deny: [] } });
  const app = harness(env.tempHome);
  try {
    const ui = fakeView();
    app.provider.resolveWebviewView(ui.view);

    assert.deepEqual(ui.view.webview.options, { enableScripts: true });
    assert.ok(ui.view.webview.html.startsWith('<!DOCTYPE html>'), 'the panel document is assigned');
    assert.equal(ui.posted.length, 0, 'the push is debounced, not synchronous');

    await settle();
    assert.equal(ui.posted.length, 1);
    const data = ui.posted[0];
    assert.equal(data.type, 'data');
    assert.equal(data.active, true);
    assert.equal(data.total, 1);
    assert.deepEqual(data.wildcards, ['Bash(git status *)']);
    assert.equal(data.wildcardCount, 1);
    assert.equal(data.specificCount, 0);
    assert.equal(data.pendingWildcard, 0, 'an already-optimal list badges no pending work');
    // The two helpers that need real bytes on disk; the other thirteen collapse
    // to null/0 under this harness, which is why it can stay this small.
    assert.equal(data.backupCount, 1, 'activation captured the live list into the backup');
    assert.ok(data.settingsPath.endsWith(path.join('.claude', 'settings.json')));
  } finally {
    await app.dispose();
  }
});

test('every dashboard message reaches its command, and nothing else does', async (t) => {
  const env = setup(t);
  env.write({ permissions: { allow: ['Bash(git status *)'], deny: [] } });
  const app = harness(env.tempHome);
  try {
    const ui = fakeView();
    app.provider.resolveWebviewView(ui.view);
    await settle();

    const routes = [
      ['runNow', 'permission-wildcarding.runNow'],
      ['restore', 'permission-wildcarding.restoreBackup'],
      ['autoLearnScan', 'permission-wildcarding.autoLearnScan'],
      ['autoLearnReview', 'permission-wildcarding.autoLearnReview'],
      ['autoLearnApply', 'permission-wildcarding.autoLearnApplySafe'],
      ['autoLearnUndo', 'permission-wildcarding.autoLearnUndo'],
      ['autoLearnMode', 'permission-wildcarding.autoLearnCycleMode'],
      ['autoLearnWhy', 'permission-wildcarding.autoLearnWhy'],
      ['toggleMax', 'permission-wildcarding.toggleMax'],
      ['toggleCodexMax', 'permission-wildcarding.toggleCodexMax'],
      ['rebuildRecall', 'permission-wildcarding.rebuildRecall'],
      ['lintMemory', 'permission-wildcarding.lintMemory'],
      ['drainLocal', 'permission-wildcarding.drainLocal'],
      ['toggleGuidance', 'permission-wildcarding.toggleGuidance'],
      ['toggleGates', 'permission-wildcarding.toggleGates'],
      ['showWildcards', 'permission-wildcarding.showWildcards'],
    ];
    for (const [type, command] of routes) {
      app.executed.length = 0;
      ui.on.message({ type });
      assert.deepEqual(app.executed, [command], `${type} routes to ${command}`);
    }

    // A route added to the switch without a row above would otherwise ship
    // untested — the panel's buttons are the only way most of these are reached.
    const source = fs.readFileSync(require.resolve('../vscode-extension/extension'), 'utf8');
    const cases = source.match(/case '[A-Za-z]+':\s*vscode\.commands\.executeCommand\(/g) || [];
    assert.equal(cases.length, routes.length, 'every executeCommand case in the switch is covered');

    // The two that are handled in-process rather than dispatched.
    app.executed.length = 0;
    ui.posted.length = 0;
    ui.on.message({ type: 'refresh' });
    await settle();
    assert.deepEqual(app.executed, [], 'refresh is handled here, not dispatched');
    assert.equal(ui.posted.length, 1);

    ui.on.message({ type: 'remove', value: 'Bash(git status *)' });
    await settle();
    assert.deepEqual(env.read().permissions.allow, [], 'remove prunes the entry it was given');

    // Junk and absent types must not dispatch anything.
    app.executed.length = 0;
    ui.on.message({ type: 'notAThing' });
    ui.on.message(undefined);
    assert.deepEqual(app.executed, []);
  } finally {
    await app.dispose();
  }
});

test('a hide/show race disposes the dead view, never the live one', async (t) => {
  const env = setup(t);
  env.write({ permissions: { allow: ['Bash(git status *)'], deny: [] } });
  const app = harness(env.tempHome);
  try {
    // The view is disposed on every hide (package.json does not declare
    // retainContextWhenHidden) and re-resolved on show, so a quick hide/show can
    // resolve the replacement before the first one's disposal is delivered.
    const first = fakeView();
    const second = fakeView();
    app.provider.resolveWebviewView(first.view);
    app.provider.resolveWebviewView(second.view);
    await settle();

    first.on.dispose();               // late notification for the view already replaced
    second.posted.length = 0;
    app.provider.refresh();
    await settle();
    assert.equal(second.posted.length, 1, 'the live view still receives pushes');

    // And the identity check must still let a real disposal through.
    second.on.dispose();
    app.provider.refresh();
    await settle();
    assert.equal(second.posted.length, 1, 'a disposed view stops receiving pushes');
  } finally {
    await app.dispose();
  }
});

test('with no live view there is no push and no work-up', async (t) => {
  const env = setup(t);
  env.write({ permissions: { allow: FIFTEEN, deny: [] } });
  const app = harness(env.tempHome);
  try {
    // Never resolved: refresh() must not even reach processAllowList, because
    // ~35 call sites — several of them file-watcher callbacks — fire while the
    // sidebar is collapsed.
    const before = app.passes.count;
    app.provider.refresh();
    await settle();
    assert.equal(app.passes.count, before, 'the whole work-up is skipped, not just the post');

    const ui = fakeView();
    app.provider.resolveWebviewView(ui.view);
    await settle();
    assert.equal(ui.posted.length, 1);

    ui.on.dispose();
    const after = app.passes.count;
    app.provider.refresh();
    await settle();
    assert.equal(ui.posted.length, 1, 'postMessage is not called once the view is gone');
    assert.equal(app.passes.count, after);
  } finally {
    await app.dispose();
  }
});

test('one push per burst, and the wildcarding pass is not repeated for it', async (t) => {
  const env = setup(t);
  env.write({ permissions: { allow: FIFTEEN, deny: [] } });
  const app = harness(env.tempHome);
  try {
    const ui = fakeView();
    app.provider.resolveWebviewView(ui.view);
    await settle();

    // runWildcarding computes processAllowList and hands the result over; the
    // refresh that follows must not compute the identical value a second time.
    ui.posted.length = 0;
    let before = app.passes.count;
    await app.commands.get('permission-wildcarding.runNow')();
    await settle();
    assert.equal(app.passes.count - before, 1, 'one pass per settings write, not two');
    assert.equal(ui.posted.length, 1);
    assert.equal(ui.posted[0].pendingWildcard, 0);
    assert.equal(ui.posted[0].wildcardCount, FIFTEEN.length);

    // A watcher pair (onDidChange + onDidCreate) fires together, and several
    // call sites refresh twice for one event. One push.
    ui.posted.length = 0;
    for (let i = 0; i < 5; i += 1) app.provider.refresh();
    await settle();
    assert.equal(ui.posted.length, 1, 'the burst coalesces into a single push');

    // A hint is only a shortcut while it still describes the file. If something
    // wrote settings.json in between, the pass runs for real rather than
    // rendering a badge against a list that is no longer there.
    ui.posted.length = 0;
    before = app.passes.count;
    app.provider.refresh({ allow: ['Bash(stale *)'], optimized: ['Bash(stale *)'] });
    await settle();
    assert.equal(app.passes.count - before, 1, 'a stale hint is recomputed, not trusted');
    assert.deepEqual(ui.posted[0].wildcards, [...FIFTEEN].sort());
  } finally {
    await app.dispose();
  }
});

test('a prune whose settings write fails keeps its backup cover', async (t) => {
  const env = setup(t);
  env.write({ permissions: { allow: ['Bash(git status *)', 'Bash(rg *)'], deny: [] } });
  const app = harness(env.tempHome);
  const backupPath = path.join(env.tempHome, '.claude', 'backups', 'allow-list.latest.json');
  const backup = () => JSON.parse(fs.readFileSync(backupPath, 'utf8'));
  try {
    const ui = fakeView();
    app.provider.resolveWebviewView(ui.view);
    await settle();
    assert.ok(backup().allow.includes('Bash(rg *)'), 'precondition: the backup holds the entry');

    // removeAllowEntry reads settings.json, then writeAllow reads it again to
    // rebase onto the newest copy — and that second read throws
    // SETTINGS_UNREADABLE whenever it lands inside one of Claude Code's in-place
    // rewrites, which is every approval. Pruning the backup before the write
    // meant the entry stayed live in settings.json with its only copy gone from
    // the high-water mark, so a later wipe could not restore it.
    app.arm(['ok', 'corrupt']);
    ui.on.message({ type: 'remove', value: 'Bash(rg *)' });
    await settle();

    assert.ok(env.read().permissions.allow.includes('Bash(rg *)'),
      'precondition: the write failed, so the entry is still live in settings.json');
    assert.ok(backup().allow.includes('Bash(rg *)'),
      'a prune that never landed must not take the entry out of the backup');

    // And the successful prune still forgets, or the guard reports the user's own
    // instruction as damage forever.
    ui.on.message({ type: 'remove', value: 'Bash(rg *)' });
    await settle();
    assert.ok(!env.read().permissions.allow.includes('Bash(rg *)'));
    assert.ok(!backup().allow.includes('Bash(rg *)'), 'a prune that landed leaves the backup');
  } finally {
    await app.dispose();
  }
});

// ── the webview document ───────────────────────────────────────────────────────

// _html() returns one JS template literal, and a single backtick anywhere inside
// it — in a comment, in a string, anywhere — ends the literal and breaks the
// file. That has happened three times. node --check does not always catch it
// (the result can still parse), so count them.
test('the panel template contains no backtick that would end it early', () => {
  const lines = fs.readFileSync(require.resolve('../vscode-extension/extension'), 'utf8').split(/\r?\n/);
  const start = lines.findIndex((line) => line.includes('return `<!DOCTYPE html>'));
  const end = lines.findIndex((line, index) => index > start && line.trim() === '</html>`;');
  assert.ok(start > 0, 'the template still starts with a tagged <!DOCTYPE html> line');
  assert.ok(end > start, 'the template still ends with a </html> line');
  const offenders = [];
  for (let index = start + 1; index < end; index += 1) {
    if (lines[index].includes('`')) offenders.push(`${index + 1}: ${lines[index].trim()}`);
  }
  assert.deepEqual(offenders, [], 'no backticks between the template delimiters');
});

// The cap and the "and N more" affordance are the only dashboard logic that
// lives in the webview script rather than in a method, so run the script the way
// the webview would: a DOM thin enough to read in one screen, fed the exact
// payload resolveWebviewView pushed.
function fakeDom() {
  const byId = new Map();
  const make = (tag) => {
    const element = {
      tag,
      children: [],
      listeners: {},
      dataset: {},
      style: {},
      classList: { toggle() {} },
      className: '',
      textContent: '',
      title: '',
      innerHTML: '',
      hidden: false,
      appendChild(child) { element.children.push(child); return child; },
      addEventListener(name, callback) {
        (element.listeners[name] || (element.listeners[name] = [])).push(callback);
      },
      click() {
        for (const callback of element.listeners.click || []) callback({ preventDefault() {} });
      },
      querySelector() { return null; },
      querySelectorAll() { return []; },
    };
    return element;
  };
  const document = {
    getElementById(id) {
      if (!byId.has(id)) byId.set(id, make('#' + id));
      return byId.get(id);
    },
    createElement: make,
    querySelectorAll() { return []; },
  };
  return { document, byId };
}

function runPanelScript(html) {
  const opening = html.indexOf('<script nonce=');
  const body = html.slice(html.indexOf('>', opening) + 1, html.indexOf('</script>', opening));
  const dom = fakeDom();
  const posted = [];
  const listeners = {};
  const api = {
    getState: () => ({}),
    setState: () => {},
    postMessage: (payload) => posted.push(payload),
  };
  const win = {
    addEventListener(name, callback) {
      (listeners[name] || (listeners[name] = [])).push(callback);
    },
  };
  // eslint-disable-next-line no-new-func
  new Function('acquireVsCodeApi', 'document', 'window', body)(() => api, dom.document, win);
  return {
    dom,
    posted,
    deliver(data) { for (const callback of listeners.message || []) callback({ data }); },
  };
}

test('the sidebar renders twelve wildcards and defers the rest to the picker', async (t) => {
  const env = setup(t);
  env.write({ permissions: { allow: FIFTEEN, deny: [] } });
  const app = harness(env.tempHome);
  try {
    const ui = fakeView();
    app.provider.resolveWebviewView(ui.view);
    await settle();

    const panel = runPanelScript(ui.view.webview.html);
    assert.deepEqual(panel.posted, [{ type: 'refresh' }], 'the panel asks for its first payload');
    panel.deliver(ui.posted[0]);

    const rows = panel.dom.byId.get('list').children;
    assert.equal(rows.length, 13, 'twelve entries plus one deferral row');

    const shown = rows.slice(0, 12).map((row) => row.children[0].textContent);
    assert.deepEqual(shown, [...FIFTEEN].sort().slice(0, 12));

    const more = rows[12];
    assert.equal(more.className, 'more');
    assert.equal(more.textContent, 'and 3 more — search all 15 →');

    // The deferral opens the QuickPick, and each row's ✕ prunes that entry.
    panel.posted.length = 0;
    more.click();
    rows[0].children[1].click();
    assert.deepEqual(panel.posted, [
      { type: 'showWildcards' },
      { type: 'remove', value: [...FIFTEEN].sort()[0] },
    ]);
  } finally {
    await app.dispose();
  }
});

// The memory report is the most expensive thing one push does: measured 6.99 ms
// and 25 fs syscalls (12 readFileSync + 11 existsSync + 2 readdirSync) against a
// live corpus. _push called it TWICE — once for the Memory card, once for a
// one-integer `gateSources` lookup in the Gates card that the first call had
// already computed. Two calls measured 9.92 ms, so the duplicate cost 2.93 ms of
// every refresh, and a refresh fires on every settings.json change.
//
// This is the only assertion in the suite that can see it. Every other test stubs
// memoryReport and ignores how often it is called, and no test exercises the real
// one from this path at all — so without a count, reverting the hoist is silent.
test('one push computes the memory report once, not once per card that needs it', async (t) => {
  const { tempHome, write } = setup(t);
  write({ permissions: { allow: ['Bash(git status *)'] } });
  const app = harness(tempHome);
  try {
    const ui = fakeView();
    app.provider.resolveWebviewView(ui.view);
    await settle();

    assert.equal(ui.posted.length, 1, 'one debounced push, so the count below is per-push');
    assert.equal(app.memoryReports.count, 1,
      'the Memory card and the Gates card must share one report, not take one each');

    // And the value actually reaches both consumers. A hoist that threaded the
    // report into only one card would still count 1 while the other silently
    // called nothing and rendered wrong.
    const data = ui.posted[0];
    assert.ok('memory' in data, 'the memory card key is present');
    assert.ok('gates' in data, 'the gates card key is present');

    // A second push recomputes: the corpus can change between renders, so the
    // report is per-push and must NOT be memoised across pushes.
    app.provider.refresh();
    await settle();
    assert.equal(ui.posted.length, 2);
    assert.equal(app.memoryReports.count, 2,
      'per-push, not cached forever — a corpus edit between renders must be seen');
  } finally {
    await app.dispose();
  }
});

// Two hero-card facts, both of which were wrong or absent in a shipped build.
//
// The gate count read `text.match(/^- \*\*/gm)`, assuming every compiled gate
// opens with a bold lead-in. True of the pre-2026-09-09 corpus and of nothing
// since — so with five gates installed the card rendered "0 active" directly
// beside an ON state. The authoritative count is in the header recall.py writes.
// The identical regex shipped in scripts/verify-release.ps1 and reported
// "0 gate(s)" for the same file, so this is a defect that occurred twice.
//
// The version was not shown at all, which is what makes "is my fix actually
// installed" cost a trip to the Extensions view. That question came up repeatedly
// while this project was being built.
test('the hero card reports the running version and a gate count that does not depend on prose', async (t) => {
  const env = setup(t);
  env.write({ permissions: { allow: ['Bash(git status *)'], deny: [] } });

  // A compiled gates file whose bullets are PLAIN, i.e. the shape the current
  // compiler emits. Under the old regex this counts as zero.
  const gatesFile = path.join(env.tempHome, '.claude', 'gates.generated.md');
  fs.writeFileSync(gatesFile,
    '<!-- generated by recall.py --gates-compile; sha deadbeefdeadbeef -->\n'
    + '## Standing gates (3 memories, managed)\n\n'
    + '- first standing order, no bold anywhere\n'
    + '- second standing order\n'
    + '- third standing order\n');

  const app = harness(env.tempHome);
  try {
    const ui = fakeView();
    app.provider.resolveWebviewView(ui.view);
    await settle();

    const data = ui.posted[0];
    assert.equal(data.gates.count, 3,
      'counted from the header, not from how the gates happen to be worded');
    // Mutation-checked against the SHIPPED implementation: restoring
    // `/^- \*\*/gm` makes this fail with 0. Note what it does NOT distinguish —
    // this fixture has three plain bullets, so the header parse and the
    // bullet-count fallback both answer 3. That is deliberate: the fallback
    // exists for an older compiled file with no header, and contriving a case
    // where the two disagree would mean asserting against output the compiler
    // cannot produce.

    // The version comes from the manifest beside extension.js, which resolves both
    // in the repo and inside the packaged VSIX.
    const expected = require('../vscode-extension/package.json').version;
    assert.equal(data.version, expected, 'the payload carries the running version');
    assert.match(data.version, /^\d+\.\d+\.\d+$/, 'and it is a real semver, not a placeholder');
  } finally {
    await app.dispose();
  }
});
