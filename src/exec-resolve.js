'use strict';

// Launching a CLI by bare name is not symmetric on Windows. A PATH lookup that
// honours PATHEXT finds `codex.cmd`, but CreateProcess does not consult
// PATHEXT, so spawn('codex') fails ENOENT; naming the shim outright fails too,
// because Node refuses to run a .cmd or .bat without a command processor. An
// npm-installed CLI is exactly this shape, so the usual "it is on PATH" check
// passes and the call then cannot start.
//
// Resolve the name once here and let the resolved extension decide how to
// launch it: a batch shim goes through the command processor, everything else
// is spawned directly by absolute path. POSIX keeps its own PATH handling.

const fs = require('fs');
const path = require('path');

const BATCH_EXTENSIONS = new Set(['.cmd', '.bat']);

// PATHEXT first, bare name last. npm installs a CLI as three siblings: an
// extensionless shell script, a .cmd and a .ps1. CreateProcess cannot run the
// extensionless one, so preferring it would reproduce the very ENOENT this
// module exists to avoid; cmd.exe does not consider it either. The empty
// extension stays at the end so an explicit path that already carries one
// still matches itself.
function pathExtensions() {
  const raw = process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD';
  const listed = raw.split(';').map((value) => value.trim()).filter(Boolean);
  return [...listed, ''];
}

function isFile(target) {
  try { return fs.statSync(target).isFile(); } catch { return false; }
}

// Standard install locations to probe once PATH has failed.
//
// npm on Windows puts a CLI shim in its global prefix, %APPDATA%\npm, and that
// directory is not always persisted into the machine or user PATH. Measured on
// one box: `codex` and `claude` both live there, both resolve from a shell that
// a developer tool launched, and neither directory appears in HKCU\Environment
// or HKLM. A process that inherits the login environment instead, such as a VS
// Code extension host, therefore cannot see a CLI that the same user can run in
// a terminal. That is a confusing failure to debug from the outside, so close it.
//
// The trust expansion is narrow: this resolves only a name the caller asked for
// by hand, and only inside the user's own npm prefix or the Node install
// directory. Anything that can write to either can already act as the user.
// Read from the environment on every call so a test can point them elsewhere.
function fallbackDirectories() {
  if (process.platform !== 'win32') return [];
  const dirs = [];
  if (process.env.APPDATA) dirs.push(path.join(process.env.APPDATA, 'npm'));
  if (process.env.ProgramFiles) dirs.push(path.join(process.env.ProgramFiles, 'nodejs'));
  return dirs;
}

function probeDirectories(dirs, value, extensions) {
  for (const dir of dirs) {
    for (const extension of extensions) {
      const candidate = path.join(dir, value + extension);
      if (isFile(candidate)) return candidate;
    }
  }
  return null;
}

// Returns an absolute path on Windows, the name unchanged on POSIX (where
// spawn resolves PATH itself), or null when neither PATH nor a standard install
// location holds it.
function resolveExecutable(name) {
  const value = String(name == null ? '' : name);
  if (!value) return null;
  if (process.platform !== 'win32') return value;
  const extensions = pathExtensions();
  if (value.includes('/') || value.includes('\\')) {
    const direct = path.resolve(value);
    for (const extension of extensions) if (isFile(direct + extension)) return direct + extension;
    return null;
  }
  const onPath = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  // PATH stays authoritative; the fallback only answers where PATH said nothing.
  return probeDirectories(onPath, value, extensions) ||
    probeDirectories(fallbackDirectories(), value, extensions);
}

// Inside double quotes the command processor stops treating & | < > ^ ( ) as
// syntax, so quoting every token is enough to keep an argument whole. Doubling
// an embedded quote is the escape cmd.exe understands. %NAME% expansion stays
// live inside quotes and has no escape on a command line, so a token spelled
// like an environment variable would still expand; learned prefixes are
// tokenized command words, which is why that is a legibility edge and not a
// hole here.
function quoteForCommandProcessor(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

// Describes how to launch `name` with `args`: the file to spawn, the arguments
// to pass, and any spawn options the form requires. Callers spread `options`
// into their own so execFile and spawnSync can share one decision.
function commandLaunch(name, args = []) {
  const list = (Array.isArray(args) ? args : []).map(String);
  const resolved = resolveExecutable(name);
  // Unresolved on Windows means nothing on PATH matched. Hand the bare name
  // back so the caller's own ENOENT contract still fires rather than inventing
  // a different failure here.
  if (!resolved) return { file: String(name == null ? '' : name), args: list, options: {}, resolved: null };
  if (process.platform !== 'win32' || !BATCH_EXTENSIONS.has(path.extname(resolved).toLowerCase())) {
    return { file: resolved, args: list, options: {}, resolved };
  }
  const line = [resolved, ...list].map(quoteForCommandProcessor).join(' ');
  return {
    file: process.env.ComSpec || 'cmd.exe',
    args: ['/d', '/s', '/c', `"${line}"`],
    options: { windowsVerbatimArguments: true },
    resolved,
  };
}

module.exports = {
  resolveExecutable, commandLaunch, quoteForCommandProcessor, fallbackDirectories,
};
