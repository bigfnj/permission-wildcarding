'use strict';

// Codex MAX — the Codex-side analogue of Claude's MAX mode.
//
// Claude MAX skips every prompt while keeping two floors underneath it:
// permissions.deny (a hook "allow" cannot override a deny rule) and Claude
// Code's hard circuit breakers. Codex has no deny-list equivalent, so its only
// available floor is the sandbox. Codex MAX therefore sets exactly one key —
// approval_policy — and deliberately leaves sandbox_mode alone. Setting
// sandbox_mode = "danger-full-access" as well would remove the last thing in
// Codex capable of refusing a command; that stays an explicit user decision.
//
// It aims for "never" but does not insist on it. An enterprise requirements
// bundle can declare which policies are legal at all — a real one reads
// allowed_approval_policies = ["on-request", "untrusted"], with "never" simply
// absent. Writing a forbidden value would not defeat the policy, only produce a
// config Codex rejects, so the toggle settles for the least-friction value the
// org permits and reports that it did. Where the org allows "never", nothing
// changes. See targetApproval below.
//
// The file is edited surgically, line by line, never parsed and re-serialised.
// A real config.toml carries literal-string Windows paths ('\\?\C:\...'),
// inline arrays, and nested [marketplaces.x] / [plugins."x@y"] tables; a
// round trip through a TOML library would reformat or corrupt them.

const fs = require('fs');
const os = require('os');
const path = require('path');

const CODEX_CONFIG = path.join(os.homedir(), '.codex', 'config.toml');
const CODEX_MAX_STATE_FILE = path.join(os.homedir(), '.claude', 'backups', 'wildcarding-codex-max.json');
const APPROVAL_NEVER = 'never';
// Codex accepts exactly these; anything else and Codex refuses to start.
const APPROVAL_VALUES = new Set(['untrusted', 'on-request', 'never']);
const APPROVAL_LINE = /^[ \t]*approval_policy[ \t]*=/;
const TABLE_HEADER = /^[ \t]*\[/;

function detectEol(text) {
  return /\r\n/.test(text) ? '\r\n' : '\n';
}

// A bare key belongs to the top-level table only until the first [table]
// header. Appending at end-of-file would silently place approval_policy inside
// whatever table happens to be last — the single most likely way to get this
// wrong, and it fails quietly rather than loudly.
function topLevelBound(lines) {
  for (let index = 0; index < lines.length; index += 1) {
    if (TABLE_HEADER.test(lines[index])) return index;
  }
  return lines.length;
}

function findApprovalLine(lines) {
  const bound = topLevelBound(lines);
  for (let index = 0; index < bound; index += 1) {
    // A commented-out key starts with '#', so the anchored match skips it.
    if (APPROVAL_LINE.test(lines[index])) return index;
  }
  return -1;
}

// The value as Codex would read it, or null when the key is absent. Both quote
// styles are accepted because a hand-edited config may use either.
function readApproval(text) {
  const lines = String(text || '').split(/\r?\n/);
  const at = findApprovalLine(lines);
  if (at === -1) return null;
  const match = /=[ \t]*(?:"([^"]*)"|'([^']*)'|(\S+))/.exec(lines[at]);
  if (!match) return null;
  const value = (match[1] ?? match[2] ?? match[3] ?? '').trim();
  return value || null;
}

function setApproval(text, value) {
  if (!APPROVAL_VALUES.has(value)) {
    throw new Error(`Unsupported Codex approval_policy: ${value}`);
  }
  const source = String(text || '');
  const eol = detectEol(source);
  const lines = source.split(/\r?\n/);
  const at = findApprovalLine(lines);
  const rendered = `approval_policy = "${value}"`;
  if (at !== -1) {
    if (lines[at] === rendered) return { text: source, changed: false };
    lines[at] = rendered;
    return { text: lines.join(eol), changed: true };
  }
  // Insert after the last real top-level key rather than at the bound, so the
  // new key groups with its siblings instead of being wedged between the blank
  // separator and the first table header.
  let insertAt = topLevelBound(lines);
  while (insertAt > 0 && lines[insertAt - 1].trim() === '') insertAt -= 1;
  lines.splice(insertAt, 0, rendered);
  return { text: lines.join(eol), changed: true };
}

function clearApproval(text) {
  const source = String(text || '');
  const eol = detectEol(source);
  const lines = source.split(/\r?\n/);
  const at = findApprovalLine(lines);
  if (at === -1) return { text: source, changed: false };
  lines.splice(at, 1);
  return { text: lines.join(eol), changed: true };
}

function readConfig(configPath = CODEX_CONFIG) {
  try { return fs.readFileSync(configPath, 'utf8'); }
  catch { return null; }
}

function readCodexMaxState(statePath = CODEX_MAX_STATE_FILE) {
  try {
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    return state && typeof state === 'object' ? state : {};
  } catch { return {}; }
}

function writeCodexMaxState(state, statePath = CODEX_MAX_STATE_FILE) {
  try {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n', 'utf8');
  } catch { /* best-effort — never block the toggle */ }
}

// ── enterprise policy ───────────────────────────────────────────────────────────
// Codex orgs ship a signed requirements bundle that Codex caches locally. It can
// restrict which approval policies are legal at all:
//
//   allowed_approval_policies = ["on-request", "untrusted"]
//
// where "never" — the value this toggle would like to write — is simply absent.
// Writing a forbidden value is not a way to win an argument with policy; it just
// produces a config Codex will reject. So the toggle asks first and settles for
// the least-friction value the org actually permits.
const CODEX_BUNDLE_CACHE = path.join(os.homedir(), '.codex', 'cloud-config-bundle-cache.json');
// Ordered least-friction first, so "best allowed" is a scan down this list.
const APPROVAL_BY_FRICTION = ['never', 'on-request', 'untrusted'];

function readEnterpriseBundle(bundlePath = CODEX_BUNDLE_CACHE) {
  try { return JSON.parse(fs.readFileSync(bundlePath, 'utf8')); }
  catch { return null; }
}

function enterpriseRequirements(bundle) {
  const managed = bundle?.signed_payload?.bundle?.requirements_toml?.enterprise_managed;
  if (!Array.isArray(managed)) return '';
  return managed.map((entry) => String(entry?.contents || '')).join('\n');
}

// Parsed off the requirements text rather than a TOML library: the bundle is
// managed by Codex, and one array is all that is needed.
// null  = the org expressed no restriction, so every value is available.
// []    = the org restricted the set and none of it is a policy we recognise —
//         fail closed, because treating an unreadable restriction as "no
//         restriction" is how a policy control silently stops controlling.
function allowedApprovalPolicies(bundle) {
  const match = /allowed_approval_policies\s*=\s*\[([^\]]*)\]/.exec(enterpriseRequirements(bundle));
  if (!match) return null;
  return [...match[1].matchAll(/["']([^"']+)["']/g)]
    .map((entry) => entry[1].trim())
    .filter((entry) => APPROVAL_VALUES.has(entry));
}

// The enterprise bundle also carries prefix rules that force a prompt no matter
// what a user rule says:
//
//   [[rules.prefix_rules]]
//   pattern = [{ any_of = ["curl", "wget", ...] }]
//   decision = "prompt"
//   justification = "Network access or file transfer requires approval."
//
// These outrank anything Auto Learn can write, so a diagnostic that only reads
// user rules will confidently report "allowed" for a command the org prompts on.
function enterprisePrefixRules(bundle) {
  const text = enterpriseRequirements(bundle);
  const rules = [];
  for (const block of text.split(/\[\[rules\.prefix_rules\]\]/).slice(1)) {
    // Stop at the next table header so one block cannot absorb the next.
    const body = block.split(/\n\s*\[/)[0];
    const decision = /decision\s*=\s*["']([^"']+)["']/.exec(body)?.[1];
    if (!decision) continue;
    const roots = [...body.matchAll(/["']([^"']+)["']/g)]
      .map((entry) => entry[1])
      .filter((value) => value !== decision);
    const justification = /justification\s*=\s*["']([^"']*)["']/.exec(body)?.[1] || '';
    const patterns = roots.filter((value) => value !== justification);
    if (patterns.length) rules.push({ decision, patterns, justification });
  }
  return rules;
}

// The first enterprise rule governing this command root, or null.
function enterpriseDecisionFor(bundle, argv) {
  const root = String((Array.isArray(argv) ? argv[0] : argv) || '')
    .replace(/\\/g, '/').split('/').pop().toLowerCase().replace(/\.exe$/, '');
  if (!root) return null;
  for (const rule of enterprisePrefixRules(bundle)) {
    if (rule.patterns.some((pattern) => pattern.toLowerCase() === root)) return { ...rule, root };
  }
  return null;
}

function allowedSandboxModes(bundle) {
  const match = /allowed_sandbox_modes\s*=\s*\[([^\]]*)\]/.exec(enterpriseRequirements(bundle));
  if (!match) return null;
  const values = [...match[1].matchAll(/["']([^"']+)["']/g)].map((entry) => entry[1].trim());
  return values.length ? values : null;
}

// The value Codex MAX should aim for on this machine: "never" where allowed,
// otherwise the least-friction policy the org permits.
function targetApproval(bundle) {
  const allowed = allowedApprovalPolicies(bundle);
  if (!allowed) return { value: APPROVAL_NEVER, restricted: false, allowed: null };
  const value = APPROVAL_BY_FRICTION.find((policy) => allowed.includes(policy)) || null;
  return { value, restricted: !allowed.includes(APPROVAL_NEVER), allowed };
}

function isCodexMaxOn(text, bundle) {
  // `undefined` means "look it up"; an explicit `null` means "there is no
  // bundle". Collapsing the two with ?? would make it impossible to ask about a
  // machine with no enterprise policy — including from a test.
  const resolved = bundle === undefined ? readEnterpriseBundle() : bundle;
  const target = targetApproval(resolved);
  // MAX means "skip every prompt", and only approval_policy = "never" does that.
  // Where the org caps approval below "never" (target.restricted), the best value
  // MAX could write still prompts *and* equals the org's own enforced default, so
  // a config carrying it is not a MAX the user enabled — it is just the default.
  // Reporting it as "on" is the "MAX turned itself on again" bug: the org default
  // reads as a user action, and the card claims prompts are skipped when they are
  // not. So under a restriction, MAX is never on.
  if (target.value === null || target.restricted) return false;
  return readApproval(text) === target.value;
}

// Turning on records the prior value — including its *absence*, which is why
// the snapshot stores null rather than omitting the field. Turning off then
// knows whether to restore a value or remove the key entirely, instead of
// leaving behind an approval_policy the user never had.
function applyCodexMax(text, on, options = {}) {
  const statePath = options.statePath ?? CODEX_MAX_STATE_FILE;
  const now = typeof options.now === 'function' ? options.now : () => new Date().toISOString();
  const bundle = options.bundle !== undefined ? options.bundle : readEnterpriseBundle();
  const target = targetApproval(bundle);
  const source = text == null ? '' : String(text);
  if (on) {
    // Nothing this toggle can write that actually skips prompts. "never" is the
    // only value that does; where the org forbids it (target.restricted) or
    // permits no value at all (target.value === null), the least-friction policy
    // MAX could set still prompts and equals the org's own default. Writing it
    // and calling it "MAX on" is the false-positive the user reports, so say the
    // switch is unavailable instead of producing a no-op the card misreads.
    if (target.value === null || target.restricted) {
      return {
        changed: false, text: source, sandboxUntouched: true,
        blockedBy: 'enterprise-policy', allowed: target.allowed,
        target: target.value, restricted: target.restricted,
      };
    }
    if (isCodexMaxOn(source, bundle)) {
      return {
        changed: false, text: source, sandboxUntouched: true,
        target: target.value, restricted: target.restricted, allowed: target.allowed,
      };
    }
    writeCodexMaxState({ priorApproval: readApproval(source), savedAt: now() }, statePath);
    const result = setApproval(source, target.value);
    return {
      ...result, sandboxUntouched: true,
      target: target.value, restricted: target.restricted, allowed: target.allowed,
    };
  }
  if (!isCodexMaxOn(source, bundle)) return { changed: false, text: source, sandboxUntouched: true };
  const prior = readCodexMaxState(statePath).priorApproval;
  const result = prior && APPROVAL_VALUES.has(prior)
    ? setApproval(source, prior)
    : clearApproval(source);
  return { ...result, restoredTo: prior ?? null, sandboxUntouched: true };
}

// Reported alongside the toggle so the remaining floor is never a surprise.
function sandboxMode(text) {
  const lines = String(text || '').split(/\r?\n/);
  const bound = topLevelBound(lines);
  for (let index = 0; index < bound; index += 1) {
    if (/^[ \t]*sandbox_mode[ \t]*=/.test(lines[index])) {
      const match = /=[ \t]*(?:"([^"]*)"|'([^']*)'|(\S+))/.exec(lines[index]);
      if (match) return (match[1] ?? match[2] ?? match[3] ?? '').trim() || null;
    }
  }
  return null;
}

module.exports = {
  CODEX_CONFIG,
  CODEX_MAX_STATE_FILE,
  APPROVAL_NEVER,
  APPROVAL_VALUES,
  readConfig,
  readApproval,
  setApproval,
  clearApproval,
  isCodexMaxOn,
  applyCodexMax,
  sandboxMode,
  readCodexMaxState,
  writeCodexMaxState,
  CODEX_BUNDLE_CACHE,
  readEnterpriseBundle,
  allowedApprovalPolicies,
  allowedSandboxModes,
  enterprisePrefixRules,
  enterpriseDecisionFor,
  targetApproval,
  topLevelBound,
};
