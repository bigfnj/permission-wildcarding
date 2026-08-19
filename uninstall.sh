#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK_CMD="$SCRIPT_DIR/bin/wildcard-perms"
SETTINGS="$HOME/.claude/settings.json"

HOOK_CMD="$HOOK_CMD" SETTINGS="$SETTINGS" node --input-type=module <<'EOF'
import { readFileSync, writeFileSync } from 'fs';

const settingsPath = process.env.SETTINGS;
const hookCmd      = process.env.HOOK_CMD;

let cfg = {};
try { cfg = JSON.parse(readFileSync(settingsPath, 'utf8')); } catch { process.exit(0); }

if (cfg.hooks?.PostToolUse) {
  cfg.hooks.PostToolUse = cfg.hooks.PostToolUse.filter(entry =>
    !(Array.isArray(entry.hooks) && entry.hooks.some(h => h.command === hookCmd))
  );
  if (!cfg.hooks.PostToolUse.length) delete cfg.hooks.PostToolUse;
  if (!Object.keys(cfg.hooks).length)  delete cfg.hooks;
}

writeFileSync(settingsPath, JSON.stringify(cfg, null, 2) + '\n');
console.log('✓ wildcard-perms hook removed from ~/.claude/settings.json');
EOF
