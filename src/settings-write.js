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
// Coded like the lock and the unreadable case: a caller should report this and
// let its next trigger retry, not treat it as a hard failure.
const SETTINGS_CONTENDED_CODE = 'SETTINGS_CONTENDED';

// readSettingsState's classification, applied to bytes the caller already has.
// Exists so writeTransform can use ONE read for both the transform's input and
// its compare-and-swap baseline instead of two reads that can disagree.
//
// `text === null` means rawSettingsText could not read the file, and that lumps
// ENOENT together with a transient EACCES/EBUSY. Distinguished here with an
// existsSync rather than left ambiguous: treating "I could not read it" as
// "it is not there" would hand the transform an empty object and then write over
// a file that does exist.
function stateOfText(settingsPath, text) {
  if (text === null) {
    return fs.existsSync(settingsPath)
      ? { state: SETTINGS_UNREADABLE, settings: null }
      : { state: SETTINGS_ABSENT, settings: {} };
  }
  try {
    const parsed = JSON.parse(text);
    // A JSON scalar or array parses fine and is not a settings object.
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { state: SETTINGS_UNREADABLE, settings: null };
    }
    return { state: SETTINGS_PRESENT, settings: parsed };
  } catch {
    // Includes the zero-byte window of a truncate-then-write.
    return { state: SETTINGS_UNREADABLE, settings: null };
  }
}

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

// The raw bytes, for the compare-and-swap in writeTransform. Deliberately not a
// parse: two different byte sequences can parse equal, and for a whole-object
// write any byte change at all means someone else got there first.
function rawSettingsText(target) {
  try { return fs.readFileSync(target, 'utf8'); }
  catch { return null; }
}

// Deny rules present in `before` that `after` would not carry. Used to refuse a
// transform that would drop the safety boundary.
function deniesLost(before, after) {
  const had = Array.isArray(before?.permissions?.deny) ? before.permissions.deny : [];
  if (!had.length) return [];
  const kept = new Set(Array.isArray(after?.permissions?.deny) ? after.permissions.deny : []);
  return had.filter((rule) => !kept.has(rule));
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

  // ── writeTransform ──────────────────────────────────────────────────────────
  //
  // The OTHER shape of writer, for callers whose change cannot be expressed as an
  // allow-list delta. Read the contrast before reaching for either:
  //
  //   writeAllow      replays the caller's delta onto a fresh read, protects deny
  //                   additively, and MERGES (`{ ...latest, permissions }`). A
  //                   merge can never express a DELETE, and it can only ever
  //                   change `permissions.allow` plus additive `permissions.deny`.
  //   writeTransform  runs the caller's function against a fresh read and writes
  //                   what it returns, VERBATIM. It can therefore delete keys —
  //                   which `applyMax`/`applyBypass` require, since both remove
  //                   `permissions.defaultMode` and `hooks.PreToolUse` rather than
  //                   nulling them — and it gets none of writeAllow's protections.
  //
  // Routing MAX through writeAllow would silently drop Layer 2 entirely: `hooks`
  // comes from `latest` in that merge, so the approve-hook registration would
  // never be written. That is why a second writer exists.
  //
  // Compare-and-swap, not just a rebase. A rebase alone would close nothing here:
  // the caller's expensive work happens INSIDE this function (enableMaxAllow runs
  // processAllowList, measured 9.6 ms), so the read-to-write window survives the
  // change. Re-reading the bytes after the transform and retrying when they moved
  // is what actually shrinks it, and it is the pattern auto-learn-manager already
  // uses for its own transactional write. Retry is safe because both transforms
  // are idempotent overwrites — each attempt re-snapshots from the newest read,
  // which is also what makes "the MAX snapshot comes from the freshest read" true
  // at the moment of the write rather than merely at the moment of the read.
  function writeTransform(transform, { attempts = 3 } = {}) {
    let lastLatest = null;
    let lastResult = null;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      // ONE read serves both the transform's input and the compare-and-swap
      // baseline. They must be the same bytes, and originally they were not:
      // `latest` came from a readSettingsState() call and `beforeText` from a
      // second read taken after it. A concurrent write landing between those two
      // left the CAS satisfied — its own before and after agreed — while the
      // transform had already been handed a stale object, and the verbatim write
      // then discarded that concurrent change. That is the exact loss this
      // writer exists to prevent, reintroduced in a smaller window.
      const beforeText = rawSettingsText(target);
      const before = stateOfText(target, beforeText);
      // Refuse BEFORE running the transform, never after. applyMax writes the
      // allow-list snapshot as a side effect, so transforming first would clobber
      // a real snapshot with one taken from a file we then refuse to write.
      // test/cli-hook.test.js asserts those snapshot bytes survive a refusal.
      if (before.state === SETTINGS_UNREADABLE) {
        const err = new Error(`${target} exists but could not be parsed, so it is not safe to write over`);
        err.code = SETTINGS_UNREADABLE_CODE;
        throw err;
      }
      // `absent` yields {}, which is the legitimate first-run case.
      const latest = before.settings;
      const result = transform(latest);
      lastLatest = latest;
      lastResult = result;
      if (!result || result.changed !== true) return { wrote: false, result, latest };

      // Did the file move under us while the transform ran? Compare bytes, not a
      // parse: any change at all invalidates a whole-object write.
      if (rawSettingsText(target) !== beforeText) continue;

      // deny is guarded; `model`, `effortLevel`, `env` and `hooks` are NOT, and
      // this module's own header calls those "the common casualty". A transform
      // returning only `{ permissions: {...} }` is written verbatim and takes
      // them with it — and dropping `hooks` un-registers this project's own
      // PostToolUse hook, i.e. disables the tool silently. Not guarded here
      // because a whole-object writer cannot tell a deliberate removal from an
      // accidental one, which is exactly why the shape check above is the
      // backstop and why `writeAllow` is the right writer for anything that only
      // means to change the allow list.
      //
      // deny is the safety boundary every other feature defers to. writeAllow
      // guarantees it additively; this writer cannot, so it refuses to be the
      // thing that drops one rather than doing it silently. Both current
      // transforms spread `permissions` through, so this never fires for them —
      // it is a guard for the next author.
      // A shape guard before the deny guard, because its failure is worse.
      // `JSON.stringify(undefined, null, 2) + '\n'` is the ten bytes
      // "undefined\n", so a transform returning { changed: true } with no
      // settings — or a string, a number, an array — atomically REPLACES
      // settings.json with garbage and throws nothing. No current transform can
      // do it, but this writer is documented as having none of writeAllow's
      // protections, and the one guard it had was the one nothing could trip.
      if (!result.settings || typeof result.settings !== 'object' || Array.isArray(result.settings)) {
        throw new Error(
          'refusing to write: the transform returned no settings object '
          + `(got ${Array.isArray(result.settings) ? 'an array' : typeof result.settings})`,
        );
      }

      const lost = deniesLost(latest, result.settings);
      if (lost.length) {
        throw new Error(
          `refusing to write: the transform would drop ${lost.length} deny rule(s) `
          + `(${lost.slice(0, 3).join(', ')}${lost.length > 3 ? ', …' : ''})`,
        );
      }

      writeFileAtomicSync(target, JSON.stringify(result.settings, null, 2) + '\n');
      // Deliberately NOT calling onWrite. That hook is the allow-list high-water
      // backup, and the reason is narrower than it looks: MAX's blanket set does
      // legitimately reach the backup in production (via the watcher, which
      // test/policy-backup.test.js relies on), so this is not about keeping it
      // out. It is about preserving today's behaviour byte-for-byte through a
      // correctness change — the extension compensates by hand with
      // forgetFromBackup, and moving that here would be a second change riding
      // the first.
      return { wrote: true, result, latest };
    }
    // Out of attempts: another writer is winning every race. Report rather than
    // write over it; the caller's next trigger retries.
    const err = new Error(`${target} changed under every write attempt (${attempts}), so nothing was written`);
    err.code = SETTINGS_CONTENDED_CODE;
    err.result = lastResult;
    err.latest = lastLatest;
    throw err;
  }

  return {
    settingsPath: target,
    readSettingsState: () => readSettingsState(target),
    writeAllow,
    writeTransform,
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
  SETTINGS_CONTENDED_CODE,
};
