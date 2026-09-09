'use strict';

// The review loop around the derivation. A mitigation is worth a permanent line
// in someone's instruction file only if a human said so, only while its evidence
// holds, and only once. These tests pin all three, end to end through the
// manager and onto a real file.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createAutoLearnManager } = require('../src/auto-learn-manager');
const { installedDerivedIds } = require('../src/derived-guidance');

function jsonl(...records) {
  return `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;
}

const PS1 = 'D:\\work\\scripts\\build.ps1';

function fileCall(id, filePath) {
  return {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id, name: 'Edit', input: { file_path: filePath } }],
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

// Enough calls to clear the threshold that protects the context budget.
function edits(count) {
  const records = [];
  for (let index = 0; index < count; index += 1) {
    records.push(fileCall(`edit-${index}`, PS1), result(`edit-${index}`));
  }
  return records;
}

function setup(t, { count = 60, notes = '# my own instructions\n\nread these first\n' } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'permission-wildcarding-review-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const history = path.join(home, '.claude', 'projects', 'p', 'session.jsonl');
  fs.mkdirSync(path.dirname(history), { recursive: true });
  fs.writeFileSync(history, jsonl(
    { type: 'session_meta', payload: { id: 'review-session', cwd: 'D:\\work' } },
    ...edits(count),
  ));
  const claudeMd = path.join(home, '.claude', 'CLAUDE.md');
  fs.writeFileSync(claudeMd, notes);
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'),
    `${JSON.stringify({ permissions: { allow: [] } }, null, 2)}\n`);
  fs.writeFileSync(path.join(home, '.claude', 'remote-settings.json'),
    `${JSON.stringify({ permissions: { ask: ['Edit(**/*.ps1)'], deny: [], allow: [] } }, null, 2)}\n`);
  const manager = createAutoLearnManager({
    home,
    statePath: path.join(home, '.claude', 'wildcarding', 'state.json'),
    backupDir: path.join(home, '.claude', 'backups'),
    codexRulesPath: path.join(home, '.codex', 'rules', 'permission-wildcarding.rules'),
  });
  manager.scan();
  return { home, manager, claudeMd, notes };
}

test('a mitigation is offered from measured evidence and written only once accepted', (t) => {
  const { manager, claudeMd, notes } = setup(t);

  const review = manager.derivedReview();
  assert.equal(review.policy, 'present');
  assert.deepEqual(review.mitigations.map((item) => item.id), ['batch-file-edits']);
  assert.deepEqual(review.pending.map((item) => item.id), ['batch-file-edits']);
  assert.deepEqual(review.accepted, []);
  assert.equal(review.mitigations[0].prompts, 60);
  assert.match(review.mitigations[0].body, /Measured 60 prompts/);

  // Offering is not installing. Reading the review must never write.
  assert.equal(fs.readFileSync(claudeMd, 'utf8'), notes);
  assert.deepEqual(review.targets.find((item) => item.agent === 'claude').installed, []);

  const accepted = manager.decideDerived('batch-file-edits', 'accept');
  assert.deepEqual(accepted.accepted, ['batch-file-edits']);
  const target = accepted.targets.find((item) => item.agent === 'claude');
  assert.equal(target.changed, true);
  assert.deepEqual(target.added, ['batch-file-edits']);

  const text = fs.readFileSync(claudeMd, 'utf8');
  assert.deepEqual(installedDerivedIds(text), ['batch-file-edits']);
  assert.match(text, /Measured 60 prompts/);
  assert.match(text, /^# my own instructions$/m, 'the file opens with what the user wrote');

  // The decision survives a reload, and re-applying it writes nothing.
  assert.deepEqual(manager.derivedReview().accepted, ['batch-file-edits']);
  assert.deepEqual(manager.derivedReview().pending, []);
  const again = manager.decideDerived('batch-file-edits', 'accept');
  assert.equal(again.targets.find((item) => item.agent === 'claude').changed, false);
  assert.equal(fs.readFileSync(claudeMd, 'utf8'), text);
});

test('declining is remembered, so the same item is not re-offered forever', (t) => {
  const { manager, claudeMd, notes } = setup(t);
  const declined = manager.decideDerived('batch-file-edits', 'decline');
  assert.deepEqual(declined.declined, ['batch-file-edits']);
  assert.equal(fs.readFileSync(claudeMd, 'utf8'), notes, 'a decline writes nothing');

  const review = manager.derivedReview();
  // Still derived, because the cost is still real, but no longer pending. A
  // review list that keeps re-asking is one its reader learns to skip.
  assert.deepEqual(review.mitigations.map((item) => item.id), ['batch-file-edits']);
  assert.deepEqual(review.pending, []);
  assert.deepEqual(review.declined, ['batch-file-edits']);

  // And a decline after an accept removes what the accept wrote.
  manager.decideDerived('batch-file-edits', 'accept');
  assert.deepEqual(installedDerivedIds(fs.readFileSync(claudeMd, 'utf8')), ['batch-file-edits']);
  const removed = manager.decideDerived('batch-file-edits', 'decline');
  assert.deepEqual(removed.targets.find((item) => item.agent === 'claude').removed,
    ['batch-file-edits']);
  assert.equal(fs.readFileSync(claudeMd, 'utf8'), notes, 'a full round trip restores the file');
});

test('reset returns an item to pending without leaving its block behind', (t) => {
  const { manager, claudeMd, notes } = setup(t);
  manager.decideDerived('batch-file-edits', 'accept');
  const reset = manager.decideDerived('batch-file-edits', 'reset');
  assert.deepEqual(reset.accepted, []);
  assert.deepEqual(reset.declined, []);
  assert.equal(fs.readFileSync(claudeMd, 'utf8'), notes);
  assert.deepEqual(manager.derivedReview().pending.map((item) => item.id), ['batch-file-edits']);
});

test('evidence below the threshold offers nothing and installs nothing', (t) => {
  const { manager, claudeMd, notes } = setup(t, { count: 10 });
  const review = manager.derivedReview();
  assert.deepEqual(review.mitigations, [], '10 prompts does not earn a permanent instruction');
  assert.deepEqual(review.pending, []);

  // Accepting an id that is not currently derived must not fabricate a block.
  // The accept is recorded, so it takes effect if the cost ever returns.
  const accepted = manager.decideDerived('batch-file-edits', 'accept');
  assert.deepEqual(accepted.accepted, ['batch-file-edits']);
  assert.equal(fs.readFileSync(claudeMd, 'utf8'), notes);
  assert.deepEqual(installedDerivedIds(fs.readFileSync(claudeMd, 'utf8')), []);
});

test('an accepted block is swept once its evidence falls away', (t) => {
  const { manager, claudeMd } = setup(t);
  manager.decideDerived('batch-file-edits', 'accept');
  assert.match(fs.readFileSync(claudeMd, 'utf8'), /Measured 60 prompts/);

  // Rebuilding against a corpus that no longer shows the cost is what success
  // looks like: the policy was fixed, or the advice worked. The block has to go,
  // because the number in it was the whole justification for keeping it.
  fs.writeFileSync(path.join(path.dirname(claudeMd), 'remote-settings.json'),
    `${JSON.stringify({ permissions: { ask: ['Bash(nothing-here:*)'], deny: [], allow: [] } }, null, 2)}\n`);
  const fresh = createAutoLearnManager({
    home: path.dirname(path.dirname(claudeMd)),
    statePath: path.join(path.dirname(claudeMd), 'wildcarding', 'state.json'),
    backupDir: path.join(path.dirname(claudeMd), 'backups'),
  });
  fresh.rebuildManagedHits();
  const swept = fresh.decideDerived('batch-file-edits', 'accept');
  assert.deepEqual(swept.targets.find((item) => item.agent === 'claude').removed,
    ['batch-file-edits']);
  const text = fs.readFileSync(claudeMd, 'utf8');
  assert.ok(!text.includes('Measured 60 prompts'), 'a stale number is a false claim');
  assert.deepEqual(installedDerivedIds(text), []);
});

test('a bad id or decision is refused rather than written', (t) => {
  const { manager, claudeMd, notes } = setup(t);
  for (const bad of ['', '  ', 'Not An Id', '../../etc/passwd', 'x'.repeat(65)]) {
    assert.throws(() => manager.decideDerived(bad, 'accept'), /Invalid derived mitigation id/,
      JSON.stringify(bad));
  }
  assert.throws(() => manager.decideDerived('batch-file-edits', 'maybe'), /Invalid decision/);
  assert.equal(fs.readFileSync(claudeMd, 'utf8'), notes);
});

test('an unreadable policy withholds the write instead of removing what is installed', (t) => {
  const { manager, claudeMd } = setup(t);
  manager.decideDerived('batch-file-edits', 'accept');
  const installed = fs.readFileSync(claudeMd, 'utf8');
  assert.deepEqual(installedDerivedIds(installed), ['batch-file-edits']);

  // The managed file is a client-rewritten cache, so catching it mid-write is
  // realistic. With no readable policy there is no derivation, and reconciling
  // against an empty one does not install nothing, it removes what is there and
  // then reports the item as installed anyway. Removing this tool's own
  // marker-fenced block is a normal, intended operation; doing it on
  // information the tool knows is incomplete is not.
  fs.writeFileSync(path.join(path.dirname(claudeMd), 'remote-settings.json'), '{ not json');
  const fresh = createAutoLearnManager({
    home: path.dirname(path.dirname(claudeMd)),
    statePath: path.join(path.dirname(claudeMd), 'wildcarding', 'state.json'),
    backupDir: path.join(path.dirname(claudeMd), 'backups'),
  });
  const blocked = fresh.decideDerived('read-gated-path-once', 'decline');
  assert.equal(blocked.blocked, 'managed-policy-unreadable');
  assert.deepEqual(blocked.targets, [], 'no target was touched');
  assert.deepEqual(blocked.declined, ['read-gated-path-once'], 'the decision is still recorded');
  assert.equal(fs.readFileSync(claudeMd, 'utf8'), installed, 'the file is byte-identical');

  // And a rebuild in the same condition keeps the evidence rather than zeroing
  // it, so one badly-timed command cannot destroy a full-corpus derivation.
  const report = fresh.rebuildManagedHits();
  assert.equal(report.blocked, 'managed-policy-unreadable');
  assert.equal(report.degraded, true);
  assert.ok(report.prompts > 0, 'the existing table survives an unreadable policy');
});

test('an accepted mitigation is not evicted by the cap when costlier rules appear', (t) => {
  const { manager, claudeMd } = setup(t);
  manager.decideDerived('batch-file-edits', 'accept');
  assert.deepEqual(installedDerivedIds(fs.readFileSync(claudeMd, 'utf8')), ['batch-file-edits']);

  // The cap limits how much is OFFERED. Applying it before consulting the
  // accepted set meant three costlier rules silently uninstalled an accepted
  // mitigation whose own rule was still far above threshold.
  const home = path.dirname(path.dirname(claudeMd));
  fs.writeFileSync(path.join(path.dirname(claudeMd), 'remote-settings.json'),
    `${JSON.stringify({ permissions: { ask: [
      'Edit(**/*.ps1)', 'Bash(curl:*)', 'Bash(cmake:*)', 'Read(**/.env*)',
    ], deny: [], allow: [] } }, null, 2)}\n`);
  const statePath = path.join(path.dirname(claudeMd), 'wildcarding', 'state.json');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  state.managedHits = {
    'Bash(curl:*)': { hits: 900, tools: ['Bash'] },
    'Bash(cmake:*)': { hits: 800, tools: ['Bash'] },
    'Read(**/.env*)': { hits: 700, tools: ['Read'] },
    // The accepted item's own evidence is untouched and still far above
    // threshold. It is only the cap that would have evicted it.
    'Edit(**/*.ps1)': { hits: 60, tools: ['Edit'] },
  };
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);

  const fresh = createAutoLearnManager({
    home, statePath, backupDir: path.join(path.dirname(claudeMd), 'backups'),
  });
  const review = fresh.derivedReview();
  assert.equal(review.pending.length, 3, 'three items on offer, which is the cap');
  assert.ok(review.mitigations.some((item) => item.id === 'batch-file-edits'),
    'and the accepted one is still visible past the cap');

  const after = fresh.decideDerived('batch-network-fetches', 'accept');
  const target = after.targets.find((item) => item.agent === 'claude');
  assert.deepEqual(target.removed, [], 'nothing was evicted');
  assert.deepEqual(installedDerivedIds(fs.readFileSync(claudeMd, 'utf8')).sort(),
    ['batch-file-edits', 'batch-network-fetches']);
});

test('a rebuild and a following scan do not count the same call twice', (t) => {
  // The recommended bootstrap on a fresh install is exactly the dangerous
  // order: a rebuild counts straight from the corpus without writing
  // observation hashes, so the scan that follows saw every call as first sight.
  // The doubled number is what gets written into a human's instruction file as
  // the justification for a standing rule.
  const { manager, home } = setup(t, { count: 4 });
  const statePath = path.join(home, '.claude', 'wildcarding', 'state.json');
  const hits = () => {
    const table = JSON.parse(fs.readFileSync(statePath, 'utf8')).managedHits;
    return table['Edit(**/*.ps1)'] ? table['Edit(**/*.ps1)'].hits : 0;
  };
  assert.equal(hits(), 4, 'setup scans, so the incremental path counted them');

  const rebuilt = manager.rebuildManagedHits();
  assert.equal(rebuilt.prompts, 4);
  assert.ok(rebuilt.countedThrough, 'the pass records how far it counted');
  manager.scan();
  assert.equal(hits(), 4, 'a scan after a rebuild adds nothing it already counted');
});
