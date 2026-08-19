'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  tokenizeCommand,
  splitCommandSegments,
  extractInvocations,
  classifyInvocation,
  candidateKey,
  aggregateObservations,
  isAutoSafeCandidate,
  AUTO_SUFFIX_CLOSED_ROOTS,
} = require('../src/auto-learn');

// One auto-safe grant is a pattern, not a replay of what was seen: `Bash(echo *)`
// also matches `echo <anything> > <anywhere>`, because a trailing `*` admits
// shell syntax and no Claude Code allow pattern can exclude a redirection. A root
// therefore qualifies only when no argument can reach its stdout.
const first = (tool, command, metadata) => extractInvocations(tool, command, metadata)[0];

test('a root that puts its argument on stdout is read-only but never auto-safe', () => {
  for (const [tool, command] of [
    ['Bash', 'echo hello'],
    ['Bash', 'printf %s hi'],
    ['Bash', 'basename /tmp/x'],
    ['PowerShell', 'Write-Output hi'],
    ['PowerShell', 'Get-Date -Format yyyy'],
  ]) {
    const item = first(tool, command);
    assert.equal(item.autoSafe, false, `${command} must not be auto-safe`);
    // Still classified read-only, so it remains available as a review candidate.
    assert.equal(item.risk, 'read-only', `${command} should stay read-only`);
    assert.ok(item.reasons.includes('prefix-suffix-unsafe'), `${command} should say why`);
  }
});

test('fixed-output roots stay auto-safe, and the accepted residual is truncation only', () => {
  for (const [tool, command] of [
    ['Bash', 'whoami'], ['Bash', 'pwd'], ['Bash', 'uname -a'],
    ['PowerShell', 'Get-Culture'], ['PowerShell', 'Get-TimeZone'],
  ]) {
    const item = first(tool, command);
    assert.equal(item.autoSafe, true, `${command} should stay auto-safe`);
  }
  // The residual, asserted so it stays a decision rather than an accident: the
  // emitted pattern still admits `whoami > f`. Fixed content, arbitrary path.
  assert.equal(first('Bash', 'whoami').claudePermission, 'Bash(whoami *)');
  // The observed redirection form is still refused on its own evidence.
  assert.equal(first('Bash', 'whoami > /tmp/f').autoSafe, false);
});

test('no auto-safe root can emit its own argument, so none is a content-write primitive', () => {
  for (const root of ['echo', 'printf', 'basename', 'dirname', 'get-date',
    'write-output', 'write-verbose', 'write-warning']) {
    assert.equal(AUTO_SUFFIX_CLOSED_ROOTS.has(root), false, `${root} must not be auto-safe`);
  }
});

test('git cat-file stays reviewable but is never auto-applied', () => {
  // `git cat-file --textconv` runs the diff driver the repository names.
  const catFile = first('Bash', 'git cat-file -p HEAD');
  assert.equal(catFile.risk, 'read-only');
  assert.equal(catFile.autoSafe, false);
  assert.equal(catFile.claudePermission, 'Bash(git cat-file *)');
  // The rest of the safe-git set is unaffected.
  assert.equal(first('Bash', 'git status --short').autoSafe, true);
  assert.equal(first('Bash', 'git rev-parse HEAD').autoSafe, true);
});

test('tokenizes quoted arguments, assignments, and operators without shattering values', () => {
  assert.deepEqual(
    tokenizeCommand('FOO="two words" BAR=plain git status --short', 'bash'),
    ['FOO=two words', 'BAR=plain', 'git', 'status', '--short'],
  );
  assert.deepEqual(
    tokenizeCommand('& "C:\\Program Files\\Acme\\tool.exe" \'two words\'', 'powershell'),
    ['&', 'C:\\Program Files\\Acme\\tool.exe', 'two words'],
  );
  assert.deepEqual(
    tokenizeCommand('printf "%s" "a && b" && git status', 'bash'),
    ['printf', '%s', 'a && b', '&&', 'git', 'status'],
  );
  assert.deepEqual(
    tokenizeCommand("Get-Content 'a|b'; Get-Date", 'powershell'),
    ['Get-Content', 'a|b', ';', 'Get-Date'],
  );
});

test('splits all Bash roots while respecting quotes, groups, and descriptor redirects', () => {
  assert.deepEqual(
    splitCommandSegments("printf '%s' 'a && b' && git status | rg 'x;y'; npm test", 'bash'),
    ["printf '%s' 'a && b'", 'git status', "rg 'x;y'", 'npm test'],
  );
  assert.deepEqual(
    splitCommandSegments('echo $(printf "a;b") && pwd', 'bash'),
    ['echo $(printf "a;b")', 'pwd'],
  );
  assert.deepEqual(splitCommandSegments('printf x 2>&1 & pwd', 'bash'), ['printf x 2>&1', 'pwd']);
});

test('splits PowerShell chains without treating call operator as a separator', () => {
  const command = "Get-ChildItem 'A;B' | Select-Object Name; & \"C:\\Program Files\\Acme\\tool.exe\" --version; Get-Content \"x|y\"";
  assert.deepEqual(splitCommandSegments(command, 'powershell'), [
    "Get-ChildItem 'A;B'",
    'Select-Object Name',
    '& "C:\\Program Files\\Acme\\tool.exe" --version',
    'Get-Content "x|y"',
  ]);
});

test('extracts later roots in compound commands and classifies each independently', () => {
  const found = extractInvocations('Bash', 'git status && npm test | rg TODO', {
    source: 'claude', outcome: 'success',
  });
  assert.deepEqual(found.map((item) => item.root), ['git', 'npm', 'rg']);
  assert.ok(found.every((item) => item.complex));
  assert.deepEqual(found[0].prefix, ['git', 'status']);
  assert.equal(found[0].claudePermission, 'Bash(git status *)');
  assert.equal(found[0].risk, 'read-only');
  assert.equal(found[0].autoSafe, true);
  assert.equal(found[1].risk, 'shell');
  assert.equal(found[1].autoSafe, false);
  assert.equal(found[2].risk, 'unknown');
  assert.equal(found[2].autoSafe, false);
});

test('strips direct env assignments but keeps them out of automatic policy', () => {
  const [item] = extractInvocations('Bash', 'FOO="two words" BAR=plain git status');
  assert.deepEqual(item.argv, ['git', 'status']);
  assert.deepEqual(item.environment, ['FOO', 'BAR']);
  assert.equal(item.root, 'git');
  assert.equal(item.claudePermission, null);
  assert.ok(item.reasons.includes('environment-prefix'));
  assert.equal(item.risk, 'shell');
  assert.equal(item.autoSafe, false);

  const [preloaded] = extractInvocations('Bash', 'LD_PRELOAD=/tmp/evil.so cat README.md');
  assert.deepEqual(preloaded.environment, ['LD_PRELOAD']);
  assert.equal(preloaded.claudePermission, null);
  assert.equal(preloaded.autoSafe, false);
});

test('quoted executable paths never become malformed wildcard roots', () => {
  const [item] = extractInvocations('Bash', '"C:/Program Files/Acme/tool.exe" --version');
  assert.equal(item.root, 'tool.exe');
  assert.deepEqual(item.argv, ['C:/Program Files/Acme/tool.exe', '--version']);
  assert.equal(item.claudePermission, null);
  assert.equal(item.autoSafe, false);
  assert.ok(item.reasons.includes('quoted-executable'));
  assert.ok(item.reasons.includes('path-executable'));
  assert.doesNotMatch(JSON.stringify(item), /Bash\("C:\/Program \*\)/);
});

test('PowerShell call operator remains review-only instead of broad wildcarding ampersand', () => {
  const [item] = extractInvocations('PowerShell', '& "C:\\Program Files\\Acme\\tool.exe" --version');
  assert.equal(item.root, 'tool.exe');
  assert.equal(item.callOperator, true);
  assert.equal(item.claudePermission, null);
  assert.equal(item.risk, 'shell');
  assert.equal(item.autoSafe, false);
  assert.ok(item.reasons.includes('powershell-call-operator'));
});

test('reserved and dynamic command forms never seed permissions', () => {
  const [bash] = extractInvocations('Bash', 'for item in one two');
  assert.equal(bash.root, 'for');
  assert.equal(bash.claudePermission, null);
  assert.ok(bash.reasons.includes('reserved-keyword'));

  const [powershell] = extractInvocations('PowerShell', 'if ($ok) { Get-ChildItem }');
  assert.equal(powershell.root, 'if');
  assert.equal(powershell.claudePermission, null);

  const [dynamic] = extractInvocations('PowerShell', '$command --version');
  assert.equal(dynamic.root, null);
  assert.equal(dynamic.claudePermission, null);
  assert.ok(dynamic.reasons.includes('dynamic-executable'));
});

test('trailing wildcard input remains stable and never gains a second wildcard', () => {
  const [bash] = extractInvocations('Bash', 'git *');
  assert.equal(bash.claudePermission, null);
  assert.ok(bash.reasons.includes('trailing-wildcard'));

  const [wrapped] = extractInvocations('Bash', 'Bash(git *)');
  assert.equal(wrapped.root, 'git');
  assert.equal(wrapped.claudePermission, null);

  const [powershell] = extractInvocations('PowerShell', 'Get-ChildItem *');
  assert.equal(powershell.claudePermission, 'PowerShell(Get-ChildItem *)');
  assert.equal(powershell.autoSafe, false);
  assert.ok(powershell.reasons.includes('prefix-suffix-unsafe'));
});

test('classifies destructive, admin, network, credential, shell, and write risks', () => {
  const cases = [
    ['Bash', 'rm -rf build', 'destructive'],
    ['Bash', 'sudo ls', 'admin'],
    ['Bash', 'curl https://example.com', 'network'],
    ['PowerShell', 'Get-Content ~/.ssh/id_rsa', 'credential'],
    ['Bash', 'bash -c "echo hi"', 'shell'],
    ['PowerShell', 'Set-Content out.txt value', 'write'],
    ['Bash', 'git reset --hard', 'destructive'],
    ['Bash', 'git push origin main', 'network'],
    ['Bash', 'git commit -m test', 'write'],
  ];
  for (const [tool, command, risk] of cases) {
    const [item] = extractInvocations(tool, command);
    assert.equal(item.risk, risk, command);
    assert.equal(item.autoSafe, false, command);
  }
});

test('remote paths and PowerShell remoting flags never become automatic reads', () => {
  const cases = [
    ['Get-ChildItem \\\\server\\share'],
    ['Get-CimInstance -ComputerName server Win32_OperatingSystem'],
    ['Get-ChildItem -PSSession session'],
  ];
  for (const [command] of cases) {
    const [item] = extractInvocations('PowerShell', command);
    assert.equal(item.risk, 'network', command);
    assert.equal(item.autoSafe, false, command);
  }
});

test('stateful date and hostname executables are never auto-safe', () => {
  const cases = [
    ['Bash', 'date'],
    ['Bash', 'hostname'],
    ['PowerShell', 'date.exe'],
    ['PowerShell', 'hostname.exe'],
  ];
  for (const [tool, command] of cases) {
    const [item] = extractInvocations(tool, command);
    assert.equal(item.autoSafe, false, command);
  }
});

test('only known read-only roots and narrow mixed-root subcommands are auto-safe', () => {
  const safe = [
    ['Bash', 'git status --short'],
    ['Bash', 'git rev-parse --show-toplevel'],
    ['Bash', 'rg --files'],
  ];
  for (const [tool, command] of safe) {
    const [item] = extractInvocations(tool, command);
    assert.equal(item.risk, 'read-only', command);
    assert.equal(item.autoSafe, true, command);
  }
  const reviewOnly = [
    ['Bash', 'cat README.md'],
    ['PowerShell', 'Get-Content README.md'],
    ['PowerShell', 'Get-ChildItem -LiteralPath .'],
    ['PowerShell', 'Test-Path README.md'],
  ];
  for (const [tool, command] of reviewOnly) {
    const [item] = extractInvocations(tool, command);
    assert.equal(item.risk, 'read-only', command);
    assert.equal(item.autoSafe, false, command);
    assert.ok(item.reasons.includes('prefix-suffix-unsafe'), command);
  }
  const [unknown] = extractInvocations('Bash', 'custom-tool inspect');
  assert.equal(unknown.risk, 'unknown');
  assert.equal(unknown.autoSafe, false);
  const [preprocessor] = extractInvocations('Bash', 'rg --pre processor TODO');
  assert.equal(preprocessor.risk, 'shell');
  assert.equal(preprocessor.autoSafe, false);
  const [rgSearch] = extractInvocations('Bash', 'rg TODO');
  assert.deepEqual(rgSearch.prefix, ['rg']);
  assert.equal(rgSearch.autoSafe, false);
  const [rgFiles] = extractInvocations('Bash', 'rg --files');
  assert.deepEqual(rgFiles.prefix, ['rg', '--files']);
  assert.equal(rgFiles.autoSafe, true);
  const [redirect] = extractInvocations('Bash', 'git status > status.txt');
  assert.equal(redirect.risk, 'write');
  assert.equal(redirect.autoSafe, false);
});

test('mixed-capability families emit a narrow prefix and permission', () => {
  const [status] = extractInvocations('Bash', 'git status --short');
  assert.deepEqual(status.prefix, ['git', 'status']);
  assert.equal(status.claudePermission, 'Bash(git status *)');
  assert.notEqual(status.claudePermission, 'Bash(git *)');

  const [npm] = extractInvocations('Bash', 'npm test');
  assert.deepEqual(npm.prefix, ['npm', 'test']);
  assert.equal(npm.claudePermission, 'Bash(npm test *)');
  assert.equal(npm.autoSafe, false);
});

// Get-Culture rather than Get-Date: `Get-Date -Format "'text'"` puts its own
// argument on stdout, so it is no longer suffix-closed (see the redirection
// tests below).
test('classifyInvocation enriches an independently supplied record', () => {
  const item = classifyInvocation({ tool: 'PowerShell', command: 'Get-Culture', source: 'claude' });
  assert.equal(item.root, 'Get-Culture');
  assert.deepEqual(item.argv, ['Get-Culture']);
  assert.equal(item.risk, 'read-only');
  assert.equal(item.autoSafe, true);
  assert.equal(item.source, 'claude');
});

test('candidateKey is case-stable and follows the exported prefix contract', () => {
  const [one] = extractInvocations('PowerShell', 'Get-ChildItem .');
  const [two] = extractInvocations('PowerShell', 'get-childitem C:\\Temp');
  assert.equal(candidateKey(one), 'powershell:get-childitem');
  assert.equal(candidateKey(one), candidateKey(two));
  const [git] = extractInvocations('Bash', 'git status --short');
  assert.equal(candidateKey(git), 'bash:git status');
  assert.equal(candidateKey({ shell: 'bash', root: null, prefix: [] }), null);
});

test('aggregates execution outcomes and source sets without counting approval as success', () => {
  const [candidate] = aggregateObservations([
    { tool: 'Bash', command: 'git status --short', source: 'claude', outcome: 'success' },
    { tool: 'shell_command', command: 'git status', shell: 'bash', source: 'codex', exitCode: 0 },
    { tool: 'Bash', command: 'git status --porcelain', source: 'claude', success: true },
    { tool: 'Bash', command: 'git status', source: 'claude', status: 'approved' },
  ]);
  assert.deepEqual(candidate.counts, { success: 3, failed: 0, unknown: 1, total: 4 });
  assert.equal(candidate.successfulRuns, 3);
  assert.equal(candidate.unknownRuns, 1);
  assert.deepEqual(candidate.sources, ['claude', 'codex']);
  assert.equal(candidate.sourceCount, 2);
  assert.equal(candidate.meetsThreshold, true);
  assert.equal(candidate.autoSafe, true);
  assert.equal(candidate.disposition, 'auto-safe');
  assert.equal(candidate.claudePermission, 'Bash(git status *)');
  assert.equal(isAutoSafeCandidate(candidate), true);
});

test('a confirmed failure blocks auto application even after threshold', () => {
  const [candidate] = aggregateObservations([
    { tool: 'Bash', command: 'git status', outcome: 'success' },
    { tool: 'Bash', command: 'git status', outcome: 'success' },
    { tool: 'Bash', command: 'git status', outcome: 'success' },
    { tool: 'Bash', command: 'git status', outcome: 'failed' },
  ]);
  assert.equal(candidate.meetsThreshold, true);
  assert.equal(candidate.autoSafe, false);
  assert.equal(candidate.disposition, 'review');
});

test('threshold can change but never makes risky roots auto-safe', () => {
  const candidates = aggregateObservations([
    { tool: 'Bash', command: 'rm -rf build', outcome: 'success' },
    { tool: 'Bash', command: 'rm -rf dist', outcome: 'success' },
    { tool: 'Bash', command: 'git status', outcome: 'success' },
    { tool: 'Bash', command: 'git status --short', outcome: 'success' },
    { tool: 'Bash', command: 'git diff', outcome: 'success' },
    { tool: 'Bash', command: 'git diff --stat', outcome: 'success' },
  ], { threshold: 2 });
  const rm = candidates.find((item) => item.root === 'rm');
  const git = candidates.find((item) => item.prefix[1] === 'status');
  const diff = candidates.find((item) => item.prefix[1] === 'diff');
  assert.equal(rm.meetsThreshold, true);
  assert.equal(rm.autoSafe, false);
  assert.equal(rm.disposition, 'review');
  assert.equal(git.autoSafe, true);
  assert.equal(diff.meetsThreshold, true);
  assert.equal(diff.autoSafe, false);
  assert.equal(diff.disposition, 'review');
});

test('aggregate examples are minimal and contain no transcript secret values', () => {
  const token = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456';
  const [candidate] = aggregateObservations([{
    tool: 'Bash',
    command: `curl -H "Authorization: Bearer ${token}" https://user:password@example.com/private?token=${token}`,
    outcome: 'success', source: 'claude',
  }], { threshold: 1 });
  assert.equal(candidate.risk, 'credential');
  assert.equal(candidate.autoSafe, false);
  assert.match(candidate.examples[0], /<redacted>/);
  assert.doesNotMatch(candidate.examples[0], /ABCDEFGHIJKLMNOPQRSTUVWXYZ|password@example|private\?token/);
  assert.doesNotMatch(JSON.stringify(candidate), new RegExp(token));
});

test('unknown argument values are represented by placeholders, not copied', () => {
  const [candidate] = aggregateObservations([{
    tool: 'Bash', command: 'git status --short very-private-worktree-name', outcome: 'success',
  }], { threshold: 1 });
  assert.match(candidate.examples[0], /<args>/);
  assert.doesNotMatch(candidate.examples[0], /very-private-worktree-name/);
});

test('family prefixes never persist private positional values or paths', () => {
  const privatePath = 'D:\\Clients\\PrivateCase.dll';
  const [dotnet] = extractInvocations('PowerShell', `dotnet ${privatePath}`);
  assert.deepEqual(dotnet.prefix, ['dotnet']);
  assert.equal(dotnet.claudePermission, null);
  assert.equal(dotnet.complex, true);
  const [candidate] = aggregateObservations([{
    tool: 'PowerShell', command: `dotnet ${privatePath}`, outcome: 'success',
  }], { threshold: 1 });
  assert.doesNotMatch(JSON.stringify(candidate), /PrivateCase|Clients/);
});

test('non-command tools are ignored unless explicit shell metadata is supplied', () => {
  assert.deepEqual(extractInvocations('Read', 'git status'), []);
  const [codexLike] = extractInvocations('custom_exec', 'git status', { shell: 'bash' });
  assert.equal(codexLike.root, 'git');
});

test('segments that carry no executable terminate instead of recursing forever', () => {
  // A bare env assignment, an operator-only fragment, a lone PowerShell call
  // operator, and a comment all tokenize to zero executables. Re-deriving them
  // returns the same empty argv, so the classifier must not recurse on it.
  for (const [tool, command] of [
    ['Bash', 'FOO=bar'], ['Bash', 'TB="C:/x/y"'], ['Bash', '&&'], ['Bash', '|'],
    ['Bash', ';'], ['Bash', '#comment'], ['PowerShell', '&'],
  ]) {
    const invocation = classifyInvocation({ tool, command });
    assert.equal(invocation.root, null);
    assert.equal(invocation.claudePermission, null);
    assert.equal(candidateKey(invocation), null);
    assert.deepEqual(extractInvocations(tool, command), []);
  }
  assert.deepEqual(aggregateObservations([{ tool: 'Bash', command: 'FOO=bar', status: 'success' }],
    { threshold: 1 }), []);
});

test('heredoc and here-string bodies are data, never command roots', () => {
  const script = [
    "cat > /tmp/x.py <<'EOF'", 'import os', 'def main():', '    print(1)', 'EOF',
    'python /tmp/x.py',
  ].join('\n');
  assert.deepEqual(extractInvocations('Bash', script).map((item) => item.root), ['cat', 'python']);

  // Two bodies queued from separate lines, one of them tab-stripped.
  const twin = ['cat <<-A > a', 'body A', 'A', 'cat <<B > b', 'body B', 'B', 'ls'].join('\n');
  assert.deepEqual(extractInvocations('Bash', twin).map((item) => item.root), ['cat', 'cat', 'ls']);

  // A body nested inside a command substitution, with quotes of its own.
  const commit = [
    'git commit -m "$(cat <<\'EOF\'',  'fix: it said "Always X" -- a hard rule',
    'achieve actually', 'EOF', ')\"',
  ].join('\n');
  assert.deepEqual(extractInvocations('Bash', commit).map((item) => item.root), ['git']);

  // A PowerShell here-string body stays out of the command stream too.
  const here = ["git commit -m @'", 'line one', 'Get-ChildItem C:\\', "'@", 'ls'].join('\n');
  assert.deepEqual(extractInvocations('PowerShell', here).map((item) => item.root), ['git', 'ls']);
});

test('constructs that only look like heredocs keep their commands', () => {
  assert.deepEqual(extractInvocations('Bash', 'rg foo <<< "DATA"').map((item) => item.root), ['rg']);
  assert.deepEqual(extractInvocations('Bash', 'echo $((1 << 2))\nls').map((item) => item.root),
    ['echo', 'ls']);
  assert.deepEqual(extractInvocations('Bash', 'echo "a << b"').map((item) => item.root), ['echo']);
  // A split command substitution is not a finished env assignment, so the flag
  // that follows it must never be promoted to a command root.
  assert.ok(!extractInvocations('Bash', 'before=$(wc -l < f.cs)\nsed -i 1d f.cs')
    .some((item) => item.root === '-l'));
  assert.deepEqual(extractInvocations('Bash', 'FOO=bar ls -la').map((item) => item.root), ['ls']);
});

test('one exit status is only credited to the segments it provably covers', () => {
  const counts = (command, status) => Object.fromEntries(
    aggregateObservations([{ tool: 'Bash', command, status }], { threshold: 1 })
      .map((item) => [item.key.replace('bash:', ''), item.counts]));

  // A single command owns its outcome in both directions.
  const okCounts = counts('git status', 'success')['git status'];
  assert.equal(okCounts.success, 1);
  assert.equal(okCounts.failed, 0);
  assert.equal(okCounts.unknown, 0);
  const failCounts = counts('git status', 'failed')['git status'];
  assert.equal(failCounts.success, 0);
  assert.equal(failCounts.failed, 1);
  assert.equal(failCounts.unknown, 0);

  // An all-`&&` chain proves every link ran and exited 0, but a failure could
  // have come from any link, so it is credited to none of them.
  const chain = counts('git status && npm test', 'success');
  assert.equal(chain['git status'].success, 1);
  assert.equal(chain['npm test'].success, 1);
  const broken = counts('git status && npm test', 'failed');
  assert.equal(broken['git status'].failed, 0);
  assert.equal(broken['git status'].unknown, 1);

  // Only the last segment of a `;` chain carries the overall status. `false`
  // cannot succeed, and must not inherit a success from its neighbours.
  const sequence = counts('git status; false; rg --version', 'success');
  assert.equal(sequence.false.success, 0);
  assert.equal(sequence['git status'].success, 0);
  assert.equal(sequence['rg --version'].success, 1);

  // A pipeline reports its last stage; `||` proves nothing about either side.
  assert.equal(counts('docker ps | rg foo', 'success').rg.success, 1);
  assert.equal(counts('docker ps | rg foo', 'success')['docker ps'].unknown, 1);
  const either = counts('make build || echo fallback', 'success');
  assert.equal(either.make.unknown, 1);
  assert.equal(either.echo.unknown, 1);
});
