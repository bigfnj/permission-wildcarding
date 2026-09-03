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

function escapeLiteral(value) {
  return String(value).replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}

// Rewrites the `:*` spelling to the ` *` spelling for a command tool. Anything
// else is returned unchanged.
function normalizeRule(rule) {
  const text = String(rule == null ? '' : rule);
  const parsed = RULE_SHAPE.exec(text);
  if (!parsed) return text;
  const [, tool, inner] = parsed;
  if (!COMMAND_TOOLS.has(tool)) return text;
  return inner.endsWith(':*') ? `${tool}(${inner.slice(0, -2)} *)` : text;
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

// Does `rule` cover `permission`? Both sides are normalized, so a colon-form
// probe is understood as readily as a colon-form rule.
function ruleMatches(rule, permission) {
  if (typeof rule !== 'string' || typeof permission !== 'string') return false;
  const target = normalizeRule(permission);
  if (normalizeRule(rule) === target) return true;
  try { return new RegExp(`^${ruleRegexSource(rule)}$`).test(target); }
  catch { return false; }
}

// True when the two strings are the same rule written differently.
function sameRule(left, right) {
  return normalizeRule(left) === normalizeRule(right);
}

module.exports = { normalizeRule, ruleRegexSource, ruleMatches, sameRule };
