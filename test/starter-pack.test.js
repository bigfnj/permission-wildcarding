'use strict';

// The starter pack is a seed, so it has to hold two properties that are easy to
// break when folding a real machine's list back into it:
//
//   1. Every entry is already in final wildcarded form, so `processAllowList`
//      passes the whole list through untouched. An entry that its own pass would
//      prune (a narrow `Bash(claude setup-token *)` sitting under a later
//      `Bash(claude *)`) makes --seed report phantom churn on a fresh machine.
//   2. Nothing in it is machine-specific. It travels to other workstations, so an
//      absolute path or an env-var-prefixed command would seed a permission that
//      cannot match anything there.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { processAllowList } = require('../src/permissions');

const pack = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'patterns', 'starter-pack.json'), 'utf8')
);

test('the starter pack is a list of unique permission strings', () => {
  assert.ok(Array.isArray(pack) && pack.length > 200, `pack has ${pack.length} entries`);
  assert.equal(new Set(pack).size, pack.length, 'duplicate entries');
  for (const entry of pack) {
    assert.equal(typeof entry, 'string');
    assert.ok(
      /^[A-Za-z][\w-]*(\(.+\))?$/s.test(entry) || /^mcp__/.test(entry),
      `not a permission: ${entry}`
    );
  }
});

test('the pack passes through its own generalizer unchanged', () => {
  const processed = processAllowList(pack);
  const pruned = pack.filter((entry) => !processed.includes(entry));
  const rewritten = processed.filter((entry) => !pack.includes(entry));
  assert.deepEqual(pruned, [], 'entries a seed would immediately prune');
  assert.deepEqual(rewritten, [], 'entries the generalizer would rewrite');
  assert.deepEqual(processed, pack, 'order must be stable too');
});

test('nothing in the pack is tied to one machine', () => {
  for (const entry of pack) {
    const inner = /^[A-Za-z][\w-]*\((.*)\)$/s.exec(entry)?.[1] ?? '';
    assert.ok(!/^[~/]/.test(inner), `absolute or home path: ${entry}`);
    assert.ok(!/^[A-Za-z]:[\\/]/.test(inner), `drive-letter path: ${entry}`);
    assert.ok(!/^["']/.test(inner), `quoted program: ${entry}`);
    assert.ok(!/^[A-Za-z_][A-Za-z0-9_]*=/.test(inner), `env-var prefix: ${entry}`);
  }
});

// Bash sits under Claude Code's built-in read-only set and, in an enterprise,
// a managed allow list; PowerShell has neither, so a user rule is the only
// layer that decides there. A pack weighted toward Bash spends its entries on
// the half where they matter least, so the two halves are kept in step by
// scripts/mirror-pack.js and this asserts the pack is closed under that rule.
test('the PowerShell half is in step with the Bash half', () => {
  const { mirrorTargets } = require('../scripts/mirror-pack');
  const { missing } = mirrorTargets(pack);
  assert.deepEqual(missing, [],
    `run "node scripts/mirror-pack.js --write" to add: ${missing.join(', ')}`);
});

test('mirroring never carries an interpreter or a bare family prefix across', () => {
  const { mirrorTargets, NEVER_MIRROR } = require('../scripts/mirror-pack');
  // Feed the rule entries it must refuse, and confirm it proposes nothing.
  const dangerous = [
    'Bash(bash *)', 'Bash(python *)', 'Bash(node *)', 'Bash(npx *)',
    'Bash(sudo *)', 'Bash(rm *)', 'Bash(curl *)', 'Bash(sops *)',
    'Bash(docker *)', 'Bash(pip *)', 'Bash(./build.sh *)',
  ];
  const { missing } = mirrorTargets(dangerous);
  assert.deepEqual(missing, [], 'none of these may gain a PowerShell twin');

  // And the refusal is a rule, not a coincidence: a plain cross-platform tool
  // in the same list does get mirrored.
  const mixed = mirrorTargets(['Bash(bash *)', 'Bash(ffprobe *)']);
  assert.deepEqual(mixed.missing, ['PowerShell(ffprobe *)']);
  assert.ok(NEVER_MIRROR.has('bash'));
});
