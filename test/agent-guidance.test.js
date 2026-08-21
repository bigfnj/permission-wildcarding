'use strict';

// The guidance block is written into the user's own instruction file, so the
// contract is narrow and absolute: it is fenced by markers, an unchanged block
// produces no write at all (this runs on every activation), a stale block is
// replaced rather than duplicated, and turning it off restores the file the user
// had byte for byte.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  BEGIN, END, guidanceBlock, hasGuidance, isCurrent, applyGuidance, guidanceStatus, setGuidance,
  guidanceTargets, installedGuidanceTargets, guidanceStatusAll, setGuidanceAll,
} = require('../src/agent-guidance');

const USER_TEXT = '# My global instructions\n\nAlways use the toolbox python.\n';

function scratch() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-guidance-'));
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
