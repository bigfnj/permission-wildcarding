'use strict';

// Agent guidance — stop the prompts being *created*.
//
// Wildcarding and Auto Learn both act after the fact: a prompt happens, an
// approval is stored, and this repo generalizes it so the next one does not
// prompt. That leaves one class of friction untouched, and it is the expensive
// one. A compound command (`cd x && dotnet build`, or a multi-statement
// PowerShell block) is stored *verbatim* when approved, because there is no
// single command root to key on — `src/permissions.js` deliberately leaves those
// entries alone rather than shattering a quoted path into junk. Such an entry
// can never match a second command, so every variation prompts again. That is
// what fills a project's settings.local.json with hundreds of one-shot grants.
//
// No generalizer can fix that entry after the fact. The only fix is upstream:
// the agent writes one command per call, so the approval it produces is a
// command family instead of a string literal. That is a prompt-side change, so
// it belongs in the agent's instructions — and the agent cannot reliably install
// it itself, since editing its own permission surface is exactly what a
// permission classifier stops. The extension writes it instead.
//
// The target is `~/.claude/CLAUDE.md`: user-scope, loaded in every session of
// every project. The block is fenced by markers so it is idempotent to rewrite,
// removable without touching a byte of the user's own text, and obvious to a
// human reading the file.

const fs = require('fs');
const os = require('os');
const path = require('path');

const { writeFileAtomicSync } = require('./permissions');

const BEGIN = '<!-- BEGIN permission-wildcarding: shell style (managed) -->';
const END = '<!-- END permission-wildcarding: shell style -->';

function guidancePath(home = os.homedir()) {
  return path.join(home, '.claude', 'CLAUDE.md');
}

function codexGuidancePath(home = os.homedir()) {
  return path.join(home, '.codex', 'AGENTS.md');
}

// Both agents load a user-scope instruction file, and both are hurt by the same
// habit for different reasons — Claude Code stores the approved command *string*,
// while Codex policy is an argv prefix for the program it actually executes, so a
// `bash -lc "cd x && build"` call is a `bash` invocation and a rule for the real
// tool never applies to it. One block, both files.
function guidanceTargets(home = os.homedir()) {
  return [
    { agent: 'claude', path: guidancePath(home) },
    { agent: 'codex', path: codexGuidancePath(home) },
  ];
}

// Only write for an agent that is actually installed: the file may not exist yet
// (that is fine, it gets created), but its config directory must, or this would
// conjure a ~/.codex on a machine that has never run Codex.
function installedGuidanceTargets(home = os.homedir()) {
  return guidanceTargets(home).filter((target) =>
    fs.existsSync(target.path) || fs.existsSync(path.dirname(target.path)));
}

// Kept short on purpose: this text is loaded into the context of every session,
// so it has the same budget discipline as a MEMORY.md hook line. Rules only,
// each one traceable to something the generalizer cannot do after the fact.
const GUIDANCE_BODY = `## Shell style that does not re-prompt

An approval is stored as the command *string* that was approved. One command per
call becomes a reusable wildcard (\`Bash(git *)\`); a compound command is stored
verbatim and never matches anything again, so every variation prompts afresh.

- **One command per tool call.** No \`&&\`, \`;\` or \`|\` chains, and no
  multi-statement PowerShell (\`$x = ...; if (...) { ... }\`). A chain built only
  from already-allowed commands is fine — Claude Code checks each sub-command —
  the cost lands when a chain needs a *new* approval.
- **Use the tool's own path flag, not \`cd\`.** \`git -C <path> status\`,
  \`npm --prefix <dir> run build\`, \`dotnet build <path>\`, \`rg <pat> <path>\`,
  \`tail -n 50 <file>\`. \`cd <path> && <cmd>\` keys the stored approval on
  \`cd\`, so the half that mattered never becomes a wildcard.
- **Call executables by bare name.** A quoted absolute path
  (\`& "C:\\Program Files\\App\\app.exe"\`) cannot be wildcarded at all — put its
  directory on PATH, or invoke a wrapper script.
- **Put multi-step work in a script and run the script.** One permission,
  reusable forever (\`./run-gate.ps1\`, \`./build.sh\`). This is the right answer
  whenever a build or a full verify needs several steps in order.
- \`VAR=value <cmd>\` prefixes are fine; they are stripped before matching.

Why both agents care: Claude Code stores the approved command *string*, and Codex
policy is an argv prefix for the program actually executed — so
\`bash -lc "cd x && build"\` is a \`bash\` call, and a rule for the real tool never
applies to it.

Managed by permission-wildcarding. Remove this block, or turn it off with
\`wildcard-perms --guidance off\`.`;

function guidanceBlock() {
  return `${BEGIN}\n${GUIDANCE_BODY}\n${END}\n`;
}

// Marker-fenced, so a rewrite replaces exactly what a previous version wrote and
// an "off" leaves the rest of the file untouched. Matching is anchored on the
// markers rather than the body text, which is what lets the wording change
// between releases without stranding an old copy.
function blockRange(text) {
  const start = text.indexOf(BEGIN);
  if (start === -1) return null;
  const end = text.indexOf(END, start);
  if (end === -1) return null;
  return { start, end: end + END.length };
}

function hasGuidance(text) {
  return blockRange(typeof text === 'string' ? text : '') !== null;
}

// Whether the installed block is the current wording. An upgrade should refresh
// a stale block silently; an unchanged one must not produce a write, or the
// extension would rewrite CLAUDE.md on every activation.
function isCurrent(text) {
  const range = blockRange(typeof text === 'string' ? text : '');
  if (!range) return false;
  return text.slice(range.start, range.end) === guidanceBlock().trimEnd();
}

// Compute the file content for turning guidance on/off. Pure, so the decision is
// testable without a filesystem: returns `changed: false` for a no-op.
function applyGuidance(text, on) {
  const current = typeof text === 'string' ? text : '';
  const range = blockRange(current);

  if (!on) {
    if (!range) return { changed: false, text: current };
    // Take the trailing newline with the block, and the blank line that was
    // inserted ahead of it, so removing and re-adding is a round trip. The
    // separator sweep eats the newline that ended the user's own last line too,
    // so put exactly one back — a text file keeps its final newline.
    let start = range.start;
    let end = range.end;
    while (end < current.length && current[end] === '\n') end += 1;
    while (start > 0 && current[start - 1] === '\n') start -= 1;
    let next = current.slice(0, start) + current.slice(end);
    if (next.length && !next.endsWith('\n')) next += '\n';
    return { changed: next !== current, text: next };
  }

  if (range) {
    if (isCurrent(current)) return { changed: false, text: current };
    const next = current.slice(0, range.start) + guidanceBlock().trimEnd() + current.slice(range.end);
    return { changed: true, text: next };
  }

  // Append rather than prepend: the user's own instructions keep their position
  // at the top of the file, where they were written to be read first.
  const separator = current.length === 0 ? '' : current.endsWith('\n\n') ? '' : current.endsWith('\n') ? '\n' : '\n\n';
  return { changed: true, text: `${current}${separator}${guidanceBlock()}` };
}

function readGuidanceFile(file) {
  try { return fs.readFileSync(file, 'utf8'); }
  catch (error) { return error.code === 'ENOENT' ? '' : null; }
}

function guidanceStatus(file = guidancePath()) {
  const text = readGuidanceFile(file);
  if (text === null) return { path: file, readable: false, on: false, current: false };
  return { path: file, readable: true, on: hasGuidance(text), current: isCurrent(text) };
}

// Drive the change. Backs the file up on first modification — this is the user's
// own instruction file, and a managed block that ate someone's notes would be
// unforgivable even though the marker logic says it cannot.
function setGuidance(on, {
  file = guidancePath(),
  backupDir = path.join(os.homedir(), '.claude', 'backups'),
  // Named per target, so the Claude and Codex instruction files cannot overwrite
  // each other's pre-change copy in the shared backup directory.
  backupName = 'CLAUDE.md.pre-guidance',
} = {}) {
  const text = readGuidanceFile(file);
  if (text === null) return { changed: false, error: `cannot read ${file}`, path: file, on: false };

  const result = applyGuidance(text, on);
  if (!result.changed) return { changed: false, path: file, on: hasGuidance(text), error: null };

  try {
    if (text.length) {
      fs.mkdirSync(backupDir, { recursive: true });
      writeFileAtomicSync(path.join(backupDir, backupName), text);
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeFileAtomicSync(file, result.text);
  } catch (error) {
    return { changed: false, path: file, on: hasGuidance(text), error: error.message };
  }
  return { changed: true, path: file, on: !!on, error: null };
}

// Every installed agent's file, as one call — what the CLI and the extension
// actually drive. Each target is independent: an unreadable or failed one is
// reported in its own row rather than aborting the others.
function guidanceStatusAll(home = os.homedir()) {
  return installedGuidanceTargets(home).map((target) => ({
    agent: target.agent,
    ...guidanceStatus(target.path),
  }));
}

function setGuidanceAll(on, { home = os.homedir(), backupDir } = {}) {
  return installedGuidanceTargets(home).map((target) => ({
    agent: target.agent,
    ...setGuidance(on, {
      file: target.path,
      ...(backupDir ? { backupDir } : {}),
      backupName: `${path.basename(target.path)}.pre-guidance`,
    }),
  }));
}

module.exports = {
  BEGIN, END, GUIDANCE_BODY,
  guidancePath, codexGuidancePath, guidanceTargets, installedGuidanceTargets,
  guidanceBlock, hasGuidance, isCurrent, applyGuidance,
  guidanceStatus, setGuidance, guidanceStatusAll, setGuidanceAll,
};
