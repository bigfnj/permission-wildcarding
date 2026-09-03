'use strict';

// The two matching rules that this project got wrong for months, taken from
// docs/claude-code-permissions.md. Both are asserted as conditions rather than
// as "the code mentions them", so disabling either fails here.

const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeRule, ruleMatches, sameRule } = require('../src/permission-match');
const { isCoveredBy, processAllowList } = require('../src/permissions');
const { claudePermissionDecision } = require('../vscode-extension/autoLearnUi');

test('a lone trailing star also matches the bare command', () => {
  // Documented: `Bash(ls *)` matches `ls`, `Bash(git log *)` matches `git log`.
  assert.equal(ruleMatches('Bash(ls *)', 'Bash(ls)'), true);
  assert.equal(ruleMatches('Bash(git log *)', 'Bash(git log)'), true);
  assert.equal(ruleMatches('PowerShell(Get-Date *)', 'PowerShell(Get-Date)'), true);
  // And still matches the form with arguments.
  assert.equal(ruleMatches('Bash(ls *)', 'Bash(ls -la)'), true);

  // The allowance holds only while the trailing star is the ONLY wildcard.
  assert.equal(ruleMatches('Bash(git * main)', 'Bash(git)'), false);
  assert.equal(ruleMatches('Bash(rg * --files *)', 'Bash(rg)'), false);

  // A prefix is not a licence for a different command.
  assert.equal(ruleMatches('Bash(ls *)', 'Bash(lsof)'), false);
  assert.equal(ruleMatches('Bash(git log *)', 'Bash(git logx)'), false);
});

test('the colon and space spellings are one rule, for command tools only', () => {
  assert.equal(sameRule('Bash(npm run:*)', 'Bash(npm run *)'), true);
  assert.equal(normalizeRule('PowerShell(docker:*)'), 'PowerShell(docker *)');
  assert.equal(ruleMatches('Bash(docker:*)', 'Bash(docker exec -it x sh)'), true);
  assert.equal(ruleMatches('Bash(docker:*)', 'Bash(docker)'), true);

  // Neither spelling covers the other, so pruning cannot delete one of a pair.
  assert.equal(isCoveredBy('Bash(npm run)', 'Bash(npm run:*)'), true);
  assert.equal(isCoveredBy('Bash(npm run:*)', 'Bash(npm run *)'), false);
  assert.equal(isCoveredBy('Bash(npm run *)', 'Bash(npm run:*)'), false);

  // A non-command tool keeps its own specifier grammar: a Skill colon is a
  // field separator, not a trailing-wildcard suffix, so nothing is inferred.
  assert.equal(normalizeRule('Skill(update-config:*)'), 'Skill(update-config:*)');
  assert.equal(isCoveredBy('Skill(update-config)', 'Skill(update-config:*)'), false);
  assert.deepEqual(processAllowList(['Skill(update-config)', 'Skill(update-config:*)']).sort(),
    ['Skill(update-config)', 'Skill(update-config:*)']);
});

test('the dashboard reads a colon-form policy rule it used to be blind to', () => {
  // An enterprise managed policy writes the colon form exclusively, so a
  // dashboard that only understood the space form reported no match and told
  // you a family was uncovered when policy already decided it.
  const settings = { permissions: { allow: ['Bash(git status:*)'], ask: ['Bash(docker:*)'], deny: [] } };
  assert.equal(claudePermissionDecision(settings, 'Bash(git status *)').decision, 'allow');
  assert.equal(claudePermissionDecision(settings, 'Bash(docker exec *)').decision, 'ask');
  assert.equal(claudePermissionDecision(settings, 'Bash(rg *)').decision, 'default');
});
