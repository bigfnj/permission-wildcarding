'use strict';

// A managed rule the allow list cannot beat is the one thing wildcarding can
// never fix, so the only useful thing left is to say what it costs. Shell
// families could already answer that from their own run counts. File tools
// could not: they render no permission by design, so their evidence has to be
// collected as the scan runs. These tests pin the collection, the privacy
// boundary it must not cross, and the ranking built on top of it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createAutoLearnManager } = require('../src/auto-learn-manager');

function jsonl(...records) {
  return `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;
}

// Distinctive basenames, so a leak of the path is detectable by substring and
// cannot be confused with the rule text that is allowed to be stored.
const PS1 = 'D:\\work\\scripts\\uniquebuildtile.ps1';
// `**/.env*` matches a file NAMED .env-something, not any file ending in .env,
// so the fixture has to be the shape the rule actually governs.
const ENVFILE = 'D:\\work\\app\\.env.uniqueprivatecreds';
const NOTES = 'D:\\work\\docs\\uniqueplainnotes.md';
const KEYS = 'D:\\work\\etc\\authorized_keys';

const MANAGED = {
  permissions: {
    ask: ['Edit(**/*.ps1)', 'Read(**/.env*)', 'Bash(git push:*)'],
    deny: ['Edit(**/authorized_keys)'],
    allow: [],
  },
};

function fileCall(id, tool, filePath) {
  return {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id, name: tool, input: { file_path: filePath } }],
    },
  };
}

function shellCall(id, command) {
  return {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }],
    },
  };
}

function result(id) {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: id, is_error: false, content: 'ok' }],
    },
  };
}

function setup(t, { policy = MANAGED, records = [], state } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'permission-wildcarding-hits-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const history = path.join(home, '.claude', 'projects', 'project-a', 'session.jsonl');
  fs.mkdirSync(path.dirname(history), { recursive: true });
  fs.writeFileSync(history, jsonl(
    { type: 'session_meta', payload: { id: 'hits-session', cwd: 'D:\\work' } },
    ...records,
  ));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'),
    `${JSON.stringify({ permissions: { allow: [] } }, null, 2)}\n`);
  if (policy) {
    fs.writeFileSync(path.join(home, '.claude', 'remote-settings.json'),
      `${JSON.stringify(policy, null, 2)}\n`);
  }
  const statePath = path.join(home, '.claude', 'wildcarding', 'auto-learn-state.test.json');
  if (state) {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
  }
  const manager = createAutoLearnManager({
    home, threshold: 3, statePath,
    codexRulesPath: path.join(home, '.codex', 'rules', 'permission-wildcarding.rules'),
  });
  return { home, manager, statePath, history };
}

test('a file tool records the managed rule that governs it, never the path', (t) => {
  const { manager, statePath } = setup(t, {
    records: [
      fileCall('a', 'Edit', PS1), result('a'),
      fileCall('b', 'Edit', PS1), result('b'),
      fileCall('c', 'Edit', PS1), result('c'),
      fileCall('d', 'Read', ENVFILE), result('d'),
      fileCall('e', 'Edit', KEYS), result('e'),
      // Controls: a path no managed rule covers, and a write to a path only the
      // Edit rules mention, so a tool mismatch cannot be counted.
      fileCall('f', 'Edit', NOTES), result('f'),
      fileCall('g', 'Write', PS1), result('g'),
    ],
  });
  manager.scan();

  const hits = JSON.parse(fs.readFileSync(statePath, 'utf8')).managedHits;
  assert.deepEqual(hits, {
    'Edit(**/*.ps1)': { hits: 3, tools: ['Edit'] },
    'Edit(**/authorized_keys)': { hits: 1, tools: ['Edit'] },
    'Read(**/.env*)': { hits: 1, tools: ['Read'] },
  });
});

// Its own test on purpose. Folded in above it sat after a deepEqual on the hit
// table, so any unrelated change to that table failed first and this assertion
// was never reached: a privacy guard that only runs when everything else is
// already correct is not a guard. Mutating the collector to keep the path made
// exactly that happen, which is why this is separate and asserts nothing else.
test('no observed path reaches the state file, only the rule it matched', (t) => {
  const { manager, statePath } = setup(t, {
    records: [
      fileCall('a', 'Edit', PS1), result('a'),
      fileCall('d', 'Read', ENVFILE), result('d'),
      fileCall('f', 'Edit', NOTES), result('f'),
    ],
  });
  manager.scan();

  const text = fs.readFileSync(statePath, 'utf8');
  const leaks = ['uniquebuildtile', 'uniqueprivatecreds', 'uniqueplainnotes', 'scripts', 'work'];
  for (const leak of leaks) {
    assert.ok(!text.includes(leak), `state file must not carry "${leak}"`);
  }
  // And the rule, which is org policy rather than user data, is present. Without
  // this the test would also pass on a collector that recorded nothing at all.
  assert.ok(text.includes('Edit(**/*.ps1)'), 'the matched rule is what gets kept');
});

test('deny outranks ask for the same path, matching documented precedence', (t) => {
  const { manager, statePath } = setup(t, {
    policy: {
      permissions: {
        ask: ['Edit(**/*.ps1)'],
        deny: ['Edit(**/*.ps1)'],
        allow: [],
      },
    },
    records: [fileCall('a', 'Edit', PS1), result('a')],
  });
  manager.scan();
  const hits = JSON.parse(fs.readFileSync(statePath, 'utf8')).managedHits;
  assert.deepEqual(Object.keys(hits), ['Edit(**/*.ps1)']);
  const { managed } = manager.status();
  const entry = managed.costliestRules.find((item) => item.rule === 'Edit(**/*.ps1)');
  assert.equal(entry.decision, 'deny', 'a rule in both lists is reported as the deny it is');
});

test('an observation seen twice by the scanner is counted once', (t) => {
  const { manager, statePath, history } = setup(t, {
    records: [
      fileCall('a', 'Edit', PS1), result('a'),
      fileCall('b', 'Edit', PS1), result('b'),
    ],
  });
  manager.scan();
  const hits = () => JSON.parse(fs.readFileSync(statePath, 'utf8')).managedHits['Edit(**/*.ps1)'].hits;
  assert.equal(hits(), 2);

  // Two cheaper layers stop a re-count before the guard is reached, and neither
  // is the guard: an unchanged file is skipped whole by its cursor, and a grown
  // file is filtered by byte offset so only the appended calls survive. Testing
  // either proves nothing about the dedupe.
  manager.scan();
  assert.equal(hits(), 2, 'an unchanged file is skipped by its cursor');
  fs.appendFileSync(history, jsonl(fileCall('c', 'Edit', PS1), result('c')));
  manager.scan();
  assert.equal(hits(), 3, 'an append is filtered by offset, so only the new call lands');

  // The path that DOES reach it: a rewritten transcript. The head fingerprint no
  // longer matches, so the file is re-read whole with no offset filter, and
  // every earlier call arrives again with its observation hash already stored.
  // Without the hash check a compacted transcript would re-count its entire
  // history on the next scan, inflating the number the report is built on.
  fs.writeFileSync(history, jsonl(
    { type: 'noise', note: 'a rewritten head changes the fingerprint' },
    { type: 'session_meta', payload: { id: 'hits-session', cwd: 'D:\\work' } },
    fileCall('a', 'Edit', PS1), result('a'),
    fileCall('b', 'Edit', PS1), result('b'),
    fileCall('c', 'Edit', PS1), result('c'),
    fileCall('d', 'Edit', PS1), result('d'),
  ));
  manager.scan();
  assert.equal(hits(), 4, 'the one new call counts; the three re-read ones do not');
});

test('costliest rules merge shell family runs with file-tool hits, ranked by cost', (t) => {
  const { manager } = setup(t, {
    records: [
      fileCall('e1', 'Edit', PS1), result('e1'),
      fileCall('e2', 'Edit', PS1), result('e2'),
      shellCall('s1', 'git push origin main'), result('s1'),
      shellCall('s2', 'git push origin main'), result('s2'),
      shellCall('s3', 'git push --tags'), result('s3'),
      shellCall('s4', 'git push --tags'), result('s4'),
      shellCall('s5', 'git push --tags'), result('s5'),
      // A family no managed rule touches must not appear at any cost.
      shellCall('s6', 'rg TODO'), result('s6'),
    ],
  });
  manager.scan();
  const { managed } = manager.status();

  const rules = managed.costliestRules.map((entry) => entry.rule);
  assert.deepEqual(rules, ['Bash(git push:*)', 'Edit(**/*.ps1)'],
    'the shell rule cost 5 prompts and the edit rule 2, so it ranks first');
  assert.equal(managed.costliestRules[0].prompts, 5);
  assert.equal(managed.costliestRules[1].prompts, 2);
  assert.deepEqual(managed.costliestRules[1].tools, ['Edit']);
  assert.ok(managed.costliestRules.every((entry) => entry.decision === 'ask'));
  assert.ok(!rules.includes('Bash(rg *)'));
});

test('no managed policy means no matcher, no hits, and an honest report', (t) => {
  const { manager, statePath } = setup(t, {
    policy: null,
    records: [fileCall('a', 'Edit', PS1), result('a')],
  });
  manager.scan();
  assert.deepEqual(JSON.parse(fs.readFileSync(statePath, 'utf8')).managedHits, {},
    'an unmanaged machine has nothing to attribute');
  const { managed } = manager.status();
  assert.equal(managed.policy, 'absent');
  assert.deepEqual(managed.costliestRules, [],
    'absent must read as no data, never as a confident zero');
});

test('a rebuild derives the table from the whole corpus without disturbing a scan', (t) => {
  const { manager, statePath } = setup(t, {
    records: [
      fileCall('a', 'Edit', PS1), result('a'),
      fileCall('b', 'Edit', PS1), result('b'),
      fileCall('c', 'Read', ENVFILE), result('c'),
      fileCall('d', 'Edit', NOTES), result('d'),
      shellCall('s1', 'git push origin main'), result('s1'),
    ],
  });
  // A machine that has been running a while has already consumed its corpus, so
  // the table a normal scan can build is the one thing a new install cannot get.
  manager.scan();
  const afterScan = JSON.parse(fs.readFileSync(statePath, 'utf8'));

  const report = manager.rebuildManagedHits();
  assert.equal(report.policy, 'present');
  assert.equal(report.rules, 2, 'the two covered rules, not the uncovered path');
  assert.equal(report.prompts, 3, 'two ps1 edits plus one .env read');

  const afterRebuild = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  assert.deepEqual(afterRebuild.managedHits, {
    'Edit(**/*.ps1)': { hits: 2, tools: ['Edit'] },
    'Read(**/.env*)': { hits: 1, tools: ['Read'] },
  });

  // The rebuild reads with empty cursors to force a full pass. If it saved the
  // cursors it produced, or touched candidates, it would silently rewind or
  // corrupt the scan it is supposed to sit beside.
  assert.deepEqual(afterRebuild.cursors, afterScan.cursors, 'cursors are not moved');
  assert.deepEqual(afterRebuild.candidates, afterScan.candidates, 'candidates are not touched');
  assert.deepEqual(afterRebuild.observationHashes, afterScan.observationHashes,
    'observation hashes are not touched');

  // Idempotent: a second pass replaces rather than accumulates.
  manager.rebuildManagedHits();
  assert.deepEqual(JSON.parse(fs.readFileSync(statePath, 'utf8')).managedHits,
    afterRebuild.managedHits, 'running it twice is running it once');
});

test('a rebuild with no managed policy clears the table instead of keeping stale counts', (t) => {
  const { manager, statePath } = setup(t, {
    policy: null,
    records: [fileCall('a', 'Edit', PS1), result('a')],
    state: {
      version: 1, mode: 'recommend', threshold: 3, candidates: {}, observationHashes: {},
      cursors: {}, applied: { claude: [], codex: [] }, reviewed: { claude: [], codex: [] },
      codexTargets: {}, managedClaude: {},
      managedHits: { 'Edit(**/*.ps1)': { hits: 99, tools: ['Edit'] } },
      lastScanAt: null, lastScanStats: null, lastApplication: null,
    },
  });
  const report = manager.rebuildManagedHits();
  assert.equal(report.policy, 'absent');
  assert.equal(report.rules, 0);
  // A count attributed to a policy that is no longer there is worse than no
  // count: it names a rule the reader cannot find in any file.
  assert.deepEqual(JSON.parse(fs.readFileSync(statePath, 'utf8')).managedHits, {});
});

test('the hit table is capped, and eviction keeps the expensive rules', (t) => {
  // A managed policy has a few dozen rules, so passing the cap means a bug. The
  // file still must not grow without bound, and what survives has to be the
  // part the report is about.
  const managedHits = {};
  for (let index = 0; index < 250; index += 1) {
    managedHits[`Edit(**/generated-${String(index).padStart(3, '0')}.ps1)`] = { hits: index + 1, tools: ['Edit'] };
  }
  const { manager, statePath } = setup(t, {
    records: [fileCall('a', 'Edit', PS1), result('a')],
    state: {
      version: 1, mode: 'recommend', threshold: 3, candidates: {}, observationHashes: {},
      cursors: {}, applied: { claude: [], codex: [] }, reviewed: { claude: [], codex: [] },
      codexTargets: {}, managedClaude: {}, managedHits,
      lastScanAt: null, lastScanStats: null, lastApplication: null,
    },
  });
  manager.scan();
  const stored = JSON.parse(fs.readFileSync(statePath, 'utf8')).managedHits;
  const keys = Object.keys(stored);
  assert.equal(keys.length, 200, 'the cap holds through a load and a save');
  assert.ok(keys.includes('Edit(**/generated-249.ps1)'), 'the costliest rule survives');
  assert.ok(!keys.includes('Edit(**/generated-000.ps1)'), 'the cheapest rule is evicted first');

  // A malformed or zero-hit entry is dropped rather than stored as noise.
  assert.ok(Object.values(stored).every((entry) => entry.hits > 0));
});
