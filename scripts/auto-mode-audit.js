'use strict';

// Which of your allow entries does Claude Code actually load?
//
// In auto mode the classifier is the decider, and Claude Code DISCARDS any
// allow entry that would bypass it, logging one line per entry:
//
//   [DEBUG] Ignoring dangerous permission Bash(*) from <file> (bypasses classifier)
//
// An entry that is discarded cannot stop a prompt, so counting it as coverage
// is counting a rule that is not there. This audits the whole list in one run.
//
// It is free and it cannot touch your real configuration:
//   - CLAUDE_CONFIG_DIR points at an empty sandbox, so no credentials, no
//     managed policy fetch, and nothing of yours is read or written
//   - your settings file is read and never modified; only a copy of the allow
//     array is written into the sandbox
//   - with no credentials the run stops at "Not logged in", and the permission
//     load happens BEFORE that, so the answer arrives without an API call
//
// Usage:
//   node scripts/auto-mode-audit.js                     audit ~/.claude/settings.json in auto mode
//   node scripts/auto-mode-audit.js --mode manual       the same list in manual (default) mode
//   node scripts/auto-mode-audit.js --settings <path>   audit some other settings file
//   node scripts/auto-mode-audit.js --entries "Bash(*)" test specific entries instead
//   node scripts/auto-mode-audit.js --json              machine-readable output

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { commandLaunch } = require('../src/exec-resolve');

const IGNORED_LINE = /Ignoring dangerous permission (.+?) from .+? \(bypasses classifier\)/g;

function parseArgs(argv) {
  const args = { mode: 'auto', json: false, settings: null, entries: null, keep: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--json') args.json = true;
    else if (flag === '--keep') args.keep = true;
    else if (flag === '--mode') args.mode = String(argv[++index] || 'auto');
    else if (flag === '--settings') args.settings = String(argv[++index] || '');
    else if (flag === '--entries') args.entries = String(argv[++index] || '').split(',').map((v) => v.trim()).filter(Boolean);
  }
  return args;
}

function readAllow(settingsPath) {
  const raw = JSON.parse(fs.readFileSync(settingsPath, 'utf8').replace(/^﻿/, ''));
  const allow = raw && raw.permissions && Array.isArray(raw.permissions.allow) ? raw.permissions.allow : [];
  return allow.filter((entry) => typeof entry === 'string' && entry);
}

// Runs one probe and returns the entries Claude Code refused to load.
function audit(entries, mode) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-mode-audit-'));
  const configDir = path.join(sandbox, 'config');
  const probePath = path.join(sandbox, 'probe.settings.json');
  const debugPath = path.join(sandbox, 'debug.log');
  fs.mkdirSync(configDir, { recursive: true });
  // deny and ask are emptied so the run answers one question only: which allow
  // entries survive the load.
  fs.writeFileSync(probePath, `${JSON.stringify({ permissions: { allow: entries, deny: [], ask: [] } }, null, 2)}\n`);

  const launch = commandLaunch('claude', [
    '--settings', probePath,
    '--permission-mode', mode,
    '--debug-file', debugPath,
    '-p', `audit-${crypto.randomBytes(3).toString('hex')}`,
  ]);
  const result = spawnSync(launch.file, launch.args, {
    encoding: 'utf8', windowsHide: true, timeout: 120000,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, CLAUDE_CONFIG_DIR: configDir },
    ...launch.options,
  });

  let log = '';
  try { log = fs.readFileSync(debugPath, 'utf8'); } catch {}
  const ignored = [];
  let match;
  IGNORED_LINE.lastIndex = 0;
  while ((match = IGNORED_LINE.exec(log)) !== null) ignored.push(match[1]);

  const stderr = `${result.stderr || ''}${result.stdout || ''}`;
  // The sandbox has no credentials on purpose, so this is the expected end of a
  // healthy run. Anything else means the probe did not get far enough to be
  // trusted, and saying so beats reporting an empty ignore list as "all good".
  const reachedPermissionLoad = log.includes('Ignoring dangerous permission') ||
    /Not logged in|Please run \/login|Invalid API key/i.test(stderr);
  if (!args.keep) { try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch {} }

  return {
    sandbox, mode, total: entries.length,
    ignored: [...new Set(ignored)],
    reachedPermissionLoad,
    launchError: result.error ? result.error.code || result.error.message : null,
    note: reachedPermissionLoad ? null : stderr.trim().split('\n').slice(0, 3).join(' | '),
  };
}

const args = parseArgs(process.argv.slice(2));
const settingsPath = args.settings || path.join(os.homedir(), '.claude', 'settings.json');
const entries = args.entries || readAllow(settingsPath);
const report = audit(entries, args.mode);
report.settings = args.entries ? '(explicit --entries)' : settingsPath;
report.loaded = entries.filter((entry) => !report.ignored.includes(entry));

if (args.json) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else if (report.launchError) {
  process.stdout.write(`could not launch claude: ${report.launchError}\n`);
} else if (!report.reachedPermissionLoad) {
  process.stdout.write(`probe did not reach the permission load, so the result is not trustworthy: ${report.note}\n`);
} else {
  process.stdout.write(`${report.settings}\nmode ${report.mode}: ${report.total} entries, ${report.ignored.length} discarded, ${report.loaded.length} loaded\n`);
  if (report.ignored.length) {
    process.stdout.write('\ndiscarded (cannot stop a prompt in this mode):\n');
    for (const entry of report.ignored.slice().sort()) process.stdout.write(`  - ${entry}\n`);
  }
  if (args.keep) process.stdout.write(`\nsandbox kept at ${report.sandbox}\n`);
}
