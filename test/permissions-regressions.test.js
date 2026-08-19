'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  generalizePermission,
  isCoveredBy,
  processAllowList,
} = require('../src/permissions');

test('legacy wildcarding never creates a broad PowerShell call-operator rule', () => {
  const exact = 'PowerShell(& "C:\\Program Files\\Tool\\tool.exe" --version)';
  assert.equal(generalizePermission(exact), exact);
  assert.notEqual(generalizePermission(exact), 'PowerShell(& *)');
});

test('quoted and path executables remain exact instead of becoming malformed roots', () => {
  const quoted = 'Bash("/opt/My Tool/tool" --version)';
  const relative = 'Bash(./scripts/check.sh --fast)';
  assert.equal(generalizePermission(quoted), quoted);
  assert.equal(generalizePermission(relative), relative);
});

test('narrow learned permissions stay narrow and cover matching calls', () => {
  const narrow = 'Bash(git status *)';
  assert.equal(generalizePermission('Bash(git status --short)'), narrow);
  assert.equal(generalizePermission('PowerShell(git status --short)'), 'PowerShell(git status *)');
  assert.equal(generalizePermission('Bash(git)'), 'Bash(git)');
  assert.deepEqual(processAllowList([narrow, 'Bash(git status --short)']), [narrow]);
  assert.deepEqual(
    processAllowList([narrow, 'Bash(git push origin main)']),
    [narrow, 'Bash(git push *)'],
  );
  assert.equal(isCoveredBy('Bash(git status --porcelain)', narrow), true);
  assert.equal(isCoveredBy('Bash(git push origin main)', narrow), false);
});
