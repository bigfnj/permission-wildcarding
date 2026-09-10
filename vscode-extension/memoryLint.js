'use strict';

// Memory-index hygiene lint for the Claude Code file-memory system.
//
// MEMORY.md is loaded into every session, so it must stay thin: one-line hooks, with
// running status pushed into the per-fact file or the project repo. This module keeps
// that discipline honest *ambiently* — pure Node, no Python, no model, no Claude Code
// hook — so it ships in the VSIX and works under the managed policy. It watches every
// ~/.claude/projects/*/memory/MEMORY.md, shows a status-bar bloat gauge, and squiggles
// over-budget hook lines + broken index links in the editor. (Semantic recall is the
// separate CPU tool in this repo's memory/recall.py — deliberately not bundled here.)

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

// Backstop cadence for re-discovering the memory store. A file watcher can only
// report on a directory that exists when the watcher is made, so when the store
// MOVES every watcher dies at once and no surviving watcher can say so. Same
// watcher-plus-periodic-reconcile shape Auto Learn uses, for the same reason.
const RECONCILE_MS = 5 * 60 * 1000;

function cfg() {
  const c = vscode.workspace.getConfiguration('permissionWildcarding');
  return {
    enabled: c.get('memory.enabled') !== false,
    dir: (c.get('memory.dir') || '').trim(),
    lineBudget: Number(c.get('memory.lineBudget')) || 300,
    totalBudget: Number(c.get('memory.totalBudget')) || 12000,
  };
}

// Every dir that holds a MEMORY.md (explicit config dir, else auto-discovered).
function discoverDirs(conf) {
  if (conf.dir) return fs.existsSync(path.join(conf.dir, 'MEMORY.md')) ? [conf.dir] : [];
  const out = [];
  let projects;
  try { projects = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true }); } catch { return out; }
  for (const e of projects) {
    if (!e.isDirectory()) continue;
    const d = path.join(PROJECTS_DIR, e.name, 'memory');
    if (fs.existsSync(path.join(d, 'MEMORY.md'))) out.push(d);
  }
  return out;
}

function norm(s) {
  return s.trim().toLowerCase().replace(/-/g, '_');
}

// Fast lint of one dir's MEMORY.md: size + over-budget hook lines + broken file links.
// Cheap enough to run on every save (reads one file, no sibling scan).
function fastLint(dir, conf) {
  const memPath = path.join(dir, 'MEMORY.md');
  let text;
  try { text = fs.readFileSync(memPath, 'utf8'); } catch { return null; }
  const bytes = Buffer.byteLength(text, 'utf8');
  const tokens = Math.round(bytes / 4);
  const lines = text.split(/\r?\n/);

  const over = [];
  const broken = [];
  const linkRe = /\]\(([^)]+\.md)(#[^)]*)?\)/g;
  lines.forEach((ln, i) => {
    if (ln.startsWith('- ') && ln.length > conf.lineBudget) {
      over.push({ line: i, len: ln.length, text: ln });
    }
    let m;
    linkRe.lastIndex = 0;
    while ((m = linkRe.exec(ln)) !== null) {
      if (!fs.existsSync(path.join(dir, m[1]))) {
        broken.push({ line: i, col: m.index, target: m[1] });
      }
    }
  });
  return { dir, memPath, bytes, tokens, over, broken, totalOver: bytes > conf.totalBudget };
}

// The dir whose MEMORY.md is "current": the configured one, else the most recently
// touched (i.e. the memory you're actually working in). Shared by the status-bar
// gauge and the dashboard Memory card so both reflect the same file.
function pickPrimaryDir(dirs) {
  if (!dirs.length) return null;
  if (dirs.length === 1) return dirs[0];
  return dirs
    .map((d) => ({ d, t: (() => { try { return fs.statSync(path.join(d, 'MEMORY.md')).mtimeMs; } catch { return 0; } })() }))
    .sort((a, b) => b.t - a.t)[0].d;
}

// Blank out fenced + inline code spans so example [[links]] written inside backticks
// (e.g. `[[...]]`) aren't reported as unresolved wiki-links.
function stripCode(text) {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/~~~[\s\S]*?~~~/g, ' ')
    .replace(/``[^`]*``/g, ' ')
    .replace(/`[^`]*`/g, ' ');
}

// Full report: fast lint + unresolved [[wikilinks]] across the whole dir (report-only —
// forward-links to not-yet-written memories are legitimate, so they never become squiggles).
function fullReport(dir, conf) {
  const fast = fastLint(dir, conf);
  if (!fast) return null;
  let files;
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.md')); } catch { files = []; }

  const valid = new Set();
  let all = '';
  // How many memories the gates compiler could actually take. Counted HERE
  // because this loop already reads every body, so it costs nothing extra, and
  // because the alternative was a UI that offers "Compile gates" on a corpus
  // with nothing to compile — a modal, a compile and a warning toast to learn
  // what a disabled button could have said.
  //
  // The rule mirrors recall.py's _compile_gates_text: selection is on `scope`
  // (NOT type) plus the presence of a gate block. Kept deliberately literal so
  // the two are easy to compare; recall.py stays the authority that actually
  // compiles, and this is only ever used to decide whether to offer the action.
  let gateSources = 0;
  for (const f of files) {
    let raw;
    try { raw = fs.readFileSync(path.join(dir, f), 'utf8'); } catch { continue; }
    all += '\n' + raw;
    valid.add(norm(f.slice(0, -3)));
    const nm = raw.slice(0, 400).match(/^\s*name:\s*(.+)$/m);
    if (nm) valid.add(norm(nm[1].trim().replace(/^["']|["']$/g, '')));
    if (/^\s*scope:\s*global\s*$/m.test(raw) && raw.includes('<!-- gate -->')) gateSources += 1;
  }
  const unresolved = [...new Set(
    [...stripCode(all).matchAll(/\[\[([^\]]+)\]\]/g)].map((m) => m[1]).filter((l) => !valid.has(norm(l)))
  )].sort();
  return { ...fast, fileCount: files.length, unresolved, gateSources };
}

class MemoryLint {
  constructor() {
    this.status = null;
    this.diags = null;
    this.channel = null;
    this.watchers = new Map();
    this.debounce = null;
    this.timer = null;
    // Set once the subscriptions are disposed, so a callback that was already
    // in flight cannot act on a torn-down instance. See refresh().
    this.disposed = false;
  }

  activate(context) {
    // Registered BEFORE the enabled check, and unconditionally. package.json
    // declares `permission-wildcarding.lintMemory` with no `when` clause and
    // `contributes.menus.commandPalette` is null, so the palette entry exists
    // whatever this setting says. Registering it only on the enabled path left
    // the command's one discoverable entry point raising "command not found".
    // showReport() answers for the disabled case itself.
    context.subscriptions.push(
      vscode.commands.registerCommand('permission-wildcarding.lintMemory', () => this.showReport())
    );

    if (!cfg().enabled) return;

    this.diags = vscode.languages.createDiagnosticCollection('claude-memory');
    this.channel = vscode.window.createOutputChannel('Claude Memory Lint');
    this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 90);
    this.status.command = 'permission-wildcarding.lintMemory';
    context.subscriptions.push(this.diags, this.channel, this.status);

    context.subscriptions.push(
      vscode.commands.registerCommand('permission-wildcarding.lintMemory', () => this.showReport())
    );

    // External writes (an agent editing MEMORY.md outside the editor) + in-editor saves/opens.
    // The per-dir watchers are (re)built from discovery inside refresh(), not once here:
    // Claude Code derives the project slug from the working directory, so renaming a
    // working root moves the whole store to a new slug. Watchers bound to the old dir then
    // fire never again, and a gauge that only repaints on those events would sit frozen on
    // stale numbers indefinitely — reporting a budget for a file that no longer exists.
    context.subscriptions.push(
      vscode.workspace.onDidSaveTextDocument((d) => { if (this.isMemory(d)) this.refresh(); }),
      vscode.workspace.onDidOpenTextDocument((d) => { if (this.isMemory(d)) this.refresh(); }),
      vscode.window.onDidChangeActiveTextEditor((e) => { if (e && this.isMemory(e.document)) this.refresh(); }),
      { dispose: () => this.disposeWatchers() }
    );

    // The backstop: a move leaves no live watcher to report it, so re-discover on a timer.
    this.disposed = false;
    this.timer = setInterval(() => this.refresh(), RECONCILE_MS);
    if (typeof this.timer?.unref === 'function') this.timer.unref();
    // The debounce timer belongs here too. It used to be armed by schedule()
    // and cleared by nothing: a MEMORY.md write within 300 ms of a reload left
    // it live, and it then fired refresh() AFTER every subscription above was
    // disposed — clearing a disposed DiagnosticCollection, hiding a disposed
    // StatusBarItem, and calling syncWatchers(), which creates a fresh watcher
    // per discovered dir into a map nothing will ever drain again. That is the
    // same shape as the leak this file is held up elsewhere as the model for.
    context.subscriptions.push({
      dispose: () => {
        this.disposed = true;
        clearInterval(this.timer);
        this.timer = null;
        clearTimeout(this.debounce);
        this.debounce = null;
      },
    });

    this.refresh();
  }

  // Keep one watcher per discovered dir: add watchers for dirs that appeared, drop the
  // ones whose dir went away. Called from refresh(), so the watcher set never outlives
  // the discovery it came from.
  syncWatchers(dirs) {
    const wanted = new Set(dirs);
    for (const [dir, watcher] of this.watchers) {
      if (wanted.has(dir)) continue;
      try { watcher.dispose(); } catch { /* already gone with the extension host */ }
      this.watchers.delete(dir);
    }
    for (const dir of wanted) {
      if (this.watchers.has(dir)) continue;
      const w = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(vscode.Uri.file(dir), 'MEMORY.md')
      );
      w.onDidChange(() => this.schedule());
      w.onDidCreate(() => this.schedule());
      w.onDidDelete(() => this.schedule());
      this.watchers.set(dir, w);
    }
  }

  disposeWatchers() {
    for (const [, watcher] of this.watchers) {
      try { watcher.dispose(); } catch { /* nothing left to release */ }
    }
    this.watchers.clear();
  }

  isMemory(doc) {
    return doc && path.basename(doc.fileName) === 'MEMORY.md'
      && doc.fileName.replace(/\\/g, '/').includes('/.claude/projects/');
  }

  schedule() {
    clearTimeout(this.debounce);
    this.debounce = setTimeout(() => this.refresh(), 300);
  }

  // The dir the status-bar gauge reflects (see pickPrimaryDir).
  primaryDir(dirs) {
    return pickPrimaryDir(dirs);
  }

  refresh() {
    // Belt to the cleared-timer brace. Clearing the timers stops a NEW callback
    // from being scheduled; it cannot recall one that already fired and is
    // sitting in the microtask queue. Everything below touches objects VS Code
    // has disposed, and `this.diags.clear()` is not even optional-chained.
    if (this.disposed) return;
    const conf = cfg();
    if (!conf.enabled) { this.status?.hide(); this.diags?.clear(); this.disposeWatchers(); return; }
    const dirs = discoverDirs(conf);
    this.syncWatchers(dirs);

    // Diagnostics for every discovered MEMORY.md (squiggles show when the file is open).
    this.diags.clear();
    for (const dir of dirs) {
      const r = fastLint(dir, conf);
      if (r) this.diags.set(vscode.Uri.file(r.memPath), this.toDiagnostics(r, conf));
    }

    const primary = this.primaryDir(dirs);
    const r = primary && fastLint(primary, conf);
    if (!r) { this.status.hide(); return; }
    const issues = r.over.length + r.broken.length;
    const tok = r.tokens >= 1000 ? (r.tokens / 1000).toFixed(1) + 'k' : String(r.tokens);
    this.status.text = `$(book) mem: ${tok} tok` + (issues ? ` · ${issues} to fix` : '');
    this.status.tooltip =
      `MEMORY.md: ${r.bytes} bytes (~${r.tokens} tokens/session, budget ${conf.totalBudget / 4 | 0})\n` +
      `${r.over.length} over-budget hook line(s), ${r.broken.length} broken index link(s)\n` +
      `${path.dirname(r.memPath).replace(os.homedir(), '~')}\nClick for the full report.`;
    this.status.backgroundColor = (issues || r.totalOver)
      ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
    this.status.show();
  }

  toDiagnostics(r, conf) {
    const out = [];
    for (const o of r.over) {
      const d = new vscode.Diagnostic(
        new vscode.Range(o.line, 0, o.line, o.len),
        `Index line is ${o.len} chars (budget ${conf.lineBudget}). Move the running detail into ` +
        `the memory file or the project repo and leave a one-line hook.`,
        vscode.DiagnosticSeverity.Warning
      );
      d.source = 'claude-memory';
      out.push(d);
    }
    for (const b of r.broken) {
      const d = new vscode.Diagnostic(
        new vscode.Range(b.line, b.col, b.line, b.col + b.target.length + 4),
        `Index links to a missing file: ${b.target}`,
        vscode.DiagnosticSeverity.Warning
      );
      d.source = 'claude-memory';
      out.push(d);
    }
    return out;
  }

  showReport() {
    const conf = cfg();
    // Reachable with the feature off, because the command is now always
    // registered. Say so plainly instead of dereferencing this.channel, which
    // activate() never created on that path.
    if (!conf.enabled) {
      vscode.window.showInformationMessage(
        'permission-wildcarding: memory lint is off — set permissionWildcarding.memory.enabled to true.'
      );
      return;
    }
    const dirs = discoverDirs(conf);
    const dir = this.primaryDir(dirs);
    if (!dir) {
      vscode.window.showInformationMessage('permission-wildcarding: no MEMORY.md found under ~/.claude/projects/*/memory.');
      return;
    }
    const r = fullReport(dir, conf);
    const ch = this.channel;
    ch.clear();
    ch.appendLine(`Memory lint — ${r.memPath.replace(os.homedir(), '~')}`);
    ch.appendLine(`  ${r.bytes} bytes (~${r.tokens} tokens loaded every session), target < ${conf.totalBudget}`);
    if (r.totalOver) ch.appendLine(`  ! index is ${r.bytes - conf.totalBudget} bytes over budget`);
    ch.appendLine(`  ${r.fileCount} memory files in the dir`);
    ch.appendLine('');
    if (r.over.length) {
      ch.appendLine(`${r.over.length} index line(s) over ${conf.lineBudget} chars — leave a hook, move detail out:`);
      for (const o of [...r.over].sort((a, b) => b.len - a.len)) {
        ch.appendLine(`  ${String(o.len).padStart(4)} ch  L${o.line + 1}  ${o.text.slice(2, 72)}...`);
      }
      ch.appendLine('');
    }
    if (r.broken.length) {
      ch.appendLine('index links to MISSING files:');
      for (const b of r.broken) ch.appendLine(`  L${b.line + 1}  ${b.target}`);
      ch.appendLine('');
    }
    if (r.unresolved.length) {
      ch.appendLine('unresolved [[links]] (typo, or a forward-link to a memory not written yet):');
      for (const l of r.unresolved) ch.appendLine(`  [[${l}]]`);
      ch.appendLine('');
    }
    if (!r.over.length && !r.broken.length) ch.appendLine('clean: every index line within budget, all index links resolve.');
    ch.show(true);
    this.refresh();
  }
}

// Convenience for the dashboard Memory card: the full report for the current memory
// dir, plus the resolved config. Returns { conf, dir, report } (dir/report null if
// there is no MEMORY.md to look at). Pure Node — no python, no model.
function memoryReport() {
  const conf = cfg();
  const dir = pickPrimaryDir(discoverDirs(conf));
  return { conf, dir, report: dir ? fullReport(dir, conf) : null };
}

module.exports = { MemoryLint, fastLint, fullReport, discoverDirs, pickPrimaryDir, memoryReport };
