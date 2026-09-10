'use strict';

const vscode = require('vscode');
const fs     = require('fs');
const path   = require('path');
const os     = require('os');
const crypto = require('crypto');
const https  = require('https');
const { execFile } = require('child_process');
const { createAutoLearnWorkerRunner } = require('./autoLearnWorkerRunner');

// Share core logic with the hook variant — permissions.js is copied into
// src/ by scripts/package.mjs so both modes stay in sync from a single source.
const {
  processAllowList, writeFileAtomicSync, isBypassOn,
  applyMax, isMaxOn, maxLayers, buildMaxAllowSet, MAX_MARKERS,
} = require('./src/permissions');
const { createAutoLearnManager } = require('./src/auto-learn-manager');
const {
  createPolicyLock, POLICY_LOCK_CODE, POLICY_LOCK_PATH, POLICY_LOCK_BUSY_MESSAGE,
} = require('./src/policy-lock');
const {
  CODEX_CONFIG, CODEX_BUNDLE_CACHE, applyCodexMax, isCodexMaxOn, readApproval, sandboxMode,
  readEnterpriseBundle, targetApproval, enterpriseDecisionFor,
} = require('./src/codex-max');
const {
  managedSettingsPaths, policySignalPaths, policyLimitsPath, policyRestrictions, assessPolicy,
} = require('./src/policy-guard');
const { extractInvocations, candidateKey } = require('./src/auto-learn');
const { commandLaunch } = require('./src/exec-resolve');
const { recallIndexCount, recallIndexStatus } = require('./src/recall-index');
const { drainLocalSettings, localSettingsPath, LOCAL_RELATIVE } = require('./src/local-settings');
const { guidanceStatusAll, setGuidanceAll } = require('./src/agent-guidance');
const { gatesStatusAll, setGatesAll, readCompiled, compiledPath } = require('./src/agent-gates');
const {
  applicationSummary, candidatePendingTargets, claudeDecisionExplanation,
  claudePermissionDecision, codexCheckVariants, codexExecpolicyArgs, codexRestartSuffix,
  derivedGuidanceItems, derivedGuidanceSummary,
  isCandidateComplete, managedBlockedDetail, managedBlockedNote, managedPromptExplanation,
  policyTargetLabel, reviewableCandidates, selectionsNeedingConfirmation,
  uniqueTargets,
} = require('./autoLearnUi');

// Ambient memory-index hygiene lint (self-contained; pure Node, no Python/model/hook).
// memoryReport() also backs the dashboard Memory card (stats only, still pure Node).
const { MemoryLint, memoryReport, discoverDirs } = require('./memoryLint');

const SETTINGS      = path.join(os.homedir(), '.claude', 'settings.json');
const BACKUP_DIR    = path.join(os.homedir(), '.claude', 'backups');
const LATEST_BACKUP = path.join(BACKUP_DIR, 'allow-list.latest.json');
// The primary backup above lives INSIDE the directory it exists to survive the
// reset of, which is fine for the failure it was written for (an org policy
// rewriting settings.json in place) and useless for the one observed
// 2026-09-09, when every directory under ~/.claude was recreated — `backups/`
// went with it, and the allow list came back only because this extension was
// still running and held it in memory. So mirror off-tree, outside ~/.claude.
// Default is homedir-derived to stay portable (and hermetic under a mocked
// home); point the setting at another volume to survive more than a reset.
const MIRROR_BACKUP_DEFAULT = path.join(os.homedir(), '.permission-wildcarding', 'allow-list.latest.json');
const PROJECTS_DIR  = path.join(os.homedir(), '.claude', 'projects');
const CODEX_SESSIONS_DIR = path.join(os.homedir(), '.codex', 'sessions');
// Auto Learn, this wildcarding pass, and the MAX/bypass toggles are all writers
// of one settings.json. They take the same lock (POLICY_LOCK_PATH, defined once
// in src/policy-lock.js) so none can land between another's writes.

let debounceTimer = null;
// One channel for the extension's lifetime, disposed with it. Three sites used
// to create one PER INVOCATION and never dispose it, and one of those is a
// palette command with no call limit, so the Output dropdown filled with
// duplicate "Permission Wildcarding" entries and each retained its backing
// document. memoryLint.js already had the right pattern: create in activate,
// register as a subscription.
let outputChannel = null;
let recallSyncTimer = null;  // the deferred staleness check, so deactivate can cancel it
let policyLock = null;      // shared with Auto Learn; created on first write
let lockedRetries = 0;      // consecutive deferrals while Auto Learn holds it
let dashboard = null;        // WildcardingViewProvider instance
let lastRun = null;          // timestamp of the last write we made
let statusBar = null;        // persistent status-bar indicator while MAX/bypass is on
let memBounce = null;        // debounce for MEMORY.md-driven dashboard refreshes
let gatesBounce = null;      // debounce for corpus-driven gate recompiles
let recallRebuildAt = 0;     // timestamp of the last auto-rebuild (cooldown gate)
let autoLearnBounce = null;  // debounce for Claude/Codex transcript writes
let autoLearnTimer = null;   // periodic reconciliation timer
let autoLearnBusy = false;
let autoLearnLastError = null;
let autoLearnFailureCount = 0;
let autoLearnNextRetryAt = 0;
let autoLearnManager = null;
let autoLearnManagerKey = '';
let autoLearnCardCache = null;  // { key, data }; key includes the state file stamp
let autoLearnWorkerRunner = null;
let policyBounce = null;        // debounce for policy-signal / settings-change guard runs
let localDrainBounce = null;    // debounce for settings.local.json writes
let localDrainRetries = 0;      // consecutive deferrals while settings.json was unreadable
let localDrainAt = null;        // timestamp of the last local drain that changed something
let dashboardBounce = null;     // debounce for dashboard pushes (see refresh())

// ── deactivation ──────────────────────────────────────────────────────────────
// Set by deactivate(), cleared by activate(). Clearing a timer stops a spawn
// STARTING; it says nothing about work already in flight, and deactivate had no
// way to ask. Every async continuation below that would touch the dashboard,
// spawn a child or write a file checks this one flag instead of each growing its
// own cancellation story.
//
// The worst case was the gate compile: its callback chains into ensureGates() →
// setGatesAll(), so a compile that started before a reload rewrote the user's
// CLAUDE.md / AGENTS.md from a torn-down extension host.
// The memory linter instance. Module-scoped so onDidChangeConfiguration can
// reach it; see the memory branch of the listener.
let memoryLint = null;
let deactivated = false;
// Bumped by every activate(). deactivate() captures it before awaiting the Auto
// Learn drain so a continuation that resumes after a same-realm re-activate can
// tell it is no longer the current generation. See the tail of deactivate().
let activationGeneration = 0;

// The children themselves. execFile returns a ChildProcess and not one of the
// four call sites retained it, so deactivate could only ever hope they were
// finished — including the 180s recall rebuilds.
const liveChildren = new Set();

function trackChild(child) {
  if (!child || typeof child.on !== 'function') return child;
  liveChildren.add(child);
  const forget = () => liveChildren.delete(child);
  // Both, because a spawn failure emits 'error' and never 'close'.
  child.on('close', forget);
  child.on('error', forget);
  return child;
}

function killLiveChildren() {
  for (const child of [...liveChildren]) {
    try { child.kill(); } catch { /* already gone */ }
  }
  liveChildren.clear();
}

// ── settings.json helpers ─────────────────────────────────────────────────────
function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS, 'utf8'));
  } catch {
    return null; // missing or mid-write
  }
}

// The state constants, the "why is there no value" read, and the rebasing writer
// all moved to src/settings-write.js so the CLI — whose hook is the highest-
// frequency writer of this file — uses the same one instead of a naive spread.
// Re-exported as locals here so every existing call site is untouched.
const {
  createSettingsWriter,
  SETTINGS_ABSENT, SETTINGS_PRESENT, SETTINGS_UNREADABLE, SETTINGS_UNREADABLE_CODE,
} = require('./src/settings-write');

// backupPolicy is INJECTED rather than imported by the writer: it reaches
// vscode.workspace.getConfiguration for the off-tree mirror path, and src/ has to
// stay loadable from a bare Node process. Declared lazily because backupPolicy is
// defined below this point.
const settingsWriter = createSettingsWriter({
  settingsPath: SETTINGS,
  onWrite: (allow, deny) => backupPolicy(allow, deny),
});

const readSettingsState = () => settingsWriter.readSettingsState();
const writeAllow = (settings, allow, denyAdditions) =>
  settingsWriter.writeAllow(settings, allow, denyAdditions);

// ── policy backup / restore ─────────────────────────────────────────────────────
// A managed-settings refresh (e.g. an org policy with allowManagedHooksOnly) can
// reset settings.json and wipe accumulated wildcards. This keeps a copy of the
// allow list *and* the deny list in ~/.claude/backups so a reset is recoverable.
//
// Both halves matter. deny is the safety boundary every other feature defers to
// — MAX mode, bypass mode and auto-safe all end their safety argument at "deny
// still wins" — so restoring allow alone would hand back every permission with
// the killswitch still off, which is strictly worse than not restoring at all.
//
// It's a high-water mark: the backup only grows. A reset that *shrinks* the live
// lists never clobbers a fuller backup, so restore always has the complete set.
// For deny that direction is also the fail-closed one: a rule deliberately
// deleted can reappear on an explicit restore, which is noisy but never unsafe.
//
// On-disk shape is { allow, deny }. A bare array is the pre-1.12 allow-only
// backup and is still read, so an existing file upgrades in place on first write.
//
// Read late rather than at module load: a settings change must not need a window
// reload to take effect, and a config read at require time runs before the
// mocked workspace exists in tests. Falls back to the default when unset or
// blank, and `~` is expanded so a hand-typed setting behaves as it reads.
function mirrorBackupPath() {
  let configured;
  try {
    configured = vscode.workspace.getConfiguration('permissionWildcarding')
      .get('backupMirrorPath', '');
  } catch { configured = ''; }
  if (typeof configured !== 'string' || !configured.trim()) return MIRROR_BACKUP_DEFAULT;
  const raw = configured.trim();
  return raw.startsWith('~')
    ? path.join(os.homedir(), raw.slice(1).replace(/^[\\/]+/, ''))
    : raw;
}

function readOneBackup(file) {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return null; }
  if (Array.isArray(raw)) return { allow: raw, deny: [] };
  if (!raw || typeof raw !== 'object') return null;
  return {
    allow: Array.isArray(raw.allow) ? raw.allow : [],
    deny: Array.isArray(raw.deny) ? raw.deny : [],
  };
}

// Primary first, mirror only as a FALLBACK — deliberately not a union. Unioning
// the two copies would resurrect a deliberate prune whenever one of them lagged,
// which is the single failure `forgetFromBackup` exists to prevent. The mirror
// therefore only speaks when the primary is gone or unparseable, which is
// exactly the recovery case it was added for.
function readBackup() {
  return readOneBackup(LATEST_BACKUP) ?? readOneBackup(mirrorBackupPath());
}

// Atomic per file via temp + rename. The mirror is best-effort and written
// second: it must never cost the primary write, which is the copy every other
// code path reads first.
function writeBackupCopies(payload) {
  // writeFileAtomicSync, not a hand-rolled `target + '.tmp'`. That shared name
  // is exactly the collision src/permissions.js:31-33 exists to prevent —
  // "Unique per-writer temp name so the hook and the VS Code extension (or two
  // extension hosts) never collide on one shared *.wc.tmp" — and this file has
  // seen four extension copies running at once. Two hosts racing on one .tmp can
  // rename a half-written file into place, and because both copies used the same
  // scheme one race corrupted the primary AND the mirror together: readBackup()
  // then fails to parse both, `previous` collapses to empty, and the high-water
  // mark silently resets to whatever the live list happens to be at that
  // instant. If that instant is mid-policy-wipe, the only recovery data for the
  // 2026-09-09 class of event is destroyed by the thing meant to preserve it.
  const write = (target) => {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    writeFileAtomicSync(target, payload);
  };
  // Attempted independently rather than in sequence. The mirror's whole purpose
  // is surviving the loss of the primary's directory, so a primary failure is
  // the case where the mirror matters most — it must not be skipped by it.
  let primaryError;
  try { write(LATEST_BACKUP); } catch (error) { primaryError = error; }
  try { write(mirrorBackupPath()); } catch { /* off-tree copy is best-effort */ }
  // Rethrown for the caller's own best-effort catch, so behaviour on a failed
  // primary write is unchanged from before the mirror existed.
  if (primaryError) throw primaryError;
}

function backupPolicy(allow, deny) {
  try {
    const nextAllow = Array.isArray(allow) ? allow : [];
    const nextDeny = Array.isArray(deny) ? deny : [];
    if (!nextAllow.length && !nextDeny.length) return;
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const previous = readBackup() ?? { allow: [], deny: [] };
    // Union rather than comparing only lengths: a same-sized settings refresh
    // can replace one wildcard with another and must not silently drop either.
    const merged = {
      allow: [...new Set([...previous.allow, ...nextAllow])],
      deny: [...new Set([...previous.deny, ...nextDeny])],
    };
    if (JSON.stringify(previous) === JSON.stringify(merged)) return;
    writeBackupCopies(JSON.stringify(merged, null, 2) + '\n');
  } catch { /* best-effort — never block the main write */ }
}

function backupCount() {
  const backup = readBackup();
  return backup ? backup.allow.length + backup.deny.length : 0;
}

// The one way an entry leaves the high-water mark: the user said to remove it.
// Without this the backup would resurrect every deliberate prune, and the policy
// guard would read the user's own edit as damage.
function forgetFromBackup(permissions) {
  const drop = new Set(Array.isArray(permissions) ? permissions : [permissions]);
  const backup = readBackup();
  if (!backup) return;
  const next = {
    allow: backup.allow.filter((entry) => !drop.has(entry)),
    deny: backup.deny.filter((entry) => !drop.has(entry)),
  };
  if (next.allow.length === backup.allow.length && next.deny.length === backup.deny.length) return;
  try {
    // Both copies, or the next restore reads the mirror and hands the pruned
    // entry straight back.
    writeBackupCopies(JSON.stringify(next, null, 2) + '\n');
  } catch { /* best-effort — never block the removal itself */ }
}

// ── policy guard ────────────────────────────────────────────────────────────────
// The point of the backup is the day managed policy lands. Two different things
// happen to prior approvals then, and only one is recoverable:
//
//   missing  — the refresh reset settings.json. The backup has them; re-assert.
//   shadowed — managed deny/ask outranks a user allow entry. Nothing user-side
//              beats that, so it is reported and never re-written. Fighting it
//              is exactly how this becomes a write loop against the policy.
//
// Only `missing` triggers a write, and only when there is something to restore,
// so a policy change that took nothing away produces no write at all.
function readManagedSettings() {
  for (const candidate of managedSettingsPaths()) {
    try { return { path: candidate, settings: JSON.parse(fs.readFileSync(candidate, 'utf8')) }; }
    catch { /* absent or mid-write — try the next location */ }
  }
  return null;
}

function readPolicyLimits() {
  try { return JSON.parse(fs.readFileSync(policyLimitsPath(), 'utf8')); }
  catch { return null; }
}

// Triggered by a policy signal *and* by any settings.json change, because the
// signal that matters is "approvals stopped being there", not "a policy file
// changed". On a console-managed org there may be no managed-settings.json at
// all — restrictions are configured server-side and only ever surface locally as
// ~/.claude/policy-limits.json, or as effects with no local artefact whatsoever.
// Watching for the admin-dropped file alone is how a guard watches nothing.
function onManagedPolicyChanged() {
  const backup = readBackup();
  if (!backup) return;
  const liveState = readSettingsState();
  // Say nothing when the file could not be read. The next settings write or policy
  // event brings us straight back here, and by then it parses; guessing in the
  // meantime means guessing "all of it went missing", against a file that is
  // usually intact and mid-write.
  if (liveState.state === SETTINGS_UNREADABLE) return;
  const managed = readManagedSettings();
  const live = liveState.settings;
  const assessment = assessPolicy({
    live, backup, managed: managed?.settings, limits: readPolicyLimits(),
  });
  if (!assessment.restorable && !assessment.shadowed.length) return;

  // Only a bulk loss is repaired without asking. Removing one entry is an
  // instruction (the ✕ prune already forgets it from the backup); losing most of
  // the list is damage.
  if (!assessment.bulkLoss && assessment.restorable) {
    // Small loss: an instruction, not damage — so ask rather than auto-restore.
    // "Forget them" drops the entries from the high-water backup, which is the
    // fix for a stale backup nagging forever about entries the user pruned by
    // editing settings.json directly (the ✕ button forgets; a hand edit can't).
    const stale = [...assessment.missing.allow, ...assessment.missing.deny];
    vscode.window.showWarningMessage(
      `permission-wildcarding: ${assessment.restorable} saved ${assessment.restorable === 1 ? 'entry is' : 'entries are'} missing from settings.json.`,
      'Re-assert them', 'Forget them'
    ).then((choice) => {
      if (choice === 'Re-assert them') restoreFromBackup();
      else if (choice === 'Forget them') {
        forgetFromBackup(stale);
        vscode.window.setStatusBarMessage(
          `$(check) permission-wildcarding: forgot ${stale.length} stale ${stale.length === 1 ? 'entry' : 'entries'} from the backup`, 4000);
        dashboard?.refresh();
      }
    });
    return;
  }

  const notes = [];
  let restored = null;
  if (assessment.bulkLoss) {
    // One notification per event: the restore reports back instead of raising its
    // own toast, so the count below is what the write actually changed on disk. A
    // restore that turns out to be a no-op says nothing at all, which is the
    // second line of defence against announcing a loss that never happened.
    restored = restoreFromBackup({ announce: false });
    if (restored) {
      const count = restored.addedAllow + restored.addedDeny;
      notes.push(`re-asserted ${count} ${count === 1 ? 'entry' : 'entries'} that went missing`);
    }
  }
  if (assessment.shadowed.length) {
    // These cannot be recovered, only explained — say so rather than implying
    // the restore covered them.
    notes.push(
      `${assessment.shadowed.length} now overridden by managed rules (cannot be restored — managed policy outranks your allow list)`
    );
  }
  if (assessment.capabilities.userHooksDisabled && isMaxOn(live)) {
    notes.push('managed policy disables user hooks, so MAX layer 2 (approve hook) is inert — the allow-wildcard layer still applies');
  }
  if (!notes.length) return;

  vscode.window.showWarningMessage(
    `permission-wildcarding: policy change detected — ${notes.join('; ')}.`,
    'Show detail'
  ).then((choice) => {
    if (choice !== 'Show detail') return;
    const channel = sharedChannel({ fresh: true });
    // Name the source honestly. On a console-managed org there is often no
    // managed-settings.json at all, and saying "managed policy: undefined" would
    // be worse than saying where the signal actually came from.
    channel.appendLine(`Managed settings file: ${managed ? managed.path : 'none on disk'}`);
    channel.appendLine(`Server-delivered restrictions (${policyLimitsPath()}):`);
    channel.appendLine(assessment.restrictions.length
      ? assessment.restrictions.map((name) => `  ${name}: not allowed`).join('\n')
      : '  none recorded');
    channel.appendLine('');
    channel.appendLine(`Re-asserted: ${restored ? restored.addedAllow + restored.addedDeny : 0} entries`);
    if (assessment.shadowed.length) {
      channel.appendLine('');
      channel.appendLine('Overridden by managed policy (not recoverable):');
      for (const entry of assessment.shadowed) {
        channel.appendLine(`  ${entry.permission} — managed ${entry.decision}: ${entry.rule}`);
      }
    }
    channel.show(true);
  });
}

// Watcher events arrive in bursts, and this pass draws a much larger conclusion
// from them than the wildcarding pass does, so it gets the same treatment: settle
// first, then look once. Measured on this machine, a single Claude Code start
// re-saved policy-limits.json four times in 40 seconds while settings.json was
// being rewritten in place, and each of those fired the guard immediately.
const POLICY_CHECK_DEBOUNCE_MS = 1500;

// The `deactivated` check belongs in the SCHEDULER, not only in the callback.
// deactivate() sets the flag and clears these timers, and then AWAITS the Auto
// Learn drain — which by deliberate decision has no deadline. Every file watcher
// is still live across that await, and a settings.json or policy-limits.json
// event arriving in it called straight through to here and re-armed a timer that
// had just been cleared. 400-1500 ms later runWildcarding() took the policy lock
// and wrote ~/.claude/settings.json, drainLocal() wrote that AND the project's
// settings.local.json, and onManagedPolicyChanged() could reach
// restoreFromBackup() — all from a torn-down extension host. drainLocal's own
// retry path re-schedules up to 20 times, which can stretch that window to a
// minute.
//
// Refusing to arm is strictly better than checking inside the callback: it also
// stops the timer existing, so nothing is left for a later teardown to clear.
function schedulePolicyCheck(delay = POLICY_CHECK_DEBOUNCE_MS) {
  if (deactivated) return;
  clearTimeout(policyBounce);
  policyBounce = setTimeout(() => {
    try { onManagedPolicyChanged(); } catch { /* a watcher must never surface a stack */ }
  }, delay);
}

// Merge the backup into the current allow and deny lists, then generalize/prune
// the allow half. Used to recover after a policy wipe — a superset merge, so it
// never removes anything.
//
// Returns what the write changed, or null when nothing was written. `announce:
// false` hands the reporting to the caller so one event cannot raise two toasts.
function restoreFromBackup(options = {}) {
  const announce = options.announce !== false;
  const backup = readBackup();
  if (!backup) {
    // Name both, or a user whose ~/.claude was reset is told the only copy is
    // missing while the off-tree one sits there unmentioned.
    vscode.window.showWarningMessage('permission-wildcarding: no backup found at '
      + `${LATEST_BACKUP} or ${mirrorBackupPath()}`);
    return null;
  }
  if (!backup.allow.length && !backup.deny.length) {
    vscode.window.showWarningMessage('permission-wildcarding: backup is empty — nothing to restore');
    return null;
  }

  const liveState = readSettingsState();
  // Restoring "over" a file we cannot parse would compare the backup against an
  // allow list we never read, so every entry looks missing and the merge has no
  // live half to preserve. An absent file is different: there is nothing to lose.
  if (liveState.state === SETTINGS_UNREADABLE) {
    vscode.window.showWarningMessage(
      `permission-wildcarding: ${SETTINGS} could not be parsed — not restoring over it. ` +
      'Fix the file (or close whatever is writing it) and run Restore again.'
    );
    return null;
  }
  const settings = liveState.settings ?? {};
  const current  = Array.isArray(settings.permissions?.allow) ? settings.permissions.allow : [];
  const currentDeny = Array.isArray(settings.permissions?.deny) ? settings.permissions.deny : [];
  // Never restore the MAX blanket markers (Bash(*) / PowerShell(*)) from backup.
  // MAX is an explicit mode choice — a restore should not silently re-enable it.
  // The full MAX set (Read(*), Edit, Write, …) is legitimately used outside MAX too,
  // so only the two markers that uniquely signal MAX-on are excluded.
  const maxMarkerSet = new Set(MAX_MARKERS);
  const safeBackupAllow = backup.allow.filter((p) => !maxMarkerSet.has(p));
  const merged   = processAllowList([...new Set([...current, ...safeBackupAllow])]);
  const missingDeny = backup.deny.filter((rule) => !currentDeny.includes(rule));

  if (JSON.stringify(current) === JSON.stringify(merged) && !missingDeny.length) {
    if (announce) {
      vscode.window.setStatusBarMessage('$(history) permission-wildcarding: policy already matches backup', 4000);
    }
    dashboard?.refresh();
    return null;
  }

  let written = null;
  try {
    // One atomic write carries both halves, so there is no window in which the
    // allow list is restored while its boundary is still missing.
    written = writeAllow(settings, merged, missingDeny);
    lastRun = Date.now();
    if (announce) {
      // Plain text: notification bodies do not expand codicons, so a `$(history)`
      // here reaches the user verbatim. The status-bar calls keep theirs, where
      // the substitution does happen.
      vscode.window.showInformationMessage(
        `permission-wildcarding: restored from backup — +${written.addedAllow} allow ` +
        `(${written.allow.length} ${written.allow.length === 1 ? 'entry' : 'entries'} now active)` +
        (written.addedDeny
          ? `, +${written.addedDeny} deny ${written.addedDeny === 1 ? 'rule' : 'rules'}`
          : '')
      );
    }
  } catch (err) {
    vscode.window.showErrorMessage(`permission-wildcarding: restore failed — ${err.message}`);
  }
  dashboard?.refresh();
  return written;
}

// ── memory card: recall (CPU LLM) status + vector-cache rebuild ─────────────────
// The dashboard Memory card surfaces what the lint doesn't: the state of recall.py's
// CPU embedder (bge-small ONNX) and the vector cache. Detection is a passive
// filesystem probe — no python is spawned until you click "Rebuild recall index".

// The toolbox venv python that carries onnxruntime + numpy (recall.py re-execs into it).
function toolboxPython() {
  const base = process.env.CODEX_TOOLBOX
    || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'DevToolbox');
  return path.join(base, 'python', '.venv', 'Scripts', 'python.exe');
}

// Absolute path to recall.py, resolved in order:
//   1. the configured override (permissionWildcarding.memory.recallScript)
//   2. the copy bundled into the VSIX by scripts/package.mjs — the normal case for an
//      installed extension, and why a fresh install no longer needs a checkout at all
//   3. the dev layout — vscode-extension/ sits next to memory/ (running from the repo, e.g. F5)
//   4. an open workspace folder that IS or CONTAINS the permission-wildcarding repo — it can
//      live on any drive, so probe the usual layouts (folder = repo | a projects/ dir |
//      a .claude/ root) rather than a fixed path
//   5. the ~/.claude/projects/permission-wildcarding convention
// Empty string when none resolve — the rebuild button then guides the user to set it, while
// the passive status probe keeps working regardless.
function recallScriptPath() {
  const c = vscode.workspace.getConfiguration('permissionWildcarding').get('memory.recallScript');
  if (typeof c === 'string' && c.trim() && fs.existsSync(c.trim())) return c.trim();

  const hit = (p) => (p && fs.existsSync(p) ? p : '');

  const bundled = hit(path.join(__dirname, 'memory', 'recall.py'));
  if (bundled) return bundled;

  const dev = hit(path.join(__dirname, '..', 'memory', 'recall.py'));
  if (dev) return dev;

  for (const f of vscode.workspace.workspaceFolders || []) {
    const root = f.uri.fsPath;
    const found = hit(path.join(root, 'memory', 'recall.py'))                           // folder is the repo root
      || hit(path.join(root, 'permission-wildcarding', 'memory', 'recall.py'))              // folder is a projects/ dir
      || hit(path.join(root, 'projects', 'permission-wildcarding', 'memory', 'recall.py')); // folder is a .claude/ root
    if (found) return found;
  }

  return hit(path.join(PROJECTS_DIR, 'permission-wildcarding', 'memory', 'recall.py'));
}

// Stable home for the 32MB model, deliberately outside both the extension dir and any
// checkout: the extension dir is replaced on every upgrade (which would mean a
// re-download per version), and a checkout can be deleted or sit in a synced OneDrive
// folder. Same ~/.claude/wildcarding state dir MAX mode writes its approve hook into.
const RECALL_MODEL_HOME = path.join(os.homedir(), '.claude', 'wildcarding', 'models');
const RECALL_MODEL_FILE = 'bge-small.onnx';
const RECALL_VOCAB_FILE = 'bge-small.vocab.txt';

// Every dir that could already hold the model, most stable first. These are read
// probes: an existing copy anywhere here is used as-is and never re-downloaded.
function recallModelCandidates() {
  const script = recallScriptPath();
  return [
    process.env.RECALL_MODEL_DIR,
    RECALL_MODEL_HOME,
    script ? path.join(path.dirname(script), 'models') : '',
    path.join(__dirname, 'memory', 'models'),
    path.join(__dirname, '..', 'memory', 'models'),
    'D:\\.ai-work\\projects\\desktopPet\\src\\Models',
  ].filter(Boolean);
}

// Where a *usable* bge-small lives — mirrors recall.py's own search order, and requires
// the vocab beside the model, because recall.py's Bge loads the vocab from whichever dir
// it resolved the model in. A model-only dir would resolve here and then fail at embed
// time, so it is skipped in favour of a complete one.
function recallModelDir() {
  for (const dir of recallModelCandidates()) {
    if (fs.existsSync(path.join(dir, RECALL_MODEL_FILE)) &&
        fs.existsSync(path.join(dir, RECALL_VOCAB_FILE))) return dir;
  }
  return '';
}

// A vocab to seed the model home from. Small and git-tracked, so the bundled copy is
// always available even on a machine that has never held the model.
function recallVocabSource() {
  for (const dir of recallModelCandidates()) {
    const candidate = path.join(dir, RECALL_VOCAB_FILE);
    if (fs.existsSync(candidate)) return candidate;
  }
  return '';
}

// Passive probe: is the CPU embedder ready to run? Green needs both the model asset
// and the venv that carries onnxruntime. Never runs python.
function recallStatus() {
  const py = toolboxPython();
  const modelDir = recallModelDir();
  const venv = fs.existsSync(py);
  const model = !!modelDir;
  const state = venv && model ? 'ready' : (!model ? 'model-missing' : 'venv-missing');
  return { py, modelDir, venv, model, state };
}

// Fetch the CPU recall model on demand into RECALL_MODEL_HOME. Same asset
// recall.py/desktopPet already ship (bge-small-en-v1.5, int8 ONNX, ~32MB). The model is
// gitignored and stays out of the VSIX (only the vocab is committed and bundled) because
// 32MB per release would be re-downloaded on every upgrade. Source is
// Xenova/bge-small-en-v1.5 on Hugging Face (a public repo, no token). Follows
// redirects itself (Node's https doesn't) since HF's /resolve/ URLs 302 to a CDN host.
const RECALL_MODEL_URL = 'https://huggingface.co/Xenova/bge-small-en-v1.5/resolve/main/onnx/model_quantized.onnx';
const RECALL_MODEL_MIN_BYTES = 5 * 1024 * 1024; // sanity floor — a bad URL/auth wall serves a small HTML page, not the binary

function httpsGetFollow(url, onResponse, redirectsLeft = 5) {
  const req = https.get(url, { headers: { 'User-Agent': 'permission-wildcarding' } }, (res) => {
    const loc = res.headers.location;
    if (loc && res.statusCode >= 300 && res.statusCode < 400) {
      res.resume(); // drain so the socket can be reused
      if (redirectsLeft <= 0) { onResponse(null, new Error('too many redirects')); return; }
      httpsGetFollow(new URL(loc, url).toString(), onResponse, redirectsLeft - 1);
      return;
    }
    onResponse(res, null);
  });
  req.on('error', (err) => onResponse(null, err));
  req.setTimeout(30000, () => req.destroy(new Error('timed out')));
  return req;
}

// Downloads to `<dest>.tmp` and renames on success so a cancelled/failed run never
// leaves a half-written bge-small.onnx that would falsely read as "model present".
function downloadRecallModel() {
  const modelDir = RECALL_MODEL_HOME;
  const dest = path.join(modelDir, RECALL_MODEL_FILE);
  const tmp = dest + '.tmp';
  const vocabSource = recallVocabSource();
  const vocabTarget = path.join(modelDir, RECALL_VOCAB_FILE);

  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'permission-wildcarding: downloading recall model (bge-small, ~32MB)…', cancellable: true },
    (progress, token) => new Promise((resolve) => {
      fs.mkdirSync(modelDir, { recursive: true });

      // Seed the vocab first: the model cannot load without it, and failing before a
      // 32MB transfer is friendlier than failing after one.
      if (!fs.existsSync(vocabTarget)) {
        if (!vocabSource) {
          vscode.window.showErrorMessage(
            `permission-wildcarding: ${RECALL_VOCAB_FILE} not found — cannot set up the recall model.`);
          resolve(false); return;
        }
        try { fs.copyFileSync(vocabSource, vocabTarget); }
        catch (err) {
          vscode.window.showErrorMessage(
            `permission-wildcarding: could not copy ${RECALL_VOCAB_FILE} — ${err.message}`);
          resolve(false); return;
        }
      }

      const out = fs.createWriteStream(tmp);
      let received = 0, total = 0, reported = 0, activeReq = null;

      const fail = (err) => {
        out.close();
        try { fs.unlinkSync(tmp); } catch { /* nothing to clean up */ }
        vscode.window.showErrorMessage(`permission-wildcarding: recall model download failed — ${err.message || err}`);
        resolve(false);
      };

      token.onCancellationRequested(() => activeReq?.destroy(new Error('cancelled')));

      activeReq = httpsGetFollow(RECALL_MODEL_URL, (res, err) => {
        if (err) { fail(err); return; }
        if (res.statusCode !== 200) { res.resume(); fail(new Error(`HTTP ${res.statusCode}`)); return; }
        total = Number(res.headers['content-length'] || 0);
        res.on('data', (chunk) => {
          received += chunk.length;
          if (total) {
            const pct = Math.floor((received / total) * 100);
            if (pct > reported) { progress.report({ increment: pct - reported }); reported = pct; }
          }
        });
        res.on('error', fail);
        res.pipe(out);
        out.on('finish', () => {
          out.close(() => {
            if (received < RECALL_MODEL_MIN_BYTES) { fail(new Error(`only received ${received} bytes — expected a ~32MB file`)); return; }
            fs.renameSync(tmp, dest);
            resolve(true);
          });
        });
        out.on('error', fail);
      });
    })
  );
}

// The one action the card owns: force a full re-embed of the memory dir. Spawns the
// venv python directly (so recall.py doesn't need to re-exec) with the model + corpus
// pinned via env, so the cache and the card's stats always agree on the same dir.
async function rebuildRecall() {
  const { dir } = memoryReport();
  if (!dir) {
    vscode.window.showInformationMessage('permission-wildcarding: no MEMORY.md found to index.');
    return;
  }
  const script = recallScriptPath();
  if (!script) {
    vscode.window.showWarningMessage(
      'permission-wildcarding: recall.py not found. Set its path so the card can rebuild the index.',
      'Set recall.py path…'
    ).then((c) => { if (c === 'Set recall.py path…') setRecallPath(); });
    return;
  }
  let st = recallStatus();
  if (!st.venv) {
    vscode.window.showWarningMessage(`permission-wildcarding: DevToolbox venv python not found at ${st.py} — cannot rebuild the recall index.`);
    return;
  }
  if (!st.model) {
    const choice = await vscode.window.showWarningMessage(
      'permission-wildcarding: the CPU recall model (bge-small-en-v1.5, ~32MB) isn\'t installed yet. Download it from Hugging Face now?',
      'Download', 'Cancel'
    );
    if (choice !== 'Download') return;
    const ok = await downloadRecallModel();
    if (!ok) return;
    st = recallStatus();
    if (!st.model) {
      vscode.window.showErrorMessage(
        `permission-wildcarding: model download reported success but ${RECALL_MODEL_FILE} still was not detected — check ${RECALL_MODEL_HOME}.`);
      return;
    }
  }

  vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'permission-wildcarding: rebuilding recall index…' },
    () => new Promise((resolve) => {
      const env = { ...process.env, RECALL_MODEL_DIR: st.modelDir, RECALL_MEMORY_DIR: dir, RECALL_REEXEC: '1' };
      trackChild(execFile(st.py, [script, '--rebuild'], { env, timeout: 180000 }, (err, _stdout, stderr) => {
        // A 180s rebuild easily outlives a reload, and deactivate kills it — so
        // the error this reports would be the teardown's own SIGTERM.
        if (deactivated) { resolve(); return; }
        if (err) {
          vscode.window.showErrorMessage(`permission-wildcarding: recall rebuild failed — ${(stderr || err.message || '').trim().slice(0, 300)}`);
        } else {
          const n = recallIndexCount(dir);
          vscode.window.showInformationMessage(`permission-wildcarding: recall index rebuilt${n != null ? ` — ${n} memories embedded` : ''}.`);
        }
        dashboard?.refresh();
        resolve();
      }));
    })
  );
}

// Silent background sync: no progress modal, no prompts, no downloads. Fires only when
// the script + venv + model are already present, the cache is genuinely behind the
// corpus, and the cooldown (15 min) has expired.
//
// Runs recall.py WITHOUT --rebuild, i.e. its incremental build_or_update: entries for
// deleted files are dropped, only changed files are re-embedded, and the ONNX session is
// not even constructed when there is nothing to do. --rebuild is force=True and belongs
// to the button, where the user asked for a full re-embed; on this path it re-embedded
// the entire corpus every tick — and because staleness was a count comparison against a
// file set that included MEMORY.md (which recall.py never embeds), every tick was 'stale'.
const RECALL_AUTO_COOLDOWN_MS = 15 * 60 * 1000;
function autoSyncRecallIfStale() {
  try {
    // Checked before the spawn, not only in the callback: a child started after
    // teardown is one killLiveChildren() has already been past.
    if (deactivated) return;
    if (Date.now() - recallRebuildAt < RECALL_AUTO_COOLDOWN_MS) return;
    const { dir } = memoryReport();
    if (!dir) return;
    const script = recallScriptPath();
    const st = recallStatus();
    // Only sync when everything is already in place — no downloads, no prompts.
    if (!script || !st.venv || !st.model) return;
    if (!recallIndexStatus(dir).stale) return; // cache already matches the corpus
    recallRebuildAt = Date.now();
    const env = { ...process.env, RECALL_MODEL_DIR: st.modelDir, RECALL_MEMORY_DIR: dir, RECALL_REEXEC: '1' };
    trackChild(execFile(st.py, [script, '--list'], { env, timeout: 180000 }, (err, _stdout, stderr) => {
      if (deactivated) return;
      if (!err) {
        const n = recallIndexCount(dir);
        vscode.window.setStatusBarMessage(
          `$(book) Recall index synced${n != null ? ` — ${n} memories embedded` : ''}`, 5000
        );
      } else {
        console.error('permission-wildcarding: auto recall sync failed —', (stderr || err.message || '').trim().slice(0, 300));
      }
      dashboard?.refresh();
    }));
  } catch { /* auto-sync is best-effort — never break anything else */ }
}

async function setRecallPath() {
  const val = await vscode.window.showInputBox({
    title: 'permission-wildcarding: path to recall.py',
    prompt: "Absolute path to your permission-wildcarding repo's memory/recall.py",
    value: recallScriptPath(),
    ignoreFocusOut: true,
  });
  if (val && val.trim()) {
    await vscode.workspace.getConfiguration('permissionWildcarding')
      .update('memory.recallScript', val.trim(), vscode.ConfigurationTarget.Global);
    dashboard?.refresh();
  }
}

// The Memory card's data payload (pure Node). null when there's no MEMORY.md at all.
//
// `report` is optional and defaults to a fresh call, so the ~35 non-dashboard
// callers are unaffected. _push() passes one in because gatesCardData needs a
// single integer out of the same object, and computing it twice cost 2.93 ms and
// 25 fs syscalls per refresh (measured: one memoryReport() 6.99 ms, two 9.92 ms,
// 12 readFileSync + 11 existsSync + 2 readdirSync each).
function memoryCardData(precomputed = null) {
  let out = null;
  try {
    const { conf, dir, report } = precomputed || memoryReport();
    // `conf.enabled` is honoured here, not just discovered. memoryLint.activate()
    // returns early when memory.enabled is false and so never registers
    // `permission-wildcarding.lintMemory`, while this card gated on `dir &&
    // report` alone — so with the feature switched off the card still rendered
    // and its link posted a command that does not exist, which VS Code reports
    // as "command not found". Same key, two components, one of them ignoring it.
    if (conf.enabled !== false && dir && report) {
      const st = recallStatus();
      // embedded/indexable both exclude MEMORY.md, so a complete cache reads N of N
      // rather than looking one short forever.
      const recall = recallIndexStatus(dir);
      out = {
        dir: dir.replace(os.homedir(), '~'),
        tokens: report.tokens,
        budgetTokens: Math.round(conf.totalBudget / 4),
        overBudget: report.bytes > conf.totalBudget,
        files: report.fileCount,
        indexable: recall.indexable,
        embedded: recall.embedded,
        stale: recall.stale,
        over: report.over.length,
        broken: report.broken.length,
        unresolved: report.unresolved.length,
        llm: st.state,
        modelDir: st.modelDir ? st.modelDir.replace(os.homedir(), '~') : null,
        canRebuild: !!recallScriptPath() && st.venv && st.model,
      };
    }
  } catch { /* memory card is optional — never break the dashboard */ }
  return out;
}

// ── activation ────────────────────────────────────────────────────────────────
// Cross-agent Auto Learn keeps transcript text in memory only. Persistent state
// contains normalized prefixes, counters, reason labels, hashes, and cursors.
function autoLearnConfig() {
  const cfg = vscode.workspace.getConfiguration('permissionWildcarding');
  const mode = cfg.get('autoLearn.mode', 'recommend');
  const codexScope = cfg.get('autoLearn.codexScope', 'user');
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const trustedWorkspaceRoot = vscode.workspace.isTrusted ? workspaceRoot : null;
  let codexRulesPath = path.join(os.homedir(), '.codex', 'rules', 'permission-wildcarding.rules');
  let scopeWarning = '';
  if (codexScope === 'off') codexRulesPath = null;
  else if (codexScope === 'workspace') {
    if (!trustedWorkspaceRoot) {
      codexRulesPath = null;
      scopeWarning = 'Workspace Codex rules require an open trusted workspace.';
    } else {
      codexRulesPath = path.join(trustedWorkspaceRoot, '.codex', 'rules', 'permission-wildcarding.rules');
    }
  }
  return {
    enabled: cfg.get('autoLearn.enabled', true),
    mode: ['observe', 'recommend', 'auto-safe'].includes(mode) ? mode : 'recommend',
    threshold: Math.max(1, Math.floor(cfg.get('autoLearn.successThreshold', 3))),
    intervalMinutes: Math.max(1, Number(cfg.get('autoLearn.intervalMinutes', 5)) || 5),
    debounceSeconds: Math.max(1, Number(cfg.get('autoLearn.debounceSeconds', 20)) || 20),
    codexScope,
    codexRulesPath,
    codexExecutable: cfg.get('autoLearn.codexExecutable', 'codex') || 'codex',
    scopeWarning,
    // Evidence/state is partitioned and cwd-filtered by the open workspace
    // independently of where generated Codex policy is exported. Trust is
    // required only before writing or evaluating workspace-owned rules.
    workspaceRoot,
    codexWorkspaceRoot: trustedWorkspaceRoot,
  };
}

function autoLearnManagerOptions(cfg = autoLearnConfig()) {
  return {
    home: os.homedir(), homeDir: os.homedir(), mode: cfg.mode,
    threshold: cfg.threshold, successThreshold: cfg.threshold,
    codexRulesPath: cfg.codexRulesPath, codexExecutable: cfg.codexExecutable,
    workspaceRoot: cfg.workspaceRoot,
    paths: {
      claudeHistory: PROJECTS_DIR,
      codexHistory: CODEX_SESSIONS_DIR,
      claudeSettings: SETTINGS,
      codexRules: cfg.codexRulesPath,
    },
  };
}

function getAutoLearnManager() {
  const cfg = autoLearnConfig();
  const key = JSON.stringify({
    home: os.homedir(), mode: cfg.mode, threshold: cfg.threshold,
    codexRulesPath: cfg.codexRulesPath, codexExecutable: cfg.codexExecutable,
    workspaceRoot: cfg.workspaceRoot,
  });
  if (autoLearnManager && key === autoLearnManagerKey) return autoLearnManager;
  autoLearnManager = createAutoLearnManager(autoLearnManagerOptions(cfg));
  autoLearnManagerKey = key;
  return autoLearnManager;
}

function invalidateAutoLearnManager() {
  autoLearnManager = null;
  autoLearnManagerKey = '';
  autoLearnCardCache = null;
}

// The worker is spawned by PATH, so the Module._load redirect a test installs
// cannot reach it: `./src/` exists only in a packaged extension, where
// scripts/package.mjs copies repo-root src/ next to this file, and is generated
// and gitignored in the repository. Same split requireShared() handles in
// autoLearnUi.js. Without the fallback a scan dies with MODULE_NOT_FOUND on any
// fresh checkout, which is CI (npm test runs before packaging) and anyone
// debugging the extension from source.
function autoLearnWorkerPath() {
  const packaged = path.join(__dirname, 'src', 'auto-learn-worker.js');
  if (fs.existsSync(packaged)) return packaged;
  const repository = path.join(__dirname, '..', 'src', 'auto-learn-worker.js');
  return fs.existsSync(repository) ? repository : packaged;
}

function getAutoLearnWorkerRunner() {
  if (!autoLearnWorkerRunner) {
    autoLearnWorkerRunner = createAutoLearnWorkerRunner({
      workerPath: autoLearnWorkerPath(),
      optionsProvider: () => autoLearnManagerOptions(),
      onMutation: () => invalidateAutoLearnManager(),
    });
  }
  return autoLearnWorkerRunner;
}

function runAutoLearnWorker(operation, ...args) {
  // The `deactivated` check has to live HERE, not in the runner. deactivate()
  // nulls `autoLearnWorkerRunner` so a same-realm re-activate can get a working
  // one — which means a late call arriving after teardown finds an empty slot,
  // and getAutoLearnWorkerRunner() cheerfully builds a FRESH runner with
  // `deactivating: false`. Its own guard cannot see the teardown that already
  // happened. So the caller that used to be refused forever ("Auto Learn is
  // deactivating") would instead start a real Worker post-teardown and let it
  // write settings.json, the claims registry and the Codex rules file.
  //
  // Rejecting rather than resolving: every caller treats this as an operation
  // that either produced a result or failed, and a silent success would be read
  // as "the scan found nothing".
  if (deactivated) {
    return Promise.reject(new Error('Auto Learn is deactivating'));
  }
  return getAutoLearnWorkerRunner().run(operation, ...args);
}

function managerStatus(manager) {
  if (typeof manager?.status === 'function') return manager.status();
  if (typeof manager?.getStatus === 'function') return manager.getStatus();
  return {};
}

function managerCandidates(manager, options) {
  const value = typeof manager?.listCandidates === 'function'
    ? manager.listCandidates(options)
    : (typeof manager?.getCandidates === 'function' ? manager.getCandidates(options) : []);
  return Array.isArray(value) ? value : (Array.isArray(value?.candidates) ? value.candidates : []);
}

function countAutoLearnCandidates(candidates, status = {}, requiredTargets = ['claude'], mode = 'recommend', settings = null) {
  const pending = candidates.filter((candidate) =>
    !isCandidateComplete(candidate, status, requiredTargets));
  if (mode === 'observe') {
    return { total: candidates.length, safe: 0, review: 0, covered: 0, observe: pending.length, applied: candidates.length - pending.length };
  }
  const reviewable = reviewableCandidates(candidates, status, requiredTargets, settings);
  return {
    total: candidates.length,
    safe: pending.filter((candidate) => candidate.autoSafe || candidate.disposition === 'auto-safe').length,
    review: reviewable.candidates.length,
    covered: reviewable.covered.length,
    observe: pending.filter((candidate) => candidate.disposition === 'observe').length,
    applied: candidates.length - pending.length,
  };
}

function autoLearnStateStamp(manager) {
  try {
    const stat = fs.statSync(manager?.paths?.state);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch { return 'absent'; }
}

function autoLearnEvidence(cfg) {
  const manager = getAutoLearnManager();
  const key = `${autoLearnManagerKey}|${autoLearnStateStamp(manager)}`;
  if (autoLearnCardCache?.key === key) return autoLearnCardCache.data;
  const data = typeof manager?.overview === 'function'
    ? (() => {
      const view = manager.overview();
      return {
        status: view?.status || {},
        candidates: Array.isArray(view?.candidates) ? view.candidates : [],
      };
    })()
    : { status: managerStatus(manager) || {}, candidates: managerCandidates(manager) };
  autoLearnCardCache = { key, data };
  return data;
}

function autoLearnCardData() {
  const cfg = autoLearnConfig();
  let status = {};
  let candidates = [];
  try {
    ({ status, candidates } = autoLearnEvidence(cfg));
  } catch (error) {
    autoLearnLastError = error.message;
  }
  return {
    enabled: cfg.enabled, mode: cfg.mode, threshold: cfg.threshold,
    codexScope: cfg.codexScope, scopeWarning: cfg.scopeWarning,
    busy: autoLearnBusy, error: autoLearnLastError,
    lastScanAt: status.lastScanAt || status.lastScan || null,
    lastApplyAt: status.lastApplyAt || status.lastApplicationAt || null,
    counts: countAutoLearnCandidates(
      candidates, status, cfg.codexRulesPath ? ['claude', 'codex'] : ['claude'], cfg.mode, readSettings(),
    ),
    canUndo: Boolean(status.canUndo || status.lastApplication),
  };
}

function autoLearnApplicationMessage(summary, verb = 'applied') {
  const count = summary?.appliedCount || 0;
  const targets = uniqueTargets(summary?.changedTargets);
  if (!targets.length) {
    return count
      ? `Auto Learn recorded ${count} already-covered command ${count === 1 ? 'family' : 'families'}; no policy file changed.`
      : 'Auto Learn did not change a policy file.';
  }
  const scope = policyTargetLabel(targets);
  if (!count) return `Auto Learn reconciled ${scope} policy.` + codexRestartSuffix(targets);
  return `Auto Learn ${verb} ${count} command ${count === 1 ? 'family' : 'families'} in ${scope}.` +
    codexRestartSuffix(targets);
}

async function runAutoLearnScan(manual = false, suppressApplicationNotice = false) {
  const cfg = autoLearnConfig();
  if (!cfg.enabled && !manual) return null;
  if (!manual && Date.now() < autoLearnNextRetryAt) return null;
  if (autoLearnBusy) {
    if (manual) vscode.window.setStatusBarMessage('$(sync~spin) Auto Learn scan already running', 3000);
    return null;
  }
  autoLearnBusy = true;
  autoLearnLastError = null;
  dashboard?.refresh();
  if (manual) vscode.window.setStatusBarMessage('$(sync~spin) Auto Learn: scanning Claude + Codex history…', 4000);
  await new Promise((resolve) => setTimeout(resolve, 0));
  try {
    const result = await runAutoLearnWorker('scan', { mode: cfg.mode, threshold: cfg.threshold });
    autoLearnFailureCount = 0;
    autoLearnNextRetryAt = 0;
    const manager = getAutoLearnManager();
    const status = managerStatus(manager);
    const counts = countAutoLearnCandidates(
      managerCandidates(manager), status, cfg.codexRulesPath ? ['claude', 'codex'] : ['claude'], cfg.mode,
      readSettings(),
    );
    const summary = applicationSummary(result);
    const applied = summary.appliedCount;
    if (manual) {
      let message = `Auto Learn: ${counts.safe} safe, ${counts.review} review, ${counts.observe} still observing`;
      if (applied && summary.changedTargets.length) {
        message += `; auto-applied ${applied} in ${policyTargetLabel(summary.changedTargets)}`;
      } else if (applied) {
        message += `; recorded ${applied} already-covered ${applied === 1 ? 'family' : 'families'}`;
      } else if (summary.changedTargets.length) {
        message += `; reconciled ${policyTargetLabel(summary.changedTargets)} policy`;
      }
      vscode.window.showInformationMessage(
        message + '.' + codexRestartSuffix(summary.changedTargets)
      );
    } else if ((applied || summary.changedTargets.length) && !suppressApplicationNotice) {
      vscode.window.showInformationMessage(autoLearnApplicationMessage(summary, 'safely applied'));
    }
    return result;
  } catch (error) {
    autoLearnLastError = error.message;
    if (!manual) {
      autoLearnFailureCount += 1;
      // Retry transient failures, without hammering a deterministic bad history
      // record on every watcher event. A successful scan resets this backoff.
      const delayMinutes = Math.min(60, 2 ** Math.min(autoLearnFailureCount - 1, 6));
      autoLearnNextRetryAt = Date.now() + delayMinutes * 60 * 1000;
    }
    if (manual) vscode.window.showErrorMessage(`Auto Learn scan failed: ${error.message}`);
    else console.error('permission-wildcarding: Auto Learn scan failed —', error);
    return null;
  } finally {
    autoLearnBusy = false;
    dashboard?.refresh();
  }
}

async function applyAutoLearnSafe() {
  const cfg = autoLearnConfig();
  if (!cfg.enabled) {
    vscode.window.showWarningMessage('Auto Learn is disabled in settings. Enable it before applying policy.');
    return;
  }
  if (cfg.mode === 'observe') {
    vscode.window.showWarningMessage('Auto Learn is in observe mode. Switch to recommend or auto-safe before applying policy.');
    return;
  }
  const scanResult = await runAutoLearnScan(false, true);
  if (scanResult === null) return;
  const scanSummary = applicationSummary(scanResult);
  try {
    const result = await runAutoLearnWorker('apply', { includeReviewed: false });
    const summary = applicationSummary(scanResult, result);
    const count = summary.appliedCount;
    if (!count && !summary.changedTargets.length) {
      vscode.window.showInformationMessage('Auto Learn: no unapplied safe candidates meet the threshold.');
    }
    else vscode.window.showInformationMessage(autoLearnApplicationMessage(summary, 'applied'));
  } catch (error) {
    autoLearnLastError = error.message;
    if (scanSummary.appliedCount || scanSummary.changedTargets.length) {
      vscode.window.showInformationMessage(
        autoLearnApplicationMessage(scanSummary, 'safely applied during the prerequisite scan')
      );
    }
    vscode.window.showErrorMessage(`Auto Learn apply failed after scanning: ${error.message}`);
  }
  dashboard?.refresh();
}

async function reviewAutoLearnCandidates() {
  const cfg = autoLearnConfig();
  if (!cfg.enabled) {
    vscode.window.showWarningMessage('Auto Learn is disabled in settings. Enable it before reviewing candidates.');
    return;
  }
  if (cfg.mode === 'observe') {
    vscode.window.showWarningMessage('Auto Learn is in observe mode. Switch to recommend to review candidates.');
    return;
  }
  const scanResult = await runAutoLearnScan(false, true);
  if (scanResult === null) return;
  const scanSummary = applicationSummary(scanResult);
  const notifyScanApplication = () => {
    if (scanSummary.appliedCount || scanSummary.changedTargets.length) {
      vscode.window.showInformationMessage(
        autoLearnApplicationMessage(scanSummary, 'safely applied during the review scan')
      );
    }
  };
  const manager = getAutoLearnManager();
  const status = managerStatus(manager);
  const requiredTargets = cfg.codexRulesPath ? ['claude', 'codex'] : ['claude'];
  const settingsNow = readSettings();
  const { covered, candidates } = reviewableCandidates(
    managerCandidates(manager), status, requiredTargets, settingsNow,
  );
  const coveredNote = covered.length
    ? ` (${covered.length} already covered by existing allow rules — hidden)`
    : '';
  // A family a managed ask covers is withheld from this list, because no rule
  // written from here can stop its prompt. Withholding it silently was the
  // whole problem: the prompts kept arriving with nothing in Review to explain
  // them, and a grant already in settings.json looked like it had just failed.
  // The wording lives in autoLearnUi.js, where it is under test.
  const managed = status.managed || {};
  const blockedCount = (managed.inertFamilies || []).length;
  const blockedNote = managedBlockedNote(managed);
  const showBlockedDetail = () => {
    const channel = sharedChannel({ fresh: true });
    for (const line of managedBlockedDetail(managed)) channel.appendLine(line);
    channel.show(true);
  };
  if (!candidates.length) {
    if (scanSummary.appliedCount || scanSummary.changedTargets.length) notifyScanApplication();
    else if (blockedCount || managed.degraded) {
      vscode.window.showInformationMessage(
        `Auto Learn: no candidates are ready for review${coveredNote}${blockedNote}.`,
        'Show blocked'
      ).then((choice) => { if (choice === 'Show blocked') showBlockedDetail(); });
    } else {
      vscode.window.showInformationMessage(
        `Auto Learn: no candidates are ready for review${coveredNote}.`
      );
    }
    return;
  }
  // A deny or ask rule beats a user allow entry, and managed policy can supply
  // either. Say so up front rather than letting a granted family keep prompting.
  const overrideOf = (candidate) => {
    if (!candidate.claudePermission) return null;
    const { decision } = claudePermissionDecision(settingsNow, candidate.claudePermission);
    return decision === 'deny' || decision === 'ask' ? decision : null;
  };
  const picks = await vscode.window.showQuickPick(candidates.map((candidate) => ({
    label: `${candidate.claudePermission || candidate.prefix?.join(' ') || candidate.key} [pending: ${policyTargetLabel(candidatePendingTargets(candidate, status, requiredTargets))}]`,
    description: `${candidate.counts?.success ?? candidate.successfulRuns ?? 0} successes · ${candidate.risk}`,
    detail: [overrideOf(candidate) ? `policy ${overrideOf(candidate)} overrides this grant` : null,
      candidate.autoSafe ? 'safe' : 'manual review',
      (candidate.sources || []).join(' + '), (candidate.reasons || []).join(', ')]
      .filter(Boolean).join(' · '),
    candidate,
  })), {
    canPickMany: true,
    ignoreFocusOut: true,
    title: `Auto Learn candidates${coveredNote}${blockedNote}`,
    placeHolder: 'Select command families to add to Claude permissions and validated Codex rules',
  });
  if (!picks?.length) { notifyScanApplication(); return; }
  // Confirm on risk and policy override, not on auto-safe eligibility — see
  // selectionsNeedingConfirmation in autoLearnUi.js for why.
  const notable = selectionsNeedingConfirmation(
    picks.map((pick) => pick.candidate), overrideOf,
  );
  if (notable.length) {
    const named = notable.slice(0, 6).map((entry) => {
      const label = entry.candidate.claudePermission ||
        entry.candidate.prefix?.join(' ') || entry.candidate.key;
      return entry.override
        ? `  ${label} — ${entry.candidate.risk}, but policy ${entry.override} overrides this grant`
        : `  ${label} — ${entry.candidate.risk}`;
    });
    const more = notable.length - named.length;
    const answer = await vscode.window.showWarningMessage(
      `Grant ${picks.length} command ${picks.length === 1 ? 'family' : 'families'}?`,
      {
        modal: true,
        detail: [
          `${notable.length} of them ${notable.length === 1 ? 'is' : 'are'} not plain read-only:`,
          '',
          ...named,
          ...(more > 0 ? [`  …and ${more} more`] : []),
          '',
          'permissions.deny and managed policy still win.',
        ].join('\n'),
      },
      'Grant'
    );
    if (answer !== 'Grant') { notifyScanApplication(); return; }
  }
  try {
    const expectedFingerprints = Object.fromEntries(
      picks.map((pick) => [pick.candidate.key, pick.candidate.fingerprint]),
    );
    const result = await runAutoLearnWorker('apply', {
      keys: picks.map((pick) => pick.candidate.key),
      includeReviewed: true,
      expectedFingerprints,
    });
    const summary = applicationSummary(scanResult, result);
    vscode.window.showInformationMessage(summary.appliedCount || summary.changedTargets.length
      ? autoLearnApplicationMessage(summary, 'applied after review')
      : 'Auto Learn: the selected candidates were already covered or structurally ineligible.');
  } catch (error) {
    autoLearnLastError = error.message;
    notifyScanApplication();
    vscode.window.showErrorMessage(`Auto Learn reviewed selection was not applied: ${error.message}`);
  }
  dashboard?.refresh();
}

async function undoAutoLearn() {
  try {
    const result = await runAutoLearnWorker('undo');
    if (result?.changed === false || result?.undone === false) {
      vscode.window.showInformationMessage(result?.reason || 'Auto Learn: nothing to undo.');
    } else {
      const targets = uniqueTargets(result?.restoredTargets);
      vscode.window.showInformationMessage(
        `Auto Learn restored ${policyTargetLabel(targets)} from before its last application.` +
        codexRestartSuffix(targets)
      );
    }
  } catch (error) {
    autoLearnLastError = error.message;
    vscode.window.showErrorMessage(`Auto Learn undo stopped: ${error.message}`);
  }
  dashboard?.refresh();
}

async function cycleAutoLearnMode() {
  const order = ['observe', 'recommend', 'auto-safe'];
  const cfg = autoLearnConfig();
  const next = order[(order.indexOf(cfg.mode) + 1) % order.length];
  if (next === 'auto-safe') {
    const answer = await vscode.window.showWarningMessage(
      `Turn on Auto Learn auto-safe mode? Only deterministic read-only families with ${cfg.threshold}+ successful runs are eligible; every other risk class stays review-only.`,
      { modal: true }, 'Enable auto-safe'
    );
    if (answer !== 'Enable auto-safe') return;
  }
  await vscode.workspace.getConfiguration('permissionWildcarding')
    .update('autoLearn.mode', next, (() => {
      const inspected = vscode.workspace.getConfiguration('permissionWildcarding').inspect('autoLearn.mode');
      if (inspected?.workspaceFolderValue !== undefined) return vscode.ConfigurationTarget.WorkspaceFolder;
      if (inspected?.workspaceValue !== undefined) return vscode.ConfigurationTarget.Workspace;
      return vscode.ConfigurationTarget.Global;
    })());
  invalidateAutoLearnManager();
  vscode.window.showInformationMessage(`Auto Learn mode: ${next}.`);
  scheduleAutoLearn(50);
  dashboard?.refresh();
}

function execFileCaptured(executable, args) {
  // Same PATHEXT asymmetry the Auto Learn validator hits: a bare name that a
  // PATH check finds can still be unlaunchable when it resolves to a shim.
  const launch = commandLaunch(executable, args);
  return new Promise((resolve, reject) => {
    trackChild(execFile(launch.file, launch.args, {
      windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024, ...launch.options,
    }, (error, stdout, stderr) => {
      if (error) {
        error.detail = String(stderr || stdout || error.message).trim();
        reject(error);
        return;
      }
      resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
    }));
  });
}

function codexRuleFiles(cfg) {
  const directories = [path.join(os.homedir(), '.codex', 'rules')];
  if (cfg.codexWorkspaceRoot) directories.push(path.join(cfg.codexWorkspaceRoot, '.codex', 'rules'));
  const files = [];
  for (const directory of directories) {
    let entries = [];
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (entry.isFile() && entry.name.toLowerCase().endsWith('.rules')) {
        files.push(path.join(directory, entry.name));
      }
    }
  }
  if (cfg.codexRulesPath && fs.existsSync(cfg.codexRulesPath)) files.push(cfg.codexRulesPath);
  return [...new Set(files.map((file) => path.resolve(file)))].sort();
}

function learnedCandidateExplanation(invocation, learned, target, threshold) {
  const label = invocation.prefix?.join(' ') || candidateKey(invocation);
  if (!learned) return `${label}: no correlated history evidence has been learned yet.`;
  const success = learned.counts?.success ?? learned.successfulRuns ?? 0;
  const failed = learned.counts?.failed ?? learned.failedRuns ?? 0;
  const pending = candidatePendingTargets(learned, {}, [target]);
  const state = learned.autoSafe ? 'auto-safe'
    : learned.disposition === 'review' ? 'review required' : `observing until ${threshold} successes`;
  return `${label}: ${success} successful, ${failed} failed; ${state}` +
    (pending.length ? `; pending for ${pending.join(' + ')}` : '; already applied or ineligible for this target') + '.';
}

function execpolicyOutputSummary(output) {
  const text = String(output || '').trim();
  try {
    const parsed = JSON.parse(text);
    const decision = parsed.decision || 'no decision (prompt/default policy)';
    const matches = Array.isArray(parsed.matchedRules) ? parsed.matchedRules.length : 0;
    return `decision: ${decision}; matched rules: ${matches}\n${JSON.stringify(parsed, null, 2)}`;
  } catch {
    return text || 'No output returned.';
  }
}

function windowsPowerShellExecutable() {
  const root = process.env.SystemRoot || process.env.WINDIR;
  if (!root) return null;
  const executable = path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return fs.existsSync(executable) ? executable : null;
}

// Reachable whatever Review is showing. The detail used to hang off the
// "no candidates" toast, which is the one situation where nobody is being
// prompted: a busy list is exactly when you want to know which prompts cannot be
// fixed, and that was the case with no route to the answer.
function showAutoLearnBlocked() {
  let managed;
  try { managed = managerStatus(getAutoLearnManager()).managed; }
  catch (error) {
    vscode.window.showErrorMessage(`Auto Learn could not read its state: ${error.message}`);
    return;
  }
  const blocked = (managed && managed.inertFamilies) || [];
  if (!managed || (managed.policy === 'absent' && !blocked.length)) {
    vscode.window.showInformationMessage(
      'Auto Learn: no managed policy is present, so nothing is blocked by one.');
    return;
  }
  if (!managed.degraded && !blocked.length && !(managed.deadAllowEntries || []).length) {
    vscode.window.showInformationMessage(
      'Auto Learn: no command family is blocked by your managed policy.');
    return;
  }
  const channel = sharedChannel({ fresh: true });
  for (const line of managedBlockedDetail(managed)) channel.appendLine(line);
  channel.show(true);
}

// The one lever left for a managed rule no grant can beat. Deliberately a
// per-item decision rather than a single "apply all" button: this writes a
// standing instruction into the user's own CLAUDE.md, and a bulk write leaves
// every line in that file indistinguishable from every other, which is the
// state a hand-maintained gates block is already in.
async function showDerivedGuidance() {
  let review;
  try { review = getAutoLearnManager().derivedReview(); }
  catch (error) {
    vscode.window.showErrorMessage(`Derived guidance could not be computed: ${error.message}`);
    return;
  }
  const items = derivedGuidanceItems(review);
  if (!items.length) {
    // Not an error, and usually the good outcome. Say which it is.
    vscode.window.showInformationMessage(`Derived guidance: ${derivedGuidanceSummary(review)}`);
    return;
  }
  const pick = await vscode.window.showQuickPick(items, {
    title: `Derived guidance — ${derivedGuidanceSummary(review)}`,
    placeHolder: 'Behaviour that reduces a prompt no allow rule can stop',
    matchOnDetail: true,
  });
  if (!pick) return;

  const choices = [
    { label: 'Accept', value: 'accept', description: `Write this into your instruction file (${pick.rule})` },
    { label: 'Decline', value: 'decline', description: 'Never offer this one again' },
    { label: 'Reset', value: 'reset', description: 'Back to undecided, and remove it if installed' },
  ];
  const decision = await vscode.window.showQuickPick(choices, {
    title: pick.label, placeHolder: `Currently ${pick.state}`,
  });
  if (!decision) return;

  try {
    const result = getAutoLearnManager().decideDerived(pick.id, decision.value);
    const wrote = (result.targets || []).filter((target) => target.changed);
    const failed = (result.targets || []).filter((target) => target.error);
    if (failed.length) {
      vscode.window.showWarningMessage(
        `Derived guidance ${decision.value}: ${failed.map((t) => t.error).join('; ')}`);
      return;
    }
    vscode.window.showInformationMessage(wrote.length
      ? `Derived guidance ${decision.value}: updated ${wrote.map((t) => t.agent).join(', ')}. ` +
        'Loaded from the next session on.'
      : `Derived guidance ${decision.value}: recorded, no instruction file needed changing.`);
  } catch (error) {
    vscode.window.showErrorMessage(`Derived guidance ${decision.value} failed: ${error.message}`);
  }
}

async function explainAutoLearnPrompt() {
  const agentPick = await vscode.window.showQuickPick([
    { label: 'Claude Code', value: 'claude', description: 'Evaluate deny, ask, and allow precedence' },
    { label: 'Codex', value: 'codex', description: 'Run codex execpolicy check against visible rules' },
  ], { title: 'Which agent showed the approval prompt?' });
  if (!agentPick) return;

  const shell = await vscode.window.showQuickPick(['PowerShell', 'Bash'], {
    title: 'Which shell syntax should Auto Learn parse?',
  });
  if (!shell) return;
  const command = await vscode.window.showInputBox({
    title: `Why did ${agentPick.label} prompt?`,
    prompt: 'Paste the shell command. It is analyzed in memory and is not saved.',
    ignoreFocusOut: true,
  });
  if (!command) return;

  const invocations = extractInvocations(shell, command, { source: 'manual' });
  if (!invocations.length) {
    vscode.window.showInformationMessage('Auto Learn could not derive a stable command family from that shell expression.');
    return;
  }

  const cfg = autoLearnConfig();
  let candidates = new Map();
  try {
    candidates = new Map(managerCandidates(getAutoLearnManager())
      .map((candidate) => [candidate.key, candidate]));
  } catch { /* Policy analysis still works if learner state is temporarily unavailable. */ }

  if (agentPick.value === 'claude') {
    const settings = readSettings() || {};
    const details = invocations.map((invocation) => {
      const exact = `${shell}(${invocation.command || command})`;
      const learned = candidates.get(candidateKey(invocation));
      const assessment = claudePermissionDecision(settings, exact);
      let explanation = claudeDecisionExplanation(assessment);
      // Name the managed rule rather than gesturing at "org policy". A managed
      // ask is the single most likely reason a command whose allow entry matches
      // is still prompting, and it is knowable from the cached policy, so
      // pointing at the server-side capability list below was naming the wrong
      // cause: those restrictions have nothing to do with a command prompt.
      let managedNote = null;
      try { managedNote = managedPromptExplanation(getAutoLearnManager().explainManaged(exact)); }
      catch { /* Policy analysis is best-effort; the precedence answer still stands. */ }
      if (managedNote) explanation += `\n${managedNote}`;
      else if (assessment.decision === 'allow') {
        explanation += ' If Claude still prompted, org policy is the remaining explanation — see below.';
      }
      return `${exact}\n${explanation}\nLearner: ${learnedCandidateExplanation(
        invocation, learned, 'claude', cfg.threshold,
      )}`;
    });
    // Name the org policy explicitly. Saying "check managed policy" is useless
    // advice on a console-managed org, where there is no managed-settings.json to
    // check: restrictions are configured server-side and only their cached
    // effects are visible locally. An unqualified "ALLOW" here is exactly the
    // wrong answer to give someone whose org is prompting them.
    const restrictions = policyRestrictions(readPolicyLimits());
    const orgNote = restrictions.length
      ? `\n\nYour organization applies server-side restrictions (${policyLimitsPath()}):\n` +
        restrictions.map((name) => `  ${name}: not allowed`).join('\n') +
        '\nThese are configured in the org console, not in any local settings file, so the ' +
        'verdict above reflects your user settings only.'
      : '\n\nNo server-delivered org restrictions were found locally, but a console-managed org ' +
        'can still apply policy that leaves no local trace.';
    vscode.window.showInformationMessage('Claude permission analysis', {
      modal: true,
      detail: `Precedence: managed/org policy > deny > ask > allow > session default.\n\n${details.join('\n\n')}${orgNote}`,
    });
    return;
  }

  // The enterprise bundle outranks every user rule, so check it first. Reporting
  // "no local rule allows this" for a command the org forces a prompt on names
  // the wrong cause, and the fix it implies (write a rule) cannot work.
  const bundle = readEnterpriseBundle();
  const enterprise = invocations
    .map((invocation) => ({ invocation, rule: enterpriseDecisionFor(bundle, invocation.argv) }))
    .filter((entry) => entry.rule);
  if (enterprise.length) {
    const target = targetApproval(bundle);
    vscode.window.showInformationMessage('Codex enterprise policy', {
      modal: true,
      detail: [
        'Your organization\'s Codex policy governs this command directly, and it outranks any ' +
        'rule Auto Learn can write:',
        '',
        ...enterprise.map((entry) =>
          `  ${entry.rule.root} — decision "${entry.rule.decision}"\n    ${entry.rule.justification}`),
        '',
        target.restricted
          ? `Approval policy is also capped: the org allows only [${(target.allowed || []).join(', ')}], ` +
            'so "never" cannot be set. Codex MAX applies the least-friction policy permitted.'
          : 'No approval-policy cap was found.',
        '',
        'A user rule cannot override this. The prompt is the policy working as configured.',
      ].join('\n'),
    });
    return;
  }

  const rules = codexRuleFiles(cfg);
  if (!rules.length) {
    vscode.window.showInformationMessage('Codex execpolicy analysis', {
      modal: true,
      detail: 'No enterprise rule governs this command, and no user or trusted-workspace .rules files are currently visible, so Codex has no local prefix rule to allow it. This check cannot see session approval state or sandbox restrictions.',
    });
    return;
  }

  const variants = [];
  for (let index = 0; index < invocations.length; index += 1) {
    variants.push(...codexCheckVariants(
      shell,
      index === 0 ? command : invocations[index].command,
      invocations[index],
      index === 0 ? windowsPowerShellExecutable() : null,
    ));
  }
  const uniqueVariants = [...new Map(variants.map((item) => [JSON.stringify(item.argv), item])).values()];
  try {
    const checks = [];
    for (const variant of uniqueVariants) {
      const result = await execFileCaptured(
        cfg.codexExecutable, codexExecpolicyArgs(rules, variant.argv),
      );
      checks.push(`${variant.label}: ${JSON.stringify(variant.argv)}\n${execpolicyOutputSummary(result.stdout)}`);
    }
    const learned = invocations.map((invocation) => learnedCandidateExplanation(
      invocation, candidates.get(candidateKey(invocation)), 'codex', cfg.threshold,
    ));
    vscode.window.showInformationMessage('Codex execpolicy analysis', {
      modal: true,
      detail: `Rules checked:\n${rules.map((file) => `- ${file.replace(os.homedir(), '~')}`).join('\n')}` +
        `\n\n${checks.join('\n\n')}\n\nLearner:\n${learned.join('\n')}` +
        '\n\nScope limitation: only visible user and trusted-workspace rule files were checked; managed/system policy, session approval state, and sandbox restrictions may still prompt.',
    });
  } catch (error) {
    // The rejection may be our own teardown: deactivate kills the child, which
    // surfaces here as a failed check the user never caused.
    if (deactivated) return;
    vscode.window.showErrorMessage(
      `Codex execpolicy check failed without changing rules: ${error.detail || error.message}`
    );
  }
}

// A bare call is a watcher-driven reactive scan: coalesce a burst of transcript
// writes and scan once activity settles, using the configurable debounce (the
// thing that felt too frequent at its old 1.2s). Explicit-delay callers are
// deliberate quick refreshes after a specific action and pass their own value.
// Guarded like schedule/scheduleLocalDrain/schedulePolicyCheck. These two were
// missed by that pass, and the Auto Learn transcript watcher is the highest-
// frequency trigger in the extension — Claude Code appends to those files
// constantly, including during a reload. Measured after deactivate() resolved:
// one watcher event took active Timeouts 0 -> 1, and one
// onDidChangeConfiguration for permissionWildcarding.autoLearn took it to 2, one
// of which is a fresh 5-minute setInterval that nothing will ever clear. Each
// tick then bumps autoLearnFailureCount and autoLearnNextRetryAt, driving the
// backoff to its 60-minute ceiling — so a same-realm re-activate inherits a
// silently dead Auto Learn.
function scheduleAutoLearn(delay) {
  if (deactivated) return;
  if (delay == null) delay = autoLearnConfig().debounceSeconds * 1000;
  clearTimeout(autoLearnBounce);
  autoLearnBounce = setTimeout(() => runAutoLearnScan(false), delay);
}

function resetAutoLearnTimer() {
  // Before the clear as well as the arm: a torn-down host must not leave a
  // 5-minute interval behind, and must not clear a SUCCESSOR's either.
  if (deactivated) return;
  clearInterval(autoLearnTimer);
  const cfg = autoLearnConfig();
  if (!cfg.enabled) return;
  autoLearnTimer = setInterval(() => runAutoLearnScan(false), cfg.intervalMinutes * 60 * 1000);
}

function registerAutoLearnWatchers(context) {
  for (const [base, pattern] of [
    [path.join(os.homedir(), '.claude'), 'projects/**/*.jsonl'],
    [path.join(os.homedir(), '.codex'), 'sessions/**/*.jsonl'],
  ]) {
    try {
      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(vscode.Uri.file(base), pattern)
      );
      watcher.onDidChange(() => scheduleAutoLearn());
      watcher.onDidCreate(() => scheduleAutoLearn());
      watcher.onDidDelete(() => scheduleAutoLearn());
      context.subscriptions.push(watcher);
    } catch (error) {
      console.error('permission-wildcarding: Auto Learn watcher failed —', error);
    }
  }
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((event) => {
    if (!event.affectsConfiguration('permissionWildcarding.autoLearn')) return;
    invalidateAutoLearnManager();
    resetAutoLearnTimer();
    scheduleAutoLearn(100);
    dashboard?.refresh();
  }));
  resetAutoLearnTimer();
}

// Watch each workspace folder's .claude/settings.local.json — the file Claude
// Code actually writes an "always approve" into. This is the loop that was
// missing: the approval lands locally, its portable form is promoted to user
// scope, and no other project ever prompts for that command again.
function registerLocalWatchers(context) {
  const watchers = [];
  const attach = () => {
    while (watchers.length) { try { watchers.pop().dispose(); } catch { /* already gone */ } }
    for (const folder of vscode.workspace.workspaceFolders || []) {
      try {
        const watcher = vscode.workspace.createFileSystemWatcher(
          new vscode.RelativePattern(folder, LOCAL_RELATIVE.split(path.sep).join('/'))
        );
        watcher.onDidChange(() => scheduleLocalDrain());
        watcher.onDidCreate(() => scheduleLocalDrain());
        watchers.push(watcher);
      } catch (error) {
        console.error('permission-wildcarding: local-settings watcher failed —', error);
      }
    }
  };
  // ONE subscription that drains the live list, rather than one per watcher.
  // Each watcher used to be pushed into both `watchers` and
  // `context.subscriptions`, and `attach()` drains only the former. Since
  // `attach()` re-runs on every workspace-folder change and
  // `context.subscriptions` is append-only until deactivate, every folder
  // change left another set of already-disposed watchers pinned there for the
  // life of the window. memoryLint.js keeps its watchers in a Map it prunes
  // itself and never hands them to `context.subscriptions`, for this reason.
  context.subscriptions.push({
    dispose: () => {
      while (watchers.length) { try { watchers.pop().dispose(); } catch { /* already gone */ } }
    },
  });
  attach();
  // A folder added mid-session brings its own local approvals with it. Both
  // subscriptions are feature-tested rather than assumed: an unexpected host
  // missing one must cost the drain its liveness, never activation.
  if (typeof vscode.workspace.onDidChangeWorkspaceFolders === 'function') {
    context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => {
      attach();
      scheduleLocalDrain(1200);
    }));
  }
  if (typeof vscode.workspace.onDidChangeConfiguration === 'function') {
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('permissionWildcarding.localDrain')) scheduleLocalDrain(200);
      if (event.affectsConfiguration('permissionWildcarding.guidance')) ensureGuidance(true);
      // gates and memory.* had no listener at all, so flipping either in the
      // Settings UI did nothing until a window reload — and memoryLint reads
      // memory.enabled once at activation, so its four keys were picked up only
      // by the 5-minute reconcile or a save event.
      if (event.affectsConfiguration('permissionWildcarding.gates')) ensureGates(true);
      if (event.affectsConfiguration('permissionWildcarding.memory')) {
        // BOTH, and in this order. Refreshing only the dashboard was worse than
        // refreshing nothing: memoryCardData() re-reads the configuration and
        // the corpus on every call, so the card went live while the linter
        // stayed exactly as activate() left it — no gauge and no diagnostics on
        // a false -> true flip, and a stale gauge on true -> false. The card
        // then asserted a feature was on when it was off.
        memoryLint?.reconfigure();
        dashboard?.refresh();
      }
    }));
  }
  context.subscriptions.push({
    dispose() { while (watchers.length) { try { watchers.pop().dispose(); } catch { /* already gone */ } } },
  });
}

// Created on first use and disposed with the extension. Lazy rather than built
// in activate, because the mocked-vscode activation test does not stub every
// window API and a channel nobody opened costs nothing.
function sharedChannel({ fresh = false } = {}) {
  if (!outputChannel) outputChannel = vscode.window.createOutputChannel('Permission Wildcarding');
  // Every consumer writes a SELF-CONTAINED report and none of them had a way to
  // start a clean one. Collapsing N channels into one fixed the disposal leak
  // and traded it for an unbounded document: these are palette and notification
  // actions with no call limit, so "Show blocked" ten times printed ten reports
  // with no separator, oldest first, and the reader had to scroll to find the
  // one they just asked for. The old test asserted the channel COUNT and
  // nothing about its content, which is why this survived the fix.
  if (fresh) outputChannel.clear();
  return outputChannel;
}

function activate(context) {
  // The module can outlive a deactivate (an extension disable/enable, or an
  // upgrade, re-activates in the same realm), so the teardown flag has to be
  // released here or the second activation is muted for its whole lifetime.
  deactivated = false;
  activationGeneration += 1;
  // Watch settings.json for any change (Claude Code approval, manual edit, etc.).
  // RelativePattern (not a plain string) — plain strings only watch files inside
  // opened workspace folders, but ~/.claude/settings.json usually isn't one.
  const watcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(vscode.Uri.file(path.dirname(SETTINGS)), path.basename(SETTINGS))
  );
  // Loss is checked on every settings change, not only on a policy-file event:
  // server-delivered org policy can remove approvals with no local file to watch.
  const onSettingsChanged = () => { schedule(); schedulePolicyCheck(); };
  watcher.onDidChange(onSettingsChanged);
  watcher.onDidCreate(onSettingsChanged);
  context.subscriptions.push(watcher);

  // Watch for managed policy arriving or changing. This is the case the backup
  // exists for, so it is checked once at startup and on every subsequent change
  // rather than only when the user happens to click Restore.
  for (const managedPath of policySignalPaths()) {
    try {
      const managedWatcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(vscode.Uri.file(path.dirname(managedPath)), path.basename(managedPath))
      );
      managedWatcher.onDidChange(() => schedulePolicyCheck());
      managedWatcher.onDidCreate(() => schedulePolicyCheck());
      context.subscriptions.push(managedWatcher);
    } catch { /* an unwatchable system path must never block activation */ }
  }
  // Catch a policy that landed while VS Code was closed. Not debounced: this one
  // is a single shot rather than a burst, and if settings.json happens to be
  // mid-write right now the read guard makes it a no-op instead of a false alarm.
  try { onManagedPolicyChanged(); } catch { /* never block activation */ }

  // Codex config.toml drives the Codex half of the friction indicator.
  try {
    const codexWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(path.dirname(CODEX_CONFIG)), path.basename(CODEX_CONFIG))
    );
    codexWatcher.onDidChange(() => { updateStatusBar(); dashboard?.refresh(); });
    codexWatcher.onDidCreate(() => { updateStatusBar(); dashboard?.refresh(); });
    context.subscriptions.push(codexWatcher);
  } catch { /* never block activation */ }

  // The org's signed requirements bundle, which decides whether Codex MAX is legal at all.
  // Codex owns this file and refetches it on its own schedule, so the card would otherwise
  // keep reporting "org policy caps approval" from a stale cache long after an account or
  // policy change made `never` legal — right up until something unrelated forced a render.
  try {
    const bundleWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(
        vscode.Uri.file(path.dirname(CODEX_BUNDLE_CACHE)), path.basename(CODEX_BUNDLE_CACHE))
    );
    bundleWatcher.onDidChange(() => { updateStatusBar(); dashboard?.refresh(); });
    bundleWatcher.onDidCreate(() => { updateStatusBar(); dashboard?.refresh(); });
    bundleWatcher.onDidDelete(() => { updateStatusBar(); dashboard?.refresh(); });
    context.subscriptions.push(bundleWatcher);
  } catch { /* never block activation */ }

  // The compiled gates file. Whoever recompiles (the CLI, or the SessionStart hook) only
  // writes this file; watching it is what turns a corpus edit into an installed block
  // without waiting for the next activation. ensureGates is a no-op when already current.
  try {
    const gatesFile = compiledPath();
    const gatesWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(path.dirname(gatesFile)), path.basename(gatesFile))
    );
    gatesWatcher.onDidChange(() => ensureGates());
    gatesWatcher.onDidCreate(() => ensureGates());
    gatesWatcher.onDidDelete(() => dashboard?.refresh());
    context.subscriptions.push(gatesWatcher);
  } catch { /* never block activation */ }

  // Sidebar dashboard (Activity Bar → webview).
  dashboard = new WildcardingViewProvider(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(WildcardingViewProvider.viewId, dashboard)
  );

  // Manual trigger — from the Command Palette or the view's title-bar button.
  context.subscriptions.push(
    vscode.commands.registerCommand('permission-wildcarding.runNow', () => runWildcarding(true))
  );

  // Restore prunes from the backup after a wipe — palette / title-bar / dashboard.
  context.subscriptions.push(
    vscode.commands.registerCommand('permission-wildcarding.restoreBackup', () => restoreFromBackup())
  );

  // The full wildcard list with a filter box, for when the capped sidebar list
  // is not the right shape — reachable from the palette and from the sidebar's
  // "and N more" affordance.
  context.subscriptions.push(
    vscode.commands.registerCommand('permission-wildcarding.showWildcards', () => showWildcardPicker())
  );

  // Keep the legacy command id as an alias; Auto Learn is the only history scanner.
  context.subscriptions.push(
    vscode.commands.registerCommand('permission-wildcarding.scanHistory', () => runAutoLearnScan(true)),
    vscode.commands.registerCommand('permission-wildcarding.autoLearnScan', () => runAutoLearnScan(true)),
    vscode.commands.registerCommand('permission-wildcarding.autoLearnReview', () => reviewAutoLearnCandidates()),
    vscode.commands.registerCommand('permission-wildcarding.autoLearnApplySafe', () => applyAutoLearnSafe()),
    vscode.commands.registerCommand('permission-wildcarding.autoLearnUndo', () => undoAutoLearn()),
    vscode.commands.registerCommand('permission-wildcarding.autoLearnCycleMode', () => cycleAutoLearnMode()),
    vscode.commands.registerCommand('permission-wildcarding.autoLearnWhy', () => explainAutoLearnPrompt()),
    vscode.commands.registerCommand('permission-wildcarding.autoLearnShowBlocked', () => showAutoLearnBlocked()),
    vscode.commands.registerCommand('permission-wildcarding.derivedGuidance', () => showDerivedGuidance())
  );

  // Rebuild the recall (CPU bge-small) vector cache from the Memory card.
  context.subscriptions.push(
    vscode.commands.registerCommand('permission-wildcarding.rebuildRecall', () => rebuildRecall())
  );

  // MAX mode (primary) + bypass (secondary; palette/CLI) "skip everything" toggles.
  context.subscriptions.push(
    vscode.commands.registerCommand('permission-wildcarding.toggleMax', () => toggleMax()),
    vscode.commands.registerCommand('permission-wildcarding.toggleCodexMax', () => toggleCodexMax())
  );

  // Project-local approvals → user scope, and the shell-style block that stops
  // the un-generalizable approvals being created in the first place.
  context.subscriptions.push(
    vscode.commands.registerCommand('permission-wildcarding.drainLocal', () => drainLocal(true)),
    vscode.commands.registerCommand('permission-wildcarding.toggleGuidance', () => toggleGuidance()),
    vscode.commands.registerCommand('permission-wildcarding.toggleGates', () => toggleGates())
  );
  try {
    registerLocalWatchers(context);
  } catch (err) {
    console.error('permission-wildcarding: local-settings watchers failed —', err);
  }

  // Persistent status-bar indicator so an active "skip everything" is never invisible.
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = 'permission-wildcarding.toggleMax';
  context.subscriptions.push(statusBar);
  updateStatusBar();

  // Process once on activation to catch anything missed while VS Code was closed.
  runWildcarding();
  // Same for approvals that landed in a project's settings.local.json, and for
  // the guidance block — an upgrade refreshes stale wording, and neither writes
  // anything when the state is already right.
  drainLocal();
  ensureGuidance();
  // Gates too. Install-only: this never spawns python, so a corpus edit reaches the block
  // through the compiled file that the CLI or the SessionStart hook last wrote.
  ensureGates();
  startAutoLearn(context);
  // Sync the recall index on startup when the model is present and the cache is behind
  // the corpus. Deferred 10 s so the extension host settles first.
  recallSyncTimer = setTimeout(autoSyncRecallIfStale, 10000);

  // Memory-index hygiene lint: status-bar bloat gauge + editor squiggles on over-budget
  // hook lines / broken index links. Isolated so a failure here never breaks wildcarding.
  try {
    // Module-scoped, not block-local: the configuration listener needs a handle
    // on it. Without one it could only refresh the dashboard card, which is how
    // the card ended up reporting live memory data for a linter that was off.
    memoryLint = new MemoryLint();
    memoryLint.activate(context);
  } catch (err) {
    console.error('permission-wildcarding: memory lint failed to activate —', err);
  }

  // Keep the dashboard's Memory card live as MEMORY.md changes (an agent editing it
  // outside the editor still fires this). Best-effort — the card also refreshes on
  // panel visibility and after a rebuild, so a watcher failure is non-fatal.
  try {
    for (const dir of discoverDirs({ enabled: true, dir: '', lineBudget: 300, totalBudget: 12000 })) {
      const w = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(vscode.Uri.file(dir), 'MEMORY.md')
      );
      const bump = () => {
        clearTimeout(memBounce);
        memBounce = setTimeout(() => { dashboard?.refresh(); autoSyncRecallIfStale(); }, 350);
      };
      w.onDidChange(bump); w.onDidCreate(bump); w.onDidDelete(bump);
      context.subscriptions.push(w);
    }
  } catch (err) {
    console.error('permission-wildcarding: memory-card watcher failed —', err);
  }

  // Recompile the gates when the corpus that produced them changes.
  //
  // A SessionStart hook would be the obvious home for this and it does not work under a
  // managed policy. Enforcement of `allowManagedHooksOnly` is PER EVENT: a user hook runs
  // only on an event the managed policy itself defines. Measured on a box whose policy
  // defines PostToolUse and nothing else — a user PostToolUse canary fired 4 times out of 4,
  // while a real session start and a /clear both left the compiled file untouched.
  //
  // A memory file changing is the better trigger regardless. It is the actual cause, it
  // fires once per edit instead of once per session, and the extension is not a hook, so no
  // policy can switch it off. Gated on the block already being installed, so this never
  // spawns python for anyone who has not opted in.
  try {
    for (const dir of discoverDirs({ enabled: true, dir: '', lineBudget: 300, totalBudget: 12000 })) {
      const w = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(vscode.Uri.file(dir), '*.md')
      );
      const bump = (uri) => {
        // The index carries hooks, never gate blocks, and it changes far more often.
        if (uri && path.basename(uri.fsPath) === 'MEMORY.md') return;
        if (!gatesEnabled()) return;
        try {
          if (!gatesStatusAll().some((state) => state.on)) return;
        } catch { return; }
        clearTimeout(gatesBounce);
        // Long debounce on purpose: editing a memory tends to save several times, and each
        // compile is a python spawn.
        gatesBounce = setTimeout(() => {
          compileGates({ quiet: true }).then((ok) => { if (ok) ensureGates(); });
        }, 2000);
      };
      w.onDidChange(bump); w.onDidCreate(bump); w.onDidDelete(bump);
      context.subscriptions.push(w);
    }
  } catch (err) {
    console.error('permission-wildcarding: gates corpus watcher failed —', err);
  }
}

// Reflect the live "skip everything" state in the status bar (warning-tinted ON).
// Primary signal is MAX mode; bypassPermissions mode also lights it.
// Learn on startup, on either agent's JSONL appends, and periodically to
// reconcile events missed while the extension host was suspended.
// This sits immediately after activate() so all dashboard state already exists.
function startAutoLearn(context) {
  registerAutoLearnWatchers(context);
  scheduleAutoLearn(750);
}

// ── one vocabulary for "how much friction is left" ──────────────────────────────
// There are two agents and three switches, which is exactly the sort of thing
// that becomes folklore. Everything that reports state derives it from here, so
// the status bar, the tooltip and the dashboard can never disagree, and every
// label names the agent it applies to.
//
//   Claude  MAX    — blanket allow wildcards + PreToolUse approve hook.
//                    Floor: permissions.deny + hard circuit breakers.
//   Claude  BYPASS  — flips permissions.defaultMode. Legacy/advanced; managed
//                    policy can disable it, which is why MAX exists.
//   Codex   MAX    — approval_policy = "never" in config.toml.
//                    Floor: the sandbox (sandbox_mode is never touched).
//
// The two MAX switches are siblings, not one setting: they write different
// files, for different agents, with different floors.
function codexConfigText() {
  try { return fs.readFileSync(CODEX_CONFIG, 'utf8'); }
  catch { return null; }
}

function frictionState() {
  const settings = readSettings();
  const codexText = codexConfigText();
  // bypass is detected but no longer offered: it is Claude Code's own setting,
  // and where policy permits it the user can set it there. Reported so an
  // externally-enabled bypass is never invisible.
  const claude = isMaxOn(settings) ? 'max' : isBypassOn(settings) ? 'bypass' : 'prompts';
  return {
    claude,
    claudeLayers: maxLayers(settings),
    codex: codexText === null ? 'absent' : isCodexMaxOn(codexText) ? 'max' : 'prompts',
    codexApproval: codexText === null ? null : readApproval(codexText),
    codexSandbox: codexText === null ? null : sandboxMode(codexText),
  };
}

const CLAUDE_LABEL = { max: 'Claude MAX', bypass: 'Claude BYPASS', prompts: 'Claude prompts' };
const CODEX_LABEL = { max: 'Codex MAX', prompts: 'Codex prompts', absent: 'Codex n/a' };

function frictionSummary(state = frictionState()) {
  return `${CLAUDE_LABEL[state.claude]} · ${CODEX_LABEL[state.codex]}`;
}

function updateStatusBar() {
  if (!statusBar) return;
  const state = frictionState();
  const anyOn = state.claude !== 'prompts' || state.codex === 'max';
  statusBar.text = `${anyOn ? '$(zap)' : '$(shield)'} ${frictionSummary(state)}`;
  statusBar.tooltip = [
    state.claude === 'max'
      ? `Claude: MAX — every prompt skipped (allow-wildcards ${state.claudeLayers.allow ? 'on' : 'off'}, approve-hook ${state.claudeLayers.hook ? 'on' : 'off'}). permissions.deny + circuit breakers still apply.`
      : state.claude === 'bypass'
        ? 'Claude: BYPASS — defaultMode flipped. Managed policy can disable this; MAX is the durable option.'
        : 'Claude: prompts active.',
    state.codex === 'max'
      ? `Codex: MAX — approval_policy=never. The ${state.codexSandbox || 'configured'} sandbox is still the floor, so out-of-workspace writes and network remain blocked.`
      : state.codex === 'prompts'
        ? `Codex: prompts active (approval_policy=${state.codexApproval || 'default'}).`
        : 'Codex: no config.toml found.',
    '',
    'Click to toggle Claude MAX.',
  ].join('\n');
  statusBar.backgroundColor = anyOn
    ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
  statusBar.show();
}

// Codex MAX writes Codex's own config.toml, so it takes no policy lock — it
// shares no file with Auto Learn or the wildcarding pass.
function toggleCodexMax() {
  const text = codexConfigText();
  if (text === null) {
    vscode.window.showWarningMessage(
      `permission-wildcarding: no Codex config at ${CODEX_CONFIG} — cannot toggle Codex MAX.`
    );
    return;
  }
  const turningOn = !isCodexMaxOn(text);
  let res;
  try {
    res = applyCodexMax(text, turningOn);
    if (res.blockedBy === 'enterprise-policy') {
      const allowed = (res.allowed || []).join(', ') || 'none';
      vscode.window.showWarningMessage(
        res.restricted
          ? "Codex MAX skips every prompt by setting approval_policy=\"never\", but your organization's " +
            `Codex policy forbids it (allows only [${allowed}]). Codex will keep prompting; nothing was changed.`
          : "Codex MAX: your organization's Codex policy permits no approval policy this can set " +
            `(allowed: ${allowed}). Nothing was changed.`
      );
      return;
    }
    // A refusal is not "already in that state". applyCodexMax returns
    // `changed: false` with `error: 'codex-max-snapshot-failed'` when the
    // snapshot that alone can restore the previous Codex settings did not land
    // — and falling through to the silent `!res.changed` return told the user
    // nothing at all: Codex MAX stays off while they believe it went on. The
    // CLI already reports this (bin/wildcard-perms:808 for the Claude half);
    // both extension toggles ignored it.
    if (res.error === 'codex-max-snapshot-failed') {
      vscode.window.showErrorMessage(
        'Codex MAX: refused — could not write the settings snapshot to ~/.claude/backups, '
        + 'so turning it off later could not restore your Codex approval policy. '
        + 'Nothing was changed. Check that directory is writable and retry.'
      );
      updateStatusBar();
      dashboard?.refresh();
      return;
    }
    if (!res.changed) { updateStatusBar(); dashboard?.refresh(); return; }
    fs.mkdirSync(path.dirname(CODEX_CONFIG), { recursive: true });
    writeFileAtomicSync(CODEX_CONFIG, res.text);
  } catch (err) {
    vscode.window.showErrorMessage(`permission-wildcarding: Codex MAX toggle failed — ${err.message}`);
    return;
  }
  const sandbox = sandboxMode(res.text) || 'configured';
  if (turningOn) {
    vscode.window.showWarningMessage(
      `⚡ Codex MAX ON — approval_policy=${res.target}. ` +
      (res.restricted
        ? "Your organization's Codex policy forbids 'never', so this is the least-friction policy it allows. "
        : 'Codex stops asking. ') +
      `The ${sandbox} sandbox is untouched and still blocks out-of-workspace writes and network. ` +
      'Restart Codex to apply.'
    );
  } else {
    vscode.window.showInformationMessage(
      `permission-wildcarding: Codex MAX OFF — approval_policy=${res.restoredTo ?? 'unset (key removed)'}. Restart Codex to apply.`
    );
  }
  updateStatusBar();
  dashboard?.refresh();
}

// Flip MAX mode: blanket allow-list wildcards (Layer 1) + a PreToolUse auto-approve
// hook (Layer 2), independent of Claude Code's bypassPermissions mode. Reversible
// via the sidecar snapshot. deny rules + circuit breakers still apply.
function toggleMax() {
  // Read and write under the lock: MAX-off unions the sidecar snapshot with
  // whatever was granted since, so an Auto Learn write landing between the read
  // and the write would be re-pruned back out.
  let turningOn = false;
  let layers = null;
  let switchedMode = null;
  let restoredMode = null;
  try {
    getPolicyLock().locked(() => {
      // Read, transform and write are one operation now, all against the SAME
      // fresh read taken inside the writer.
      //
      // What this replaces: a readSettings() here, applyMax against it, and a
      // whole-object writeFileAtomicSync at the end. That held the policy lock
      // the entire time and it did not matter — Claude Code never takes this lock
      // and rewrites settings.json on every /model, /effort and approval, so
      // anything landing in the window was reverted. The CLI had the identical
      // shape and was fixed in the same change; fixing only one would have left
      // half the bug, which is the mistake that was made in the other direction
      // when the drain was rebased.
      //
      // `turningOn` is derived INSIDE the closure, not before it. Deriving it
      // from an earlier read let the request and the file disagree: if MAX had
      // already reached the requested state, applyMax returned changed:false,
      // nothing was written, `layers` stayed null, and BOTH notification branches
      // below were skipped — the user clicked and got no message at all, the
      // exact failure the snapshot-refusal branch was added to fix.
      //
      // It also deletes a guard that told a lie. readSettings() collapses absent
      // and unreadable into null and reported "settings.json not found" for a
      // file that was merely mid-write, and it refused on an ABSENT file where
      // the CLI proceeds. Now: absent yields {} and MAX-on works on a fresh
      // install like the CLI's does, and unreadable throws SETTINGS_UNREADABLE
      // into the catch below, which says "could not be parsed" — which is true.
      let res;
      let wroteOnto;
      ({ result: res, latest: wroteOnto } = settingsWriter.writeTransform((latest) => {
        turningOn = !isMaxOn(latest);
        return applyMax(latest, turningOn);
      }));
      // A refusal is not "already in that state". `changed: false` with
      // `error: 'max-snapshot-failed'` means the allow-list snapshot did not
      // land, so MAX-off could never restore the user's entries. Falling
      // through to the bare `!res.changed` return left `layers` null, which
      // skips BOTH notification branches below — the user got no message at
      // all, and believes MAX is on while it is off.
      if (res.error === 'max-snapshot-failed') {
        vscode.window.showErrorMessage(
          'permission-wildcarding: MAX refused — could not write the allow-list snapshot to '
          + '~/.claude/backups, so turning MAX off later could not restore your entries. '
          + 'MAX is unchanged. Check that directory is writable and retry.'
        );
        return;
      }
      if (!res.changed) {
        // Defensive, and the comment that was here had it exactly backwards.
        //
        // It claimed deriving `turningOn` inside the closure made this reachable.
        // It does the opposite: because intent now comes from the SAME read the
        // transform runs on, `isMaxOn(latest) === false` implies `turningOn` is
        // true implies `enableMaxAllow` returns changed:true — or the single
        // `max-snapshot-failed`, which the branch above already intercepts.
        // Enumerating all four layer states leaves no path here.
        //
        // Kept rather than deleted: it is the difference between a silent return
        // and a message if applyMax ever grows a second refusal, and that silent
        // return is the bug the branch above exists to fix. The CLI's equivalent
        // IS reachable, because there intent comes from argv rather than from the
        // read — that asymmetry is the point.
        vscode.window.showInformationMessage(
          `permission-wildcarding: MAX is already ${turningOn ? 'OFF' : 'ON'} — nothing to change.`
        );
        return;
      }
      switchedMode = res.switchedMode;
      restoredMode = res.restoredMode;
      if (!turningOn) {
        // Purge MAX blanket entries from the backup so the policy guard does not
        // treat them as "missing" and re-assert them, re-enabling MAX silently.
        //
        // Only the ones MAX itself added, which is what MAX-off actually removed:
        // res.settings already unions the pre-MAX snapshot back in, so anything
        // still present there is the user's and must keep its backup cover.
        //
        // NAMING, corrected: this used to be called `preMax`, which was wrong and
        // actively misleading. `wroteOnto` is writeTransform's `latest` — the read
        // the write landed on — so when turning MAX OFF its allow list is the
        // MAX-ON on-disk state, NOT the pre-MAX list. The pre-MAX list exists only
        // in the sidecar snapshot, and disableMaxAllow is what unions it back.
        //
        // Both halves come from ONE read, which is the point: the set to purge is
        // derived from the list the write actually rebased onto, and measured
        // against the list the write produced.
        //
        // What actually varies with this argument is narrow, and worth stating so
        // nobody mistakes a passing suite for coverage. buildMaxAllowSet's first
        // seven entries are the MAX_ALLOW_CORE constant, so only the `mcp__*` tail
        // depends on it — and detectMcpServers matches the PREFIX `mcp__S__`, so a
        // specific `mcp__S__tool` surviving into the restored list still yields
        // server S. The only input that distinguishes this from the post-MAX list
        // is an `mcp__S__*` blanket that arrived WHILE MAX was on, for a server
        // with no other `mcp__S__` entry: disableMaxAllow strips it and the
        // snapshot cannot restore it, so only the freshest read knows S existed.
        // That is the case test/policy-backup.test.js now pins.
        const restoredAllow = res.settings?.permissions?.allow ?? [];
        const wroteOntoAllow = wroteOnto?.permissions?.allow ?? [];
        forgetFromBackup(buildMaxAllowSet(wroteOntoAllow)
          .filter((entry) => !restoredAllow.includes(entry)));
      }
      lastRun = Date.now();
      layers = maxLayers(res.settings);
    });
  } catch (err) {
    // User-initiated, so report the contention instead of deferring silently the
    // way runWildcarding's watcher-driven pass does.
    vscode.window.showErrorMessage(err?.code === POLICY_LOCK_CODE
      ? `permission-wildcarding: ${POLICY_LOCK_BUSY_MESSAGE}`
      : `permission-wildcarding: MAX toggle failed — ${err.message}`);
    updateStatusBar();
    dashboard?.refresh();
    return;
  }

  if (layers && turningOn) {
    vscode.window.showWarningMessage(
      `⚡ MAX mode ON — every prompt skipped via allow-wildcards${layers.hook ? ' + approve hook' : ''} ` +
      '(deny rules + circuit breakers still apply). Reload the window for the approve hook to take effect.' +
      (switchedMode
        ? ` Permission mode switched from ${switchedMode} to default: auto mode discards Bash(*) as ` +
          'classifier-bypassing, so MAX would have granted nothing there. MAX off puts the mode back.'
        : ''),
      'Reload Window'
    ).then((choice) => {
      if (choice === 'Reload Window') vscode.commands.executeCommand('workbench.action.reloadWindow');
    });
  } else if (layers) {
    vscode.window.showInformationMessage(
      'permission-wildcarding: MAX mode OFF — restored your allow list, kept anything approved while MAX was on, ' +
      'and removed the approve hook.' +
      (restoredMode ? ` Permission mode restored to ${restoredMode}.` : '') +
      ' Reload the window to apply.'
    );
  }
  updateStatusBar();
  dashboard?.refresh();
}


function getPolicyLock() {
  if (!policyLock) policyLock = createPolicyLock({ lockPath: POLICY_LOCK_PATH });
  return policyLock;
}

function schedule(delay = 400) {
  // See schedulePolicyCheck: a watcher event during deactivate's awaited drain
  // re-armed this and wrote settings.json after teardown.
  if (deactivated) return;
  clearTimeout(debounceTimer);
  // 400ms debounce — Claude Code may write settings.json in several rapid bursts.
  debounceTimer = setTimeout(() => runWildcarding(), delay);
}

// The dashboard's badge is processAllowList(<what is on disk>), which this pass
// has just finished computing. `after` is already generalized, so
// processAllowList(after) === after — that is the idempotence the watcher-loop
// guard above relies on — and handing the pair over lets the refresh skip a
// second quadratic pass over the same list. The dashboard still re-checks that
// the disk holds `after`, so a write that lands in between costs nothing but the
// recompute it would have done anyway.
function wildcardingHint(after) {
  return Array.isArray(after) ? { allow: after, optimized: after } : null;
}

// Generalize + prune the allow list. `manual` = invoked via the button/command
// (surface a status message even when nothing changed).
function runWildcarding(manual = false) {
  // Keep the status indicator current on every settings.json change — a flip via
  // the CLI (`wildcard-perms --max` / `--bypass`) fires the watcher and lands here.
  updateStatusBar();

  // Already optimal: the ~95% case. Factored out because it is now reachable from
  // two places — the unlocked probe below, and the post-lock path when somebody
  // else generalized the list while we were waiting.
  //
  // backupPolicy runs HERE, on the unchanged path, and that is load-bearing. It is
  // the only thing that rebuilds a DELETED backup, which is not hypothetical: on
  // 2026-09-09 every directory under ~/.claude was recreated and this path is what
  // restored the mirror. It self-short-circuits when the union is unchanged, so it
  // costs a backup read, not a write. deny rides along because this is the path
  // that runs on every settings change, so it is where a deny rule added by hand
  // first reaches the backup.
  const reportAlreadyOptimal = (list, deny) => {
    backupPolicy(list, deny);
    if (manual) vscode.window.setStatusBarMessage('$(shield) permission-wildcarding: already optimal', 4000);
    dashboard?.refresh(wildcardingHint(list));
  };

  // ── the unlocked probe ──────────────────────────────────────────────────────
  //
  // The read and the pass used to happen INSIDE the lock, so every settings.json
  // change paid a full lock cycle just to discover there was nothing to do. Same
  // mistake, and the same fix, as bin/wildcard-perms:287-296 — this read is a
  // NEGATIVE TEST ONLY, which is what makes it safe unlocked. If the list is
  // already a fixed point we write nothing, so a stale read costs nothing. The
  // moment it differs, everything authoritative is redone inside the lock.
  //
  // The lock cycle is 3.4-3.7 ms of file operations (46% of it a single
  // fsyncSync), but milliseconds are the smaller half of the argument. The real
  // win is CONTENTION. Auto Learn is on by default, scans every 5 minutes plus a
  // 20-second debounce on the highest-frequency watcher in this extension, and its
  // scan() holds this same lock across the ENTIRE transcript corpus read. The
  // 20-deep `lockedRetries` budget with a 1500 ms backoff below — up to ~30
  // seconds of deferral — is evidence that this race was observed, not predicted.
  // On the unchanged path the pass can now no longer lose it at all.
  //
  // And the lock never protected this read from the file's highest-frequency
  // writer anyway: Claude Code does not take it (see toggleMax's note above).
  const settings = readSettings();
  if (!settings) { dashboard?.refresh(); return; }
  const before = settings?.permissions?.allow ?? [];
  const after = processAllowList(before);

  if (JSON.stringify(before) === JSON.stringify(after)) {
    // Reset here too. The budget used to be cleared only after a completed lock
    // cycle, and an early return that never reaches the lock would otherwise
    // strand it — leaving a window of contention permanently spent.
    lockedRetries = 0;
    reportAlreadyOptimal(after, settings?.permissions?.deny);
    return;
  }

  // ── a write is due, so now take the lock ────────────────────────────────────
  //
  // The probe's snapshot is DISCARDED and everything recomputed from a read taken
  // inside the lock. This is not defensive tidiness, it is required:
  // `writeAllow` replays a delta computed against the CALLER's snapshot, and its
  // own note (src/settings-write.js:145-152) names this caller — "WRONG for one
  // whose whole output is a function of the list it read … Such a caller must
  // re-read and recompute first, so `settings` IS `latest` and this degenerates
  // to identity."
  //
  // Until now this function satisfied that precondition only BY ACCIDENT, because
  // its read happened to sit inside the lock. Handing writeAllow the probe's
  // snapshot instead would reintroduce the failure spelled out at
  // bin/wildcard-perms:354-368: with MAX on, Claude Code persists
  // `Bash(npm test)`; the unlocked pass marks it removed because `Bash(*)` covers
  // it; `--max off` then deliberately preserves it; replaying `removed` deletes it
  // for good.
  //
  // So the changed path now runs the pass twice. That is the correct trade: it is
  // the ~5% case, it already pays for an atomic write, and 3.2 ms of recompute
  // buys back the only guarantee that makes the delta replay sound.
  let locked;
  let lockedBefore;
  let lockedAfter;
  try {
    getPolicyLock().locked(() => {
      locked = readSettings();
      if (!locked) return;
      lockedBefore = locked?.permissions?.allow ?? [];
      lockedAfter = processAllowList(lockedBefore);
      if (JSON.stringify(lockedBefore) === JSON.stringify(lockedAfter)) return;
      writeAllow(locked, lockedAfter);
      lastRun = Date.now();
    });
  } catch (err) {
    if (err?.code === POLICY_LOCK_CODE) {
      // Auto Learn is mid-scan or mid-apply. Its write fires the watcher again,
      // so a bounded retry keeps the list converging without spinning.
      if (lockedRetries < 20) { lockedRetries += 1; schedule(1500); }
      dashboard?.refresh();
      return;
    }
    vscode.window.showErrorMessage(`permission-wildcarding: write failed — ${err.message}`);
    dashboard?.refresh();
    return;
  }
  lockedRetries = 0;
  if (!locked) { dashboard?.refresh(); return; }

  // Reported from the LOCKED read, not the probe, because that is what the write
  // actually rebased onto. Reachable when another writer generalized the list
  // between the probe and the lock — and it also still guards the watcher loop
  // (our own write re-fires the watcher; the second pass short-circuits at the
  // probe above).
  if (JSON.stringify(lockedBefore) === JSON.stringify(lockedAfter)) {
    reportAlreadyOptimal(lockedAfter, locked?.permissions?.deny);
    return;
  }

  {
    const addedList   = lockedAfter.filter(p => !lockedBefore.includes(p));
    const removedList = lockedBefore.filter(p => !lockedAfter.includes(p));
    if (addedList.length || removedList.length) {
      vscode.window.showInformationMessage(
        `permission-wildcarding: wildcarded ${addedList.length} permission${addedList.length !== 1 ? 's' : ''}, pruned ${removedList.length} — ${lockedAfter.length} total`,
        { detail: addedList.map(p => `→ ${p}`).join('\n') }
      );
      vscode.window.setStatusBarMessage(
        `$(shield) permission-wildcarding: +${addedList.length} -${removedList.length} → ${lockedAfter.length} entries`,
        5000
      );
    }
  }

  dashboard?.refresh(wildcardingHint(lockedAfter));
}

// ── project-local approvals ─────────────────────────────────────────────────────
// Claude Code persists an "always approve" into the *project's*
// .claude/settings.local.json, so that is where approvals actually pile up — and
// nothing here used to read it. Promote the portable ones to user scope, where
// one entry covers every project, then drop the local entries user scope now
// covers. src/local-settings.js owns the rules; this owns the VS Code wiring.

function localDrainEnabled() {
  return vscode.workspace.getConfiguration('permissionWildcarding').get('localDrain.enabled', true);
}

// Writing into a workspace's .claude/ changes that project's files, so an
// untrusted window reads but never writes — the same line the Codex
// workspace-scope rule writer draws.
function drainableRoots() {
  if (!vscode.workspace.isTrusted) return [];
  return (vscode.workspace.workspaceFolders || [])
    .map((folder) => folder.uri.fsPath)
    .filter((root) => fs.existsSync(localSettingsPath(root)));
}

function drainOneWorkspace(root, dryRun = false) {
  return drainLocalSettings({
    workspaceRoot: root,
    readUserSettings: readSettings,
    // The extension's own merge: rebase onto the newest settings.json and refresh
    // the high-water backup, so a promoted entry is protected by the policy guard
    // exactly like an approval the wildcarding pass generalized.
    applyUserAllow: (entries) => {
      const settings = readSettings() ?? {};
      const existing = Array.isArray(settings?.permissions?.allow) ? settings.permissions.allow : [];
      writeAllow(settings, processAllowList([...new Set([...existing, ...entries])]));
    },
    dryRun,
  });
}

// Drain every open workspace folder. `manual` surfaces a message even when there
// was nothing to do, so the button always answers.
function drainLocal(manual = false) {
  if (!manual && !localDrainEnabled()) return;
  const roots = drainableRoots();
  if (!roots.length) {
    if (manual) {
      vscode.window.setStatusBarMessage(
        vscode.workspace.isTrusted
          ? '$(shield) permission-wildcarding: no .claude/settings.local.json in this workspace'
          : '$(shield) permission-wildcarding: workspace is not trusted — local drain skipped',
        5000);
    }
    return;
  }

  const reports = [];
  try {
    getPolicyLock().locked(() => {
      for (const root of roots) reports.push(drainOneWorkspace(root));
    });
  } catch (err) {
    if (err?.code === POLICY_LOCK_CODE) {
      // Auto Learn holds the lock; its write fires the settings watcher and we
      // come back through here. Only a manual click deserves a message.
      if (manual) vscode.window.setStatusBarMessage(`$(shield) permission-wildcarding: ${POLICY_LOCK_BUSY_MESSAGE}`, 5000);
      return;
    }
    if (err?.code === SETTINGS_UNREADABLE_CODE) {
      // settings.json is mid-write. Promoting a project-local entry can wait; the
      // entries stay in settings.local.json until a later pass picks them up, so a
      // retry is enough and a startup toast about a transient is not. Bounded,
      // because a file that stays unparseable is a different problem and retrying
      // it every three seconds forever would not be the fix for it.
      if (localDrainRetries < 20) { localDrainRetries += 1; scheduleLocalDrain(3000); }
      if (manual) {
        vscode.window.setStatusBarMessage(
          '$(shield) permission-wildcarding: settings.json is mid-write — retrying the drain shortly', 5000);
      }
      return;
    }
    vscode.window.showErrorMessage(`permission-wildcarding: local drain failed — ${err.message}`);
    return;
  }
  localDrainRetries = 0;

  if (reports.some((report) => report.blocked === 'max')) {
    if (manual) {
      vscode.window.showWarningMessage(
        'permission-wildcarding: Claude MAX is ON — its blanket Bash(*) layer covers every ' +
        'project-local entry, so draining would empty that file and MAX-off would not bring it ' +
        'back. Turn MAX off first.');
    }
    dashboard?.refresh();
    return;
  }

  const promoted = reports.flatMap((report) => report.promoted);
  const pruned = reports.reduce((sum, report) => sum + report.pruned.length, 0);
  if (promoted.length || pruned) {
    localDrainAt = Date.now();
    lastRun = Date.now();
    vscode.window.showInformationMessage(
      `permission-wildcarding: promoted ${promoted.length} project-local approval${promoted.length !== 1 ? 's' : ''} ` +
      `to user scope, pruned ${pruned} now-redundant local ${pruned === 1 ? 'entry' : 'entries'}`,
      { detail: promoted.map((p) => `→ ${p}`).join('\n') }
    );
  } else if (manual) {
    const kept = reports.reduce((sum, report) => sum + report.kept, 0);
    vscode.window.setStatusBarMessage(
      `$(shield) permission-wildcarding: nothing to promote — ${kept} local ` +
      `${kept === 1 ? 'entry is' : 'entries are'} project-specific`, 5000);
  }
  dashboard?.refresh();
}

function scheduleLocalDrain(delay = 900) {
  // See schedulePolicyCheck. This one also self-reschedules on contention, up
  // to 20 times, so an unguarded arm could keep writing for about a minute.
  if (deactivated) return;
  clearTimeout(localDrainBounce);
  localDrainBounce = setTimeout(() => drainLocal(), delay);
}

// Dashboard numbers come from a dry run over each folder, so the card shows what
// a click would actually do rather than a raw entry count.
function localCardData() {
  const roots = (vscode.workspace.workspaceFolders || [])
    .map((folder) => folder.uri.fsPath)
    .filter((root) => fs.existsSync(localSettingsPath(root)));
  if (!roots.length) return null;
  let promote = 0; let prune = 0; let kept = 0; let blocked = false;
  for (const root of roots) {
    const report = drainOneWorkspace(root, true);
    if (report.blocked) { blocked = true; kept += report.kept; continue; }
    promote += report.promote.length;
    prune += report.prune.length;
    kept += report.kept;
  }
  return {
    folders: roots.length,
    file: roots.length === 1 ? localSettingsPath(roots[0]).replace(os.homedir(), '~') : LOCAL_RELATIVE,
    promote, prune, kept, blocked,
    trusted: vscode.workspace.isTrusted,
    enabled: localDrainEnabled(),
    lastRun: localDrainAt,
  };
}

// ── agent guidance ──────────────────────────────────────────────────────────────
// The one class of friction no generalizer can fix after the fact: a compound
// command is stored verbatim when approved, so it never matches a second command.
// The fix is upstream, in the agent's instructions — and the agent cannot install
// it itself, because editing its own permission surface is what a classifier
// stops. So the extension writes it, into ~/.claude/CLAUDE.md.

function guidanceEnabled() {
  return vscode.workspace.getConfiguration('permissionWildcarding').get('guidance.enabled', true);
}

// Keep CLAUDE.md in step with the setting on activation, and refresh a block
// written by an older version. Silent when already correct: this runs on every
// activation and must not rewrite the user's instruction file for nothing.
function ensureGuidance(announce = false) {
  // The same gate ensureGates has, and for the same reason: this writes the
  // user's CLAUDE.md and ~/.codex/AGENTS.md, and it is reached from the
  // configuration listener, which stays live until VS Code disposes the
  // subscriptions — i.e. after deactivate() resolves. Measured: flipping
  // guidance.enabled after teardown rewrote CLAUDE.md from 1802 bytes to 24.
  // Its twin was guarded in the lifecycle pass and this one was missed.
  if (deactivated) return;
  try {
    const want = guidanceEnabled();
    const states = guidanceStatusAll().filter((state) => state.readable);
    if (!states.length) return;
    // Nothing to do when every installed agent already matches the setting — and
    // when it is on, already has the current wording.
    if (states.every((state) => state.on === want && (!want || state.current))) return;
    const changed = setGuidanceAll(want).filter((result) => result.changed);
    if (!changed.length) return;
    if (announce || want) {
      vscode.window.setStatusBarMessage(
        `$(shield) permission-wildcarding: shell-style guidance ${want ? 'added to' : 'removed from'} ` +
        changed.map((result) => result.agent).join(' + '),
        6000);
    }
    dashboard?.refresh();
  } catch (err) {
    console.error('permission-wildcarding: guidance write failed —', err);
  }
}

async function toggleGuidance() {
  const config = vscode.workspace.getConfiguration('permissionWildcarding');
  const states = guidanceStatusAll();
  // Off only when it is on everywhere it can be AND already the shipped wording. A
  // half-installed or stale state (a new agent appeared, a file was hand-edited, or a
  // release changed the text) should complete or refresh, not undo — which also means the
  // dashboard finally has a refresh path instead of only remove.
  const next = !(states.length && states.every((state) => state.on && state.current));

  // Removal is the only direction that costs something: every compound command starts
  // prompting again. The control lives on a dashboard people open just to read status, so
  // a modal makes a stray click harmless. Adding needs no confirmation, being the
  // recoverable direction.
  if (!next) {
    const files = states.map((state) => state.path.replace(os.homedir(), '~')).join(', ');
    const choice = await vscode.window.showWarningMessage(
      'Remove shell-style guidance?',
      {
        modal: true,
        detail: `Deletes the managed block from ${files}. Approvals stop generalizing, so `
          + 'compound commands prompt again on every variation. Your own text is left '
          + 'untouched and a backup is written first, and you can re-add it any time.',
      },
      'Remove');
    if (choice !== 'Remove') return;
  }

  // Persist the intent as well as the file, or the next activation would undo it.
  try {
    await config.update('guidance.enabled', next, vscode.ConfigurationTarget.Global);
  } catch (err) {
    vscode.window.showErrorMessage(`permission-wildcarding: ${err.message}`);
    return;
  }

  const results = setGuidanceAll(next);
  const failed = results.filter((result) => result.error);
  if (failed.length) {
    vscode.window.showErrorMessage(
      `permission-wildcarding: ${failed.map((result) => `${result.agent}: ${result.error}`).join('; ')}`);
  } else {
    vscode.window.showInformationMessage(
      `permission-wildcarding: shell-style guidance ${next ? 'ON' : 'OFF'} — ` +
      results.map((result) => result.path.replace(os.homedir(), '~')).join(', ') +
      (next ? ' (applies from each agent’s next session)' : ''));
  }
  dashboard?.refresh();
}

function guidanceCardData() {
  try {
    const states = guidanceStatusAll();
    if (!states.length) return null;
    return {
      on: states.every((state) => state.on),
      partial: states.some((state) => state.on) && !states.every((state) => state.on),
      current: states.every((state) => !state.on || state.current),
      readable: states.some((state) => state.readable),
      agents: states.filter((state) => state.on).map((state) => state.agent),
      targets: states.map((state) => state.agent),
      path: states.map((state) => state.path.replace(os.homedir(), '~')).join(', '),
    };
  } catch {
    return null;
  }
}

// ── memory gates ────────────────────────────────────────────────────────────────
// The guidance block above carries wording that ships in this repo. This one carries the
// user's own standing orders: `recall.py --gates-compile` lifts the `<!-- gate -->` section
// out of every memory marked `scope: global` and writes them to ~/.claude/gates.generated.md,
// which this block installs verbatim.
//
// Why a resident block rather than leaving them in the memory index: the index is a list of
// one-line hooks, so the enforceable half of a rule sits in a file that only loads if a
// recall happens to surface it. That works for reference material and fails for standing
// orders, because you cannot recall a rule you are already breaking — nothing triggers the
// lookup. Policy has to be resident; facts do not.
//
// Installing is a file read, so it runs on activation. COMPILING spawns python, so it stays
// an explicit action the card offers when there is nothing compiled yet.

function gatesEnabled() {
  return vscode.workspace.getConfiguration('permissionWildcarding').get('gates.enabled', true);
}

// How many gates the compiled file holds. Counts the bullets the compiler emits rather than
// parsing it, so a hand-mangled file reads as 0 instead of throwing.
// The running extension's version, for the dashboard's status line — so "which
// build am I looking at" is answerable without opening the Extensions view. This
// is the question that costs real time when a fix is in the repo but the VSIX was
// never reinstalled, which has happened repeatedly.
//
// Memoized rather than read per push: a version cannot change while the process
// runs, and the whole point of the change above it is to stop doing avoidable fs
// work on that path. `./package.json` resolves in BOTH layouts — beside
// extension.js in the repo, and beside it again inside the packaged VSIX — and the
// catch means a missing or unreadable manifest degrades to no badge rather than
// to a broken dashboard.
let extensionVersionMemo;
function extensionVersion() {
  if (extensionVersionMemo === undefined) {
    try { extensionVersionMemo = require('./package.json').version || ''; }
    catch { extensionVersionMemo = ''; }
  }
  return extensionVersionMemo;
}

// Read the count out of the header recall.py already writes, not out of the prose.
//
// This was `text.match(/^- \*\*/gm)`, which assumes every gate opens with a bold
// lead-in. That was true of the pre-2026-09-09 corpus and of nothing since, so
// with five gates installed the card read "0 active" — a number that flatly
// contradicted the ON state beside it. recall.py's _compile_gates_text emits
// "## Standing gates (N memories, managed)", which is the authoritative count and
// is independent of how any gate happens to be worded.
//
// Same defect, same day, in scripts/verify-release.ps1, which reported
// "0 gate(s)" for the same file. Fixed there first; this is the product half.
function compiledGateCount() {
  try {
    const text = readCompiled();
    if (!text) return 0;
    const header = text.match(/##\s+Standing gates\s+\((\d+)\s+memor/);
    if (header) return Number(header[1]);
    // Fall back to counting top-level bullets rather than to zero: an older
    // compiled file with no header still has gates in it.
    return (text.match(/^-\s/gm) || []).length;
  } catch {
    return 0;
  }
}

// Compiling needs python but NOT the embedding model: --gates-compile only reads frontmatter
// and lifts marker-fenced text, so the model precondition that gates a recall rebuild does
// not apply. Resolves false when it could not run, having already told the user why.
// `quiet` is for the corpus watcher below: a background recompile that fails must not throw
// a modal at someone who was only editing a note, so it reports to the console instead.
function compileGates({ quiet = false } = {}) {
  const warn = (msg, action) => {
    if (quiet) { console.error('permission-wildcarding: ' + msg); return; }
    if (action) {
      vscode.window.showWarningMessage('permission-wildcarding: ' + msg, action)
        .then((c) => { if (c === action) setRecallPath(); });
    } else {
      vscode.window.showWarningMessage('permission-wildcarding: ' + msg);
    }
  };
  // Nothing here may start after teardown: the callback chains into a write of
  // the user's instruction files.
  if (deactivated) return Promise.resolve(false);
  const script = recallScriptPath();
  if (!script) {
    warn('recall.py not found, so gates cannot be compiled.', 'Set recall.py path…');
    return Promise.resolve(false);
  }
  const st = recallStatus();
  if (!st.venv) {
    warn(`DevToolbox venv python not found at ${st.py} — cannot compile gates.`);
    return Promise.resolve(false);
  }
  const { dir } = memoryReport();
  return new Promise((resolve) => {
    const env = { ...process.env, RECALL_REEXEC: '1', ...(dir ? { RECALL_MEMORY_DIR: dir } : {}) };
    trackChild(execFile(st.py, [script, '--gates-compile'], { env, timeout: 60000 }, (err, _out, stderr) => {
      // Resolve false rather than true, so no caller chains into a policy write
      // on the strength of a compile the teardown just cancelled.
      if (deactivated) { resolve(false); return; }
      if (err) {
        const detail = (stderr || err.message || '').trim().slice(0, 300);
        if (quiet) console.error('permission-wildcarding: gate compile failed —', detail);
        else vscode.window.showErrorMessage(`permission-wildcarding: gate compile failed — ${detail}`);
        resolve(false);
        return;
      }
      resolve(true);
    }));
  });
}

// Keep the instruction files in step with the setting on activation, and refresh a block
// whose corpus has changed. Silent when already correct, because this runs on every
// activation and must not rewrite the user's instruction file for nothing.
function ensureGates(announce = false) {
  try {
    // The last gate before setGatesAll(). Reached from the compiled-file watcher
    // and from the compile callback, both of which can land after deactivate —
    // and this writes the user's CLAUDE.md / AGENTS.md.
    if (deactivated) return;
    const want = gatesEnabled();
    const states = gatesStatusAll().filter((state) => state.readable);
    if (!states.length) return;
    // Never install without a compile. setGatesAll refuses anyway, and reporting success
    // here would leave the card claiming ON while enforcing nothing.
    if (want && !states.some((state) => state.compiled)) return;
    if (states.every((state) => state.on === want && (!want || state.current))) return;
    const changed = setGatesAll(want).filter((result) => result.changed);
    if (!changed.length) return;
    if (announce || want) {
      vscode.window.setStatusBarMessage(
        `$(law) permission-wildcarding: memory gates ${want ? 'added to' : 'removed from'} ` +
        changed.map((result) => result.agent).join(' + '),
        6000);
    }
    dashboard?.refresh();
  } catch (err) {
    console.error('permission-wildcarding: gates write failed —', err);
  }
}

async function toggleGates() {
  const config = vscode.workspace.getConfiguration('permissionWildcarding');
  let states = gatesStatusAll();
  // Same rule as guidance: a stale or half-installed state should refresh or complete
  // rather than undo, so `off` only happens from a fully installed, current block.
  const next = !(states.length && states.every((state) => state.on && state.current));

  if (next && !states.some((state) => state.compiled)) {
    const choice = await vscode.window.showWarningMessage(
      'No gates compiled yet.',
      {
        modal: true,
        detail: 'Memory gates are built from your own memory files: each one marked '
          + '`scope: global` with a <!-- gate --> block holding its resident lines. Compile '
          + 'them first and the managed block gets installed from the result.',
      },
      'Compile now');
    if (choice !== 'Compile now') return;
    if (!await compileGates()) return;
    states = gatesStatusAll();
    if (!states.some((state) => state.compiled)) {
      vscode.window.showWarningMessage(
        'permission-wildcarding: nothing to install — no memory carries a <!-- gate --> block '
        + 'with `scope: global`.');
      dashboard?.refresh();
      return;
    }
  }

  if (!next) {
    const files = states.map((state) => state.path.replace(os.homedir(), '~')).join(', ');
    const choice = await vscode.window.showWarningMessage(
      'Remove memory gates?',
      {
        modal: true,
        detail: `Deletes the managed block from ${files}. Your standing orders stop being `
          + 'loaded every session, so they apply only when a recall happens to surface them. '
          + 'The memory files themselves are untouched and a backup is written first.',
      },
      'Remove');
    if (choice !== 'Remove') return;
  }

  try {
    await config.update('gates.enabled', next, vscode.ConfigurationTarget.Global);
  } catch (err) {
    vscode.window.showErrorMessage(`permission-wildcarding: ${err.message}`);
    return;
  }

  const results = setGatesAll(next);
  const failed = results.filter((result) => result.error);
  if (failed.length) {
    vscode.window.showErrorMessage(
      `permission-wildcarding: ${failed.map((result) => `${result.agent}: ${result.error}`).join('; ')}`);
  } else {
    vscode.window.showInformationMessage(
      `permission-wildcarding: memory gates ${next ? 'ON' : 'OFF'} — ` +
      results.map((result) => result.path.replace(os.homedir(), '~')).join(', ') +
      (next ? ' (applies from each agent’s next session)' : ''));
  }
  dashboard?.refresh();
}

// `precomputed` is the same optional memoryReport() result memoryCardData takes —
// this card needs exactly one integer out of it, `report.gateSources`, which the
// memory card's call already computed. Defaults to a fresh call so the other
// callers are unaffected.
function gatesCardData(precomputed = null) {
  try {
    const states = gatesStatusAll();
    if (!states.length) return null;
    return {
      on: states.every((state) => state.on),
      partial: states.some((state) => state.on) && !states.every((state) => state.on),
      current: states.every((state) => !state.on || state.current),
      readable: states.some((state) => state.readable),
      compiled: states.some((state) => state.compiled),
      count: compiledGateCount(),
      // Whether compiling could produce anything at all, so the card can decline
      // to offer an action that cannot succeed. Undefined when the memory report
      // is unavailable, which renderGates treats as "unknown, so still offer it"
      // rather than as zero.
      //
      // The try/catch is load-bearing and stays even with a value passed in: the
      // distinction between `undefined` ("unknown, still offer") and `0`
      // ("decline") is the card's whole contract, and a precomputed
      // `{ report: null }` yields undefined through `?.` naturally. What must NOT
      // happen is a throw escaping to the outer catch below, which returns null
      // and loses the entire card rather than one field.
      gateSources: (() => {
        try { return (precomputed || memoryReport()).report?.gateSources; } catch { return undefined; }
      })(),
      agents: states.filter((state) => state.on).map((state) => state.agent),
      targets: states.map((state) => state.agent),
      path: states.map((state) => state.path.replace(os.homedir(), '~')).join(', '),
    };
  } catch {
    return null;
  }
}

// One removal path, shared by the dashboard's ✕ and the QuickPick below, so the
// two can never diverge on the ordering that makes a prune stick.
function removeAllowEntry(perm) {
  if (!perm) return false;
  const settings = readSettings();
  if (!settings) return false;
  const allow = (settings.permissions?.allow ?? []).filter((p) => p !== perm);
  try {
    // Settings FIRST, backup second. The prune does have to leave the high-water
    // mark — otherwise the entry returns on the next restore and the policy guard
    // reports it as missing forever — but doing that first meant betting the
    // backup on a write that routinely fails: writeAllow throws
    // SETTINGS_UNREADABLE_CODE whenever it lands inside one of the in-place
    // rewrites Claude Code performs on every approval, /model and /effort. The
    // entry then stayed live in settings.json while its only copy was gone from
    // the backup, so a later wipe could not bring it back — the one unrecoverable
    // outcome, traded for a recoverable one (a stale backup entry the guard
    // offers to re-assert or forget).
    writeAllow(settings, allow);
    forgetFromBackup([perm]);
    lastRun = Date.now();
    vscode.window.setStatusBarMessage(`$(shield) permission-wildcarding: removed ${perm}`, 4000);
    return true;
  } catch (err) {
    vscode.window.showErrorMessage(`permission-wildcarding: remove failed — ${err.message}`);
    return false;
  }
}

// The whole wildcard list, with a filter box. The sidebar shows the first dozen
// and defers here, because the list is longest exactly when the tool is working:
// 404 of 423 entries on the machine this was built for, the longest 137
// characters, wrapping to three lines in a 320px column. A QuickPick is the
// right shape — full window width, fuzzy filter, keyboard-first — and it is
// already this extension's idiom for Review, derived guidance and the agent
// pickers.
async function showWildcardPicker() {
  const settings = readSettings();
  if (!settings) {
    vscode.window.showWarningMessage(
      'permission-wildcarding: settings.json is missing or unreadable.');
    return;
  }
  const allow = Array.isArray(settings.permissions?.allow) ? settings.permissions.allow : [];
  // The dashboard's own classification, so the sidebar count and the picker
  // count can never disagree.
  const wildcards = allow.filter((p) => p.includes('*')).sort();
  if (!wildcards.length) {
    vscode.window.showInformationMessage(
      'permission-wildcarding: no wildcard entries yet — approve some commands first.');
    return;
  }
  const pick = await vscode.window.showQuickPick(
    wildcards.map((permission) => ({
      label: permission,
      // The tool name, so typing "powershell" narrows to that half of the list.
      description: (/^([A-Za-z]+)\(/.exec(permission) || [, 'other'])[1],
    })),
    {
      title: `Tracked wildcards (${wildcards.length} of ${allow.length} allow entries)`,
      placeHolder: 'Filter by command or tool — pick one to remove it',
      matchOnDescription: true,
    });
  if (!pick) return;

  // Confirmed, unlike the sidebar's hover-revealed ✕, because Enter on a
  // filtered list is easy to mis-hit and this is NOT recoverable: the prune
  // deliberately drops the entry from the high-water-mark backup too, so
  // "Restore prunes from backup" will not bring it back.
  const choice = await vscode.window.showWarningMessage(
    'Remove this wildcard?',
    {
      modal: true,
      detail: `${pick.label}\n\nIt is dropped from settings.json and from the backup, so a `
        + 'later restore will not reinstate it. Claude Code will prompt again for commands '
        + 'this covered.',
    },
    'Remove');
  if (choice !== 'Remove') return;
  if (removeAllowEntry(pick.label)) dashboard?.refresh();
}

// ── dashboard (Activity Bar webview) ────────────────────────────────────────────

// Short enough to read as instant, long enough to collapse a watcher pair. The
// other bounces in this file are 200ms–2s because they debounce *work*; this one
// debounces a render, so it is sized to the burst and nothing more.
const DASHBOARD_BOUNCE_MS = 60;

// Cheap enough to be worth it: an O(n) compare in front of an O(n²) pass.
function sameList(a, b) {
  return a.length === b.length && a.every((entry, index) => entry === b[index]);
}

class WildcardingViewProvider {
  static viewId = 'permissionWildcarding.dashboard';

  constructor(context) {
    this.context = context;
    this.view = null;
    this.hint = null;  // { allow, optimized } from the caller, consumed by the next _push
  }

  resolveWebviewView(view) {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = this._html(view.webview);

    view.webview.onDidReceiveMessage((msg) => {
      switch (msg?.type) {
        case 'runNow':       vscode.commands.executeCommand('permission-wildcarding.runNow'); break;
        case 'restore':      vscode.commands.executeCommand('permission-wildcarding.restoreBackup'); break;
        case 'autoLearnScan': vscode.commands.executeCommand('permission-wildcarding.autoLearnScan'); break;
        case 'autoLearnReview': vscode.commands.executeCommand('permission-wildcarding.autoLearnReview'); break;
        case 'autoLearnApply': vscode.commands.executeCommand('permission-wildcarding.autoLearnApplySafe'); break;
        case 'autoLearnUndo': vscode.commands.executeCommand('permission-wildcarding.autoLearnUndo'); break;
        case 'autoLearnMode': vscode.commands.executeCommand('permission-wildcarding.autoLearnCycleMode'); break;
        case 'autoLearnWhy': vscode.commands.executeCommand('permission-wildcarding.autoLearnWhy'); break;
        case 'toggleMax':    vscode.commands.executeCommand('permission-wildcarding.toggleMax'); break;
        case 'toggleCodexMax': vscode.commands.executeCommand('permission-wildcarding.toggleCodexMax'); break;
        case 'rebuildRecall': vscode.commands.executeCommand('permission-wildcarding.rebuildRecall'); break;
        case 'lintMemory':   vscode.commands.executeCommand('permission-wildcarding.lintMemory'); break;
        case 'drainLocal':   vscode.commands.executeCommand('permission-wildcarding.drainLocal'); break;
        case 'toggleGuidance': vscode.commands.executeCommand('permission-wildcarding.toggleGuidance'); break;
        case 'toggleGates': vscode.commands.executeCommand('permission-wildcarding.toggleGates'); break;
        case 'showWildcards': vscode.commands.executeCommand('permission-wildcarding.showWildcards'); break;
        case 'refresh':      this.refresh(); break;
        case 'remove':       this._remove(msg.value); break;
      }
    });

    // The view is disposed every time it is hidden — package.json declares it
    // without retainContextWhenHidden — and re-resolved on show. Without this,
    // `this.view` kept pointing at the disposed one, and `refresh()` guards only
    // on `!this.view`: every dashboard?.refresh() call site (there are dozens,
    // several of them file-watcher callbacks) would run the entire synchronous
    // work-up first — processAllowList, a MEMORY.md read per discovered store, a
    // dry-run drain per workspace folder — and only then throw on postMessage.
    // From a watcher callback that surfaces as an unhandled extension-host
    // error, and the wasted work repeated on every background event for as long
    // as the sidebar stayed collapsed.
    //
    // Identity-checked before nulling: a hide/show race can resolve the next
    // view before the previous one's disposal is delivered, and clearing
    // unconditionally would drop the live view instead of the dead one.
    view.onDidDispose(() => { if (this.view === view) this.view = null; });

    view.onDidChangeVisibility(() => { if (view.visible) this.refresh(); });
    this.refresh();
  }

  // Ask for a push. Debounced like every other handler in this file (memBounce,
  // gatesBounce, policyBounce, localDrainBounce, autoLearnBounce): this was the
  // one that ran straight through, and it has ~35 call sites — several of them
  // watcher pairs (onDidChange + onDidCreate, or a delete beside a create) that
  // fire together, each paying for a full work-up including a quadratic
  // processAllowList.
  //
  // `hint` is an { allow, optimized } pair from a caller that just computed it.
  // Used only when the list it was computed from is still what is on disk, so a
  // write that landed in between falls back to a fresh pass rather than
  // rendering a count against the wrong list.
  refresh(hint = null) {
    // Before the timer, not inside it: nothing to push means nothing to schedule,
    // and this is the guard that keeps a collapsed sidebar (the view is disposed
    // on hide) from doing the whole work-up on every background event.
    if (!this.view) return;
    this.hint = hint && Array.isArray(hint.allow) && Array.isArray(hint.optimized) ? hint : null;
    clearTimeout(dashboardBounce);
    dashboardBounce = setTimeout(() => this._push(), DASHBOARD_BOUNCE_MS);
  }

  // Push current state to the webview.
  _push() {
    // The one place a torn-down extension could still reach the dashboard: every
    // refresh() call site funnels through here.
    //
    // `visible` as well as `!this.view`, and the two cover different states. The
    // view is DISPOSED when hidden — the manifest declares it without
    // retainContextWhenHidden — and onDidDispose nulls `this.view`, so the
    // `!this.view` half already covers a closed sidebar. What it does not cover is
    // the view being collapsed within a showing container, where it stays alive
    // and merely turns invisible, and the window between a hide and its disposal
    // event being delivered. In both, the full synchronous work-up ran and posted
    // to a webview whose content had already been torn down.
    //
    // No dirty flag is needed: resolveWebviewView already installs
    // `onDidChangeVisibility(() => { if (view.visible) this.refresh(); })`, so
    // becoming visible re-pushes with fresh state.
    //
    // Scope note, because an audit oversold this one: it is NOT worth ~22 ms x 50
    // sites, because the dominant collapsed-sidebar case was already handled. It
    // is worth the one line as robustness.
    if (deactivated || !this.view || !this.view.visible) return;
    const hint = this.hint;
    this.hint = null;
    const settings = readSettings();
    const allow = Array.isArray(settings?.permissions?.allow) ? settings.permissions.allow : [];
    const wildcards = allow.filter((p) => p.includes('*')).sort();
    // What Wildcard Now would actually change. The "specific" tally is not that
    // number: an entry with no `*` is often one the pass can never generalize
    // (Edit, Write, WebSearch, an exact mcp__server__tool), so badging the button
    // with it advertises work that resolves to "already optimal".
    //
    // processAllowList is quadratic — ~57ms on the 423-entry list this was built
    // for — and runWildcarding had just run it over the same input immediately
    // before calling refresh(), so every settings write paid for it twice on the
    // extension-host thread.
    const optimized = hint && sameList(hint.allow, allow) ? hint.optimized : processAllowList(allow);
    const pendingWildcard = optimized.length === allow.length && optimized.every((p, i) => p === allow[i])
      ? 0
      : optimized.filter((p) => !allow.includes(p)).length + allow.filter((p) => !optimized.includes(p)).length;
    // The live wildcarding pass watches Claude's settings.json; Auto Learn also
    // reads Codex history (regardless of codexScope, which only gates rule writes).
    // Name Codex in the status card whenever both are true, so the flagship line
    // isn't Claude-only for a cross-agent tool.
    const autoLearn = autoLearnCardData();
    const codexWatching = !!autoLearn.enabled && fs.existsSync(CODEX_SESSIONS_DIR);
    // One memory report for the whole push, hoisted for the same reason autoLearn
    // above it is: two cards need it and it is not cheap. memoryCardData consumes
    // conf plus six report fields; gatesCardData needs the single integer
    // report.gateSources, which this call has already computed. Measured 2.93 ms
    // and 25 fs syscalls saved per refresh.
    //
    // On a throw, fall back to the SHAPE both builders already read as "no card"
    // rather than to null. Passing null would make each builder take its
    // fresh-call default and throw again — three calls on the error path instead
    // of the two we started with. This shape is also exactly what every test stub
    // for memoryReport returns, so the failure path is the path already covered.
    let memory;
    try { memory = memoryReport(); }
    catch { memory = { conf: {}, dir: null, report: null }; }
    this.view.webview.postMessage({
      type: 'data',
      active: fs.existsSync(SETTINGS),
      settingsPath: SETTINGS.replace(os.homedir(), '~'),
      version: extensionVersion(),
      codexWatching,
      total: allow.length,
      wildcardCount: wildcards.length,
      specificCount: allow.length - wildcards.length,
      pendingWildcard,
      backupCount: backupCount(),
      wildcards,
      lastRun,
      max: { on: isMaxOn(settings), layers: maxLayers(settings) },
      codexMax: (() => {
        const state = frictionState();
        const target = targetApproval(readEnterpriseBundle());
        return {
          on: state.codex === 'max',
          absent: state.codex === 'absent',
          approval: state.codexApproval,
          sandbox: state.codexSandbox,
          restricted: target.restricted,
          allowed: target.allowed,
        };
      })(),
      autoLearn,
      memory: memoryCardData(memory),
      local: localCardData(),
      guidance: guidanceCardData(),
      gates: gatesCardData(memory),
    });
  }

  // Remove a single permission entry (the per-row prune button).
  _remove(perm) {
    removeAllowEntry(perm);
    this.refresh();
  }

  _html(webview) {
    const nonce = crypto.randomBytes(16).toString('hex');
    const csp = [
      "default-src 'none'",
      "style-src 'unsafe-inline'",
      `script-src 'nonce-${nonce}'`,
    ].join('; ');

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground);
         padding: 10px 12px; font-size: 13px; }
  .card { background: var(--vscode-editorWidget-background, rgba(127,127,127,0.08));
          border: 1px solid var(--vscode-widget-border, transparent);
          border-radius: 6px; padding: 10px 12px; margin-bottom: 10px; }
  .status { display: flex; align-items: center; gap: 8px; font-weight: 600; }
  /* Quiet and pushed to the right, so it answers "which build am I looking at"
     without competing with the state it sits beside. */
  .ver { margin-left: auto; font-weight: 400; font-size: 11px;
         color: var(--vscode-descriptionForeground); }
  .dot { width: 9px; height: 9px; border-radius: 50%; background: var(--vscode-charts-green, #3fb950);
         box-shadow: 0 0 6px var(--vscode-charts-green, #3fb950); flex: 0 0 auto; }
  .dot.idle { background: var(--vscode-charts-yellow, #d29922); box-shadow: 0 0 6px var(--vscode-charts-yellow, #d29922); }
  .dot.on { background: var(--vscode-charts-red, #f85149); box-shadow: 0 0 6px var(--vscode-charts-red, #f85149); }
  .dot.blocked { background: var(--vscode-charts-red, #f85149); box-shadow: 0 0 6px var(--vscode-charts-red, #f85149); }
  #codexMaxCard.on, #maxCard.on { border-color: var(--vscode-charts-red, #f85149); }
  button.bypass { width: 100%; padding: 7px; border-radius: 5px; cursor: pointer; margin-top: 8px;
          font-size: 12px; font-weight: 600;
          border: 1px solid var(--vscode-button-border, var(--vscode-widget-border, transparent));
          background: var(--vscode-button-secondaryBackground, transparent);
          color: var(--vscode-button-secondaryForeground, var(--vscode-foreground)); }
  button.bypass.on { background: var(--vscode-charts-red, #f85149); color: #fff; border-color: transparent; }
  /* Guidance ON is the state you want, not a danger state, so it must not inherit the red
     bypass look — red there says "you are exposed", which is backwards. Quiet it right
     down: the remove action should not read as the card's primary call to action. */
  button.bypass.managed, button.bypass.managed.on {
    background: transparent; color: var(--vscode-descriptionForeground);
    border-color: var(--vscode-panel-border); font-weight: 400;
  }
  button.bypass.managed:hover:not(:disabled) {
    color: var(--vscode-foreground); border-color: var(--vscode-focusBorder);
  }
  button.bypass:hover { background: var(--vscode-button-secondaryHoverBackground, var(--vscode-list-hoverBackground)); }
  button.bypass.on:hover { filter: brightness(1.1); }
  button.bypass:disabled { opacity: 0.5; cursor: not-allowed; }
  button.bypass:disabled:hover { background: var(--vscode-button-secondaryBackground, transparent); filter: none; }
  .muted { color: var(--vscode-descriptionForeground); font-size: 11px; }
  .sub { margin-top: 4px; }
  .stats { display: flex; gap: 10px; }
  .stat { flex: 1; text-align: center; }
  .stat .n { font-size: 22px; font-weight: 700; line-height: 1.1; }
  .stat .l { font-size: 10px; text-transform: uppercase; letter-spacing: .04em;
             color: var(--vscode-descriptionForeground); }
  button.run { width: 100%; padding: 7px; border: none; border-radius: 5px; cursor: pointer;
          font-size: 13px; font-weight: 600; margin-bottom: 6px;
          background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  button.run:hover { background: var(--vscode-button-hoverBackground); }
  button.restore { width: 100%; padding: 6px; border-radius: 5px; cursor: pointer;
          font-size: 12px; margin-bottom: 12px;
          border: 1px solid var(--vscode-button-border, var(--vscode-widget-border, transparent));
          background: var(--vscode-button-secondaryBackground, transparent);
          color: var(--vscode-button-secondaryForeground, var(--vscode-foreground)); }
  button.restore:hover { background: var(--vscode-button-secondaryHoverBackground, var(--vscode-list-hoverBackground)); }
  .listhead { display: flex; justify-content: space-between; align-items: baseline;
              margin: 2px 2px 6px; cursor: pointer; user-select: none; }
  .listhead:hover .h { color: var(--vscode-textLink-foreground); }
  .listhead .h { font-weight: 600; }
  #chev { display: inline-block; width: 1em; font-size: 10px; }
  ul { list-style: none; margin: 0; padding: 0; }
  li { display: flex; align-items: center; gap: 6px; padding: 4px 6px; border-radius: 4px; }
  li:hover { background: var(--vscode-list-hoverBackground); }
  li code { font-family: var(--vscode-editor-font-family, monospace); font-size: 12px;
            flex: 1 1 auto; word-break: break-all; }
  li .x { flex: 0 0 auto; cursor: pointer; border: none; background: transparent;
          color: var(--vscode-descriptionForeground); font-size: 14px; line-height: 1;
          padding: 2px 5px; border-radius: 4px; visibility: hidden; }
  li:hover .x { visibility: visible; }
  li .x:hover { background: var(--vscode-toolbar-hoverBackground); color: var(--vscode-errorForeground); }
  .empty { color: var(--vscode-descriptionForeground); font-style: italic; padding: 6px; }
  li.more { color: var(--vscode-textLink-foreground); cursor: pointer; font-size: 11px;
            padding: 6px; }
  li.more:hover { text-decoration: underline; }
  #memDir { word-break: break-all; }
  .memissues { margin: 8px 2px 6px; font-size: 11px; }
  .memlink { color: var(--vscode-textLink-foreground); cursor: pointer; text-decoration: none; }
  .memlink:hover { text-decoration: underline; }
  .buttonrow { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin-top: 8px; }
  .buttonrow button { margin: 0; }

  /* ── layout: one hero, everything else a stateful row ──────────────────────
     Nine equally-weighted cards meant nothing was weighted: a destructive MAX
     toggle rendered exactly like a token gauge. So exactly one card keeps card
     chrome, and every secondary feature becomes a single collapsed row whose
     CURRENT STATE is on the right-hand side — the point being that you never
     expand a row just to find out where it stands. */
  .hero { background: var(--vscode-editorWidget-background, rgba(127,127,127,0.08));
          border: 1px solid var(--vscode-widget-border, transparent);
          border-radius: 6px; padding: 12px; margin-bottom: 4px; }
  .heronum { text-align: center; font-size: 30px; font-weight: 700; line-height: 1.05;
             margin: 10px 0 2px; }
  .heronum small { font-size: 13px; font-weight: 400; color: var(--vscode-descriptionForeground); }
  .herosub { text-align: center; font-size: 11px; color: var(--vscode-descriptionForeground);
             margin-bottom: 12px; }
  .hero button.run, .hero button.restore { margin-bottom: 0; }
  .hero button.restore { margin-top: 6px; }

  .row { border-top: 1px solid var(--vscode-panel-border, rgba(127,127,127,0.25)); }
  .row:last-of-type { border-bottom: 1px solid var(--vscode-panel-border, rgba(127,127,127,0.25)); }
  .rowhead { display: flex; align-items: center; gap: 8px; padding: 8px 2px;
             cursor: pointer; user-select: none; }
  .rowhead:hover .rowname { color: var(--vscode-textLink-foreground); }
  /* An identity glyph, not a status colour. The state itself is the text on the
     right, so a collapsed row never communicates by hue alone — which the eleven
     glowing dots this replaces did, on a red/green axis. */
  .glyph { flex: 0 0 auto; width: 1.1em; text-align: center; font-size: 11px;
           color: var(--vscode-descriptionForeground); }
  .chev { flex: 0 0 auto; width: .8em; font-size: 9px; color: var(--vscode-descriptionForeground); }
  .rowname { font-weight: 600; flex: 1 1 auto; }
  .rowstate { flex: 0 0 auto; font-size: 11px; color: var(--vscode-descriptionForeground);
              text-align: right; }
  .rowstate.warn { color: var(--vscode-charts-yellow, #d29922); }
  .rowstate.hot  { color: var(--vscode-charts-red, #f85149); font-weight: 600; }
  .rowbody { padding: 0 2px 10px 2.1em; }
  .rowbody[hidden] { display: none; }
  /* The card markup inside a row keeps its ids and its JS untouched, and simply
     stops drawing itself as a card. */
  .row .card { background: none; border: none; border-radius: 0; padding: 0; margin: 0 0 8px; }
  .row .card:last-child { margin-bottom: 0; }
  /* MAX-on has to stay loud, and a nested card has no border left to colour. */
  .row #maxCard.on, .row #codexMaxCard.on {
    border-left: 2px solid var(--vscode-charts-red, #f85149); padding-left: 8px; }
  /* The glow was 6px on every one of eleven dots. Kept as a plain 8px pip. */
  .dot { box-shadow: none; width: 8px; height: 8px; }
  .row .status { font-weight: 400; font-size: 12px; }
  #autoLearnCard > .status { display: none; }
</style>
</head>
<body>
  <div class="hero">
    <div class="status"><span id="dot" class="dot"></span><span id="statusText">Active</span><span id="version" class="ver"></span></div>
    <div class="muted sub" id="watching">watching settings.json</div>

    <div class="heronum"><span id="total">–</span> <small>approved</small></div>
    <div class="herosub">
      <span id="wildcards">–</span> wildcards · <span id="specific">–</span> specific
    </div>

    <button class="run" id="runNow">⟳  Wildcard Now</button>
    <button class="restore" id="restore" title="Merge your saved backup back into the allow list">⤺  Restore prunes from backup</button>
    <div class="muted sub" id="lastRun"></div>
    <div class="muted" id="backup"></div>
  </div>

  <section class="row">
    <div class="rowhead" data-row="autoLearn">
      <span class="chev">▸</span><span class="glyph">✳</span>
      <span class="rowname">Auto Learn</span><span class="rowstate" id="stAutoLearn"></span>
    </div>
    <div class="rowbody" id="bodyAutoLearn" hidden>
      <div class="card" id="autoLearnCard">
        <div class="status"><span id="aldot" class="dot idle"></span><span id="altext">Auto Learn</span></div>
        <div class="muted sub" id="alsub">loading cross-agent history state…</div>
        <div class="stats" style="margin-top:8px">
          <div class="stat"><div class="n" id="alsafe">–</div><div class="l">safe</div></div>
          <div class="stat"><div class="n" id="alreview">–</div><div class="l">review</div></div>
          <div class="stat"><div class="n" id="alobserve">–</div><div class="l">observing</div></div>
        </div>
        <div class="buttonrow">
          <button class="restore" id="alScan">Scan now</button>
          <button class="restore" id="alReview">Review</button>
          <button class="restore" id="alUndo">Undo</button>
          <button class="restore" id="alWhy">Why prompt?</button>
        </div>
      </div>
    </div>
  </section>

  <section class="row">
    <div class="rowhead" data-row="max">
      <span class="chev">▸</span><span class="glyph">↯</span>
      <span class="rowname">MAX modes</span><span class="rowstate" id="stMax"></span>
    </div>
    <div class="rowbody" id="bodyMax" hidden>
      <div class="card" id="maxCard">
        <div class="status"><span id="mdot" class="dot idle"></span><span id="mtext">Claude MAX: OFF</span></div>
        <div class="muted sub" id="msub">Claude · skip every prompt — allow-wildcards + approve hook</div>
        <button class="bypass" id="maxBtn">⚡ Turn Claude MAX ON</button>
      </div>
      <div class="card" id="codexMaxCard">
        <div class="status"><span id="cxdot" class="dot idle"></span><span id="cxtext">Codex MAX: OFF</span></div>
        <div class="muted sub" id="cxsub">Codex · approval_policy=never — sandbox stays as the floor</div>
        <button class="bypass" id="codexMaxBtn">⚡ Turn Codex MAX ON</button>
      </div>
    </div>
  </section>

  <section class="row" id="localCard" style="display:none">
    <div class="rowhead" data-row="local">
      <span class="chev">▸</span><span class="glyph">▤</span>
      <span class="rowname">Project-local</span><span class="rowstate" id="stLocal"></span>
    </div>
    <div class="rowbody" id="bodyLocal" hidden>
    <div class="card">
    <div class="status"><span id="locdot" class="dot idle"></span><span id="loctext">Project-local approvals</span></div>
    <div class="muted sub" id="locsub"></div>
    <div class="stats" style="margin-top:8px">
      <div class="stat"><div class="n" id="locpromote">–</div><div class="l">promote</div></div>
      <div class="stat"><div class="n" id="locprune">–</div><div class="l">redundant</div></div>
      <div class="stat"><div class="n" id="lockept">–</div><div class="l">project-only</div></div>
    </div>
    <button class="restore" id="drainLocal" title="Promote portable local approvals to user scope, then drop the ones user scope covers">⤴  Drain into user scope</button>
    </div>
    </div>
  </section>

  <section class="row" id="guidanceCard" style="display:none">
    <div class="rowhead" data-row="guidance">
      <span class="chev">▸</span><span class="glyph">▣</span>
      <span class="rowname">Shell-style guidance</span><span class="rowstate" id="stGuidance"></span>
    </div>
    <div class="rowbody" id="bodyGuidance" hidden>
      <div class="card">
        <div class="status"><span id="gddot" class="dot idle"></span><span id="gdtext">Shell-style guidance</span></div>
        <div class="muted sub" id="gdsub"></div>
        <button class="bypass" id="guidanceBtn">Add to ~/.claude/CLAUDE.md</button>
      </div>
    </div>
  </section>

  <section class="row" id="gatesCard" style="display:none">
    <div class="rowhead" data-row="gates">
      <span class="chev">▸</span><span class="glyph">▣</span>
      <span class="rowname">Memory gates</span><span class="rowstate" id="stGates"></span>
    </div>
    <div class="rowbody" id="bodyGates" hidden>
      <div class="card">
        <div class="status"><span id="mgdot" class="dot idle"></span><span id="mgtext">Memory gates</span></div>
        <div class="muted sub" id="mgsub"></div>
        <button class="bypass" id="gatesBtn">Compile and add</button>
      </div>
    </div>
  </section>

  <section class="row" id="memCard" style="display:none">
    <div class="rowhead" data-row="memory">
      <span class="chev">▸</span><span class="glyph">◈</span>
      <span class="rowname">Memory</span><span class="rowstate" id="stMemory"></span>
    </div>
    <div class="rowbody" id="bodyMemory" hidden>
      <div class="card">
        <div class="status"><span id="llmDot" class="dot idle"></span><span id="llmText">CPU LLM</span></div>
        <div class="muted sub" id="memDir"></div>
        <div class="stats" style="margin-top:8px">
          <div class="stat"><div class="n" id="memTok">–</div><div class="l">tok/session</div></div>
          <div class="stat"><div class="n" id="memFiles">–</div><div class="l">files</div></div>
          <div class="stat"><div class="n" id="memEmb">–</div><div class="l">embedded</div></div>
        </div>
        <div class="memissues" id="memIssues"></div>
        <button class="restore" id="rebuild" title="Force a full CPU re-embed of the memory dir (recall.py --rebuild)">⟳  Rebuild recall index</button>
      </div>
    </div>
  </section>

  <section class="row">
    <div class="rowhead" id="toggle" data-row="list" title="Click to collapse / expand">
      <span class="chev" id="chev">▸</span><span class="glyph">✱</span>
      <span class="rowname">Wildcards tracked</span><span class="rowstate" id="wcount"></span>
    </div>
    <div class="rowbody" id="bodyList" hidden><ul id="list"></ul></div>
  </section>

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);

  // Which disclosure rows are open, persisted across reloads. Everything starts
  // CLOSED deliberately: the collapsed summary on the right of each row already
  // answers "where does this stand?", so opening a row is for acting on it, not
  // for reading it. That is the whole reason the summaries exist.
  // Enough to see the shape of the list without it becoming the panel.
  const LIST_CAP = 12;

  const st = vscode.getState() || {};
  const openRows = new Set(Array.isArray(st.open) ? st.open : []);
  const bodyFor = (key) => $('body' + key.charAt(0).toUpperCase() + key.slice(1));

  function applyRows() {
    for (const head of document.querySelectorAll('.rowhead')) {
      const key = head.dataset.row;
      if (!key) continue;
      const isOpen = openRows.has(key);
      const body = bodyFor(key);
      if (body) body.hidden = !isOpen;
      const chev = head.querySelector('.chev');
      if (chev) chev.textContent = isOpen ? '▾' : '▸';
    }
  }

  for (const head of document.querySelectorAll('.rowhead')) {
    head.addEventListener('click', () => {
      const key = head.dataset.row;
      if (!key) return;
      if (openRows.has(key)) openRows.delete(key); else openRows.add(key);
      vscode.setState({ open: [...openRows] });
      applyRows();
    });
  }

  // The collapsed state of every row. Each is a short phrase, never a bare
  // colour: eleven glowing red/green dots used to be the only signal, which is
  // unreadable for the ~8% of men with a red-green deficiency and ambiguous for
  // everyone else ('is yellow bad?'). The hot/warn tones tint a phrase that is
  // already legible on its own.
  function setState(id, text, tone) {
    const el = $(id);
    if (!el) return;
    el.textContent = text || '';
    el.className = 'rowstate' + (tone ? ' ' + tone : '');
  }

  function renderRowStates(d) {
    const a = d.autoLearn || {};
    const counts = a.counts || {};
    if (!a.enabled) setState('stAutoLearn', 'disabled');
    else if (a.busy) setState('stAutoLearn', 'scanning…');
    else if (a.error) setState('stAutoLearn', 'error', 'hot');
    else if (counts.review) setState('stAutoLearn', counts.review + ' to review', 'warn');
    else if (counts.safe) setState('stAutoLearn', counts.safe + ' safe to apply', 'warn');
    else setState('stAutoLearn', String(a.mode || 'recommend'));

    const cOn = !!(d.max && d.max.on);
    const xOn = !!(d.codexMax && d.codexMax.on);
    if (cOn && xOn) setState('stMax', 'both ON', 'hot');
    else if (cOn) setState('stMax', 'Claude ON', 'hot');
    else if (xOn) setState('stMax', 'Codex ON', 'hot');
    else if (d.codexMax && d.codexMax.restricted) setState('stMax', 'off · Codex capped');
    else setState('stMax', 'both off');

    const g = d.guidance || {};
    setState('stGuidance', !g.on ? 'not installed' : (g.current ? 'on' : 'older wording'),
      !g.on || g.current ? null : 'warn');

    const gt = d.gates || {};
    setState('stGates', !gt.compiled ? 'nothing compiled'
      : !gt.on ? gt.count + ' waiting'
        : (gt.current ? gt.count + ' active' : 'stale — refresh'),
      !gt.compiled ? null : (!gt.on || !gt.current ? 'warn' : null));

    const m = d.memory || {};
    const issues = (m.over || 0) + (m.broken || 0) + (m.unresolved || 0);
    setState('stMemory',
      (m.tokens != null ? fmtK(m.tokens) + ' tok' : 'no index')
        + (issues ? ' · ' + issues + ' to fix' : ''),
      issues ? 'warn' : null);

    // promote/prune are counts, not arrays, and 'pending' is defined the same way
    // renderLocal defines it, so the row and the card can never disagree.
    const l = d.local || {};
    const pending = (l.promote || 0) + (l.prune || 0);
    if (l.blocked) setState('stLocal', 'blocked by MAX', 'warn');
    else if (!l.trusted) setState('stLocal', 'workspace not trusted');
    else if (pending) setState('stLocal', pending + ' to drain', 'warn');
    else setState('stLocal', 'drained');

    setState('wcount', d.wildcardCount + ' total');
  }

  function timeAgo(ts) {
    if (!ts) return '';
    const s = Math.round((Date.now() - ts) / 1000);
    if (s < 5)   return 'last wildcarded: just now';
    if (s < 60)  return 'last wildcarded: ' + s + 's ago';
    if (s < 3600) return 'last wildcarded: ' + Math.round(s/60) + 'm ago';
    return 'last wildcarded: ' + Math.round(s/3600) + 'h ago';
  }

  function renderMax(m) {
    const on = !!(m && m.on);
    const L = (m && m.layers) || {};
    $('mdot').className = 'dot' + (on ? ' on' : ' idle');
    $('mtext').textContent = on ? 'Claude MAX: ON — all Claude prompts skipped' : 'Claude MAX: OFF';
    $('msub').textContent = on
      ? 'Claude · layers: allow-wildcards ' + (L.allow ? '✓' : '✕') + ', approve-hook ' + (L.hook ? '✓' : '✕') + ' · deny still applies'
      : 'Claude · skip every prompt — allow-wildcards + approve hook';
    $('maxBtn').textContent = on ? '⚡ Turn Claude MAX OFF' : '⚡ Turn Claude MAX ON';
    $('maxBtn').className = 'bypass' + (on ? ' on' : '');
    $('maxCard').className = 'card' + (on ? ' on' : '');
  }

  function renderCodexMax(c) {
    const on = !!(c && c.on);
    const absent = !!(c && c.absent);
    // "never" is the only approval_policy that skips every prompt. Where the org
    // forbids it, Codex MAX has no on-state to reach, so it is unavailable rather
    // than off — and the button is disabled, because clicking it can only write
    // the org default (which the card would otherwise misread as "MAX on").
    const restricted = !on && !absent && !!(c && c.restricted);
    $('cxdot').className = 'dot' + (on ? ' on' : restricted ? ' blocked' : ' idle');
    $('cxtext').textContent = absent
      ? 'Codex MAX: no config.toml'
      : on ? 'Codex MAX: ON — all Codex prompts skipped'
      : restricted ? 'Codex MAX: unavailable — org policy caps approval'
      : 'Codex MAX: OFF';
    // Always name the remaining floor: this switch never touches the sandbox.
    const allowed = (c && c.allowed && c.allowed.length) ? c.allowed.join(', ') : 'the org-permitted set';
    $('cxsub').textContent = absent
      ? 'Codex · no ~/.codex/config.toml found'
      : on
        ? 'Codex · approval_policy=' + (c.approval || '?') + (c.restricted ? ' (org policy caps this)' : '') + ' · ' + (c.sandbox || 'sandbox') + ' sandbox still blocks network + out-of-workspace writes'
      : restricted
        ? "Codex · org allows only [" + allowed + "], so 'never' (skip all prompts) can't be set. Current approval_policy=" + (c.approval || 'default') + '.'
        : 'Codex · approval_policy=' + (c.approval || 'default') + ' — sandbox stays as the floor';
    $('codexMaxBtn').textContent = on ? '⚡ Turn Codex MAX OFF' : '⚡ Turn Codex MAX ON';
    $('codexMaxBtn').className = 'bypass' + (on ? ' on' : '');
    $('codexMaxBtn').disabled = absent || restricted;
    $('codexMaxCard').className = 'card' + (on ? ' on' : '');
  }


  function renderAutoLearn(a) {
    a = a || {};
    const counts = a.counts || {};
    const active = !!a.enabled;
    $('aldot').className = 'dot' + (active && !a.error ? '' : ' idle');
    const alMode = String(a.mode || 'recommend').toLowerCase();
    // 'recommend' is the default and the usual state — show it unlabeled; only name
    // the mode when it's the less-common observe / auto-safe.
    $('altext').textContent = 'Auto Learn' + (alMode === 'recommend' ? '' : ': ' + alMode.toUpperCase());
    const notes = [active ? 'Claude + Codex history' : 'disabled', 'threshold ' + (a.threshold || 3), 'Codex ' + (a.codexScope || 'user')];
    if (counts.covered) notes.push(counts.covered + ' already covered');
    if (a.busy) notes.unshift('scanning…');
    if (a.scopeWarning) notes.push(a.scopeWarning);
    if (a.error) notes.push('error: ' + a.error);
    $('alsub').textContent = notes.join(' · ');
    $('alsafe').textContent = counts.safe || 0;
    $('alreview').textContent = counts.review || 0;
    $('alobserve').textContent = counts.observe || 0;
    $('alUndo').disabled = !a.canUndo || !!a.busy;
    for (const id of ['alScan', 'alWhy']) $(id).disabled = !!a.busy;
    $('alReview').disabled = !active || !!a.busy || a.mode === 'observe';
    $('alReview').textContent = (counts.review > 0) ? 'Review (' + counts.review + ')' : 'Review';
  }

  function fmtK(n) {
    return n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n);
  }

  function renderMemory(m) {
    const card = $('memCard');
    if (!m) { card.style.display = 'none'; return; }
    card.style.display = '';

    const ready = m.llm === 'ready';
    $('llmDot').className = 'dot' + (ready ? '' : ' idle');
    $('llmText').textContent = ready
      ? 'CPU LLM: ready (bge-small, 384-dim)'
      : (m.llm === 'model-missing' ? 'CPU LLM: model not found' : 'CPU LLM: venv not found');
    $('llmText').style.fontWeight = '600';
    $('memDir').textContent = m.dir;

    $('memTok').textContent = fmtK(m.tokens);
    $('memTok').title = 'budget ' + fmtK(m.budgetTokens) + ' tok/session';
    if (m.overBudget) $('memTok').style.color = 'var(--vscode-charts-red, #f85149)';
    else $('memTok').style.color = '';
    $('memFiles').textContent = m.files;
    $('memFiles').title = m.indexable == null
      ? 'markdown files in the memory dir'
      : m.indexable + ' indexable + MEMORY.md (the index itself is never embedded)';
    $('memEmb').textContent = m.embedded == null ? '–' : m.embedded;
    $('memEmb').title = m.embedded == null
      ? 'recall cache not built yet — click Rebuild'
      : m.embedded + ' of ' + (m.indexable == null ? '?' : m.indexable) + ' indexable memories embedded'
        + (m.stale ? ' — cache is behind the files' : '');
    $('memEmb').style.color = m.stale ? 'var(--vscode-charts-yellow, #d29922)' : '';

    const issues = [];
    if (m.over)   issues.push(m.over + ' over budget');
    if (m.broken) issues.push(m.broken + ' broken link' + (m.broken !== 1 ? 's' : ''));
    const el = $('memIssues');
    el.innerHTML = '';
    if (issues.length) {
      el.className = 'memissues';
      const a = document.createElement('a');
      a.className = 'memlink';
      a.textContent = '⚠ ' + issues.join(' · ') + ' — open report';
      a.addEventListener('click', (e) => { e.preventDefault(); vscode.postMessage({ type: 'lintMemory' }); });
      el.appendChild(a);
    } else {
      el.className = 'memissues muted';
      el.textContent = '✓ index clean, all links resolve';
    }
  }

  function renderLocal(l) {
    const card = $('localCard');
    if (!l) { card.style.display = 'none'; return; }
    card.style.display = '';
    const pending = l.promote + l.prune;
    $('locdot').className = 'dot' + (pending && l.trusted && !l.blocked ? '' : ' idle');
    $('loctext').textContent = l.blocked
      ? 'Project-local approvals — blocked by MAX'
      : (pending ? 'Project-local approvals: ' + pending + ' to drain' : 'Project-local approvals: drained');
    $('loctext').style.fontWeight = '600';
    $('locsub').textContent = l.blocked
      ? 'Claude MAX covers every local entry — turn MAX off before draining'
      : (!l.trusted ? 'workspace not trusted — read-only'
        : (l.folders > 1 ? l.folders + ' folders · ' + l.file : l.file)
          + (l.enabled ? '' : ' · auto-drain off'));
    $('locpromote').textContent = l.promote;
    $('locprune').textContent = l.prune;
    $('lockept').textContent = l.kept;
    $('locpromote').title = 'portable command families that would move to user scope';
    $('locprune').title = 'local entries user scope already grants';
    $('lockept').title = 'entries only this project can justify (script blobs, absolute paths, MCP tools)';
    $('drainLocal').disabled = !l.trusted || !!l.blocked || pending === 0;
    $('drainLocal').textContent = pending
      ? '⤴  Drain ' + pending + ' into user scope'
      : '⤴  Nothing to drain';
  }

  function renderGuidance(g) {
    const card = $('guidanceCard');
    if (!g) { card.style.display = 'none'; return; }
    card.style.display = '';
    $('gddot').className = 'dot' + (g.on && g.current ? '' : ' idle');
    const state = g.on ? (g.current ? 'ON' : 'ON (older wording)') : (g.partial ? 'PARTIAL' : 'OFF');
    $('gdtext').textContent = 'Shell-style guidance: ' + state
      + (g.agents.length ? ' — ' + g.agents.join(' + ') : '');
    $('gdtext').style.fontWeight = '600';
    $('gdsub').textContent = g.on || g.partial
      ? 'one command per call → every approval generalizes · ' + g.path
      : 'teach ' + g.targets.join(' + ') + ' to write approvals that can be wildcarded';
    const btn = $('guidanceBtn');
    btn.disabled = !g.readable;
    btn.classList.toggle('on', !!g.on);
    // Installed-and-current is the resting state, so the button goes quiet and the ellipsis
    // announces the confirm dialog. Stale wording gets the honest label instead, now that
    // toggling a stale block refreshes it rather than tearing it out.
    btn.classList.toggle('managed', !!g.on && !!g.current);
    btn.textContent = g.on
      ? (g.current ? 'Remove guidance…' : 'Refresh wording')
      : 'Add to ' + g.targets.join(' + ') + ' instructions';
  }

  function renderGates(g) {
    const card = $('gatesCard');
    if (!g) { card.style.display = 'none'; return; }
    card.style.display = '';
    $('mgdot').className = 'dot' + (g.on && g.current ? '' : ' idle');
    const state = !g.compiled ? 'nothing compiled'
      : g.on ? (g.current ? 'ON' : 'ON (corpus changed)')
        : (g.partial ? 'PARTIAL' : 'OFF');
    $('mgtext').textContent = 'Memory gates: ' + state
      + (g.on && g.count ? ' — ' + g.count + ' gate' + (g.count === 1 ? '' : 's') : '');
    $('mgtext').style.fontWeight = '600';
    $('mgsub').textContent = !g.compiled
      ? 'no memory carries a scope:global gate block yet'
      : g.on || g.partial
        ? 'your standing orders, resident every session · ' + g.path
        : g.count + ' compiled gate' + (g.count === 1 ? '' : 's') + ' waiting to be installed';
    const btn = $('gatesBtn');
    // Nothing compiled AND no memory the compiler could take: offering "Compile
    // gates" here spent a modal, a compile and a warning toast to end up saying
    // "nothing to install". Say it on the button instead. gateSources is only
    // trusted when it is a number — undefined means the memory report was
    // unavailable, and an unknown count must still offer the action.
    const noSources = g.gateSources === 0;
    btn.disabled = !g.readable || (!g.compiled && noSources);
    btn.classList.toggle('on', !!g.on);
    // Same treatment as guidance: installed-and-current is the resting state, so the button
    // stops shouting and the ellipsis warns that a confirm follows.
    btn.classList.toggle('managed', !!g.on && !!g.current);
    btn.textContent = !g.compiled ? (noSources ? 'No gates to compile' : 'Compile gates')
      : g.on ? (g.current ? 'Remove gates…' : 'Refresh from memory')
        : 'Add to ' + g.targets.join(' + ') + ' instructions';
  }

  function render(d) {
    $('dot').className = 'dot' + (d.active ? '' : ' idle');
    $('statusText').textContent = d.active ? 'Active' : 'Idle — settings.json not found';
    // Empty string when the manifest could not be read, which renders as nothing
    // rather than as 'v' or 'undefined'.
    $('version').textContent = d.version ? 'v' + d.version : '';
    $('watching').textContent = 'watching ' + d.settingsPath + (d.codexWatching ? ' + Codex history' : '');
    renderMax(d.max);
    renderCodexMax(d.codexMax);
    renderAutoLearn(d.autoLearn);
    renderLocal(d.local);
    renderGuidance(d.guidance);
    renderGates(d.gates);
    renderMemory(d.memory);
    $('lastRun').textContent = timeAgo(d.lastRun);
    $('backup').textContent = d.backupCount
      ? 'backup: ' + d.backupCount + ' entries saved'
      : 'backup: none yet';
    $('total').textContent = d.total;
    $('wildcards').textContent = d.wildcardCount;
    $('specific').textContent = d.specificCount;
    $('wcount').textContent = d.wildcardCount + ' total';
    $('runNow').textContent = (d.pendingWildcard > 0) ? '⟳  Wildcard Now (' + d.pendingWildcard + ')' : '⟳  Wildcard Now';

    const list = $('list');
    list.innerHTML = '';
    if (!d.wildcards.length) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = 'No wildcards yet — approve some commands, or click Wildcard Now.';
      list.appendChild(li);
    } else {
      // Capped, because this list is a symptom of the tool WORKING: on this
      // machine it is 404 of 423 entries and the longest is 137 characters,
      // which wraps to three lines in a 320px sidebar — 10,796 px of list
      // inside a panel the wrong shape for it. The full set gets a QuickPick,
      // where the window is wide and there is a filter box.
      //
      // Ordered for the PREVIEW, not alphabetically. The list arrives sorted,
      // and quoted absolute paths sort ahead of letters, so a plain slice showed
      // twelve quoted-absolute-path blobs — the least
      // recognisable entries in the set, making the panel look like noise, which
      // is the exact complaint the cap exists to answer. Bare command families
      // first, everything else after, each half still alphabetical.
      const simple = (p) => /^[A-Za-z]+\([A-Za-z][\w.-]*[ :]\*\)$/.test(p);
      const preview = [...d.wildcards.filter(simple), ...d.wildcards.filter((p) => !simple(p))]
        .slice(0, LIST_CAP);
      for (const w of preview) {
        const li = document.createElement('li');
        const code = document.createElement('code');
        code.textContent = w;
        const x = document.createElement('button');
        x.className = 'x'; x.textContent = '✕'; x.title = 'Remove this entry';
        x.addEventListener('click', () => vscode.postMessage({ type: 'remove', value: w }));
        li.appendChild(code); li.appendChild(x);
        list.appendChild(li);
      }
      const hidden = d.wildcards.length - LIST_CAP;
      if (hidden > 0) {
        const li = document.createElement('li');
        li.className = 'more';
        li.title = 'Open the full list with a filter box';
        li.textContent = 'and ' + hidden + ' more — search all ' + d.wildcards.length + ' →';
        li.addEventListener('click', () => vscode.postMessage({ type: 'showWildcards' }));
        list.appendChild(li);
      }
    }
    applyRows();
    renderRowStates(d);
  }

  $('runNow').addEventListener('click', () => vscode.postMessage({ type: 'runNow' }));
  $('alScan').addEventListener('click', () => vscode.postMessage({ type: 'autoLearnScan' }));
  $('alReview').addEventListener('click', () => vscode.postMessage({ type: 'autoLearnReview' }));
  $('alUndo').addEventListener('click', () => vscode.postMessage({ type: 'autoLearnUndo' }));
  $('alWhy').addEventListener('click', () => vscode.postMessage({ type: 'autoLearnWhy' }));
  $('restore').addEventListener('click', () => vscode.postMessage({ type: 'restore' }));
  $('rebuild').addEventListener('click', () => vscode.postMessage({ type: 'rebuildRecall' }));
  $('maxBtn').addEventListener('click', () => vscode.postMessage({ type: 'toggleMax' }));
  $('codexMaxBtn').addEventListener('click', () => vscode.postMessage({ type: 'toggleCodexMax' }));
  $('drainLocal').addEventListener('click', () => vscode.postMessage({ type: 'drainLocal' }));
  $('guidanceBtn').addEventListener('click', () => vscode.postMessage({ type: 'toggleGuidance' }));
  $('gatesBtn').addEventListener('click', () => vscode.postMessage({ type: 'toggleGates' }));
  window.addEventListener('message', (e) => { if (e.data?.type === 'data') render(e.data); });
  applyRows();
  vscode.postMessage({ type: 'refresh' });
</script>
</body>
</html>`;
  }
}

async function deactivate() {
  const generation = activationGeneration;
  // First, before anything is awaited: everything below this line is racing the
  // continuations it is trying to stop.
  deactivated = true;
  clearTimeout(debounceTimer);
  clearTimeout(policyBounce);
  clearTimeout(localDrainBounce);
  clearTimeout(memBounce);
  clearTimeout(autoLearnBounce);
  clearInterval(autoLearnTimer);
  // These two were missed. `gatesBounce` spawns Python from its callback, and
  // the recall timeout's handle was never captured at all, so both could fire
  // against a torn-down extension after a reload or an upgrade.
  clearTimeout(gatesBounce);
  clearTimeout(recallSyncTimer);
  clearTimeout(dashboardBounce);
  // A cleared timer only stops a spawn that had not started. These four had, and
  // nothing retained them, so a reload left up to a 180s python child running
  // against a torn-down host — and the gate compile's callback wrote policy.
  killLiveChildren();
  if (outputChannel) { try { outputChannel.dispose(); } catch { /* already gone */ } }
  outputChannel = null;
  // The retainers, dropped BEFORE the await, not after.
  //
  // These hold real memory across a same-realm re-activate (an extension
  // disable/enable, or an upgrade), unlike the timer handles above — which are
  // already cleared, and holding a dead handle costs nothing:
  //
  //   dashboard    the webview provider, and through it the whole ExtensionContext
  //   memoryLint   the same, via this.context, which reconfigure() needs
  //   autoLearnManager / autoLearnCardCache   parsed history state, the largest
  //                thing this extension ever builds
  //
  // They were originally nulled at the END of this function, after the drain, and
  // that was a real defect. The drain below has no deadline by deliberate
  // decision, so if the host's deactivate timeout expires and a same-realm
  // activate() runs during it, this continuation resumes and nulls slots the
  // SUCCESSOR has already populated. Measured: 0 pushes reached the successor's
  // live webview through `dashboard?.refresh()` while calling refresh() on the
  // instance directly still produced one — the panel rendered and its buttons
  // worked, and all ~35 refresh call sites were a permanent no-op for the life of
  // the window. `memoryLint = null` did the same to reconfigure(), which is
  // verbatim the defect reconfigure() was added to fix.
  //
  // None of them needs the drain to finish, so nothing is lost by dropping them
  // here.
  dashboard = null;
  memoryLint = null;
  autoLearnManager = null;
  autoLearnManagerKey = null;
  autoLearnCardCache = null;

  if (autoLearnWorkerRunner) await autoLearnWorkerRunner.deactivate();
  // This one DOES have to come after the drain, so nothing shortens it.
  // `deactivating` inside the runner is sticky and its public API has no reset,
  // while getAutoLearnWorkerRunner() only builds one when the slot is empty — so
  // a retained instance made every Auto Learn op after a same-realm re-activate
  // reject "Auto Learn is deactivating", permanently. Nulling it is correct
  // whether or not a successor exists: the successor could not have created its
  // own while this slot was full, so it would inherit this dead one.
  autoLearnWorkerRunner = null;
  // The busy latch is different: a successor's in-flight scan can legitimately
  // hold it, so only clear it if no re-activate happened while we awaited.
  // `activate()` bumps the generation, which is the cheapest way to tell.
  if (generation === activationGeneration) autoLearnBusy = false;
}

module.exports = { activate, deactivate };
