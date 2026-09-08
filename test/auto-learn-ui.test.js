'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  applicationSummary, candidatePendingTargets, claudeDecisionExplanation,
  claudePermissionDecision, codexCheckVariants, codexExecpolicyArgs, codexRestartSuffix,
  isCandidateComplete, managedBlockedDetail, managedBlockedNote, managedPromptExplanation,
  policyTargetLabel, reviewableCandidates,
} = require('../vscode-extension/autoLearnUi');

// Regression: the Review badge counted every candidate with a 'review'
// disposition, but the picker hides the ones an existing allow rule already
// covers. "Review (30)" opening a list of 1 is the button lying about its own
// scope — both must read from reviewableCandidates.
test('the review count matches what the picker will actually show', () => {
  const settings = { permissions: { allow: ['Bash(rg *)', 'Bash(git *)'], deny: [] } };
  const candidates = [
    // Already covered by Bash(rg *) — hidden from the picker, so not counted.
    { key: 'rg\0--files', claudePermission: 'Bash(rg --files *)', disposition: 'review', meetsThreshold: true },
    // Already covered by Bash(git *).
    { key: 'git\0status', claudePermission: 'Bash(git status *)', disposition: 'review', meetsThreshold: true },
    // Genuinely new — the only thing the picker offers.
    { key: 'tokei\0.',    claudePermission: 'Bash(tokei *)',      disposition: 'review', meetsThreshold: true },
    // Below threshold and still observing — not ready either way.
    { key: 'fd\0-e',      claudePermission: 'Bash(fd *)',         disposition: 'observe', meetsThreshold: false },
  ];

  const result = reviewableCandidates(candidates, {}, ['claude'], settings);
  assert.equal(result.candidates.length, 1, 'only the uncovered candidate is offered');
  assert.equal(result.candidates[0].claudePermission, 'Bash(tokei *)');
  assert.equal(result.covered.length, 2, 'covered candidates are reported, not silently dropped');
  assert.equal(result.ready.length, 3, 'the observing candidate is not ready');
});

test('with no settings to compare against, nothing is treated as covered', () => {
  const candidates = [
    { key: 'rg\0--files', claudePermission: 'Bash(rg --files *)', disposition: 'review', meetsThreshold: true },
  ];
  assert.equal(reviewableCandidates(candidates, {}, ['claude'], null).candidates.length, 1);
  assert.equal(reviewableCandidates([], {}, ['claude'], null).candidates.length, 0);
});

test('candidate completion honors manager eligible and pending targets', () => {
  const candidate = {
    key: 'git\0status', eligibleTargets: ['claude'], pendingTargets: [],
  };
  assert.equal(isCandidateComplete(candidate, {}, ['claude', 'codex']), true);
  assert.deepEqual(candidatePendingTargets({
    ...candidate, pendingTargets: ['claude'],
  }, {}, ['claude', 'codex']), ['claude']);
});

test('candidate completion falls back to per-target applied state', () => {
  const candidate = { key: 'rg\0--files' };
  const status = { applied: { claude: ['rg\0--files'], codex: [] } };
  assert.deepEqual(candidatePendingTargets(candidate, status, ['claude', 'codex']), ['codex']);
});

test('application summary includes scan auto-application and later apply', () => {
  assert.deepEqual(applicationSummary(
    { application: { appliedKeys: ['git\0status'], changedTargets: ['claude'] } },
    { appliedKeys: ['rg\0--files'], changedTargets: ['codex'] },
  ), {
    appliedCount: 2,
    appliedKeys: ['git\0status', 'rg\0--files'],
    changedTargets: ['claude', 'codex'],
  });
});

test('Claude permission analysis reports deny then ask then allow precedence', () => {
  const settings = { permissions: {
    allow: ['Bash(git *)'], ask: ['Bash(git push *)'], deny: ['Bash(git push --force *)'],
  } };
  assert.equal(claudePermissionDecision(settings, 'Bash(git push --force origin)').decision, 'deny');
  assert.equal(claudePermissionDecision(settings, 'Bash(git push origin)').decision, 'ask');
  assert.equal(claudePermissionDecision(settings, 'Bash(git status)').decision, 'allow');
  assert.equal(claudePermissionDecision(settings, 'Bash(rg TODO)').decision, 'default');
  assert.match(
    claudeDecisionExplanation(claudePermissionDecision(settings, 'Bash(git push origin)')),
    /ASK.*Ask wins over allow.*prompt is expected/,
  );
});

// The review list drops candidates an existing allow rule already covers. That
// suppression reuses the same precedence check, so pin the shapes it depends on:
// a candidate permission is a *wildcard* string, and coverage means an existing
// rule matches it, not that the two are equal.
test('an existing root wildcard reports a narrower candidate as already covered', () => {
  const settings = { permissions: { allow: ['Bash(rg *)', 'Bash(git *)', 'Bash(tokei *)'] } };
  const covered = (permission) =>
    claudePermissionDecision(settings, permission).decision === 'allow';

  assert.equal(covered('Bash(rg --files *)'), true, 'covered by Bash(rg *)');
  assert.equal(covered('Bash(git status *)'), true, 'covered by Bash(git *)');
  assert.equal(covered('Bash(tokei *)'), true, 'covered exactly');
  assert.equal(covered('Bash(whoami *)'), false, 'nothing grants this yet');

  // Coverage must not swallow a family a deny or ask rule governs — those still
  // need to reach review so the user learns why the prompt persists.
  const guarded = { permissions: {
    allow: ['Bash(git *)'], ask: ['Bash(git push *)'], deny: ['Bash(git push --force *)'],
  } };
  assert.equal(claudePermissionDecision(guarded, 'Bash(git push *)').decision, 'ask');
  assert.equal(claudePermissionDecision(guarded, 'Bash(git push --force *)').decision, 'deny');
});

// The confirmation gate used to key off `autoSafe`, which asks whether a machine
// may apply something unattended — the wrong question for a human who has just
// ticked rows in a picker. After auto-safe narrowed to suffix-closed roots,
// nothing in the review list is ever auto-safe, so the prompt fired on every
// selection and could not be avoided.
test('confirmation is driven by risk and override, never by auto-safe eligibility', () => {
  const { selectionsNeedingConfirmation } = require('../vscode-extension/autoLearnUi');
  const readOnly = { key: 'a', risk: 'read-only', autoSafe: false, claudePermission: 'Bash(rg *)' };
  const network = { key: 'b', risk: 'network', autoSafe: false, claudePermission: 'Bash(curl *)' };

  // A plain read-only grant is exactly what the review list is for: no prompt,
  // even though it is not auto-safe.
  assert.deepEqual(selectionsNeedingConfirmation([readOnly]), []);
  // Risk is what earns the prompt.
  assert.deepEqual(
    selectionsNeedingConfirmation([readOnly, network]).map((e) => e.candidate.key), ['b']);
  // An auto-safe candidate is not special-cased either way — only its risk counts.
  assert.deepEqual(
    selectionsNeedingConfirmation([{ ...readOnly, autoSafe: true }]), []);

  // A policy override earns the prompt on its own, so a grant the current deny
  // or ask rules would defeat is never applied silently.
  const overridden = selectionsNeedingConfirmation(
    [readOnly], (candidate) => (candidate.key === 'a' ? 'deny' : null));
  assert.deepEqual(overridden, [{ candidate: readOnly, override: 'deny' }]);

  assert.deepEqual(selectionsNeedingConfirmation([]), []);
  assert.deepEqual(selectionsNeedingConfirmation(undefined), []);
});

test('Codex Why checks normalized argv and the Windows PowerShell host wrapper', () => {
  assert.deepEqual(codexCheckVariants(
    'PowerShell', 'Get-ChildItem -Force', { argv: ['Get-ChildItem', '-Force'] },
    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  ), [
    { label: 'normalized command argv', argv: ['Get-ChildItem', '-Force'] },
    {
      label: 'Windows PowerShell host argv',
      argv: [
        'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
        '-Command', 'Get-ChildItem -Force',
      ],
    },
  ]);
  assert.deepEqual(codexExecpolicyArgs(
    ['user.rules', 'workspace.rules'], ['rg', '--files'],
  ), [
    'execpolicy', 'check', '--pretty',
    '--rules', 'user.rules', '--rules', 'workspace.rules',
    '--', 'rg', '--files',
  ]);
});

test('policy summaries name only changed targets and restart Codex only when needed', () => {
  assert.equal(policyTargetLabel(['claude']), 'Claude');
  assert.equal(policyTargetLabel(['codex']), 'Codex');
  assert.equal(policyTargetLabel(['codex', 'claude', 'codex']), 'Claude and Codex');
  assert.equal(codexRestartSuffix(['claude']), '');
  assert.match(codexRestartSuffix(['codex']), /Restart Codex/);
});

// Regression: coverage was judged from the Claude allow list for every target
// at once, so a family already allowed for Claude was hidden even while it
// still owed Codex a rule. The picker is the only route to a Codex grant, so
// hiding it there meant the grant could never be made at all.
test('coverage is judged per target, so a pending Codex grant is never hidden', () => {
  const settings = { permissions: { allow: ['Bash(git *)'], deny: [] } };
  const both = ['claude', 'codex'];
  const candidate = (pending) => ({
    key: `git status:${pending.join('+')}`, claudePermission: 'Bash(git status *)',
    disposition: 'review', meetsThreshold: true,
    eligibleTargets: both, pendingTargets: pending,
  });

  // Only Claude left to grant, and the allow list already covers it: still
  // redundant, still hidden.
  const claudeOnly = reviewableCandidates([candidate(['claude'])], {}, both, settings);
  assert.equal(claudeOnly.covered.length, 1);
  assert.equal(claudeOnly.candidates.length, 0);

  // Codex is still owed a rule, so the Claude entry does not settle it.
  for (const pending of [['codex'], ['claude', 'codex']]) {
    const result = reviewableCandidates([candidate(pending)], {}, both, settings);
    assert.equal(result.covered.length, 0, `${pending} should not count as covered`);
    assert.equal(result.candidates.length, 1, `${pending} should stay in the picker`);
  }

  // A candidate with no Claude rule to compare against is never covered.
  const noRule = reviewableCandidates([{
    key: 'ctest', claudePermission: null, disposition: 'review', meetsThreshold: true,
    eligibleTargets: ['codex'], pendingTargets: ['codex'],
  }], {}, both, settings);
  assert.equal(noRule.covered.length, 0);
  assert.equal(noRule.candidates.length, 1);
});

// A managed ask outranks any grant written from here, so those families are
// withheld from the picker. Withholding them silently was the defect: the
// prompts keep arriving and Review shows nothing that explains them.
const BLOCKED = {
  policy: 'present',
  path: 'C:\\Users\\x\\.claude\\remote-settings.json',
  degraded: false,
  error: null,
  verdicts: { inert: 2, partial: 0, redundant: 3, effective: 40, unknown: 1 },
  inertFamilies: [
    { key: 'bash:curl', permission: 'Bash(curl *)', runs: 55, decision: 'ask', rule: 'Bash(curl:*)' },
    { key: 'bash:git push', permission: 'Bash(git push *)', runs: 16, decision: 'ask', rule: 'Bash(git push:*)' },
  ],
  deadAllowEntries: [
    { permission: 'Bash(curl *)', decision: 'ask', rule: 'Bash(curl:*)' },
  ],
};

test('Review names the families a managed rule blocks, and the rule that blocks them', () => {
  const note = managedBlockedNote(BLOCKED);
  assert.match(note, /2 blocked by managed policy/);

  const detail = managedBlockedDetail(BLOCKED).join('\n');
  // The rule string is the point: a bare verdict leaves the reader hunting
  // through a few hundred managed entries for the one that beat them.
  assert.match(detail, /Bash\(curl \*\) — 55 successful runs — managed ask: Bash\(curl:\*\)/);
  assert.match(detail, /Bash\(git push \*\) — 16 successful runs — managed ask: Bash\(git push:\*\)/);

  // A family with exactly one run is common on this list, and "1 successful
  // runs" is the kind of thing that makes a report look unmaintained.
  const single = managedBlockedDetail({
    policy: 'present', degraded: false,
    inertFamilies: [
      { key: 'bash:git merge', permission: 'Bash(git merge *)', runs: 1, decision: 'ask', rule: 'Bash(git merge:*)' },
    ],
    deadAllowEntries: [],
  }).join('\n');
  assert.match(single, /Bash\(git merge \*\) — 1 successful run — managed ask/);
  assert.doesNotMatch(single, /1 successful runs/);

  // The dead grant is reported and the text says why it was left alone, so
  // nobody reads the report as a deletion that failed.
  assert.match(detail, /Allow entries already in your settings/);
  assert.match(detail, /cache/);
  assert.match(detail, /deleting a live grant/);
});

test('the blocked note names a command that can actually show the list', () => {
  // A quick-pick title cannot be clicked, so a bare count is a dead end. The
  // title has to name the command, and that command has to exist: this string
  // is checked against package.json by the contribution test below.
  const note = managedBlockedNote(BLOCKED);
  assert.match(note, /Auto Learn - Show families blocked by managed policy/);

  const pkg = require('../vscode-extension/package.json');
  const titles = pkg.contributes.commands.map((entry) => entry.title);
  assert.ok(titles.includes('Permission Wildcarding: Auto Learn - Show families blocked by managed policy'),
    'the note points at a command the palette does not contribute');
});

test('"why did this prompt" names the managed rule instead of gesturing at org policy', () => {
  // The reason this matters: the user's allow entry genuinely matches, so the
  // precedence answer alone reads as "this should not have prompted".
  const asked = managedPromptExplanation({
    policy: 'present', degraded: false, verdict: 'inert',
    override: { decision: 'ask', rule: 'Bash(curl:*)' },
  });
  assert.match(asked, /Bash\(curl:\*\)/);
  assert.match(asked, /ASKS on this command/);
  assert.match(asked, /don't ask again/, 'the useless remedy has to be ruled out by name');

  const denied = managedPromptExplanation({
    policy: 'present', degraded: false, verdict: 'inert',
    override: { decision: 'deny', rule: 'Bash(rm -rf /:*)' },
  });
  assert.match(denied, /DENIES this command/);
  assert.match(denied, /No rule you can write will permit it/);

  // Nothing to say means no paragraph, so an ordinary prompt is not padded with
  // a managed-policy theory that does not apply.
  assert.equal(managedPromptExplanation({
    policy: 'present', degraded: false, verdict: 'effective', override: null,
  }), null);
  assert.equal(managedPromptExplanation({ policy: 'absent', degraded: false, override: null }), null);
  assert.equal(managedPromptExplanation(null), null);

  // Redundant is worth saying: the grant was never needed.
  assert.match(managedPromptExplanation({
    policy: 'present', degraded: false, verdict: 'redundant', override: null,
  }), /already covers this command/);

  // Degraded cannot pass as "no managed rule applies".
  assert.match(managedPromptExplanation({ policy: 'unreadable', degraded: true, override: null }),
    /could not be parsed/);
});

test('nothing blocked says nothing, and an unreadable policy refuses to say all-clear', () => {
  const clean = { policy: 'present', degraded: false, inertFamilies: [], deadAllowEntries: [] };
  assert.equal(managedBlockedNote(clean), '', 'no note when there is nothing to report');
  assert.equal(managedBlockedNote({}), '');
  assert.equal(managedBlockedNote(null), '');

  // Degraded and clean must never look alike: "could not check" is not "found
  // nothing". The note has to fire even though inertFamilies is empty.
  const broken = {
    policy: 'unreadable', degraded: true, error: 'Unexpected token n',
    verdicts: null, inertFamilies: [], deadAllowEntries: [],
  };
  const note = managedBlockedNote(broken);
  assert.match(note, /unreadable/);
  assert.doesNotMatch(note, /0 blocked/);
  const detail = managedBlockedDetail(broken).join('\n');
  assert.match(detail, /nothing below was checked/);
  assert.match(detail, /Unexpected token n/, 'the parse error is carried, not swallowed');
  assert.doesNotMatch(detail, /Blocked command families/,
    'a heading over an empty list would read as a clean bill');
});
