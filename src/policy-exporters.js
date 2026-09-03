'use strict';

// Cross-agent policy exporters for Auto Learn. The learner emits a neutral
// candidate; these exporters are the final safety boundary before it becomes a
// Claude wildcard or a Codex executable-policy rule.

const GENERATED_FORMAT_VERSION = 1;
const CODEX_BEGIN_MARKER = '# BEGIN permission-wildcarding generated rules';
const CODEX_END_MARKER = '# END permission-wildcarding generated rules';

const SHELL_WRAPPERS = new Set([
  'bash', 'bash.exe', 'cmd', 'cmd.exe', 'command.com', 'dash', 'dash.exe',
  'fish', 'fish.exe', 'ksh', 'ksh.exe', 'powershell', 'powershell.exe',
  'pwsh', 'pwsh.exe', 'sh', 'sh.exe', 'wsl', 'wsl.exe', 'zsh', 'zsh.exe',
]);

const DESTRUCTIVE_OR_ADMIN_ROOTS = new Set([
  'add-content', 'bcdedit', 'bcdedit.exe', 'chattr', 'chmod', 'chown',
  'clear-content', 'clear-disk', 'copy-item', 'dd', 'del', 'diskpart',
  'diskpart.exe', 'erase', 'format', 'format.com', 'icacls', 'icacls.exe',
  'kill', 'mkfs', 'move-item', 'net', 'net.exe', 'new-item', 'out-file',
  'reg', 'reg.exe', 'reboot', 'remove-item', 'rename-item', 'restart-computer',
  'rm', 'rmdir', 'runas', 'runas.exe', 'sc', 'sc.exe', 'set-content',
  'shutdown', 'shutdown.exe', 'stop-computer', 'stop-process', 'su', 'sudo',
  'takeown', 'takeown.exe', 'taskkill', 'taskkill.exe',
]);

const NETWORK_OR_INSTALL_ROOTS = new Set([
  'aria2c', 'choco', 'choco.exe', 'curl', 'curl.exe', 'ftp', 'ftp.exe', 'gh',
  'gh.exe', 'invoke-restmethod', 'invoke-webrequest', 'irm', 'iwr', 'nc',
  'netcat', 'npm', 'npm.cmd', 'npx', 'npx.cmd', 'pip', 'pip.exe', 'pip3',
  'pip3.exe', 'scp', 'scp.exe', 'sftp', 'sftp.exe', 'ssh', 'ssh.exe',
  'telnet', 'telnet.exe', 'wget', 'wget.exe', 'winget', 'winget.exe',
]);

// A Claude root wildcard covers every argument and subcommand. Consequently
// this allow-list is intentionally much smaller than the set of narrow Codex
// prefixes that can be emitted safely.
const CLAUDE_SAFE_BASH_ROOTS = new Set([
  'bat', 'batcat', 'cat', 'df', 'du', 'file', 'head', 'hostname', 'jq', 'ls',
  'md5sum', 'printenv', 'pwd', 'readlink', 'realpath', 'rg', 'sha1sum',
  'sha256sum', 'sha512sum', 'stat', 'strings', 'tail', 'tokei', 'tree',
  'uname', 'wc', 'where', 'where.exe', 'which', 'whoami', 'whoami.exe',
]);

const CLAUDE_SAFE_POWERSHELL_ROOTS = new Set([
  'compare-object', 'convertfrom-csv', 'convertfrom-json', 'convertto-csv',
  'convertto-html', 'convertto-json', 'format-custom', 'format-list',
  'format-table', 'format-wide', 'get-acl', 'get-childitem', 'get-command',
  'get-content', 'get-culture', 'get-date', 'get-filehash', 'get-host',
  'get-item', 'get-location', 'get-member', 'get-process', 'get-service',
  'get-winevent', 'group-object', 'join-path', 'measure-object', 'out-string',
  'resolve-path', 'select-object', 'select-string', 'sort-object', 'split-path',
  'test-path',
]);

// Roots a reviewer may wildcard by hand, kept separate from the two sets above
// because those state a stronger property: every argument is read-only, which
// is what lets the automatic path use them. These are not read-only. `ctest`
// runs whatever the project defines and `magick` writes files, so neither can
// ever be auto-applied; `isAutoSafeCandidate` requires read-only risk, and a
// selection here is named in the confirmation prompt before it lands.
//
// The list is evidence-driven rather than aspirational: each root is one the
// starter pack already grants for the other shell, so refusing to propose it
// meant the learner disagreed with the seed it ships. A single-token root
// belongs here only when a human granting it wholesale is a decision the
// project has already made.
const CLAUDE_REVIEWABLE_ROOTS = new Set([
  'cmake', 'cmake.exe', 'ctest', 'ctest.exe', 'magick', 'magick.exe',
]);

const SAFE_GIT_READ_SUBCOMMANDS = new Set([
  'blame', 'cat-file', 'count-objects', 'describe', 'diff', 'for-each-ref',
  'grep', 'log', 'ls-files', 'ls-tree', 'name-rev', 'rev-parse', 'shortlog',
  'show', 'status', 'whatchanged',
]);
const SAFE_RG_PREFIXES = new Set(['--files', '--type-list', '--help', '--version', '-h', '-V']);
// `cat-file` is absent deliberately: `git cat-file --textconv` runs the diff
// driver the repository names, so it stays readable (SAFE_GIT_READ_SUBCOMMANDS,
// above) without ever being auto-applied.
const AUTO_SAFE_GIT_SUBCOMMANDS = new Set([
  'count-objects', 'ls-files', 'ls-tree', 'rev-parse', 'show-ref', 'status',
]);
const STATE_MUTATING_ROOTS = new Set(['date', 'date.exe', 'hostname', 'hostname.exe']);
// This gate is deliberately a second, independent copy of the learner's list in
// src/auto-learn.js — a bug in one should not propagate to the other. A root
// qualifies only when no argument can reach its stdout, so roots whose argument
// *is* the output (echo, printf, Write-*, basename, dirname, Get-Date -Format)
// are excluded: one grant would otherwise become an arbitrary-content file write.
//
// The rationale used to say no Claude Code allow pattern can exclude a
// redirection. That is wrong, and the gate survives the correction. MEASURED
// 2026-09-03 against Claude Code 2.1.258: the redirect target IS intercepted
// independently of the command rule, `Bash(echo *)` allowed, five probes. In a
// non-interactive `-p` run every redirect was refused ("Output redirection to
// '<path>' was blocked"), including one inside the session's own working
// directory that the refusal itself listed as allowed. In an interactive session
// the identical redirect SUCCEEDED silently and wrote the file, because a
// tool-wide `Write` grant covers the write, and patterns/starter-pack.json seeds
// exactly that grant.
//
// So the guard is real but it is not protection we get for free: with `Write`
// allowed, an auto-applied `Bash(echo *)` does write arbitrary content to an
// arbitrary path. What the guard changes is blast radius, from anywhere on disk
// to anywhere inside the session's working directories. Still worth excluding.
// See docs/claude-code-permissions.md section 4.
const AUTO_SUFFIX_CLOSED_ROOTS = new Set([
  'false', 'get-alias', 'get-computerinfo', 'get-culture', 'get-host',
  'get-location', 'get-member', 'get-psprovider', 'get-timezone', 'pwd',
  'true', 'uname', 'uname.exe', 'whoami', 'whoami.exe',
]);
const AUTO_UNSAFE_REASONS = new Set([
  'credential-sensitive', 'environment-prefix', 'network-command',
  'prefix-suffix-unsafe', 'remote-argument', 'shell-structure',
]);


function canonicalRoot(token) {
  const normalized = String(token == null ? '' : token).replace(/\\/g, '/');
  return (normalized.split('/').pop() || '').toLowerCase();
}

function cleanOneLine(value, maxLength = 240) {
  return String(value == null ? '' : value)
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function starlarkString(value) {
  return JSON.stringify(String(value))
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function isAutoSafe(candidate) {
  return Boolean(candidate) &&
    (candidate.autoSafe === true || candidate.auto_safe === true);
}

function candidateRiskIsUnsafe(candidate) {
  if (!candidate) return true;
  const flags = [
    'admin', 'administrative', 'dangerous', 'destructive', 'isAdmin',
    'isDangerous', 'isDestructive', 'mutating', 'mutation', 'network',
    'privileged', 'remote', 'risky', 'writes',
  ];
  if (flags.some((key) => candidate[key] === true)) return true;

  const unsafeLabel = (value) => {
    if (value == null || value === '') return false;
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value > 1;
    if (Array.isArray(value)) return value.some(unsafeLabel);
    if (typeof value === 'object') {
      return ['level', 'risk', 'category', 'categories', 'kind', 'flags']
        .some((key) => Object.prototype.hasOwnProperty.call(value, key) &&
          unsafeLabel(value[key]));
    }
    const label = String(value).trim().toLowerCase();
    if (!label || ['none', 'safe', 'low', 'low-risk', 'minimal', 'read-only', 'readonly', '0', '1'].includes(label)) return false;
    return true;
  };

  return [candidate.risk, candidate.riskLevel, candidate.risk_level,
    candidate.riskCategory, candidate.riskCategories, candidate.categories]
    .some(unsafeLabel);
}

function candidateIsComplex(candidate) {
  return Boolean(candidate?.complex || candidate?.isComplex ||
    candidate?.is_complex || candidate?.compound || candidate?.isCompound);
}

function candidateHasAutomaticBlock(candidate) {
  return (Array.isArray(candidate?.reasons) ? candidate.reasons : [])
    .some((reason) => AUTO_UNSAFE_REASONS.has(String(reason)));
}

function normalizePrefix(candidate) {
  // Only the learner's reviewed prefix is authoritative. Never derive policy
  // from a raw command string or a full observed argv.
  if (!Array.isArray(candidate?.prefix) || candidate.prefix.length === 0) return null;
  if (!candidate.prefix.every((token) => typeof token === 'string' && token.length > 0)) return null;
  if (candidate.prefix.some((token) => /[\u0000-\u001f\u007f]/.test(token) || token.includes('*'))) return null;
  return candidate.prefix.slice();
}

function candidateContainsSecret(candidate, prefix) {
  if (candidate?.secretBearing || candidate?.secret_bearing || candidate?.containsSecrets ||
      candidate?.contains_secrets || candidate?.credential === true || candidate?.sensitive === true) return true;
  return prefix.some((token) =>
    /^(?:[^=]*(?:api[_-]?key|authorization|credential|password|secret|token)[^=]*)=/i.test(token) ||
    /^bearer\s+\S+/i.test(token)
  );
}

function wrapperIsBroad(prefix) {
  const root = canonicalRoot(prefix?.[0]);
  if (!SHELL_WRAPPERS.has(root)) return false;
  if (prefix.length === 1) return true;
  const second = String(prefix[1]).toLowerCase();
  if (['cmd', 'cmd.exe', 'command.com'].includes(root)) return second === '/c' || second === '/k';
  if (['powershell', 'powershell.exe', 'pwsh', 'pwsh.exe'].includes(root)) {
    if (['-c', '-command', '-encodedcommand', '-enc'].includes(second)) return true;
    return !['-file', '-f'].includes(second) || prefix.length < 3;
  }
  if (['bash', 'bash.exe', 'dash', 'dash.exe', 'fish', 'fish.exe', 'ksh', 'ksh.exe', 'sh', 'sh.exe', 'zsh', 'zsh.exe'].includes(root)) {
    return ['-c', '-lc'].includes(second);
  }
  return prefix.length < 2;
}

function candidateIsWrapper(candidate, prefix) {
  return Boolean(candidate?.wrapper || candidate?.isWrapper || candidate?.is_wrapper ||
    SHELL_WRAPPERS.has(canonicalRoot(prefix?.[0])));
}

function prefixIsAutoSuffixClosed(prefix) {
  const root = canonicalRoot(prefix?.[0]);
  if (root === 'git' || root === 'git.exe') {
    return prefix.length >= 2 && AUTO_SAFE_GIT_SUBCOMMANDS.has(String(prefix[1]).toLowerCase());
  }
  if (root === 'rg' || root === 'rg.exe') {
    return prefix.length >= 2 && SAFE_RG_PREFIXES.has(String(prefix[1]));
  }
  return AUTO_SUFFIX_CLOSED_ROOTS.has(root);
}

function prefixIsKnownRisky(prefix) {
  if (!Array.isArray(prefix) || prefix.length === 0) return true;
  const root = canonicalRoot(prefix[0]);
  if (DESTRUCTIVE_OR_ADMIN_ROOTS.has(root) || NETWORK_OR_INSTALL_ROOTS.has(root) ||
      STATE_MUTATING_ROOTS.has(root)) return true;
  if (root === 'git' || root === 'git.exe') {
    return prefix.length < 2 || !SAFE_GIT_READ_SUBCOMMANDS.has(String(prefix[1]).toLowerCase());
  }
  if (root === 'rg' || root === 'rg.exe') {
    return prefix.length < 2 || !SAFE_RG_PREFIXES.has(String(prefix[1]));
  }
  if (prefix.length === 1 && [
    'docker', 'docker.exe', 'node', 'node.exe', 'perl', 'perl.exe', 'py',
    'py.exe', 'python', 'python.exe', 'python3', 'python3.exe', 'ruby',
    'ruby.exe',
  ].includes(root)) return true;
  return false;
}

function candidateEligibleForCodex(candidate, options) {
  const reviewed = options?.includeReviewed === true;
  if ((!isAutoSafe(candidate) && !reviewed) || candidateIsComplex(candidate)) return null;
  const prefix = normalizePrefix(candidate);
  if (!prefix || candidateContainsSecret(candidate, prefix)) return null;
  if (candidateIsWrapper(candidate, prefix)) {
    if (!reviewed || wrapperIsBroad(prefix)) return null;
  }
  if (!reviewed && (candidateRiskIsUnsafe(candidate) || candidateHasAutomaticBlock(candidate) ||
      prefixIsKnownRisky(prefix) || !prefixIsAutoSuffixClosed(prefix))) return null;
  return prefix;
}

function successCount(candidate) {
  for (const value of [candidate?.successCount, candidate?.successfulRuns,
    candidate?.successes, candidate?.counts?.success, candidate?.counts?.successful]) {
    const count = Number(value);
    if (Number.isFinite(count) && count > 0) return Math.floor(count);
  }
  return 0;
}

function patternKey(pattern) {
  return JSON.stringify(pattern);
}

function shellExampleArg(value) {
  const arg = String(value);
  if (/^[A-Za-z0-9_@%+=:,./\\-]+$/.test(arg)) return arg;
  const quote = String.fromCharCode(34);
  const escaped = arg.replace(/\\/g, '\\\\').split(quote).join('\\' + quote);
  return quote + escaped + quote;
}

function expandPattern(pattern) {
  let commands = [[]];
  for (const position of pattern) {
    const alternatives = Array.isArray(position) ? position : [position];
    commands = commands.flatMap((prefix) => alternatives.map((token) => [...prefix, token]));
  }
  return commands;
}

function commandExample(argv) {
  return argv.map(shellExampleArg).join(' ');
}

function nonMatchExamples(pattern) {
  const unionIndex = pattern.findIndex(Array.isArray);
  if (unionIndex >= 0) {
    const argv = pattern.map((position) => Array.isArray(position) ? position[0] : position);
    const root = canonicalRoot(argv[0]);
    if ((root === 'git' || root === 'git.exe') && unionIndex === 1) {
      return [commandExample([argv[0], 'push']), commandExample([argv[0], 'reset', '--hard'])];
    }
    argv[unionIndex] = '__claude_wildcarding_not_allowed__';
    return [commandExample(argv)];
  }
  if (pattern.length === 1) return ['__claude_wildcarding_nonmatch__'];
  const argv = pattern.slice();
  argv[argv.length - 1] = `${argv[argv.length - 1]}__claude_wildcarding_nonmatch__`;
  return [commandExample(argv)];
}

function ruleJustification(candidates, options) {
  if (typeof options?.justification === 'string') {
    const fixed = cleanOneLine(options.justification);
    if (fixed) return fixed;
  }
  const custom = candidates.map((candidate) => cleanOneLine(candidate?.justification))
    .filter(Boolean).sort((a, b) => a.localeCompare(b));
  if (custom.length) return custom[0];
  const observed = candidates.reduce((sum, candidate) => sum + successCount(candidate), 0);
  return observed > 0
    ? `Auto Learn: ${observed} successful local history observation${observed === 1 ? '' : 's'}.`
    : 'Auto Learn: deterministic low-risk prefix from local history.';
}

function renderPattern(pattern) {
  const renderPosition = (position) => Array.isArray(position)
    ? `[${position.map(starlarkString).join(', ')}]`
    : starlarkString(position);
  return `[${pattern.map(renderPosition).join(', ')}]`;
}

function renderRule(record, options) {
  const renderList = (values) => values.map((value) => `        ${starlarkString(value)},`).join('\n');
  const matches = expandPattern(record.pattern).map(commandExample);
  return [
    'prefix_rule(',
    `    pattern = ${renderPattern(record.pattern)},`,
    '    decision = ' + starlarkString('allow') + ',',
    `    justification = ${starlarkString(ruleJustification(record.candidates, options))},`,
    '    match = [', renderList(matches), '    ],',
    '    not_match = [', renderList(nonMatchExamples(record.pattern)), '    ],',
    ')',
  ].join('\n');
}

function buildCodexRecords(candidates, options) {
  const byPattern = new Map();
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    // Codex policy is an argv prefix for a program it will execute. An MCP
    // tool, a fetch domain or a file edit has no such shape, so a tool family
    // must never be rendered as one of its rules.
    if (candidate && typeof candidate === 'object' && candidate.kind === 'tool') continue;
    const prefix = candidateEligibleForCodex(candidate, options);
    if (!prefix) continue;
    const key = patternKey(prefix);
    if (!byPattern.has(key)) byPattern.set(key, { pattern: prefix, candidates: [] });
    byPattern.get(key).candidates.push(candidate);
  }

  let records = [...byPattern.values()];
  const gitGroups = new Map();
  for (const record of records) {
    const [root, subcommand] = record.pattern;
    if (record.pattern.length !== 2 ||
        !['git', 'git.exe'].includes(canonicalRoot(root)) ||
        !SAFE_GIT_READ_SUBCOMMANDS.has(String(subcommand).toLowerCase())) continue;
    if (!gitGroups.has(root)) gitGroups.set(root, []);
    gitGroups.get(root).push(record);
  }

  const groupedKeys = new Set();
  const unions = [];
  for (const [root, group] of gitGroups) {
    const subcommands = [...new Set(group.map((record) => record.pattern[1]))]
      .sort((a, b) => a.localeCompare(b));
    if (subcommands.length < 2) continue;
    group.forEach((record) => groupedKeys.add(patternKey(record.pattern)));
    unions.push({ pattern: [root, subcommands], candidates: group.flatMap((record) => record.candidates) });
  }

  records = records.filter((record) => !groupedKeys.has(patternKey(record.pattern)));
  records.push(...unions);
  records.sort((a, b) => patternKey(a.pattern).localeCompare(patternKey(b.pattern)));
  return records;
}

function renderCodexRules(candidates, options = {}) {
  const version = cleanOneLine(options.version ?? GENERATED_FORMAT_VERSION, 40) || String(GENERATED_FORMAT_VERSION);
  const customHeader = typeof options.header === 'string'
    ? cleanOneLine(options.header, 160)
    : 'Generated by permission-wildcarding Auto Learn. Review before enabling.';
  const header = options.header === false ? [] : [
    `# ${customHeader}`,
    `# Generator format version: ${version}`,
  ];
  const body = buildCodexRecords(candidates, options).map((record) => renderRule(record, options));
  if (body.length === 0) body.push('# No auto-safe command prefixes were eligible.');
  return [...header, ...header.length && body.length ? [''] : [], ...body].join('\n').trimEnd() + '\n';
}

function lexicalMask(source) {
  const chars = source.split('');
  const stack = [];
  const errors = [];
  const quoteChars = new Set([String.fromCharCode(34), String.fromCharCode(39)]);
  const pairs = { ')': '(', ']': '[', '}': '{' };
  let quote = null;
  let escaped = false;
  let comment = false;

  for (let index = 0; index < chars.length; index++) {
    const character = chars[index];
    if (comment) {
      if (character === '\n') comment = false;
      else chars[index] = ' ';
      continue;
    }
    if (quote) {
      chars[index] = character === '\n' ? '\n' : ' ';
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '#') {
      chars[index] = ' ';
      comment = true;
      continue;
    }
    if (quoteChars.has(character)) {
      chars[index] = ' ';
      quote = character;
      continue;
    }
    if ('([{'.includes(character)) stack.push({ character, index });
    else if (')]}'.includes(character)) {
      const open = stack.pop();
      if (!open || open.character !== pairs[character]) {
        errors.push(`Unbalanced ${character} at offset ${index}`);
        break;
      }
    }
  }
  if (quote) errors.push('Unterminated string literal');
  if (stack.length) errors.push(`Unclosed ${stack[stack.length - 1].character} at offset ${stack[stack.length - 1].index}`);
  return { masked: chars.join(''), errors };
}

function findRuleBlocks(source, masked) {
  const blocks = [];
  const expression = /\bprefix_rule\s*\(/g;
  let match;
  while ((match = expression.exec(masked))) {
    const open = masked.indexOf('(', match.index);
    let depth = 0;
    let close = -1;
    for (let index = open; index < masked.length; index++) {
      if (masked[index] === '(') depth++;
      else if (masked[index] === ')' && --depth === 0) {
        close = index;
        break;
      }
    }
    if (close < 0) break;
    blocks.push({ start: match.index, end: close + 1, text: source.slice(match.index, close + 1), mask: masked.slice(match.index, close + 1) });
    expression.lastIndex = close + 1;
  }
  return blocks;
}

function assignedArray(block, name) {
  const assignment = new RegExp(`\\b${name}\\s*=`).exec(block.mask);
  if (!assignment) return null;
  const open = block.mask.indexOf('[', assignment.index + assignment[0].length);
  if (open < 0) return null;
  let depth = 0;
  for (let index = open; index < block.mask.length; index++) {
    if (block.mask[index] === '[') depth++;
    else if (block.mask[index] === ']' && --depth === 0) return block.text.slice(open, index + 1);
  }
  return null;
}

function patternSafetyErrors(pattern, number) {
  const errors = [];
  if (!Array.isArray(pattern) || pattern.length === 0 || Array.isArray(pattern[0])) {
    return [`Rule ${number}: pattern must begin with one exact executable token`];
  }
  for (const position of pattern) {
    const tokens = Array.isArray(position) ? position : [position];
    if (tokens.length === 0 || tokens.some((token) => typeof token !== 'string' || !token)) {
      errors.push(`Rule ${number}: pattern tokens must be non-empty strings`);
      continue;
    }
    if (tokens.some((token) => /[\u0000-\u001f\u007f]/.test(token))) errors.push(`Rule ${number}: control character in pattern token`);
    if (tokens.some((token) => token.includes('*'))) errors.push(`Rule ${number}: star tokens are not Codex argv wildcards`);
  }

  const root = canonicalRoot(pattern[0]);
  const second = pattern.length > 1
    ? (Array.isArray(pattern[1]) ? pattern[1] : [pattern[1]]).map((value) => String(value).toLowerCase())
    : [];
  if (['powershell', 'powershell.exe', 'pwsh', 'pwsh.exe'].includes(root) &&
      (pattern.length === 1 || (pattern.length === 2 && second.some((value) => ['-c', '-command'].includes(value))))) {
    errors.push(`Rule ${number}: broad PowerShell command prefix is forbidden`);
  }
  if (pattern.length === 1 && ['curl', 'curl.exe', 'py', 'py.exe', 'python', 'python.exe', 'python3', 'python3.exe'].includes(root)) {
    errors.push(`Rule ${number}: bare ${root} prefix is too broad`);
  }
  if ((root === 'git' || root === 'git.exe') && pattern.length === 1) errors.push(`Rule ${number}: bare git prefix is too broad`);
  return errors;
}

function validateCodexRulesText(text) {
  if (typeof text !== 'string') return { valid: false, errors: ['Rules text must be a string'] };
  const scanned = lexicalMask(text);
  const errors = scanned.errors.slice();
  if (errors.length) return { valid: false, errors };

  const blocks = findRuleBlocks(text, scanned.masked);
  const remaining = scanned.masked.split('');
  if (remaining[0] === '\uFEFF') remaining[0] = ' ';
  blocks.forEach((block) => {
    for (let index = block.start; index < block.end; index++) remaining[index] = ' ';
  });
  if (remaining.join('').trim()) errors.push('Unexpected top-level executable policy content');

  const allowExpression = new RegExp(`\\bdecision\\s*=\\s*${starlarkString('allow')}`);
  const fields = ['pattern', 'decision', 'justification', 'match', 'not_match'];
  blocks.forEach((block, index) => {
    const number = index + 1;
    for (const field of fields) {
      if (!new RegExp(`\\b${field}\\s*=`).test(block.mask)) errors.push(`Rule ${number}: missing ${field}`);
    }
    if (!allowExpression.test(block.text)) errors.push(`Rule ${number}: generated decision must be allow`);
    for (const field of ['match', 'not_match']) {
      const arrayText = assignedArray(block, field);
      if (!arrayText || /^\[\s*\]$/.test(arrayText)) errors.push(`Rule ${number}: ${field} must contain inline tests`);
    }
    const patternText = assignedArray(block, 'pattern');
    if (patternText) {
      try {
        errors.push(...patternSafetyErrors(JSON.parse(patternText), number));
      } catch {
        errors.push(`Rule ${number}: pattern must use deterministic JSON-compatible string arrays`);
      }
    }
  });
  return { valid: errors.length === 0, errors };
}

// Beyond shell rules, a permission may name an exact MCP tool, one fetch
// domain, or a bare tool. None carries a wildcard: the grant is never wider
// than the call that was observed.
const MCP_PERMISSION = /^mcp__[A-Za-z0-9_.-]{1,64}__[A-Za-z0-9_.-]{1,64}$/;
const WEB_FETCH_PERMISSION = /^WebFetch\(domain:([A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63})+)\)$/;
function parseToolPermission(permission) {
  const value = String(permission);
  if (MCP_PERMISSION.test(value)) return { permission: value, tool: 'mcp', root: value, tokens: [value] };
  const fetched = WEB_FETCH_PERMISSION.exec(value);
  if (fetched) {
    return { permission: value, tool: 'WebFetch', root: fetched[1], tokens: [fetched[1]] };
  }
  if (value === 'WebSearch') return { permission: value, tool: 'WebSearch', root: value, tokens: [value] };
  return null;
}
function parseClaudePermission(permission) {
  const match = /^(Bash|PowerShell)\((.+) \*\)$/.exec(String(permission));
  if (!match) return null;
  const tokens = match[2].split(' ');
  const safeToken = /^[A-Za-z0-9_@%+=:,./\\-]+$/;
  if (tokens.length === 0 || tokens.some((token) => !token || !safeToken.test(token))) return null;
  if (candidateContainsSecret({}, tokens)) return null;
  return { permission: match[0], tool: match[1], root: tokens[0], tokens };
}

function claudePermissionIsSafe(parsed, options) {
  const reviewed = options?.includeReviewed === true;
  if (!parsed || parsed.root === '&') return false;
  const root = parsed.root.toLowerCase();
  if (DESTRUCTIVE_OR_ADMIN_ROOTS.has(root) || NETWORK_OR_INSTALL_ROOTS.has(root) ||
      STATE_MUTATING_ROOTS.has(root) || SHELL_WRAPPERS.has(root)) return false;
  if (!reviewed && !prefixIsAutoSuffixClosed(parsed.tokens)) return false;
  if (parsed.tokens.length === 1) {
    const automatic = parsed.tool === 'PowerShell'
      ? CLAUDE_SAFE_POWERSHELL_ROOTS : CLAUDE_SAFE_BASH_ROOTS;
    if (automatic.has(root)) return true;
    return reviewed && CLAUDE_REVIEWABLE_ROOTS.has(root);
  }
  if (root === 'git' || root === 'git.exe') {
    return SAFE_GIT_READ_SUBCOMMANDS.has(parsed.tokens[1].toLowerCase());
  }
  return !prefixIsKnownRisky(parsed.tokens);
}

function candidateClaudePermission(candidate, options) {
  if (typeof candidate === 'string') return candidate;
  const reviewed = options?.includeReviewed === true;
  // A tool family states its own rule or has none. Never synthesize a shell
  // rule from its prefix: 'Edit' is not a command root.
  if (candidate?.kind === 'tool') {
    return reviewed && typeof candidate.claudePermission === 'string'
      ? candidate.claudePermission : null;
  }
  if ((!isAutoSafe(candidate) && !reviewed) || candidateIsComplex(candidate) ||
      (!reviewed && (candidateRiskIsUnsafe(candidate) || candidateHasAutomaticBlock(candidate)))) return null;
  if (typeof candidate.claudePermission === 'string') return candidate.claudePermission;
  if (typeof candidate.claude_permission === 'string') return candidate.claude_permission;

  const prefix = Array.isArray(candidate.claudePrefix) ? candidate.claudePrefix
    : Array.isArray(candidate.claude_prefix) ? candidate.claude_prefix
      : Array.isArray(candidate.prefix) ? candidate.prefix
    : null;
  const root = typeof candidate.root === 'string' ? candidate.root : prefix?.[0];
  const tokens = prefix && prefix.every((token) => typeof token === 'string') ? prefix.slice() : [root];
  if (!root || candidateIsWrapper(candidate, [root]) || candidateContainsSecret(candidate, tokens)) return null;

  let tool = candidate.tool;
  if (tool !== 'Bash' && tool !== 'PowerShell') {
    const shell = String(candidate.shell || '').toLowerCase();
    if (shell.includes('powershell') || shell === 'pwsh' || /^[A-Za-z]+-[A-Za-z]/.test(root)) tool = 'PowerShell';
    else if (shell.includes('bash') || shell.includes('sh') || !shell) tool = 'Bash';
    else return null;
  }
  return `${tool}(${tokens.join(' ')} *)`;
}

function renderClaudePermissions(candidates, options = {}) {
  const permissions = new Set();
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    const rendered = candidateClaudePermission(candidate, options);
    if (candidate && typeof candidate === 'object' && candidate.kind === 'tool') {
      // Opaque, networked or disk-mutating by nature, so an explicit review is
      // the only route these ever take into policy.
      const tool = options?.includeReviewed === true ? parseToolPermission(rendered) : null;
      if (tool) permissions.add(tool.permission);
      continue;
    }
    const parsed = parseClaudePermission(rendered);
    if (claudePermissionIsSafe(parsed, options)) permissions.add(parsed.permission);
  }
  return [...permissions].sort((a, b) => a.localeCompare(b));
}

function mergeClaudeAllow(existing, candidates, processAllowList, options = {}) {
  if (processAllowList && typeof processAllowList === 'object') {
    options = processAllowList;
    processAllowList = null;
  }
  const manual = Array.isArray(existing) ? existing.slice() : [];
  let generated = renderClaudePermissions(candidates, options);
  // Normalize generated entries only. Giving an old processor the full list
  // could prune narrower manual entries, violating the non-destructive merge.
  if (typeof processAllowList === 'function') {
    const processed = processAllowList(generated.slice());
    generated = renderClaudePermissions(Array.isArray(processed) ? processed : generated, options);
  }
  const seen = new Set(manual.filter((value) => typeof value === 'string'));
  for (const permission of generated) {
    if (!seen.has(permission)) {
      manual.push(permission);
      seen.add(permission);
    }
  }
  return manual;
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function markerMatches(text, marker) {
  const expression = new RegExp(`^${escapeRegex(marker)}[ \\t]*\\r?$`, 'gm');
  const matches = [];
  let match;
  while ((match = expression.exec(text))) {
    let lineEnd = match.index + match[0].length;
    if (text[lineEnd] === '\n') lineEnd++;
    matches.push({ start: match.index, end: lineEnd });
  }
  return matches;
}

function stripManagedMarkers(text) {
  const normalized = String(text).replace(/\r\n/g, '\n').trim();
  if (!normalized.startsWith(CODEX_BEGIN_MARKER) || !normalized.endsWith(CODEX_END_MARKER)) return normalized;
  return normalized
    .slice(CODEX_BEGIN_MARKER.length, -CODEX_END_MARKER.length)
    .replace(/^\s*\n?/, '')
    .replace(/\n?\s*$/, '');
}

function mergeGeneratedCodexRules(existingText, generatedText) {
  const existing = String(existingText == null ? '' : existingText);
  const generated = stripManagedMarkers(generatedText == null ? '' : generatedText);
  const validation = validateCodexRulesText(generated);
  if (!validation.valid) {
    throw new Error(`Refusing to merge invalid generated Codex rules: ${validation.errors.join('; ')}`);
  }

  const managedBlock = [CODEX_BEGIN_MARKER, generated.trimEnd(), CODEX_END_MARKER, ''].join('\n');
  const begins = markerMatches(existing, CODEX_BEGIN_MARKER);
  const ends = markerMatches(existing, CODEX_END_MARKER);
  if (begins.length !== ends.length || begins.length > 1) {
    throw new Error('Cannot merge Codex rules with unbalanced or duplicate generated markers');
  }
  if (begins.length === 1) {
    if (begins[0].start >= ends[0].start) throw new Error('Cannot merge Codex rules whose generated markers are out of order');
    return existing.slice(0, begins[0].start) + managedBlock + existing.slice(ends[0].end);
  }
  if (!existing) return managedBlock;
  const separator = existing.endsWith('\n') ? (existing.trim() ? '\n' : '') : '\n\n';
  return existing + separator + managedBlock;
}

module.exports = {
  renderCodexRules,
  validateCodexRulesText,
  renderClaudePermissions,
  mergeClaudeAllow,
  mergeGeneratedCodexRules,
  // Exported so the drift test can assert this gate and the learner's
  // independent copy still describe the same set.
  AUTO_SUFFIX_CLOSED_ROOTS,
  AUTO_SAFE_GIT_SUBCOMMANDS,
};
