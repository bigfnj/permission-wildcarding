'use strict';

// The fixed-point cache is the one module in this repo whose defects are all
// silent. It exists to let the PostToolUse hook skip a ~8 ms processAllowList pass
// and the ~4.8 ms require chain that reaches it, and every way it can be wrong
// still "works":
//
//   * a hash that has lost its low bits is still a deterministic cache key;
//   * a key compared in part still hits, forever, and never generalizes again;
//   * a `crypto` load costs more than the pass it was added to avoid, and the
//     hook still produces the right answer.
//
// So the tests here are mostly about things that produce no symptom. Nothing
// below asserts that a hit is fast; they assert that a hit is EARNED.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const MODULE = path.join(__dirname, '..', 'src', 'fixed-point-cache.js');
const {
  fnv1a32, fixedPointKey, readFixedPoint, writeFixedPoint, isFixedPoint,
  cachePath, CACHE_VERSION,
} = require('../src/fixed-point-cache');

// Stands in for settings.json. Only its bytes matter to this module.
const CONTENT = JSON.stringify({
  permissions: { allow: ['Bash(git *)', 'Bash(rg *)'], deny: [] },
}, null, 2) + '\n';

function sandbox(t, label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `permission-wildcarding-${label}-`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Two whole-second stamps. utimesSync with a whole second sidesteps every
// filesystem timestamp-granularity question, the way the policy-lock test does —
// neither platform's precision should decide whether this passes.
const T1 = 1_600_000_000_000;
const T2 = 1_600_000_060_000;

test('the FNV-1a golden vectors, which pin Math.imul and nothing else', () => {
  // The canonical FNV-1a 32-bit vectors. They are here for exactly one defect:
  // writing the multiply as `h *= 16777619` instead of Math.imul. That form
  // exceeds 2^53 and rounds the low bits away — and it still functions perfectly
  // as a cache, so it produces no failure anywhere, ever, and only the collision
  // resistance quietly dies.
  //
  // Traced byte by byte against a BigInt reference: the float form reproduces ''
  // (no multiply at all) and 'a' (one multiply that happens to round to the exact
  // value), then diverges on the FIRST byte of 'foobar' — e30c2798 against the
  // correct e30c2799 — and ends at 0ee3c7f0. So the third vector is the only one
  // with teeth, and the first two are pinned to say so.
  assert.equal(fnv1a32(''), '811c9dc5');
  assert.equal(fnv1a32('a'), 'e40c292c');
  assert.equal(fnv1a32('foobar'), 'bf9cf968');

  // A hash whose top nibble is zero must still be 8 characters: the key is
  // shape-checked on write and eyeballed by whoever debugs a stuck cache, and a
  // variable-width segment defeats both.
  assert.equal(fnv1a32('pad400'), '02b6d30a');

  // Bytes, not UTF-16 code units, so a caller that read settings.json as a Buffer
  // and one that read it as a string agree instead of missing forever.
  assert.equal(fnv1a32(Buffer.from('foobar', 'utf8')), 'bf9cf968');
  assert.equal(fnv1a32('é'), fnv1a32(Buffer.from([0xc3, 0xa9])));
});

test('the key tracks the settings bytes exactly', () => {
  const key = fixedPointKey(CONTENT);
  assert.match(key, /^\d+:[0-9a-f]{8}:\d+:[0-9a-f]{8}$/);
  assert.ok(key.startsWith(`${CACHE_VERSION}:`), 'the format number leads the key');

  // Identical bytes, identical key: this is the entire hit path, and if it were
  // not stable within a process the cache would never hit at all.
  assert.equal(fixedPointKey(CONTENT), key);
  assert.equal(fixedPointKey(Buffer.from(CONTENT, 'utf8')), key,
    'a Buffer read and a string read of one file are the same fixed point');

  // One byte different is a different fixed-point question. This is the case that
  // matters most: Claude Code appending one permission must not read as a hit.
  const grew = CONTENT.replace('"deny": []', '"deny": ["Bash(rm *)"]');
  assert.notEqual(fixedPointKey(grew), key);

  // Byte length is a segment of its own, but it is not the only thing compared:
  // two contents of the same length must still differ, or any permission swapped
  // for an equally long one would be invisible.
  const swapped = CONTENT.replace('Bash(rg *)', 'Bash(rm *)');
  assert.equal(swapped.length, CONTENT.length, 'the fixture must be length-preserving');
  assert.notEqual(fixedPointKey(swapped), key);
  assert.equal(key.split(':')[2], String(Buffer.byteLength(CONTENT, 'utf8')),
    'the length segment is the real byte length, not the string length');

  // Anything that is not bytes somebody read gets no key. `String(null)` would
  // otherwise mint a perfectly valid key for the four characters "null".
  for (const notBytes of [null, undefined, 42, {}, ['a'], true]) {
    assert.equal(fixedPointKey(notBytes), null);
  }
});

test('the key follows the code, so a checkout invalidates it without a version bump', (t) => {
  const dir = sandbox(t, 'fpcode');
  const first = path.join(dir, 'permissions.js');
  const second = path.join(dir, 'permission-match.js');
  fs.writeFileSync(first, 'a');
  fs.writeFileSync(second, 'b');
  const codeFiles = [first, second];
  const keyAt = () => fixedPointKey(CONTENT, { codeFiles });

  const stamp = (file, when) => fs.utimesSync(file, new Date(when), new Date(when));
  stamp(first, T1);
  stamp(second, T1);
  const original = keyAt();
  assert.equal(keyAt(), original, 'stable while the code is');

  // mtime alone, with the size untouched. `git checkout` of a single file in place
  // is the motivating case — it is what someone bisecting the generalizer does, it
  // can leave the size identical, and a hand-maintained VERSION constant (the
  // src/auto-learn-manager.js:29-31 shape) cannot see it at all. Without this the
  // cache would report a stale fixed point for the whole bisect.
  stamp(first, T2);
  const touched = keyAt();
  assert.notEqual(touched, original);

  // Size alone: rewrite longer, then put the mtime back, so size is the only
  // difference left between this key and the one above.
  fs.writeFileSync(first, 'aa');
  stamp(first, T2);
  assert.notEqual(keyAt(), touched);

  // Both files count. permission-match.js decides every covering question
  // processAllowList asks, so a change there changes the answer just as much.
  const beforeSecond = keyAt();
  stamp(second, T2);
  assert.notEqual(keyAt(), beforeSecond);
});

test('no key, and no write, when the code cannot be stat-ed', (t) => {
  const dir = sandbox(t, 'fpnostat');
  const home = path.join(dir, 'home');
  const missing = [path.join(dir, 'gone.js'), path.join(dir, 'also-gone.js')];

  // A stat failure must not throw out of the module, and must not fall back to
  // some degenerate stamp: a key written with a placeholder version would be a
  // permanent false hit once the real files came back.
  assert.equal(fixedPointKey(CONTENT, { codeFiles: missing }), null);
  assert.equal(fixedPointKey(CONTENT, { codeFiles: [] }), null);
  assert.equal(isFixedPoint(CONTENT, { home, codeFiles: missing }), false);

  // Which means the write side has to refuse null rather than stringify it, and
  // refuse anything else that is not a key. writeFixedPoint is the only function
  // that can create a hit, so its input has to come from fixedPointKey.
  for (const notKey of [null, undefined, '', '  ', 'true', '1', 42, {},
    JSON.stringify({ version: 1, key: 'abc' })]) {
    assert.equal(writeFixedPoint(notKey, { home }), false);
  }
  assert.equal(fs.existsSync(cachePath({ home })), false, 'no file was created');
});

test('a written key round-trips, and the file is the key rather than JSON', (t) => {
  const home = sandbox(t, 'fptrip');
  const key = fixedPointKey(CONTENT);

  assert.equal(readFixedPoint({ home }), null, 'nothing before the write');
  assert.equal(writeFixedPoint(key, { home }), true);
  assert.equal(readFixedPoint({ home }), key);
  assert.equal(isFixedPoint(CONTENT, { home }), true);

  // The parent directory is created on the way, like writeBypassState does: on a
  // fresh machine ~/.claude/wildcarding does not exist until some feature makes it.
  const file = cachePath({ home });
  assert.equal(file, path.join(home, '.claude', 'wildcarding', 'fixed-point.json'));

  // The ENTIRE content is the key. Not a JSON object holding the key — that shape
  // is what allows a later edit to compare only one field of it, which would hit
  // forever and fail nothing. Pinned mechanically so such an edit breaks a test.
  const raw = fs.readFileSync(file, 'utf8');
  assert.equal(raw.trim(), key);
  assert.throws(() => JSON.parse(raw), SyntaxError,
    'the cache file must not be parseable as JSON');

  // Rewriting replaces rather than appends, so the file can never accumulate two
  // keys and hit on the older one.
  const other = fixedPointKey(`${CONTENT}\n`);
  assert.equal(writeFixedPoint(other, { home }), true);
  assert.equal(readFixedPoint({ home }), other);
  assert.equal(isFixedPoint(CONTENT, { home }), false);
});

test('every unusable cache file degrades to a miss and throws nothing', (t) => {
  const home = sandbox(t, 'fpmiss');
  const file = cachePath({ home });
  const key = fixedPointKey(CONTENT);
  fs.mkdirSync(path.dirname(file), { recursive: true });

  // The invariant for all of these is isFixedPoint === false. readFixedPoint is
  // only null for the cases with no key-shaped text in them at all; for garbage it
  // returns the garbage, and the === is what rejects it.
  const missesWith = (label, write) => {
    fs.rmSync(file, { recursive: true, force: true });
    write();
    assert.doesNotThrow(() => readFixedPoint({ home }), label);
    assert.equal(isFixedPoint(CONTENT, { home }), false, `${label} must be a miss`);
  };

  missesWith('an absent file', () => {});
  assert.equal(readFixedPoint({ home }), null);

  missesWith('an empty file', () => fs.writeFileSync(file, ''));
  assert.equal(readFixedPoint({ home }), null, 'empty is a miss, not the empty string');

  missesWith('a whitespace-only file', () => fs.writeFileSync(file, '\r\n \t\n'));
  assert.equal(readFixedPoint({ home }), null);

  missesWith('garbage', () => fs.writeFileSync(file, 'not a key at all\n'));
  missesWith('a JSON file from some other format', () =>
    fs.writeFileSync(file, `${JSON.stringify({ version: 1, key })}\n`));

  // The torn write. A half-flushed file leaves a PREFIX of the key, and a prefix is
  // not === the key, so this degrades by construction rather than by a catch
  // happening to be in the right place. Every prefix, not just a plausible one.
  for (let cut = 1; cut < key.length; cut += 1) {
    missesWith(`a key truncated to ${cut} bytes`, () =>
      fs.writeFileSync(file, key.slice(0, cut)));
  }

  // A DIRECTORY at the cache path. readFileSync throws EISDIR here, not ENOENT —
  // on Windows as well as POSIX, confirmed — so an `err.code === 'ENOENT'` guard
  // instead of a bare catch would let this one escape into the hook, which runs
  // after every tool call.
  missesWith('a directory at the cache path', () => fs.mkdirSync(file));
  assert.equal(readFixedPoint({ home }), null);

  // And the real key still hits afterwards, so none of the above passed by making
  // the whole module inert.
  fs.rmSync(file, { recursive: true, force: true });
  assert.equal(writeFixedPoint(key, { home }), true);
  assert.equal(isFixedPoint(CONTENT, { home }), true);
});

test('a write that cannot land returns false rather than throwing', (t) => {
  const dir = sandbox(t, 'fpunwritable');
  const key = fixedPointKey(CONTENT);

  // A FILE where ~/.claude has to be, which is the portable way to make the write
  // fail: mkdirSync of the parent gets ENOTDIR on both platforms, where a chmod
  // would be ignored on Windows. Stands in for the real cause — an unwritable or
  // Defender-locked ~/.claude — and the hook must survive it, because losing this
  // file costs exactly one cache miss and must cost nothing else.
  const blocked = path.join(dir, 'blocked-home');
  fs.mkdirSync(blocked);
  fs.writeFileSync(path.join(blocked, '.claude'), 'not a directory');
  assert.equal(writeFixedPoint(key, { home: blocked }), false);

  // A directory sitting where the file goes: the parent creation succeeds and
  // writeFileSync is the thing that throws (EISDIR), which is a separate branch
  // from the one above.
  const occupied = path.join(dir, 'occupied-home');
  const file = cachePath({ home: occupied });
  fs.mkdirSync(file, { recursive: true });
  assert.equal(writeFixedPoint(key, { home: occupied }), false);
  assert.equal(isFixedPoint(CONTENT, { home: occupied }), false);
});

test('the module source requires nothing but fs, os and path', () => {
  const source = fs.readFileSync(MODULE, 'utf8');
  const required = [...source.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)]
    .map((match) => match[1]);

  // The hook's whole latency budget rests on the lazy-require discipline at
  // bin/wildcard-perms:11-26, and this module is consulted on the hot path before
  // anything else loads — so it is the one file where a new top-level require
  // cannot be traded for convenience. Note the ban covers the comments too: the
  // prose above deliberately writes "a crypto load" rather than the call, because
  // this scan does not strip comments and an earlier test in this repo
  // (installers.test.js) failed twice on its own explanatory text.
  assert.deepEqual([...new Set(required)].sort(), ['fs', 'os', 'path']);
});

test('requiring the module does not load crypto in a fresh process', () => {
  // Measured cold in a fresh process: loading crypto plus the first createHash plus
  // a digest is 4.15 ms (min 3.758 over 21 runs), because the lazy OpenSSL init
  // happens after the module snapshot and so is paid once per process — once per
  // hook call. The cache saves ~12 ms, so a hash from the standard library would
  // spend a third of the win on the check itself. That is why the hash is
  // hand-rolled, and this is the guard that keeps it that way even if someone
  // "simplifies" it through a transitive require rather than a direct one.
  //
  // The source scan above cannot see a transitive load; the module load list can.
  // Diffed before/after so only what THIS require pulled in is attributed to it —
  // a future Node that loads crypto during bootstrap must not fail this test, and
  // must not hide a regression either.
  const probe = `
    const before = new Set(process.moduleLoadList);
    const mod = require(${JSON.stringify(MODULE)});
    process.stdout.write(JSON.stringify({
      added: process.moduleLoadList.filter((entry) => !before.has(entry)),
      api: typeof mod.fnv1a32,
    }));
  `;
  const result = spawnSync(process.execPath, ['-e', probe], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);

  const report = JSON.parse(result.stdout);
  assert.equal(report.api, 'function', 'the probe really did load the module');
  assert.deepEqual(report.added.filter((entry) => /crypto/i.test(entry)), [],
    `requiring the module loaded: ${report.added.join(', ')}`);
});
