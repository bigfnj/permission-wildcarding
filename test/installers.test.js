'use strict';

// The installers had no test of any kind — not here, not in verify-release.ps1,
// not in CI — and they are the highest-blast-radius files in the repo: they are
// the only writers of settings.json that take no lock, are not atomic, and had
// no backup. Both of them replaced the user's entire policy with nothing but
// their own hook entry, from a single unreadable read:
//
//   install.sh    `try { cfg = JSON.parse(...) } catch {}` then write cfg
//   install.ps1   `ConvertFrom-Json -AsHashtable`, which is PowerShell 6+ ONLY.
//                 Under Windows PowerShell 5.1 — the shell README names for it —
//                 it threw, the catch only warned, and $cfg stayed empty.
//
// Reproduced on 5.1.26100.7019 against a settings.json holding model,
// effortLevel, env, permissions.allow, permissions.deny and a third-party
// SessionStart hook: all six gone, exit code 0, "[OK]" printed.
//
// install.sh's embedded ES module is driven for real below. install.ps1 cannot
// be, on a POSIX CI runner, so it gets static guards against the exact two
// mistakes instead — which is worth more than nothing and runs everywhere.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');

const HEALTHY = JSON.stringify({
  model: 'claude-opus-5',
  effortLevel: 'high',
  env: { FOO: 'bar' },
  permissions: {
    allow: ['Bash(git status *)', 'Bash(rg *)', 'Read(*)'],
    deny: ['Bash(rm -rf /*)'],
  },
  hooks: {
    SessionStart: [{ hooks: [{ type: 'command', command: 'other-tool' }] }],
  },
}, null, 2) + '\n';

// The ES module install.sh feeds to `node --input-type=module` on stdin. Taken
// from the real file so the test cannot drift from what ships.
function embeddedModule() {
  const sh = fs.readFileSync(path.join(repoRoot, 'install.sh'), 'utf8');
  const start = sh.indexOf("node --input-type=module <<'EOF'");
  assert.notEqual(start, -1, 'the heredoc that carries the installer logic moved');
  const bodyStart = sh.indexOf('\n', start) + 1;
  const end = sh.indexOf('\nEOF', bodyStart);
  assert.notEqual(end, -1, 'unterminated heredoc');
  return sh.slice(bodyStart, end);
}

// Returns { code, stdout, stderr, after } — `after` being the bytes on disk.
function runInstaller(settingsPath, source) {
  let code = 0;
  let stdout = '';
  let stderr = '';
  try {
    stdout = execFileSync(process.execPath, ['--input-type=module', '-e', source], {
      env: { ...process.env, SETTINGS: settingsPath, HOOK_CMD: '/repo/bin/wildcard-perms' },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    code = typeof error.status === 'number' ? error.status : 1;
    stdout = error.stdout || '';
    stderr = error.stderr || '';
  }
  const after = fs.existsSync(settingsPath) ? fs.readFileSync(settingsPath, 'utf8') : null;
  return { code, stdout, stderr, after };
}

function sandbox(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-installer-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  return path.join(dir, '.claude', 'settings.json');
}

test('the installer keeps every key it found', (t) => {
  const settingsPath = sandbox(t);
  fs.writeFileSync(settingsPath, HEALTHY);

  const run = runInstaller(settingsPath, embeddedModule());
  assert.equal(run.code, 0, run.stderr);

  const after = JSON.parse(run.after);
  // Named individually rather than deep-equalling the whole object, so a
  // failure says WHICH key the installer ate.
  assert.equal(after.model, 'claude-opus-5');
  assert.equal(after.effortLevel, 'high');
  assert.deepEqual(after.env, { FOO: 'bar' });
  assert.equal(after.permissions.allow.length, 3, 'the allow list is the whole point of the tool');
  assert.equal(after.permissions.deny.length, 1, 'deny is what a user cannot afford to lose silently');
  assert.ok(after.hooks.SessionStart, "a co-located third-party hook is not ours to delete");
  assert.equal(after.hooks.PostToolUse.length, 1, 'and ours was actually added');
});

test('an unparseable settings.json is refused, not written over', (t) => {
  const settingsPath = sandbox(t);
  // Truncated mid-array: exactly what a reader sees inside somebody else's
  // non-atomic write, which is routine here — Claude Code rewrites this file
  // on every /model, /effort and approval.
  const broken = '{ "model": "x", "permissions": { "allow": [ ';
  fs.writeFileSync(settingsPath, broken);

  const run = runInstaller(settingsPath, embeddedModule());

  assert.notEqual(run.code, 0, 'a refusal has to be visible in the exit code');
  assert.equal(run.after, broken, 'the bytes are untouched, so the file stays recoverable');
  assert.match(run.stderr, /left untouched/);
});

test('a zero-byte settings.json is refused too', (t) => {
  const settingsPath = sandbox(t);
  // Not the same as absent. This is the window between truncate and write.
  fs.writeFileSync(settingsPath, '');

  const run = runInstaller(settingsPath, embeddedModule());

  assert.notEqual(run.code, 0);
  assert.equal(run.after, '', 'still empty — we did not decide it meant "no config yet"');
  assert.match(run.stderr, /present but empty/);
});

test('a JSON file that is not an object is refused', (t) => {
  const settingsPath = sandbox(t);
  // Parses fine, so the SyntaxError guard does not fire; `cfg.hooks ??= {}` on
  // an array would then write an array with a `hooks` property.
  fs.writeFileSync(settingsPath, '[1, 2, 3]');

  const run = runInstaller(settingsPath, embeddedModule());

  assert.notEqual(run.code, 0);
  assert.equal(run.after, '[1, 2, 3]');
  assert.match(run.stderr, /does not contain a JSON object/);
});

test('an absent settings.json is created, because that is the legitimate case', (t) => {
  const settingsPath = sandbox(t);
  assert.equal(fs.existsSync(settingsPath), false);

  const run = runInstaller(settingsPath, embeddedModule());

  assert.equal(run.code, 0, run.stderr);
  const after = JSON.parse(run.after);
  assert.equal(after.hooks.PostToolUse.length, 1);
  assert.equal(fs.existsSync(settingsPath + '.pre-install-backup'), false,
    'nothing existed, so there is nothing to back up');
});

test('the pre-write backup holds the bytes as found, not the config being written', (t) => {
  const settingsPath = sandbox(t);
  fs.writeFileSync(settingsPath, HEALTHY);

  const run = runInstaller(settingsPath, embeddedModule());
  assert.equal(run.code, 0, run.stderr);

  const backup = fs.readFileSync(settingsPath + '.pre-install-backup', 'utf8');
  // The easy mistake is to serialise `cfg` — which by then already has the new
  // hook pushed into it, making the "backup" a copy of the new state.
  assert.equal(backup, HEALTHY, 'byte-identical to what was there before');
  assert.ok(!backup.includes('PostToolUse'), 'so it is a way back, not a duplicate');
});

test('running twice does not register the hook twice', (t) => {
  const settingsPath = sandbox(t);
  fs.writeFileSync(settingsPath, HEALTHY);

  const source = embeddedModule();
  assert.equal(runInstaller(settingsPath, source).code, 0);
  const second = runInstaller(settingsPath, source);

  assert.equal(second.code, 0, second.stderr);
  assert.equal(JSON.parse(second.after).hooks.PostToolUse.length, 1);
  assert.match(second.stdout, /already registered/);
});

test('install.sh creates ~/.claude, as install.ps1 already did', () => {
  const sh = fs.readFileSync(path.join(repoRoot, 'install.sh'), 'utf8');
  // Without this, a fresh POSIX machine got ENOENT on the write and `set -e`
  // aborted before the starter-pack prompt. Windows had the mkdir; POSIX did not.
  assert.match(sh, /mkdir -p "\$\(dirname "\$SETTINGS"\)"/,
    'the parent directory must be created before the settings write');
});

test('no PowerShell script uses a PowerShell 7-only JSON parameter', () => {
  // -AsHashtable does not exist in Windows PowerShell 5.1, and the failure is
  // not a syntax error: both scripts parse clean under 5.1 and then eat the
  // config at run time. README.md names `.\install.ps1  # Windows PowerShell`
  // with no version requirement, so 5.1 is a supported shell and this parameter
  // is banned. If it is ever needed, add `#Requires -Version 6` first.
  // Comments are stripped before the check. The ban is on CALLING it; explaining
  // why it is banned, next to the replacement, is the whole point of the fix.
  // BOTH comment forms: `<# ... #>` blocks go first, because their interior lines
  // do not start with `#` and a line-only filter sails straight past them. Two
  // earlier versions of this test failed on their own explanatory prose — once on
  // a line comment, once on a block comment.
  const code = (body) => body
    .replace(/<#[\s\S]*?#>/g, ' ')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');

  // Repo root AND scripts/. The scan used to be root-only, which left a hole the
  // moment a .ps1 landed anywhere else — scripts/verify-installers.ps1 now does,
  // and it is precisely a file about this parameter.
  const dirs = [repoRoot, path.join(repoRoot, 'scripts')];
  const scripts = dirs.flatMap((dir) => (fs.existsSync(dir) ? fs.readdirSync(dir) : [])
    .filter((name) => name.endsWith('.ps1'))
    .map((name) => [path.relative(repoRoot, path.join(dir, name)),
      fs.readFileSync(path.join(dir, name), 'utf8')]));
  assert.ok(scripts.length >= 4,
    `expected both installers plus the scripts/ pair, found ${scripts.length}: ${scripts.map(([n]) => n).join(', ')}`);

  for (const [name, body] of scripts) {
    if (/#Requires\s+-Version\s+[6-9]/i.test(body)) continue;
    assert.ok(!/-AsHashtable/.test(code(body)),
      `${name} uses -AsHashtable, which throws on Windows PowerShell 5.1`);
  }
});

test('both PowerShell installers fail closed on an unreadable settings.json', () => {
  // The behavioural version of this is scripts/verify-installers.ps1, which
  // drives both installers as children under powershell.exe and is run by the
  // `installers` job in .github/workflows/test.yml and by
  // scripts/verify-release.ps1. This is the part that can run on a POSIX runner:
  // it pins the refusal, not the wording of the message.
  //
  // (That cross-reference was a promise before it was a fact — it named
  // verify-release.ps1 while verify-release.ps1 contained no installer check at
  // all. Both halves exist now.)
  for (const name of ['install.ps1', 'uninstall.ps1']) {
    const body = fs.readFileSync(path.join(repoRoot, name), 'utf8');
    assert.match(body, /could not be parsed/,
      `${name} must recognise an unparseable file`);
    assert.match(body, /left untouched/,
      `${name} must say it changed nothing`);
    // A warning followed by a write is precisely the shape that caused the loss.
    assert.match(body, /exit 1/,
      `${name} must exit non-zero rather than continue with an empty config`);
  }
});

// ── uninstall.sh ─────────────────────────────────────────────────────────────

function embeddedUninstaller() {
  const sh = fs.readFileSync(path.join(repoRoot, 'uninstall.sh'), 'utf8');
  const start = sh.indexOf("node --input-type=module <<'EOF'");
  assert.notEqual(start, -1, 'the heredoc that carries the uninstaller logic moved');
  const bodyStart = sh.indexOf('\n', start) + 1;
  const end = sh.indexOf('\nEOF', bodyStart);
  assert.notEqual(end, -1, 'unterminated heredoc');
  return sh.slice(bodyStart, end);
}

test('the uninstaller keeps a third-party hook that shares our entry', (t) => {
  const settingsPath = sandbox(t);
  const hookCmd = '/repo/bin/wildcard-perms';
  // Ours and a neighbour's in the SAME `hooks` array. Filtering per ENTRY
  // deleted the neighbour along with ours — silently, from a tool whose whole
  // promise is that it does not touch what it did not add.
  fs.writeFileSync(settingsPath, JSON.stringify({
    model: 'x',
    hooks: {
      PostToolUse: [{
        matcher: 'Bash',
        hooks: [
          { type: 'command', command: hookCmd },
          { type: 'command', command: 'neighbour-tool' },
        ],
      }],
    },
  }, null, 2) + '\n');

  const run = runInstaller(settingsPath, embeddedUninstaller());
  assert.equal(run.code, 0, run.stderr);

  const after = JSON.parse(run.after);
  assert.equal(after.hooks.PostToolUse.length, 1, 'the entry survives, because something in it did');
  assert.deepEqual(after.hooks.PostToolUse[0].hooks, [{ type: 'command', command: 'neighbour-tool' }],
    'ours is gone and only ours is gone');
  assert.equal(after.hooks.PostToolUse[0].matcher, 'Bash', 'the entry keeps its other fields');
  assert.equal(after.model, 'x');
});

test('the uninstaller drops the entry, and then hooks, when nothing else is left', (t) => {
  const settingsPath = sandbox(t);
  const hookCmd = '/repo/bin/wildcard-perms';
  fs.writeFileSync(settingsPath, JSON.stringify({
    model: 'x',
    hooks: { PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: hookCmd }] }] },
  }, null, 2) + '\n');

  const run = runInstaller(settingsPath, embeddedUninstaller());
  assert.equal(run.code, 0, run.stderr);

  const after = JSON.parse(run.after);
  // No empty `hooks: {}` left behind: an uninstall should leave no trace.
  assert.deepEqual(Object.keys(after), ['model']);
});

test('the uninstaller counts hooks, not entries', (t) => {
  const settingsPath = sandbox(t);
  const hookCmd = '/repo/bin/wildcard-perms';
  // Two registrations of ours, one of them sharing an entry with a neighbour.
  // Per-entry counting reported "1 hook" for two removals.
  fs.writeFileSync(settingsPath, JSON.stringify({
    hooks: {
      PostToolUse: [
        { matcher: 'Bash', hooks: [{ type: 'command', command: hookCmd }, { type: 'command', command: 'neighbour' }] },
        { matcher: 'PowerShell', hooks: [{ type: 'command', command: hookCmd }] },
      ],
    },
  }, null, 2) + '\n');

  const run = runInstaller(settingsPath, embeddedUninstaller());
  assert.equal(run.code, 0, run.stderr);
  assert.match(run.stdout, /removed 2 wildcard-perms PostToolUse hooks/);

  const after = JSON.parse(run.after);
  assert.equal(after.hooks.PostToolUse.length, 1);
  assert.deepEqual(after.hooks.PostToolUse[0].hooks, [{ type: 'command', command: 'neighbour' }]);
});
