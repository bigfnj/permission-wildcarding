'use strict';

// Recall vector-cache bookkeeping, shared by the extension and its tests.
//
// recall.py owns the cache; this module only answers "is it behind the files?"
// so the extension can decide whether spawning python is worth it. recall.py's
// build_or_update() stays the authority, and every predicate here mirrors the
// comparison it makes (name set, size, mtime, embed identity) so the two agree
// on what "current" means. A drift test pins the two shared constants.
//
// The rule that is easy to get wrong: MEMORY.md is the always-loaded index, and
// recall.py excludes it from the corpus. Counting it as an indexable file makes
// a complete cache read one short forever, which silently converts a staleness
// check into a full re-embed of every memory on every tick.

const fs = require('fs');
const path = require('path');

const MEMORY_INDEX_NAME = 'MEMORY.md';       // recall.py EXCLUDE
const RECALL_EMBED_ID = 'bge-small-onnx';    // recall.py EMBED_ID
const RECALL_INDEX_NAME = 'recall_index.json';
// Python writes st_mtime as float seconds and Node reads mtimeMs; measured on a
// real store the two agree to ~0.0002ms, so 1ms is slack for the float
// round-trip without being loose enough to miss an edit.
const MTIME_TOLERANCE_MS = 1;

// The files recall.py would embed: every .md in the dir except the index itself.
// null when the dir cannot be read — there is nothing to say about it then.
function indexableMemories(dir) {
  try {
    return fs.readdirSync(dir)
      .filter((name) => name.endsWith('.md') && name !== MEMORY_INDEX_NAME)
      .sort();
  } catch { return null; }
}

// The parsed cache, or null when it is absent, unreadable, or not a cache.
function readRecallIndex(dir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, RECALL_INDEX_NAME), 'utf8'));
    return parsed && parsed.files && typeof parsed.files === 'object' ? parsed : null;
  } catch { return null; }
}

// How many memories are in the cache; null when it has not been built yet.
function recallIndexCount(dir) {
  const index = readRecallIndex(dir);
  return index ? Object.keys(index.files).length : null;
}

function entryMatchesFile(entry, stats) {
  if (!entry || typeof entry !== 'object') return false;
  if (entry.size !== stats.size) return false;
  return Math.abs(Number(entry.mtime) * 1000 - stats.mtimeMs) <= MTIME_TOLERANCE_MS;
}

// Is the cache behind the corpus? A count comparison alone cannot see an
// in-place edit (count unchanged) or a deletion (count moves the wrong way), so
// both used to slip past: the feature looked like it worked because a separate
// off-by-one kept it firing anyway.
function recallIndexStatus(dir) {
  const indexable = indexableMemories(dir);
  if (indexable == null) {
    return { indexable: null, embedded: null, stale: false, reason: 'unreadable-dir' };
  }
  const index = readRecallIndex(dir);
  if (!index) {
    return {
      indexable: indexable.length, embedded: null,
      stale: indexable.length > 0, reason: 'no-cache',
    };
  }
  const embedded = Object.keys(index.files).length;
  const base = { indexable: indexable.length, embedded, stale: false, reason: 'current' };
  // recall.py discards the whole cache when the embedder identity changed, so a
  // mismatch is pending work however well the per-file stats line up.
  if (index.embed !== RECALL_EMBED_ID) return { ...base, stale: true, reason: 'embed-id-changed' };
  if (embedded !== indexable.length) return { ...base, stale: true, reason: 'count-mismatch' };
  for (const name of indexable) {
    const entry = index.files[name];
    if (!entry) return { ...base, stale: true, reason: 'missing-entry' };
    let stats;
    try { stats = fs.statSync(path.join(dir, name)); }
    catch { return { ...base, stale: true, reason: 'unreadable-file' }; }
    if (!entryMatchesFile(entry, stats)) return { ...base, stale: true, reason: 'file-changed' };
  }
  return base;
}

module.exports = {
  MEMORY_INDEX_NAME, RECALL_EMBED_ID, RECALL_INDEX_NAME, MTIME_TOLERANCE_MS,
  indexableMemories, readRecallIndex, recallIndexCount, recallIndexStatus,
};
