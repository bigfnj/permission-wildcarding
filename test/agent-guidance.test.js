'use strict';

// The guidance block is written into the user's own instruction file, so the
// contract is narrow and absolute: it is fenced by markers, an unchanged block
// produces no write at all (this runs on every activation), a stale block is
// replaced rather than duplicated, and turning it off restores the file the user
// had byte for byte.

const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  BEGIN, END, guidanceBlock, hasGuidance, isCurrent, applyGuidance, guidanceStatus, setGuidance,
  guidanceTargets, installedGuidanceTargets, guidanceStatusAll, setGuidanceAll,
  createManagedBlock, escapeMarker,
} = require('../src/agent-guidance');

const USER_TEXT = '# My global instructions\n\nAlways use the toolbox python.\n';

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

function scratch() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-guidance-'));
  scratchRoots.push(root);
  return { root, file: path.join(root, 'CLAUDE.md'), backupDir: path.join(root, 'backups') };
}

test('the block is appended below the user text, and only once', () => {
  const first = applyGuidance(USER_TEXT, true);
  assert.equal(first.changed, true);
  assert.ok(first.text.startsWith(USER_TEXT), 'user text keeps its position at the top');
  assert.ok(hasGuidance(first.text));
  assert.ok(isCurrent(first.text));

  const again = applyGuidance(first.text, true);
  assert.equal(again.changed, false, 'an unchanged block must not produce a write');
  assert.equal(again.text, first.text);
  assert.equal(first.text.split(BEGIN).length - 1, 1, 'exactly one block');
});

test('a block from an older version is replaced, not duplicated', () => {
  const stale = `${USER_TEXT}\n${BEGIN}\n## Old wording that shipped in 1.0\n${END}\n`;
  assert.equal(hasGuidance(stale), true);
  assert.equal(isCurrent(stale), false);

  const refreshed = applyGuidance(stale, true);
  assert.equal(refreshed.changed, true);
  assert.equal(refreshed.text.split(BEGIN).length - 1, 1);
  assert.equal(isCurrent(refreshed.text), true);
  assert.ok(!refreshed.text.includes('Old wording'));
  assert.ok(refreshed.text.startsWith(USER_TEXT));
});

test('off is a byte-for-byte round trip of the user file', () => {
  const on = applyGuidance(USER_TEXT, true);
  const off = applyGuidance(on.text, false);
  assert.equal(off.changed, true);
  assert.equal(off.text, USER_TEXT);
  // Idempotent in that direction too.
  assert.equal(applyGuidance(off.text, false).changed, false);
});

test('an empty or absent file gets just the block', () => {
  const created = applyGuidance('', true);
  assert.equal(created.text, guidanceBlock());
  assert.equal(applyGuidance(created.text, false).text, '');
});

test('the block names the rules the generalizer cannot recover after the fact', () => {
  const block = guidanceBlock();
  assert.ok(block.startsWith(BEGIN));
  assert.ok(block.trimEnd().endsWith(END));
  for (const needle of ['One command per tool call', 'git -C', 'bare name', 'script']) {
    assert.ok(block.includes(needle), needle);
  }
  // Both agents are hurt by the same habit for different reasons, and the block
  // has to say why, or a Codex user reads it as someone else's rule.
  assert.ok(block.includes('argv prefix'), 'names the Codex mechanism');
  // It is loaded into every session, so it stays inside a MEMORY.md-sized budget.
  assert.ok(block.length < 2200, `block is ${block.length} bytes`);
});

test('a target is only written for an agent that is installed', (t) => {
  const box = scratch();
  const home = box.root;
  assert.deepEqual(guidanceTargets(home).map((target) => target.agent), ['claude', 'codex']);

  // A bare home has neither agent, so there is nothing to write to.
  assert.deepEqual(installedGuidanceTargets(home), []);
  assert.deepEqual(setGuidanceAll(true, { home, backupDir: box.backupDir }), []);

  // Claude only: ~/.codex is never conjured on a machine that has no Codex.
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  assert.deepEqual(installedGuidanceTargets(home).map((target) => target.agent), ['claude']);
  const claudeOnly = setGuidanceAll(true, { home, backupDir: box.backupDir });
  assert.deepEqual(claudeOnly.map((result) => result.agent), ['claude']);
  assert.equal(fs.existsSync(path.join(home, '.codex')), false);

  // Once Codex is present it gets the same block, and its own backup file.
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(home, '.codex', 'AGENTS.md'), '# Codex notes\n', 'utf8');
  const both = setGuidanceAll(true, { home, backupDir: box.backupDir });
  assert.deepEqual(both.map((result) => result.agent), ['claude', 'codex']);
  assert.equal(both[0].changed, false, 'Claude was already current');
  assert.equal(both[1].changed, true);
  assert.ok(hasGuidance(fs.readFileSync(path.join(home, '.codex', 'AGENTS.md'), 'utf8')));
  // Codex had content, so it was copied aside under its own name — the two files
  // must never share one backup slot. Claude's was created from nothing, so there
  // was nothing to preserve.
  assert.equal(
    fs.readFileSync(path.join(box.backupDir, 'AGENTS.md.pre-guidance'), 'utf8'),
    '# Codex notes\n'
  );
  assert.equal(fs.existsSync(path.join(box.backupDir, 'CLAUDE.md.pre-guidance')), false);

  const states = guidanceStatusAll(home);
  assert.deepEqual(states.map((state) => [state.agent, state.on, state.current]), [
    ['claude', true, true],
    ['codex', true, true],
  ]);

  // And off clears both, leaving each file as its owner had it.
  setGuidanceAll(false, { home, backupDir: box.backupDir });
  assert.equal(fs.readFileSync(path.join(home, '.codex', 'AGENTS.md'), 'utf8'), '# Codex notes\n');
  assert.deepEqual(guidanceStatusAll(home).map((state) => state.on), [false, false]);
});

test('setGuidance writes the file, backs up what was there, and reports state', () => {
  const box = scratch();
  fs.writeFileSync(box.file, USER_TEXT, 'utf8');

  assert.deepEqual(guidanceStatus(box.file), {
    path: box.file, readable: true, on: false, current: false,
  });

  const on = setGuidance(true, { file: box.file, backupDir: box.backupDir });
  assert.equal(on.changed, true);
  assert.equal(on.error, null);
  assert.ok(hasGuidance(fs.readFileSync(box.file, 'utf8')));
  assert.equal(fs.readFileSync(path.join(box.backupDir, 'CLAUDE.md.pre-guidance'), 'utf8'), USER_TEXT);

  const status = guidanceStatus(box.file);
  assert.equal(status.on, true);
  assert.equal(status.current, true);

  assert.equal(setGuidance(true, { file: box.file, backupDir: box.backupDir }).changed, false);

  const off = setGuidance(false, { file: box.file, backupDir: box.backupDir });
  assert.equal(off.changed, true);
  assert.equal(fs.readFileSync(box.file, 'utf8'), USER_TEXT);
});

test('a missing CLAUDE.md is created rather than treated as an error', () => {
  const box = scratch();
  const result = setGuidance(true, { file: box.file, backupDir: box.backupDir });
  assert.equal(result.changed, true);
  assert.equal(result.error, null);
  assert.equal(fs.readFileSync(box.file, 'utf8'), guidanceBlock());
  // Nothing to back up when there was no file.
  assert.equal(fs.existsSync(box.backupDir), false);
});

// ── Removal arithmetic ────────────────────────────────────────────────────────
// Both newline sweeps used to eat EVERY adjacent newline and only the
// end-of-file case put one back, so a block with the user's own text above AND
// below it fused two of their lines into one. It read as harmless because the
// block this repo installs lands at line 1 on the author's machine, where the
// leading sweep is a no-op; any content above the block arms it.

const count = (text, needle) => text.split(needle).length - 1;

// A stand-in for the gates block: same plumbing, its own marker pair. Used
// rather than agent-gates so these assertions do not depend on a compiled
// corpus existing anywhere.
const SECOND = createManagedBlock({
  begin: '<!-- BEGIN permission-wildcarding: second block (managed) -->',
  end: '<!-- END permission-wildcarding: second block -->',
  body: () => '## A second managed block\n\nInstalled below the first one.',
});

test('removal keeps exactly one separator wherever the block sits', () => {
  // Mid-file, the measured failure: "my own notesmore of my notes\n".
  const middle = `my own notes\n\n${BEGIN}\nMANAGED\n${END}\n\nmore of my notes\n`;
  assert.equal(applyGuidance(middle, false).text, 'my own notes\n\nmore of my notes\n');

  // Single-newline separation stays single: a blank line the user did not have
  // must not be invented either.
  const tight = `top\n${BEGIN}\nMANAGED\n${END}\nbottom\n`;
  assert.equal(applyGuidance(tight, false).text, 'top\nbottom\n');

  // Start of file: nothing above to separate from, so the run below the block
  // was all the block's own and the file must not open with a blank line.
  const first = `${BEGIN}\nMANAGED\n${END}\n\nmy own notes\n`;
  assert.equal(applyGuidance(first, false).text, 'my own notes\n');
  assert.equal(applyGuidance(`${BEGIN}\nMANAGED\n${END}\n`, false).text, '');

  // End of file: a text file keeps its final newline, and exactly one.
  const last = `my own notes\n\n${BEGIN}\nMANAGED\n${END}\n`;
  assert.equal(applyGuidance(last, false).text, 'my own notes\n');

  // No block, no write.
  assert.deepEqual(applyGuidance('my own notes\n', false),
    { changed: false, text: 'my own notes\n' });
});

test('off with a second managed block below it leaves that block on its own line', () => {
  // `--guidance off` while the gates or a derived block is installed is a
  // documented, supported combination, and it produced
  // "user preamble<!-- BEGIN ...": the removal ate the blank line AND the
  // newline that ended the user's own last line, so the surviving block's begin
  // marker was appended mid-line, where it is no longer a marker at all.
  const preamble = '# my own instructions\n\nAlways use the toolbox python.\n';
  const withShell = applyGuidance(preamble, true).text;
  const withBoth = SECOND.apply(withShell, true).text;
  assert.ok(withBoth.startsWith(preamble));

  const shellGone = applyGuidance(withBoth, false);
  assert.equal(shellGone.changed, true);
  assert.equal(hasGuidance(shellGone.text), false);
  assert.ok(SECOND.has(shellGone.text));
  // Byte-identical to having installed only the second block: removing the
  // first is a true round trip even with a managed block adjacent to it.
  assert.equal(shellGone.text, SECOND.apply(preamble, true).text);
  assert.ok(shellGone.text.startsWith(`${preamble}\n<!-- BEGIN permission-wildcarding: second block`));
  // And the survivor comes off leaving the user's own file, byte for byte.
  assert.equal(SECOND.apply(shellGone.text, false).text, preamble);
  // Removing the LAST of the two is the end-of-file case, and restores the
  // file as it stood with only the first block installed.
  assert.equal(SECOND.apply(withBoth, false).text, withShell);
});

test('a body that quotes the markers cannot truncate its own block', () => {
  // The gates body is compiled from the user's memory corpus and a derived body
  // embeds managed rule text, so a body documenting this very feature quotes the
  // markers. `blockRange` took the FIRST end marker after begin, so the range
  // stopped inside the body: a rewrite replaced only the truncated range and
  // left the rest of the old body plus an orphaned end marker behind, and since
  // the reinstalled body carried that inner marker again, every pass appended
  // another copy. `off` removed only as far as the first inner marker, which
  // made the junk permanent.
  const hostile = `## Gate: managed blocks\n\n- The fence is ${BEGIN} ... ${END} and nothing else.`;
  const block = createManagedBlock({ begin: BEGIN, end: END, body: () => hostile });

  const on = block.apply(USER_TEXT, true);
  assert.equal(on.changed, true);
  assert.equal(count(on.text, BEGIN), 1, 'exactly one begin marker survives the body');
  assert.equal(count(on.text, END), 1, 'and exactly one end marker');
  // Neutralised, not dropped: refusing the block would cost a user whose memory
  // documents this feature all of their gates, so the text stays readable.
  assert.ok(on.text.includes(escapeMarker(BEGIN)), 'the quoted begin marker is still legible');
  assert.ok(on.text.includes(escapeMarker(END)));
  assert.ok(block.isCurrent(on.text));

  // The accumulation: every later pass used to append another body tail.
  const second = block.apply(on.text, true);
  assert.equal(second.changed, false, 'a marker-carrying body must still settle');
  assert.equal(block.apply(second.text, true).text, on.text);
  assert.equal(count(on.text, END), 1);

  // And it is removable, which the truncated range made impossible.
  assert.equal(block.apply(on.text, false).text, USER_TEXT);
});
