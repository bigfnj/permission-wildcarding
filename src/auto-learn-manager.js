'use strict';

// Stateful orchestration for cross-agent Auto Learn. Transcript text is handed
// to the pure analyzers and is never written here. Durable state contains only
// normalized metadata, counters, hashed observation ids, and file cursors.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { aggregateObservations, isAutoSafeCandidate, COMPLEX_REASONS } = require('./auto-learn');
const { scanHistoryFiles } = require('./history-adapters');
const { createPolicyLock } = require('./policy-lock');
const { commandLaunch } = require('./exec-resolve');
const {
  readPolicy, assessPermission, overridingRule, coversPermission,
} = require('./managed-policy');
const {
  renderCodexRules, validateCodexRulesText, renderClaudePermissions, mergeClaudeAllow,
  mergeGeneratedCodexRules,
} = require('./policy-exporters');

const VERSION = 1;
const MODES = new Set(['observe', 'recommend', 'auto-safe']);
const CLAUDE_CLAIMS_VERSION = 1;
const OUTCOMES = new Set(['success', 'failed', 'unknown']);
const RISK_RANK = new Map([
  ['read-only', 0], ['unknown', 1], ['complex', 2], ['write', 3],
  ['shell', 4], ['network', 5], ['credential', 6], ['admin', 7], ['destructive', 8],
]);
const RETRY_RENAME = new Set(['EPERM', 'EACCES', 'EBUSY', 'ETXTBSY']);

function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function sleep(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
function hash(value) { return crypto.createHash('sha256').update(value ?? Buffer.alloc(0)).digest('hex'); }
function clean(value, length = 256) {
  return typeof value === 'string'
    ? value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, length)
    : '';
}
function positive(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 1 ? Math.floor(number) : fallback;
}
function configuredPath(home, value, fallback) {
  const chosen = value === undefined ? fallback : value;
  if (chosen === null || chosen === false || chosen === '') return null;
  let result = String(chosen);
  if (result === '~') result = home;
  else if (/^~[\\/]/.test(result)) result = path.join(home, result.slice(2));
  return path.resolve(result);
}
function configuredRoots(home, value, fallback) {
  const chosen = value === undefined ? fallback : value;
  return (Array.isArray(chosen) ? chosen : [chosen])
    .filter((item) => item !== null && item !== false && item !== undefined && item !== '')
    .map((item) => configuredPath(home, item, null));
}

function normalizedPath(value) {
  const result = path.resolve(String(value || '')).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? result.toLowerCase() : result;
}
function within(root, value) {
  if (!root || !value) return false;
  const base = normalizedPath(root);
  const child = normalizedPath(value);
  const relative = path.relative(base, child);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}
function candidateFingerprint(item) {
  return hash(Buffer.from(JSON.stringify({
    key: item.key, prefix: item.prefix, claudePermission: item.claudePermission,
    risk: item.risk, baseAutoSafe: item.baseAutoSafe, complex: item.complex,
    reasons: item.reasons, sources: item.sources, counts: item.counts,
  }), 'utf8'));
}
// Policy/state writes fail closed if the atomic rename cannot complete.
function atomicWrite(target, value) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = path.join(path.dirname(target),
    `.${path.basename(target)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  const data = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
  let fd;
  try {
    fd = fs.openSync(temp, 'wx', 0o600);
    let offset = 0;
    while (offset < data.length) offset += fs.writeSync(fd, data, offset, data.length - offset);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    try { fs.chmodSync(temp, fs.statSync(target).mode); } catch {}
    let last;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try { fs.renameSync(temp, target); return; }
      catch (error) {
        last = error;
        if (!RETRY_RENAME.has(error.code)) break;
        sleep(20 * (attempt + 1));
      }
    }
    throw last;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {}
    try { fs.unlinkSync(temp); } catch {}
  }
}

function snapshot(target) {
  try {
    const content = fs.readFileSync(target);
    return { exists: true, content, hash: hash(content) };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const content = Buffer.alloc(0);
    return { exists: false, content, hash: hash(content) };
  }
}
function unchanged(target, before) {
  const current = snapshot(target);
  return current.exists === before.exists && current.hash === before.hash;
}
function validPrefix(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 8) return null;
  if (value.some((token) => typeof token !== 'string' || !token || token.length > 256 ||
    /[\u0000-\u001f\u007f]/.test(token))) return null;
  return value.slice();
}
function counts(value) {
  const result = {};
  for (const name of OUTCOMES) result[name] = Math.max(0, Number(value?.[name]) || 0);
  result.total = result.success + result.failed + result.unknown;
  return result;
}
function refresh(candidate, threshold) {
  candidate.threshold = threshold;
  candidate.counts.total = candidate.counts.success + candidate.counts.failed + candidate.counts.unknown;
  candidate.successfulRuns = candidate.counts.success;
  candidate.failedRuns = candidate.counts.failed;
  candidate.unknownRuns = candidate.counts.unknown;
  candidate.sourceCount = candidate.sources.length;
  candidate.meetsThreshold = candidate.counts.success >= threshold;
  candidate.autoSafe = isAutoSafeCandidate(candidate);
  candidate.disposition = candidate.autoSafe ? 'auto-safe' : candidate.meetsThreshold ? 'review' : 'observe';
  return candidate;
}
function candidate(value, threshold) {
  if (!object(value)) return null;
  const key = clean(value.key, 512);
  const prefix = validPrefix(value.prefix);
  if (!key || !prefix) return null;
  const reasons = [...new Set((Array.isArray(value.reasons) ? value.reasons : [])
    .map((item) => clean(item, 80)).filter(Boolean))].sort();
  return refresh({
    key, tool: clean(value.tool, 64), shell: clean(value.shell, 32),
    kind: value.kind === 'tool' ? 'tool' : 'shell',
    root: clean(value.root, 256) || prefix[0], prefix,
    claudePermission: clean(value.claudePermission, 768) || null,
    risk: RISK_RANK.has(value.risk) ? value.risk : 'unknown',
    baseAutoSafe: value.baseAutoSafe === true,
    // Re-derived, not read back. The flag is OR-merged across observations and
    // so can only ever ratchet on; a state written while a chained link counted
    // as complexity holds it for families whose reasons never justified it, and
    // no amount of later clean evidence would clear it.
    complex: reasons.some((reason) => COMPLEX_REASONS.has(reason)),
    reasons,
    sources: [...new Set((Array.isArray(value.sources) ? value.sources : [])
      .map((item) => clean(item, 32)).filter(Boolean))].sort(),
    counts: counts(value.counts),
  }, threshold);
}
function applied(value) {
  const result = { claude: [], codex: [] };
  for (const kind of Object.keys(result)) result[kind] = [...new Set(
    (Array.isArray(value?.[kind]) ? value[kind] : []).map((key) => clean(key, 512)).filter(Boolean),
  )].sort();
  return result;
}
function codexTargets(value) {
  const result = {};
  if (!object(value)) return result;
  for (const [id, record] of Object.entries(value)) {
    if (!/^[a-f0-9]{16}$/.test(id) || !object(record)) continue;
    result[id] = {
      applied: [...new Set((Array.isArray(record.applied) ? record.applied : [])
        .map((key) => clean(key, 512)).filter(Boolean))].sort(),
      reviewed: [...new Set((Array.isArray(record.reviewed) ? record.reviewed : [])
        .map((key) => clean(key, 512)).filter(Boolean))].sort(),
    };
  }
  return result;
}
function managedClaude(value) {
  const result = {};
  if (!object(value)) return result;
  for (const [key, permission] of Object.entries(value)) {
    const safeKey = clean(key, 512);
    const safePermission = clean(permission, 768);
    if (safeKey && safePermission) result[safeKey] = safePermission;
  }
  return result;
}
function emptyClaudeClaims() {
  return { version: CLAUDE_CLAIMS_VERSION, permissions: {} };
}
function parseClaudeClaims(before, target) {
  if (!before.exists) return emptyClaudeClaims();
  let raw;
  try { raw = JSON.parse(before.content.toString('utf8').replace(/^\uFEFF/, '')); }
  catch (error) { throw new Error(`Cannot parse Claude policy claims: ${error.message}`); }
  if (!object(raw) || raw.version !== CLAUDE_CLAIMS_VERSION || !object(raw.permissions)) {
    throw new Error(`Cannot use malformed Claude policy claims registry: ${target}`);
  }
  const result = emptyClaudeClaims();
  for (const [permission, record] of Object.entries(raw.permissions)) {
    if (!permission || permission.length > 768 || /[\u0000-\u001f\u007f]/.test(permission) ||
        !object(record) || typeof record.managed !== 'boolean' || !Array.isArray(record.claimants)) {
      throw new Error(`Cannot use malformed Claude policy claims registry: ${target}`);
    }
    const claimants = [...new Set(record.claimants)].sort();
    if (!claimants.length || claimants.some((id) =>
      typeof id !== 'string' || !/^state-sha256:[a-f0-9]{24}$/.test(id))) {
      throw new Error(`Cannot use malformed Claude policy claims registry: ${target}`);
    }
    result.permissions[permission] = { managed: record.managed, claimants };
  }
  return result;
}
function renderClaudeClaims(value) {
  const permissions = {};
  for (const permission of Object.keys(value.permissions).sort()) {
    const record = value.permissions[permission];
    permissions[permission] = {
      managed: record.managed === true,
      claimants: [...new Set(record.claimants)].sort(),
    };
  }
  return JSON.stringify({ version: CLAUDE_CLAIMS_VERSION, permissions }, null, 2) + '\n';
}
function updateClaudeClaims(claims, claimantId, permissions, current, legacyManaged) {
  for (const record of Object.values(claims.permissions)) {
    record.claimants = record.claimants.filter((id) => id !== claimantId);
  }
  for (const permission of permissions) {
    let record = claims.permissions[permission];
    if (!record) {
      record = {
        managed: legacyManaged.has(permission) || !current.includes(permission),
        claimants: [],
      };
      claims.permissions[permission] = record;
    }
    if (!record.claimants.includes(claimantId)) record.claimants.push(claimantId);
    record.claimants.sort();
  }
  for (const [permission, record] of Object.entries(claims.permissions)) {
    if (record.claimants.length) continue;
    if (record.managed) current = current.filter((rule) => rule !== permission);
    delete claims.permissions[permission];
  }
  return current;
}
function grantSnapshot(state) {
  return {
    applied: applied(state.applied), reviewed: applied(state.reviewed),
    codexTargets: codexTargets(state.codexTargets), managedClaude: managedClaude(state.managedClaude),
  };
}
function restoreGrants(state, grants) {
  state.applied = applied(grants?.applied);
  state.reviewed = applied(grants?.reviewed);
  state.codexTargets = codexTargets(grants?.codexTargets);
  state.managedClaude = managedClaude(grants?.managedClaude);
}
// How many times each managed rule actually cost a prompt. The KEY is a managed
// rule string, which is org policy: no path, argument or prompt text is
// involved, which is what lets this be persisted at all. The decision (ask vs
// deny) is deliberately NOT stored, because the policy is a client-refreshed
// cache and a decision cached here could contradict the live file; it is
// resolved at report time instead.
//
// Capped because this is a new dimension in a long-lived file. A managed policy
// carries a few dozen rules, so the limit is generous and hitting it means a
// bug rather than a workload.
const MANAGED_HITS_LIMIT = 200;
function managedHits(value) {
  if (!object(value)) return {};
  const entries = [];
  for (const [rule, record] of Object.entries(value)) {
    const text = clean(rule, 200);
    if (!text || !object(record)) continue;
    const hits = Math.max(0, Math.floor(Number(record.hits) || 0));
    if (!hits) continue;
    const tools = Array.isArray(record.tools)
      ? [...new Set(record.tools.map((item) => clean(item, 48)).filter(Boolean))].sort().slice(0, 12)
      : [];
    entries.push([text, { hits, tools }]);
  }
  entries.sort((a, b) => b[1].hits - a[1].hits || a[0].localeCompare(b[0]));
  const result = {};
  for (const [rule, record] of entries.slice(0, MANAGED_HITS_LIMIT)) result[rule] = record;
  return result;
}
function cursor(value) {
  if (!object(value)) return null;
  const result = {};
  for (const name of ['size', 'offset', 'mtimeMs', 'ino', 'headLength', 'tailStart', 'tailLength']) {
    if (Number.isFinite(value[name]) && value[name] >= 0) result[name] = value[name];
  }
  for (const name of ['source', 'headHash', 'tailHash']) {
    const text = clean(value[name], name === 'source' ? 32 : 128);
    if (text) result[name] = text;
  }
  return Number.isFinite(result.size) ? result : null;
}

function emptyState(mode, threshold) {
  return {
    version: VERSION, mode, threshold, candidates: {}, observationHashes: {}, cursors: {},
    applied: { claude: [], codex: [] }, reviewed: { claude: [], codex: [] },
    codexTargets: {}, managedClaude: {}, managedHits: {},
    lastScanAt: null, lastScanStats: null,
    lastApplication: null,
  };
}
function lastApplication(value) {
  if (!object(value) || !Array.isArray(value.targets)) return null;
  const targets = value.targets.map((item) => {
    if (!object(item) || !['claude', 'claude-claims', 'codex'].includes(item.kind)) return null;
    const beforeHash = /^[a-f0-9]{64}$/.test(item.beforeHash || '') ? item.beforeHash : null;
    const afterHash = /^[a-f0-9]{64}$/.test(item.afterHash || '') ? item.afterHash : null;
    if (!item.path || !item.backupPath || !beforeHash || !afterHash) return null;
    return {
      kind: item.kind, path: path.resolve(item.path), backupPath: path.resolve(item.backupPath),
      beforeHash, afterHash, existed: item.existed === true,
    };
  }).filter(Boolean);
  return targets.length ? {
    at: clean(value.at, 64) || null, targets,
    grantsBefore: {
      applied: applied(value.grantsBefore?.applied || value.appliedBefore),
      reviewed: applied(value.grantsBefore?.reviewed),
      codexTargets: codexTargets(value.grantsBefore?.codexTargets),
      managedClaude: managedClaude(value.grantsBefore?.managedClaude),
    },
    grantsAfter: {
      applied: applied(value.grantsAfter?.applied || value.appliedAfter),
      reviewed: applied(value.grantsAfter?.reviewed),
      codexTargets: codexTargets(value.grantsAfter?.codexTargets),
      managedClaude: managedClaude(value.grantsAfter?.managedClaude),
    },
  } : null;
}
function sanitizeState(raw, mode, threshold) {
  const state = emptyState(mode, threshold);
  if (!object(raw)) return state;
  state.mode = MODES.has(raw.mode) ? raw.mode : mode;
  state.threshold = positive(raw.threshold, threshold);
  if (object(raw.candidates)) for (const value of Object.values(raw.candidates)) {
    const item = candidate(value, state.threshold);
    if (item) state.candidates[item.key] = item;
  }
  if (object(raw.observationHashes)) for (const [id, value] of Object.entries(raw.observationHashes)) {
    if (!/^[a-f0-9]{64}$/.test(id) || !object(value)) continue;
    const key = clean(value.key, 512);
    if (key) state.observationHashes[id] = {
      key, outcome: OUTCOMES.has(value.outcome) ? value.outcome : 'unknown',
      source: clean(value.source, 32) || 'unknown',
    };
  }
  if (object(raw.cursors)) for (const [file, value] of Object.entries(raw.cursors)) {
    const safe = cursor(value);
    const id = /^path-sha256:[a-f0-9]{24}$/.test(file)
      ? file : `path-sha256:${hash(Buffer.from(normalizedPath(file), 'utf8')).slice(0, 24)}`;
    if (safe) state.cursors[id] = safe;
  }
  state.applied = applied(raw.applied);
  state.reviewed = applied(raw.reviewed);
  state.codexTargets = codexTargets(raw.codexTargets);
  state.managedClaude = managedClaude(raw.managedClaude);
  state.managedHits = managedHits(raw.managedHits);
  state.lastScanAt = clean(raw.lastScanAt, 64) || null;
  if (object(raw.lastScanStats)) state.lastScanStats = {
    files: Math.max(0, Number(raw.lastScanStats.files) || 0),
    observations: Math.max(0, Number(raw.lastScanStats.observations) || 0),
    errors: Math.max(0, Number(raw.lastScanStats.errors) || 0),
  };
  state.lastApplication = lastApplication(raw.lastApplication);
  return state;
}
function persistentState(state) {
  const candidates = {};
  for (const key of Object.keys(state.candidates).sort()) {
    const item = state.candidates[key];
    candidates[key] = {
      key, tool: item.tool, kind: item.kind, shell: item.shell, root: item.root,
      prefix: item.prefix.slice(),
      claudePermission: item.claudePermission, risk: item.risk, baseAutoSafe: item.baseAutoSafe,
      complex: item.complex, reasons: item.reasons.slice(), sources: item.sources.slice(),
      counts: { ...item.counts },
    };
  }
  return {
    version: VERSION, mode: state.mode, threshold: state.threshold, candidates,
    observationHashes: state.observationHashes, cursors: state.cursors,
    applied: applied(state.applied), reviewed: applied(state.reviewed),
    codexTargets: codexTargets(state.codexTargets), managedClaude: managedClaude(state.managedClaude),
    managedHits: managedHits(state.managedHits),
    lastScanAt: state.lastScanAt, lastScanStats: state.lastScanStats,
    lastApplication: state.lastApplication,
  };
}
function maxRisk(left, right) {
  const a = RISK_RANK.has(left) ? left : 'unknown';
  const b = RISK_RANK.has(right) ? right : 'unknown';
  return RISK_RANK.get(b) > RISK_RANK.get(a) ? b : a;
}
function mergeCandidate(existing, fresh, threshold) {
  if (!existing) {
    const created = candidate(fresh, threshold);
    if (!created) return null;
    created.counts = { success: 0, failed: 0, unknown: 0, total: 0 };
    return refresh(created, threshold);
  }
  existing.risk = maxRisk(existing.risk, fresh.risk);
  existing.baseAutoSafe = existing.baseAutoSafe && fresh.baseAutoSafe;
  existing.complex = existing.complex || fresh.complex;
  if (existing.claudePermission !== fresh.claudePermission) existing.claudePermission = null;
  if (JSON.stringify(existing.prefix) !== JSON.stringify(fresh.prefix)) {
    existing.complex = true;
    existing.baseAutoSafe = false;
    existing.reasons.push('prefix-conflict');
  }
  existing.reasons = [...new Set([...existing.reasons, ...fresh.reasons])].sort();
  existing.sources = [...new Set([...existing.sources, ...fresh.sources])].sort();
  return refresh(existing, threshold);
}
function observedOutcome(item) {
  if (item.counts?.success === 1) return 'success';
  if (item.counts?.failed === 1) return 'failed';
  return 'unknown';
}
function changeOutcome(item, before, after) {
  if (before === 'failed' && after !== 'failed') return false;
  if (OUTCOMES.has(before)) item.counts[before] = Math.max(0, item.counts[before] - 1);
  if (OUTCOMES.has(after)) item.counts[after] += 1;
  return before !== after;
}
// Observation hashes only exist to stop a re-read of the same bytes counting
// twice. Cursors mean that re-read is rare and recent, so the index is capped
// and trimmed oldest first. Insertion order is preserved through JSON, and an
// entry whose family is gone can never dedupe anything again.
function pruneObservationHashes(state, limit) {
  const entries = Object.entries(state.observationHashes);
  const live = entries.filter(([, value]) => state.candidates[value.key]);
  const kept = limit > 0 && live.length > limit ? live.slice(live.length - limit) : live;
  if (kept.length === entries.length) return 0;
  state.observationHashes = Object.fromEntries(kept);
  return entries.length - kept.length;
}
function observationHash(observation, key) {
  const identity = observation?.id || JSON.stringify([
    observation?.source, observation?.tool, observation?.callId, observation?.command,
  ]);
  return hash(Buffer.from(`${identity}\0${key}`, 'utf8'));
}
function applyArguments(value, additional) {
  if (Array.isArray(value)) return { ...(object(additional) ? additional : {}), keys: value };
  return object(value) ? { ...value } : object(additional) ? { ...additional } : {};
}
function defaultCodexValidator(text, context) {
  fs.mkdirSync(path.dirname(context.path), { recursive: true });
  const temp = path.join(path.dirname(context.path),
    `.permission-wildcarding-validate.${process.pid}.${crypto.randomBytes(6).toString('hex')}.rules`);
  fs.writeFileSync(temp, text, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  try {
    const command = Array.isArray(context.command) && context.command.length
      ? context.command.map(String) : ['__claude_wildcarding_validation__'];
    // Fails closed on purpose: no reachable codex means no validation, and an
    // unvalidated rules file must never be written.
    const executable = context.codexExecutable || 'codex';
    const launch = commandLaunch(executable,
      ['execpolicy', 'check', '--rules', temp, '--', ...command]);
    // Name the way out. This surfaces in the dashboard's Auto Learn card, where
    // an error with no remedy reads as the feature being broken; the setting has
    // existed all along and nothing said so. An explicit path is honoured
    // directly, batch shim included.
    //
    // Raised from two places because the two platforms fail differently: on
    // Windows resolution has to succeed before spawn is even attempted, while
    // on POSIX the name is handed to spawn and comes back ENOENT. Same advice
    // either way, so the message is built once.
    const notFound = new Error(
      `codex executable not found: ${executable}. Looked on PATH and in the standard ` +
      'npm locations. Point at it with the permissionWildcarding.autoLearn.codexExecutable ' +
      'setting, or --codex-executable on the CLI, e.g. ' +
      '/usr/local/bin/codex, or C:/Users/<you>/AppData/Roaming/npm/codex.cmd',
    );
    if (process.platform === 'win32' && !launch.resolved) throw notFound;
    const result = spawnSync(launch.file, launch.args,
      { encoding: 'utf8', windowsHide: true, timeout: 30000, ...launch.options });
    if (result.error) throw result.error.code === 'ENOENT' ? notFound : result.error;
    if (result.status !== 0) throw new Error(
      `codex execpolicy check rejected generated rules: ${clean(result.stderr || result.stdout || `exit ${result.status}`, 500)}`,
    );
    let parsed = {};
    try { parsed = JSON.parse(result.stdout); } catch {}
    const decision = parsed.decision || parsed.result?.decision || parsed.effective_decision;
    if (context.command && decision !== 'allow') throw new Error(
      `codex execpolicy check did not allow generated prefix: ${command.join(' ')}`,
    );
    return { valid: true, decision: context.command ? decision : undefined };
  } finally {
    try { fs.unlinkSync(temp); } catch {}
  }
}
function createAutoLearnManager(options = {}) {
  const aliases = object(options.paths) ? options.paths : {};
  const home = path.resolve(options.home || options.homeDir || os.homedir());
  const configuredMode = MODES.has(options.mode) ? options.mode : 'recommend';
  const configuredThreshold = positive(options.threshold ?? options.successThreshold, 3);
  const workspaceRoot = options.workspaceRoot ? path.resolve(options.workspaceRoot) : null;
  const userDataDir = path.join(home, '.claude', 'wildcarding');
  const workspaceId = workspaceRoot ? hash(Buffer.from(normalizedPath(workspaceRoot), 'utf8')).slice(0, 16) : null;
  const defaultStatePath = path.join(userDataDir,
    workspaceId ? `auto-learn-state.${workspaceId}.json` : 'auto-learn-state.json');
  const requestedStatePath = configuredPath(home, options.statePath ?? aliases.state, defaultStatePath);
  const statePath = within(userDataDir, requestedStatePath) ? requestedStatePath : defaultStatePath;
  const claudeClaimsPath = path.join(userDataDir, 'claude-policy-claims.json');
  const claudeClaimantId = `state-sha256:${hash(Buffer.from(normalizedPath(statePath), 'utf8')).slice(0, 24)}`;

  const requestedLockPath = configuredPath(home, options.lockPath ?? aliases.lock,
    path.join(userDataDir, 'auto-learn-policy.lock'));
  const lockPath = within(userDataDir, requestedLockPath)
    ? requestedLockPath : path.join(userDataDir, 'auto-learn-policy.lock');
  const requestedBackupDir = configuredPath(home, options.backupDir ?? aliases.backups,
    path.join(userDataDir, 'backups'));
  const backupDir = within(userDataDir, requestedBackupDir)
    ? requestedBackupDir : path.join(userDataDir, 'backups');
  const claudeSettingsPath = configuredPath(home,
    options.claudeSettingsPath ?? aliases.claudeSettings, path.join(home, '.claude', 'settings.json'));
  const explicitCodex = Object.prototype.hasOwnProperty.call(options, 'codexRulesPath') ||
    Object.prototype.hasOwnProperty.call(aliases, 'codexRules');
  const codexValue = Object.prototype.hasOwnProperty.call(options, 'codexRulesPath')
    ? options.codexRulesPath : aliases.codexRules;
  const codexRulesPath = configuredPath(home, explicitCodex ? codexValue : undefined,
    path.join(home, '.codex', 'rules', 'permission-wildcarding.rules'));
  const codexTargetId = codexRulesPath
    ? hash(Buffer.from(normalizedPath(codexRulesPath), 'utf8')).slice(0, 16) : null;
  const claudeRoots = configuredRoots(home,
    options.claudeRoots ?? options.claudeHistoryPath ?? aliases.claudeHistory,
    [path.join(home, '.claude', 'projects')]);
  const codexRoots = configuredRoots(home,
    options.codexRoots ?? options.codexHistoryPath ?? aliases.codexHistory,
    [path.join(home, '.codex', 'sessions')]);
  const historyScanner = typeof options.historyScanner === 'function' ? options.historyScanner : scanHistoryFiles;
  const codexValidator = typeof options.codexValidator === 'function' ? options.codexValidator
    : typeof options.validateCodexRules === 'function' ? options.validateCodexRules : defaultCodexValidator;
  const codexExecutable = options.codexExecutable || 'codex';
  const afterPolicyWrite = typeof options.testHooks?.afterPolicyWrite === 'function'
    ? options.testHooks.afterPolicyWrite : null;
  const lockStaleMs = Number.isFinite(options.lockStaleMs) ? Math.max(0, options.lockStaleMs) : 10 * 60 * 1000;
  const observationHashLimit = Number.isFinite(options.observationHashLimit)
    ? Math.max(0, Math.floor(options.observationHashLimit)) : 20000;
  // Read once per manager and cached: the policy is a client-refreshed cache,
  // so re-reading it per candidate would only add I/O to a listing.
  let policyCache;
  const managedPolicy = () => {
    if (policyCache === undefined) {
      policyCache = options.managedPolicy !== undefined
        ? options.managedPolicy
        : readPolicy({ home, policyPath: options.managedPolicyPath });
    }
    return policyCache;
  };
  // Turns a file path into the managed rule that governs it, for the scanner to
  // record. The scanner calls this while the path is still in hand and keeps
  // only the returned rule, so no path reaches an observation or the state file.
  // Paths are normalized to forward slashes because a managed glob is written
  // that way and a Windows path would never match one.
  const probeMatcher = () => {
    const policy = managedPolicy();
    if (!policy || !policy.present) return undefined;
    const deny = Array.isArray(policy.raw?.deny) ? policy.raw.deny : [];
    const ask = Array.isArray(policy.raw?.ask) ? policy.raw.ask : [];
    if (!deny.length && !ask.length) return undefined;
    return (tool, filePath) => {
      const probe = `${tool}(${String(filePath).replace(/\\/g, '/')})`;
      return deny.find((rule) => coversPermission(rule, probe))
        || ask.find((rule) => coversPermission(rule, probe))
        || null;
    };
  };
  const clock = typeof options.now === 'function' ? options.now : () => new Date();
  const now = () => {
    const value = clock();
    return (value instanceof Date ? value : new Date(value)).toISOString();
  };

  function load() {
    let raw;
    try { raw = JSON.parse(fs.readFileSync(statePath, 'utf8').replace(/^\uFEFF/, '')); }
    catch (error) {
      if (error.code !== 'ENOENT') throw new Error(`Cannot read Auto Learn state: ${error.message}`);
    }
    const state = sanitizeState(raw, configuredMode, configuredThreshold);
    if (codexTargetId) {
      if (!state.codexTargets[codexTargetId]) state.codexTargets[codexTargetId] =
        Object.keys(state.codexTargets).length === 0
          ? { applied: state.applied.codex.slice(), reviewed: state.reviewed.codex.slice() }
          : { applied: [], reviewed: [] };
      state.applied.codex = state.codexTargets[codexTargetId].applied.slice();
      state.reviewed.codex = state.codexTargets[codexTargetId].reviewed.slice();
    } else {
      state.applied.codex = [];
      state.reviewed.codex = [];
    }
    for (const item of Object.values(state.candidates)) refresh(item, state.threshold);
    return state;
  }
  function save(state) {
    atomicWrite(statePath, JSON.stringify(persistentState(state), null, 2) + '\n');
  }
  // Shared with the extension wildcarding pass so the two writers of
  // settings.json cannot interleave, and so a wildcarding rewrite cannot land
  // between the settings write and the claims write of one application.
  const { locked } = createPolicyLock({ lockPath, staleMs: lockStaleMs, now });
  function clone(item, known) {
    const to = [
      ...(known.claude.has(item.key) ? ['claude'] : []),
      ...(known.codex.has(item.key) ? ['codex'] : []),
    ];
    // Managed settings outrank user settings and evaluate ask before allow, so
    // a family a managed ask covers cannot be granted here: writing the rule
    // changes nothing and the prompt survives. Withhold the proposal rather
    // than offer work that cannot pay off. Policy is never consulted to WIDEN
    // eligibility, only to withhold it.
    const policyVerdict = assessPermission(managedPolicy(), item.claudePermission);
    const eligibleTargets = [
      ...(claudeSettingsPath && policyVerdict !== 'inert' && claudeEligible(item, true) ? ['claude'] : []),
      ...(codexRulesPath && codexEligible(item, true) ? ['codex'] : []),
    ];
    return {
      ...item, prefix: item.prefix.slice(), reasons: item.reasons.slice(),
      sources: item.sources.slice(), counts: { ...item.counts },
      fingerprint: candidateFingerprint(item), eligibleTargets,
      policy: policyVerdict,
      pendingTargets: eligibleTargets.filter((target) => !to.includes(target)),
      applied: to.length > 0, appliedTo: to,
    };
  }
  function listCandidates(query = {}) {
    return candidatesFrom(load(), query);
  }
  function candidatesFrom(state, query = {}) {    const known = { claude: new Set(state.applied.claude), codex: new Set(state.applied.codex) };
    let result = Object.values(state.candidates).map((item) => clone(item, known));
    if (query.autoSafe === true) result = result.filter((item) => item.autoSafe);
    if (query.pending === true) result = result.filter((item) => item.pendingTargets.length > 0);
    if (query.disposition) {
      const allowed = new Set(Array.isArray(query.disposition) ? query.disposition : [query.disposition]);
      result = result.filter((item) => allowed.has(item.disposition));
    }
    return result.sort((a, b) => a.key.localeCompare(b.key));
  }
  // Entries already sitting in the user's allow list that a managed rule
  // overrides. Reported, never removed: this policy file is a client-refreshed
  // CACHE, and deleting a live grant because a stale copy calls it dead is the
  // same error with the sign flipped. The module may withhold a proposal, never
  // widen or revoke one.
  function deadAllowEntries(policy) {
    if (!claudeSettingsPath) return [];
    const now = snapshot(claudeSettingsPath);
    if (!now.exists) return [];
    let settings;
    try { settings = JSON.parse(now.content.toString('utf8').replace(/^\uFEFF/, '')); }
    catch { return []; }
    if (!object(settings)) return [];
    const allow = Array.isArray(settings.permissions?.allow) ? settings.permissions.allow : [];
    const seen = new Set();
    const dead = [];
    for (const entry of allow) {
      if (typeof entry !== 'string' || seen.has(entry)) continue;
      seen.add(entry);
      const override = overridingRule(policy, entry);
      if (override) dead.push({ permission: entry, ...override });
    }
    return dead.sort((a, b) => a.permission.localeCompare(b.permission));
  }
  // The verdict was computed for every candidate and read by nothing, so a
  // family a managed ask blocks just vanished from Review while its prompts
  // kept arriving, and a grant already written into settings looked like it had
  // simply failed. Naming the rule that cannot be beaten is the only useful
  // thing left to say about such a family, so say it.
  function managedSummary(all, hits) {
    const policy = managedPolicy();
    const state = policy.unreadable ? 'unreadable' : (policy.present ? 'present' : 'absent');
    // Degraded must never read as clean. With no usable policy there is no
    // verdict to report, so the counts are null rather than a confident zero.
    if (state !== 'present') return {
      policy: state, path: policy.path, degraded: state === 'unreadable',
      error: policy.error || null, verdicts: null, inertFamilies: [], deadAllowEntries: [],
      costliestRules: [],
    };
    const verdicts = { inert: 0, partial: 0, redundant: 0, effective: 0, unknown: 0 };
    const inertFamilies = [];
    for (const item of all) {
      if (!item.claudePermission) continue;
      const verdict = assessPermission(policy, item.claudePermission);
      verdicts[verdict] = (verdicts[verdict] || 0) + 1;
      if (verdict === 'inert') inertFamilies.push({
        key: item.key, permission: item.claudePermission, runs: item.counts?.success ?? 0,
        ...(overridingRule(policy, item.claudePermission) || {}),
      });
    }
    inertFamilies.sort((a, b) => b.runs - a.runs || a.key.localeCompare(b.key));
    // What the prompts actually cost, ranked by managed rule. Two sources,
    // because the two halves of the friction surface are shaped differently: a
    // shell family renders a permission that can be assessed, so its evidence
    // is the family's own run count, while a file tool renders no permission by
    // design and its evidence arrives as a per-rule hit count from the scan.
    // Without this the report could name a blocked family but never say which
    // rule was expensive, which is the only question a policy owner can act on.
    const costs = new Map();
    const addCost = (rule, runs, tools) => {
      const text = typeof rule === 'string' ? rule : '';
      if (!text || !(runs > 0)) return;
      const entry = costs.get(text) || { rule: text, prompts: 0, tools: [] };
      entry.prompts += runs;
      for (const tool of (Array.isArray(tools) ? tools : [tools])) {
        if (tool && !entry.tools.includes(tool)) entry.tools.push(tool);
      }
      costs.set(text, entry);
    };
    for (const family of inertFamilies) {
      addCost(family.rule, family.runs, family.permission?.split('(')[0]);
    }
    for (const [rule, record] of Object.entries(object(hits) ? hits : {})) {
      addCost(rule, record.hits, record.tools);
    }
    const costliestRules = [...costs.values()]
      .map((entry) => ({
        ...entry, tools: entry.tools.filter(Boolean).sort(),
        decision: policy.raw?.deny?.some((item) => item === entry.rule) ? 'deny' : 'ask',
      }))
      .sort((a, b) => b.prompts - a.prompts || a.rule.localeCompare(b.rule));
    return {
      policy: state, path: policy.path, degraded: false, error: null,
      verdicts, inertFamilies, deadAllowEntries: deadAllowEntries(policy),
      costliestRules,
    };
  }
  // Why a single pasted command is still prompting. "Your allow rule matches, so
  // this should not have prompted" is the wrong answer whenever a managed ask
  // covers the command, and it is the answer the caller would otherwise give,
  // because a user allow entry really does match. Reading the policy is the only
  // way to name the actual cause.
  function explainManaged(permission) {
    const policy = managedPolicy();
    return {
      policy: policy.unreadable ? 'unreadable' : (policy.present ? 'present' : 'absent'),
      degraded: Boolean(policy.unreadable),
      verdict: assessPermission(policy, permission),
      override: overridingRule(policy, permission),
    };
  }
  function status() {
    return statusFrom(load());
  }
  function statusFrom(state) {    const all = Object.values(state.candidates);
    const appliedKeys = [...new Set([...state.applied.claude, ...state.applied.codex])].sort();
    return {
      version: VERSION, mode: state.mode, threshold: state.threshold,
      lastScanAt: state.lastScanAt, lastScan: state.lastScanAt,
      lastScanStats: state.lastScanStats,
      lastApplyAt: state.lastApplication?.at || null,
      lastApplicationAt: state.lastApplication?.at || null,
      lastApplication: state.lastApplication ? { at: state.lastApplication.at } : null,
      canUndo: Boolean(state.lastApplication), candidateCount: all.length,
      counts: {
        total: all.length, safe: all.filter((item) => item.autoSafe).length,
        review: all.filter((item) => item.disposition === 'review').length,
        observe: all.filter((item) => item.disposition === 'observe').length,
      },
      applied: applied(state.applied), appliedKeys,
      managed: managedSummary(all, state.managedHits),
      paths: {
        state: statePath, claudeSettings: claudeSettingsPath,
        claudeClaims: claudeClaimsPath, codexRules: codexRulesPath,
      },
    };
  }
  // The dashboard needs both halves on every render; one load answers both.
  function overview(query = {}) {
    const state = load();
    return { status: statusFrom(state), candidates: candidatesFrom(state, query) };
  }
  function setMode(mode, threshold) {
    if (!MODES.has(mode)) throw new Error(`Invalid Auto Learn mode: ${mode}`);
    return locked(() => {
      const state = load();
      const next = threshold === undefined ? state.threshold : positive(threshold, 0);
      if (!next) throw new Error('Auto Learn threshold must be a positive integer');
      const changed = state.mode !== mode || state.threshold !== next;
      state.mode = mode;
      state.threshold = next;
      for (const item of Object.values(state.candidates)) refresh(item, next);
      if (changed || !fs.existsSync(statePath)) save(state);
      return { mode, threshold: next, changed };
    });
  }
  function validateCodex(generated, merged, prefixes) {
    const internal = validateCodexRulesText(generated);
    if (!internal.valid) throw new Error(
      `Generated Codex rules failed internal validation: ${internal.errors.join('; ')}`,
    );
    const commands = prefixes.length ? prefixes : [null];
    for (const command of commands) {
      const result = codexValidator(merged, {
        path: codexRulesPath, codexExecutable, internal,
        command: command ? command.slice() : null,
      });
      if (result?.then) throw new Error('Codex validator must be synchronous');
      if (result === false || result?.valid === false) throw new Error(
        `codex execpolicy check rejected generated rules${result?.error ? `: ${clean(result.error, 500)}` : ''}`,
      );
      if (command && result !== true && (!object(result) || result.decision !== 'allow')) throw new Error(
        `codex execpolicy check did not allow generated prefix: ${command.join(' ')}`,
      );
    }
  }
  const claudeEligible = (item, reviewed) =>
    renderClaudePermissions([item], { includeReviewed: reviewed }).length > 0;
  // Rendering a prefix_rule is not the same as being allowed to write one. The
  // merge step refuses text this validator rejects (a bare `curl`, `python` or
  // `git` prefix, a broad PowerShell form), and an application is atomic, so
  // offering such a candidate as eligible meant one unwritable row failed the
  // whole batch and applied nothing. Eligibility asks the writer's question.
  const codexEligible = (item, reviewed) => {
    const text = renderCodexRules([item], { includeReviewed: reviewed });
    if (!/\bprefix_rule\s*\(/.test(text)) return false;
    return validateCodexRulesText(text).valid === true;
  };
  function backup(kind, target, before, time) {
    const backupPath = path.join(backupDir,
      `${time.replace(/[:.]/g, '-')}-${kind}-${crypto.randomBytes(4).toString('hex')}.bak`);
    atomicWrite(backupPath, before.content);
    return {
      kind, path: target, backupPath, beforeHash: before.hash, afterHash: null,
      existed: before.exists,
    };
  }
  function rollback(written) {
    const conflicts = [];
    for (const change of written.slice().reverse()) try {
      const current = snapshot(change.path);
      if (!current.exists || current.hash !== change.afterHash) {
        conflicts.push(change.path);
        continue;
      }
      if (change.before.exists) atomicWrite(change.path, change.before.content);
      else fs.unlinkSync(change.path);
    } catch { conflicts.push(change.path); }
    return conflicts;
  }

  function applyUnlocked(state, request = {}) {
    if (state.mode === 'observe') return {
      changed: false, appliedCount: 0, applied: { claude: [], codex: [] },
      reason: 'Auto Learn observe mode records evidence only.',
    };
    const includeReviewed = request.includeReviewed === true;
    const keys = Array.isArray(request.keys)
      ? [...new Set(request.keys.map((key) => clean(key, 512)).filter(Boolean))] : null;
    if (includeReviewed && !keys?.length) {
      throw new Error('includeReviewed requires an explicit non-empty candidate key selection');
    }
    if (keys) {
      const missing = keys.filter((key) => !state.candidates[key]);
      if (missing.length) throw new Error(`Unknown Auto Learn candidate key(s): ${missing.join(', ')}`);
      if (includeReviewed && keys.some((key) => !state.candidates[key].meetsThreshold)) {
        throw new Error('Reviewed candidates must meet the configured success threshold');
      }
      if (includeReviewed && !object(request.expectedFingerprints)) {
        throw new Error('Reviewed application requires candidate fingerprints');
      }
      if (object(request.expectedFingerprints)) for (const key of keys) {
        const expected = clean(request.expectedFingerprints[key], 64);
        if (!expected || expected !== candidateFingerprint(state.candidates[key])) {
          throw new Error(`Auto Learn candidate changed after review: ${key}`);
        }
      }
    }
    const selected = (keys || Object.keys(state.candidates)).map((key) => state.candidates[key])
      .filter(Boolean).filter((item) => includeReviewed || item.autoSafe);
    const targets = Array.isArray(request.targets) ? new Set(request.targets) : null;
    const useClaude = Boolean(claudeSettingsPath) && request.claude !== false &&
      (!targets || targets.has('claude'));
    const useCodex = Boolean(codexRulesPath) && request.codex !== false &&
      (!targets || targets.has('codex'));
    const beforeGrants = grantSnapshot(state);
    const oldClaude = state.applied.claude.slice();
    const oldReviewedClaude = new Set(state.reviewed.claude);
    let nextClaude = useClaude
      ? oldClaude.filter((key) => state.candidates[key]?.autoSafe ||
        (oldReviewedClaude.has(key) && claudeEligible(state.candidates[key], true)))
      : oldClaude.slice();
    let nextReviewedClaude = useClaude
      ? state.reviewed.claude.filter((key) => nextClaude.includes(key))
      : state.reviewed.claude.slice();
    const record = codexTargetId
      ? (state.codexTargets[codexTargetId] || { applied: [], reviewed: [] })
      : { applied: [], reviewed: [] };
    const oldCodex = record.applied.slice();
    const oldReviewedCodex = new Set(record.reviewed);
    let nextCodex = useCodex
      ? oldCodex.filter((key) => state.candidates[key]?.autoSafe ||
        (oldReviewedCodex.has(key) && codexEligible(state.candidates[key], true)))
      : oldCodex.slice();
    let nextReviewedCodex = useCodex
      ? record.reviewed.filter((key) => nextCodex.includes(key))
      : record.reviewed.slice();
    const newly = { claude: [], codex: [] };
    if (useClaude) for (const item of selected) {
      if (!claudeEligible(item, includeReviewed)) continue;
      if (!nextClaude.includes(item.key)) newly.claude.push(item.key);
      nextClaude.push(item.key);
      if (includeReviewed) nextReviewedClaude.push(item.key);
    }
    if (useCodex) for (const item of selected) {
      if (!codexEligible(item, includeReviewed)) continue;
      if (!nextCodex.includes(item.key)) newly.codex.push(item.key);
      nextCodex.push(item.key);
      if (includeReviewed) nextReviewedCodex.push(item.key);
    }
    nextClaude = [...new Set(nextClaude)].sort();
    nextReviewedClaude = [...new Set(nextReviewedClaude)].filter((key) => nextClaude.includes(key)).sort();
    nextCodex = [...new Set(nextCodex)].sort();
    nextReviewedCodex = [...new Set(nextReviewedCodex)].filter((key) => nextCodex.includes(key)).sort();

    const changes = [];
    let nextManagedClaude = managedClaude(state.managedClaude);
    if (useClaude) {
      const before = snapshot(claudeSettingsPath);
      let settings = {};
      if (before.exists && before.content.length) try {
        settings = JSON.parse(before.content.toString('utf8').replace(/^\uFEFF/, ''));
      } catch (error) { throw new Error(`Cannot parse Claude settings: ${error.message}`); }
      if (!object(settings)) throw new Error('Claude settings must be a JSON object');
      let current = Array.isArray(settings.permissions?.allow) ? settings.permissions.allow.slice() : [];
      const items = nextClaude.map((key) => state.candidates[key]).filter(Boolean);
      const permissionsByKey = new Map();
      for (const item of items) {
        const permission = renderClaudePermissions([item], { includeReviewed: true })[0] || null;
        if (permission) permissionsByKey.set(item.key, permission);
      }

      const claimsBefore = snapshot(claudeClaimsPath);
      const claims = parseClaudeClaims(claimsBefore, claudeClaimsPath);
      const desiredPermissions = [...new Set(permissionsByKey.values())];
      const legacyManaged = new Set(Object.values(nextManagedClaude));
      current = updateClaudeClaims(
        claims, claudeClaimantId, desiredPermissions, current, legacyManaged,
      );
      const allow = mergeClaudeAllow(current, items, null, { includeReviewed: true });
      nextManagedClaude = {};
      for (const [key, permission] of permissionsByKey) {
        if (claims.permissions[permission]?.managed) nextManagedClaude[key] = permission;
      }

      const updated = {
        ...settings,
        permissions: { ...(object(settings.permissions) ? settings.permissions : {}), allow },
      };
      const content = Buffer.from(JSON.stringify(updated, null, 2) + '\n');
      if (!before.exists || !content.equals(before.content)) {
        changes.push({ kind: 'claude', path: claudeSettingsPath, before, content });
      }
      const claimsContent = Buffer.from(renderClaudeClaims(claims));
      if ((claimsBefore.exists || Object.keys(claims.permissions).length) &&
          (!claimsBefore.exists || !claimsContent.equals(claimsBefore.content))) {
        changes.push({
          kind: 'claude-claims', path: claudeClaimsPath, before: claimsBefore,
          content: claimsContent,
        });
      }
    }
    if (useCodex && (nextCodex.length || fs.existsSync(codexRulesPath))) {
      const before = snapshot(codexRulesPath);
      const items = nextCodex.map((key) => state.candidates[key]).filter(Boolean);
      const generated = renderCodexRules(items, { includeReviewed: true });
      const merged = mergeGeneratedCodexRules(before.exists ? before.content.toString('utf8') : '', generated);
      const content = Buffer.from(merged);
      if (!before.exists || !content.equals(before.content)) {
        validateCodex(generated, merged, items.map((item) => item.prefix));
        changes.push({ kind: 'codex', path: codexRulesPath, before, content });
      }
    }
    for (const change of changes) if (!unchanged(change.path, change.before)) {
      throw new Error(`Policy changed while Auto Learn was preparing it: ${change.path}`);
    }
    const time = now();
    const backups = changes.map((change) => backup(change.kind, change.path, change.before, time));
    const written = [];
    try {
      for (let index = 0; index < changes.length; index += 1) {
        const change = changes[index];
        if (!unchanged(change.path, change.before)) {
          throw new Error(`Policy changed before Auto Learn could write it: ${change.path}`);
        }
        atomicWrite(change.path, change.content);
        change.afterHash = hash(change.content);
        backups[index].afterHash = change.afterHash;
        written.push(change);
        if (afterPolicyWrite) afterPolicyWrite({
          kind: change.kind, path: change.path, index, afterHash: change.afterHash,
        });
      }
      state.applied.claude = nextClaude;
      state.reviewed.claude = nextReviewedClaude;
      state.managedClaude = nextManagedClaude;
      if (codexTargetId) state.codexTargets[codexTargetId] = {
        applied: nextCodex, reviewed: nextReviewedCodex,
      };
      state.applied.codex = nextCodex;
      state.reviewed.codex = nextReviewedCodex;
      if (changes.length) state.lastApplication = {
        at: time, targets: backups, grantsBefore: beforeGrants,
        grantsAfter: grantSnapshot(state),
      };
      save(state);
    } catch (error) {
      const conflicts = rollback(written);
      if (conflicts.length) error.rollbackConflicts = conflicts;
      throw error;
    }
    const appliedKeys = [...new Set([...newly.claude, ...newly.codex])].sort();
    const changedTargets = [...new Set(changes.map((item) =>
      item.kind === 'claude-claims' ? 'claude' : item.kind))];
    return {
      changed: changes.length > 0, changedTargets,
      applied: newly, appliedKeys, appliedCount: appliedKeys.length,
      skippedCount: Math.max(0, (keys || Object.keys(state.candidates)).length - selected.length),
      at: changes.length ? time : null,
    };
  }
  function applyPolicy(value, additional) {
    const request = applyArguments(value, additional);
    return locked(() => applyUnlocked(load(), request));
  }
  function applyClaude(value, additional) {
    const request = applyArguments(value, additional);
    request.targets = ['claude'];
    return locked(() => applyUnlocked(load(), request));
  }
  function applyCodex(value, additional) {
    const request = applyArguments(value, additional);
    request.targets = ['codex'];
    return locked(() => applyUnlocked(load(), request));
  }

  // Derives the whole hit table from the whole corpus in one pass.
  //
  // A normal scan only sees what its cursors have not already consumed, so on
  // any machine that has been running a while the table would start empty and
  // the number actually worth acting on would take weeks to reappear. That is
  // the same "no evidence at install time" problem that makes a static block
  // the wrong answer, so the fix is an explicit one-time pass rather than
  // waiting. Cursors are passed empty to force a full read and the returned
  // ones are DISCARDED, so this neither advances nor rewinds a scan; candidates
  // and observation hashes are untouched for the same reason. Dedupe is per
  // pass, by observation id, which makes repeated runs idempotent.
  function rebuildManagedHits() {
    return locked(() => {
      const state = load();
      const matcher = probeMatcher();
      const policy = managedPolicy();
      if (!matcher) {
        state.managedHits = {};
        save(state);
        return {
          policy: policy.unreadable ? 'unreadable' : (policy.present ? 'present' : 'absent'),
          degraded: Boolean(policy.unreadable), rules: 0, prompts: 0, files: 0,
        };
      }
      const result = historyScanner({
        cursors: {}, claudeRoots, codexRoots, probeMatcher: matcher,
      });
      const seen = new Set();
      const hits = {};
      for (const observation of result.observations || []) {
        if (workspaceRoot && !within(workspaceRoot, observation.cwd)) continue;
        const rule = clean(observation.managedRule, 200);
        if (!rule || seen.has(observation.id)) continue;
        seen.add(observation.id);
        const record = hits[rule] || { hits: 0, tools: [] };
        record.hits += 1;
        const tool = clean(observation.tool, 48);
        if (tool && !record.tools.includes(tool)) record.tools.push(tool);
        hits[rule] = record;
      }
      state.managedHits = managedHits(hits);
      save(state);
      return {
        policy: 'present', degraded: false,
        rules: Object.keys(state.managedHits).length,
        prompts: Object.values(state.managedHits).reduce((total, item) => total + item.hits, 0),
        files: Array.isArray(result.files) ? result.files.length : 0,
      };
    });
  }
  function scan(request = {}) {
    return locked(() => {
      const state = load();
      if (request.mode !== undefined) {
        if (!MODES.has(request.mode)) throw new Error(`Invalid Auto Learn mode: ${request.mode}`);
        state.mode = request.mode;
      }
      if (request.threshold !== undefined) {
        const next = positive(request.threshold, 0);
        if (!next) throw new Error('Auto Learn threshold must be a positive integer');
        state.threshold = next;
      }
      const result = historyScanner({
        cursors: state.cursors, claudeRoots, codexRoots,
        overlapBytes: request.overlapBytes, platform: request.platform,
        probeMatcher: probeMatcher(),
      });
      if (!result || !Array.isArray(result.observations) || !object(result.cursors)) {
        throw new Error('History scanner returned an invalid result');
      }
      let newObservations = 0;
      let updatedObservations = 0;
      let acceptedObservations = 0;
      for (const observation of result.observations) {
        if (workspaceRoot && !within(workspaceRoot, observation.cwd)) continue;
        let accepted = false;
        for (const fresh of aggregateObservations([observation], { threshold: 1 })) {
          const id = observationHash(observation, fresh.key);
          const previous = state.observationHashes[id];
          const next = observedOutcome(fresh);
          // An unanswered call is not execution evidence. It is neither persisted
          // nor allowed to create a candidate; a later correlated result can add it.
          if (next === 'unknown') continue;
          const item = mergeCandidate(state.candidates[fresh.key], fresh, state.threshold);
          if (!item) continue;
          state.candidates[fresh.key] = item;
          const source = fresh.sources[0] || clean(observation.source, 32) || 'unknown';
          if (!previous) {
            changeOutcome(item, null, next);
            state.observationHashes[id] = { key: fresh.key, outcome: next, source };
            newObservations += 1;
            // Counted once, on first sight, keyed off the same hash that stops
            // a re-scan from double-counting the candidate itself.
            if (observation.managedRule) {
              const rule = clean(observation.managedRule, 200);
              if (rule) {
                const record = state.managedHits[rule] || { hits: 0, tools: [] };
                record.hits += 1;
                const tool = clean(observation.tool, 48);
                if (tool && !record.tools.includes(tool)) record.tools.push(tool);
                state.managedHits[rule] = record;
              }
            }
          } else if (previous.key === fresh.key && previous.outcome !== next &&
              changeOutcome(item, previous.outcome, next)) {
            state.observationHashes[id] = { key: fresh.key, outcome: next, source };
            updatedObservations += 1;
          }
          if (!item.sources.includes(source)) item.sources.push(source);
          item.sources.sort();
          refresh(item, state.threshold);
          accepted = true;
        }
        if (accepted) acceptedObservations += 1;
      }
      for (const item of Object.values(state.candidates)) refresh(item, state.threshold);
      const prunedObservations = pruneObservationHashes(state, observationHashLimit);
      state.cursors = {};
      for (const [file, value] of Object.entries(result.cursors)) {
        const safe = cursor(value);
        const id = /^path-sha256:[a-f0-9]{24}$/.test(file)
          ? file : `path-sha256:${hash(Buffer.from(normalizedPath(file), 'utf8')).slice(0, 24)}`;
        if (safe) state.cursors[id] = safe;
      }
      // Enforce the cap on the way out, so one scan cannot leave the file
      // holding more rules than the normalizer would accept reading it back.
      state.managedHits = managedHits(state.managedHits);
      state.lastScanAt = now();
      state.lastScanStats = {
        files: Array.isArray(result.files) ? result.files.length : Object.keys(state.cursors).length,
        observations: acceptedObservations,
        errors: Array.isArray(result.files) ? result.files.filter((item) => item.mode === 'error').length : 0,
        prunedObservations,
      };
      save(state);
      const application = state.mode === 'auto-safe'
        ? applyUnlocked(state, { includeReviewed: false }) : null;
      return {
        scannedAt: state.lastScanAt, files: state.lastScanStats.files,
        observations: acceptedObservations, newObservations, updatedObservations,
        prunedObservations,
        candidates: Object.keys(state.candidates).length, application, apply: application,
      };
    });
  }

  // Undo releases this claimant's grants instead of restoring a file byte for
  // byte. Claude Code, the wildcarding pass and other workspaces all write the
  // same settings.json, so an unrelated edit must not make Undo unavailable,
  // and releasing a claim must never revoke a permission another claimant still
  // holds. Returns null when the current policy cannot be read.
  function releaseClaudeGrants(application) {
    const now = snapshot(claudeSettingsPath);
    if (!now.exists) return null;
    let settings;
    try { settings = JSON.parse(now.content.toString('utf8').replace(/^\uFEFF/, '')); }
    catch { return null; }
    if (!object(settings)) return null;
    const permissions = object(settings.permissions) ? settings.permissions : {};
    const allow = Array.isArray(permissions.allow) ? permissions.allow.slice() : [];
    const claims = parseClaudeClaims(snapshot(claudeClaimsPath), claudeClaimsPath);
    const restored = [...new Set(Object.values(application.grantsBefore?.managedClaude || {}))];
    const legacyManaged = new Set(Object.values(application.grantsAfter?.managedClaude || {}));
    const next = updateClaudeClaims(claims, claudeClaimantId, restored, allow, legacyManaged);
    return {
      claude: Buffer.from(JSON.stringify({
        ...settings, permissions: { ...permissions, allow: next },
      }, null, 2) + '\n'),
      'claude-claims': Buffer.from(renderClaudeClaims(claims)),
      solo: Object.keys(claims.permissions).length === 0,
    };
  }
  function undo() {
    return locked(() => {
      const state = load();
      const application = state.lastApplication;
      if (!application) return {
        changed: false, undone: false, reason: 'No Auto Learn application is available to undo.',
      };
      const restores = [];
      let released;
      for (const target of application.targets) {
        const current = snapshot(target.path);
        const before = snapshot(target.backupPath);
        if (!before.exists || before.hash !== target.beforeHash) throw new Error(
          `Refusing to undo because the Auto Learn backup is missing or changed: ${target.backupPath}`,
        );
        // An untouched target is restored exactly. A moved one is reconciled,
        // except the Codex rules file, which nothing else is expected to write.
        const untouched = current.exists && current.hash === target.afterHash;
        let content = before.content;
        let remove = untouched && !target.existed;
        if (target.kind === 'codex') {
          if (!untouched) throw new Error(
            `Refusing to undo because the policy changed after Auto Learn wrote it: ${target.path}`,
          );
        } else {
          if (released === undefined) released = releaseClaudeGrants(application);
          if (!released) throw new Error(
            `Refusing to undo because the policy could not be read: ${target.path}`,
          );
          content = released[target.kind];
          remove = released.solo && !target.existed;
        }
        restores.push({ target, current, before, content, untouched, remove });
      }
      const restored = [];
      try {
        for (const item of restores) {
          if (item.remove) {
            if (item.current.exists) fs.unlinkSync(item.target.path);
          } else atomicWrite(item.target.path, item.content);
          item.restored = snapshot(item.target.path);
          restored.push(item);
        }
        restoreGrants(state, application.grantsBefore);
        if (codexTargetId && state.codexTargets[codexTargetId]) {
          state.applied.codex = state.codexTargets[codexTargetId].applied.slice();
          state.reviewed.codex = state.codexTargets[codexTargetId].reviewed.slice();
        }
        state.lastApplication = null;
        save(state);
      } catch (error) {
        const conflicts = [];
        for (const item of restored.slice().reverse()) try {
          const current = snapshot(item.target.path);
          if (current.exists !== item.restored.exists || current.hash !== item.restored.hash) {
            conflicts.push(item.target.path);
            continue;
          }
          atomicWrite(item.target.path, item.current.content);
        } catch { conflicts.push(item.target.path); }
        if (conflicts.length) error.rollbackConflicts = conflicts;
        throw error;
      }
      return {
        changed: true, undone: true,
        restoredTargets: [...new Set(restores.map((item) =>
          item.target.kind === 'claude-claims' ? 'claude' : item.target.kind))],
      };
    });
  }

  return {
    paths: {
      home, state: statePath, lock: lockPath, backups: backupDir,
      claudeHistory: claudeRoots.slice(), codexHistory: codexRoots.slice(),
      claudeSettings: claudeSettingsPath, claudeClaims: claudeClaimsPath,
      codexRules: codexRulesPath,
    },
    scan, status, getStatus: status, overview, explainManaged, rebuildManagedHits,
    listCandidates, list: listCandidates, getCandidates: listCandidates,
    setMode, apply: applyPolicy, applyClaude, applyCodex, undo,
  };
}

module.exports = { createAutoLearnManager };
