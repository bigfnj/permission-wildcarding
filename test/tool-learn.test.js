'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { aggregateObservations, candidateKey, toolInvocation, isLearnableTool } = require('../src/auto-learn');
const { renderClaudePermissions, renderCodexRules } = require('../src/policy-exporters');

function observed(tool, target, status = 'success') {
  return { tool, kind: 'tool', command: target, status, source: 'claude' };
}

function families(observations, threshold = 1) {
  return Object.fromEntries(aggregateObservations(observations, { threshold })
    .map((item) => [item.key, item]));
}

test('a non-shell tool becomes a family only when it has a policy shape', () => {
  for (const name of ['mcp__github__create_issue', 'WebFetch', 'WebSearch', 'Edit', 'Read']) {
    assert.equal(isLearnableTool(name), true, name);
  }
  for (const name of ['TodoWrite', 'Task', 'Bash', '', 'mcp__only-one-part']) {
    assert.equal(isLearnableTool(name), false, name);
  }
  assert.equal(toolInvocation('TodoWrite', 'x'), null);
});

test('an MCP call proposes the exact tool, never the whole server', () => {
  const byKey = families([
    observed('mcp__github__create_issue', 'call'),
    observed('mcp__github__list_issues', 'call'),
  ]);
  const create = byKey['mcp:github__create_issue'];
  assert.equal(create.claudePermission, 'mcp__github__create_issue');
  assert.equal(create.autoSafe, false, 'an opaque capability is never automatic');
  assert.ok(byKey['mcp:github__list_issues'], 'each tool is its own family');

  const permissions = renderClaudePermissions(Object.values(byKey), { includeReviewed: true });
  assert.deepEqual(permissions, ['mcp__github__create_issue', 'mcp__github__list_issues']);
  assert.ok(!permissions.some((value) => value.includes('*')), 'no server-wide wildcard is ever emitted');
});

test('a web fetch proposes one domain, taken from the observed URL', () => {
  const byKey = families([
    observed('WebFetch', 'https://docs.anthropic.com/en/docs/claude-code?x=1#y'),
    observed('WebFetch', 'HTTPS://Docs.Anthropic.com/other'),
    observed('WebFetch', 'file:///etc/passwd'),
    observed('WebFetch', 'not a url'),
  ]);
  assert.deepEqual(Object.keys(byKey), ['webfetch:docs.anthropic.com'],
    'the host is normalized, and a non-http target is not a domain');
  const fetched = byKey['webfetch:docs.anthropic.com'];
  assert.equal(fetched.claudePermission, 'WebFetch(domain:docs.anthropic.com)');
  assert.equal(fetched.risk, 'network');
  assert.equal(fetched.autoSafe, false);
  // The path and query of the observed URL are evidence, not policy, and are
  // never persisted.
  assert.doesNotMatch(JSON.stringify(fetched), /docs\/claude-code|x=1/);
});

test('a file tool is counted but never turned into an inferred path rule', () => {
  const byKey = families([observed('Edit', 'file'), observed('Write', 'file'), observed('Read', 'file')]);
  for (const [key, expectedRisk] of [['edit:', 'write'], ['write:', 'write'], ['read:', 'unknown']]) {
    const family = byKey[key];
    assert.ok(family, key);
    assert.equal(family.claudePermission, null, 'a directory grant would be wider than the evidence');
    assert.equal(family.risk, expectedRisk);
    assert.equal(family.autoSafe, false);
  }
  // Crucially, nothing synthesizes a shell rule such as Bash(Edit *) from the
  // family prefix.
  assert.deepEqual(renderClaudePermissions(Object.values(byKey), { includeReviewed: true }), []);
});

test('tool families are Claude-only and are never automatically applied', () => {
  const byKey = families([
    observed('mcp__github__create_issue', 'call'),
    observed('WebFetch', 'https://example.com/x'),
    observed('WebSearch', 'search'),
    observed('Edit', 'file'),
  ]);
  const all = Object.values(byKey);

  // Threshold alone can never promote them: automatic export stays empty.
  assert.deepEqual(renderClaudePermissions(all, {}), []);
  assert.ok(all.every((item) => item.autoSafe === false));

  // Codex policy is argv prefixes for shell programs; none of these belong.
  assert.ok(!/prefix_rule/.test(renderCodexRules(all, { includeReviewed: true })));
});

test('a failed tool call is negative evidence like any other', () => {
  const byKey = families([
    observed('mcp__github__create_issue', 'call', 'success'),
    observed('mcp__github__create_issue', 'call', 'failed'),
  ]);
  const family = byKey['mcp:github__create_issue'];
  assert.equal(family.counts.success, 1);
  assert.equal(family.counts.failed, 1);
  assert.equal(candidateKey(family.key ? family : {}), family.key);
});
