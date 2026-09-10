#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK_CMD="$SCRIPT_DIR/bin/wildcard-perms"
SETTINGS="$HOME/.claude/settings.json"

HOOK_CMD="$HOOK_CMD" SETTINGS="$SETTINGS" node --input-type=module <<'EOF'
import { readFileSync, writeFileSync } from 'fs';

const settingsPath = process.env.SETTINGS;
const hookCmd      = process.env.HOOK_CMD;

let cfg;
try { cfg = JSON.parse(readFileSync(settingsPath, 'utf8')); }
catch (error) {
  // Nothing to undo is not a failure, but it is not a success either: say which
  // of the two happened rather than exiting 0 in silence.
  if (error.code === 'ENOENT') {
    console.log(`- no ${settingsPath}, so there is no hook to remove`);
    process.exit(0);
  }
  console.error(`✗ ${settingsPath} could not be read or parsed (${error.message}) — left untouched`);
  process.exit(1);
}

// The two installers register two different command strings for the same hook, and
// an uninstall that knows only one of them can never undo the other. install.sh
// registers the bare path, because the shebang makes the script directly
// executable; install.ps1 registers `node "<forward-slash path>"`, because Windows
// has no shebang support and a bare extensionless path pops a "How do you want to
// open this file?" dialog on every hook fire. So match on the PATH, not on the
// spelling of the command that wraps it.
const hookPath = (value) => {
  let text = String(value ?? '').trim();
  const wrapped = /^node\s+(.+)$/i.exec(text);
  if (wrapped) text = wrapped[1].trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
  text = text.replace(/\\/g, '/');
  // Git Bash spells D:\repo as /d/repo where PowerShell writes D:/repo — one path,
  // two spellings — and a Windows path is case-insensitive besides.
  const drive = /^\/([A-Za-z])\//.exec(text);
  if (drive) text = `${drive[1]}:/${text.slice(3)}`;
  return text.replace(/\/+$/, '').toLowerCase();
};

const target = hookPath(hookCmd);
const isOurs = (hook) => hookPath(hook?.command) === target;

const installed = Array.isArray(cfg.hooks?.PostToolUse) ? cfg.hooks.PostToolUse : [];

// Removed PER HOOK, not per entry. Dropping the whole entry took any hook that
// happened to share its `hooks` array with ours — somebody else's tool, deleted
// silently by our uninstaller. src/permissions.js:unregisterApproveHook already
// filters per hook; these two scripts were the ones that did not.
let removed = 0;
const kept = [];
for (const entry of installed) {
  if (!Array.isArray(entry?.hooks)) { kept.push(entry); continue; }
  const mine = entry.hooks.filter(isOurs).length;
  if (!mine) { kept.push(entry); continue; }
  removed += mine;
  const survivors = entry.hooks.filter((hook) => !isOurs(hook));
  // An entry that held only ours goes; one that held a neighbour keeps it,
  // with its matcher and any other fields intact.
  if (survivors.length) kept.push({ ...entry, hooks: survivors });
}

// The write and the "hook removed" message both used to sit OUTSIDE this check, so
// an uninstall that matched nothing still rewrote settings.json and still reported
// success — which is exactly what every PowerShell install got.
if (!removed) {
  console.log(`- no wildcard-perms hook registered in ${settingsPath}; nothing removed`);
  process.exit(0);
}

if (kept.length) cfg.hooks.PostToolUse = kept;
else delete cfg.hooks.PostToolUse;
if (cfg.hooks && !Object.keys(cfg.hooks).length) delete cfg.hooks;

writeFileSync(settingsPath, JSON.stringify(cfg, null, 2) + '\n');
console.log(`✓ removed ${removed} wildcard-perms PostToolUse hook${removed === 1 ? '' : 's'} from ${settingsPath}`);
console.log('  Allow-list entries stay as they are — this removes the hook, not your permissions.');
EOF
