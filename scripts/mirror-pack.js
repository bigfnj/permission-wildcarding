'use strict';

// Keeps the starter pack's PowerShell half in step with its Bash half.
//
// Why this exists: Bash sits under two layers the user never has to configure,
// Claude Code's built-in read-only command set and (in an enterprise) a managed
// allow list that usually covers coreutils and the common test/build tools.
// PowerShell has neither, so a user rule is the only thing that decides there.
// A pack weighted toward Bash therefore spends most of its entries on the half
// where they matter least. See docs/claude-code-permissions.md section 6.
//
// Mirroring adds the PowerShell spelling of a decision the pack has already
// made for Bash. It never invents a new capability, and it refuses to carry
// across anything whose PowerShell spelling would mean something broader:
//
//   - an interpreter or shell wrapper, because that grant covers every payload
//   - a POSIX-only tool or shell builtin, which cannot resolve under PowerShell
//   - a path or repo-relative script, which has no portable meaning
//   - anything the project's own classifier calls destructive, admin,
//     credential-sensitive, network or shell, or flags as a bare family prefix
//
// Usage:  node scripts/mirror-pack.js            report what is missing
//         node scripts/mirror-pack.js --write     add it to the pack

const fs = require('fs');
const path = require('path');

const { extractInvocations } = require('../src/auto-learn');

const PACK_PATH = path.join(__dirname, '..', 'patterns', 'starter-pack.json');

const NEVER_MIRROR = new Set([
  // Interpreters and shell wrappers.
  'bash', 'sh', 'dash', 'ksh', 'zsh', 'fish', 'command', 'builtin', 'env',
  'eval', 'exec', 'source', 'wsl', 'xargs', 'parallel', 'timeout', 'nohup',
  'setsid', 'ionice', 'flock', 'watch', 'sudo', 'su', 'doas', 'node', 'npx',
  'python', 'python3', 'py', 'ruby', 'perl', 'php', 'deno', 'bun', 'java',
  'ipython', 'pwsh', 'powershell', 'cmd', 'cmd.exe', 'iex',
  // POSIX-only or Linux host tooling.
  'journalctl', 'systemctl', 'service', 'apt', 'apt-get', 'apt-cache', 'yum',
  'dnf', 'pacman', 'brew', 'dpkg', 'rpm', 'snap', 'ip', 'ifconfig', 'iptables',
  'mount', 'umount', 'lsblk', 'dmesg', 'uname', 'id', 'chmod', 'chown',
  'fc-list', 'fc-cache', 'ldconfig', 'update-alternatives', 'df', 'du',
  'printenv', 'kill', 'killall', 'pkill', 'ps', 'free', 'pgrep', 'uptime',
  'lsof', 'nproc', 'sysctl', 'groups', 'who', 'w', 'last',
  // Shell builtins: statements rather than executables, so a PowerShell rule
  // for one can never match anything.
  'export', 'exit', 'wait', 'unset', 'set', 'alias', 'unalias', 'jobs', 'fg',
  'bg', 'trap', 'ulimit', 'umask', 'read', 'shift', 'local', 'readonly',
  'declare', 'typeset', 'pushd', 'popd', 'dirs', 'hash', 'times', 'type',
]);

const UNSAFE_RISK = new Set(['destructive', 'admin', 'credential', 'network', 'shell']);
const UNSAFE_REASONS = new Set([
  'admin-command', 'credential-sensitive', 'destructive-command',
  'family-subcommand-unknown', 'network-command', 'remote-argument',
  'reserved-keyword', 'shell-wrapper', 'shell-wrapper-option',
]);

function parseEntry(entry) {
  const parsed = /^([A-Za-z_]+)\(([\s\S]*)\)$/.exec(String(entry));
  if (!parsed) return null;
  let inner = parsed[2];
  if (inner.endsWith(' *') || inner.endsWith(':*')) inner = inner.slice(0, -2);
  const tokens = inner.trim().split(/\s+/).filter(Boolean);
  return tokens.length ? { tool: parsed[1], tokens } : null;
}

// Returns the PowerShell entries the pack is missing, with a reason for every
// Bash entry that was deliberately not carried across.
function mirrorTargets(pack) {
  const entries = (Array.isArray(pack) ? pack : []).map((entry) => ({ entry, parsed: parseEntry(entry) }));
  const existing = new Set(entries
    .filter((item) => item.parsed && item.parsed.tool === 'PowerShell')
    .map((item) => item.parsed.tokens.join(' ').toLowerCase()));

  const missing = [];
  const skipped = [];
  for (const { entry, parsed } of entries) {
    if (!parsed || parsed.tool !== 'Bash') continue;
    const root = parsed.tokens[0];
    const key = parsed.tokens.join(' ').toLowerCase();
    if (existing.has(key)) continue;
    if (NEVER_MIRROR.has(root.toLowerCase())) { skipped.push({ entry, why: 'wrapper or platform-specific' }); continue; }
    if (/[\\/]/.test(root) || root.startsWith('.')) { skipped.push({ entry, why: 'path or relative script' }); continue; }
    if (!/^[A-Za-z0-9_][A-Za-z0-9_.+-]*$/.test(root)) { skipped.push({ entry, why: 'not a bare root' }); continue; }
    const [classified] = extractInvocations('PowerShell', parsed.tokens.join(' '), {});
    if (!classified) { skipped.push({ entry, why: 'unparseable under PowerShell' }); continue; }
    if (UNSAFE_RISK.has(classified.risk)) { skipped.push({ entry, why: `classified ${classified.risk}` }); continue; }
    const blocking = (classified.reasons || []).find((reason) => UNSAFE_REASONS.has(reason));
    if (blocking) { skipped.push({ entry, why: `reason ${blocking}` }); continue; }
    missing.push(`PowerShell(${parsed.tokens.join(' ')} *)`);
  }
  return { missing: [...new Set(missing)].sort((a, b) => a.localeCompare(b)), skipped };
}

module.exports = { mirrorTargets, parseEntry, NEVER_MIRROR };

if (require.main === module) {
  const pack = JSON.parse(fs.readFileSync(PACK_PATH, 'utf8'));
  const { missing, skipped } = mirrorTargets(pack);
  const tally = {};
  for (const { why } of skipped) tally[why] = (tally[why] || 0) + 1;
  process.stdout.write(`pack ${pack.length} entries; PowerShell half is missing ${missing.length}\n`);
  for (const entry of missing) process.stdout.write(`  + ${entry}\n`);
  process.stdout.write(`not mirrored: ${JSON.stringify(tally)}\n`);
  if (process.argv[2] === '--write' && missing.length) {
    const next = [...new Set([...pack, ...missing])].sort((a, b) => a.localeCompare(b));
    fs.writeFileSync(PACK_PATH, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    process.stdout.write(`written: ${pack.length} -> ${next.length}\n`);
  }
}
