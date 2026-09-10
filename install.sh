#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK_CMD="$SCRIPT_DIR/bin/wildcard-perms"
SETTINGS="$HOME/.claude/settings.json"

chmod +x "$HOOK_CMD"

# install.ps1 creates this; install.sh did not, so a fresh POSIX machine failed
# with ENOENT on the write below and `set -e` aborted before the starter-pack
# prompt. The Windows half has carried the mkdir since it was fixed there.
mkdir -p "$(dirname "$SETTINGS")"

# ── 1. Register PostToolUse hook ──────────────────────────────────────────────
HOOK_CMD="$HOOK_CMD" SETTINGS="$SETTINGS" node --input-type=module <<'EOF'
import { readFileSync, writeFileSync } from 'fs';

const settingsPath = process.env.SETTINGS;
const hookCmd      = process.env.HOOK_CMD;

// `catch {}` here meant that ANY read failure fell through to `cfg = {}` and
// the write below replaced the user's whole settings.json with just this hook.
// ENOENT is the legitimate case; a SyntaxError is not — it is the zero-byte or
// half-written window of somebody else's atomic write, which src/settings-write.js
// calls routine "because Claude Code rewrites this file in place on every
// /model, /effort and approval". uninstall.sh, in this same directory, already
// draws exactly this distinction and refuses; the installer never did.
let cfg = {};
let originalRaw = null;   // the bytes as found, for the backup below
try {
  originalRaw = readFileSync(settingsPath, 'utf8');
  if (originalRaw.trim() === '') {
    console.error(`✗ ${settingsPath} is present but empty — refusing to write over it.`);
    console.error('  That is usually a file being written right now. Re-run in a moment.');
    process.exit(1);
  }
  cfg = JSON.parse(originalRaw);
  if (cfg === null || typeof cfg !== 'object' || Array.isArray(cfg)) {
    console.error(`✗ ${settingsPath} does not contain a JSON object — left untouched.`);
    process.exit(1);
  }
} catch (error) {
  if (error.code !== 'ENOENT') {
    // Fail closed. Nothing is written, so the damaged file stays recoverable.
    console.error(`✗ ${settingsPath} could not be parsed — left untouched.`);
    console.error(`  ${error.message}`);
    console.error('  Nothing was changed. Fix or move the file, then re-run.');
    process.exit(1);
  }
  originalRaw = null;     // genuinely absent, so there is nothing to back up
}

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
  // The bytes as FOUND, not the object we are about to write — `cfg` already
  // has the new hook pushed into it by the line above.
  //
  // This is the only unlocked, non-atomic write to settings.json in the
  // project; everything in-process goes through writeFileAtomicSync, which an
  // install script cannot reach. A copy is the next-best thing.
  if (originalRaw !== null) {
    try { writeFileSync(settingsPath + '.pre-install-backup', originalRaw); }
    catch { /* best effort: never block the install on the backup */ }
  }
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
