'use strict';

// Reads the managed policy Claude Code caches on disk, so the learner can tell
// a grant that will work from one that cannot.
//
// Managed settings sit at the highest precedence tier and rules evaluate deny,
// then ask, then allow. A managed `ask` entry therefore beats anything written
// into user `permissions.allow`: proposing such a family produces a rule that
// changes nothing, and the prompt keeps coming. A managed `allow` entry means
// the opposite, that a grant would be redundant rather than a win.
//
// Two deliberate limits. This is a CACHE, refreshed by the client, so it is
// read as advisory: it can withhold a proposal and it can label one, and it is
// never a reason to widen anything. And absence proves nothing, because a
// machine with no managed policy simply has no file here.
//
// The file uses the `Tool(cmd:*)` spelling exclusively, which is why matching
// goes through permission-match rather than a local regex.

const fs = require('fs');
const os = require('os');
const path = require('path');

const { normalizeRule, ruleMatches } = require('./permission-match');

const COMMAND_TOOLS = new Set(['Bash', 'PowerShell']);
const RULE_SHAPE = /^([A-Za-z_][A-Za-z0-9_]*)\(([\s\S]*)\)$/;

function defaultPolicyPath(home) {
  return path.join(path.resolve(home || os.homedir()), '.claude', 'remote-settings.json');
}

// A rule becomes a tool plus the command tokens it fixes. `Bash(docker:*)` is
// the prefix ['docker'], so it governs every command starting with it.
function rulePrefix(rule) {
  const parsed = RULE_SHAPE.exec(normalizeRule(rule));
  if (!parsed) return null;
  const [, tool, inner] = parsed;
  if (!COMMAND_TOOLS.has(tool)) return null;
  const specifier = inner.endsWith(' *') ? inner.slice(0, -2) : inner;
  const tokens = specifier.trim().split(/\s+/).filter(Boolean);
  // `text` is kept so a report can name the rule it lost to. A bare verdict
  // sends the reader hunting through a few hundred managed entries for the one
  // that beat them.
  return tokens.length ? { tool, tokens, text: String(rule) } : null;
}

function coversPrefix(commandTokens, ruleTokens) {
  return ruleTokens.length <= commandTokens.length &&
    ruleTokens.every((token, index) => token.toLowerCase() === commandTokens[index].toLowerCase());
}

function readPolicy(options = {}) {
  const target = options.policyPath || defaultPolicyPath(options.home);
  let raw;
  try { raw = JSON.parse(fs.readFileSync(target, 'utf8').replace(/^﻿/, '')); }
  catch (error) {
    // Unreadable and absent are different, and neither is "no policy". A parse
    // failure is reported so a caller can say the check ran degraded rather
    // than silently treating the machine as unmanaged.
    return {
      path: target, present: false,
      unreadable: error.code !== 'ENOENT',
      error: error.code === 'ENOENT' ? null : error.message,
      ask: [], allow: [], deny: [], raw: { ask: [], allow: [], deny: [] },
      hookEvents: [], managedHooksOnly: false,
    };
  }
  const permissions = raw && typeof raw.permissions === 'object' && raw.permissions ? raw.permissions : {};
  const prefixes = (list) => (Array.isArray(list) ? list : []).map(rulePrefix).filter(Boolean);
  // `prefixes` drops every non-command rule, which is why a Read or Edit rule
  // used to be invisible to every verdict below. The rule text is kept beside
  // it so the other specifier grammars can be matched whole.
  const texts = (list) => (Array.isArray(list) ? list : [])
    .filter((rule) => typeof rule === 'string' && rule.trim());
  return {
    path: target, present: true, unreadable: false, error: null,
    ask: prefixes(permissions.ask),
    allow: prefixes(permissions.allow),
    deny: prefixes(permissions.deny),
    raw: {
      ask: texts(permissions.ask),
      allow: texts(permissions.allow),
      deny: texts(permissions.deny),
    },
    hookEvents: raw && typeof raw.hooks === 'object' && raw.hooks ? Object.keys(raw.hooks) : [],
    managedHooksOnly: raw ? raw.allowManagedHooksOnly === true : false,
  };
}

// The tool a rule or permission belongs to. `Edit(**/*.ps1)` is `Edit`; a bare
// `Edit` with no specifier is also `Edit`. An mcp permission is its own tool
// name, so dots and hyphens are allowed in the bare form.
function toolOf(value) {
  const text = String(value == null ? '' : value).trim();
  const parsed = RULE_SHAPE.exec(text);
  if (parsed) return parsed[1];
  return /^[A-Za-z_][A-Za-z0-9_.-]*$/.test(text) ? text : null;
}

// A path specifier is not a command specifier. A managed glob is authored with
// forward slashes for a case-insensitive filesystem, so `Edit(**/*.ps1)` tested
// against `D:\repo\Build.PS1` missed on BOTH counts and the rule looked free.
// Folding case and separators can only ever make this module withhold or label
// more, never widen a grant, which is the direction it already documents.
function slashFold(value) {
  return value.replace(/\\/g, '/').toLowerCase();
}

// Does a managed rule govern this permission, for a tool whose specifier is not
// a command prefix? `rulePrefix` models Bash and PowerShell only, on purpose,
// so a `Read`, `Edit`, `WebFetch(domain:...)` or `mcp__server__tool` rule fell
// out of every verdict as `unknown`. Matching the whole permission string
// handles those grammars without teaching this module each one, which is what
// `shadowedByManaged` in policy-guard.js already does reactively. The one case
// a regex cannot express is the tool-level rule: a bare `Edit` carries no
// specifier and therefore governs every Edit call.
function coversPermission(rule, permission) {
  const ruleText = String(rule == null ? '' : rule).trim();
  const permText = String(permission == null ? '' : permission).trim();
  // MCP has two documented wildcard shapes and neither is a `Tool(specifier)`,
  // so `toolOf` reads the whole string as the tool name and they compared
  // unequal. Prefix matching on the `__` boundary is exact: unlike splitting on
  // `__`, it cannot mis-parse a server name that itself contains one.
  if (ruleText.startsWith('mcp__')) {
    const prefix = ruleText.endsWith('*') ? ruleText.slice(0, -1) : `${ruleText}__`;
    if (prefix.length > 'mcp__'.length - 1 && permText.startsWith(prefix)) return true;
  }
  const ruleTool = toolOf(ruleText);
  if (!ruleTool || ruleTool !== toolOf(permText)) return false;
  // A bare tool name has no specifier to match, so it covers the whole tool.
  // Tested on the trimmed text, because the untrimmed one was what the next
  // line used and a padded rule was invisible on every path.
  if (!RULE_SHAPE.test(ruleText)) return true;
  if (COMMAND_TOOLS.has(ruleTool)) return ruleMatches(ruleText, permText);
  return ruleMatches(slashFold(ruleText), slashFold(permText));
}

// Same vocabulary as the command path below, decided on rule text instead of
// command tokens. Order matters and mirrors it: covered is inert, covering is
// partial, a managed allow is redundant.
function assessByText(policy, permission) {
  if (!toolOf(permission)) return 'unknown';
  const raw = policy.raw || { ask: [], allow: [], deny: [] };
  const blocking = [...raw.deny, ...raw.ask];
  if (blocking.some((rule) => coversPermission(rule, permission))) return 'inert';
  if (blocking.some((rule) => coversPermission(permission, rule))) return 'partial';
  if (raw.allow.some((rule) => coversPermission(rule, permission))) return 'redundant';
  return 'effective';
}

// How a managed policy would treat the permission we are about to write.
//
//   'inert'     every command the grant matches also matches a managed ask or
//               deny, so the grant changes nothing and the prompt remains
//   'partial'   the grant is broader than such a rule, so part of it works
//   'redundant' a managed allow already covers it
//   'effective' the policy has nothing to say
function assessPermission(policy, permission) {
  if (!policy || !policy.present) return 'unknown';
  const mine = rulePrefix(permission);
  if (!mine) return assessByText(policy, permission);
  const applies = (rules, predicate) => rules.some((rule) =>
    rule.tool === mine.tool && predicate(rule));
  if (applies([...policy.deny, ...policy.ask], (rule) => coversPrefix(mine.tokens, rule.tokens))) return 'inert';
  if (applies([...policy.deny, ...policy.ask], (rule) => coversPrefix(rule.tokens, mine.tokens))) return 'partial';
  if (applies(policy.allow, (rule) => coversPrefix(mine.tokens, rule.tokens))) return 'redundant';
  return 'effective';
}

// The specific managed rule that outranks this permission, or null when none
// does. Same shape and vocabulary as `shadowedByManaged` in policy-guard.js,
// which answers the question reactively for the wildcarding pass off the raw
// settings object; this answers it for the learner off the normalized policy,
// so neither has to adopt the other's reader.
function overridingRule(policy, permission) {
  if (!policy || !policy.present) return null;
  const mine = rulePrefix(permission);
  if (!mine) {
    if (!toolOf(permission)) return null;
    const raw = policy.raw || { ask: [], allow: [], deny: [] };
    const deny = raw.deny.find((rule) => coversPermission(rule, permission));
    if (deny) return { decision: 'deny', rule: deny };
    const ask = raw.ask.find((rule) => coversPermission(rule, permission));
    return ask ? { decision: 'ask', rule: ask } : null;
  }
  const find = (rules) => rules.find((rule) =>
    rule.tool === mine.tool && coversPrefix(mine.tokens, rule.tokens)) || null;
  const deny = find(policy.deny);
  if (deny) return { decision: 'deny', rule: deny.text };
  const ask = find(policy.ask);
  return ask ? { decision: 'ask', rule: ask.text } : null;
}

// True when a user hook on this event is silently dropped, which is how a
// PreToolUse auto-approve hook can be registered and never run.
function hookEventAllowed(policy, event) {
  if (!policy || !policy.present || !policy.managedHooksOnly) return true;
  return policy.hookEvents.includes(String(event));
}

module.exports = {
  defaultPolicyPath, readPolicy, rulePrefix, coversPrefix,
  assessPermission, overridingRule, hookEventAllowed,
  coversPermission, toolOf,
};
