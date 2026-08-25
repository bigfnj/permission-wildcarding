'use strict';

// Compiled memory gates — make the standing orders resident.
//
// `agent-guidance.js` installs a block whose text is a const in this repo. This one
// installs a block whose text is derived from the user's own memory corpus:
// `recall.py --gates-compile` lifts the `<!-- gate -->` section out of every memory marked
// `type: feedback` + `scope: global` and concatenates them into gates.generated.md.
//
// Why bother, when the memory index already exists: the index is a list of *hooks*, and
// the enforceable half of a rule lives in the file body, which only loads if a recall
// happens to surface it. That works for reference material and fails for standing orders,
// because you cannot recall a rule you are already breaking — nothing triggers the lookup.
// So policy has to be resident and facts do not, and the index currently mixes them.
//
// Why an instruction file rather than a hook: a SessionStart hook is the obvious way to
// force text into every session, and it is unavailable under a managed policy that sets
// allowManagedHooksOnly. Instruction-file text is the one always-loaded surface that
// survives, which is why this ships as a managed block.
//
// Separate markers from the shell-style block on purpose. The two have different
// lifecycles — one is release-versioned, one tracks a corpus that changes underneath it —
// and independent switches, so `--guidance off` must never take the gates with it.

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  createManagedBlock, installedGuidanceTargets, guidanceStatus, setGuidance,
} = require('./agent-guidance');

const GATES_BEGIN = '<!-- BEGIN permission-wildcarding: memory gates (managed) -->';
const GATES_END = '<!-- END permission-wildcarding: memory gates -->';

// Where recall.py --gates-compile writes. Alongside the file it feeds rather than in a
// checkout: it is derived from a private memory dir and has no business being committed.
function compiledPath(home = os.homedir()) {
  return path.join(home, '.claude', 'gates.generated.md');
}

// Read late, on every call, so a recompile is picked up without reloading the extension.
// Empty string for "not compiled yet", null for a real read error, matching the
// convention readGuidanceFile already uses.
function readCompiled(home = os.homedir()) {
  try { return fs.readFileSync(compiledPath(home), 'utf8').trim(); }
  catch (error) { return error.code === 'ENOENT' ? '' : null; }
}

// The body is the compiled file, so staleness needs no version bump: edit a memory,
// recompile, and isCurrent() goes false on its own because the bytes differ.
//
// Bound to a home rather than closing over os.homedir(): every caller here already takes
// a home, and a block that read the default one would check a caller's compile and then
// install somebody else's bytes.
function makeGatesBlock(home = os.homedir()) {
  return createManagedBlock({
    begin: GATES_BEGIN,
    end: GATES_END,
    body: () => readCompiled(home) || '',
  });
}

// Deliberately NOT a module-level `makeGatesBlock()` singleton. Every entry point here takes
// a home, and a block built at require time would freeze whatever os.homedir() said then --
// which is how a test with a mocked home ends up writing to the real ~/.claude.

function gatesStatus(file, home = os.homedir()) {
  return { ...guidanceStatus(file, makeGatesBlock(home)), compiled: !!readCompiled(home) };
}

function gatesStatusAll(home = os.homedir()) {
  return installedGuidanceTargets(home).map((target) => ({
    agent: target.agent,
    ...gatesStatus(target.path, home),
  }));
}

function setGatesAll(on, { home = os.homedir(), backupDir } = {}) {
  // Refuse to install an empty block. Without this, a missing compile would fence off
  // nothing, report success, and leave a card reading "gates ON" forever — the exact
  // silent-failure shape this whole feature exists to avoid.
  if (on && !readCompiled(home)) {
    return [{
      agent: 'all', changed: false, path: compiledPath(home), on: false, compiled: false,
      error: 'no compiled gates: run `recall.py --gates-compile` first',
    }];
  }
  return installedGuidanceTargets(home).map((target) => ({
    agent: target.agent,
    ...setGuidance(on, {
      file: target.path,
      ...(backupDir ? { backupDir } : {}),
      // `.pre-gates`, not `.pre-guidance`: the two blocks share a backup directory and
      // must not overwrite each other's pre-change copy.
      backupName: `${path.basename(target.path)}.pre-gates`,
      block: makeGatesBlock(home),
    }),
  }));
}

module.exports = {
  GATES_BEGIN, GATES_END, makeGatesBlock,
  compiledPath, readCompiled, gatesStatus, gatesStatusAll, setGatesAll,
};
