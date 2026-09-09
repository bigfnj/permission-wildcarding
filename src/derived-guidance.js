'use strict';

// A managed rule the allow list cannot beat is the one prompt no generalizer can
// ever remove: precedence puts managed `ask` above every user allow, so the rule
// this project exists to write is inert against it. What is left is behaviour,
// and behaviour is what an instruction file changes. This module turns a
// measured cost into the sentence that reduces it.
//
// Four deliberate limits, each of which was a real temptation:
//
//   - Nothing here writes anything. Deriving is separate from installing so the
//     caller can show a mitigation and let a human refuse it.
//   - Nothing derives at install time. The evidence that makes a mitigation
//     worth a permanent context cost does not exist until a corpus has been
//     scanned, so a static paragraph shipped at install is the thing this
//     replaces, not the thing it extends.
//   - A rule shape with no known mitigation produces NOTHING, never filler.
//     Advice that does not change what the agent does is pure context cost, and
//     it teaches the reader to skim the block that carries the real rules.
//   - A threshold and a cap. An allow entry is paid for once; a line in an
//     instruction file is paid for on every session forever. The bar is
//     therefore much higher than the one the shell learner uses for a grant.

const fs = require('fs');
const os = require('os');
const path = require('path');

const { toolOf } = require('./managed-policy');
const { createManagedBlock, installedGuidanceTargets } = require('./agent-guidance');
const { writeFileAtomicSync } = require('./permissions');

const DEFAULT_THRESHOLD = 50;
const DEFAULT_LIMIT = 3;

// Fetch tools, which the docs recommend gating rather than allow-listing. Kept
// separate from the generic command case because the advice is different: a
// fetch has an alternative tool, an arbitrary command does not.
const NETWORK_ROOTS = new Set([
  'curl', 'wget', 'nc', 'ncat', 'netcat', 'socat', 'scp', 'rsync', 'ftp', 'sftp',
]);
const WRITE_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);
const COMMAND_TOOLS = new Set(['Bash', 'PowerShell']);
const RULE_SHAPE = /^([A-Za-z_][A-Za-z0-9_]*)\(([\s\S]*)\)$/;

function specifierOf(rule) {
  const parsed = RULE_SHAPE.exec(String(rule == null ? '' : rule).trim());
  return parsed ? parsed[2] : null;
}

// The command a rule fixes. Both spellings of the trailing wildcard reduce to
// the same root, so `Bash(curl:*)` and `Bash(curl *)` are one rule here.
function commandRoot(rule) {
  const specifier = specifierOf(rule);
  if (specifier === null) return null;
  const text = specifier.endsWith(':*') ? specifier.slice(0, -2)
    : specifier.endsWith(' *') ? specifier.slice(0, -2) : specifier;
  const root = text.trim().split(/\s+/)[0] || '';
  return root ? root.toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/, '') : null;
}

function plural(count, word) {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

// Every body opens by saying the prompt cannot be configured away, because that
// is the fact that makes behavioural advice worth following rather than an
// annoyance to work around. A reader who thinks a setting would fix this will
// go looking for the setting.
function preamble(entry) {
  const decision = entry.decision === 'deny' ? 'deny' : 'ask';
  const extra = Array.isArray(entry.rules) && entry.rules.length > 1
    ? `, plus ${plural(entry.rules.length - 1, 'more rule')} of the same shape` : '';
  return `\`${entry.rule}\` is a managed \`${decision}\`${extra}, which outranks every ` +
    `user allow entry, so no wildcard can stop it. Measured ${plural(entry.prompts, 'prompt')}.`;
}

const MITIGATIONS = [
  {
    id: 'batch-file-edits',
    match: (entry) => WRITE_TOOLS.has(entry.tool),
    title: 'Editing a path a managed rule gates',
    body: (entry) => `${preamble(entry)} Read the file, decide every change, then ` +
      `apply ONE consolidated ${entry.tool} per file per pass instead of a sequence of ` +
      `small ones. Do not reach for a different file tool to dodge the rule: the ask ` +
      `is deliberate, and a whole-file overwrite risks more than the prompt costs.`,
  },
  {
    id: 'read-gated-path-once',
    match: (entry) => entry.tool === 'Read',
    title: 'Reading a path a managed rule gates',
    body: (entry) => `${preamble(entry)} The contents do not change between reads, so ` +
      `read it once and keep what you need rather than re-reading it later in the same ` +
      `session. If you only need one value, asking for that value costs no prompt at all.`,
  },
  {
    id: 'batch-network-fetches',
    match: (entry) => COMMAND_TOOLS.has(entry.tool) && NETWORK_ROOTS.has(commandRoot(entry.rule)),
    title: 'Fetching over the network',
    body: (entry) => `${preamble(entry)} One tool call is one prompt, so batch every ` +
      `fetch into a SINGLE call rather than one call per URL. A public GET of text you ` +
      `are going to read can go through WebFetch instead and skip the prompt entirely; ` +
      `a download, a status probe, a POST or an auth header still needs the command.`,
  },
  {
    id: 'script-multi-step-work',
    match: (entry) => COMMAND_TOOLS.has(entry.tool),
    title: 'Running a command a managed rule gates',
    body: (entry) => `${preamble(entry)} Each invocation is its own prompt, so put the ` +
      `multi-step work in a script and run the script once. Approving one script beats ` +
      `approving each of the steps inside it, and the script is reusable.`,
  },
];

// `costliestRules` from the managed report, ranked. Anything without a tool or a
// known shape is skipped rather than guessed at.
//
// Grouped by mitigation id, not emitted per rule. There are four ids and a
// managed policy can easily carry two rules of one shape, so a per-rule list
// produced duplicate ids, and every structure downstream assumes an id is
// unique: the accepted/declined sets, the marker pair, and the `wanted` map in
// `reconcileDerived`. The observable damage was that the LAST rule won, so the
// installed block named the cheaper rule and the expensive one got no advice
// while still consuming one of the three cap slots. Grouping fixes both: the
// costliest rule of a shape is the one named, the others are counted into the
// same total, and the cap now limits distinct advice rather than rule count.
function deriveMitigations(costliestRules, options = {}) {
  const threshold = Number.isFinite(options.threshold)
    ? Math.max(1, Math.floor(options.threshold)) : DEFAULT_THRESHOLD;
  const limit = Number.isFinite(options.limit)
    ? Math.max(0, Math.floor(options.limit)) : DEFAULT_LIMIT;
  const rules = Array.isArray(costliestRules) ? costliestRules : [];
  const groups = new Map();
  const seenRules = new Set();
  for (const item of rules) {
    const rule = typeof item?.rule === 'string' ? item.rule : '';
    const prompts = Number(item?.prompts) || 0;
    if (!rule || prompts < threshold || seenRules.has(rule)) continue;
    const tool = toolOf(rule);
    if (!tool) continue;
    const entry = {
      rule, prompts, tool,
      decision: item.decision === 'deny' ? 'deny' : 'ask',
      tools: Array.isArray(item.tools) ? item.tools.filter(Boolean) : [],
    };
    const mitigation = MITIGATIONS.find((candidate) => candidate.match(entry));
    if (!mitigation) continue;
    seenRules.add(rule);
    const group = groups.get(mitigation.id);
    if (group) {
      group.rules.push(rule);
      group.prompts += prompts;
      for (const name of entry.tools) if (!group.tools.includes(name)) group.tools.push(name);
      continue;
    }
    groups.set(mitigation.id, {
      mitigation, rule, rules: [rule], prompts, tool,
      decision: entry.decision, tools: entry.tools.slice(),
    });
  }
  const derived = [];
  for (const group of groups.values()) {
    if (derived.length >= limit) break;
    derived.push({
      id: group.mitigation.id, rule: group.rule, rules: group.rules.slice(),
      decision: group.decision, prompts: group.prompts, tool: group.tool,
      tools: group.tools.slice(), title: group.mitigation.title,
      body: group.mitigation.body(group),
    });
  }
  return derived;
}

// One marker pair per mitigation, so `--guidance off` and an undo can remove
// exactly the one the reader rejected. A single shared block would make every
// line in it indistinguishable from every other, which is the state the
// hand-written gates in this user's CLAUDE.md are already in.
function markersFor(id) {
  const slug = String(id).replace(/[^a-z0-9-]/gi, '').toLowerCase();
  return {
    begin: `<!-- BEGIN permission-wildcarding: ${slug} (derived) -->`,
    end: `<!-- END permission-wildcarding: ${slug} (derived) -->`,
  };
}

// The rendered block. The evidence count is in the text on purpose: a reader
// deciding whether to keep a permanent instruction needs the number that
// justified it, and a stale number is the signal to drop the line.
function renderMitigation(mitigation) {
  return `- **${mitigation.title}.** ${mitigation.body}`;
}

// One block per mitigation, built on the same marker plumbing the shell-style
// text and the compiled gates already use, so an "off" on one can never tear out
// another. Removal only reads the markers, which is why a block can be removed
// from a title and body this module no longer has.
function mitigationBlock(mitigation) {
  const { begin, end } = markersFor(mitigation.id);
  return createManagedBlock({ begin, end, body: () => renderMitigation(mitigation) });
}

// Every derived block currently in the file, by id, including ones this version
// would no longer derive. Without this a mitigation could only ever be added.
function installedDerivedIds(text) {
  const pattern = /<!-- BEGIN permission-wildcarding: ([a-z0-9-]+) \(derived\) -->/g;
  const found = [];
  let match = pattern.exec(typeof text === 'string' ? text : '');
  while (match) {
    if (!found.includes(match[1])) found.push(match[1]);
    match = pattern.exec(text);
  }
  return found;
}

// Pure: the file content that should exist given what was derived and what the
// human accepted. Text in, text out, so the decision is testable without a disk.
//
// Nothing is installed that was not explicitly accepted. That is the whole
// difference between this and a static block shipped at install: the tool
// proposes, a human disposes, and a declined id simply never appears in
// `accepted` so it is never written.
function reconcileDerived(text, mitigations, options = {}) {
  const accepted = new Set((Array.isArray(options.accepted) ? options.accepted : []).map(String));
  const wanted = new Map();
  for (const item of (Array.isArray(mitigations) ? mitigations : [])) {
    if (item && accepted.has(String(item.id))) wanted.set(String(item.id), item);
  }
  const original = typeof text === 'string' ? text : '';
  let next = original;
  const added = [];
  const updated = [];
  const removed = [];

  // Remove first, including any block whose rule has since dropped below the
  // threshold or whose id this version no longer knows. A block still asserting
  // "Measured 253 prompts" after the policy changed is worse than no block: the
  // number IS the justification, so a stale number is a false claim.
  for (const id of installedDerivedIds(next)) {
    if (wanted.has(id)) continue;
    const result = mitigationBlock({ id, title: '', body: '' }).apply(next, false);
    if (result.changed) {
      next = result.text;
      removed.push(id);
    }
  }
  for (const item of wanted.values()) {
    const block = mitigationBlock(item);
    const had = block.has(next);
    const result = block.apply(next, true);
    if (result.changed) {
      next = result.text;
      (had ? updated : added).push(String(item.id));
    }
  }
  return { text: next, changed: next !== original, added, updated, removed };
}

function readFileOrEmpty(file) {
  try { return fs.readFileSync(file, 'utf8'); }
  catch (error) { return error.code === 'ENOENT' ? '' : null; }
}

// Claude only, unlike the static shell-style block. That block is about writing
// one command per tool call, which is true for any agent. These mitigations are
// not: the evidence comes from Claude transcripts and a Claude managed policy,
// the precedence argument in every body is Claude's, and the advice names Claude
// tools. Writing "a managed `ask` outranks every user allow entry" into
// ~/.codex/AGENTS.md describes a model Codex does not have.
function derivedTargets(home) {
  return installedGuidanceTargets(home).filter((target) => target.agent === 'claude');
}

// Which derived blocks the instruction file currently carries. Read-only, and an
// unreadable file says so rather than reporting an empty list, because "no
// blocks" and "cannot tell" lead to opposite next actions.
function derivedStatus({ home = os.homedir() } = {}) {
  return derivedTargets(home).map((target) => {
    const text = readFileOrEmpty(target.path);
    return {
      agent: target.agent, path: target.path, readable: text !== null,
      installed: text === null ? [] : installedDerivedIds(text),
    };
  });
}

// One write per file rather than one per mitigation: the reconcile is computed
// whole, so a failure cannot leave half a decision applied. Backed up on first
// modification for the same reason `setGuidance` does it, under its own name so
// it cannot overwrite that function's pre-change copy in a shared directory.
function setDerivedGuidance(mitigations, accepted, {
  home = os.homedir(),
  backupDir = path.join(os.homedir(), '.claude', 'backups'),
} = {}) {
  return derivedTargets(home).map((target) => {
    const base = { agent: target.agent, path: target.path };
    const text = readFileOrEmpty(target.path);
    if (text === null) {
      return { ...base, changed: false, error: `cannot read ${target.path}`,
        added: [], updated: [], removed: [], installed: [] };
    }
    const result = reconcileDerived(text, mitigations, { accepted });
    if (!result.changed) {
      return { ...base, changed: false, error: null,
        added: [], updated: [], removed: [], installed: installedDerivedIds(text) };
    }
    try {
      if (text.length) {
        fs.mkdirSync(backupDir, { recursive: true });
        writeFileAtomicSync(path.join(backupDir, `${path.basename(target.path)}.pre-derived`), text);
      }
      fs.mkdirSync(path.dirname(target.path), { recursive: true });
      writeFileAtomicSync(target.path, result.text);
    } catch (error) {
      return { ...base, changed: false, error: error.message,
        added: [], updated: [], removed: [], installed: installedDerivedIds(text) };
    }
    return { ...base, changed: true, error: null,
      added: result.added, updated: result.updated, removed: result.removed,
      installed: installedDerivedIds(result.text) };
  });
}

module.exports = {
  deriveMitigations, markersFor, renderMitigation,
  mitigationBlock, installedDerivedIds, reconcileDerived,
  derivedStatus, setDerivedGuidance,
  DEFAULT_THRESHOLD, DEFAULT_LIMIT,
};
