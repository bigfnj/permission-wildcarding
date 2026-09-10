'use strict';

// End to end through the real Review command handler, not the wording helpers.
// A managed ask outranks any grant written from here, so those families are
// withheld from the picker; withholding them silently left the prompts
// unexplained. Twice in this repo's history a green unit suite sat alongside a
// feature that was broken in the extension, so this drives the command itself.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const { createAutoLearnManager } = require('../src/auto-learn-manager');

function disposable() { return { dispose() {} }; }

const MANAGED = {
  permissions: {
    ask: ['Bash(curl:*)', 'Bash(git push:*)'],
    allow: [],
    deny: [],
  },
};

test('the Review command names families a managed rule blocks, and offers the detail', async () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'permission-wildcarding-blocked-'));
  const workspaceRoot = path.join(tempHome, 'workspace');
  fs.mkdirSync(path.join(tempHome, '.claude'), { recursive: true });
  fs.mkdirSync(workspaceRoot, { recursive: true });
  fs.writeFileSync(path.join(tempHome, '.claude', 'remote-settings.json'),
    JSON.stringify(MANAGED, null, 2));
  // A grant the user already wrote that the managed ask outranks.
  fs.writeFileSync(path.join(tempHome, '.claude', 'settings.json'),
    `${JSON.stringify({ permissions: { allow: ['Bash(curl *)'] } }, null, 2)}\n`);

  // State is partitioned per workspace, so ask the manager where its file goes
  // rather than guessing the hash in the name.
  const statePath = createAutoLearnManager({
    home: tempHome, workspaceRoot, threshold: 3, codexRulesPath: null,
  }).status().paths.state;
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  const family = (key, tokens, permission, runs) => ({
    key, tool: 'Bash', kind: 'shell', shell: 'bash', root: tokens[0], prefix: tokens,
    claudePermission: permission, risk: 'read-only', baseAutoSafe: false, complex: false,
    reasons: ['known-read-only-command'], sources: ['claude'],
    counts: { success: runs, failed: 0, unknown: 0, total: runs },
  });
  fs.writeFileSync(statePath, `${JSON.stringify({
    version: 1, mode: 'recommend', threshold: 3,
    candidates: {
      'bash:curl': family('bash:curl', ['curl'], 'Bash(curl *)', 55),
      // One run, so the singular is exercised through the real command too.
      'bash:git push': family('bash:git push', ['git', 'push'], 'Bash(git push *)', 1),
    },
    observationHashes: {}, cursors: {},
    applied: { claude: [], codex: [] }, reviewed: { claude: [], codex: [] },
    codexTargets: {}, managedClaude: {}, lastScanAt: null, lastScanStats: null, lastApplication: null,
  }, null, 2)}\n`);

  const commands = new Map();
  const infos = [];
  const channelLines = [];
  let shown = false;
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
      createOutputChannel() {
        return {
          appendLine(line) { channelLines.push(line); },
          // Real OutputChannel API, and the report path now uses it. Modelled
          // faithfully rather than stubbed empty, or this mock would report a
          // channel that grows forever while the product's does not.
          clear() { channelLines.length = 0; },
          show() { shown = true; },
          dispose() {},
        };
      },
      registerWebviewViewProvider() { return disposable(); },
      setStatusBarMessage() {},
      showErrorMessage() {},
      // The handler chains .then on this, so it must be thenable. Answering
      // with the action label is what exercises the detail path.
      showInformationMessage(message, ...actions) {
        infos.push({ message, actions });
        return Promise.resolve(actions.includes('Show blocked') ? 'Show blocked' : undefined);
      },
      showWarningMessage() {},
      showQuickPick() { return Promise.resolve(undefined); },
    },
    workspace: {
      isTrusted: true,
      workspaceFolders: [{ uri: { fsPath: workspaceRoot } }],
      createFileSystemWatcher() {
        return { onDidChange() {}, onDidCreate() {}, onDidDelete() {}, dispose() {} };
      },
      getConfiguration() {
        return {
          // Codex off keeps the run to the Claude half, which is the half a
          // managed policy governs.
          get: (key, fallback) => (key === 'autoLearn.codexScope' ? 'off' : fallback),
          inspect: () => ({}), update: async () => {},
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

  let extension;
  try {
    delete require.cache[extensionPath];
    extension = require(extensionPath);
    extension.activate({ subscriptions: [] });
    await commands.get('permission-wildcarding.autoLearnReview')();

    // Both families are inert, so the picker has nothing to offer and the old
    // build said only "no candidates are ready for review".
    const last = infos.at(-1);
    assert.ok(last, 'the Review command reported something');
    assert.match(last.message, /2 blocked by managed policy/);
    assert.deepEqual(last.actions, ['Show blocked'],
      'the detail has to be reachable, not just counted');

    // The action was answered, so the output channel carries the detail and
    // names the managed rule that wins.
    assert.equal(shown, true, 'the channel is revealed, not written to in silence');
    const detail = channelLines.join('\n');
    assert.match(detail, /Bash\(curl \*\) — 55 successful runs — managed ask: Bash\(curl:\*\)/);
    assert.match(detail, /Bash\(git push \*\) — 1 successful run — managed ask: Bash\(git push:\*\)/);
    assert.doesNotMatch(detail, /1 successful runs/);
    // And the dead grant already sitting in settings.json.
    assert.match(detail, /Allow entries already in your settings/);
    assert.match(detail, /Bash\(curl \*\) — managed ask: Bash\(curl:\*\)/);

    // Reporting is not deleting: the entry is still in the user's file.
    const settings = JSON.parse(fs.readFileSync(path.join(tempHome, '.claude', 'settings.json'), 'utf8'));
    assert.deepEqual(settings.permissions.allow, ['Bash(curl *)']);

    // The standalone command is the real fix. Hanging the detail off the
    // "no candidates" toast made it unreachable in the only situation that
    // matters: a busy review list on a machine that keeps getting prompted.
    // It must produce the same detail with no dependence on Review's state.
    // Deliberately NOT clearing channelLines by hand any more: the report path
    // calls OutputChannel.clear() itself now, and that is the thing worth
    // asserting. The channel is shared and these are palette actions with no
    // call limit, so without it the second report lands underneath the first
    // and the reader scrolls past stale output to reach what they just asked
    // for. A hand-reset here would hide exactly that.
    shown = false;
    assert.equal(commands.has('permission-wildcarding.autoLearnShowBlocked'), true,
      'the command is registered, or the picker title names something unrunnable');
    await commands.get('permission-wildcarding.autoLearnShowBlocked')();
    assert.equal(shown, true);
    const direct = channelLines.join('\n');
    assert.match(direct, /Bash\(curl \*\) — 55 successful runs — managed ask: Bash\(curl:\*\)/);
    assert.match(direct, /Bash\(git push \*\) — 1 successful run — managed ask: Bash\(git push:\*\)/);
    // One copy, not two. This is the assertion the channel-count test could
    // never make: collapsing to a single shared channel fixed the disposal
    // leak and replaced it with an unbounded document.
    assert.equal(
      channelLines.filter((line) => /Bash\(curl \*\) — 55 successful runs/.test(line)).length, 1,
      'the second report must replace the first, not accumulate beneath it',
    );
  } finally {
    // deactivate() has to run even when an assertion above throws. activate()
    // starts interval timers, and leaving them alive keeps the test process up
    // long past the failure: a red run then looks like a hang instead of a
    // failure, which is the worst way for CI to report a broken build.
    try { await extension?.deactivate(); } catch {}
    Module._load = originalLoad;
    delete require.cache[extensionPath];
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});
