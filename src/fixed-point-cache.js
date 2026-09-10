'use strict';

// Fixed-point cache — "are the exact bytes now in settings.json already known to be
// a fixed point of processAllowList?"
//
// The PostToolUse hook runs after every single tool call, and the overwhelmingly
// common answer is "yes, nothing to do": the allow list was generalized on some
// earlier call, and reprocessing it returns the identical list. Proving that costs a
// ~8 ms processAllowList pass plus the ~4.8 ms require chain that reaches it. This
// module answers the same question from one short file read, so the hook can skip
// both whenever the bytes have not moved.
//
// Two rules govern everything below.
//
// 1. Three requires, forever: fs, path, os. That is the lazy-require discipline
//    documented at bin/wildcard-perms:11-26, and `crypto` is the module this must
//    never reach. Measured cold in a fresh process, loading it plus the first
//    createHash plus a digest costs 4.15 ms (min 3.758 over 21 runs), because the
//    lazy OpenSSL init happens after the module snapshot and is therefore paid once
//    per process — which is once per hook call. A cache that costs 4.15 ms to consult
//    cannot pay for a 12 ms saving. Hence the hand-rolled hash below.
//    test/fixed-point-cache.test.js asserts the ban mechanically, against this file's
//    source and against the module load list of a child process.
//
// 2. Every failure degrades to a MISS. A miss costs one wasted processAllowList pass,
//    which is precisely what the hook did before this file existed. A spurious HIT
//    skips a generalization that was due, silently, forever. So nothing here throws,
//    and comparing part of a key is not representable.

const fs = require('fs');
const os = require('os');
const path = require('path');

// The cache file's ENTIRE content is the key: `1:3f2a1b9c:17004:9a3f1c07`, read,
// trimmed, compared with ===. Deliberately not JSON, despite the .json extension it
// inherits from its neighbours in ~/.claude/wildcarding:
//
//   * A torn or truncated write leaves a PREFIX of the key, and a prefix is not ===
//     the key. Degradation is structural, rather than depending on a parse error
//     happening to throw in the right place.
//   * Folding the format number and the code stamp into the one compared string makes
//     "compare only part of the key" unrepresentable. With a {version, key} object, a
//     later edit that compared only `key` would be a permanent silent false hit, and
//     nothing would ever fail — which is how such an edit survives review.
//
// The format number leads the key so that a future change to the key's shape reads as
// a miss instead of colliding with an old file.
const CACHE_VERSION = 1;

// Segments: format number, code stamp, byte length, content hash. Its only job is to
// reject values that are not keys at all (null from a failed stat, '', 'true', a JSON
// blob); the read-side === is what decides whether a real key is the right one.
const KEY_SHAPE = /^\d+:[0-9a-f]{8}:\d+:[0-9a-f]{8}$/;

// Resolved at call time, never captured at require time — the discipline
// src/agent-gates.js:64-66 and src/agent-guidance.js:55 document, because the tests
// substitute the home directory and a module-level constant would freeze whatever
// os.homedir() said at require time and then write to the real ~/.claude.
//
// Alongside the policy lock, the Auto Learn state and the recall models.
// src/permissions.js:464 defines the same directory as APPROVE_DIR; joined
// independently here on purpose, since importing it would pull in permissions.js and
// defeat the entire point of the cache.
function cachePath({ home = os.homedir(), cacheFile } = {}) {
  return cacheFile || path.join(home, '.claude', 'wildcarding', 'fixed-point.json');
}

// The two files that between them define everything processAllowList does:
// generalizePermission, createCoverIndex and prunePermissions are all in
// permissions.js, and every covering decision they make comes from
// permission-match.js via isCoveredBy -> ruleMatches / sameRule / escapeLiteral.
// There is no third input on that path — no data file, no policy read, no env.
//
// Their mtimeMs:size IS the cache's version. A hand-bumped constant is the trap this
// project already fell into at src/auto-learn-manager.js:29-31, where `VERSION = 1`
// is write-only with no migration hook. A stat also self-invalidates on an in-place
// `git checkout`, which is exactly what someone bisecting the generalizer does and
// exactly what a constant cannot see. Measured ~0.03 ms per statSync.
function codeFiles() {
  return [
    path.join(__dirname, 'permissions.js'),
    path.join(__dirname, 'permission-match.js'),
  ];
}

// Accept a string or a Buffer and hash the UTF-8 BYTES either way, so a caller that
// read settings.json as a Buffer and one that read it as a string agree. (Bytes that
// are not valid UTF-8 round-trip through a string as U+FFFD and would hash
// differently — that is a miss, which is safe.)
function bytesOf(value) {
  if (Buffer.isBuffer(value)) return value;
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  return null;
}

// FNV-1a, 32-bit, pure JS.
//
// The multiply is Math.imul and must stay Math.imul. `h *= 16777619` exceeds 2^53 on
// the very first round and silently rounds the low bits away — and the result is
// still a perfectly serviceable cache key, deterministic and collision-free enough
// that nothing ever fails, so the lost collision resistance never shows up as a
// symptom. The golden vectors in the test file are the only thing that catches it.
function fnv1a32(input) {
  const bytes = bytesOf(input) || Buffer.from(String(input), 'utf8');
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i += 1) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193);
  }
  // padStart because a hash with a leading zero nibble is otherwise 7 chars, and a
  // variable-width segment makes the key harder to eyeball and to shape-check.
  return (h >>> 0).toString(16).padStart(8, '0');
}

// One short segment for both code files, hashed together rather than concatenated as
// four raw numbers: the key is meant to be readable at a glance and compared whole.
// null on any stat failure, so no key can be minted for code whose identity is
// unknown.
function codeStamp(files) {
  if (!Array.isArray(files) || files.length === 0) return null;
  try {
    return fnv1a32(files.map((file) => {
      const stat = fs.statSync(file);
      return `${stat.mtimeMs}:${stat.size}`;
    }).join('|'));
  } catch { return null; }
}

// The key for a given settings.json content, or null if it cannot be trusted.
//
// Byte length is a segment of its own as well as being folded into the hash: it is
// free, it is the cheapest thing to compare by eye when debugging a stuck cache, and
// two contents of the same length still differ by hash.
function fixedPointKey(content, options = {}) {
  const bytes = bytesOf(content);
  if (bytes === null) return null;
  const stamp = codeStamp(options.codeFiles || codeFiles());
  if (stamp === null) return null;
  return `${CACHE_VERSION}:${stamp}:${bytes.length}:${fnv1a32(bytes)}`;
}

// The trimmed key on disk, or null. Missing file, empty file, a directory at the path
// (readFileSync throws EISDIR, not ENOENT — the one everybody forgets), an unreadable
// file: all one catch, all a miss.
function readFixedPoint(options = {}) {
  try {
    return fs.readFileSync(cachePath(options), 'utf8').trim() || null;
  } catch { return null; }
}

// Did the key land? Best-effort like readBypassState/writeBypassState in
// src/permissions.js:382-393, and for the same reason: total loss of this file costs
// exactly one cache miss.
//
// Plain writeFileSync, NOT writeFileAtomicSync. That helper's rename retry loop
// (src/permissions.js:36-46) is sleepSync(20 * (attempt + 1)) over 10 attempts, where
// sleepSync is Atomics.wait — an unyieldable thread block totalling ~1100 ms worst
// case, on EPERM/EACCES/EBUSY/ETXTBSY, which is exactly what a brand-new temp file in
// ~/.claude attracts from Defender. Importing a second of stall onto the hook path to
// protect a file worth one cache miss would be a bad trade; a torn write here is
// already handled, because a prefix of a key is not === the key.
function writeFixedPoint(key, options = {}) {
  // Refuses null, which is what fixedPointKey returns when the code stat failed: no
  // version, no write. A key must never be recorded for bytes nobody verified, and
  // never with a degenerate version.
  if (typeof key !== 'string' || !KEY_SHAPE.test(key)) return false;
  try {
    const target = cachePath(options);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `${key}\n`, 'utf8');
    return true;
  } catch { return false; }
}

// The whole point of the module, in one call, and the only comparison callers should
// write. `readFixedPoint(...) === fixedPointKey(...)` looks equivalent and is not:
// both sides return null on failure, so a failed code stat plus an absent cache file
// compares null === null and reports a HIT for content nobody has ever checked. This
// makes that unrepresentable.
function isFixedPoint(content, options = {}) {
  const key = fixedPointKey(content, options);
  return key !== null && readFixedPoint(options) === key;
}

module.exports = {
  fnv1a32,
  fixedPointKey,
  readFixedPoint,
  writeFixedPoint,
  isFixedPoint,
  cachePath,
  codeFiles,
  CACHE_VERSION,
};
