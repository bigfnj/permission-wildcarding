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
