'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
const { isLearnableTool, toolTarget, toolPath } = require('./tool-learn');
const CODEX_ITEM_TYPES = new Set([
  'function_call', 'function_call_output', 'custom_tool_call', 'custom_tool_call_output',
]);
const DEFAULT_OVERLAP_BYTES = 256 * 1024;
const FINGERPRINT_BYTES = 4096;

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== '');
}

function stringValue(value) {
  if (typeof value === 'string' && value) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

function stableHash(...parts) {
  const hash = crypto.createHash('sha256');
  for (const part of parts) {
    hash.update(String(part === undefined ? '' : part));
    hash.update('\0');
  }
  return hash.digest('hex').slice(0, 24);
}

function defineParserOffsets(observation, callOffset, callEnd) {
  Object.defineProperties(observation, {
    _callOffset: { value: callOffset, enumerable: false },
    _callEnd: { value: callEnd, enumerable: false },
    _resultOffset: { value: undefined, writable: true, enumerable: false },
    _resultEnd: { value: undefined, writable: true, enumerable: false },
  });
}

// A file or fetch path is tested against managed policy here and then dropped;
// what survives is the RULE it matched, which is org policy rather than user
// data. Putting the path on the observation instead would have downgraded the
// invariant from "no path ever leaves the parser", which one assertion can
// check, to "no path is ever persisted", which every future consumer has to
// keep true. The matcher is injected so this module stays policy-ignorant, and
// a throwing or absent matcher simply yields no rule.
function matchManaged(options, tool, filePath) {
  const matcher = options && typeof options.probeMatcher === 'function'
    ? options.probeMatcher : null;
  if (!matcher || !filePath) return undefined;
  try {
    const rule = matcher(String(tool), String(filePath));
    return typeof rule === 'string' && rule ? rule : undefined;
  } catch { return undefined; }
}

function createObservation(fields) {
  const { source, tool, command } = fields;
  // A non-shell tool carries an opaque target rather than a command string.
  const kind = SHELL_TOOLS.has(tool) ? 'shell' : 'tool';
  if (kind === 'tool' && !isLearnableTool(tool)) return null;
  if (typeof command !== 'string' || !command.trim()) return null;
  const locationKey = fields.file || '<text>';
  const realCallId = stringValue(fields.callId);
  const effectiveCallId = realCallId || `${source}-synthetic-${stableHash(
    locationKey, fields.session, fields.callOffset, fields.commandIndex || 0, command,
  )}`;
  const identityParts = realCallId
    ? [source, fields.session, realCallId, fields.commandIndex || 0]
    : [source, locationKey, fields.session, effectiveCallId, fields.commandIndex || 0, command];
  const observation = {
    id: `${source}:${stableHash(...identityParts)}`,
    source,
    tool,
    command,
    status: 'unknown',
    callId: effectiveCallId,
  };
  if (kind === 'tool') observation.kind = kind;
  // The managed RULE a non-shell call matched, never the path that matched it.
  // Deliberately absent from `identityParts` above so existing observation
  // hashes do not move: adding this must not re-observe a counted corpus.
  if (fields.managedRule !== undefined) observation.managedRule = fields.managedRule;
  if (fields.timestamp !== undefined) observation.timestamp = fields.timestamp;
  if (fields.cwd !== undefined) observation.cwd = fields.cwd;
  if (fields.session !== undefined) observation.session = fields.session;
  defineParserOffsets(observation, fields.callOffset, fields.callEnd);
  return observation;
}

function mergeStatus(current, incoming) {
  if (incoming === 'failed') return 'failed';
  if (incoming === 'success' && current !== 'failed') return 'success';
  return current || 'unknown';
}

function applyResult(observation, result) {
  if (!observation || !result) return;
  observation.status = mergeStatus(observation.status, result.status);
  if (result.offset !== undefined) observation._resultOffset = result.offset;
  if (result.end !== undefined) observation._resultEnd = result.end;
}

// Offsets are byte-based so an append scanner can compare them with fs.stat.
function parseJsonlRecords(text, options, onRecord) {
  const sourceText = Buffer.isBuffer(text) ? text.toString('utf8') : String(text == null ? '' : text);
  const baseOffset = Number.isFinite(options && options.baseOffset) ? options.baseOffset : 0;
  const lines = sourceText.split('\n');
  let offset = baseOffset;
  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index];
    const hasNewline = index < lines.length - 1;
    const byteLength = Buffer.byteLength(rawLine, 'utf8') + (hasNewline ? 1 : 0);
    const location = { offset, end: offset + byteLength, index };
    offset += byteLength;
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (!line.trim()) continue;
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    if (isObject(record)) onRecord(record, location);
  }
}

function walkObjectBlocks(value, visitor, depth = 0) {
  if (depth > 20 || value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const entry of value) walkObjectBlocks(entry, visitor, depth + 1);
    return;
  }
  visitor(value);
  for (const child of Object.values(value)) {
    if (child !== null && typeof child === 'object') walkObjectBlocks(child, visitor, depth + 1);
  }
}

function numericExitCode(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) return Number(value.trim());
  return undefined;
}

// Codex reports how a script went in words even when it reports no exit code,
// and that wording was the single largest source of discarded evidence: an
// `unknown` outcome is dropped as not-evidence without even a stored
// observation hash. Measured on this machine's Codex corpus, 60 recent session
// files and 4,259 tool outputs: 2,316 resolved by an exit code, and **854**
// carried only this wording, which is 27% of everything resolvable.
//
// Treating `completed` as success is an inference, so it was checked rather
// than assumed. Across every output where BOTH the wording and an exit code
// appear, `completed` coincided with exit 0 thirteen times and with a nonzero
// code **zero** times. Note that `test/history-adapters.test.js` deliberately
// fixtures `Script completed` alongside `Exit code: 1`; that combination did
// not occur in the corpus, and it does not matter here regardless, because
// every caller checks for an explicit code first and only falls back to this.
function scriptWordingStatus(value) {
  const match = /\bScript\s+(completed|failed)\b/i.exec(value);
  if (!match) return 'unknown';
  return match[1].toLowerCase() === 'completed' ? 'success' : 'failed';
}

function structuredResultStatus(value, options = {}, depth = 0, seen = new Set()) {
  if (depth > 8 || value === null || value === undefined) return 'unknown';
  if (typeof value === 'string') {
    if (!options.inspectText) return 'unknown';
    const patterns = [
      /\bprocess\s+exited\s+with\s+(?:exit\s+)?code\s*:?\s*(-?\d+)\b/i,
      /\bexit(?:ed)?\s+(?:with\s+)?code\s*[:=]\s*(-?\d+)\b/i,
      /\bexit_code\s*[:=]\s*(-?\d+)\b/i,
      // The quote class was `[']`, a one-member class holding only an
      // apostrophe, where `['"]` was meant. So the double-quoted spelling that
      // `JSON.stringify` produces matched none of these, and the bare
      // `exit_code` pattern above cannot cover it either, because the closing
      // quote sits between the key and the colon and `\s*` will not consume
      // it. Measured: 43 outputs in the local corpus carry the quoted form.
      /['"]exit_code['"]\s*:\s*(-?\d+)\b/i,
      /['"]exitCode['"]\s*:\s*(-?\d+)\b/i,
    ];
    for (const pattern of patterns) {
      const match = pattern.exec(value);
      if (match) return Number(match[1]) === 0 ? 'success' : 'failed';
    }
    // An explicit code always wins; this is only reached when there is none.
    return scriptWordingStatus(value);
  }
  if (!isObject(value) && !Array.isArray(value)) return 'unknown';
  if (seen.has(value)) return 'unknown';
  seen.add(value);
  if (Array.isArray(value)) {
    let status = 'unknown';
    for (const entry of value) {
      status = mergeStatus(status, structuredResultStatus(entry, options, depth + 1, seen));
    }
    return status;
  }
  const failureFlags = ['is_error', 'isError', 'failed', 'interrupted', 'timed_out', 'timedOut'];
  if (failureFlags.some((key) => value[key] === true)) return 'failed';
  if (value.success === false || value.ok === false) return 'failed';
  for (const key of ['exit_code', 'exitCode', 'status_code', 'statusCode', 'returncode', 'returnCode']) {
    const code = numericExitCode(value[key]);
    if (code !== undefined) return code === 0 ? 'success' : 'failed';
  }
  const statusWord = typeof value.status === 'string' ? value.status.toLowerCase() : '';
  if (['failed', 'failure', 'error', 'errored', 'cancelled', 'canceled', 'timed_out'].includes(statusWord)) {
    return 'failed';
  }
  if (value.success === true || value.ok === true || ['success', 'succeeded'].includes(statusWord)) {
    return 'success';
  }
  let status = 'unknown';
  for (const [key, child] of Object.entries(value)) {
    const inspectText = options.inspectText && ['output', 'text', 'content', 'message', 'result'].includes(key);
    if ((child !== null && typeof child === 'object') || (inspectText && typeof child === 'string')) {
      status = mergeStatus(status, structuredResultStatus(child, options, depth + 1, seen));
    }
  }
  return status;
}

function claudeMessageCandidates(record) {
  const candidates = [];
  const add = (value) => {
    if (isObject(value) && !candidates.includes(value)) candidates.push(value);
  };
  add(record.message);
  add(record.payload && record.payload.message);
  if (record.role || Array.isArray(record.content)) add(record);
  return candidates;
}

function claudeMetadata(record, message, state, options) {
  const payload = isObject(record.payload) ? record.payload : {};
  return {
    session: firstDefined(
      stringValue(record.sessionId), stringValue(record.session_id),
      stringValue(payload.sessionId), stringValue(payload.session_id),
      state.session, stringValue(options.session),
    ),
    cwd: firstDefined(
      stringValue(record.cwd), stringValue(payload.cwd), stringValue(message && message.cwd),
      state.cwd, stringValue(options.cwd),
    ),
    timestamp: firstDefined(record.timestamp, payload.timestamp, message && message.timestamp),
  };
}

function classifyClaudeResult(block, supplement) {
  if (block && (block.is_error === true || block.isError === true)) return 'failed';
  const structured = structuredResultStatus(supplement, { inspectText: false });
  if (structured !== 'unknown') return structured;
  if (block && (block.is_error === false || block.isError === false)) return 'success';
  // tool_result/toolUseResult is written only after execution. Explicit errors
  // above still win; otherwise its presence is Claude's completion signal.
  if (block || supplement !== undefined) return 'success';
  return 'unknown';
}

function parseClaudeJsonl(text, options = {}) {
  const observations = [];
  const calls = new Map();
  const results = new Map();
  const state = { session: stringValue(options.session), cwd: stringValue(options.cwd) };
  const file = stringValue(options.file) || stringValue(options.path);

  parseJsonlRecords(text, options, (record, location) => {
    const payload = isObject(record.payload) ? record.payload : {};
    state.session = firstDefined(
      stringValue(record.sessionId), stringValue(record.session_id),
      record.type === 'session_meta' ? stringValue(payload.id) : undefined, state.session,
    );
    state.cwd = firstDefined(stringValue(record.cwd), stringValue(payload.cwd), state.cwd);

    const messages = claudeMessageCandidates(record);
    for (const message of messages) {
      const role = String(firstDefined(message.role, message.type, record.type, '')).toLowerCase();
      const isAssistant = role === 'assistant' || String(record.type || '').toLowerCase() === 'assistant';
      if (!isAssistant || !Array.isArray(message.content)) continue;
      let blockIndex = 0;
      walkObjectBlocks(message.content, (block) => {
        if (block.type !== 'tool_use') return;
        const shell = SHELL_TOOLS.has(block.name);
        if (!shell && !isLearnableTool(block.name)) return;
        const metadata = claudeMetadata(record, message, state, options);
        const observation = createObservation({
          source: 'claude',
          tool: block.name,
          command: shell ? (block.input && block.input.command)
            : toolTarget(block.name, block.input),
          managedRule: shell ? undefined
            : matchManaged(options, block.name, toolPath(block.name, block.input)),
          callId: firstDefined(block.id, block.tool_use_id, block.toolUseId, block.call_id, block.callId),
          timestamp: metadata.timestamp,
          cwd: metadata.cwd,
          session: metadata.session,
          file,
          callOffset: location.offset,
          callEnd: location.end,
          commandIndex: blockIndex,
        });
        blockIndex += 1;
        if (!observation) return;
        const key = `${observation.callId}\0${observation.command}`;
        if (calls.has(key)) return;
        calls.set(key, observation);
        observations.push(observation);
        const priorResult = results.get(observation.callId);
        if (priorResult) applyResult(observation, priorResult);
      });
    }

    const recordSupplement = firstDefined(record.toolUseResult, payload.toolUseResult);
    const resultBlocks = [];
    for (const message of messages) {
      if (!Array.isArray(message.content)) continue;
      walkObjectBlocks(message.content, (block) => {
        if (block.type === 'tool_result') resultBlocks.push(block);
      });
    }
    if (record.type === 'tool_result') resultBlocks.push(record);

    for (const block of resultBlocks) {
      const callId = stringValue(firstDefined(
        block.tool_use_id, block.toolUseId, block.call_id, block.callId,
        record.tool_use_id, record.toolUseId,
      ));
      if (!callId) continue;
      const result = {
        status: classifyClaudeResult(block, firstDefined(block.toolUseResult, recordSupplement)),
        offset: location.offset,
        end: location.end,
      };
      const previous = results.get(callId);
      if (previous) result.status = mergeStatus(previous.status, result.status);
      results.set(callId, result);
      for (const observation of calls.values()) {
        if (observation.callId === callId) applyResult(observation, result);
      }
    }

    // Some versions use a keyed, direct toolUseResult without a content block.
    if (recordSupplement !== undefined && resultBlocks.length === 0) {
      const resultObject = isObject(recordSupplement) ? recordSupplement : {};
      const callId = stringValue(firstDefined(
        resultObject.tool_use_id, resultObject.toolUseId, resultObject.call_id,
        resultObject.callId, record.tool_use_id, record.toolUseId,
      ));
      if (callId) {
        const result = {
          status: classifyClaudeResult(undefined, recordSupplement),
          offset: location.offset,
          end: location.end,
        };
        results.set(callId, result);
        for (const observation of calls.values()) {
          if (observation.callId === callId) applyResult(observation, result);
        }
      }
    }
  });
  return observations;
}

function isIdentifierStart(char) {
  return typeof char === 'string' && /[A-Za-z_$]/.test(char);
}

function isIdentifierPart(char) {
  return typeof char === 'string' && /[A-Za-z0-9_$]/.test(char);
}

function readIdentifier(source, start) {
  if (!isIdentifierStart(source[start])) return null;
  let end = start + 1;
  while (end < source.length && isIdentifierPart(source[end])) end += 1;
  return { value: source.slice(start, end), end };
}

function skipTrivia(source, start) {
  let index = start;
  while (index < source.length) {
    if (/\s/.test(source[index])) { index += 1; continue; }
    if (source[index] === '/' && source[index + 1] === '/') {
      const newline = source.indexOf('\n', index + 2);
      return newline === -1 ? source.length : skipTrivia(source, newline + 1);
    }
    if (source[index] === '/' && source[index + 1] === '*') {
      const close = source.indexOf('*/', index + 2);
      return close === -1 ? source.length : skipTrivia(source, close + 2);
    }
    break;
  }
  return index;
}

function readJsStringLiteral(source, start) {
  const quote = source[start];
  const quoteCode = quote && quote.charCodeAt(0);
  const slash = String.fromCharCode(92);
  if (![34, 39, 96].includes(quoteCode)) return null;
  let value = '';
  let valid = true;
  let index = start + 1;
  while (index < source.length) {
    const char = source[index];
    if (char === quote) return { value: valid ? value : undefined, valid, end: index + 1 };
    if (quoteCode === 96 && char === '$' && source[index + 1] === '{') valid = false;
    if (char !== slash) { value += char; index += 1; continue; }
    index += 1;
    if (index >= source.length) break;
    const escaped = source[index];
    const simpleCodes = { b: 8, f: 12, n: 10, r: 13, t: 9, v: 11, 0: 0 };
    if (Object.prototype.hasOwnProperty.call(simpleCodes, escaped)) {
      value += String.fromCharCode(simpleCodes[escaped]);
      index += 1;
    } else if (escaped.charCodeAt(0) === 10) {
      index += 1;
    } else if (escaped.charCodeAt(0) === 13) {
      index += source.charCodeAt(index + 1) === 10 ? 2 : 1;
    } else if (escaped === 'x' || escaped === 'u') {
      const length = escaped === 'x' ? 2 : 4;
      const hex = source.slice(index + 1, index + 1 + length);
      if (!new RegExp('^[0-9A-Fa-f]{' + length + '}$').test(hex)) valid = false;
      else value += String.fromCharCode(parseInt(hex, 16));
      index += 1 + length;
    } else {
      value += escaped;
      index += 1;
    }
  }
  return { value: undefined, valid: false, end: source.length };
}

function isQuote(char) {
  return typeof char === 'string' && [34, 39, 96].includes(char.charCodeAt(0));
}

function findCommandProperty(source, objectStart) {
  let index = objectStart + 1;
  let curly = 1;
  let paren = 0;
  let bracket = 0;
  let atPropertyStart = true;
  while (index < source.length && curly > 0) {
    index = skipTrivia(source, index);
    if (index >= source.length) break;
    const char = source[index];
    if (curly === 1 && paren === 0 && bracket === 0 && atPropertyStart) {
      let key;
      let keyEnd = index;
      if (isQuote(char) && char.charCodeAt(0) !== 96) {
        const literal = readJsStringLiteral(source, index);
        if (!literal) return null;
        key = literal.valid ? literal.value : undefined;
        keyEnd = literal.end;
      } else {
        const identifier = readIdentifier(source, index);
        if (identifier) { key = identifier.value; keyEnd = identifier.end; }
      }
      if (key !== undefined) {
        const colon = skipTrivia(source, keyEnd);
        if (source[colon] === ':') {
          const valueStart = skipTrivia(source, colon + 1);
          if (key === 'command' && isQuote(source[valueStart])) {
            const literal = readJsStringLiteral(source, valueStart);
            if (!literal || !literal.valid) return null;
            const afterValue = skipTrivia(source, literal.end);
            return (source[afterValue] === ',' || source[afterValue] === '}') ? literal.value : null;
          }
          index = valueStart;
          atPropertyStart = false;
          continue;
        }
      }
      atPropertyStart = false;
    }
    if (isQuote(char)) {
      const literal = readJsStringLiteral(source, index);
      index = literal ? literal.end : source.length;
      continue;
    }
    if (char === '/' && (source[index + 1] === '/' || source[index + 1] === '*')) {
      index = skipTrivia(source, index);
      continue;
    }
    if (char === '{') curly += 1;
    else if (char === '}') curly -= 1;
    else if (char === '(') paren += 1;
    else if (char === ')') paren = Math.max(0, paren - 1);
    else if (char === '[') bracket += 1;
    else if (char === ']') bracket = Math.max(0, bracket - 1);
    else if (char === ',' && curly === 1 && paren === 0 && bracket === 0) atPropertyStart = true;
    index += 1;
  }
  return null;
}

// Tiny lexer for the generated functions.exec shape. It never evaluates JS;
// variables, concatenation, interpolation, and computed properties are rejected.
function extractNestedShellCommands(jsSource) {
  const source = typeof jsSource === 'string' ? jsSource : '';
  const commands = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    if (isQuote(char)) {
      const literal = readJsStringLiteral(source, index);
      index = literal ? literal.end : source.length;
      continue;
    }
    if (char === '/' && (source[index + 1] === '/' || source[index + 1] === '*')) {
      index = skipTrivia(source, index);
      continue;
    }
    const toolsIdentifier = readIdentifier(source, index);
    if (!toolsIdentifier || toolsIdentifier.value !== 'tools') {
      index += toolsIdentifier ? toolsIdentifier.value.length : 1;
      continue;
    }
    let cursor = skipTrivia(source, toolsIdentifier.end);
    if (source[cursor] !== '.') { index = toolsIdentifier.end; continue; }
    cursor = skipTrivia(source, cursor + 1);
    const method = readIdentifier(source, cursor);
    if (!method || method.value !== 'shell_command') { index = toolsIdentifier.end; continue; }
    cursor = skipTrivia(source, method.end);
    if (source[cursor] !== '(') { index = method.end; continue; }
    cursor = skipTrivia(source, cursor + 1);
    if (source[cursor] !== '{') { index = cursor; continue; }
    const command = findCommandProperty(source, cursor);
    if (typeof command === 'string' && command.trim()) commands.push(command);
    index = cursor + 1;
  }
  return commands;
}

function maskJsCode(source) {
  const text = String(source || '');
  const masked = text.split('');
  let index = 0;
  while (index < text.length) {
    if (isQuote(text[index])) {
      const literal = readJsStringLiteral(text, index);
      const end = literal ? literal.end : text.length;
      for (let cursor = index; cursor < end; cursor++) masked[cursor] = ' ';
      index = end;
      continue;
    }
    if (text[index] === '/' && text[index + 1] === '/') {
      const newline = text.indexOf('\n', index + 2);
      const end = newline === -1 ? text.length : newline;
      for (let cursor = index; cursor < end; cursor++) masked[cursor] = ' ';
      index = end;
      continue;
    }
    if (text[index] === '/' && text[index + 1] === '*') {
      const close = text.indexOf('*/', index + 2);
      const end = close === -1 ? text.length : close + 2;
      for (let cursor = index; cursor < end; cursor++) masked[cursor] = ' ';
      index = end;
      continue;
    }
    index += 1;
  }
  return masked.join('');
}

function customExecCanAttributeSuccess(jsSource, commands) {
  if (!Array.isArray(commands) || commands.length !== 1) return false;
  const code = maskJsCode(jsSource);
  if (/\b(?:catch|class|do|else|exit|finally|for|function|if|switch|try|while|with)\b|&&|\|\||=>|\?/.test(code)) {
    return false;
  }
  const call = /\btools\s*\.\s*shell_command\s*\(/g.exec(code);
  if (!call || !/\bawait\s*$/.test(code.slice(0, call.index))) return false;
  let curlyDepth = 0;
  for (let index = 0; index < call.index; index++) {
    if (code[index] === '{') curlyDepth += 1;
    else if (code[index] === '}') curlyDepth = Math.max(0, curlyDepth - 1);
  }
  return curlyDepth === 0;
}

// Exit-code lines if there are any, otherwise Codex's wording. Deliberately a
// whole-payload fallback rather than a per-string one, because a single
// execution emits BOTH a `Script completed` summary and an `Output:` block
// carrying `Exit code: 0`. Collecting from each string independently pushed two
// statuses for one command, and the attribution logic then refused the pair as
// a count mismatch, which is the right call on wrong input. Evidence is only
// added where there was none.
function nestedShellStatuses(value) {
  const codes = explicitNestedShellStatuses(value);
  if (codes.length) return codes;
  return scriptWordingStatuses(value);
}

function scriptWordingStatuses(value, statuses = [], depth = 0) {
  if (depth > 8 || value == null) return statuses;
  if (typeof value === 'string') {
    const status = scriptWordingStatus(value);
    if (status !== 'unknown') statuses.push(status);
    return statuses;
  }
  if (Array.isArray(value)) {
    for (const item of value) scriptWordingStatuses(item, statuses, depth + 1);
    return statuses;
  }
  if (isObject(value)) {
    for (const child of Object.values(value)) scriptWordingStatuses(child, statuses, depth + 1);
  }
  return statuses;
}

function explicitNestedShellStatuses(value, statuses = [], depth = 0) {
  if (depth > 8 || value == null) return statuses;
  if (typeof value === 'string') {
    const match = /(?:^|\r?\n)\s*Exit code:\s*(-?\d+)\b/i.exec(value);
    if (match) statuses.push(Number(match[1]) === 0 ? 'success' : 'failed');
    return statuses;
  }
  if (Array.isArray(value)) {
    for (const item of value) explicitNestedShellStatuses(item, statuses, depth + 1);
    return statuses;
  }
  if (isObject(value)) {
    for (const child of Object.values(value)) explicitNestedShellStatuses(child, statuses, depth + 1);
  }
  return statuses;
}

function jsonObject(value) {
  if (isObject(value)) return value;
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function codexItems(record) {
  const items = [];
  const add = (item) => {
    if (isObject(item) && CODEX_ITEM_TYPES.has(item.type) && !items.includes(item)) items.push(item);
  };
  if (record.type === 'response_item') add(record.payload);
  add(record);
  add(record.payload);
  add(record.item);
  if (isObject(record.payload)) add(record.payload.item);
  return items;
}

function codexTool(options) {
  if (SHELL_TOOLS.has(options.tool)) return options.tool;
  if (SHELL_TOOLS.has(options.defaultTool)) return options.defaultTool;
  return (options.platform || process.platform) === 'win32' ? 'PowerShell' : 'Bash';
}

function classifyCodexOutput(item) {
  return structuredResultStatus(item, { inspectText: true });
}

function applyCodexGroupResult(group, result) {
  if (!Array.isArray(group) || group.length === 0 || !result) return;
  let effectiveResult = result;
  if (group._customExec) {
    const nested = Array.isArray(result.nestedStatuses) ? result.nestedStatuses : [];
    let status = 'unknown';
    if (result.status === 'failed' || nested.includes('failed')) status = 'failed';
    else if (group._canAttributeSuccess && group.length === 1 &&
        nested.length === 1 && nested[0] === 'success') status = 'success';
    effectiveResult = { ...result, status };
  } else if (group.length > 1 && result.status !== 'failed') {
    effectiveResult = { ...result, status: 'unknown' };
  }
  for (const observation of group) applyResult(observation, effectiveResult);
}

function parseCodexJsonl(text, options = {}) {
  const observations = [];
  const callGroups = new Map();
  const results = new Map();
  const state = { session: stringValue(options.session), cwd: stringValue(options.cwd) };
  const file = stringValue(options.file) || stringValue(options.path);
  const tool = codexTool(options);

  parseJsonlRecords(text, options, (record, location) => {
    const payload = isObject(record.payload) ? record.payload : {};
    if (record.type === 'session_meta') {
      state.session = firstDefined(stringValue(payload.id), stringValue(payload.session_id), state.session);
      state.cwd = firstDefined(stringValue(payload.cwd), state.cwd);
    }
    state.session = firstDefined(stringValue(record.sessionId), stringValue(record.session_id), state.session);
    state.cwd = firstDefined(stringValue(record.cwd), state.cwd);

    for (const item of codexItems(record)) {
      if (item.type === 'function_call') {
        const name = String(item.name || '');
        if (name !== 'shell_command' && name !== 'functions.shell_command') continue;
        const args = jsonObject(item.arguments) || jsonObject(item.input);
        if (!args || typeof args.command !== 'string' || !args.command.trim()) continue;
        const outerCallId = stringValue(firstDefined(item.call_id, item.callId, item.id));
        const observation = createObservation({
          source: 'codex', tool, command: args.command, callId: outerCallId,
          timestamp: firstDefined(record.timestamp, payload.timestamp, item.timestamp),
          cwd: firstDefined(stringValue(args.workdir), state.cwd), session: state.session,
          file, callOffset: location.offset, callEnd: location.end,
        });
        if (!observation) continue;
        const groupKey = outerCallId || observation.callId;
        if (!callGroups.has(groupKey)) callGroups.set(groupKey, []);
        const group = callGroups.get(groupKey);
        if (!group.some((entry) => entry.id === observation.id)) {
          group.push(observation);
          observations.push(observation);
        }
        if (results.has(groupKey)) applyCodexGroupResult(group, results.get(groupKey));
        continue;
      }

      if (item.type === 'custom_tool_call') {
        const name = String(item.name || '');
        if (name !== 'exec' && name !== 'functions.exec') continue;
        const input = typeof item.input === 'string'
          ? item.input
          : (typeof item.arguments === 'string' ? item.arguments : '');
        const commands = extractNestedShellCommands(input);
        const outerCallId = stringValue(firstDefined(item.call_id, item.callId, item.id));
        const groupKey = outerCallId || `codex-group-${stableHash(file, state.session, location.offset, input)}`;
        if (!callGroups.has(groupKey)) callGroups.set(groupKey, []);
        const group = callGroups.get(groupKey);
        group._customExec = true;
        group._canAttributeSuccess = customExecCanAttributeSuccess(input, commands);
        commands.forEach((command, commandIndex) => {
          const observation = createObservation({
            source: 'codex', tool, command, callId: outerCallId,
            timestamp: firstDefined(record.timestamp, payload.timestamp, item.timestamp),
            cwd: state.cwd, session: state.session, file,
            callOffset: location.offset, callEnd: location.end, commandIndex,
          });
          if (!observation || group.some((entry) => entry.id === observation.id)) return;
          group.push(observation);
          observations.push(observation);
        });
        if (results.has(groupKey)) applyCodexGroupResult(group, results.get(groupKey));
        continue;
      }

      if (item.type === 'function_call_output' || item.type === 'custom_tool_call_output') {
        const outerCallId = stringValue(firstDefined(item.call_id, item.callId, item.id));
        if (!outerCallId) continue;
        const result = {
          status: classifyCodexOutput(item), offset: location.offset, end: location.end,
          nestedStatuses: item.type === 'custom_tool_call_output'
            ? nestedShellStatuses(item.output) : [],
        };
        const previous = results.get(outerCallId);
        if (previous) {
          result.status = mergeStatus(previous.status, result.status);
          result.nestedStatuses = [
            ...(Array.isArray(previous.nestedStatuses) ? previous.nestedStatuses : []),
            ...result.nestedStatuses,
          ];
        }
        results.set(outerCallId, result);
        applyCodexGroupResult(callGroups.get(outerCallId), result);
      }
    }
  });
  return observations;
}

function arrayValue(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function inferSource(rootPath) {
  return /(^|[\\/])\.codex([\\/]|$)/i.test(rootPath) ? 'codex' : 'claude';
}

function normalizeRootEntries(options) {
  const entries = [];
  const add = (source, value) => {
    for (const entry of arrayValue(value)) {
      if (typeof entry === 'string' && entry) entries.push({ source, path: entry });
      else if (isObject(entry)) {
        const entryPath = stringValue(firstDefined(entry.path, entry.root, entry.dir));
        const entrySource = ['claude', 'codex'].includes(entry.source) ? entry.source : source;
        if (entryPath) entries.push({ source: entrySource || inferSource(entryPath), path: entryPath });
      }
    }
  };
  const roots = options.roots;
  if (isObject(roots) && !roots.path && !roots.root && !roots.dir) {
    add('claude', roots.claude);
    add('codex', roots.codex);
  } else {
    for (const entry of arrayValue(roots)) {
      if (typeof entry === 'string') add(inferSource(entry), entry);
      else add(undefined, entry);
    }
  }
  add('claude', options.claudeRoots);
  add('codex', options.codexRoots);
  return entries;
}

function findJsonlFiles(root, source, output) {
  // Transcript roots can contain Windows junctions or symlinked directories.
  // Walking them recursively can revisit the same directory forever and crash
  // the worker with "Maximum call stack size exceeded". Use a real-path set
  // and an iterative walk so either a cycle or extreme nesting is harmless.
  const pending = [root];
  const visitedDirectories = new Set();
  while (pending.length) {
    const current = pending.pop();
    let stat;
    try { stat = fs.statSync(current); } catch { continue; }
    if (stat.isFile()) {
      if (current.toLowerCase().endsWith('.jsonl')) output.push({ source, path: path.resolve(current) });
      continue;
    }
    if (!stat.isDirectory()) continue;
    let canonical;
    try { canonical = fs.realpathSync.native(current); } catch { continue; }
    canonical = process.platform === 'win32' ? canonical.toLowerCase() : canonical;
    if (visitedDirectories.has(canonical)) continue;
    visitedDirectories.add(canonical);
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const child = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(child);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.jsonl')) {
        output.push({ source, path: path.resolve(child) });
      }
    }
  }
}

function hashBuffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function readRange(file, start, length) {
  if (length <= 0) return Buffer.alloc(0);
  const descriptor = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.allocUnsafe(length);
    let total = 0;
    while (total < length) {
      const count = fs.readSync(descriptor, buffer, total, length - total, start + total);
      if (count === 0) break;
      total += count;
    }
    return total === length ? buffer : buffer.subarray(0, total);
  } finally {
    fs.closeSync(descriptor);
  }
}

function fingerprintFile(file, size) {
  const headLength = Math.min(FINGERPRINT_BYTES, size);
  const tailStart = Math.max(0, size - FINGERPRINT_BYTES);
  const tailLength = size - tailStart;
  return {
    headLength,
    headHash: hashBuffer(readRange(file, 0, headLength)),
    tailStart,
    tailLength,
    tailHash: hashBuffer(readRange(file, tailStart, tailLength)),
  };
}

function cursorKeyForFile(file) {
  const absolutePath = path.normalize(path.resolve(file));
  const canonicalPath = process.platform === 'win32' ? absolutePath.toLowerCase() : absolutePath;
  const digest = crypto.createHash('sha256').update(canonicalPath, 'utf8').digest('hex').slice(0, 24);
  return `path-sha256:${digest}`;
}

function priorCursorFor(cursors, absolutePath, originalPath) {
  const hashedKey = cursorKeyForFile(absolutePath);
  if (cursors instanceof Map) {
    return cursors.get(hashedKey) || cursors.get(absolutePath) || cursors.get(originalPath);
  }
  if (!isObject(cursors)) return undefined;
  return cursors[hashedKey] || cursors[absolutePath] || cursors[originalPath];
}

function safeContinuation(file, stat, prior, source) {
  if (!isObject(prior) || !Number.isFinite(prior.size) || stat.size < prior.size) return false;
  if (prior.source && prior.source !== source) return false;
  if (prior.ino && stat.ino && String(prior.ino) !== String(stat.ino)) return false;
  if (![prior.headLength, prior.tailStart, prior.tailLength].every(Number.isFinite)) return false;
  if (!prior.headHash || !prior.tailHash) return false;
  if (prior.headLength > stat.size || prior.tailStart + prior.tailLength > stat.size) return false;
  try {
    return hashBuffer(readRange(file, 0, prior.headLength)) === prior.headHash &&
      hashBuffer(readRange(file, prior.tailStart, prior.tailLength)) === prior.tailHash;
  } catch {
    return false;
  }
}

function cursorForFile(file, source, stat) {
  return {
    source, size: stat.size, offset: stat.size, mtimeMs: stat.mtimeMs,
    ino: stat.ino || undefined, ...fingerprintFile(file, stat.size),
  };
}

function parseHistorySlice(source, buffer, options) {
  const text = buffer.toString('utf8');
  return source === 'codex' ? parseCodexJsonl(text, options) : parseClaudeJsonl(text, options);
}

function appendedResultIds(source, buffer) {
  const ids = new Set();
  parseJsonlRecords(buffer.toString('utf8'), {}, (record) => {
    if (source === 'codex') {
      for (const item of codexItems(record)) {
        if (item.type !== 'function_call_output' && item.type !== 'custom_tool_call_output') continue;
        const id = stringValue(firstDefined(item.call_id, item.callId, item.id));
        if (id) ids.add(id);
      }
      return;
    }
    for (const message of claudeMessageCandidates(record)) {
      if (!Array.isArray(message.content)) continue;
      walkObjectBlocks(message.content, (block) => {
        if (block.type !== 'tool_result') return;
        const id = stringValue(firstDefined(block.tool_use_id, block.toolUseId, block.call_id, block.callId));
        if (id) ids.add(id);
      });
    }
    if (record.type === 'tool_result') {
      const id = stringValue(firstDefined(record.tool_use_id, record.toolUseId, record.call_id, record.callId));
      if (id) ids.add(id);
    }
  });
  return ids;
}

// Safe appends read a bounded overlap plus new bytes. Stable observation ids let
// callers upsert a call when its result arrives on the other side of a cursor.
function scanHistoryFiles(options = {}) {
  const priorCursors = options.cursors || options.priorCursors || {};
  const overlapBytes = Number.isFinite(options.overlapBytes)
    ? Math.max(0, Math.floor(options.overlapBytes))
    : DEFAULT_OVERLAP_BYTES;
  const found = [];
  for (const root of normalizeRootEntries(options)) findJsonlFiles(root.path, root.source, found);
  const unique = new Map();
  for (const entry of found) {
    const key = process.platform === 'win32' ? entry.path.toLowerCase() : entry.path;
    if (!unique.has(key)) unique.set(key, entry);
  }
  const observations = [];
  const cursors = {};
  const files = [];
  const sorted = [...unique.values()].sort((a, b) => a.path.localeCompare(b.path));

  for (const entry of sorted) {
    const file = entry.path;
    let stat;
    try { stat = fs.statSync(file); } catch (error) {
      files.push({ path: file, source: entry.source, mode: 'error', error: error.message });
      continue;
    }
    const prior = priorCursorFor(priorCursors, file, entry.path);
    const cursorKey = cursorKeyForFile(file);
    // Everything from here is inside the per-file try. It used not to be: the
    // three `readRange` calls below, and `cursorForFile` on the `unchanged`
    // fast path, all sat outside it. `readRange` throws on ENOENT for a
    // transcript deleted between the enumeration above and the read, on
    // EACCES/EPERM/EBUSY while antivirus or another process holds a Windows
    // lock, on EMFILE, and on ERR_OUT_OF_RANGE for a file past the buffer
    // limit. Any of those escaped `scanHistoryFiles`, escaped `scan()`, and
    // took `save(state)` with it, so ONE transient failure among hundreds of
    // files discarded every other file's cursor progress and the extension
    // then backed its retry off to an hour. The fast path was the easiest to
    // miss, because it looks read-only and is in fact two file reads deep.
    let safe = false;
    let mode = 'full';
    try {
      safe = safeContinuation(file, stat, prior, entry.source);
      if (safe && stat.size === prior.size) {
        cursors[cursorKey] = cursorForFile(file, entry.source, stat);
        files.push({ path: file, source: entry.source, mode: 'unchanged', size: stat.size, bytesRead: 0 });
        continue;
      }

      mode = safe && stat.size > prior.size ? 'append' : 'full';
      let start = 0;
      let buffer;
      if (mode === 'append') {
        const tentativeStart = Math.max(0, prior.size - overlapBytes);
        buffer = readRange(file, tentativeStart, stat.size - tentativeStart);
        start = tentativeStart;
        if (tentativeStart > 0) {
          const oldPrefixLength = prior.size - tentativeStart;
          const newline = buffer.subarray(0, oldPrefixLength).indexOf(10);
          if (newline === -1) {
            mode = 'full';
            start = 0;
            buffer = readRange(file, 0, stat.size);
          } else {
            start = tentativeStart + newline + 1;
            buffer = buffer.subarray(newline + 1);
          }
        }
      } else {
        buffer = readRange(file, 0, stat.size);
      }

        let parsed = parseHistorySlice(entry.source, buffer, {
          file, baseOffset: start, platform: options.platform, defaultTool: options.defaultTool,
          probeMatcher: options.probeMatcher,
        });
        if (mode === 'append') {
          const appendedStart = Math.max(0, prior.size - start);
          const resultIds = appendedResultIds(entry.source, buffer.subarray(appendedStart));
          const parsedCalls = new Set(parsed.map((observation) => observation.callId).filter(Boolean));
          if ([...resultIds].some((id) => !parsedCalls.has(id))) {
            // The bounded overlap did not reach the matching request. Reconcile
            // this file once so a result crossing the cursor is never lost.
            start = 0;
            buffer = readRange(file, 0, stat.size);
            parsed = parseHistorySlice(entry.source, buffer, {
              file, baseOffset: 0, platform: options.platform, defaultTool: options.defaultTool,
              probeMatcher: options.probeMatcher,
            });
          }
        }
        const selected = mode === 'full'
          ? parsed
          : parsed.filter((observation) =>
            observation._callEnd > prior.size || observation._resultEnd > prior.size
          );
        observations.push(...selected);
        cursors[cursorKey] = cursorForFile(file, entry.source, stat);
        files.push({
          path: file, source: entry.source, mode, size: stat.size,
          bytesRead: buffer.length, observations: selected.length,
        });
    } catch (error) {
      // Carry the prior cursor forward ONLY when it still describes the file.
      // When `safe` is false the file was rewritten or truncated, so the prior
      // offset points into bytes that no longer exist, and writing it back made
      // the next scan resume from the wrong place and silently skip real
      // observations. Better to re-read a file we failed on than to claim
      // progress we did not make.
      //
      // A first-sight failure therefore still records no cursor and is re-read
      // next scan. That is deliberate: the alternative, inventing a cursor we
      // did not earn, trades a bounded I/O cost for permanent data loss. Making
      // it skip-until-changed needs a failure-tracking structure of its own,
      // which is in BACKLOG rather than smuggled in here.
      if (safe && prior) cursors[cursorKey] = prior;
      files.push({ path: file, source: entry.source, mode: 'error', size: stat.size, error: error.message });
    }
  }
  return { observations, cursors, files };
}

module.exports = {
  parseClaudeJsonl,
  parseCodexJsonl,
  extractNestedShellCommands,
  cursorKeyForFile,
  scanHistoryFiles,
};
