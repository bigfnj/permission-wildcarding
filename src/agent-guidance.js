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

// A marker only fences what cannot contain it. Neither body here is this repo's text —
// the gates body is compiled from the user's own memory corpus and a derived body embeds
// managed rule strings — so a body that quotes a marker is ordinary content. It used to
// truncate `blockRange` at the inner marker: a rewrite then replaced only the truncated
// range and left the rest of the old body plus an orphaned end marker behind, and since
// the reinstalled body still carried that inner marker, every later pass appended another
// copy. `off` removed only as far as the first inner marker, so none of it was removable.
//
// Neutralised rather than refused. Refusing would cost a user whose memory documents this
// very feature all of their gates; escaping the angle brackets leaves the marker readable
// to a human, stops it being a fence, and keeps the block removable.
function escapeMarker(marker) {
  return String(marker).replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// A managed block is a marker pair plus a body. The shell-style text above is one
// instance; the compiled memory gates in `agent-gates.js` are another. Each closes over
// its own markers, so adding a block cannot change how an existing one behaves, and an
// "off" on one can never tear out the other.
function createManagedBlock({ begin, end, body }) {
  // Resolved per call, never captured: a static block hands back a const, while the gates
  // block reads whatever the compiler last wrote. That is what makes a corpus-derived
  // block's staleness detectable at all, with no version to bump.
  const fenced = (text) => (text == null ? '' : String(text))
    .split(begin).join(escapeMarker(begin))
    .split(end).join(escapeMarker(end));
  const bodyText = () => fenced(typeof body === 'function' ? body() : body);
  const block = () => `${begin}\n${bodyText()}\n${end}\n`;

  // Marker-fenced, so a rewrite replaces exactly what a previous version wrote and
  // an "off" leaves the rest of the file untouched. Matching is anchored on the
  // markers rather than the body text, which is what lets the wording change
  // between releases without stranding an old copy.
  function blockRange(text) {
    const start = text.indexOf(begin);
    if (start === -1) return null;
    const stop = text.indexOf(end, start);
    if (stop === -1) return null;
    return { start, end: stop + end.length };
  }

  function has(text) {
    return blockRange(typeof text === 'string' ? text : '') !== null;
  }

  // Whether the installed block is the current wording. An upgrade should refresh
  // a stale block silently; an unchanged one must not produce a write, or the
  // extension would rewrite CLAUDE.md on every activation.
  function isCurrent(text) {
    const range = blockRange(typeof text === 'string' ? text : '');
    if (!range) return false;
    return text.slice(range.start, range.end) === block().trimEnd();
  }

  // Compute the file content for turning the block on/off. Pure, so the decision is
  // testable without a filesystem: returns `changed: false` for a no-op.
  function apply(text, on) {
    const current = typeof text === 'string' ? text : '';
    const range = blockRange(current);

    if (!on) {
      if (!range) return { changed: false, text: current };
      // The block's own bytes are the fenced range, the newline that ends its last
      // marker line, and the ONE blank line the install below inserts ahead of it.
      // Every other newline in the two runs around it belongs to the user: the one
      // that ended their own last line above, and whatever separated what follows.
      //
      // Sweeping both runs bare and only restoring a newline at end of file fused
      // two of the user's own lines into one whenever the block sat between them,
      // and dropped the separator entirely ahead of a second managed block — the
      // shape `--guidance off` meets on any file that also carries the gates or a
      // derived block. It read as harmless only because a block written at line 1
      // makes the leading sweep a no-op.
      let above = range.start;
      while (above > 0 && current[above - 1] === '\n') above -= 1;
      let below = range.end;
      while (below < current.length && current[below] === '\n') below += 1;
      const head = current.slice(0, above);
      const tail = current.slice(below);
      // Start of file: nothing above to separate from, and the run below was all
      // the block's own. End of file: the head is a text file, so exactly one final
      // newline. Mid-file: the user's line terminator above (their run less the one
      // blank line an install inserts) plus their own separation below (that run
      // less the newline that ended the block's last line).
      const separator = head.length === 0 ? ''
        : tail.length === 0 ? '\n'
          : '\n'.repeat(Math.max(1, range.start - above - 1) + Math.max(0, below - range.end - 1));
      const next = head + separator + tail;
      return { changed: next !== current, text: next };
    }

    if (range) {
      if (isCurrent(current)) return { changed: false, text: current };
      const next = current.slice(0, range.start) + block().trimEnd() + current.slice(range.end);
      return { changed: true, text: next };
    }

    // Append rather than prepend: the user's own instructions keep their position
    // at the top of the file, where they were written to be read first.
    const separator = current.length === 0 ? '' : current.endsWith('\n\n') ? '' : current.endsWith('\n') ? '\n' : '\n\n';
    return { changed: true, text: `${current}${separator}${block()}` };
  }

  return { begin, end, block, blockRange, has, isCurrent, apply };
}

// The shell-style instance, plus delegates that keep every existing call site and test
// working unchanged: the suite that was green before the split is the proof it still is.
const SHELL_BLOCK = createManagedBlock({ begin: BEGIN, end: END, body: () => GUIDANCE_BODY });

const guidanceBlock = SHELL_BLOCK.block;
const hasGuidance = SHELL_BLOCK.has;
const isCurrent = SHELL_BLOCK.isCurrent;
const applyGuidance = SHELL_BLOCK.apply;

function readGuidanceFile(file) {
  try { return fs.readFileSync(file, 'utf8'); }
  catch (error) { return error.code === 'ENOENT' ? '' : null; }
}

// `block` is additive and defaults to the shell-style instance, so every existing caller
// keeps its behaviour while `agent-gates.js` can drive the same file plumbing.
function guidanceStatus(file = guidancePath(), block = SHELL_BLOCK) {
  const text = readGuidanceFile(file);
  if (text === null) return { path: file, readable: false, on: false, current: false };
  return { path: file, readable: true, on: block.has(text), current: block.isCurrent(text) };
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
  block = SHELL_BLOCK,
} = {}) {
  const text = readGuidanceFile(file);
  if (text === null) return { changed: false, error: `cannot read ${file}`, path: file, on: false };

  const result = block.apply(text, on);
  if (!result.changed) return { changed: false, path: file, on: block.has(text), error: null };

  try {
    if (text.length) {
      fs.mkdirSync(backupDir, { recursive: true });
      writeFileAtomicSync(path.join(backupDir, backupName), text);
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeFileAtomicSync(file, result.text);
  } catch (error) {
    return { changed: false, path: file, on: block.has(text), error: error.message };
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
  createManagedBlock, escapeMarker, SHELL_BLOCK,
};
