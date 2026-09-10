'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  readApproval, setApproval, clearApproval, isCodexMaxOn, applyCodexMax,
  sandboxMode, topLevelBound, APPROVAL_VALUES,
  allowedApprovalPolicies, allowedSandboxModes, targetApproval,
  enterprisePrefixRules, enterpriseDecisionFor,
} = require('../src/codex-max');

// A real enterprise requirements bundle, in the shape Codex caches it.
const bundleWith = (contents) => ({
  signed_payload: { bundle: { requirements_toml: { enterprise_managed: [{ contents }] } } },
});
const RESTRICTED = bundleWith([
  'allowed_sandbox_modes = ["read-only", "workspace-write"]',
  'allowed_approval_policies = ["on-request", "untrusted"]',
].join('\n'));

// A config shaped like a real one: literal-string Windows paths, an inline
// array, and several nested tables after the top-level keys.
const REAL_SHAPE = [
  'notify = [ "C:\\\\Users\\\\x\\\\codex.exe", "turn-ended" ]',
  'model = "gpt-5.6-sol"',
  'sandbox_mode = "workspace-write"',
  'personality = "pragmatic"',
  '',
  '[marketplaces.openai-bundled]',
  "source = '\\\\?\\C:\\Users\\x\\.codex\\bundled'",
  '',
  '[plugins."browser@openai-bundled"]',
  'enabled = true',
  '',
].join('\n');

test('a bare key is inserted in the top-level table, never inside a later one', () => {
  const { text, changed } = setApproval(REAL_SHAPE, 'never');
  assert.equal(changed, true);
  const lines = text.split('\n');
  const keyAt = lines.findIndex((line) => line.startsWith('approval_policy'));
  // The single most dangerous failure mode: appending at EOF would silently put
  // the key inside [plugins."browser@openai-bundled"], where Codex ignores it.
  assert.ok(keyAt >= 0, 'key must be written');
  assert.ok(keyAt < topLevelBound(lines), 'key must land before the first table header');
  assert.equal(lines[keyAt - 1], 'personality = "pragmatic"', 'groups with its siblings');
});

test('editing is surgical: one line added, nothing else touched', () => {
  const { text } = setApproval(REAL_SHAPE, 'never');
  const before = REAL_SHAPE.split('\n');
  const after = text.split('\n');
  assert.equal(after.length, before.length + 1);
  assert.deepEqual(after.filter((l) => !before.includes(l)), ['approval_policy = "never"']);
  assert.deepEqual(before.filter((l) => !after.includes(l)), []);
});

test('the toggle never touches sandbox_mode, because it is the only floor Codex has', (t) => {
  // A mkdtemp dir like every other test in this file. The name `nope.json`
  // suggested a path that would not be written, but applyCodexMax writes its
  // state there — so this left a real 69-byte nope.json in %TEMP% behind on
  // every run, at a FIXED path, which two concurrent runs would also fight over.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-max-sandbox-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const on = applyCodexMax(REAL_SHAPE, true, { statePath: path.join(dir, 'state.json'), bundle: null });
  assert.equal(sandboxMode(on.text), 'workspace-write');
  assert.equal(on.sandboxUntouched, true);
  assert.equal(/danger-full-access/.test(on.text), false);
});

test('round trip restores the file byte for byte', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-max-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const statePath = path.join(dir, 'state.json');

  const on = applyCodexMax(REAL_SHAPE, true, { statePath, bundle: null });
  assert.equal(isCodexMaxOn(on.text, null), true);
  const off = applyCodexMax(on.text, false, { statePath, bundle: null });
  assert.equal(off.text, REAL_SHAPE, 'off must restore the original bytes');
  assert.equal(isCodexMaxOn(off.text, null), false);
});

test('an existing approval_policy is restored, not removed', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-max-prior-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const statePath = path.join(dir, 'state.json');
  const source = REAL_SHAPE.replace('model = "gpt-5.6-sol"', 'model = "gpt-5.6-sol"\napproval_policy = "untrusted"');

  const on = applyCodexMax(source, true, { statePath, bundle: null });
  assert.equal(readApproval(on.text), 'never');
  const off = applyCodexMax(on.text, false, { statePath, bundle: null });
  assert.equal(readApproval(off.text), 'untrusted', 'the prior policy must come back');
  assert.equal(off.text, source);
});

test('with no prior key, off removes it rather than inventing one', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-max-absent-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const statePath = path.join(dir, 'state.json');
  const on = applyCodexMax(REAL_SHAPE, true, { statePath, bundle: null });
  const off = applyCodexMax(on.text, false, { statePath, bundle: null });
  assert.equal(readApproval(off.text), null);
});

test('a commented-out key is not mistaken for a live one', () => {
  const source = '# approval_policy = "never"\nmodel = "x"\n';
  assert.equal(readApproval(source), null);
  assert.equal(isCodexMaxOn(source, null), false);
  const { text } = setApproval(source, 'never');
  assert.equal(text.split('\n').filter((l) => l.startsWith('approval_policy')).length, 1);
  assert.match(text, /# approval_policy = "never"/, 'the comment must survive');
});

test('CRLF files stay CRLF, and both quote styles are read', () => {
  const crlf = 'model = "x"\r\nsandbox_mode = "workspace-write"\r\n';
  const { text } = setApproval(crlf, 'never');
  assert.equal(/\r\n/.test(text), true);
  assert.equal(/[^\r]\n/.test(text), false, 'must not introduce bare LF');
  assert.equal(readApproval("approval_policy = 'on-request'\n"), 'on-request');
});

test('an unsupported policy value is refused rather than written', () => {
  assert.throws(() => setApproval(REAL_SHAPE, 'yolo'), /Unsupported Codex approval_policy/);
  assert.deepEqual([...APPROVAL_VALUES].sort(), ['never', 'on-request', 'untrusted']);
});

test('a config with no tables at all still gets a top-level key', () => {
  const { text } = setApproval('model = "x"\n', 'never');
  assert.equal(readApproval(text), 'never');
  assert.equal(clearApproval(text).text, 'model = "x"\n');
});

// An org bundle can declare which approval policies are legal at all. MAX means
// "skip every prompt", which only approval_policy="never" achieves. Where the org
// forbids "never", no value MAX could write skips prompts — and the least-friction
// one it could set is the org's own default — so MAX has no on-state to reach and
// must report that it is unavailable rather than write a no-op and call it "on".
test('enterprise policy that forbids "never" makes Codex MAX unavailable, not a no-op on', (t) => {
  assert.deepEqual(allowedApprovalPolicies(RESTRICTED), ['on-request', 'untrusted']);
  assert.deepEqual(allowedSandboxModes(RESTRICTED), ['read-only', 'workspace-write']);

  const target = targetApproval(RESTRICTED);
  assert.equal(target.restricted, true, 'never is not in the allowed set');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-max-policy-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const statePath = path.join(dir, 'state.json');
  const on = applyCodexMax(REAL_SHAPE, true, { statePath, bundle: RESTRICTED });
  assert.equal(on.changed, false, 'nothing is written when MAX cannot skip prompts');
  assert.equal(on.text, REAL_SHAPE, 'the config is left byte for byte');
  assert.equal(on.blockedBy, 'enterprise-policy');
  assert.equal(on.restricted, true);
  assert.equal(/never/.test(on.text), false, 'a forbidden value is never written');
  // The sandbox is still untouched, and would have been capped anyway.
  assert.equal(sandboxMode(on.text), 'workspace-write');
});

// The exact "MAX turned itself on again" report: on a capped box, target.value
// collapses to the org's enforced default (on-request here). A config that merely
// carries that default — because Codex, the user, or a stale toggle wrote it — is
// not a MAX the user enabled, and on-request skips nothing. isCodexMaxOn must not
// read it as on, or the card claims "all prompts skipped" from the org's own floor.
test('the org default under a restriction never reads as Codex MAX on', () => {
  const target = targetApproval(RESTRICTED);
  assert.equal(target.value, 'on-request', 'the org default is the only value MAX could set');

  const withDefault = setApproval(REAL_SHAPE, 'on-request').text;
  assert.equal(readApproval(withDefault), 'on-request');
  assert.equal(isCodexMaxOn(withDefault, RESTRICTED), false, 'the org default is not MAX');

  const withUntrusted = setApproval(REAL_SHAPE, 'untrusted').text;
  assert.equal(isCodexMaxOn(withUntrusted, RESTRICTED), false, 'a permitted lesser policy is not MAX either');

  // And where the org does allow "never", the same isCodexMaxOn still reports it.
  const withNever = setApproval(REAL_SHAPE, 'never').text;
  assert.equal(isCodexMaxOn(withNever, null), true, 'unrestricted "never" is genuinely on');
});

test('no allowed policy at all is refused, not guessed at', () => {
  const none = bundleWith('allowed_approval_policies = ["something-unknown"]');
  assert.deepEqual(allowedApprovalPolicies(none), [], 'present but unreadable = nothing allowed');
  assert.equal(targetApproval(none).value, null);
  const res = applyCodexMax(REAL_SHAPE, true, { bundle: none });
  assert.equal(res.changed, false);
  assert.equal(res.blockedBy, 'enterprise-policy');
});

test('with no bundle, nothing is capped and "never" is still the target', () => {
  assert.equal(allowedApprovalPolicies(null), null, 'absent key = unrestricted');
  assert.equal(targetApproval(null).value, 'never');
  assert.equal(targetApproval(null).restricted, false);
});

// The enterprise bundle carries prefix rules that force a prompt regardless of
// any user rule. A diagnostic that reads only user rules names the wrong cause
// and suggests a fix (write a rule) that cannot work.
test('enterprise prefix rules are parsed and matched by command root', () => {
  const bundle = bundleWith([
    '[[rules.prefix_rules]]',
    'pattern = [{ any_of = ["sh", "bash", "zsh"] }]',
    'decision = "prompt"',
    'justification = "Shell launchers require human review."',
    '',
    '[[rules.prefix_rules]]',
    'pattern = [{ any_of = ["curl", "wget"] }]',
    'decision = "prompt"',
    'justification = "Network access requires approval."',
  ].join('\n'));

  const rules = enterprisePrefixRules(bundle);
  assert.equal(rules.length, 2, 'each block is its own rule');
  assert.deepEqual(rules[0].patterns, ['sh', 'bash', 'zsh']);
  assert.equal(rules[1].justification, 'Network access requires approval.');

  // Matching is on the command root, so a path or .exe suffix still matches.
  assert.equal(enterpriseDecisionFor(bundle, ['curl', '--version']).decision, 'prompt');
  assert.equal(enterpriseDecisionFor(bundle, ['C:\\tools\\curl.exe', '-s']).decision, 'prompt');
  assert.equal(enterpriseDecisionFor(bundle, ['/usr/bin/bash', '-lc', 'ls']).root, 'bash');
  assert.equal(enterpriseDecisionFor(bundle, ['rg', '--files']), null, 'ungoverned root');
  assert.equal(enterpriseDecisionFor(bundle, []), null);
  assert.equal(enterpriseDecisionFor(null, ['curl']), null, 'no bundle, no rules');
});
