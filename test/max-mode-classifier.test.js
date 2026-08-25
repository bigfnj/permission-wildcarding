'use strict';

// MAX mode and Claude Code's auto mode are mutually exclusive, and the toggle has
// to know that. Auto mode routes every decision through the classifier and drops
// any allow entry that would bypass it. Measured against 2.1.238 and 2.1.245 by
// loading the same settings under both modes: in auto mode `Bash(*)`,
// `PowerShell(*)` and every interpreter root load with "Ignoring dangerous
// permission … (bypasses classifier)"; in default mode all 302 entries load
// intact. Turning MAX on inside auto mode therefore collapsed the specific list
// into a blanket that grants nothing, which is worse than leaving MAX off.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

// The state file path is computed at require time, so the home has to be stubbed
// before the module loads or the test would write over the real MAX snapshot.
function loadPermissions(tempHome) {
  const target = require.resolve('../src/permissions');
  const originalLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (request === 'os' && parent?.filename === target) return { ...os, homedir: () => tempHome };
    return originalLoad.call(this, request, parent, isMain);
  };
  delete require.cache[target];
  try { return require(target); }
  finally { Module._load = originalLoad; delete require.cache[target]; }
}

function setup(t) {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'permission-wildcarding-max-'));
  t.after(() => fs.rmSync(tempHome, { recursive: true, force: true }));
  return { tempHome, api: loadPermissions(tempHome) };
}

const ALLOW = ['Bash(git *)', 'Bash(rg *)', 'Bash(python *)'];

test('turning MAX on from auto mode takes the mode with it', (t) => {
  const { api } = setup(t);
  const settings = {
    permissions: { allow: ALLOW, deny: ['Bash(rm -rf /*)'], defaultMode: 'auto' },
    model: 'claude-opus-5',
  };

  const on = api.applyMax(settings, true);
  assert.equal(on.changed, true);
  assert.equal(on.switchedMode, 'auto', 'the caller has to be able to say what happened');
  assert.equal(on.settings.permissions.defaultMode, 'default',
    'MAX in auto mode grants nothing, so the mode moves rather than the promise breaking');
  assert.ok(on.settings.permissions.allow.includes('Bash(*)'));
  assert.equal(on.settings.model, 'claude-opus-5', 'unrelated keys are untouched');
  assert.deepEqual(on.settings.permissions.deny, ['Bash(rm -rf /*)']);

  const off = api.applyMax(on.settings, false);
  assert.equal(off.restoredMode, 'auto', 'and MAX off hands the mode back');
  assert.equal(off.settings.permissions.defaultMode, 'auto');
  assert.deepEqual(off.settings.permissions.allow, ALLOW);
});

test('a mode MAX did not change is left alone', (t) => {
  const { api } = setup(t);
  const settings = { permissions: { allow: ALLOW, defaultMode: 'acceptEdits' } };

  const on = api.applyMax(settings, true);
  assert.equal(on.switchedMode, null, 'only auto mode is incompatible');
  assert.equal(on.settings.permissions.defaultMode, 'acceptEdits');

  const off = api.applyMax(on.settings, false);
  assert.equal(off.restoredMode, null, 'nothing to restore, so nothing is written');
  assert.equal(off.settings.permissions.defaultMode, 'acceptEdits');
});

test('a key the user never had does not appear on the way back', (t) => {
  const { api } = setup(t);
  const on = api.applyMax({ permissions: { allow: ALLOW } }, true);
  assert.equal(on.switchedMode, null);
  assert.equal('defaultMode' in on.settings.permissions, false);

  const off = api.applyMax(on.settings, false);
  assert.equal('defaultMode' in off.settings.permissions, false,
    'restoring a recorded absence must remove the key, not write null');
});

test('a mode changed by hand while MAX was on stays changed', (t) => {
  const { api } = setup(t);
  const on = api.applyMax({ permissions: { allow: ALLOW, defaultMode: 'auto' } }, true);
  // The user picks plan mode while MAX is on. That is their choice, not ours.
  const edited = { ...on.settings, permissions: { ...on.settings.permissions, defaultMode: 'plan' } };

  const off = api.applyMax(edited, false);
  assert.equal(off.restoredMode, null);
  assert.equal(off.settings.permissions.defaultMode, 'plan',
    'MAX only puts back the mode it set, and only if it is still there');
});

test('classifierModeOn reads the mode that discards blanket wildcards', (t) => {
  const { api } = setup(t);
  assert.equal(api.classifierModeOn({ permissions: { defaultMode: 'auto' } }), true);
  assert.equal(api.classifierModeOn({ permissions: { defaultMode: 'default' } }), false);
  assert.equal(api.classifierModeOn({ permissions: {} }), false);
  assert.equal(api.classifierModeOn({}), false);
  assert.equal(api.classifierModeOn(null), false);
  assert.equal(api.CLASSIFIER_MODE, 'auto');
  assert.equal(api.MAX_MODE, 'default');
});
