'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  MEMORY_INDEX_NAME, RECALL_EMBED_ID, RECALL_INDEX_NAME,
  indexableMemories, recallIndexCount, recallIndexStatus,
} = require('../src/recall-index');

function store(memories, { index = true, embed = RECALL_EMBED_ID } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'permission-wildcarding-recall-'));
  // Every real store has the always-loaded index beside the memories.
  fs.writeFileSync(path.join(dir, MEMORY_INDEX_NAME), '- [one](one.md) — hook\n');
  for (const [name, body] of Object.entries(memories)) {
    fs.writeFileSync(path.join(dir, name), body);
  }
  if (index) writeIndex(dir, Object.keys(memories), embed);
  return dir;
}

// Mirror what recall.py persists: float-seconds mtime + size per embedded file.
function writeIndex(dir, names, embed = RECALL_EMBED_ID) {
  const files = {};
  for (const name of names) {
    const stats = fs.statSync(path.join(dir, name));
    files[name] = { mtime: stats.mtimeMs / 1000, size: stats.size, desc: name, vec: [0, 1] };
  }
  fs.writeFileSync(path.join(dir, RECALL_INDEX_NAME), JSON.stringify({ embed, files }));
}

test('MEMORY.md is not an indexable memory, so a complete cache is not one short', () => {
  const dir = store({ 'one.md': 'first', 'two.md': 'second' });
  try {
    assert.deepEqual(indexableMemories(dir), ['one.md', 'two.md']);
    // The regression: counting MEMORY.md made embedded(2) < files(3) forever, so a
    // current cache always read as stale and every tick forced a full re-embed.
    assert.deepEqual(recallIndexStatus(dir), {
      indexable: 2, embedded: 2, stale: false, reason: 'current',
    });
    assert.equal(recallIndexCount(dir), 2);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('an added memory is work to do', () => {
  const dir = store({ 'one.md': 'first' });
  try {
    fs.writeFileSync(path.join(dir, 'two.md'), 'second');
    const status = recallIndexStatus(dir);
    assert.equal(status.stale, true);
    assert.equal(status.reason, 'count-mismatch');
    assert.equal(status.indexable, 2);
    assert.equal(status.embedded, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('an in-place edit is work to do even though the file count never moves', () => {
  const dir = store({ 'one.md': 'first', 'two.md': 'second' });
  try {
    // Same name, same count — only size and mtime move. A count comparison cannot
    // see this at all, so the auto-sync silently never fired for edits.
    fs.writeFileSync(path.join(dir, 'two.md'), 'second, revised');
    const status = recallIndexStatus(dir);
    assert.equal(status.stale, true);
    assert.equal(status.reason, 'file-changed');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a touched file with an unchanged size is still work to do', () => {
  const dir = store({ 'one.md': 'abc' });
  try {
    const target = path.join(dir, 'one.md');
    const future = new Date(Date.now() + 60_000);
    fs.utimesSync(target, future, future);
    assert.equal(fs.statSync(target).size, 3); // size held constant on purpose
    const status = recallIndexStatus(dir);
    assert.equal(status.stale, true);
    assert.equal(status.reason, 'file-changed');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a deleted memory is work to do rather than reading as current', () => {
  const dir = store({ 'one.md': 'first', 'two.md': 'second' });
  try {
    fs.rmSync(path.join(dir, 'two.md'));
    const status = recallIndexStatus(dir);
    // embedded(2) > indexable(1): a count-only check read this as "current" and left a
    // vector for a file that no longer exists in the cache.
    assert.equal(status.stale, true);
    assert.equal(status.reason, 'count-mismatch');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a renamed memory is work to do even at an identical count', () => {
  const dir = store({ 'one.md': 'first' });
  try {
    fs.renameSync(path.join(dir, 'one.md'), path.join(dir, 'renamed.md'));
    const status = recallIndexStatus(dir);
    assert.equal(status.stale, true);
    assert.equal(status.reason, 'missing-entry');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the mtime float round-trip does not read as a change', () => {
  const dir = store({ 'one.md': 'first' });
  try {
    // recall.py writes st_mtime as float seconds and this reads mtimeMs back, so the
    // comparison has to tolerate the round-trip without tolerating a real edit.
    const index = JSON.parse(fs.readFileSync(path.join(dir, RECALL_INDEX_NAME), 'utf8'));
    const stats = fs.statSync(path.join(dir, 'one.md'));
    assert.notEqual(index.files['one.md'].mtime, stats.mtimeMs); // seconds vs ms
    assert.equal(recallIndexStatus(dir).stale, false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('an unbuilt cache is stale only when there is something to embed', () => {
  const empty = store({}, { index: false });
  const populated = store({ 'one.md': 'first' }, { index: false });
  try {
    assert.deepEqual(recallIndexStatus(empty), {
      indexable: 0, embedded: null, stale: false, reason: 'no-cache',
    });
    assert.deepEqual(recallIndexStatus(populated), {
      indexable: 1, embedded: null, stale: true, reason: 'no-cache',
    });
    assert.equal(recallIndexCount(populated), null);
  } finally {
    fs.rmSync(empty, { recursive: true, force: true });
    fs.rmSync(populated, { recursive: true, force: true });
  }
});

test('a cache from a different embedder is discarded work, however fresh the stats', () => {
  const dir = store({ 'one.md': 'first' }, { embed: 'some-other-embedder' });
  try {
    const status = recallIndexStatus(dir);
    assert.equal(status.stale, true);
    assert.equal(status.reason, 'embed-id-changed');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('an unreadable dir has nothing to say rather than forcing a rebuild', () => {
  const missing = path.join(os.tmpdir(), 'permission-wildcarding-recall-absent-dir');
  assert.equal(indexableMemories(missing), null);
  assert.deepEqual(recallIndexStatus(missing), {
    indexable: null, embedded: null, stale: false, reason: 'unreadable-dir',
  });
});

test('a corrupt cache file reads as unbuilt instead of throwing', () => {
  const dir = store({ 'one.md': 'first' }, { index: false });
  try {
    fs.writeFileSync(path.join(dir, RECALL_INDEX_NAME), '{ not json');
    assert.equal(recallIndexCount(dir), null);
    assert.equal(recallIndexStatus(dir).reason, 'no-cache');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the constants shared with recall.py have not drifted', () => {
  // Two copies of one rule is how the off-by-one got in. recall.py stays the
  // authority; this pins the extension-side copy to it.
  const source = fs.readFileSync(path.join(__dirname, '..', 'memory', 'recall.py'), 'utf8');
  const excluded = /^EXCLUDE = \{([^}]*)\}/m.exec(source);
  assert.ok(excluded, 'recall.py no longer declares EXCLUDE');
  assert.equal(excluded[1].trim(), `"${MEMORY_INDEX_NAME}"`);

  const embedId = /^EMBED_ID = "([^"]+)"/m.exec(source);
  assert.ok(embedId, 'recall.py no longer declares EMBED_ID');
  assert.equal(embedId[1], RECALL_EMBED_ID);

  // The incremental path the extension relies on: mtime + size, not a count.
  assert.match(source, /idx\["files"\]\[n\]\.get\("mtime"\) != st\.st_mtime/);
  assert.match(source, /idx\["files"\]\[n\]\.get\("size"\) != st\.st_size/);

  // The silent sync runs `--list` precisely because it is the incremental build
  // (force=False): only changed files re-embed, and the ONNX session is skipped when
  // there is nothing to do. If --list stops building, the sync stops syncing.
  assert.match(source, /if args\.list:\s*\r?\n\s*idx = build_or_update\(\)/);
});
