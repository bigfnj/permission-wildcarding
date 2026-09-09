'use strict';

// One implementation of Claude Code's documented rule matching, shared by the
// wildcarding pass and the dashboard so the two cannot drift apart. Citations
// live in docs/claude-code-permissions.md; the two rules that are easy to miss:
//
//   1. `Tool(cmd:*)` is an equivalent spelling of `Tool(cmd *)`. A matcher that
//      knows only one form treats the two as unrelated rules, so it keeps both
//      in the allow list and reports a covered family as uncovered.
//   2. A trailing `*` with a space before it ALSO matches the bare command:
//      `Bash(ls *)` matches `ls`, and `Bash(git log *)` matches `git log`. That
//      holds only while the trailing `*` is the rule's only wildcard, so an
//      entry carrying a second `*` does not get the bare-command allowance.

const RULE_SHAPE = /^([A-Za-z_][A-Za-z0-9_]*)\(([\s\S]*)\)$/;

// Both rules below are documented for command specifiers, which is where a
// space separates a prefix from its arguments. Other tools use their own
// specifier grammar: a `Read(**/x)` path glob, or a `Skill(name:args)` where
// the colon is a field separator rather than the trailing-wildcard suffix.
// Applying command semantics there would be an inference, and the cost of
// being wrong is pruning a rule someone still needs, so it is not applied.
const COMMAND_TOOLS = new Set(['Bash', 'PowerShell']);

// Both caches below are keyed on the exact rule string and hold the result of a
// pure function of that string, so nothing in them can go stale. That is what
// earns a cache here, and it is worth naming the contrast: auto-learn-manager.js
// deliberately refuses to cache a managed-policy decision, because that file is
// a client-refreshed copy and a stored verdict could contradict it. A string in,
// a string out, has no such hazard.
//
// Why it is worth anything: `ruleMatches` rebuilt a RegExp on every call, and
// `isCoveredBy` sits inside both quadratic passes of `processAllowList`.
// Measured on a real 316-entry allow list, one pass was 192,150 compilations
// and 507 ms; with these two maps it is 316 compilations.
//
// Capped because the lifetime differs by two orders of magnitude between the two
// callers: the hook process exits after one pass, while the VS Code extension
// host holds this module for the whole session. A real allow list plus a managed
// policy is a few hundred distinct strings, so reaching this limit means a caller
// is synthesizing rules in a loop, which is a bug rather than a workload.
// Eviction is a wholesale clear, because an LRU's bookkeeping would cost more
// than the compile it saves.
const MATCH_CACHE_LIMIT = 5000;
const normalizedRules = new Map();
const compiledRules = new Map();

// `undefined` is the miss sentinel, which is why the compiled cache stores an
// explicit `null` for a rule that cannot compile rather than leaving it absent.
function cached(store, key, build) {
  const hit = store.get(key);
  if (hit !== undefined) return hit;
  const value = build();
  if (store.size >= MATCH_CACHE_LIMIT) store.clear();
  store.set(key, value);
  return value;
}

function escapeLiteral(value) {
  return String(value).replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeRuleUncached(rule) {
  const text = String(rule == null ? '' : rule);
  const parsed = RULE_SHAPE.exec(text);
  if (!parsed) return text;
  const [, tool, inner] = parsed;
  if (!COMMAND_TOOLS.has(tool)) return text;
  return inner.endsWith(':*') ? `${tool}(${inner.slice(0, -2)} *)` : text;
}

// Rewrites the `:*` spelling to the ` *` spelling for a command tool. Anything
// else is returned unchanged.
//
// Only a string is cached. `null` and `undefined` both normalize to `''` and
// must keep doing so, and keying them in the same map as the empty string would
// be a distinction this function does not draw but a caller might rely on.
function normalizeRule(rule) {
  if (typeof rule !== 'string') return normalizeRuleUncached(rule);
  return cached(normalizedRules, rule, () => normalizeRuleUncached(rule));
}

function ruleRegexSource(rule) {
  const normalized = normalizeRule(rule);
  const parsed = RULE_SHAPE.exec(normalized);
  if (parsed) {
    const [, tool, inner] = parsed;
    const wildcards = (inner.match(/\*/g) || []).length;
    if (COMMAND_TOOLS.has(tool) && wildcards === 1 && inner.endsWith(' *')) {
      // ` .*` optional, so the prefix alone matches too.
      return `${escapeLiteral(tool)}\\(${escapeLiteral(inner.slice(0, -2))}( .*)?\\)`;
    }
  }
  return escapeLiteral(normalized).replace(/\*/g, '.*');
}

// The compiled form of a rule, or `null` when it cannot compile.
//
// The `catch` is unreachable today and is kept as insurance rather than as a
// live path. Measured: `escapeLiteral` escapes every regex metacharacter except
// `*`, and `*` is always rewritten to `.*`, so no rule string can produce an
// invalid pattern. `Bash((`, `[`, `Bash({2,1})`, `\` and `(?<` all compile.
// Do NOT write a test asserting a rule "cannot compile": there is no such
// input, and the assertion would pass whether or not this guard exists. What is
// worth asserting, and is, is that a metacharacter is treated as a literal.
// The `null` sentinel exists so that if `escapeLiteral` ever narrows, the
// failure is cached rather than re-thrown on every call.
function compiledRule(rule) {
  return cached(compiledRules, rule, () => {
    try { return new RegExp(`^${ruleRegexSource(rule)}$`); }
    catch { return null; }
  });
}

// Does `rule` cover `permission`? Both sides are normalized, so a colon-form
// probe is understood as readily as a colon-form rule.
function ruleMatches(rule, permission) {
  // Before any normalization, so a non-string can never reach a cache key.
  if (typeof rule !== 'string' || typeof permission !== 'string') return false;
  const target = normalizeRule(permission);
  if (normalizeRule(rule) === target) return true;
  const pattern = compiledRule(rule);
  return pattern === null ? false : pattern.test(target);
}

// True when the two strings are the same rule written differently.
function sameRule(left, right) {
  return normalizeRule(left) === normalizeRule(right);
}

// Introspection, so the cap can be asserted rather than assumed. Without this a
// test can only check that results survive an eviction, which stays true if the
// cap is deleted entirely: a bound nothing observes is not a bound.
function matchCacheStats() {
  return { normalized: normalizedRules.size, compiled: compiledRules.size, limit: MATCH_CACHE_LIMIT };
}

module.exports = {
  normalizeRule, ruleRegexSource, ruleMatches, sameRule,
  matchCacheStats, MATCH_CACHE_LIMIT,
};
