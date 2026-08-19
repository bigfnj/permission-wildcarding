'use strict';

// An end-to-end pass over transcripts shaped like the ones a real session
// writes. The unit tests all fed the learner tidy single commands, so nothing
// caught a scan that died on the first bare env assignment it met. This drives
// the whole path -- files on disk, adapters, extractor, manager, state -- with
// the awkward shapes that actually appear in a working day.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAutoLearnManager } = require('../src/auto-learn-manager');

function jsonl(...records) {
  return `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;
}

function call(id, name, command) {
  return { type: 'tool_use', id, name, input: { command } };
}

function assistant(...content) {
  return { type: 'assistant', message: { role: 'assistant', content } };
}

function results(...pairs) {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: pairs.map(([id, isError]) => ({
        type: 'tool_result', tool_use_id: id, is_error: Boolean(isError), content: 'output',
      })),
    },
  };
}

const HEREDOC = [
  "cat > /tmp/report.py <<'PY'",
  'import os',
  'def main():',
  '    print("done")',
  'PY',
  'python /tmp/report.py',
].join('\n');

const COMMIT = [
  'git add -A && git commit -m "$(cat <<\'EOF\'',
  'fix(thing): stop forcing the value',
  '',
  'It said "always do this" -- a hard rule we should relax to achieve',
  'something that actually works.',
  'EOF',
  ')"',
].join('\n');

const SCRIPTED = [
  "cd /d/project",
  'before=$(wc -l < src/app.cs)',
  "sed -i '5,9d' src/app.cs",
  'after=$(wc -l < src/app.cs)',
  'echo "lines: $before -> $after"',
].join('\n');

function corpus(root) {
  const claude = path.join(root, 'projects', 'workspace');
  fs.mkdirSync(claude, { recursive: true });
  fs.writeFileSync(path.join(claude, 'session.jsonl'), jsonl(
    { type: 'session_meta', payload: { id: 'session-one' }, cwd: root },
    assistant(
      // The shapes that used to end the scan before it could save anything.
      call('env-only', 'Bash', 'TB="C:/tools/bin"'),
      call('operator-only', 'Bash', '&&'),
      call('comment-only', 'Bash', '# regenerate the fixtures'),
      call('call-operator', 'PowerShell', '&'),
      // Script bodies that used to become command roots.
      call('heredoc', 'Bash', HEREDOC),
      call('commit', 'Bash', COMMIT),
      call('scripted', 'Bash', SCRIPTED),
      // Ordinary evidence, including a chain and a pipeline.
      call('solo', 'Bash', 'git status'),
      call('chain', 'Bash', 'git ls-files && git status'),
      call('pipeline', 'Bash', 'docker ps | rg wildcarding'),
      call('sequence', 'Bash', 'git status; false; pwd'),
      call('failure', 'Bash', 'git status'),
      call('pending', 'Bash', 'curl https://example.invalid/secret'),
      call('powershell', 'PowerShell', "Get-ChildItem 'C:/Program Files'"),
    ),
    results(['env-only'], ['operator-only'], ['comment-only'], ['call-operator'],
      ['heredoc'], ['commit'], ['scripted'], ['solo'], ['chain'], ['pipeline'],
      ['sequence'], ['failure', true], ['powershell']),
  ));
  return { claudeRoots: [path.join(root, 'projects')], codexRoots: [] };
}

function tempHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'permission-wildcarding-corpus-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

test('a scan over realistic transcripts completes and keeps only real commands', (t) => {
  const home = tempHome(t);
  const roots = corpus(home);
  const learn = createAutoLearnManager({
    home, mode: 'recommend', threshold: 2, codexRulesPath: null, ...roots,
  });

  const result = learn.scan();
  assert.ok(result.scannedAt, 'the scan finished and recorded a timestamp');
  assert.equal(result.files, 1);
  assert.ok(fs.existsSync(learn.paths.state), 'state is persisted, so progress survives');

  const keys = learn.listCandidates().map((item) => item.key);

  // Commands whose outcome the transcript actually proves are learned.
  for (const key of ['bash:git status', 'bash:python', 'bash:echo', 'bash:git add',
    'bash:git commit', 'bash:git ls-files', 'bash:rg', 'bash:pwd', 'powershell:get-childitem']) {
    assert.ok(keys.includes(key), `expected to learn ${key}`);
  }

  // A command whose outcome cannot be attributed earns no family at all, so an
  // uncredited pipeline stage or mid-chain step never pads the review list.
  for (const key of ['bash:cat', 'bash:sed', 'bash:cd', 'bash:docker ps', 'bash:false']) {
    assert.ok(!keys.includes(key), `${key} has no proven outcome yet`);
  }

  // Script bodies, prose and shell punctuation never become command families.
  for (const key of ['bash:import', 'bash:def', 'bash:print("done")', 'bash:py',
    'bash:achieve', 'bash:something', 'bash:it', 'bash:eof', 'bash:-l', 'bash:&&']) {
    assert.ok(!keys.includes(key), `${key} is not a command`);
  }
  assert.ok(!keys.some((key) => /[=$()|]/.test(key)), `malformed roots remain: ${keys}`);
});

test('a scan credits outcomes only where the transcript proves them', (t) => {
  const home = tempHome(t);
  const roots = corpus(home);
  const learn = createAutoLearnManager({
    home, mode: 'recommend', threshold: 2, codexRulesPath: null, ...roots,
  });
  learn.scan();
  const byKey = Object.fromEntries(learn.listCandidates().map((item) => [item.key, item]));

  // `git status` ran solo twice, once reported failed, so the failure sticks and
  // blocks automatic application however many successes accumulate.
  assert.equal(byKey['bash:git status'].counts.failed, 1);
  assert.equal(byKey['bash:git status'].autoSafe, false);

  // Both links of an && chain that returned success are proven to have run.
  assert.equal(byKey['bash:git ls-files'].counts.success, 1);
  assert.equal(byKey['bash:git add'].counts.success, 1);

  // A pipeline reports its last stage only, and a ; chain likewise.
  assert.equal(byKey['bash:rg'].counts.success, 1);
  assert.equal(byKey['bash:pwd'].counts.success, 1);
  assert.equal(byKey['bash:echo'].counts.success, 1);

  // `false` cannot succeed, so it must never inherit a neighbour's exit code.
  assert.ok(!byKey['bash:false'], 'no family is built from an unattributable run');
  assert.ok(!byKey['bash:docker ps'], 'the uncredited stage of a pipeline stays out');

  // An unanswered call is not evidence at any point.
  assert.ok(!byKey['bash:curl'], 'a pending call creates no family');
});

test('rescanning an unchanged corpus adds no evidence', (t) => {
  const home = tempHome(t);
  const roots = corpus(home);
  const learn = createAutoLearnManager({
    home, mode: 'recommend', threshold: 2, codexRulesPath: null, ...roots,
  });
  const first = learn.scan();
  const before = learn.listCandidates().map((item) => `${item.key}:${item.counts.success}`);
  const second = learn.scan();
  const after = learn.listCandidates().map((item) => `${item.key}:${item.counts.success}`);

  assert.ok(first.newObservations > 0);
  assert.equal(second.newObservations, 0, 'cursors and hashes stop a re-read counting twice');
  assert.deepEqual(after, before);
});
