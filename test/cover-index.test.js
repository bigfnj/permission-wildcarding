'use strict';

// The coverage index, proved equivalent to the scan it replaces.
//
// The two coverage scans in processAllowList were 99.8% of a pass the hook pays
// on every tool call — 348,588 RegExp.test() calls at 423 entries, and quadratic
// on a list that only grows. The index makes that linear, but it decides nothing:
// it narrows the candidate set and `isCoveredBy` still answers. So the only error
// class that can change a result is a false NEGATIVE, and that is exactly what
// these tests hunt.
//
// The oracle is the full scan, kept in the codebase permanently. Every assertion
// below compares index output against oracle output over the same pool, so the
// two cannot drift without a test going red and naming the input that split them.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { isCoveredBy, createCoverIndex, processAllowList } = require('../src/permissions');

// The full scan the index replaces. Deliberately written out here rather than
// imported, so a change to the production path cannot silently change the oracle.
const oracleCoveredBy = (specific, pool) => pool.filter((rule) => isCoveredBy(specific, rule));

function assertAgrees(t, pool, candidates, label) {
  const index = createCoverIndex(pool);
  let disagreements = 0;
  for (const candidate of candidates) {
    const expected = oracleCoveredBy(candidate, pool);
    const actual = index.coveredBy(candidate);
    // Order can differ (buckets then fallback), the SET cannot.
    const e = [...new Set(expected)].sort();
    const a = [...new Set(actual)].sort();
    if (JSON.stringify(e) !== JSON.stringify(a)) {
      disagreements += 1;
      assert.deepEqual(a, e, `${label}: cover-set differs for ${candidate}`);
    }
    assert.equal(index.covers(candidate), expected.length > 0,
      `${label}: covers() differs for ${candidate}`);
  }
  assert.equal(disagreements, 0);
}

// The shapes that break a naive literal-prefix index. Each is here because the
// real matcher was probed and returned the answer noted.
const ADVERSARIAL = [
  'Bash(git *)',            // the ordinary case
  'Bash(git:*)',            // the other spelling of the same rule
  'Bash(git status *)',     // two-token literal
  'Bash(g* *)',             // glob INSIDE the token — unreachable by lookup
  'Bash(mkfs* *)',          // ditto, and it ships in the starter pack's deny half
  'Bash(*)',                // tool-wide
  'Bash( *)',               // empty literal with a space
  'Bash(rm -rf /*)',        // a glob that is not a trailing scope wildcard
  'PowerShell(dotnet *)',   // the other command tool
  'PowerShell(& *)',        // the call-operator form
  'Read(*)',                // a non-command tool
  // Colon-form scope on tools where `:` is NOT normalised to a space. This is
  // the class that shipped broken: coverIndexKey treats `:` as a token boundary
  // and coverLookupKeys did not, so the rule was indexed under a key no lookup
  // could generate — and being indexed, it was not in the linear fallback
  // either. Bash/PowerShell hid it because matching rewrites their `:*` to ` *`.
  'Skill(dataviz:*)',       // ships in patterns/starter-pack.json
  'Skill(claude-api:*)',    // ditto
  'WebFetch(domain:*)',     // documented Claude Code syntax
  'mcp__server__tool(a:*)', // an MCP tool with an argument
  'Skill(a:b:*)',           // two colons, so the boundary is the LAST one
  'WebSearch',              // no argument at all
  'mcp__server__tool',      // no parentheses
  'Bash("C:\\Program Files\\x.exe" *)',       // quoted path with a space
  'Bash("C:\\Program  Files\\x.exe" *)',      // ...and with a DOUBLE space
  'Bash(./build.sh *)',     // relative path root
];

const CANDIDATES = [
  'Bash(git)', 'Bash(git status)', 'Bash(git status --short)', 'Bash(gi)', 'Bash(gi t)',
  'Bash(github)', 'Bash(mkfs.ext4 /dev/sda)', 'Bash(rm -rf /home)', 'Bash(rg foo)',
  'PowerShell(dotnet build)', 'PowerShell(& "app.exe" run)', 'Read(/etc/passwd)',
  'WebSearch', 'mcp__server__tool', 'Bash("C:\\Program Files\\x.exe" verify)',
  'Bash("C:\\Program  Files\\x.exe" verify)', 'Bash(./build.sh --release)',
  'Bash()', 'Bash( )', 'Bash(git  status)',
  // The colon-form candidates. `Skill(other:report)` and `Skill(dataviz)` are
  // the negatives — a fix that made `:` a boundary too eagerly would start
  // reporting those as covered, and the oracle says they are not.
  'Skill(dataviz:report)', 'Skill(claude-api:messages)', 'Skill(other:report)',
  'Skill(dataviz)', 'Skill(dataviz:)', 'Skill(a:b:c)', 'Skill(a:bb:c)',
  'WebFetch(domain:github.com)', 'WebFetch(domain:)', 'mcp__server__tool(a:b)',
];

test('the index agrees with the full scan on adversarial shapes', (t) => {
  // Every candidate against the whole adversarial pool, and each rule against a
  // pool of every other rule — so a rule is exercised as candidate and coverer.
  assertAgrees(t, ADVERSARIAL, [...CANDIDATES, ...ADVERSARIAL], 'adversarial pool');
});

test('a glob inside a token is still found, via the fallback', (t) => {
  // The case a literal-prefix index cannot see. If these regress, the fallback
  // pool has been mis-classified and coverage silently shrinks.
  const index = createCoverIndex(['Bash(g* *)', 'Bash(mkfs* *)']);
  assert.deepEqual(index.coveredBy('Bash(git status)'), ['Bash(g* *)']);
  assert.deepEqual(index.coveredBy('Bash(mkfs.ext4 /dev/sda)'), ['Bash(mkfs* *)']);
  assert.equal(index.stats().indexed, 0, 'neither rule is indexable');
  assert.equal(index.stats().fallback, 2, 'both must land in the fallback');
});

test('the trailing star matches empty, and identity is not coverage', (t) => {
  const index = createCoverIndex(['Bash(git *)', 'Bash(git:*)']);
  assert.equal(index.covers('Bash(git)'), true, 'the trailing star matches empty');
  // Tool(cmd:*) and Tool(cmd *) are the SAME rule, not one covering the other,
  // so neither may report the other as its coverer.
  assert.deepEqual(index.coveredBy('Bash(git *)'), oracleCoveredBy('Bash(git *)', ['Bash(git *)', 'Bash(git:*)']));
  assert.deepEqual(index.coveredBy('Bash(git:*)'), oracleCoveredBy('Bash(git:*)', ['Bash(git *)', 'Bash(git:*)']));
});

test('the index agrees with the full scan over the starter pack', (t) => {
  const packPath = path.resolve(__dirname, '..', 'patterns', 'starter-pack.json');
  const pack = JSON.parse(fs.readFileSync(packPath, 'utf8'));
  assert.ok(pack.length > 300, `expected a real pack, got ${pack.length}`);
  assertAgrees(t, pack, pack, 'starter pack');

  // The pack against itself is not enough, and that is why it stayed green
  // while five oracle-confirmed false negatives shipped: it holds
  // `Skill(dataviz:*)` but no `Skill(dataviz:report)` for that rule to cover,
  // so the only key ever exercised is the tool-wide one. Every scope wildcard
  // in the pack now gets a candidate SYNTHESISED under it, in both spellings,
  // which is what a real user's list accumulates.
  const derived = [];
  for (const rule of pack) {
    const parts = /^([A-Za-z][A-Za-z0-9:_-]*)\((.*)\)$/s.exec(rule);
    if (!parts) continue;
    const [, tool, arg] = parts;
    if (!/\*\s*$/.test(arg)) continue;
    const literal = arg.replace(/\*\s*$/, '').replace(/[\s:]+$/, '');
    if (literal === '') continue;
    derived.push(`${tool}(${literal} probe)`, `${tool}(${literal}:probe)`, `${tool}(${literal})`);
  }
  assert.ok(derived.length > 100, `expected many derived candidates, got ${derived.length}`);
  assertAgrees(t, pack, derived, 'starter pack + synthesised candidates');
});

test('the index agrees with the full scan over a generated corpus', (t) => {
  // Deterministic pseudo-random, so a failure is reproducible.
  let seed = 20260910;
  const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const roots = ['git', 'gh', 'npm', 'rg', 'fd', 'mkfs', 'g', 'dotnet', 'python'];
  const subs = ['status', 'push', 'run', 'build', 'install', ''];
  // Both halves of the tool space. Only Bash and PowerShell have their `:*`
  // rewritten to ` *` before matching, so a corpus of just those two makes the
  // separator axis vacuous — 300 cases, 20% of them colons, and not one could
  // reach the false negative that shipped. The non-command tools carry it.
  const tools = ['Bash', 'PowerShell', 'Skill', 'WebFetch', 'mcp__server__tool', 'Read'];
  const pool = [];
  const candidates = [];
  for (let i = 0; i < 300; i += 1) {
    const tool = tools[Math.floor(rand() * tools.length)];
    const root = roots[Math.floor(rand() * roots.length)];
    const sub = subs[Math.floor(rand() * subs.length)];
    const glob = rand() < 0.25 ? '*' : '';        // glob mid-token
    const sep = rand() < 0.4 ? ':' : ' ';
    // Separated the same way in the rule and the candidate, so a colon-scoped
    // rule actually gets a colon-scoped candidate to be tested against.
    const join = rand() < 0.5 ? ':' : ' ';
    pool.push(`${tool}(${root}${glob}${sub ? `${join}${sub}` : ''}${sep}*)`);
    candidates.push(`${tool}(${root}${sub ? `${join}${sub}` : ''}${rand() < 0.5 ? `${join}--flag` : ''})`);
  }
  assertAgrees(t, pool, candidates, 'generated corpus');
});

test('processAllowList is unchanged on the real allow list, if one is present', (t) => {
  // Belt and braces against the actual data this runs on. Skipped where there is
  // no settings.json, so CI on a fresh runner stays green.
  const settings = path.join(process.env.USERPROFILE || process.env.HOME || '', '.claude', 'settings.json');
  let allow;
  try { allow = JSON.parse(fs.readFileSync(settings, 'utf8')).permissions.allow; }
  catch { t.skip('no local settings.json to compare against'); return; }
  if (!Array.isArray(allow) || allow.length < 50) { t.skip('allow list too small to be interesting'); return; }

  // The oracle pipeline, recomputed here with the full scan.
  const existingScopes = allow.filter((p) => /\*\s*\)$/.test(p));
  const { generalizePermission } = require('../src/permissions');
  const generalized = [...new Set(allow.map((p) =>
    (existingScopes.some((s) => s !== p && isCoveredBy(p, s)) ? p : generalizePermission(p))))];
  const oracle = generalized.filter((p, i) =>
    !generalized.some((o, j) => i !== j && isCoveredBy(p, o)));

  assert.deepEqual(processAllowList(allow), oracle,
    `the indexed pipeline must match the full scan over all ${allow.length} live entries`);
});
