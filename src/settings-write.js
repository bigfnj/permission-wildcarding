'use strict';

// The one rebasing writer for `~/.claude/settings.json`.
//
// This used to live in vscode-extension/extension.js, reachable only from the
// extension, while the CLI — including the PostToolUse hook, the highest-frequency
// writer on the machine — used a naive `{ ...settings, permissions: { ...allow } }`
// spread from its own read. That spread reverts whatever landed between the read
// and the write, and Claude Code rewrites settings.json in place on every /model,
// /effort and approval, so the common casualty is `model` / `effortLevel` / `hooks`
// rather than anything this project put there.
//
// Nothing here touches the `vscode` API, which is what made the move possible. The
// backup is injected rather than imported, because the extension's backup reaches
// `vscode.workspace.getConfiguration` for the off-tree mirror path and `src/` must
// stay loadable from a bare Node process.

const fs = require('fs');
const os = require('os');
const path = require('path');

const { writeFileAtomicSync } = require('./permissions');

function defaultSettingsPath(home = os.homedir()) {
  return path.join(home, '.claude', 'settings.json');
}

// "The file is not there" and "the file could not be read this instant" collapse
// into one null for a caller that only wants a value, and that is wrong for
// anything reasoning about loss: a watcher event landing inside one of Claude
// Code's own writes is routine, not exotic. Absent means the backup should step
// in; unreadable means wait and look again, because the alternative is concluding
// that everything is gone.
const SETTINGS_ABSENT = 'absent';
const SETTINGS_PRESENT = 'present';
const SETTINGS_UNREADABLE = 'unreadable';
const SETTINGS_UNREADABLE_CODE = 'SETTINGS_UNREADABLE';

function readSettingsState(settingsPath) {
  let raw;
  try {
    raw = fs.readFileSync(settingsPath, 'utf8');
  } catch (err) {
    return err?.code === 'ENOENT'
      ? { state: SETTINGS_ABSENT, settings: {} }
      : { state: SETTINGS_UNREADABLE, settings: null };
  }
  try {
    return { state: SETTINGS_PRESENT, settings: JSON.parse(raw) };
  } catch {
    // Includes the zero-byte window of a truncate-then-write.
    return { state: SETTINGS_UNREADABLE, settings: null };
  }
}

// `onWrite(allow, deny)` runs after a successful write — the extension passes its
// high-water-mark backup. Omitted by callers that have none, which preserves the
// CLI's existing behaviour exactly rather than quietly giving it a new one.
function createSettingsWriter({ settingsPath, onWrite } = {}) {
  const target = settingsPath || defaultSettingsPath();

  function writeAllow(settings, allow, denyAdditions) {
    // Rebase the intended allow-list delta onto the newest parseable settings so
    // a concurrent Claude/Codex settings write does not lose unrelated fields or
    // approvals that arrived after this operation began.
    const state = readSettingsState(target);
    // The one case where falling back to the caller's snapshot is destructive: the
    // file is there, it just could not be parsed. `settings` is often `{}` on that
    // path, and the spread below would then write a settings.json holding nothing
    // but `permissions`, taking model, effortLevel, env and hooks with it. Refuse,
    // and let the caller report it — every call site already does.
    if (state.state === SETTINGS_UNREADABLE) {
      const err = new Error(`${target} exists but could not be parsed, so it is not safe to write over`);
      // Coded like the policy lock, and for the same reason: a background writer
      // should treat this as "come back in a moment", not as a failure to shout
      // about. Whatever is mid-write finishes and its change re-triggers us.
      err.code = SETTINGS_UNREADABLE_CODE;
      throw err;
    }
    const latest = state.state === SETTINGS_PRESENT ? state.settings : settings;
    const originalAllow = Array.isArray(settings?.permissions?.allow) ? settings.permissions.allow : [];
    const latestAllow = Array.isArray(latest?.permissions?.allow) ? latest.permissions.allow : [];
    // NOTE for anyone reusing this: the delta is computed against the CALLER's
    // snapshot and replayed on the fresh read. That is right for a caller whose
    // intent is a set of specific additions and removals, and WRONG for one whose
    // whole output is a function of the list it read — a stale `removed` entry
    // then deletes something the fresh list gained on purpose. Such a caller must
    // re-read and recompute first, so `settings` IS `latest` and this degenerates
    // to identity. The wildcarding pass is exactly that kind of caller.
    const removed = new Set(originalAllow.filter((entry) => !allow.includes(entry)));
    const added = allow.filter((entry) => !originalAllow.includes(entry));
    const rebasedAllow = [...new Set([...latestAllow.filter((entry) => !removed.has(entry)), ...added])];
    // deny is only ever added to, never rebased away: it is the safety boundary
    // every other feature defers to, so a concurrent writer's rule must survive.
    const latestDeny = Array.isArray(latest?.permissions?.deny) ? latest.permissions.deny : [];
    const additions = Array.isArray(denyAdditions) ? denyAdditions : [];
    const rebasedDeny = additions.length ? [...new Set([...latestDeny, ...additions])] : latestDeny;
    const permissions = { ...latest.permissions, allow: rebasedAllow };
    // Don't introduce an empty deny key where the user never had one.
    if (rebasedDeny.length || Array.isArray(latest?.permissions?.deny)) permissions.deny = rebasedDeny;
    const updated = { ...latest, permissions };
    // Atomic write with Windows-safe rename retry + in-place fallback. The naive
    // renameSync raced Claude Code's own settings.json writes → intermittent EPERM.
    writeFileAtomicSync(target, JSON.stringify(updated, null, 2) + '\n');
    if (typeof onWrite === 'function') onWrite(rebasedAllow, rebasedDeny);
    // What actually landed, measured against the file this write rebased onto — not
    // against the caller's older snapshot. A caller that reports its own intent
    // instead ends up announcing "+299 restored" over a file that already had them.
    return {
      allow: rebasedAllow,
      deny: rebasedDeny,
      addedAllow: rebasedAllow.filter((entry) => !latestAllow.includes(entry)).length,
      addedDeny: rebasedDeny.filter((entry) => !latestDeny.includes(entry)).length,
    };
  }

  return {
    settingsPath: target,
    readSettingsState: () => readSettingsState(target),
    writeAllow,
  };
}

module.exports = {
  defaultSettingsPath,
  readSettingsState,
  createSettingsWriter,
  SETTINGS_ABSENT,
  SETTINGS_PRESENT,
  SETTINGS_UNREADABLE,
  SETTINGS_UNREADABLE_CODE,
};
