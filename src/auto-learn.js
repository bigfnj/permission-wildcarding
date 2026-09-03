'use strict';

// Deterministic command analysis shared by Claude and Codex history readers.
// This module has no I/O and never applies a permission by itself.

const { isLearnableTool, toolInvocation } = require('./tool-learn');

const COMMAND_TOOLS = new Set([
  'bash', 'powershell', 'shell', 'shell_command', 'exec_command',
  'functions.shell_command', 'functions.exec_command',
]);
const BASH_RESERVED = new Set([
  '!', '[', '[[', 'case', 'coproc', 'declare', 'do', 'done', 'elif', 'else',
  'esac', 'eval', 'exec', 'export', 'fi', 'for', 'function', 'if', 'in',
  'local', 'readonly', 'return', 'select', 'set', 'source', 'then', 'time',
  'trap', 'typeset', 'unset', 'until', 'while', '{', '}',
]);
const POWERSHELL_RESERVED = new Set([
  'begin', 'break', 'catch', 'class', 'continue', 'data', 'do', 'dynamicparam',
  'else', 'elseif', 'end', 'enum', 'exit', 'filter', 'finally', 'for',
  'foreach', 'from', 'function', 'if', 'in', 'param', 'process', 'return',
  'switch', 'throw', 'trap', 'try', 'until', 'using', 'while', 'workflow',
]);

// Only roots whose ordinary purpose is read-only belong here. More powerful
// roots are classified separately even if one observed invocation looked safe.
const READ_ONLY_ROOTS = new Set([
  'basename', 'cat', 'cmp', 'comm', 'cut', 'dirname', 'du', 'echo',
  'file', 'get-acl', 'get-alias', 'get-authenticodesignature', 'get-childitem',
  'get-ciminstance', 'get-command', 'get-computerinfo', 'get-content',
  'get-culture', 'get-date', 'get-filehash', 'get-host', 'get-item',
  'get-itemproperty', 'get-location', 'get-member', 'get-module', 'get-process',
  'get-psdrive', 'get-psprovider', 'get-service', 'get-timezone', 'get-variable',
  'get-winevent', 'grep', 'head', 'id', 'join-path', 'jq', 'ls',
  'md5sum', 'more', 'nl', 'od', 'paste', 'printf', 'pwd', 'readlink',
  'realpath', 'resolve-path', 'rg', 'sha1sum', 'sha256sum', 'sha512sum',
  'split-path', 'stat', 'strings', 'tail', 'test', 'test-path', 'tr', 'true',
  'false', 'uname', 'uniq', 'wc', 'where', 'where.exe', 'which', 'whoami',
  'write-output', 'write-verbose', 'write-warning',
]);
const DESTRUCTIVE_ROOTS = new Set([
  'clear-content', 'clear-disk', 'del', 'erase', 'format', 'format-disk',
  'format-volume', 'initialize-disk', 'kill', 'killall', 'mkfs', 'pkill',
  'remove-item', 'remove-partition', 'restart-computer', 'rm', 'rmdir',
  'shred', 'shutdown', 'stop-computer', 'stop-process', 'taskkill', 'unlink',
]);
const ADMIN_ROOTS = new Set([
  'bcdedit', 'bootrec', 'diskpart', 'dism', 'doas', 'manage-bde', 'netsh',
  'regsvr32', 'runas', 'runasti64', 'sc', 'sc.exe', 'set-service', 'su', 'sudo',
]);
const NETWORK_ROOTS = new Set([
  'aria2c', 'aws', 'az', 'curl', 'dig', 'ftp', 'gcloud', 'gh',
  'invoke-restmethod', 'invoke-webrequest', 'nc', 'ncat', 'netcat', 'nslookup',
  'ping', 'scp', 'sftp', 'socat', 'ssh', 'telnet', 'test-netconnection',
  'tracert', 'traceroute', 'wget',
]);
const CREDENTIAL_ROOTS = new Set([
  'age', 'cmdkey', 'convertfrom-securestring', 'convertto-securestring',
  'get-credential', 'gpg', 'op', 'pass', 'secret-tool', 'sops', 'ssh-add',
  'ssh-keygen',
]);
const SHELL_WRAPPERS = new Set([
  '.', 'bash', 'bun', 'cmd', 'cmd.exe', 'command', 'dash', 'deno', 'env',
  'eval', 'exec', 'fish', 'iex', 'invoke-expression', 'java', 'ksh', 'mshta',
  'node', 'npm', 'npx', 'parallel', 'perl', 'php', 'pnpm', 'powershell',
  'powershell.exe', 'pwsh', 'py', 'python', 'python3', 'ruby', 'rundll32', 'sh',
  'source', 'wsl', 'xargs', 'yarn', 'zsh',
]);
const WRITE_ROOTS = new Set([
  'add-content', 'chmod', 'chown', 'copy-item', 'cp', 'dd', 'install', 'ln',
  'mkdir', 'move-item', 'mv', 'new-item', 'out-file', 'rename-item', 'set-acl',
  'set-content', 'set-item', 'set-itemproperty', 'tar', 'touch', 'unzip', 'zip',
]);
const FAMILY_ROOTS = new Set([
  'aws', 'az', 'cargo', 'choco', 'claude', 'codex', 'docker', 'dotnet',
  'gcloud', 'gh', 'git', 'go', 'kubectl', 'npm', 'ollama', 'pip', 'pip3',
  'pnpm', 'podman', 'scoop', 'terraform', 'winget', 'yarn',
]);
const FAMILY_SUBCOMMANDS = new Map(Object.entries({
  cargo: ['add', 'bench', 'build', 'check', 'clean', 'doc', 'fetch', 'fix', 'install', 'metadata', 'new', 'publish', 'remove', 'run', 'search', 'test', 'tree', 'uninstall', 'update', 'vendor'],
  choco: ['config', 'export', 'feature', 'info', 'install', 'list', 'outdated', 'pin', 'search', 'source', 'uninstall', 'upgrade'],
  claude: ['config', 'doctor', 'mcp', 'update'],
  codex: ['completion', 'exec', 'execpolicy', 'features', 'login', 'logout', 'mcp', 'review', 'sandbox'],
  docker: ['build', 'compose', 'container', 'cp', 'exec', 'image', 'images', 'info', 'inspect', 'logs', 'network', 'ps', 'pull', 'push', 'restart', 'rm', 'rmi', 'run', 'start', 'stats', 'stop', 'system', 'tag', 'version', 'volume'],
  dotnet: ['add', 'build', 'clean', 'format', 'list', 'new', 'nuget', 'pack', 'publish', 'remove', 'restore', 'run', 'sln', 'test', 'tool', 'workload'],
  gh: ['alias', 'api', 'auth', 'browse', 'cache', 'codespace', 'completion', 'config', 'extension', 'gist', 'issue', 'label', 'pr', 'release', 'repo', 'run', 'search', 'secret', 'ssh-key', 'status', 'variable', 'workflow'],
  git: ['add', 'am', 'apply', 'bisect', 'blame', 'branch', 'cat-file', 'checkout', 'cherry-pick', 'clean', 'clone', 'commit', 'config', 'count-objects', 'describe', 'diff', 'fetch', 'for-each-ref', 'gc', 'grep', 'init', 'log', 'ls-files', 'ls-remote', 'ls-tree', 'merge', 'mv', 'name-rev', 'notes', 'prune', 'pull', 'push', 'rebase', 'reflog', 'remote', 'repack', 'reset', 'restore', 'revert', 'rev-parse', 'rm', 'shortlog', 'show', 'show-ref', 'stash', 'status', 'submodule', 'switch', 'tag', 'whatchanged', 'worktree'],
  go: ['build', 'clean', 'doc', 'env', 'fmt', 'generate', 'get', 'install', 'list', 'mod', 'run', 'test', 'tool', 'version', 'vet', 'work'],
  kubectl: ['api-resources', 'api-versions', 'apply', 'auth', 'cluster-info', 'config', 'create', 'delete', 'describe', 'diff', 'exec', 'explain', 'get', 'kustomize', 'label', 'logs', 'patch', 'port-forward', 'rollout', 'run', 'scale', 'set', 'taint', 'top', 'version', 'wait'],
  npm: ['audit', 'ci', 'config', 'dedupe', 'diff', 'docs', 'exec', 'explain', 'help', 'init', 'install', 'link', 'list', 'login', 'logout', 'outdated', 'owner', 'pack', 'ping', 'prefix', 'profile', 'prune', 'publish', 'query', 'rebuild', 'repo', 'restart', 'root', 'run', 'search', 'shrinkwrap', 'start', 'stop', 'team', 'test', 'token', 'uninstall', 'update', 'version', 'view', 'whoami'],
  ollama: ['create', 'list', 'ps', 'pull', 'push', 'rm', 'run', 'serve', 'show', 'stop'],
  pip: ['cache', 'check', 'config', 'debug', 'download', 'freeze', 'hash', 'help', 'index', 'inspect', 'install', 'list', 'show', 'uninstall', 'wheel'],
  pip3: ['cache', 'check', 'config', 'debug', 'download', 'freeze', 'hash', 'help', 'index', 'inspect', 'install', 'list', 'show', 'uninstall', 'wheel'],
  terraform: ['apply', 'console', 'destroy', 'fmt', 'force-unlock', 'get', 'graph', 'import', 'init', 'login', 'logout', 'metadata', 'output', 'plan', 'providers', 'refresh', 'show', 'state', 'taint', 'test', 'untaint', 'validate', 'version', 'workspace'],
  winget: ['configure', 'download', 'export', 'features', 'hash', 'import', 'info', 'install', 'list', 'pin', 'repair', 'search', 'settings', 'show', 'source', 'uninstall', 'upgrade', 'validate'],
}).map(([root, commands]) => [root, new Set(commands)]));
const SAFE_GIT = new Set([
  'cat-file', 'count-objects', 'ls-files', 'ls-tree', 'rev-parse', 'show-ref',
  'status',
]);
// `git cat-file --textconv` runs the diff driver named by the repository's
// gitattributes, so the root is read-only to classify but not suffix-closed to
// auto-apply. It stays in SAFE_GIT — and so stays a review candidate — and is
// excluded here only.
const AUTO_SAFE_GIT = new Set([...SAFE_GIT].filter((sub) => sub !== 'cat-file'));
// Auto-applied policies are argv prefixes: every later argument is implicitly
// allowed. Other observed read commands stay useful as review candidates.
//
// A trailing `*` also admits shell syntax, not just arguments — `Bash(echo *)`
// matches `echo <anything> > <anywhere>`. Redirection cannot be excluded by a
// Claude Code allow pattern, so a root belongs here only when no argument can
// reach its stdout; otherwise one auto-applied grant becomes a write primitive
// with attacker-chosen content. That rules out echo/printf and the Write-*
// cmdlets (the argument is the output), basename/dirname (`basename 'text'`
// echoes its argument back), and Get-Date (`-Format "'text'"` emits literals).
// Every root that remains still permits truncation of an arbitrary path
// (`whoami > f`) with fixed content — the accepted residual, documented in the
// README, and the reason this list stays as short as it is.
const AUTO_SUFFIX_CLOSED_ROOTS = new Set([
  'false', 'get-alias', 'get-computerinfo', 'get-culture', 'get-host',
  'get-location', 'get-member', 'get-psprovider', 'get-timezone', 'pwd',
  'true', 'uname', 'whoami',
]);

// Complexity is a property of the invocation's own shape, and every trigger
// records a reason, so the flag is always derivable from the reasons. Keeping
// one list is what lets a stored candidate be re-derived rather than trusted:
// the flag used to be OR-merged across observations and could never clear.
//
// 'compound-command' is deliberately absent. Being one link of a chain says
// nothing about the link itself; whether its exit status can be trusted is
// already decided by segmentAttribution, which withholds success credit from
// any segment it cannot attribute. Counting the chain as complexity too
// disqualified the family a second time, permanently, for evidence the
// counters had already discounted.
const COMPLEX_REASONS = new Set([
  'dynamic-executable', 'family-subcommand-unknown', 'missing-command-root',
  'path-executable', 'powershell-call-operator', 'prefix-conflict',
  'quoted-executable', 'reserved-keyword', 'script-syntax', 'shell-structure',
  'write-redirection',
]);

const SAFE_RG_MODES = new Set(['--files', '--type-list', '--help', '--version', '-h', '-V']);
const NETWORK_GIT = new Set(['clone', 'fetch', 'ls-remote', 'pull', 'push', 'send-email', 'submodule']);
const DESTRUCTIVE_GIT = new Set(['checkout', 'clean', 'reset', 'restore']);
const WRITE_GIT = new Set([
  'add', 'am', 'apply', 'bisect', 'branch', 'cherry-pick', 'commit', 'config',
  'gc', 'init', 'merge', 'mv', 'notes', 'prune', 'rebase', 'reflog', 'remote',
  'repack', 'revert', 'rm', 'stash', 'switch', 'tag', 'worktree',
]);

const SECRET_WORD_RE = /(?:api[_-]?key|access[_-]?key|authorization|bearer|client[_-]?secret|cookie|credential|passwd|password|private[_-]?key|session[_-]?key|token)/i;
const SECRET_PATH_RE = /(?:^|[\\/])(?:\.aws|\.azure|\.config[\\/]gcloud|\.env(?:\.|$)|\.kube|\.npmrc|\.pypirc|\.ssh)(?:[\\/]|$)|(?:auth\.json|credentials?|id_(?:rsa|dsa|ecdsa|ed25519)|privatekey)/i;
const SECRET_VALUE_RE = /(?:\bAKIA[0-9A-Z]{16}\b|\bgh[pousr]_[A-Za-z0-9]{20,}\b|\bsk-[A-Za-z0-9_-]{16,}\b|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.)/;
const RISK_RANK = new Map([
  ['read-only', 0], ['unknown', 1], ['complex', 2], ['write', 3],
  ['shell', 4], ['network', 5], ['credential', 6], ['admin', 7],
  ['destructive', 8],
]);

function normalizeShell(shell, tool) {
  const explicit = String(shell || '').trim().toLowerCase();
  const toolName = String(tool || '').trim().toLowerCase();
  if (/^(?:powershell|pwsh|ps)$/.test(explicit)) return 'powershell';
  if (/^(?:bash|sh|zsh|fish|ksh|dash)$/.test(explicit)) return 'bash';
  if (explicit) return explicit;
  if (toolName.includes('powershell') || toolName === 'pwsh') return 'powershell';
  if (toolName === 'bash') return 'bash';
  if (toolName.includes('shell_command') || toolName.includes('exec_command') || toolName === 'shell') {
    return process.platform === 'win32' ? 'powershell' : 'bash';
  }
  return 'bash';
}

function permissionToolFor(shell) {
  return shell === 'powershell' ? 'PowerShell' : (shell === 'bash' ? 'Bash' : null);
}
function isCommandTool(tool, metadata) {
  return COMMAND_TOOLS.has(String(tool || '').trim().toLowerCase()) || Boolean(metadata && metadata.shell);
}
function isWhitespace(ch) { return /\s/.test(ch); }
function isCommentStart(text, index) {
  return text[index] === '#' && (index === 0 || isWhitespace(text[index - 1]));
}
function isBashAmpersandSeparator(text, index) {
  if (text[index + 1] === '>') return false;
  let previous = index - 1;
  while (previous >= 0 && isWhitespace(text[previous])) previous--;
  return text[previous] !== '>';
}

// A heredoc body is data, not commands, and it can sit inside quotes or a
// command substitution (`git commit -m "$(cat <<'EOF' ... EOF)"`), so mask it
// before segmentation instead of tracking it as parser state. An unquoted
// delimiter must be upper-case, the real-world convention, so `echo "a << b"`
// and the `<<<` here-string keep their current handling.
const HEREDOC_OPENER = /(?<!<)<<-?[ \t]*(?:(['"])([A-Za-z_][A-Za-z0-9_]*)\1|([A-Z][A-Z0-9_]*))/g;

function maskHeredocBodies(text) {
  if (!text.includes('<<')) return text;
  const output = [];
  const pending = [];
  for (const line of text.split('\n')) {
    if (pending.length) {
      output.push('');
      if (line.replace(/\r$/, '').trim() === pending[0]) pending.shift();
      continue;
    }
    output.push(line);
    HEREDOC_OPENER.lastIndex = 0;
    let match;
    while ((match = HEREDOC_OPENER.exec(line)) !== null) pending.push(match[2] || match[3]);
  }
  return output.join('\n');
}

// One tool result carries one exit status. An all-`&&` chain proves every link
// ran and exited 0; otherwise only the final segment of a `;`/newline/pipe chain
// carries the overall status. Everything else earns no evidence.
function segmentAttribution(segments) {
  if (segments.length <= 1) return segments.map(() => 'both');
  const separators = segments.slice(1).map((segment) => segment.separator);
  if (separators.every((value) => value === '&&')) return segments.map(() => 'success');
  const last = separators[separators.length - 1];
  const carriesStatus = last === ';' || last === '\n' || last === '|';
  return segments.map((segment, index) =>
    carriesStatus && index === segments.length - 1 ? 'both' : 'none');
}

// Split only top-level separators. Quoted and grouped constructs remain intact,
// allowing classification to reject them without inventing malformed roots.
function splitSegmentsDetailed(command, shell) {
  const mode = normalizeShell(shell);
  const raw = String(command == null ? '' : command);
  const text = mode === 'powershell' ? raw : maskHeredocBodies(raw);
  const segments = [];
  let current = '', quote = null, depth = 0;
  let separator = null;
  const flush = () => {
    const value = current.trim();
    if (value) segments.push({ value, separator });
    current = '';
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i], next = text[i + 1];
    if (quote === 'single') {
      current += ch;
      if (mode === 'powershell' && ch === "'" && next === "'") current += text[++i];
      else if (ch === "'") quote = null;
      continue;
    }
    if (quote === 'double') {
      current += ch;
      if ((mode === 'powershell' && ch === '`') || (mode !== 'powershell' && ch === '\\')) {
        if (i + 1 < text.length) current += text[++i];
      } else if (ch === '"') quote = null;
      continue;
    }
    if (mode === 'powershell' && ch === '<' && next === '#') {
      const end = text.indexOf('#>', i + 2); current += ' ';
      i = end === -1 ? text.length : end + 1; continue;
    }
    if (mode === 'powershell' && ch === '@' && (next === '"' || next === "'")) {
      const terminator = next === '"' ? '"@' : "'@";
      const end = text.indexOf(terminator, i + 2);
      current += ' ';
      i = (end === -1 ? text.length : end + terminator.length) - 1; continue;
    }
    if (isCommentStart(text, i)) {
      while (i < text.length && text[i] !== '\n' && text[i] !== '\r') i++;
      flush(); separator = '\n';
      if (text[i] === '\r' && text[i + 1] === '\n') i++;
      continue;
    }
    if (ch === "'") { quote = 'single'; current += ch; continue; }
    if (ch === '"') { quote = 'double'; current += ch; continue; }
    if ((mode === 'powershell' && ch === '`') || (mode !== 'powershell' && ch === '\\')) {
      current += ch; if (i + 1 < text.length) current += text[++i]; continue;
    }
    if ('([{'.includes(ch)) { depth++; current += ch; continue; }
    if (')]}'.includes(ch)) { depth = Math.max(0, depth - 1); current += ch; continue; }
    if (depth === 0) {
      let length = 0;
      if (ch === '\r' || ch === '\n' || ch === ';') length = ch === '\r' && next === '\n' ? 2 : 1;
      else if (ch === '&' && next === '&') length = 2;
      else if (ch === '|' && (next === '|' || next === '&')) length = 2;
      else if (ch === '|') length = 1;
      else if (mode !== 'powershell' && ch === '&' && isBashAmpersandSeparator(text, i)) length = 1;
      if (length) {
        flush();
        separator = ch === '\r' || ch === '\n' ? '\n' : text.slice(i, i + length);
        i += length - 1; continue;
      }
    }
    current += ch;
  }
  flush();
  return segments;
}

function splitCommandSegments(command, shell) {
  return splitSegmentsDetailed(command, shell).map((segment) => segment.value);
}

function operatorAt(text, index, mode) {
  const two = text.slice(index, index + 2), ch = text[index];
  if (two === '&&' || two === '||' || two === '|&') return two;
  if (ch === ';' || ch === '|' || ch === '\n' || ch === '\r') return ch === '\r' ? '\n' : ch;
  if (ch === '&' && (mode === 'powershell' || isBashAmpersandSeparator(text, index))) return '&';
  return null;
}

function tokenizeDetailed(command, shell) {
  const text = String(command == null ? '' : command);
  const mode = normalizeShell(shell);
  const tokens = [];
  let value = '', raw = '', quote = null, quoted = false, started = false;
  const flush = () => {
    if (!started) return;
    tokens.push({ value, raw, quoted, operator: false });
    value = ''; raw = ''; quoted = false; started = false;
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i], next = text[i + 1];
    if (quote === 'single') {
      raw += ch;
      if (mode === 'powershell' && ch === "'" && next === "'") {
        raw += text[++i]; value += "'";
      } else if (ch === "'") quote = null;
      else value += ch;
      continue;
    }
    if (quote === 'double') {
      raw += ch;
      if ((mode === 'powershell' && ch === '`') || (mode !== 'powershell' && ch === '\\')) {
        if (i + 1 < text.length) { raw += text[++i]; value += text[i]; }
      } else if (ch === '"') quote = null;
      else value += ch;
      continue;
    }
    if (mode === 'powershell' && ch === '<' && next === '#') {
      flush(); const end = text.indexOf('#>', i + 2);
      i = end === -1 ? text.length : end + 1; continue;
    }
    if (isCommentStart(text, i)) break;
    if (isWhitespace(ch)) { flush(); continue; }
    if (ch === "'" || ch === '"') {
      started = true; quoted = true; raw += ch;
      quote = ch === "'" ? 'single' : 'double'; continue;
    }
    if ((mode === 'powershell' && ch === '`') || (mode !== 'powershell' && ch === '\\')) {
      started = true; raw += ch;
      if (i + 1 < text.length) { raw += text[++i]; value += text[i]; }
      continue;
    }
    const operator = operatorAt(text, i, mode);
    if (operator) {
      flush(); tokens.push({ value: operator, raw: operator, quoted: false, operator: true });
      if (operator.length === 2) i++;
      continue;
    }
    started = true; raw += ch; value += ch;
  }
  flush();
  return tokens;
}

function tokenizeCommand(command, shell) {
  return tokenizeDetailed(command, shell).map((token) => token.value);
}
function basenamePortable(value) {
  const clean = String(value || '').replace(/[\\/]+$/, '');
  const parts = clean.split(/[\\/]/);
  return parts[parts.length - 1] || clean;
}
function normalizeRoot(root) { return basenamePortable(root).toLowerCase().replace(/\.exe$/i, ''); }
function isPathExecutable(value) {
  return /[\\/]/.test(value) || /^[A-Za-z]:/.test(value) || /^~(?:[\\/]|$)/.test(value);
}
function isBareCommandPart(value) { return /^[A-Za-z0-9_][A-Za-z0-9_.:+-]*$/.test(String(value || '')); }
function isEnvironmentAssignment(value) {
  const text = String(value == null ? '' : value);
  if (!/^[A-Za-z_][A-Za-z0-9_]*=[\s\S]*$/.test(text)) return false;
  // `before=$(wc` is a command substitution split across tokens, not a finished
  // assignment; stripping it would promote the next token (`-l`) to a root.
  const opened = (text.match(/\$\(/g) || []).length;
  const closed = (text.match(/\)/g) || []).length;
  return opened <= closed && (text.match(/`/g) || []).length % 2 === 0;
}

function unwrapPermissionCommand(tool, command) {
  const text = String(command == null ? '' : command).trim();
  const expected = String(tool || '').toLowerCase().includes('powershell') ? 'PowerShell' : 'Bash';
  const match = /^(Bash|PowerShell)\(([\s\S]*)\)$/.exec(text);
  return match && match[1] === expected ? match[2] : text;
}

function prefixFor(root, args) {
  if (!root) return [];
  const normalized = normalizeRoot(root), first = String(args[0] || '');
  if (normalized === 'rg' && SAFE_RG_MODES.has(first)) return [root, first];
  const knownFamily = FAMILY_SUBCOMMANDS.get(normalized);
  if (knownFamily?.has(first.toLowerCase())) return [root, first];
  if (['--help', '--version', '-h', '-V'].includes(first)) return [root, first];
  return [root];
}


function prefixIsAutoSuffixClosed(root, prefix) {
  const normalized = normalizeRoot(root);
  if (normalized === 'git') {
    return prefix.length >= 2 && AUTO_SAFE_GIT.has(String(prefix[1]).toLowerCase());
  }
  if (normalized === 'rg') {
    return prefix.length >= 2 && SAFE_RG_MODES.has(String(prefix[1]));
  }
  return AUTO_SUFFIX_CLOSED_ROOTS.has(normalized);
}

function hasRemoteArgument(raw, argv) {
  const values = Array.isArray(argv) ? argv.slice(1).map(String) : [];
  const remotePath = values.some((value) => value.startsWith('\\\\') || value.startsWith('//'));
  const remoteFlag = values.some((value) =>
    /^-{1,2}(?:cimsession|computername|connectionuri|pssession|session)(?:[:=]|$)/i.test(value));
  const remoteUri = /(?:^|[\s'\"])(?:file|ftp|https?|nfs|smb|ssh):\/\//i.test(String(raw || ''));
  return remotePath || remoteFlag || remoteUri;
}

function hasWriteRedirection(command, shell) {
  const text = String(command || ''), mode = normalizeShell(shell);
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote === 'single') {
      if (mode === 'powershell' && ch === "'" && text[i + 1] === "'") i++;
      else if (ch === "'") quote = null;
      continue;
    }
    if (quote === 'double') {
      if ((mode === 'powershell' && ch === '`') || (mode !== 'powershell' && ch === '\\')) i++;
      else if (ch === '"') quote = null;
      continue;
    }
    if (ch === "'") { quote = 'single'; continue; }
    if (ch === '"') { quote = 'double'; continue; }
    if ((mode === 'powershell' && ch === '`') || (mode !== 'powershell' && ch === '\\')) { i++; continue; }
    if (ch === '>' && text[i + 1] !== '&') return true; // 2>&1 is descriptor duplication
  }
  return false;
}

function containsScriptSyntax(command, shell) {
  const text = String(command || '');
  if (/\$\(|`[^`]+`|<\(|>\(/.test(text)) return true;
  return normalizeShell(shell) === 'powershell' && /(?:^|\s)(?:@?\{|@\(|\$\(|\.\s+[^.])/.test(text);
}

function permissionFor(shell, prefix, blocked) {
  const tool = permissionToolFor(shell);
  const root = normalizeRoot(prefix[0]);
  const validPart = (part, index) => isBareCommandPart(part) ||
    (index > 0 && root === 'rg' && SAFE_RG_MODES.has(String(part)));
  if (blocked || !tool || !prefix.length || !prefix.every(validPart)) return null;
  return `${tool}(${prefix.join(' ')} *)`;
}

// `timeout [OPTION] DURATION COMMAND` is stripped by Claude Code's matcher, so
// the family is the inner command. Returns the index of that command, or null
// when the shape is not the documented one, in which case nothing is stripped
// rather than guessed.
const TIMEOUT_VALUE_OPTIONS = new Set(['-s', '-k', '--signal', '--kill-after']);
const TIMEOUT_DURATION = /^[0-9]+(?:\.[0-9]+)?[smhd]?$/;
function skipTimeoutPreamble(details, start) {
  let index = start;
  while (details[index] && details[index].value.startsWith('-')) {
    const option = details[index].value;
    index += 1;
    if (TIMEOUT_VALUE_OPTIONS.has(option) && details[index]) index += 1;
  }
  if (!details[index] || !TIMEOUT_DURATION.test(details[index].value)) return null;
  index += 1;
  return details[index] ? index : null;
}

function deriveBaseInvocation(tool, command, metadata, totalSegments) {
  const shell = normalizeShell(metadata && metadata.shell, tool);
  const details = tokenizeDetailed(command, shell)
    .filter((token) => !token.operator || (shell === 'powershell' && token.value === '&'));
  let index = 0;
  const environment = [];
  const strippedWrappers = [];
  // Claude Code strips a leading env assignment, `command`, `builtin` and a
  // `timeout` preamble before matching, so a rule for the inner command covers
  // the wrapped invocation. Learning the wrapper instead would propose
  // `Bash(timeout *)`, which grants every command it can run.
  if (shell === 'bash') {
    for (let guard = 0; guard < 8; guard += 1) {
      const token = details[index];
      if (!token) break;
      if (isEnvironmentAssignment(token.value)) {
        environment.push(token.value.split('=', 1)[0]); index += 1; continue;
      }
      const name = normalizeRoot(token.value);
      if (name === 'command' || name === 'builtin') {
        strippedWrappers.push(name); index += 1; continue;
      }
      if (name === 'timeout') {
        const inner = skipTimeoutPreamble(details, index + 1);
        if (inner === null) break;
        strippedWrappers.push('timeout'); index = inner; continue;
      }
      break;
    }
  }
  let callOperator = false;
  if (shell === 'powershell' && details[index] && details[index].value === '&') {
    callOperator = true; index++;
  }
  const executable = details[index] || null;
  const executableValue = executable ? executable.value : '';
  const pathExecutable = Boolean(executable && isPathExecutable(executableValue));
  const dynamicExecutable = Boolean(executableValue && /^(?:\$|[(@{\[])/.test(executableValue));
  const root = executableValue && !dynamicExecutable ? basenamePortable(executableValue) : null;
  const argv = executable ? details.slice(index).map((token) => token.value) : [];
  const normalized = normalizeRoot(root);
  const reserved = shell === 'powershell' ? POWERSHELL_RESERVED.has(normalized) : BASH_RESERVED.has(normalized);
  const prefix = prefixFor(root, argv.slice(1));
  const reasons = [];
  if (environment.length) reasons.push('environment-prefix');
  if (strippedWrappers.length) reasons.push('stripped-wrapper');
  if (totalSegments > 1) reasons.push('compound-command');
  if (callOperator) reasons.push('powershell-call-operator');
  if (executable && executable.quoted) reasons.push('quoted-executable');
  if (pathExecutable) reasons.push('path-executable');
  if (dynamicExecutable) reasons.push('dynamic-executable');
  if (reserved) reasons.push('reserved-keyword');
  if (/\*\s*$/.test(String(command || ''))) reasons.push('trailing-wildcard');
  const unknownFamily = FAMILY_ROOTS.has(normalized) && prefix.length < 2;
  if (unknownFamily) reasons.push('family-subcommand-unknown');
  if (hasWriteRedirection(command, shell)) reasons.push('write-redirection');
  if (containsScriptSyntax(command, shell)) reasons.push('script-syntax');
  // An env assignment is deliberately absent. Claude Code strips a leading
  // `VAR=value` before matching, so `Bash(cat *)` already covers
  // `LD_PRELOAD=x cat f`: refusing to propose the rule denies the grant without
  // denying the injection. The reason is kept, and it still bars auto-safe
  // (isAutoSafeCandidate and AUTO_UNSAFE_REASONS both list it), so evidence
  // carrying an injection vector can only ever reach policy through a review.
  const permissionBlocked = pathExecutable || dynamicExecutable || callOperator || reserved ||
    unknownFamily || Boolean(executable && executable.quoted);

  return {
    ...(metadata && typeof metadata === 'object' ? metadata : {}),
    tool: String(tool || permissionToolFor(shell) || ''), shell,
    command: String(command || '').trim(), argv, root, prefix,
    claudePermission: permissionFor(shell, prefix, permissionBlocked),
    risk: 'unknown', autoSafe: false, reasons,
    complex: reasons.some((reason) => COMPLEX_REASONS.has(reason)),
    executable: executableValue || null, environment, callOperator,
    pathExecutable, quotedExecutable: Boolean(executable && executable.quoted),
    dynamicExecutable, reserved,
  };
}

function gitRisk(argv) {
  const args = argv.slice(1);
  if (!args.length || args[0].startsWith('-')) return ['unknown', false, 'git-operation-unknown'];
  const sub = args[0].toLowerCase();
  if (NETWORK_GIT.has(sub)) return ['network', false, 'network-git-operation'];
  if (DESTRUCTIVE_GIT.has(sub)) return ['destructive', false, 'destructive-git-operation'];
  if (WRITE_GIT.has(sub)) return ['write', false, 'write-git-operation'];
  if (SAFE_GIT.has(sub)) return ['read-only', true, 'known-read-only-git-operation'];
  return ['unknown', false, 'git-operation-unknown'];
}

function classifyInvocation(invocation) {
  const result = { ...(invocation || {}) };
  const shell = normalizeShell(result.shell, result.tool);
  let argv = Array.isArray(result.argv) ? result.argv.map(String) : [];
  if (!argv.length && result.command) {
    const base = deriveBaseInvocation(result.tool, result.command, { ...result, shell }, 1);
    // A segment with no executable (bare env assignment, operator-only fragment,
    // comment) derives the same empty argv forever, so recursing never terminates.
    if (Array.isArray(base.argv) && base.argv.length) return classifyInvocation(base);
    Object.assign(result, base, { argv: [] });
  }
  const root = Object.prototype.hasOwnProperty.call(result, 'root')
    ? result.root : (argv[0] ? basenamePortable(argv[0]) : null);
  const normalized = normalizeRoot(root);
  const raw = String(result.command || argv.join(' '));
  const reasons = new Set(Array.isArray(result.reasons) ? result.reasons : []);
  const reserved = Boolean(result.reserved) || (shell === 'powershell'
    ? POWERSHELL_RESERVED.has(normalized) : BASH_RESERVED.has(normalized));
  const scriptSyntax = reasons.has('script-syntax') || containsScriptSyntax(raw, shell);
  const writeRedirection = reasons.has('write-redirection') || hasWriteRedirection(raw, shell);
  const credentialSensitive = CREDENTIAL_ROOTS.has(normalized) || SECRET_WORD_RE.test(raw) ||
    SECRET_PATH_RE.test(raw) || SECRET_VALUE_RE.test(raw);
  const adminSensitive = ADMIN_ROOTS.has(normalized) || /(?:^|\s)-Verb\s+RunAs(?:\s|$)/i.test(raw);
  const environmentPrefix = reasons.has('environment-prefix') ||
    (Array.isArray(result.environment) && result.environment.length > 0);
  if (environmentPrefix) reasons.add('environment-prefix');
  // environmentPrefix is not structure: the matcher strips it, so the command
  // Claude Code sees is the one we derived. It stays out of auto-safe through
  // the reason lists instead.
  const shellStructure = !root || reserved || result.callOperator || result.pathExecutable ||
    result.quotedExecutable || result.dynamicExecutable || scriptSyntax;
  let risk = shellStructure ? 'shell' : 'unknown';
  let knownReadOnly = false;
  if (shellStructure) reasons.add(!root ? 'missing-command-root' : 'shell-structure');

  if (normalized === 'git') {
    const [category, safe, reason] = gitRisk(argv);
    risk = category === 'read-only' && risk === 'unknown' ? 'read-only' : maxRisk(risk, category);
    knownReadOnly = safe && risk === 'read-only'; reasons.add(reason);
  } else if (normalized === 'rg') {
    const unsafeRg = argv.some((arg) => arg === '--pre' || arg.startsWith('--pre='));
    const safeMode = SAFE_RG_MODES.has(String(argv[1] || ''));
    if (unsafeRg) { risk = maxRisk(risk, 'shell'); reasons.add('shell-wrapper-option'); }
    else if (safeMode && !shellStructure) {
      risk = 'read-only'; knownReadOnly = true; reasons.add('known-read-only-rg-mode');
    } else {
      risk = maxRisk(risk, 'unknown'); reasons.add('rg-root-prefix-can-execute-preprocessor');
    }
  } else if (DESTRUCTIVE_ROOTS.has(normalized)) {
    risk = maxRisk(risk, 'destructive'); reasons.add('destructive-command');
  } else if (NETWORK_ROOTS.has(normalized) || hasRemoteArgument(raw, argv)) {
    risk = maxRisk(risk, 'network'); reasons.add('network-command');
  } else if (SHELL_WRAPPERS.has(normalized) || /\.(?:bat|cmd|ps1|sh)$/i.test(String(result.executable || root || ''))) {
    risk = maxRisk(risk, 'shell'); reasons.add('shell-wrapper');
  } else if (WRITE_ROOTS.has(normalized)) {
    risk = maxRisk(risk, 'write'); reasons.add('write-command');
  } else if (READ_ONLY_ROOTS.has(normalized) && !shellStructure) {
    risk = 'read-only'; knownReadOnly = true; reasons.add('known-read-only-command');
  } else if (risk === 'unknown') reasons.add('unknown-command');

  if (writeRedirection) {
    risk = maxRisk(risk, 'write'); knownReadOnly = false; reasons.add('write-redirection');
  }
  if (credentialSensitive) {
    risk = maxRisk(risk, 'credential'); knownReadOnly = false; reasons.add('credential-sensitive');
  }
  if (adminSensitive) {
    risk = maxRisk(risk, 'admin'); knownReadOnly = false; reasons.add('admin-command');
  }
  const prefix = Array.isArray(result.prefix) && result.prefix.length
    ? result.prefix : prefixFor(root, argv.slice(1));
  const suffixClosed = prefixIsAutoSuffixClosed(root, prefix);
  if (knownReadOnly && !suffixClosed) reasons.add('prefix-suffix-unsafe');
  const structuralBlock = shellStructure || writeRedirection || !result.claudePermission || !suffixClosed;
  return {
    ...result, shell, argv, root,
    prefix,
    claudePermission: result.claudePermission == null ? null : result.claudePermission,
    risk, autoSafe: risk === 'read-only' && knownReadOnly && !structuralBlock,
    reasons: [...reasons].sort(),
    complex: [...reasons].some((reason) => COMPLEX_REASONS.has(reason)),
  };
}

function extractInvocations(tool, command, metadata = {}) {
  if (!isCommandTool(tool, metadata)) return [];
  const shell = normalizeShell(metadata.shell, tool);
  const segments = splitSegmentsDetailed(unwrapPermissionCommand(tool, command), shell);
  const attribution = segmentAttribution(segments);
  return segments
    .map((segment, index) => ({
      invocation: deriveBaseInvocation(tool, segment.value, { ...metadata, shell }, segments.length),
      attribution: attribution[index],
    }))
    .filter((entry) => entry.invocation.argv.length)
    .map((entry) => classifyInvocation({ ...entry.invocation, attribution: entry.attribution }));
}

function candidateKey(invocation) {
  if (!invocation || typeof invocation !== 'object') return null;
  if (invocation.kind === 'tool') {
    return typeof invocation.key === 'string' && invocation.key ? invocation.key : null;
  }
  const shell = normalizeShell(invocation.shell, invocation.tool);
  const prefix = Array.isArray(invocation.prefix) && invocation.prefix.length
    ? invocation.prefix : (invocation.root ? [invocation.root] : []);
  // A root that cannot be a command name cannot become a permission either, so
  // shell punctuation and split substitutions never earn a family of their own.
  if (!prefix.length || !isBareCommandPart(prefix[0])) return null;
  return `${shell}:${prefix.map((part) => String(part).trim().toLowerCase()).join(' ')}`;
}

function observationOutcome(observation) {
  if (typeof observation.success === 'boolean') return observation.success ? 'success' : 'failed';
  if (typeof observation.ok === 'boolean') return observation.ok ? 'success' : 'failed';
  if (typeof observation.isError === 'boolean') return observation.isError ? 'failed' : 'success';
  if (typeof observation.is_error === 'boolean') return observation.is_error ? 'failed' : 'success';
  const exitCode = observation.exitCode ?? observation.exit_code ?? observation.code ??
    (observation.result && (observation.result.exitCode ?? observation.result.exit_code));
  if (typeof exitCode === 'number') return exitCode === 0 ? 'success' : 'failed';
  const value = String(observation.outcome ?? observation.status ?? '').trim().toLowerCase();
  if (['success', 'succeeded', 'completed', 'complete', 'ok', 'passed', 'executed'].includes(value)) return 'success';
  if (['failed', 'failure', 'error', 'errored', 'denied', 'rejected', 'cancelled', 'canceled'].includes(value)) return 'failed';
  return 'unknown'; // approval alone is not successful execution evidence
}

// The outer exit status is evidence for a segment only when attribution allows it.
function attributedOutcome(invocation) {
  const outcome = observationOutcome(invocation);
  switch (invocation.attribution) {
    case 'none': return 'unknown';
    case 'success': return outcome === 'success' ? 'success' : 'unknown';
    default: return outcome;
  }
}

function inferredSource(observation) {
  const explicit = observation.source ?? observation.provider ?? observation.agent;
  if (typeof explicit === 'string' && explicit.trim()) return explicit.trim().toLowerCase();
  const tool = String(observation.tool || '').toLowerCase();
  if (tool === 'bash' || tool === 'powershell') return 'claude';
  if (tool.includes('shell_command') || tool.includes('exec_command')) return 'codex';
  return 'unknown';
}

// Retain only the learned prefix; no raw transcript argument enters state.
function sanitizedExample(invocation) {
  const prefix = Array.isArray(invocation.prefix) && invocation.prefix.length
    ? invocation.prefix.map(String) : (invocation.root ? [String(invocation.root)] : []);
  if (!prefix.length) return '<unresolved command>';
  const raw = String(invocation.command || '');
  const suffix = SECRET_WORD_RE.test(raw) || SECRET_PATH_RE.test(raw) || SECRET_VALUE_RE.test(raw)
    ? ' <redacted>'
    : ((invocation.argv || []).length > prefix.length ? ' <args>' : '');
  return `${prefix.join(' ')}${suffix}`.slice(0, 160);
}
function maxRisk(left, right) {
  return (RISK_RANK.get(right) ?? 1) > (RISK_RANK.get(left) ?? 1) ? right : left;
}

function expandObservation(observation) {
  if (!observation || typeof observation !== 'object') return [];
  // A non-shell tool has no command line to split; one call is one family.
  if (observation.kind === 'tool' || (observation.tool && isLearnableTool(observation.tool))) {
    const invocation = toolInvocation(observation.tool, observation.command ?? observation.target,
      observation);
    return invocation ? [invocation] : [];
  }
  if (observation.root && Array.isArray(observation.argv)) return [classifyInvocation(observation)];
  if (observation.command != null && observation.tool) {
    return extractInvocations(observation.tool, observation.command, observation);
  }
  return [];
}

function isAutoSafeCandidate(candidate) {
  if (!candidate || typeof candidate !== 'object') return false;
  const deterministicSafe = candidate.baseAutoSafe ?? candidate.autoSafe;
  if (!deterministicSafe || candidate.risk !== 'read-only' || !candidate.claudePermission) return false;
  const forbidden = new Set([
    'admin-command', 'credential-sensitive', 'destructive-command',
    'dynamic-executable', 'environment-prefix', 'path-executable',
    'powershell-call-operator', 'prefix-suffix-unsafe',
    'reserved-keyword', 'script-syntax', 'shell-structure', 'shell-wrapper',
    'shell-wrapper-option', 'write-command', 'write-redirection',
  ]);
  if ((candidate.reasons || []).some((reason) => forbidden.has(reason))) return false;
  if (!candidate.counts) return true;
  const threshold = Number.isFinite(candidate.threshold) && candidate.threshold > 0
    ? Math.floor(candidate.threshold) : 3;
  return candidate.counts.success >= threshold && candidate.counts.failed === 0;
}

function aggregateObservations(observations, options = {}) {
  const threshold = Number.isFinite(options.threshold) && options.threshold > 0
    ? Math.floor(options.threshold) : 3;
  const groups = new Map();

  for (const raw of Array.isArray(observations) ? observations : []) {
    for (const invocation of expandObservation(raw)) {
      const key = candidateKey(invocation);
      if (!key) continue;
      let candidate = groups.get(key);
      if (!candidate) {
        candidate = {
          key, tool: invocation.tool, kind: invocation.kind === 'tool' ? 'tool' : 'shell',
          shell: invocation.shell, root: invocation.root,
          prefix: [...invocation.prefix], claudePermission: invocation.claudePermission,
          risk: invocation.risk, baseAutoSafe: invocation.autoSafe, autoSafe: false,
          reasons: new Set(invocation.reasons), complex: Boolean(invocation.complex),
          counts: { success: 0, failed: 0, unknown: 0, total: 0 },
          sources: new Set(), examples: new Set(), threshold,
        };
        groups.set(key, candidate);
      } else {
        candidate.risk = maxRisk(candidate.risk, invocation.risk);
        candidate.baseAutoSafe = candidate.baseAutoSafe && invocation.autoSafe;
        candidate.complex = candidate.complex || Boolean(invocation.complex);
        if (candidate.claudePermission !== invocation.claudePermission) candidate.claudePermission = null;
        for (const reason of invocation.reasons) candidate.reasons.add(reason);
      }

      const outcome = attributedOutcome(invocation);
      // Surfaced in review so a reader can tell evidence was withheld rather
      // than never observed.
      if (outcome === 'unknown' && observationOutcome(invocation) !== 'unknown') {
        candidate.reasons.add('outcome-not-attributable');
      }
      candidate.counts[outcome]++;
      candidate.counts.total++;
      candidate.sources.add(inferredSource(invocation));
      if (candidate.examples.size < 3) candidate.examples.add(sanitizedExample(invocation));
    }
  }

  const candidates = [];
  for (const candidate of groups.values()) {
    const finalized = {
      ...candidate,
      reasons: [...candidate.reasons].sort(),
      sources: [...candidate.sources].sort(),
      examples: [...candidate.examples],
      sourceCount: candidate.sources.size,
      successfulRuns: candidate.counts.success,
      failedRuns: candidate.counts.failed,
      unknownRuns: candidate.counts.unknown,
      meetsThreshold: candidate.counts.success >= threshold,
    };
    finalized.autoSafe = isAutoSafeCandidate(finalized);
    finalized.disposition = finalized.autoSafe ? 'auto-safe'
      : (finalized.meetsThreshold ? 'review' : 'observe');
    candidates.push(finalized);
  }
  return candidates.sort((a, b) => a.key.localeCompare(b.key));
}

module.exports = {
  isLearnableTool,
  toolInvocation,
  tokenizeCommand,
  splitCommandSegments,
  extractInvocations,
  classifyInvocation,
  candidateKey,
  aggregateObservations,
  isAutoSafeCandidate,
  // Exported so the drift test can assert this gate and the exporter's
  // independent copy still describe the same set.
  AUTO_SUFFIX_CLOSED_ROOTS,
  AUTO_SAFE_GIT,
  // Exported so a stored candidate's flag can be re-derived from its reasons
  // rather than carried forward.
  COMPLEX_REASONS,
};
