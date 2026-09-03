'use strict';

const { ruleMatches } = require('./src/permission-match');

const TARGETS = new Set(['claude', 'codex']);

function uniqueTargets(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((target) => TARGETS.has(target)))];
}

function candidateAppliedTargets(candidate, status = {}) {
  const direct = uniqueTargets(candidate?.appliedTo || candidate?.appliedTargets);
  const key = candidate?.key;
  if (!key) return direct;
  const fromStatus = ['claude', 'codex'].filter((target) =>
    Array.isArray(status?.applied?.[target]) && status.applied[target].includes(key));
  return uniqueTargets([...direct, ...fromStatus]);
}

function candidateEligibleTargets(candidate, enabledTargets = ['claude']) {
  const enabled = uniqueTargets(enabledTargets);
  if (Array.isArray(candidate?.eligibleTargets)) {
    const eligible = new Set(uniqueTargets(candidate.eligibleTargets));
    return enabled.filter((target) => eligible.has(target));
  }
  return enabled;
}

function candidatePendingTargets(candidate, status = {}, enabledTargets = ['claude']) {
  const eligible = candidateEligibleTargets(candidate, enabledTargets);
  if (Array.isArray(candidate?.pendingTargets)) {
    const pending = new Set(uniqueTargets(candidate.pendingTargets));
    return eligible.filter((target) => pending.has(target));
  }
  const applied = new Set(candidateAppliedTargets(candidate, status));
  return eligible.filter((target) => !applied.has(target));
}

function isCandidateComplete(candidate, status = {}, enabledTargets = ['claude']) {
  return candidatePendingTargets(candidate, status, enabledTargets).length === 0;
}

function unwrapApplication(result) {
  if (!result || typeof result !== 'object') return null;
  return result.application || result.apply || result;
}

function applicationSummary(...results) {
  const appliedKeys = new Set();
  const changedTargets = new Set();
  let fallbackCount = 0;
  for (const outer of results) {
    const result = unwrapApplication(outer);
    if (!result || typeof result !== 'object') continue;
    if (Array.isArray(result.appliedKeys)) {
      for (const key of result.appliedKeys) appliedKeys.add(key);
    } else if (Array.isArray(result.applied)) {
      for (const key of result.applied) appliedKeys.add(key);
    } else if (result.applied && typeof result.applied === 'object') {
      for (const key of [...(result.applied.claude || []), ...(result.applied.codex || [])]) {
        appliedKeys.add(key);
      }
    } else {
      const count = [result.appliedCount, result.count, result.changedCount]
        .find((value) => Number.isFinite(value));
      fallbackCount += count ?? (result.changed ? 1 : 0);
    }
    for (const target of uniqueTargets(result.changedTargets)) changedTargets.add(target);
  }
  return {
    appliedCount: appliedKeys.size || fallbackCount,
    appliedKeys: [...appliedKeys],
    changedTargets: [...changedTargets],
  };
}

function policyTargetLabel(value) {
  const targets = uniqueTargets(value);
  if (targets.includes('claude') && targets.includes('codex')) return 'Claude and Codex';
  if (targets.includes('claude')) return 'Claude';
  if (targets.includes('codex')) return 'Codex';
  return 'policy';
}

function codexRestartSuffix(value) {
  return uniqueTargets(value).includes('codex')
    ? ' Restart Codex to load the changed rules.' : '';
}

// Delegates to the shared matcher so the dashboard reads policy the same way
// the wildcarding pass does. See docs/claude-code-permissions.md: the `:*` and
// ` *` spellings are one rule, and a lone trailing ` *` also matches the bare
// command.
function permissionMatches(permission, rule) {
  return ruleMatches(rule, permission);
}

function claudePermissionDecision(settings, permissions) {
  const probes = [...new Set((Array.isArray(permissions) ? permissions : [permissions])
    .filter((value) => typeof value === 'string' && value))];
  const configured = settings?.permissions || {};
  const matches = {};
  for (const tier of ['deny', 'ask', 'allow']) {
    const rules = Array.isArray(configured[tier]) ? configured[tier] : [];
    matches[tier] = rules.filter((rule) => probes.some((probe) => permissionMatches(probe, rule)));
  }
  const decision = matches.deny.length ? 'deny'
    : matches.ask.length ? 'ask'
      : matches.allow.length ? 'allow' : 'default';
  return { decision, matches, precedence: ['deny', 'ask', 'allow', 'default'] };
}

// Which of the selected candidates warrant a confirmation step.
//
// Deliberately keyed off risk and policy override, not off `autoSafe`. Auto-safe
// answers "may a machine apply this unattended"; a human ticking rows in a picker
// has already answered that. Once auto-safe narrowed to suffix-closed roots,
// nothing reaching this list is ever auto-safe, so an autoSafe-keyed prompt fired
// on every selection — an unavoidable confirmation is a click-through, not a gate.
//
// A plain read-only grant with no override is what the review list is *for*, so it
// passes silently. Everything else is named, so the prompt says what it is warning
// about instead of describing the selection in the abstract.
function selectionsNeedingConfirmation(candidates, overrideFor = () => null) {
  return (Array.isArray(candidates) ? candidates : [])
    .filter(Boolean)
    .map((candidate) => ({ candidate, override: overrideFor(candidate) || null }))
    .filter((entry) => entry.override || entry.candidate.risk !== 'read-only');
}

function claudeDecisionExplanation(assessment) {
  const matches = assessment?.matches || { deny: [], ask: [], allow: [] };
  const list = (tier) => matches[tier]?.length ? matches[tier].join(', ') : 'none';
  const evidence = `Matches — deny: ${list('deny')}; ask: ${list('ask')}; allow: ${list('allow')}.`;
  switch (assessment?.decision) {
    case 'deny':
      return `Claude decision: DENY. Deny wins over ask and allow. ${evidence}`;
    case 'ask':
      return `Claude decision: ASK. Ask wins over allow when no deny matches, so a prompt is expected. ${evidence}`;
    case 'allow':
      return `Claude decision: ALLOW. No deny or ask rule matched. ${evidence}`;
    default:
      return `Claude decision: DEFAULT. No deny, ask, or allow rule matched; session/default policy decides. ${evidence}`;
  }
}

function codexCheckVariants(shell, command, invocation, powershellExecutable) {
  const variants = [];
  const argv = Array.isArray(invocation?.argv) ? invocation.argv.map(String) : [];
  if (argv.length) variants.push({ label: 'normalized command argv', argv });
  if (shell === 'PowerShell' && powershellExecutable && command) {
    variants.push({
      label: 'Windows PowerShell host argv',
      argv: [String(powershellExecutable), '-Command', String(command)],
    });
  }
  return variants;
}

function codexExecpolicyArgs(ruleFiles, argv) {
  const rules = Array.isArray(ruleFiles) ? ruleFiles.map(String) : [];
  const command = Array.isArray(argv) ? argv.map(String) : [];
  return [
    'execpolicy', 'check', '--pretty',
    ...rules.flatMap((file) => ['--rules', file]),
    '--', ...command,
  ];
}

// The single definition of "what Review will actually show you". The card tile,
// the button badge, the scan summary and the picker all read from here: a count
// that includes candidates the picker then hides is a promise the button cannot
// keep, and sends you to an empty list.
function reviewableCandidates(candidates, status = {}, requiredTargets = ['claude'], settings = null) {
  const ready = (Array.isArray(candidates) ? candidates : [])
    .filter((candidate) => (candidate.meetsThreshold || candidate.disposition !== 'observe') &&
      !isCandidateComplete(candidate, status, requiredTargets));
  // A candidate an existing allow rule already covers is noise: granting
  // `Bash(rg --files *)` under an existing `Bash(rg *)` changes no prompt, and
  // the wildcarding pass prunes the entry on its next run while the claims
  // registry keeps claiming it.
  //
  // Only user settings are visible here, so this hides redundancy, never risk:
  // the worst case is a family staying in the list that did not need to.
  const claudeCovered = (candidate) => Boolean(candidate.claudePermission) &&
    claudePermissionDecision(settings, candidate.claudePermission).decision === 'allow';
  // Coverage is per target, and the Claude allow list only answers for Claude.
  // A family already allowed there can still owe Codex a rule, and hiding it on
  // the strength of the Claude entry alone meant the Codex grant could never be
  // made: the picker was the only route to it. Nothing here can read Codex
  // policy, so a pending Codex target is never assumed to be covered.
  const isCovered = (candidate) => {
    const pending = candidatePendingTargets(candidate, status, requiredTargets);
    return pending.length > 0 &&
      pending.every((target) => target === 'claude' && claudeCovered(candidate));
  };
  const covered = ready.filter(isCovered);
  return { ready, covered, candidates: ready.filter((candidate) => !isCovered(candidate)) };
}

module.exports = {
  applicationSummary,
  candidateAppliedTargets,
  reviewableCandidates,
  candidateEligibleTargets,
  candidatePendingTargets,
  claudeDecisionExplanation,
  claudePermissionDecision,
  codexCheckVariants,
  codexExecpolicyArgs,
  codexRestartSuffix,
  isCandidateComplete,
  permissionMatches,
  policyTargetLabel,
  selectionsNeedingConfirmation,
  uniqueTargets,
  unwrapApplication,
};
