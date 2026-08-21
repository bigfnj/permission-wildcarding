'use strict';

// The local drain moves a project's approvals up to user scope. Two properties
// carry the whole safety argument, and both are tested here:
//
//   1. Only a *portable* command family is promoted. A script blob, an
//      absolute-path executable or an MCP tool means nothing outside this
//      checkout, so it stays local.
//   2. A local entry is removed only when the live user-scope file grants it.
//      Coverage is read back from disk after the write, never assumed from the
//      list this pass intended to write — so a failed or filtered promotion
//      cannot revoke a permission the project already had.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  promotionFor, planPromotions, partitionLocal, redundantUnder, drainLocalSettings,
  localSettingsPath, localBackupPath,
} = require('../src/local-settings');

function scratch() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-local-'));
  return {
    root,
    backupDir: path.join(root, 'backups'),
    workspace: path.join(root, 'project'),
    writeLocal(settings) {
      const file = localSettingsPath(path.join(root, 'project'));
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n', 'utf8');
      return file;
    },
    readLocal() {
      return JSON.parse(fs.readFileSync(localSettingsPath(path.join(root, 'project')), 'utf8'));
    },
  };
}

// A user-scope stand-in that behaves like the real file: what you write is what
// the next read returns.
function userScope(allow = [], deny = []) {
  const state = { permissions: { allow: [...allow], deny: [...deny] } };
  return {
    state,
    readUserSettings: () => JSON.parse(JSON.stringify(state)),
    applyUserAllow: (entries) => { state.permissions.allow.push(...entries); },
  };
}

test('only a portable command family is promotable', () => {
  const promotable = {
    'Bash(rg --version)': 'Bash(rg *)',
    'Bash(git status)': 'Bash(git status *)',           // dispatcher keeps its subcommand
    'Bash(msbuild App.sln /t:Rebuild)': 'Bash(msbuild *)',
    'PowerShell(Get-LocalUser -Name x)': 'PowerShell(Get-LocalUser *)',
    'Bash(python *)': 'Bash(python *)',                 // already generalized
    'Bash(rg:*)': 'Bash(rg:*)',                         // colon form Claude Code also writes
    'Bash(PYTHONUTF8=1 python -c x)': 'Bash(python *)', // env prefixes are stripped
  };
  for (const [entry, expected] of Object.entries(promotable)) {
    assert.equal(promotionFor(entry), expected, entry);
  }

  const local = [
    'Bash(npm run test:*)',                                 // already a scoped prefix, not a root
    'PowerShell($x = 1; if ($x) { Write-Output "hi" })',    // script blob — no single root
    'PowerShell(& "C:\\Program Files\\App\\app.exe" --v)',  // call operator: arbitrary program
    'Bash(./build.sh)',                                     // relative path, this checkout only
    'Bash(/usr/local/bin/tool run)',                        // absolute path
    'Bash(C:/Users/me/.venv/Scripts/python.exe -c x)',      // windows path
    'Bash(for f in *.txt)',                                 // shell keyword, not a command
    'mcp__github__create_issue',                            // opaque by construction
    'WebFetch(domain:example.com)',                         // network family, review-only
    'Read(/etc/hosts)', 'Edit', 'Write', 'WebSearch',       // file/tool families
    'Skill(dataviz)',
  ];
  for (const entry of local) assert.equal(promotionFor(entry), null, entry);
  assert.equal(promotionFor(undefined), null);
});

test('a promotion user scope already grants is not proposed twice', () => {
  const { promote } = planPromotions({
    localAllow: ['Bash(git status)', 'Bash(git log -5)', 'Bash(rg pattern)', 'Bash(jq .)'],
    userAllow: ['Bash(rg *)', 'Bash(jq *)'],
  });
  // git status/log collapse to one dispatcher family; rg and jq are already granted.
  assert.deepEqual(promote, ['Bash(git status *)', 'Bash(git log *)']);
});

test('a deny rule outranks a candidate, so it is reported instead of promoted', () => {
  const { promote, denied } = planPromotions({
    localAllow: ['Bash(rm -rf build)', 'Bash(rg x)'],
    userAllow: [],
    userDeny: ['Bash(rm *)'],
  });
  assert.deepEqual(promote, ['Bash(rg *)']);
  assert.equal(denied.length, 1);
  assert.equal(denied[0].candidate, 'Bash(rm *)');
  assert.equal(denied[0].rule, 'Bash(rm *)');
});

test('pruning is coverage, not identity', () => {
  const { prune, keep } = partitionLocal(
    ['Bash(git status)', 'Bash(git status *)', 'PowerShell($x = 1; ls)'],
    ['Bash(git *)']
  );
  // Both git entries are covered by the live wildcard; the script blob is not.
  assert.deepEqual(prune, ['Bash(git status)', 'Bash(git status *)']);
  assert.deepEqual(keep, ['PowerShell($x = 1; ls)']);
});

test('an argument-less approval is redundant once its family is granted — but an env-prefixed one is not', () => {
  // `Bash(git status *)` as a glob needs the space and something after it, so the
  // bare form is not "covered"; it is still dead weight once the family is there.
  assert.equal(redundantUnder('Bash(git status)', ['Bash(git status *)']), true);
  assert.equal(redundantUnder('Bash(rg)', ['Bash(rg *)']), true);
  assert.equal(redundantUnder('Bash(git status)', ['Bash(hg *)']), false);

  // The env-prefixed entry generalizes to `Bash(python *)`, but the command it
  // grants starts with the prefix and would not match that family. Keeping it is
  // the whole reason the token check exists.
  assert.equal(redundantUnder("Bash(PYTHONUTF8=1 python -c ' *)", ['Bash(python *)']), false);
  // A path-qualified interpreter is not the `python` family either.
  assert.equal(redundantUnder('Bash(/usr/bin/python -c x)', ['Bash(python *)']), false);
});

test('a drain promotes, prunes what user scope now covers, and keeps the rest', () => {
  const box = scratch();
  box.writeLocal({
    permissions: { allow: ['Bash(git status)', 'Bash(rg x)', 'PowerShell($x = 1; ls)'] },
    enableAllProjectMcpServers: true,
  });
  const user = userScope(['Bash(rg *)']);

  const report = drainLocalSettings({
    workspaceRoot: box.workspace,
    readUserSettings: user.readUserSettings,
    applyUserAllow: user.applyUserAllow,
    backupDir: box.backupDir,
  });

  assert.deepEqual(report.promote, ['Bash(git status *)']);
  assert.deepEqual(report.promoted, ['Bash(git status *)']);
  assert.equal(report.verified, true);
  assert.deepEqual(report.pruned, ['Bash(git status)', 'Bash(rg x)']);
  assert.equal(report.kept, 1);
  assert.equal(report.changed, true);

  const after = box.readLocal();
  assert.deepEqual(after.permissions.allow, ['PowerShell($x = 1; ls)']);
  // Unrelated keys survive the rewrite.
  assert.equal(after.enableAllProjectMcpServers, true);
  // And the snapshot holds everything the project had before the drain.
  const snapshot = JSON.parse(fs.readFileSync(localBackupPath(box.workspace, box.backupDir), 'utf8'));
  assert.deepEqual(snapshot.allow, ['Bash(git status)', 'Bash(rg x)', 'PowerShell($x = 1; ls)']);
});

test('a promotion that does not land prunes nothing', () => {
  const box = scratch();
  box.writeLocal({ permissions: { allow: ['Bash(git status)'] } });
  // A user scope that silently drops writes — a failed write, or managed policy
  // filtering the entry back out. The local entry must survive.
  const swallowed = {
    readUserSettings: () => ({ permissions: { allow: [] } }),
    applyUserAllow: () => {},
  };

  const report = drainLocalSettings({
    workspaceRoot: box.workspace,
    readUserSettings: swallowed.readUserSettings,
    applyUserAllow: swallowed.applyUserAllow,
    backupDir: box.backupDir,
  });

  assert.deepEqual(report.promote, ['Bash(git status *)']);
  assert.deepEqual(report.promoted, []);
  assert.equal(report.verified, false);
  assert.deepEqual(report.pruned, []);
  assert.deepEqual(box.readLocal().permissions.allow, ['Bash(git status)']);
});

test('MAX mode blocks the drain, because its blanket wildcard covers everything', () => {
  const box = scratch();
  box.writeLocal({ permissions: { allow: ['Bash(git status)', 'PowerShell($x = 1; ls)'] } });
  const user = userScope(['Bash(*)', 'PowerShell(*)']);

  const report = drainLocalSettings({
    workspaceRoot: box.workspace,
    readUserSettings: user.readUserSettings,
    applyUserAllow: user.applyUserAllow,
    backupDir: box.backupDir,
  });

  assert.equal(report.blocked, 'max');
  assert.equal(report.changed, false);
  assert.equal(report.kept, 2);
  assert.deepEqual(box.readLocal().permissions.allow, ['Bash(git status)', 'PowerShell($x = 1; ls)']);
  assert.deepEqual(user.state.permissions.allow, ['Bash(*)', 'PowerShell(*)']);
});

test('a dry run reports the same plan and writes neither file', () => {
  const box = scratch();
  const file = box.writeLocal({ permissions: { allow: ['Bash(git status)', 'Bash(rg x)'] } });
  const before = fs.readFileSync(file, 'utf8');
  const user = userScope(['Bash(rg *)']);

  const report = drainLocalSettings({
    workspaceRoot: box.workspace,
    readUserSettings: user.readUserSettings,
    applyUserAllow: user.applyUserAllow,
    dryRun: true,
    backupDir: box.backupDir,
  });

  assert.deepEqual(report.promote, ['Bash(git status *)']);
  assert.deepEqual(report.prune, ['Bash(git status)', 'Bash(rg x)']);
  assert.equal(report.changed, true);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.deepEqual(user.state.permissions.allow, ['Bash(rg *)']);
  assert.equal(fs.existsSync(box.backupDir), false);
});

test('a project with no local file, or nothing left to move, is a clean no-op', () => {
  const box = scratch();
  const user = userScope(['Bash(git *)']);
  const options = {
    workspaceRoot: box.workspace,
    readUserSettings: user.readUserSettings,
    applyUserAllow: user.applyUserAllow,
    backupDir: box.backupDir,
  };

  const missing = drainLocalSettings(options);
  assert.equal(missing.exists, false);
  assert.equal(missing.changed, false);
  assert.equal(missing.error, null);

  box.writeLocal({ permissions: { allow: ['PowerShell(& "C:\\App\\app.exe")'] } });
  const nothing = drainLocalSettings(options);
  assert.equal(nothing.exists, true);
  assert.equal(nothing.changed, false);
  assert.equal(nothing.kept, 1);

  // And a second drain over an already-drained project changes nothing further.
  box.writeLocal({ permissions: { allow: ['Bash(git status)'] } });
  assert.equal(drainLocalSettings(options).changed, true);
  const second = drainLocalSettings(options);
  assert.equal(second.changed, false);
});
