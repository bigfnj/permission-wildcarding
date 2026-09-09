'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  parseClaudeJsonl,
  parseCodexJsonl,
  extractNestedShellCommands,
  cursorKeyForFile,
  scanHistoryFiles,
} = require('../src/history-adapters');

function jsonl(...records) {
  return `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;
}

function byCallId(observations, callId) {
  return observations.find((observation) => observation.callId === callId);
}

function responseItem(payload) {
  return { type: 'response_item', payload };
}

test('Claude parsing correlates tool results, failures, and out-of-order results', () => {
  const transcript = jsonl(
    { type: 'session_meta', payload: { id: 'claude-session' }, cwd: 'D:\\work' },
    {
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'result-first', content: 'done' }],
      },
    },
    {
      type: 'assistant',
      timestamp: '2026-08-15T01:00:00Z',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Checking.' },
          { type: 'tool_use', id: 'ok-call', name: 'Bash', input: { command: 'git status --short' } },
          { type: 'tool_use', id: 'failed-call', name: 'PowerShell', input: { command: 'Get-Item missing' } },
          { type: 'tool_use', id: 'unknown-call', name: 'Bash', input: { command: 'pwd' } },
          { type: 'tool_use', id: 'result-first', name: 'Bash', input: { command: 'rg TODO' } },
          { type: 'tool_use', id: 'ignored-call', name: 'Read', input: { file_path: 'README.md' } },
          { type: 'tool_use', id: 'unlearnable-call', name: 'TodoWrite', input: { todos: [] } },
        ],
      },
    },
    {
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'ok-call', is_error: false, content: 'clean' }],
      },
    },
    {
      type: 'user',
      toolUseResult: { exitCode: 7 },
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'failed-call', content: 'not found' }],
      },
    },
  );

  const observations = parseClaudeJsonl(transcript, {
    file: 'D:\\history\\claude.jsonl',
  });

  // File, web and MCP tools are learned too, so the shell calls are a subset.
  const shell = observations.filter((item) => item.kind !== 'tool');
  assert.equal(shell.length, 4);
  assert.deepEqual(shell.map(({ command }) => command), [
    'git status --short',
    'Get-Item missing',
    'pwd',
    'rg TODO',
  ]);
  assert.equal(byCallId(observations, 'ok-call').status, 'success');
  assert.equal(byCallId(observations, 'failed-call').status, 'failed');
  assert.equal(byCallId(observations, 'unknown-call').status, 'unknown');
  assert.equal(byCallId(observations, 'result-first').status, 'success');
  assert.equal(byCallId(observations, 'ok-call').session, 'claude-session');
  assert.equal(byCallId(observations, 'ok-call').cwd, 'D:\\work');

  // A file tool is recorded as a family with no path in it, and a tool with no
  // policy family of its own is still ignored.
  const tools = observations.filter((item) => item.kind === 'tool');
  assert.deepEqual(tools.map((item) => item.tool), ['Read']);
  assert.equal(tools[0].command, 'file');
  assert.doesNotMatch(JSON.stringify(observations), /README/);
});

test('Claude direct toolUseResult correlation honors structured failures', () => {
  const transcript = jsonl(
    {
      type: 'assistant',
      sessionId: 'direct-result-session',
      message: {
        role: 'assistant',
        content: [{
          type: 'tool_use', id: 'direct-fail', name: 'PowerShell',
          input: { command: 'Get-Content missing.txt' },
        }],
      },
    },
    {
      type: 'user',
      tool_use_id: 'direct-fail',
      toolUseResult: { success: false, exitCode: 1 },
      message: { role: 'user', content: [] },
    },
  );

  const [observation] = parseClaudeJsonl(transcript, { file: 'claude-direct.jsonl' });
  assert.equal(observation.status, 'failed');
});

test('Codex parsing correlates function calls and outputs without blessing unanswered calls', () => {
  const transcript = jsonl(
    { type: 'session_meta', payload: { id: 'codex-session', cwd: 'D:\\repo' } },
    responseItem({
      type: 'function_call_output', call_id: 'result-first',
      output: { exit_code: 0, output: 'found' },
    }),
    responseItem({
      type: 'function_call', name: 'shell_command', call_id: 'ok-call',
      arguments: JSON.stringify({ command: 'git diff --stat', workdir: 'D:\\repo\\child' }),
    }),
    responseItem({
      type: 'function_call', name: 'functions.shell_command', call_id: 'failed-call',
      arguments: JSON.stringify({ command: 'rg missing .' }),
    }),
    responseItem({
      type: 'function_call', name: 'shell_command', call_id: 'unknown-call',
      arguments: JSON.stringify({ command: 'git status' }),
    }),
    responseItem({
      type: 'function_call', name: 'shell_command', call_id: 'result-first',
      arguments: JSON.stringify({ command: 'fd package.json' }),
    }),
    responseItem({
      type: 'function_call', name: 'read_file', call_id: 'ignored-call',
      arguments: JSON.stringify({ command: 'never observed' }),
    }),
    responseItem({
      type: 'function_call_output', call_id: 'ok-call',
      output: 'Process exited with code 0\nFinal output:\n clean',
    }),
    responseItem({
      type: 'function_call_output', call_id: 'failed-call',
      output: { exitCode: 2, stderr: 'no matches' },
    }),
  );

  const observations = parseCodexJsonl(transcript, {
    file: 'D:\\history\\codex.jsonl',
    platform: 'win32',
  });

  assert.equal(observations.length, 4);
  assert.equal(byCallId(observations, 'ok-call').status, 'success');
  assert.equal(byCallId(observations, 'failed-call').status, 'failed');
  assert.equal(byCallId(observations, 'unknown-call').status, 'unknown');
  assert.equal(byCallId(observations, 'result-first').status, 'success');
  assert.equal(byCallId(observations, 'ok-call').cwd, 'D:\\repo\\child');
  assert.equal(byCallId(observations, 'ok-call').session, 'codex-session');
  assert.ok(observations.every(({ tool }) => tool === 'PowerShell'));
});

test('nested exec extraction accepts only literal tools.shell_command calls', () => {
  const source = [
    'const decoy = "tools.shell_command({ command: \\\"never\\\" })";',
    '// tools.shell_command({ command: "also never" });',
    'const first = await tools.shell_command({ workdir: "D:/repo", command: "git status --short" });',
    "const second = await tools.shell_command({ 'command': 'rg TODO src', timeout_ms: 1000 });",
    'const dynamic = await tools.shell_command({ command: suppliedCommand });',
    'const computed = await tools["shell_command"]({ command: "not accepted" });',
  ].join('\n');

  assert.deepEqual(extractNestedShellCommands(source), [
    'git status --short',
    'rg TODO src',
  ]);
});

test('Codex custom exec outcomes are conservatively attributed to nested calls', () => {
  const input = [
    'const a = await tools.shell_command({command: "git status"});',
    'const b = await tools.shell_command({command: "rg TODO"});',
  ].join('\n');
  const transcript = jsonl(
    responseItem({ type: 'custom_tool_call_output', call_id: 'exec-first', output: 'Exit code: 0' }),
    responseItem({ type: 'custom_tool_call', name: 'exec', call_id: 'exec-first', input }),
    responseItem({
      type: 'custom_tool_call', name: 'functions.exec', call_id: 'exec-failed',
      input: [
        'await tools.shell_command({ command: "npm test" });',
        'await tools.shell_command({ command: "node bad-script.js" });',
      ].join('\n'),
    }),
    responseItem({
      type: 'custom_tool_call_output', call_id: 'exec-failed',
      output: 'Script completed\nExit code: 1',
    }),
    responseItem({
      type: 'custom_tool_call', name: 'exec', call_id: 'exec-unknown',
      input: 'await tools.shell_command({ command: "node --version" })',
    }),
    responseItem({
      type: 'custom_tool_call', name: 'exec', call_id: 'exec-single',
      input: 'await tools.shell_command({ command: "pwd" })',
    }),
    responseItem({
      type: 'custom_tool_call_output',
      call_id: 'exec-single',
      output: [
        { type: 'input_text', text: 'Script completed\nWall time: 1.2 seconds' },
        { type: 'input_text', text: 'Output:\nExit code: 0\nWall time: 1.1 seconds' },
      ],
    }),
    responseItem({
      type: 'custom_tool_call', name: 'exec', call_id: 'exec-conditional',
      input: 'if (false) await tools.shell_command({ command: \'git branch --show-current\' });',
    }),
    responseItem({ type: 'custom_tool_call_output', call_id: 'exec-conditional', output: 'Exit code: 0' }),
    responseItem({
      type: 'custom_tool_call', name: 'exec', call_id: 'exec-caught',
      input: 'try { await tools.shell_command({ command: \'git rev-parse --is-inside-work-tree\' }); } catch {}',
    }),
    responseItem({ type: 'custom_tool_call_output', call_id: 'exec-caught', output: 'Exit code: 0' }),
    responseItem({
      type: 'custom_tool_call', name: 'exec', call_id: 'exec-after-exit',
      input: 'exit(); await tools.shell_command({ command: \'rg --files\' });',
    }),
    responseItem({ type: 'custom_tool_call_output', call_id: 'exec-after-exit', output: 'Exit code: 0' }),
  );

  const observations = parseCodexJsonl(transcript, {
    file: 'codex-exec.jsonl', platform: 'win32', session: 'codex-exec-session',
  });
  const grouped = Object.fromEntries(observations.map((item) => [item.command, item]));

  assert.deepEqual(Object.keys(grouped), [
    'git status', 'rg TODO', 'npm test', 'node bad-script.js', 'node --version', 'pwd',
    'git branch --show-current', 'git rev-parse --is-inside-work-tree', 'rg --files',
  ]);
  assert.equal(grouped['git status'].status, 'unknown');
  assert.equal(grouped['rg TODO'].status, 'unknown');
  assert.equal(grouped['npm test'].status, 'failed');
  assert.equal(grouped['node bad-script.js'].status, 'failed');
  assert.equal(grouped['node --version'].status, 'unknown');
  assert.equal(grouped.pwd.status, 'success');
  assert.equal(grouped['git branch --show-current'].status, 'unknown');
  assert.equal(grouped['git rev-parse --is-inside-work-tree'].status, 'unknown');
  assert.equal(grouped['rg --files'].status, 'unknown');
});

test('real observation IDs survive transcript moves and remain distinct per nested command', () => {
  const input = [
    'await tools.shell_command({ command: "git status" });',
    'await tools.shell_command({ command: "rg TODO" });',
  ].join('\n');
  const transcript = jsonl(responseItem({
    type: 'custom_tool_call', name: 'exec', call_id: 'stable-call', input,
  }));
  const first = parseCodexJsonl(transcript, {
    file: 'D:\\history\\stable.jsonl', session: 'stable-session', platform: 'win32',
  });
  const second = parseCodexJsonl(transcript, {
    file: 'E:\\copied-history\\renamed.jsonl', session: 'stable-session', platform: 'win32',
  });

  assert.deepEqual(first.map(({ id }) => id), second.map(({ id }) => id));
  assert.equal(new Set(first.map(({ id }) => id)).size, 2);
  assert.ok(first.every(({ id }) => /^codex:[a-f0-9]{24}$/.test(id)));

  const syntheticTranscript = jsonl(responseItem({
    type: 'function_call', name: 'shell_command', arguments: JSON.stringify({ command: 'pwd' }),
  }));
  const [syntheticA] = parseCodexJsonl(syntheticTranscript, {
    file: 'D:\\history\\synthetic.jsonl', session: 'stable-session', platform: 'win32',
  });
  const [syntheticB] = parseCodexJsonl(syntheticTranscript, {
    file: 'E:\\copied-history\\synthetic.jsonl', session: 'stable-session', platform: 'win32',
  });
  assert.notEqual(syntheticA.id, syntheticB.id);
});

test('incremental scanning replays overlap to correlate appended results with stable IDs', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wildcard-history-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'session.jsonl');
  const call = responseItem({
    type: 'function_call', name: 'shell_command', call_id: 'pending-call',
    arguments: JSON.stringify({ command: 'git status --short', workdir: root }),
  });
  fs.writeFileSync(file, jsonl(
    { type: 'session_meta', payload: { id: 'incremental-session', cwd: root } },
    call,
  ));

  const initial = scanHistoryFiles({ roots: { codex: root }, platform: 'win32', overlapBytes: 48 });
  assert.equal(initial.files[0].mode, 'full');
  assert.equal(initial.observations.length, 1);
  assert.equal(initial.observations[0].status, 'unknown');
  const initialId = initial.observations[0].id;

  const persistedCursors = JSON.parse(JSON.stringify(initial.cursors));
  const serializedCursors = JSON.stringify(persistedCursors);
  const [persistedKey] = Object.keys(persistedCursors);
  assert.equal(persistedKey, cursorKeyForFile(file));
  assert.match(persistedKey, /^path-sha256:[a-f0-9]{24}$/);
  assert.ok(!persistedKey.includes(path.basename(file)));
  assert.doesNotMatch(serializedCursors, /git status|command|arguments|call_id|pending-call/i);
  assert.deepEqual(
    Object.keys(Object.values(persistedCursors)[0]).sort(),
    ['headHash', 'headLength', 'ino', 'mtimeMs', 'offset', 'size', 'source', 'tailHash', 'tailLength', 'tailStart'].sort(),
  );

  fs.appendFileSync(file, jsonl(responseItem({
    type: 'function_call_output', call_id: 'pending-call', output: { exit_code: 0 },
  })));
  const appended = scanHistoryFiles({
    roots: { codex: root }, cursors: persistedCursors, platform: 'win32', overlapBytes: 48,
  });

  assert.equal(appended.files[0].mode, 'append');
  assert.equal(appended.observations.length, 1);
  assert.equal(appended.observations[0].id, initialId);
  assert.equal(appended.observations[0].status, 'success');

  const unchanged = scanHistoryFiles({
    roots: { codex: root }, cursors: JSON.parse(JSON.stringify(appended.cursors)), platform: 'win32',
  });
  assert.equal(unchanged.files[0].mode, 'unchanged');
  assert.deepEqual(unchanged.observations, []);

  const legacyCursor = { [file]: Object.values(appended.cursors)[0] };
  const legacyUnchanged = scanHistoryFiles({ roots: { codex: root }, cursors: legacyCursor, platform: 'win32' });
  assert.equal(legacyUnchanged.files[0].mode, 'unchanged');
  assert.match(Object.keys(legacyUnchanged.cursors)[0], /^path-sha256:[a-f0-9]{24}$/);
});

test('incremental scanning falls back to a full scan after truncation', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wildcard-history-rewrite-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'claude.jsonl');
  fs.writeFileSync(file, jsonl({
    type: 'assistant', sessionId: 'old-session',
    message: { role: 'assistant', content: [{
      type: 'tool_use', id: 'old-call', name: 'Bash', input: { command: 'git status --short --branch' },
    }] },
  }));
  const initial = scanHistoryFiles({ roots: { claude: root } });

  fs.writeFileSync(file, jsonl({
    type: 'assistant', sessionId: 'new-session',
    message: { role: 'assistant', content: [{
      type: 'tool_use', id: 'new-call', name: 'Bash', input: { command: 'pwd' },
    }] },
  }));
  const rewritten = scanHistoryFiles({ roots: { claude: root }, cursors: initial.cursors });

  assert.equal(rewritten.files[0].mode, 'full');
  assert.deepEqual(rewritten.observations.map(({ command }) => command), ['pwd']);
});

// One unreadable file used to end the whole scan. The reads sat outside the
// per-file try, so the throw escaped scanHistoryFiles, escaped scan(), and took
// save(state) with it: every other file's cursor progress was discarded and the
// extension then backed its retry off to an hour. Nothing in the suite drove a
// failing read, so the entire catch had no coverage.
test('one unreadable transcript does not cost the whole scan its progress', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wildcard-scan-fail-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const transcript = (id, command) => `${JSON.stringify({
    type: 'response_item',
    payload: { type: 'function_call', name: 'shell_command', call_id: id, arguments: JSON.stringify({ command }) },
  })}\n${JSON.stringify({
    type: 'response_item',
    payload: { type: 'function_call_output', call_id: id, output: { exit_code: 0 } },
  })}\n`;

  // Sorted by path, so `b` is read between `a` and `c` and a throw there would
  // have taken `c` down with it as well as discarding `a`.
  for (const [name, command] of [['a', 'rg alpha'], ['b', 'rg beta'], ['c', 'rg gamma']]) {
    fs.writeFileSync(path.join(root, `${name}.jsonl`), transcript(`${name}-1`, command));
  }

  // Fail exactly one file's read, at the layer that really throws on a deleted
  // or locked transcript, rather than by mangling its contents: a parse failure
  // takes a different path and would not have reproduced this.
  const realOpen = fs.openSync;
  const target = path.join(root, 'b.jsonl');
  t.after(() => { fs.openSync = realOpen; });
  fs.openSync = (file, ...rest) => {
    if (String(file) === target) {
      const error = new Error(`EBUSY: resource busy or locked, open '${file}'`);
      error.code = 'EBUSY';
      throw error;
    }
    return realOpen(file, ...rest);
  };

  const result = scanHistoryFiles({ cursors: {}, codexRoots: [root], claudeRoots: [] });
  const byMode = (mode) => result.files.filter((entry) => entry.mode === mode).map(
    (entry) => path.basename(entry.path)).sort();

  assert.deepEqual(byMode('error'), ['b.jsonl'], 'the locked file is reported, not thrown');
  assert.deepEqual(byMode('full'), ['a.jsonl', 'c.jsonl'], 'and the others were still read');
  assert.equal(Object.keys(result.cursors).length, 2,
    'two cursors survive, so the next scan does not redo the whole corpus');
  assert.deepEqual(result.observations.map((item) => item.command).sort(),
    ['rg alpha', 'rg gamma']);
  assert.match(result.files.find((entry) => entry.mode === 'error').error, /EBUSY/);

  // And the file recovers on its own once the read succeeds again, with no
  // manual intervention and no cursor invented for it in the meantime.
  fs.openSync = realOpen;
  const second = scanHistoryFiles({ cursors: result.cursors, codexRoots: [root], claudeRoots: [] });
  assert.deepEqual(second.observations.map((item) => item.command), ['rg beta'],
    'only the previously failed file is re-read');
  assert.equal(Object.keys(second.cursors).length, 3);
});

test('a rewritten file that fails to read does not keep a cursor that no longer fits', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wildcard-scan-stale-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'session.jsonl');
  const line = (id, command) => `${JSON.stringify({
    type: 'response_item',
    payload: { type: 'function_call', name: 'shell_command', call_id: id, arguments: JSON.stringify({ command }) },
  })}\n`;

  fs.writeFileSync(file, `${line('one', 'rg first')}${line('two', 'rg second')}`);
  const first = scanHistoryFiles({ cursors: {}, codexRoots: [root], claudeRoots: [] });
  const cursor = first.cursors[cursorKeyForFile(file)];
  assert.ok(cursor, 'a clean scan records a cursor');

  // Truncate to something shorter, which makes the prior cursor describe bytes
  // that no longer exist, then fail the read. Carrying that cursor forward made
  // the next scan resume from the wrong offset and silently skip real calls, so
  // re-reading is the correct outcome even though it costs I/O.
  fs.writeFileSync(file, line('three', 'rg third'));
  const realOpen = fs.openSync;
  t.after(() => { fs.openSync = realOpen; });
  fs.openSync = () => { const e = new Error('EBUSY'); e.code = 'EBUSY'; throw e; };
  const failed = scanHistoryFiles({ cursors: first.cursors, codexRoots: [root], claudeRoots: [] });
  fs.openSync = realOpen;

  assert.equal(failed.files[0].mode, 'error');
  assert.equal(failed.cursors[cursorKeyForFile(file)], undefined,
    'a cursor for bytes that are gone is worse than none');

  const recovered = scanHistoryFiles({ cursors: failed.cursors, codexRoots: [root], claudeRoots: [] });
  assert.deepEqual(recovered.observations.map((item) => item.command), ['rg third'],
    'the rewritten content is read in full rather than skipped');
});

// Codex says how a script went in words even when it reports no exit code, and
// an `unknown` outcome is dropped as not-evidence without even a stored hash.
// Measured on this machine's Codex corpus: 30 observations of 6,870 gain an
// attributable outcome, +28 of them failures, and no candidate changes
// disposition. Small, and in the conservative direction.
test('Codex wording resolves an outcome when no exit code is reported', () => {
  const transcript = jsonl(
    responseItem({
      type: 'function_call', name: 'shell_command', call_id: 'worded-fail',
      arguments: JSON.stringify({ command: 'rg missing' }),
    }),
    responseItem({
      type: 'function_call_output', call_id: 'worded-fail',
      output: 'Script failed\nWall time 1.1 seconds\nOutput:\n',
    }),
    responseItem({
      type: 'function_call', name: 'shell_command', call_id: 'worded-ok',
      arguments: JSON.stringify({ command: 'rg present' }),
    }),
    responseItem({
      type: 'function_call_output', call_id: 'worded-ok',
      output: 'Script completed\nWall time 0.9 seconds\nOutput:\n',
    }),
    // An explicit code still wins over the wording, in both spellings.
    responseItem({
      type: 'function_call', name: 'shell_command', call_id: 'code-wins',
      arguments: JSON.stringify({ command: 'rg conflicted' }),
    }),
    responseItem({
      type: 'function_call_output', call_id: 'code-wins',
      output: 'Script completed\nExit code: 3',
    }),
    responseItem({
      type: 'function_call', name: 'shell_command', call_id: 'json-quoted',
      arguments: JSON.stringify({ command: 'rg quoted' }),
    }),
    responseItem({
      type: 'function_call_output', call_id: 'json-quoted',
      output: '{"output":"x","metadata":{"exit_code":1}}',
    }),
    // And silence stays silence: no code and no wording is still not evidence.
    responseItem({
      type: 'function_call', name: 'shell_command', call_id: 'still-quiet',
      arguments: JSON.stringify({ command: 'rg pending' }),
    }),
    responseItem({
      type: 'function_call_output', call_id: 'still-quiet', output: 'Wall time 0.4 seconds',
    }),
  );

  const observations = parseCodexJsonl(transcript, { file: 'codex.jsonl', platform: 'win32' });
  const status = (command) => observations.find((item) => item.command === command)?.status;
  assert.equal(status('rg missing'), 'failed', 'Script failed is negative evidence');
  assert.equal(status('rg present'), 'success');
  assert.equal(status('rg conflicted'), 'failed', 'the exit code outranks the wording');
  assert.equal(status('rg quoted'), 'failed',
    'the double-quoted spelling JSON.stringify produces used to match no pattern');
  assert.equal(status('rg pending'), 'unknown');
});

test('a nested exec reports one status per execution, not one per mention of it', () => {
  // A single execution emits BOTH a `Script completed` summary and an `Output:`
  // block carrying its exit code. Reading the wording per string pushed two
  // statuses for one command, and the attribution logic then refused the pair
  // as a count mismatch, which is correct behaviour on wrong input. So the
  // wording is a whole-payload fallback, used only when no code is present.
  const withBoth = jsonl(
    responseItem({
      type: 'custom_tool_call', name: 'exec', call_id: 'one-command',
      input: 'await tools.shell_command({ command: "pwd" })',
    }),
    responseItem({
      type: 'custom_tool_call_output', call_id: 'one-command',
      output: [
        { type: 'input_text', text: 'Script completed\nWall time: 1.2 seconds' },
        { type: 'input_text', text: 'Output:\nExit code: 0\nWall time: 1.1 seconds' },
      ],
    }),
  );
  const both = parseCodexJsonl(withBoth, { file: 'codex.jsonl', platform: 'win32' });
  assert.equal(both.find((item) => item.command === 'pwd')?.status, 'success',
    'one execution, one status, still attributable');

  // Wording alone, and only wording, is what the fallback is for.
  const wordingOnly = jsonl(
    responseItem({
      type: 'custom_tool_call', name: 'exec', call_id: 'worded-only',
      input: 'await tools.shell_command({ command: "whoami" })',
    }),
    responseItem({
      type: 'custom_tool_call_output', call_id: 'worded-only',
      output: [{ type: 'input_text', text: 'Script failed\nWall time: 0.3 seconds' }],
    }),
  );
  const worded = parseCodexJsonl(wordingOnly, { file: 'codex.jsonl', platform: 'win32' });
  assert.equal(worded.find((item) => item.command === 'whoami')?.status, 'failed');

  // Success is the case that genuinely needs the nested statuses. Per
  // applyCodexGroupResult, a custom exec is only credited with success when
  // exactly one nested status says so, whereas failure can arrive through the
  // group status alone. So a wording-only SUCCESS is discarded as `unknown`
  // unless the nested fallback supplies it, and a first version of this test
  // covered only the failure path, which let a mutation removing that fallback
  // pass untouched.
  const wordedSuccess = jsonl(
    responseItem({
      type: 'custom_tool_call', name: 'exec', call_id: 'worded-success',
      input: 'await tools.shell_command({ command: "git ls-files" })',
    }),
    responseItem({
      type: 'custom_tool_call_output', call_id: 'worded-success',
      output: [{ type: 'input_text', text: 'Script completed\nWall time: 0.6 seconds' }],
    }),
  );
  const success = parseCodexJsonl(wordedSuccess, { file: 'codex.jsonl', platform: 'win32' });
  assert.equal(success.find((item) => item.command === 'git ls-files')?.status, 'success');
});
