#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK_CMD="$SCRIPT_DIR/bin/wildcard-perms"
SETTINGS="$HOME/.claude/settings.json"

chmod +x "$HOOK_CMD"

# ── 1. Register PostToolUse hook ──────────────────────────────────────────────
HOOK_CMD="$HOOK_CMD" SETTINGS="$SETTINGS" node --input-type=module <<'EOF'
import { readFileSync, writeFileSync } from 'fs';

const settingsPath = process.env.SETTINGS;
const hookCmd      = process.env.HOOK_CMD;

let cfg = {};
try { cfg = JSON.parse(readFileSync(settingsPath, 'utf8')); } catch {}

cfg.hooks ??= {};
cfg.hooks.PostToolUse ??= [];

const already = cfg.hooks.PostToolUse.some(entry =>
  Array.isArray(entry.hooks) && entry.hooks.some(h => h.command === hookCmd)
);

if (!already) {
  cfg.hooks.PostToolUse.push({
    matcher: 'Bash|PowerShell',
    hooks: [{ type: 'command', command: hookCmd }],
  });
  writeFileSync(settingsPath, JSON.stringify(cfg, null, 2) + '\n');
  console.log('✓ wildcard-perms registered as PostToolUse hook in ~/.claude/settings.json');
} else {
  console.log('✓ wildcard-perms already registered');
}
EOF

# ── 2. Optional: seed allow list from starter pack ────────────────────────────
echo ""
echo "Starter pack: $SCRIPT_DIR/patterns/starter-pack.md"
echo "Merges $(node -e "console.log(require('$SCRIPT_DIR/patterns/starter-pack.json').length)") curated permissions into your allow list."
echo ""
read -r -p "Seed your allow list from the starter pack? [y/N] " answer

case "$answer" in
  [Yy]|[Yy][Ee][Ss])
    node "$HOOK_CMD" --seed
    ;;
  *)
    echo "Skipped — run 'node $HOOK_CMD --seed' at any time to import."
    ;;
esac

echo ""
echo "Done. Reload your Claude Code window to activate the hook."
