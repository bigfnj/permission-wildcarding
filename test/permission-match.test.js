'use strict';

// The two matching rules that this project got wrong for months, taken from
// docs/claude-code-permissions.md. Both are asserted as conditions rather than
// as "the code mentions them", so disabling either fails here.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeRule, ruleMatches, sameRule, matchCacheStats,
} = require('../src/permission-match');
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

// The matcher memoizes the compiled pattern and the normalized rule, because
// `isCoveredBy` sits inside both quadratic passes of `processAllowList` and one
// pass over a real 316-entry list was 192,150 RegExp compilations and 507 ms.
// Caching a pure function of a string cannot go stale, but it can lose the three
// distinctions below, none of which the rest of the suite pins directly.
test('memoizing the matcher keeps every result it had before', () => {
  // A non-string is refused BEFORE normalization, so it can never become a
  // cache key. Repeated because a cache is exactly where a first call could
  // poison a second.
  for (let round = 0; round < 2; round += 1) {
    assert.equal(ruleMatches(null, 'Bash(ls)'), false, `round ${round}`);
    assert.equal(ruleMatches('Bash(ls *)', null), false, `round ${round}`);
    assert.equal(ruleMatches(undefined, undefined), false, `round ${round}`);
    assert.equal(ruleMatches(7, 'Bash(ls)'), false, `round ${round}`);
    assert.equal(ruleMatches({}, 'Bash(ls)'), false, `round ${round}`);
  }

  // A regex metacharacter in a rule is a LITERAL, not a pattern, and stays one
  // when the compiled form is reused from the cache. This is the honest version
  // of an assertion first written as "a rule that cannot compile returns
  // false": measured, no rule string can fail to compile, because escapeLiteral
  // escapes every metacharacter except `*` and `*` is rewritten to `.*`. That
  // earlier claim would have passed with the guard deleted, which is no test at
  // all. What follows is reachable and is the property callers depend on.
  for (let round = 0; round < 3; round += 1) {
    assert.equal(ruleMatches('Bash(a+b)', 'Bash(a+b)'), true, `round ${round}`);
    assert.equal(ruleMatches('Bash(a+b)', 'Bash(aab)'), false, `+ is literal, round ${round}`);
    assert.equal(ruleMatches('Bash(a.c)', 'Bash(abc)'), false, `. is literal, round ${round}`);
    assert.equal(ruleMatches('Bash((', 'Bash((') , true, `unbalanced is literal, round ${round}`);
    assert.equal(ruleMatches('Bash((', 'Bash(x)'), false, `round ${round}`);
    assert.equal(ruleMatches('[', '['), true, `bare bracket is literal, round ${round}`);
    assert.equal(ruleMatches('[', 'Bash(x)'), false, `round ${round}`);
  }

  // `null` and `undefined` both normalize to the empty string and must keep
  // doing so. Keying them in the same map as a real empty string would draw a
  // distinction this function does not.
  assert.equal(normalizeRule(null), '');
  assert.equal(normalizeRule(undefined), '');
  assert.equal(normalizeRule(''), '');
  assert.equal(normalizeRule(null), '', 'still empty on the second call');
  assert.equal(normalizeRule('Bash(git:*)'), 'Bash(git *)');
  assert.equal(normalizeRule('Bash(git:*)'), 'Bash(git *)', 'and stable when cached');
  assert.equal(sameRule('Bash(git:*)', 'Bash(git *)'), true);

  // Two rules sharing a prefix must not share a cache entry. This is the exact
  // failure a truncated key produces, and it is asserted here as well as
  // through the starter pack so the cause is named where the cache lives.
  assert.equal(ruleMatches('Bash(git status *)', 'Bash(git status --short)'), true);
  assert.equal(ruleMatches('Bash(git stash *)', 'Bash(git status --short)'), false);
  assert.equal(ruleMatches('Bash(git status *)', 'Bash(git stash pop)'), false);
  assert.equal(ruleMatches('Bash(git stash *)', 'Bash(git stash pop)'), true);

  // Reusing one compiled pattern across calls is only safe while it carries no
  // `g` or `y` flag, which would advance `lastIndex` between tests.
  for (let round = 0; round < 4; round += 1) {
    assert.equal(ruleMatches('Bash(rg *)', 'Bash(rg TODO)'), true, `round ${round}`);
  }
});

test('the matcher cache is bounded, and stays correct across an eviction', () => {
  // The hook process exits after one pass, but the extension host holds this
  // module for a whole session, so an unbounded map keyed on rule strings is a
  // slow leak. Push well past the limit with synthetic rules, then re-assert a
  // real one: a wholesale clear must cost nothing but a recompile.
  const { limit } = matchCacheStats();
  for (let index = 0; index < limit + 1000; index += 1) {
    ruleMatches(`Bash(synthetic-${index} *)`, `Bash(synthetic-${index} run)`);
  }
  // Asserted, not assumed. Checking only that results survive an eviction stays
  // true with the cap deleted, so it would guard nothing.
  const stats = matchCacheStats();
  assert.ok(stats.compiled <= limit, `compiled cache ${stats.compiled} exceeds ${limit}`);
  assert.ok(stats.normalized <= limit, `normalized cache ${stats.normalized} exceeds ${limit}`);

  assert.equal(ruleMatches('Bash(git status *)', 'Bash(git status --short)'), true);
  assert.equal(ruleMatches('Bash(git stash *)', 'Bash(git status --short)'), false);
  assert.equal(normalizeRule('Bash(git:*)'), 'Bash(git *)');
  assert.deepEqual(processAllowList(['Bash(git status --short)', 'Bash(git status *)']),
    ['Bash(git status *)'], 'and the pipeline still collapses after an eviction');
});
