'use strict';

// Shell commands are only part of what prompts. MCP tools, web fetches and file
// edits are recorded in the same transcripts and are learned here into the same
// candidate shape, so one review list covers the whole friction surface.
//
// Nothing in this file is ever automatically applied. A shell root can be
// classified from a known table; an MCP tool is opaque by construction, a fetch
// is network access, and a file edit mutates the disk. All three are review
// only, and the export is never wider than what was observed.

const MCP_TOOL = /^mcp__([A-Za-z0-9_.-]{1,64})__([A-Za-z0-9_.-]{1,64})$/;
const HOSTNAME = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

// A file family is one entry per tool with no path in it. Directory scopes would
// have to be inferred from observed paths, which both guesses at a rule wider
// than the evidence and would persist absolute paths the state deliberately
// never keeps.
const FILE_TOOLS = new Map([
  ['Edit', 'write'], ['MultiEdit', 'write'], ['Write', 'write'],
  ['NotebookEdit', 'write'], ['Read', 'unknown'],
]);

function target(name, input) {
  if (!input || typeof input !== 'object') return undefined;
  if (name === 'WebFetch') return typeof input.url === 'string' ? input.url : undefined;
  if (name === 'WebSearch') return typeof input.query === 'string' ? 'search' : 'search';
  if (FILE_TOOLS.has(name)) {
    const file = input.file_path ?? input.path ?? input.notebook_path;
    return typeof file === 'string' && file ? 'file' : undefined;
  }
  return MCP_TOOL.test(String(name)) ? 'call' : undefined;
}

function isLearnableTool(name) {
  const value = String(name || '');
  return value === 'WebFetch' || value === 'WebSearch' ||
    FILE_TOOLS.has(value) || MCP_TOOL.test(value);
}

// The raw path or URL behind a non-shell call, for matching against a managed
// rule while the scan is in memory. This is NOT the same thing as inferring a
// path rule, which `FILE_TOOLS` above still refuses to do: nothing here widens a
// grant or reaches the exported policy. It exists so a report can answer "which
// managed rule is costing me prompts", which needs the path only long enough to
// test it. `target` stays opaque, so the candidate key, the observation identity
// and the state file are all unchanged, and the matched RULE is what gets kept.
// A rule is org policy rather than user data; the path never leaves the scan.
// File tools only. A fetch already renders `WebFetch(domain:host)` as its
// permission, so it is assessed through the normal candidate route and needs no
// second path here; building a probe from a raw URL would only invent a shape
// no managed rule is written in.
function toolPath(name, input) {
  if (!input || typeof input !== 'object') return undefined;
  if (!FILE_TOOLS.has(String(name || ''))) return undefined;
  const file = input.file_path ?? input.path ?? input.notebook_path;
  return typeof file === 'string' && file ? file : undefined;
}

function fetchHost(value) {
  try {
    const url = new URL(String(value));
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    const host = url.hostname.toLowerCase();
    return HOSTNAME.test(host) ? host : null;
  } catch { return null; }
}

// One observation of a non-shell tool becomes one candidate-shaped record.
function toolInvocation(name, value, metadata = {}) {
  const tool = String(name || '');
  const base = {
    ...(metadata && typeof metadata === 'object' ? metadata : {}),
    kind: 'tool', tool, shell: null, argv: [], command: '',
    autoSafe: false, complex: false, attribution: 'both',
  };
  const mcp = MCP_TOOL.exec(tool);
  if (mcp) {
    const [, server, action] = mcp;
    return {
      ...base,
      key: `mcp:${server.toLowerCase()}__${action.toLowerCase()}`,
      root: server, prefix: [server, action],
      // Granting a whole server is broader than the evidence, so only the exact
      // tool that was observed is ever proposed.
      claudePermission: `mcp__${server}__${action}`,
      risk: 'unknown', reasons: ['mcp-tool', 'opaque-capability'],
    };
  }
  if (tool === 'WebFetch') {
    const host = fetchHost(value);
    if (!host) return null;
    return {
      ...base,
      key: `webfetch:${host}`, root: host, prefix: [host],
      claudePermission: `WebFetch(domain:${host})`,
      risk: 'network', reasons: ['network-command', 'web-domain'],
    };
  }
  if (tool === 'WebSearch') {
    return {
      ...base,
      key: 'websearch:', root: 'WebSearch', prefix: ['WebSearch'],
      claudePermission: 'WebSearch',
      risk: 'network', reasons: ['network-command'],
    };
  }
  if (FILE_TOOLS.has(tool)) {
    return {
      ...base,
      key: `${tool.toLowerCase()}:`, root: tool, prefix: [tool],
      // Deliberately unexportable: see the note on FILE_TOOLS above.
      claudePermission: null,
      risk: FILE_TOOLS.get(tool),
      reasons: ['file-tool', 'path-scope-not-inferred'],
    };
  }
  return null;
}

module.exports = { isLearnableTool, toolInvocation, toolTarget: target, toolPath, MCP_TOOL };
