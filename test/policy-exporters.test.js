'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  renderCodexRules,
  validateCodexRulesText,
  renderClaudePermissions,
  mergeClaudeAllow,
  mergeGeneratedCodexRules,
} = require('../src/policy-exporters');

function candidate(prefix, extra = {}) {
  return { autoSafe: true, risk: 'low', prefix, ...extra };
}

function compact(value) {
  return String(value).replace(/, /g, ',');
}

function manualRule(pattern) {
  const example = pattern.join(' ');
  return [
    'prefix_rule(',
    '    pattern = ' + JSON.stringify(pattern) + ',',
    '    decision = ' + JSON.stringify('allow') + ',',
    '    justification = ' + JSON.stringify('test rule') + ',',
    '    match = [' + JSON.stringify(example) + '],',
    '    not_match = [' + JSON.stringify('__not_match__') + '],',
    ')',
    '',
  ].join('\n');
}

test('Codex renderer is deterministic and unions strict auto-safe Git subcommands', () => {
  const quote = String.fromCharCode(34);
  const candidates = [
    candidate(['git', 'status'], { successCount: 3, justification: 'safe ' + quote + 'reason\nnext' }),
    candidate(['git', 'rev-parse'], { successCount: 2 }),
  ];
  const rendered = renderCodexRules(candidates);
  assert.equal(rendered, renderCodexRules(candidates.slice().reverse()));
  assert.ok(rendered.includes('# Generator format version: 1'));
  assert.ok(compact(rendered).includes('pattern = ' + JSON.stringify(['git', ['rev-parse', 'status']])));
  assert.ok(rendered.includes('decision = ' + JSON.stringify('allow')));
  assert.ok(rendered.includes('match = ['));
  assert.ok(rendered.includes('not_match = ['));
  assert.ok(rendered.includes('git push'));
  assert.ok(rendered.includes(JSON.stringify('safe ' + quote + 'reason next')));
  assert.deepEqual(validateCodexRulesText(rendered), { valid: true, errors: [] });
});

test('Codex auto-safe mode fails closed on unsafe or unrepresentable candidates', () => {
  const rendered = renderCodexRules([
    { autoSafe: false, risk: 'low', prefix: ['rg', '--files'] },
    candidate(['rm', '-rf']),
    candidate(['curl', '--head']),
    candidate(['git', 'push']),
    candidate(['bash', '-lc', 'rg --files']),
    candidate(['rg', '*.js']),
    candidate(['rg', '--files'], { complex: true }),
    candidate(['rg', '--files'], { secretBearing: true }),
    candidate(['rg']),
    candidate(['date']),
    candidate(['hostname']),
    candidate(['cat']),
    candidate(['Get-Content']),
    candidate(['Get-ChildItem']),
    candidate(['Test-Path']),
    candidate(['git', 'diff']),
    candidate(['git', 'status'], { reasons: ['environment-prefix'] }),
    candidate(['git', 'rev-parse'], { reasons: ['remote-argument'] }),
    candidate(['rg', '--files'], { reasons: ['network-command'] }),
  ]);
  assert.ok(rendered.includes('No auto-safe command prefixes were eligible'));
  assert.equal((rendered.match(/prefix_rule\(/g) || []).length, 0);
});

test('explicitly reviewed Codex export remains narrow and rejects broad wrappers and secrets', () => {
  const reviewed = renderCodexRules([
    { prefix: ['curl', '--head'] },
    { autoSafe: false, prefix: ['git', 'diff'] },
    { prefix: ['powershell.exe', '-Command', 'Get-ChildItem'], wrapper: true },
    { prefix: ['powershell.exe', '-File', 'D:\\tools\\audit.ps1', 'scan'], wrapper: true },
    { prefix: ['tool', 'TOKEN=secret'] },
  ], { includeReviewed: true });
  assert.ok(compact(reviewed).includes('pattern = ' + JSON.stringify(['curl', '--head'])));
  assert.ok(compact(reviewed).includes('pattern = ' + JSON.stringify(['git', 'diff'])));
  assert.ok(compact(reviewed).includes('pattern = ' + JSON.stringify(['powershell.exe', '-File', 'D:\\tools\\audit.ps1', 'scan'])));
  assert.ok(!reviewed.includes('-Command'));
  assert.ok(!reviewed.includes('TOKEN=secret'));
  assert.equal(validateCodexRulesText(reviewed).valid, true);
});

test('Codex validator rejects malformed and dangerously broad generated rules', () => {
  assert.equal(validateCodexRulesText('prefix_rule(').valid, false);
  for (const pattern of [
    ['powershell.exe', '-Command'],
    ['python'],
    ['curl'],
    ['git'],
    ['rg', '*.js'],
  ]) {
    const result = validateCodexRulesText(manualRule(pattern));
    assert.equal(result.valid, false, JSON.stringify({ pattern, result }));
  }
  assert.equal(validateCodexRulesText('dangerous_call()\n').valid, false);
});

test('Claude renderer emits only vetted root wildcards', () => {
  const permissions = renderClaudePermissions([
    candidate(['rg', '--files'], { tool: 'Bash', claudePermission: 'Bash(rg --files *)' }),
    candidate(['Get-ChildItem'], { shell: 'powershell' }),
    candidate(['Get-Content'], { shell: 'powershell' }),
    candidate(['Test-Path'], { shell: 'powershell' }),
    candidate(['cat'], { tool: 'Bash', claudePermission: 'Bash(cat *)' }),
    candidate(['date'], { tool: 'Bash', claudePermission: 'Bash(date *)' }),
    candidate(['hostname'], { tool: 'Bash', claudePermission: 'Bash(hostname *)' }),
    candidate(['git', 'status'], { tool: 'Bash', claudePermission: 'Bash(git status *)' }),
    candidate(['git', 'rev-parse'], {
      tool: 'Bash', claudePermission: 'Bash(git rev-parse *)', reasons: ['environment-prefix'],
    }),
    candidate(['rm'], { tool: 'Bash', claudePermission: 'Bash(rm *)' }),
    candidate(['curl'], { tool: 'Bash', claudePermission: 'Bash(curl *)' }),
    candidate(['anything'], { tool: 'PowerShell', claudePermission: 'PowerShell(& *)' }),
    { autoSafe: false, root: 'cat', tool: 'Bash' },
  ]);
  assert.deepEqual(permissions, ['Bash(git status *)', 'Bash(rg --files *)']);
});

// This gate is a second, independent copy of the learner's. Feed it candidates
// already flagged autoSafe — as if the learner's gate had failed open — and it
// must still refuse anything whose argument can reach stdout, because the
// emitted `Bash(<root> *)` would also match `<root> ... > <path>`.
test('the exporter refuses content-writing roots even when handed autoSafe: true', () => {
  const permissions = renderClaudePermissions([
    candidate(['echo'], { tool: 'Bash', claudePermission: 'Bash(echo *)' }),
    candidate(['printf'], { tool: 'Bash', claudePermission: 'Bash(printf *)' }),
    candidate(['basename'], { tool: 'Bash', claudePermission: 'Bash(basename *)' }),
    candidate(['dirname'], { tool: 'Bash', claudePermission: 'Bash(dirname *)' }),
    candidate(['Get-Date'], { shell: 'powershell' }),
    candidate(['Write-Output'], { shell: 'powershell' }),
    candidate(['git', 'cat-file'], { tool: 'Bash', claudePermission: 'Bash(git cat-file *)' }),
    // Retained, so the test proves exclusion rather than a blanket refusal.
    candidate(['whoami'], { tool: 'Bash', claudePermission: 'Bash(whoami *)' }),
  ]);
  assert.deepEqual(permissions, ['Bash(whoami *)']);
});

// The two gates are duplicated on purpose — a bug in one should not propagate.
// Duplication only helps while both describe the same set, so assert they agree
// modulo the exporter's .exe spellings (the learner strips .exe when normalizing).
test('the learner and exporter auto-safe sets do not drift apart', () => {
  const {
    AUTO_SUFFIX_CLOSED_ROOTS: exporterRoots,
    AUTO_SAFE_GIT_SUBCOMMANDS: exporterGit,
  } = require('../src/policy-exporters');
  const {
    AUTO_SUFFIX_CLOSED_ROOTS: learnerRoots,
    AUTO_SAFE_GIT: learnerGit,
  } = require('../src/auto-learn');

  const stripExe = (set) => new Set([...set].map((root) => root.replace(/\.exe$/, '')));
  assert.deepEqual(
    [...stripExe(exporterRoots)].sort(),
    [...stripExe(learnerRoots)].sort(),
    'auto-safe root sets disagree between src/auto-learn.js and src/policy-exporters.js',
  );
  assert.deepEqual(
    [...exporterGit].sort(),
    [...learnerGit].sort(),
    'auto-safe git subcommand sets disagree between the two gates',
  );
});

test('explicitly reviewed Claude export can retain narrow read candidates', () => {
  const permissions = renderClaudePermissions([
    { autoSafe: false, tool: 'Bash', prefix: ['cat'], claudePermission: 'Bash(cat *)' },
    { autoSafe: false, tool: 'Bash', prefix: ['git', 'diff'], claudePermission: 'Bash(git diff *)' },
    { autoSafe: false, shell: 'powershell', prefix: ['Get-Content'] },
  ], { includeReviewed: true });
  assert.deepEqual(permissions, [
    'Bash(cat *)', 'Bash(git diff *)', 'PowerShell(Get-Content *)',
  ]);
});

test('Claude merge preserves manual order and normalizes generated entries only', () => {
  const manual = ['Bash(git status *)', 'WebSearch'];
  let processorInput;
  const merged = mergeClaudeAllow(manual, [candidate(['rg', '--files'], {
    tool: 'Bash', claudePermission: 'Bash(rg --files *)',
  })], (generated) => {
    processorInput = generated.slice();
    return generated;
  });
  assert.deepEqual(processorInput, ['Bash(rg --files *)']);
  assert.deepEqual(merged, ['Bash(git status *)', 'WebSearch', 'Bash(rg --files *)']);
  assert.deepEqual(manual, ['Bash(git status *)', 'WebSearch']);
});

test('Codex managed merge preserves manual text and replaces only its marked section', () => {
  const manual = '# hand written\n' + manualRule(['rg', '--files']);
  const firstRules = renderCodexRules([candidate(['git', 'status'])]);
  const secondRules = renderCodexRules([candidate(['git', 'rev-parse'])]);
  const first = mergeGeneratedCodexRules(manual, firstRules);
  assert.ok(first.startsWith(manual));
  assert.ok(first.includes('# BEGIN permission-wildcarding generated rules'));
  assert.equal(mergeGeneratedCodexRules(first, firstRules), first);

  const second = mergeGeneratedCodexRules(first, secondRules);
  assert.ok(second.startsWith(manual));
  assert.ok(compact(second).includes('pattern = ' + JSON.stringify(['git', 'rev-parse'])));
  assert.ok(!compact(second).includes('pattern = ' + JSON.stringify(['git', 'status'])));
  assert.throws(
    () => mergeGeneratedCodexRules('# BEGIN permission-wildcarding generated rules\n', firstRules),
    /unbalanced/
  );
});
