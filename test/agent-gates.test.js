'use strict';

// The gates block shares its file plumbing with the shell-style block but not its
// markers, and that separation is the whole contract. Two managed blocks live in one
// instruction file, so the tests that matter are: removing one leaves the other byte for
// byte, a corpus edit is detected as stale with no version to bump, and a missing compile
// refuses to install rather than fencing off nothing and reporting success.

const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { BEGIN, applyGuidance, setGuidance } = require('../src/agent-guidance');
const {
  GATES_BEGIN, GATES_END, makeGatesBlock, compiledPath, readCompiled, setGatesAll,
} = require('../src/agent-gates');

const USER_TEXT = '# My global instructions\n\nAlways use the toolbox python.\n';
const COMPILED = '## Standing gates (1 memories, managed)\n\n- **File edits.** Apply directly.';

// A fake home whose .claude/ holds a compiled gates file, so nothing touches the real one.
// Every scratch root this file creates, torn down once at the end. These three
// helpers are module-level and take no `t`, so a per-test t.after() would mean
// threading the context through every call site; one `after` hook over a registry
// is the smaller change. Measured before this: the suite left 3 directories in
// %TEMP% per run, and 798 had accumulated.
const scratchRoots = [];
after(() => {
  for (const root of scratchRoots) {
    // maxRetries because a Windows handle can still be closing when we get here.
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
    catch { /* a leaked temp dir must never fail the suite */ }
  }
});

function fakeHome(compiled = COMPILED) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-gates-'));
  scratchRoots.push(root);
  fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
  if (compiled !== null) fs.writeFileSync(compiledPath(root), `${compiled}\n`, 'utf8');
  return root;
}

test('an absent compile reads empty, a present one reads trimmed', () => {
  assert.equal(readCompiled(fakeHome(null)), '');
  assert.equal(readCompiled(fakeHome()), COMPILED);
});

test('off is a byte-for-byte round trip of the user file', () => {
  // Block bound to the fake home, so the assertion cannot pass on the strength of this
  // machine happening to have a real compiled file.
  const block = makeGatesBlock(fakeHome());
  const on = block.apply(USER_TEXT, true);
  assert.equal(on.changed, true);
  assert.ok(on.text.startsWith(USER_TEXT), 'user text keeps its position at the top');
  assert.ok(on.text.includes(COMPILED), 'the compiled body is what got installed');
  assert.ok(block.has(on.text));

  const off = block.apply(on.text, false);
  assert.equal(off.changed, true);
  assert.equal(off.text, USER_TEXT, 'the file the user had, exactly');
});

test('a recompiled corpus reads as stale, and refreshes without duplicating', () => {
  // Same markers, different body: exactly what happens after editing a gate in a memory
  // file and recompiling. No version number is involved, which is the point.
  const block = makeGatesBlock(fakeHome());
  const stale = `${USER_TEXT}\n${GATES_BEGIN}\n## Standing gates (0 memories, managed)\n${GATES_END}\n`;
  assert.equal(block.has(stale), true);
  assert.equal(block.isCurrent(stale), false);

  const refreshed = block.apply(stale, true);
  assert.equal(refreshed.changed, true);
  assert.equal(refreshed.text.split(GATES_BEGIN).length - 1, 1, 'exactly one gates block');
  assert.ok(block.isCurrent(refreshed.text));
});

test('the two managed blocks coexist, and removing one leaves the other untouched', () => {
  // The reason the markers differ. A shared pair would make either "off" tear out both.
  const block = makeGatesBlock(fakeHome());
  const withShell = applyGuidance(USER_TEXT, true).text;
  const withBoth = block.apply(withShell, true).text;
  assert.ok(withBoth.includes(BEGIN), 'shell block survived the gates install');
  assert.ok(withBoth.includes(GATES_BEGIN));

  const gatesGone = block.apply(withBoth, false);
  assert.equal(gatesGone.changed, true);
  assert.equal(gatesGone.text, withShell, 'shell block is byte-identical after gates off');
  assert.ok(!gatesGone.text.includes(GATES_BEGIN));

  const shellGone = applyGuidance(withBoth, false);
  assert.ok(shellGone.text.includes(GATES_BEGIN), 'gates survived a guidance off');
  assert.ok(!shellGone.text.includes(BEGIN));
});

test('a compiled file with no gates in it is treated as nothing compiled', () => {
  // The shape a zero-gate compile produces. If the guard only checked for a MISSING file,
  // this would install a heading with no rules under it and report gates ON.
  for (const empty of ['', '\n', '   \n\n']) {
    const home = fakeHome(empty);
    fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
    assert.equal(readCompiled(home), '', `"${empty}" must read as nothing compiled`);
    const results = setGatesAll(true, { home, backupDir: path.join(home, 'backups') });
    assert.equal(results[0].changed, false);
    assert.match(results[0].error, /--gates-compile/);
  }
});

test('installing with nothing compiled refuses instead of fencing off nothing', () => {
  const home = fakeHome(null);
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  const results = setGatesAll(true, { home, backupDir: path.join(home, 'backups') });
  assert.equal(results.length, 1);
  assert.equal(results[0].changed, false);
  assert.equal(results[0].on, false);
  assert.match(results[0].error, /--gates-compile/);
  assert.ok(!fs.existsSync(path.join(home, '.claude', 'CLAUDE.md')),
    'a refused install writes no instruction file at all');
});

test('the gates backup name cannot collide with the guidance one', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-gates-bk-'));
  scratchRoots.push(root);
  const file = path.join(root, 'CLAUDE.md');
  const backupDir = path.join(root, 'backups');
  fs.writeFileSync(file, USER_TEXT, 'utf8');

  setGuidance(true, { file, backupDir });
  setGuidance(true, {
    file, backupDir, backupName: 'CLAUDE.md.pre-gates', block: makeGatesBlock(fakeHome()),
  });

  const saved = fs.readdirSync(backupDir).sort();
  assert.deepEqual(saved, ['CLAUDE.md.pre-gates', 'CLAUDE.md.pre-guidance']);
  // The guidance backup holds the original; the gates backup holds it *with* guidance,
  // so neither block's pre-change copy is lost to the other.
  assert.equal(fs.readFileSync(path.join(backupDir, 'CLAUDE.md.pre-guidance'), 'utf8'), USER_TEXT);
  assert.ok(fs.readFileSync(path.join(backupDir, 'CLAUDE.md.pre-gates'), 'utf8').includes(BEGIN));
});
