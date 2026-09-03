'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { resolveExecutable, commandLaunch, quoteForCommandProcessor } = require('../src/exec-resolve');

const windows = process.platform === 'win32';

function scratch(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `exec-resolve-${name}-`));
  test.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });
  return dir;
}

function withPath(dir, run) {
  const before = process.env.PATH;
  process.env.PATH = `${dir}${path.delimiter}${before}`;
  try { return run(); } finally { process.env.PATH = before; }
}

test('a bare name resolves through PATHEXT, which spawn itself will not do', { skip: !windows }, () => {
  const dir = scratch('pathext');
  fs.writeFileSync(path.join(dir, 'wcprobe.cmd'), '@echo probe-ok\r\n', 'utf8');

  // PATHEXT supplies the extension, so its casing is whatever the box uses.
  const resolved = withPath(dir, () => resolveExecutable('wcprobe'));
  assert.equal(path.dirname(resolved), dir);
  assert.equal(path.basename(resolved).toLowerCase(), 'wcprobe.cmd');

  // The regression itself: the bare name cannot be launched, and naming the
  // shim outright is refused, so only the resolved launch form can work.
  const bare = spawnSync('wcprobe', [], { encoding: 'utf8', env: { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH}` } });
  assert.ok(bare.error, 'a bare .cmd name is expected to be unlaunchable');
});

test('a batch shim is launched through the command processor and reports its output', { skip: !windows }, () => {
  const dir = scratch('launch');
  // %~1 strips the quoting we add, so the shim sees the argument as one token.
  fs.writeFileSync(path.join(dir, 'wcprobe.cmd'), '@echo probe-ok %~1\r\n', 'utf8');

  const launch = withPath(dir, () => commandLaunch('wcprobe', ['first arg']));
  assert.equal(launch.file, process.env.ComSpec || 'cmd.exe');
  assert.equal(launch.options.windowsVerbatimArguments, true);

  const result = spawnSync(launch.file, launch.args, {
    encoding: 'utf8', windowsHide: true, ...launch.options,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /probe-ok first arg/);
});

test('a real executable is spawned directly rather than through a shell', { skip: !windows }, () => {
  const launch = commandLaunch(process.execPath, ['--version']);
  assert.equal(launch.file, process.execPath);
  assert.deepEqual(launch.options, {});
  const result = spawnSync(launch.file, launch.args, { encoding: 'utf8' });
  assert.equal(result.status, 0);
});

test('an unresolvable name keeps the caller ENOENT contract', { skip: !windows }, () => {
  const launch = commandLaunch('wc-definitely-not-installed-xyz', ['--version']);
  assert.equal(launch.resolved, null);
  assert.equal(launch.file, 'wc-definitely-not-installed-xyz');
});

test('POSIX keeps its own PATH handling untouched', { skip: windows }, () => {
  const launch = commandLaunch('echo', ['hello']);
  assert.equal(launch.file, 'echo');
  assert.deepEqual(launch.args, ['hello']);
  assert.deepEqual(launch.options, {});
});

test('quoting keeps a command-processor metacharacter inside one argument', () => {
  assert.equal(quoteForCommandProcessor('a & b'), '"a & b"');
  assert.equal(quoteForCommandProcessor('say "hi"'), '"say ""hi"""');
});

test('an argument carrying shell syntax survives the round trip verbatim', { skip: !windows }, () => {
  const dir = scratch('metachars');
  // %* forwards every argument, so whatever cmd.exe parsed is echoed back.
  fs.writeFileSync(path.join(dir, 'wcecho.cmd'), '@echo %*\r\n', 'utf8');
  const launch = withPath(dir, () => commandLaunch('wcecho', ['a&b|c', 'two words']));
  const result = spawnSync(launch.file, launch.args, {
    encoding: 'utf8', windowsHide: true, ...launch.options,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /"a&b\|c" "two words"/);
});

// Order matters, not just presence. An npm-installed CLI puts an extensionless
// shell script next to the .cmd, and CreateProcess cannot launch the former, so
// resolving to it reproduces the ENOENT this module exists to prevent.
test('a PATHEXT match wins over an extensionless sibling of the same name', { skip: !windows }, () => {
  const dir = scratch('order');
  fs.writeFileSync(path.join(dir, 'wcprobe'), '#!/bin/sh\necho posix-shim\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'wcprobe.cmd'), '@echo probe-ok\r\n', 'utf8');

  const resolved = withPath(dir, () => resolveExecutable('wcprobe'));
  assert.equal(path.basename(resolved).toLowerCase(), 'wcprobe.cmd');

  const launch = withPath(dir, () => commandLaunch('wcprobe', []));
  const result = spawnSync(launch.file, launch.args, {
    encoding: 'utf8', windowsHide: true, ...launch.options,
  });
  assert.equal(result.error, undefined);
  assert.match(result.stdout, /probe-ok/);
});

test('an explicit path that already carries its extension still matches itself', { skip: !windows }, () => {
  const dir = scratch('explicit');
  const shim = path.join(dir, 'wcprobe.cmd');
  fs.writeFileSync(shim, '@echo probe-ok\r\n', 'utf8');
  assert.equal(resolveExecutable(shim), shim);
});

// npm's global prefix on Windows is %APPDATA%\npm, and it is not always
// persisted into the machine or user PATH. A process that inherits the login
// environment (a VS Code extension host) then cannot see a CLI the same user
// runs fine in a terminal, which is how "codex executable not found on PATH"
// reached a dashboard while `codex --version` worked in a shell.
test('a CLI in the npm global prefix resolves when PATH does not have it', { skip: !windows }, () => {
  const fake = scratch('npmprefix');
  const npmDir = path.join(fake, 'npm');
  fs.mkdirSync(npmDir, { recursive: true });
  fs.writeFileSync(path.join(npmDir, 'wcfallback.cmd'), '@echo fallback-ok\r\n', 'utf8');

  const beforeAppData = process.env.APPDATA;
  const beforePath = process.env.PATH;
  // A PATH that deliberately cannot see it, and an APPDATA that can.
  process.env.APPDATA = fake;
  process.env.PATH = path.join(fake, 'nothing-here');
  try {
    const resolved = resolveExecutable('wcfallback');
    assert.equal(path.dirname(resolved), npmDir);

    // And it is launchable, which is the whole point of resolving it.
    const launch = commandLaunch('wcfallback', []);
    const result = spawnSync(launch.file, launch.args, {
      encoding: 'utf8', windowsHide: true, ...launch.options,
    });
    assert.equal(result.error, undefined);
    assert.match(result.stdout, /fallback-ok/);

    // Absent from both, still null: the fallback is two named directories, not
    // a search of the disk.
    assert.equal(resolveExecutable('wc-not-anywhere-xyz'), null);
  } finally {
    if (beforeAppData === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = beforeAppData;
    process.env.PATH = beforePath;
  }
});

test('PATH stays authoritative over the fallback directories', { skip: !windows }, () => {
  const fake = scratch('precedence');
  const npmDir = path.join(fake, 'npm');
  const pathDir = path.join(fake, 'onpath');
  fs.mkdirSync(npmDir, { recursive: true });
  fs.mkdirSync(pathDir, { recursive: true });
  fs.writeFileSync(path.join(npmDir, 'wcboth.cmd'), '@echo from-fallback\r\n', 'utf8');
  fs.writeFileSync(path.join(pathDir, 'wcboth.cmd'), '@echo from-path\r\n', 'utf8');

  const beforeAppData = process.env.APPDATA;
  process.env.APPDATA = fake;
  try {
    const resolved = withPath(pathDir, () => resolveExecutable('wcboth'));
    assert.equal(path.dirname(resolved), pathDir, 'PATH must win');
  } finally {
    if (beforeAppData === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = beforeAppData;
  }
});
