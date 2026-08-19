'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createAutoLearnManager } = require('../src/auto-learn-manager');

const CURSOR_KEY = `path-sha256:${'a'.repeat(24)}`;

function tempHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'permission-wildcarding-manager-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}
function observed(id, command, status = 'success', cwd) {
  return { id, source: 'claude', tool: 'Bash', command, status, cwd };
}
function scannerFeed(initial) {
  let observations = initial;
  const scan = () => ({
    observations,
    cursors: { [CURSOR_KEY]: { source: 'claude', size: 100, offset: 100 } },
    files: [{ source: 'claude', mode: 'full' }],
  });
  scan.set = (value) => { observations = value; };
  return scan;
}
function manager(home, scanner, options = {}) {
  return createAutoLearnManager({
    home,
    historyScanner: scanner,
    codexValidator: () => ({ valid: true, decision: 'allow' }),
    ...options,
  });
}
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}

test('incremental scans deduplicate successes and never persist raw or unanswered commands', (t) => {
  const home = tempHome(t);
  const feed = scannerFeed([
    observed('one', 'git status --short private-a'),
    observed('two', 'git status --porcelain private-b'),
    observed('three', 'git status private-c'),
    observed('pending', 'curl https://secret.example/token', 'unknown'),
  ]);
  const learn = manager(home, feed, { codexRulesPath: null, threshold: 3 });
  const first = learn.scan();
  assert.equal(first.newObservations, 3);
  assert.equal(first.observations, 3);
  const [candidate] = learn.listCandidates();
  assert.equal(candidate.key, 'bash:git status');
  assert.equal(candidate.counts.success, 3);
  assert.equal(candidate.autoSafe, true);
  assert.match(candidate.fingerprint, /^[a-f0-9]{64}$/);

  const second = learn.scan();
  assert.equal(second.newObservations, 0);
  assert.equal(learn.listCandidates()[0].counts.success, 3);
  const stateText = fs.readFileSync(learn.paths.state, 'utf8');
  assert.doesNotMatch(stateText, /private-[abc]|secret\.example|"command"|"examples"|\.jsonl/);
  assert.match(stateText, /path-sha256:[a-f0-9]{24}/);
});

test('auto-safe applies transactionally, preserves manual policy text, validates every prefix, and undoes exactly', (t) => {
  const home = tempHome(t);
  const settings = path.join(home, '.claude', 'settings.json');
  const rules = path.join(home, '.codex', 'rules', 'permission-wildcarding.rules');
  const originalSettings = { permissions: { allow: ['WebSearch'] }, theme: 'dark' };
  const originalRules = '# manual policy owner\n';
  writeJson(settings, originalSettings);
  fs.mkdirSync(path.dirname(rules), { recursive: true });
  fs.writeFileSync(rules, originalRules);
  const feed = scannerFeed([
    observed('g1', 'git status'), observed('g2', 'git status --short'), observed('g3', 'git status'),
    observed('r1', 'rg --files src'), observed('r2', 'rg --files test'), observed('r3', 'rg --files docs'),
  ]);
  const checks = [];
  const learn = manager(home, feed, {
    mode: 'auto-safe', threshold: 3, codexRulesPath: rules,
    codexValidator: (_text, context) => {
      checks.push(context.command);
      return { valid: true, decision: context.command ? 'allow' : undefined };
    },
  });
  const result = learn.scan();
  assert.equal(result.application.appliedCount, 2);
  assert.deepEqual(checks.map((argv) => argv.join(' ')).sort(), ['git status', 'rg --files']);
  const afterSettings = JSON.parse(fs.readFileSync(settings, 'utf8'));
  assert.ok(afterSettings.permissions.allow.includes('WebSearch'));
  assert.ok(afterSettings.permissions.allow.includes('Bash(git status *)'));
  assert.ok(afterSettings.permissions.allow.includes('Bash(rg --files *)'));
  const afterRules = fs.readFileSync(rules, 'utf8');
  assert.ok(afterRules.startsWith(originalRules));
  assert.match(afterRules, /BEGIN permission-wildcarding generated rules/);
  assert.equal(learn.status().canUndo, true);

  const undone = learn.undo();
  assert.equal(undone.undone, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(settings, 'utf8')), originalSettings);
  assert.equal(fs.readFileSync(rules, 'utf8'), originalRules);
  assert.equal(learn.status().canUndo, false);
});

test('failed Codex validation leaves both policy targets byte-for-byte unchanged', (t) => {
  const home = tempHome(t);
  const settings = path.join(home, '.claude', 'settings.json');
  const rules = path.join(home, '.codex', 'rules', 'permission-wildcarding.rules');
  const beforeSettings = '{\n  "permissions": { "allow": ["WebSearch"] }\n}\n';
  const beforeRules = '# manual\n';
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  fs.mkdirSync(path.dirname(rules), { recursive: true });
  fs.writeFileSync(settings, beforeSettings);
  fs.writeFileSync(rules, beforeRules);
  const feed = scannerFeed([
    observed('1', 'git status'), observed('2', 'git status'), observed('3', 'git status'),
  ]);
  const learn = manager(home, feed, {
    threshold: 3, codexRulesPath: rules,
    codexValidator: () => ({ valid: false, error: 'test rejection' }),
  });
  learn.scan();
  assert.throws(() => learn.apply(), /rejected generated rules/);
  assert.equal(fs.readFileSync(settings, 'utf8'), beforeSettings);
  assert.equal(fs.readFileSync(rules, 'utf8'), beforeRules);
});

test('observe mode is evidence-only and refuses every apply entrypoint', (t) => {
  const home = tempHome(t);
  const feed = scannerFeed([
    observed('1', 'git status'), observed('2', 'git status'), observed('3', 'git status'),
  ]);
  const learn = manager(home, feed, { mode: 'observe', threshold: 3 });
  learn.scan();
  for (const apply of [learn.apply, learn.applyClaude, learn.applyCodex]) {
    const result = apply();
    assert.equal(result.changed, false);
    assert.match(result.reason, /evidence only/);
  }
  assert.equal(fs.existsSync(path.join(home, '.claude', 'settings.json')), false);
});

test('policy lock never steals from a live PID and recovers a dead PID lock', (t) => {
  const home = tempHome(t);
  const learn = manager(home, scannerFeed([]), { codexRulesPath: null, lockStaleMs: 25 });
  learn.setMode('recommend');
  fs.writeFileSync(learn.paths.lock, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
  assert.throws(() => learn.setMode('observe'), (error) => error.code === 'AUTO_LEARN_LOCKED');
  const old = new Date(Date.now() - 1000);
  fs.utimesSync(learn.paths.lock, old, old);
  assert.throws(() => learn.setMode('observe'), (error) => error.code === 'AUTO_LEARN_LOCKED');
  fs.unlinkSync(learn.paths.lock);
  fs.writeFileSync(learn.paths.lock, JSON.stringify({ pid: 2147483646, at: new Date().toISOString() }));
  assert.equal(learn.setMode('observe').mode, 'observe');
  assert.equal(fs.existsSync(learn.paths.lock), false);
});

test('a failed observation cannot later be rewritten as success', (t) => {
  const home = tempHome(t);
  const feed = scannerFeed([observed('same-call', 'git status', 'failed')]);
  const learn = manager(home, feed, { codexRulesPath: null, threshold: 1 });
  learn.scan();
  feed.set([observed('same-call', 'git status', 'success')]);
  const second = learn.scan();
  const [candidate] = learn.listCandidates();
  assert.equal(second.updatedObservations, 0);
  assert.equal(candidate.counts.failed, 1);
  assert.equal(candidate.counts.success, 0);
  assert.equal(candidate.autoSafe, false);
});

test('lock cleanup preserves a replacement owner', (t) => {
  const home = tempHome(t);
  const feed = scannerFeed([observed('one', 'git status')]);
  let learn;
  let replaced = false;
  const replacement = { pid: process.pid, owner: 'replacement-owner', at: new Date().toISOString() };
  learn = manager(home, feed, {
    mode: 'auto-safe', threshold: 1, codexRulesPath: null,
    testHooks: {
      afterPolicyWrite(event) {
        if (replaced || event.kind !== 'claude') return;
        fs.unlinkSync(learn.paths.lock);
        fs.writeFileSync(learn.paths.lock, JSON.stringify(replacement) + '\n');
        replaced = true;
      },
    },
  });
  learn.scan();
  assert.equal(replaced, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(learn.paths.lock, 'utf8')), replacement);
});

test('shared Claude claims prevent one workspace from revoking another', (t) => {
  const home = tempHome(t);
  const workspaceA = path.join(home, 'workspaces', 'a');
  const workspaceB = path.join(home, 'workspaces', 'b');
  fs.mkdirSync(workspaceA, { recursive: true });
  fs.mkdirSync(workspaceB, { recursive: true });
  const feedA = scannerFeed([observed('a-call', 'git status', 'success', workspaceA)]);
  const feedB = scannerFeed([observed('b-call', 'git status', 'success', workspaceB)]);
  const options = { mode: 'auto-safe', threshold: 1, codexRulesPath: null };
  const first = manager(home, feedA, { ...options, workspaceRoot: workspaceA });
  const second = manager(home, feedB, { ...options, workspaceRoot: workspaceB });
  const settings = path.join(home, '.claude', 'settings.json');
  const permission = 'Bash(git status *)';

  first.scan();
  second.scan();
  let claims = JSON.parse(fs.readFileSync(first.paths.claudeClaims, 'utf8'));
  assert.equal(claims.permissions[permission].managed, true);
  assert.equal(claims.permissions[permission].claimants.length, 2);
  assert.equal(JSON.parse(fs.readFileSync(settings, 'utf8')).permissions.allow
    .filter((item) => item === permission).length, 1);
  // Undo releases only this workspace's claim. The permission survives because
  // the other workspace still claims it, and a foreign write no longer disables Undo.
  assert.equal(first.undo().undone, true);
  assert.ok(JSON.parse(fs.readFileSync(settings, 'utf8')).permissions.allow.includes(permission));
  claims = JSON.parse(fs.readFileSync(first.paths.claudeClaims, 'utf8'));
  assert.deepEqual(claims.permissions[permission].claimants.length, 1);

  feedA.set([observed('a-call', 'git status', 'failed', workspaceA)]);
  first.scan();
  assert.ok(JSON.parse(fs.readFileSync(settings, 'utf8')).permissions.allow.includes(permission));
  claims = JSON.parse(fs.readFileSync(first.paths.claudeClaims, 'utf8'));
  assert.equal(claims.permissions[permission].claimants.length, 1);

  feedB.set([observed('b-call', 'git status', 'failed', workspaceB)]);
  second.scan();
  assert.ok(!JSON.parse(fs.readFileSync(settings, 'utf8')).permissions.allow.includes(permission));
  claims = JSON.parse(fs.readFileSync(first.paths.claudeClaims, 'utf8'));
  assert.deepEqual(claims.permissions, {});
});

test('workspace evidence is cwd-bound while state/backups stay home and the policy lock stays global', (t) => {
  const home = tempHome(t);
  const workspace = path.join(os.tmpdir(), `cw-workspace-${process.pid}-${Date.now()}`);
  const otherWorkspace = `${workspace}-other`;
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(otherWorkspace, { recursive: true });
  t.after(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(otherWorkspace, { recursive: true, force: true });
  });
  const feed = scannerFeed([
    observed('inside', 'git status', 'success', path.join(workspace, 'src')),
    observed('outside', 'rg PRIVATE', 'success', otherWorkspace),
  ]);
  const unsafeRequestedState = path.join(workspace, '.codex', 'auto-learn-state.json');
  const first = manager(home, feed, {
    workspaceRoot: workspace, statePath: unsafeRequestedState,
    codexRulesPath: null, threshold: 1,
  });
  first.scan();
  assert.deepEqual(first.listCandidates().map((item) => item.key), ['bash:git status']);
  assert.equal(first.paths.state.startsWith(path.join(home, '.claude', 'wildcarding')), true);
  assert.equal(first.paths.backups.startsWith(path.join(home, '.claude', 'wildcarding')), true);
  const second = manager(home, scannerFeed([]), {
    workspaceRoot: otherWorkspace, codexRulesPath: null,
  });
  assert.notEqual(first.paths.state, second.paths.state);
  assert.equal(first.paths.lock, second.paths.lock);
});

test('reviewed apply requires a current fingerprint and rejects a risk change after selection', (t) => {
  const home = tempHome(t);
  const successes = [
    observed('1', 'git status'), observed('2', 'git status'), observed('3', 'git status'),
  ];
  const feed = scannerFeed(successes);
  const learn = manager(home, feed, { codexRulesPath: null, threshold: 3 });
  learn.scan();
  const picked = learn.listCandidates()[0];
  feed.set([...successes, observed('failure', 'git status', 'failed')]);
  learn.scan();
  assert.throws(() => learn.apply({
    keys: [picked.key], includeReviewed: true,
    expectedFingerprints: { [picked.key]: picked.fingerprint },
  }), /changed after review/);
});

test('auto provenance revokes a downgraded managed permission but preserves a pre-existing manual permission', (t) => {
  const successes = [
    observed('1', 'git status'), observed('2', 'git status'), observed('3', 'git status'),
  ];

  const managedHome = tempHome(t);
  const managedFeed = scannerFeed(successes);
  const managed = manager(managedHome, managedFeed, {
    mode: 'auto-safe', threshold: 3, codexRulesPath: null,
  });
  managed.scan();
  const managedSettings = path.join(managedHome, '.claude', 'settings.json');
  assert.ok(JSON.parse(fs.readFileSync(managedSettings)).permissions.allow.includes('Bash(git status *)'));
  managedFeed.set([...successes, observed('failed', 'git status', 'failed')]);
  managed.scan();
  assert.ok(!JSON.parse(fs.readFileSync(managedSettings)).permissions.allow.includes('Bash(git status *)'));

  const manualHome = tempHome(t);
  const manualSettings = path.join(manualHome, '.claude', 'settings.json');
  writeJson(manualSettings, { permissions: { allow: ['Bash(git status *)', 'WebSearch'] } });
  const manualFeed = scannerFeed(successes);
  const manual = manager(manualHome, manualFeed, {
    mode: 'auto-safe', threshold: 3, codexRulesPath: null,
  });
  manual.scan();
  manualFeed.set([...successes, observed('failed', 'git status', 'failed')]);
  manual.scan();
  assert.deepEqual(JSON.parse(fs.readFileSync(manualSettings)).permissions.allow,
    ['Bash(git status *)', 'WebSearch']);
});

test('explicitly reviewed provenance survives later auto-safe regeneration', (t) => {
  const home = tempHome(t);
  const rules = path.join(home, '.codex', 'rules', 'permission-wildcarding.rules');
  const successes = [
    observed('1', 'custom-tool inspect'), observed('2', 'custom-tool inspect'),
    observed('3', 'custom-tool inspect'),
  ];
  const feed = scannerFeed(successes);
  const learn = manager(home, feed, { threshold: 3, codexRulesPath: rules });
  learn.scan();
  const picked = learn.listCandidates()[0];
  const applied = learn.applyCodex({
    keys: [picked.key], includeReviewed: true,
    expectedFingerprints: { [picked.key]: picked.fingerprint },
  });
  assert.equal(applied.appliedCount, 1);
  assert.match(fs.readFileSync(rules, 'utf8'), /custom-tool/);
  learn.setMode('auto-safe');
  feed.set([...successes, observed('failed', 'custom-tool inspect', 'failed')]);
  learn.scan();
  assert.match(fs.readFileSync(rules, 'utf8'), /custom-tool/);
});

test('Codex applied provenance is isolated by generated rule target', (t) => {
  const home = tempHome(t);
  const feed = scannerFeed([
    observed('1', 'git status'), observed('2', 'git status'), observed('3', 'git status'),
  ]);
  const userRules = path.join(home, '.codex', 'rules', 'permission-wildcarding.rules');
  const workspaceRules = path.join(home, 'workspace', '.codex', 'rules', 'permission-wildcarding.rules');
  const user = manager(home, feed, { threshold: 3, codexRulesPath: userRules });
  user.scan();
  assert.equal(user.applyCodex().appliedCount, 1);

  const workspace = manager(home, feed, { threshold: 3, codexRulesPath: workspaceRules });
  const candidate = workspace.listCandidates()[0];
  assert.ok(candidate.pendingTargets.includes('codex'));
  assert.equal(workspace.applyCodex().appliedCount, 1);
  assert.match(fs.readFileSync(userRules, 'utf8'), /git/);
  assert.match(fs.readFileSync(workspaceRules, 'utf8'), /git/);
});

test('applyCodex revokes only Codex auto provenance and leaves Claude policy and provenance untouched', (t) => {
  const home = tempHome(t);
  const rules = path.join(home, '.codex', 'rules', 'permission-wildcarding.rules');
  const successes = [
    observed('1', 'git status'), observed('2', 'git status'), observed('3', 'git status'),
  ];
  const feed = scannerFeed(successes);
  const learn = manager(home, feed, {
    mode: 'auto-safe', threshold: 3, codexRulesPath: rules,
  });
  learn.scan();
  const key = 'bash:git status';
  const settings = path.join(home, '.claude', 'settings.json');
  assert.ok(learn.status().applied.claude.includes(key));
  assert.ok(learn.status().applied.codex.includes(key));
  const claudeBefore = fs.readFileSync(settings, 'utf8');

  learn.setMode('recommend');
  feed.set([...successes, observed('failed', 'git status', 'failed')]);
  learn.scan();
  const result = learn.applyCodex();
  assert.deepEqual(result.changedTargets, ['codex']);
  assert.equal(fs.readFileSync(settings, 'utf8'), claudeBefore);
  assert.ok(learn.status().applied.claude.includes(key));
  assert.ok(!learn.status().applied.codex.includes(key));
  assert.doesNotMatch(fs.readFileSync(rules, 'utf8'), /pattern\s*=\s*\["git"/);
});

test('rollback never overwrites an external edit that races after a managed target write', (t) => {
  const home = tempHome(t);
  const settings = path.join(home, '.claude', 'settings.json');
  const rules = path.join(home, '.codex', 'rules', 'permission-wildcarding.rules');
  const originalSettings = '{"permissions":{"allow":["WebSearch"]}}\n';
  const originalRules = '# manual rule owner\n';
  const externalSettings = '{"permissions":{"allow":["ExternalEdit"]},"owner":"outside"}\n';
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  fs.mkdirSync(path.dirname(rules), { recursive: true });
  fs.writeFileSync(settings, originalSettings);
  fs.writeFileSync(rules, originalRules);
  const feed = scannerFeed([
    observed('1', 'git status'), observed('2', 'git status'), observed('3', 'git status'),
  ]);
  let hookCalls = 0;
  const learn = manager(home, feed, {
    threshold: 3, codexRulesPath: rules,
    testHooks: {
      afterPolicyWrite(event) {
        hookCalls += 1;
        assert.equal(event.kind, 'claude');
        fs.writeFileSync(event.path, externalSettings);
        throw new Error('deterministic post-write failure');
      },
    },
  });
  learn.scan();
  let failure;
  try { learn.apply(); } catch (error) { failure = error; }
  assert.match(failure?.message || '', /deterministic post-write failure/);
  assert.deepEqual(failure.rollbackConflicts, [settings]);
  assert.equal(hookCalls, 1);
  assert.equal(fs.readFileSync(settings, 'utf8'), externalSettings);
  assert.equal(fs.readFileSync(rules, 'utf8'), originalRules);
  assert.deepEqual(learn.status().appliedKeys, []);
});


test('undo survives an unrelated settings write and removes only its own entry', (t) => {
  const home = tempHome(t);
  const settings = path.join(home, '.claude', 'settings.json');
  writeJson(settings, { permissions: { allow: ['Bash(ls *)'], deny: ['Bash(rm -rf / *)'] } });
  const feed = scannerFeed([observed('one', 'git status', 'success')]);
  const learn = manager(home, feed, { mode: 'auto-safe', threshold: 1, codexRulesPath: null });
  learn.scan();
  const permission = 'Bash(git status *)';
  assert.ok(JSON.parse(fs.readFileSync(settings, 'utf8')).permissions.allow.includes(permission));

  // Claude Code persists an approval, or the wildcarding pass rewrites the list,
  // after Auto Learn wrote it. The whole-file hash no longer matches.
  const between = JSON.parse(fs.readFileSync(settings, 'utf8'));
  between.permissions.allow = [...between.permissions.allow, 'Bash(docker *)'];
  writeJson(settings, between);

  const result = learn.undo();
  assert.equal(result.undone, true);
  const after = JSON.parse(fs.readFileSync(settings, 'utf8'));
  assert.ok(!after.permissions.allow.includes(permission), 'its own entry is released');
  assert.ok(after.permissions.allow.includes('Bash(docker *)'), 'the foreign entry survives');
  assert.ok(after.permissions.allow.includes('Bash(ls *)'), 'the pre-existing entry survives');
  assert.deepEqual(after.permissions.deny, ['Bash(rm -rf / *)'], 'deny is untouched');
});

test('undo still refuses when the Codex rules file moved underneath it', (t) => {
  const home = tempHome(t);
  const codexRulesPath = path.join(home, '.codex', 'rules', 'permission-wildcarding.rules');
  const feed = scannerFeed([observed('one', 'git status', 'success')]);
  const learn = manager(home, feed, { mode: 'auto-safe', threshold: 1, codexRulesPath });
  learn.scan();
  assert.ok(fs.existsSync(codexRulesPath));
  fs.appendFileSync(codexRulesPath, '# edited by hand\n');
  assert.throws(() => learn.undo(), /policy changed after Auto Learn wrote it/);
});

test('the observation index is capped and drops entries whose family is gone', (t) => {
  const home = tempHome(t);
  const many = Array.from({ length: 40 }, (_, index) =>
    observed(`call-${index}`, `tool-${index} run`, 'success'));
  const feed = scannerFeed(many);
  const learn = manager(home, feed, {
    codexRulesPath: null, threshold: 3, observationHashLimit: 10,
  });
  const result = learn.scan();
  assert.equal(result.observations, 40, 'every observation is still counted');
  assert.ok(result.prunedObservations >= 30);

  const statePath = learn.paths.state;
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  assert.equal(Object.keys(state.observationHashes).length, 10, 'index is capped');
  // Trimming is oldest first, so the most recent evidence keeps its dedupe entry.
  const kept = Object.values(state.observationHashes).map((entry) => entry.key);
  assert.ok(kept.includes('bash:tool-39'));
  assert.ok(!kept.includes('bash:tool-0'));
  // Counts are unaffected by trimming: the families themselves are all intact.
  assert.equal(learn.listCandidates().length, 40);
});

test('a capped index still refuses to count the same observation twice', (t) => {
  const home = tempHome(t);
  const feed = scannerFeed([observed('one', 'git status', 'success')]);
  const learn = manager(home, feed, {
    codexRulesPath: null, threshold: 3, observationHashLimit: 10,
  });
  learn.scan();
  learn.scan();
  const [candidate] = learn.listCandidates().filter((item) => item.key === 'bash:git status');
  assert.equal(candidate.counts.success, 1, 'a re-read of the same bytes is not new evidence');
});

test('overview answers status and candidates from a single state read', (t) => {
  const home = tempHome(t);
  const feed = scannerFeed([observed('one', 'git status', 'success')]);
  const learn = manager(home, feed, { codexRulesPath: null, threshold: 1 });
  learn.scan();
  let reads = 0;
  const readFileSync = fs.readFileSync;
  t.after(() => { fs.readFileSync = readFileSync; });
  fs.readFileSync = (target, ...rest) => {
    if (target === learn.paths.state) reads += 1;
    return readFileSync(target, ...rest);
  };
  const view = learn.overview();
  assert.equal(reads, 1, 'the dashboard pays for one parse, not two');
  assert.equal(view.status.counts.total, 1);
  assert.deepEqual(view.candidates.map((item) => item.key), ['bash:git status']);
  assert.equal(view.status.lastScanAt, learn.status().lastScanAt);
});
