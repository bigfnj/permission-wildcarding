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

const { normalizeRule } = require('./permission-match');

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
  return tokens.length ? { tool, tokens } : null;
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
      ask: [], allow: [], deny: [], hookEvents: [], managedHooksOnly: false,
    };
  }
  const permissions = raw && typeof raw.permissions === 'object' && raw.permissions ? raw.permissions : {};
  const prefixes = (list) => (Array.isArray(list) ? list : []).map(rulePrefix).filter(Boolean);
  return {
    path: target, present: true, unreadable: false, error: null,
    ask: prefixes(permissions.ask),
    allow: prefixes(permissions.allow),
    deny: prefixes(permissions.deny),
    hookEvents: raw && typeof raw.hooks === 'object' && raw.hooks ? Object.keys(raw.hooks) : [],
    managedHooksOnly: raw ? raw.allowManagedHooksOnly === true : false,
  };
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
  if (!mine) return 'unknown';
  const applies = (rules, predicate) => rules.some((rule) =>
    rule.tool === mine.tool && predicate(rule));
  if (applies([...policy.deny, ...policy.ask], (rule) => coversPrefix(mine.tokens, rule.tokens))) return 'inert';
  if (applies([...policy.deny, ...policy.ask], (rule) => coversPrefix(rule.tokens, mine.tokens))) return 'partial';
  if (applies(policy.allow, (rule) => coversPrefix(mine.tokens, rule.tokens))) return 'redundant';
  return 'effective';
}

// True when a user hook on this event is silently dropped, which is how a
// PreToolUse auto-approve hook can be registered and never run.
function hookEventAllowed(policy, event) {
  if (!policy || !policy.present || !policy.managedHooksOnly) return true;
  return policy.hookEvents.includes(String(event));
}

module.exports = {
  defaultPolicyPath, readPolicy, rulePrefix, coversPrefix,
  assessPermission, hookEventAllowed,
};
