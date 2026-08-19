'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createAutoLearnManager } = require('../src/auto-learn-manager');

function jsonl(...records) {
  return `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;
}

function claudeCall(id, command) {
  return {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id, name: 'PowerShell', input: { command } }],
    },
  };
}

function claudeResult(id) {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: id, is_error: false, content: 'ok' }],
    },
  };
}

function codexItem(payload) {
  return { type: 'response_item', payload };
}

test('Claude and Codex history jointly learn one safe family and apply/undo separate policy', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'permission-wildcarding-e2e-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  const claudeHistory = path.join(home, '.claude', 'projects', 'project-a', 'claude-private-session.jsonl');
  const codexHistory = path.join(home, '.codex', 'sessions', '2026', '08', 'codex-private-session.jsonl');
  const settings = path.join(home, '.claude', 'settings.json');
  const rules = path.join(home, '.codex', 'rules', 'permission-wildcarding.rules');
  const originalSettings = `${JSON.stringify({
    permissions: { allow: ['WebSearch'] },
    theme: 'dark',
  }, null, 2)}\n`;
  const originalRules = '# manual policy remains owned by the user\n';
  const privatePrompt = 'fixture-private-prompt-text';

  fs.mkdirSync(path.dirname(claudeHistory), { recursive: true });
  fs.mkdirSync(path.dirname(codexHistory), { recursive: true });
  fs.mkdirSync(path.dirname(rules), { recursive: true });
  fs.writeFileSync(settings, originalSettings);
  fs.writeFileSync(rules, originalRules);
  fs.writeFileSync(claudeHistory, jsonl(
    { type: 'session_meta', payload: { id: 'claude-e2e', cwd: 'D:\\work' } },
    { type: 'user', message: { role: 'user', content: privatePrompt } },
    claudeCall('claude-one', 'git status --short private-claude-a'),
    claudeResult('claude-one'),
    claudeCall('claude-two', 'git status --porcelain private-claude-b'),
    claudeResult('claude-two'),
  ));
  fs.writeFileSync(codexHistory, jsonl(
    { type: 'session_meta', payload: { id: 'codex-e2e', cwd: 'D:\\work' } },
    codexItem({
      type: 'function_call', name: 'shell_command', call_id: 'codex-one',
      arguments: JSON.stringify({ command: 'git status --branch private-codex-c', workdir: 'D:\\work' }),
    }),
    codexItem({ type: 'function_call_output', call_id: 'codex-one', output: { exit_code: 0 } }),
  ));

  const validated = [];
  const manager = createAutoLearnManager({
    home, threshold: 3, codexRulesPath: rules,
    codexValidator: (_text, context) => {
      validated.push(context.command);
      return { valid: true, decision: context.command ? 'allow' : undefined };
    },
  });

  const scan = manager.scan({ platform: 'win32' });
  assert.equal(scan.newObservations, 3);
  const [candidate] = manager.listCandidates();
  assert.equal(candidate.key, 'powershell:git status');
  assert.equal(candidate.autoSafe, true);
  assert.deepEqual(candidate.sources, ['claude', 'codex']);
  assert.equal(candidate.counts.success, 3);

  const stateText = fs.readFileSync(manager.paths.state, 'utf8');
  assert.doesNotMatch(stateText, /private-(?:claude|codex)|private-session|\.jsonl/i);
  assert.match(stateText, /path-sha256:[a-f0-9]{24}/);

  const applied = manager.apply();
  assert.equal(applied.appliedCount, 1);
  assert.deepEqual(applied.changedTargets.sort(), ['claude', 'codex']);
  assert.deepEqual(validated, [['git', 'status']]);
  const claimsText = fs.readFileSync(manager.paths.claudeClaims, 'utf8');
  for (const privateValue of [
    'private-claude-a', 'private-claude-b', 'private-codex-c',
    privatePrompt, claudeHistory, codexHistory,
  ]) {
    assert.equal(claimsText.includes(privateValue), false, `claims leaked: ${privateValue}`);
  }
  assert.doesNotMatch(claimsText, /private-session|\.jsonl/i);
  assert.ok(JSON.parse(fs.readFileSync(settings, 'utf8')).permissions.allow.includes('PowerShell(git status *)'));
  const generatedRules = fs.readFileSync(rules, 'utf8');
  assert.ok(generatedRules.startsWith(originalRules));
  assert.match(generatedRules, /pattern\s*=\s*\[\x22git\x22, \x22status\x22\]/);

  assert.equal(manager.undo().undone, true);
  assert.equal(fs.readFileSync(settings, 'utf8'), originalSettings);
  assert.equal(fs.readFileSync(rules, 'utf8'), originalRules);
});
