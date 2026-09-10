'use strict';

// The derivation is the whole value of the managed report: a cost nobody can
// configure away is only useful if it turns into the one behaviour that reduces
// it. It is also the part most likely to quietly bloat an instruction file, so
// the threshold, the cap and the refusal to emit filler are tested as hard as
// the mapping itself.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  deriveMitigations, markersFor, renderMitigation, DEFAULT_THRESHOLD, DEFAULT_LIMIT,
  installedDerivedIds, reconcileDerived, cleanRule,
} = require('../src/derived-guidance');
const { GUIDANCE_BODY, BEGIN, END } = require('../src/agent-guidance');

const rule = (text, prompts, extra = {}) => ({
  rule: text, prompts, decision: 'ask', tools: [], ...extra,
});

test('a rule shape maps to the behaviour that reduces it, and nothing else', () => {
  const derived = deriveMitigations([
    rule('Edit(**/*.ps1)', 253, { tools: ['Edit'] }),
    rule('Bash(curl:*)', 120),
    rule('Read(**/.env*)', 90),
  ], { limit: 10 });

  assert.deepEqual(derived.map((item) => item.id),
    ['batch-file-edits', 'batch-network-fetches', 'read-gated-path-once']);

  // The count belongs in the text. A reader deciding whether to keep a permanent
  // instruction needs the number that justified it, and a number that has gone
  // stale is the signal to drop the line.
  assert.match(derived[0].body, /253 prompts/);
  assert.match(derived[0].body, /ONE consolidated Edit per file per pass/);
  // And it has to say the prompt cannot be configured away, or the reader goes
  // hunting for the setting that would have fixed it.
  for (const item of derived) {
    assert.match(item.body, /outranks every user allow entry/);
    assert.match(item.body, /Measured \d+ prompts?/);
  }

  // A fetch has an alternative tool; an arbitrary command does not. Collapsing
  // the two would give WebFetch advice for `cmake`.
  assert.match(derived[1].body, /WebFetch/);
  const generic = deriveMitigations([rule('Bash(cmake:*)', 80)]);
  assert.equal(generic[0].id, 'script-multi-step-work');
  assert.doesNotMatch(generic[0].body, /WebFetch/);
});

test('both spellings of the trailing wildcard are one rule', () => {
  for (const text of ['Bash(curl:*)', 'Bash(curl *)', 'Bash(curl.exe:*)']) {
    const derived = deriveMitigations([rule(text, 60)]);
    assert.equal(derived.length, 1, text);
    assert.equal(derived[0].id, 'batch-network-fetches', text);
  }
});

test('an unknown shape produces nothing rather than filler', () => {
  // Advice that does not change what the agent does is pure context cost, and it
  // teaches the reader to skim the block that carries the real rules.
  const derived = deriveMitigations([
    rule('WebFetch(domain:example.com)', 500),
    rule('mcp__context7__query-docs', 500),
    rule('WebSearch', 500),
    rule('not a rule at all', 500),
    rule('', 500),
    { prompts: 500 },
  ], { limit: 10 });
  assert.deepEqual(derived, []);
});

test('a bare tool-level rule is a known shape and does derive advice', () => {
  // `coversPermission` was taught the bare-tool case precisely so a managed
  // `Edit` matches every Edit probe, which means it can accumulate hundreds of
  // prompts and rank first. Requiring a specifier here made that rank-one rule
  // produce nothing, so the two modules disagreed about whether it is a shape
  // this tool understands.
  const edit = deriveMitigations([rule('Edit', 500)]);
  assert.equal(edit.length, 1);
  assert.equal(edit[0].id, 'batch-file-edits');
  assert.match(edit[0].body, /^`Edit` is a managed `ask`, which outranks/);

  const bash = deriveMitigations([rule('Bash', 500)]);
  assert.equal(bash[0].id, 'script-multi-step-work',
    'a bare command rule has no root, so it cannot be the network case');
  assert.doesNotMatch(bash[0].body, /WebFetch/);
});

test('two rules of one shape become one mitigation naming the costliest', () => {
  // There are four ids and a policy can easily carry two rules of a shape. A
  // per-rule list produced duplicate ids, and since every structure downstream
  // keys on the id, the LAST rule won: the installed block named the cheaper
  // rule, the dearer one got no advice, and both still spent a cap slot.
  const derived = deriveMitigations([
    rule('Edit(**/*.ps1)', 300, { tools: ['Edit'] }),
    rule('Edit(**/.github/workflows/*)', 120, { tools: ['Edit'] }),
    rule('Bash(docker:*)', 200),
    rule('Bash(kubectl:*)', 90),
  ], { limit: 10 });

  assert.deepEqual(derived.map((item) => item.id),
    ['batch-file-edits', 'script-multi-step-work'], 'two shapes, not four entries');
  assert.equal(derived[0].rule, 'Edit(**/*.ps1)', 'the costliest rule is the one named');
  assert.deepEqual(derived[0].rules, ['Edit(**/*.ps1)', 'Edit(**/.github/workflows/*)']);
  assert.equal(derived[0].prompts, 420, 'the advice addresses the whole shape, so the cost sums');
  assert.match(derived[0].body, /plus 1 more rule of the same shape/);
  assert.match(derived[0].body, /Measured 420 prompts/);

  assert.equal(derived[1].rule, 'Bash(docker:*)');
  assert.equal(derived[1].prompts, 290);
  assert.match(derived[1].body, /plus 1 more rule of the same shape/);

  // And the cap now limits distinct advice rather than rule count, so a fourth
  // duplicate-shape rule cannot crowd out a genuinely different mitigation.
  const capped = deriveMitigations([
    rule('Bash(alpha:*)', 400), rule('Bash(beta:*)', 300),
    rule('Bash(gamma:*)', 200), rule('Edit(**/*.ps1)', 150),
  ]);
  assert.deepEqual(capped.map((item) => item.id),
    ['script-multi-step-work', 'batch-file-edits']);
  assert.equal(capped[0].prompts, 900);
});

test('the threshold and the cap both hold, and default to the strict values', () => {
  const many = [
    rule('Edit(**/*.ps1)', 300),
    rule('Bash(curl:*)', 200),
    rule('Bash(git push:*)', 100),
    rule('Read(**/.env*)', 90),
    rule('Bash(cmake:*)', 80),
  ];
  assert.equal(deriveMitigations(many).length, DEFAULT_LIMIT);
  assert.equal(DEFAULT_LIMIT, 3);
  assert.equal(DEFAULT_THRESHOLD, 50);

  // A line in an instruction file is paid for on every session forever, so the
  // bar is far higher than the one a single allow entry has to clear.
  assert.deepEqual(deriveMitigations([rule('Edit(**/*.ps1)', 49)]), []);
  assert.equal(deriveMitigations([rule('Edit(**/*.ps1)', 50)]).length, 1);
  assert.equal(deriveMitigations(many, { threshold: 150, limit: 10 }).length, 2);
  assert.deepEqual(deriveMitigations(many, { limit: 0 }), []);

  // Ranking is the caller's, and it is preserved: the costliest rule earns the
  // scarce slot.
  assert.deepEqual(deriveMitigations(many, { threshold: 1 }).map((item) => item.rule),
    ['Edit(**/*.ps1)', 'Bash(curl:*)', 'Bash(git push:*)']);
});

test('a deny reads as a deny, and a duplicate rule earns one slot', () => {
  const derived = deriveMitigations([
    rule('Edit(**/*.ps1)', 60, { decision: 'deny' }),
    rule('Edit(**/*.ps1)', 60),
  ], { limit: 10 });
  assert.equal(derived.length, 1);
  assert.equal(derived[0].decision, 'deny');
  assert.match(derived[0].body, /managed `deny`/);
});

test('bad input is empty output, not a throw', () => {
  for (const input of [undefined, null, 'nope', 42, {}, [null], [undefined]]) {
    assert.deepEqual(deriveMitigations(input), [], JSON.stringify(input));
  }
});

test('each mitigation gets its own marker pair', () => {
  // A single shared block makes every line in it indistinguishable from every
  // other, so a reader who rejects one has to hand-edit the block. Per-item
  // markers are what let an undo remove exactly the rejected one.
  const first = markersFor('batch-file-edits');
  const second = markersFor('batch-network-fetches');
  assert.notEqual(first.begin, second.begin);
  assert.match(first.begin, /^<!-- BEGIN permission-wildcarding: batch-file-edits \(derived\) -->$/);
  assert.match(first.end, /^<!-- END permission-wildcarding: batch-file-edits \(derived\) -->$/);
  // A marker is a comment in someone's instruction file, so an id that could
  // close the comment or inject markup must not survive into it.
  const hostile = markersFor('evil--> <script>x</script>');
  assert.doesNotMatch(hostile.begin, /<script|-->\s</);
  assert.equal(renderMitigation({ title: 'T', body: 'B' }), '- **T.** B');
});

const MITIGATIONS = deriveMitigations([
  { rule: 'Edit(**/*.ps1)', prompts: 253, decision: 'ask', tools: ['Edit'] },
  { rule: 'Bash(curl:*)', prompts: 120, decision: 'ask', tools: ['Bash'] },
], { limit: 10 });

test('nothing is installed that a human did not accept', () => {
  const notes = '# my notes\n\nkeep these\n';
  // The whole difference between this and a static block shipped at install.
  assert.deepEqual(reconcileDerived(notes, MITIGATIONS, { accepted: [] }),
    { text: notes, changed: false, added: [], updated: [], removed: [] });
  assert.deepEqual(reconcileDerived(notes, MITIGATIONS).changed, false);

  const one = reconcileDerived(notes, MITIGATIONS, { accepted: ['batch-file-edits'] });
  assert.deepEqual(one.added, ['batch-file-edits']);
  assert.deepEqual(installedDerivedIds(one.text), ['batch-file-edits']);
  assert.match(one.text, /^# my notes$/m, "the user's own notes keep their place at the top");
  assert.match(one.text, /253 prompts/);
  assert.ok(!one.text.includes('WebFetch'), 'a declined mitigation is simply never written');

  // Idempotent: activation must not rewrite the file on every run.
  const again = reconcileDerived(one.text, MITIGATIONS, { accepted: ['batch-file-edits'] });
  assert.equal(again.changed, false);
  assert.deepEqual(again, { text: one.text, changed: false, added: [], updated: [], removed: [] });
});

test('a block whose evidence no longer holds is removed, not left asserting a stale number', () => {
  const installed = reconcileDerived('# notes\n', MITIGATIONS,
    { accepted: ['batch-file-edits', 'batch-network-fetches'] });
  assert.deepEqual(installed.added.sort(), ['batch-file-edits', 'batch-network-fetches']);

  // The rule dropped below threshold, which is exactly what success looks like:
  // the policy got fixed or the behaviour worked. The number in the text was the
  // justification, so leaving it in place would be a false claim.
  const dropped = deriveMitigations([
    { rule: 'Edit(**/*.ps1)', prompts: 4, decision: 'ask', tools: ['Edit'] },
    { rule: 'Bash(curl:*)', prompts: 120, decision: 'ask', tools: ['Bash'] },
  ], { limit: 10 });
  const after = reconcileDerived(installed.text, dropped,
    { accepted: ['batch-file-edits', 'batch-network-fetches'] });
  assert.deepEqual(after.removed, ['batch-file-edits']);
  assert.deepEqual(installedDerivedIds(after.text), ['batch-network-fetches']);
  assert.ok(!after.text.includes('253 prompts'));

  // An id this version no longer knows at all is still removable, because
  // removal reads the markers rather than a body it would have to reconstruct.
  const orphan = `# notes\n\n<!-- BEGIN permission-wildcarding: retired-idea (derived) -->\n- **Old.** Gone.\n<!-- END permission-wildcarding: retired-idea (derived) -->\n`;
  const swept = reconcileDerived(orphan, [], { accepted: [] });
  assert.deepEqual(swept.removed, ['retired-idea']);
  assert.equal(swept.text, '# notes\n');
});

test('a wording change refreshes in place rather than stranding a second copy', () => {
  const first = reconcileDerived('', MITIGATIONS, { accepted: ['batch-file-edits'] });
  const reworded = MITIGATIONS.map((item) => (item.id === 'batch-file-edits'
    ? { ...item, body: 'Reworded advice.' } : item));
  const second = reconcileDerived(first.text, reworded, { accepted: ['batch-file-edits'] });
  assert.deepEqual(second.updated, ['batch-file-edits']);
  assert.deepEqual(second.added, []);
  assert.deepEqual(installedDerivedIds(second.text), ['batch-file-edits'],
    'refreshed in place, so no orphaned older copy');
  assert.match(second.text, /Reworded advice\./);
  assert.ok(!second.text.includes('253 prompts'));
});

test('a derived block never disturbs the static shell-style block', () => {
  // Different marker pairs, so the two are independent. Sharing one would mean
  // an "off" on either tore out the other.
  const shell = `${BEGIN}\n${GUIDANCE_BODY}\n${END}\n`;
  const withDerived = reconcileDerived(shell, MITIGATIONS, { accepted: ['batch-file-edits'] });
  assert.ok(withDerived.text.includes(shell.trimEnd()), 'the static block survives intact');
  const swept = reconcileDerived(withDerived.text, [], { accepted: [] });
  assert.deepEqual(swept.removed, ['batch-file-edits']);
  assert.ok(swept.text.includes(shell.trimEnd()), 'and survives the sweep too');
  assert.deepEqual(installedDerivedIds(swept.text), []);
});

// ── The rule text is not this repo's ─────────────────────────────────────────
// It is read from `~/.claude/remote-settings.json`, a local client-refreshed
// cache, and it lands inside a code span in the user's own instruction file. The
// two sources that feed `costliestRules` disagreed about sanitising it: the
// managed-hits side cleans it (`auto-learn-manager.js:1391`), the inert-family
// side reaches `addCost` at :787 as `String(rule)`. So any local process able to
// write that cache could choose text that closed the code span, broke the block,
// or forged a marker line.

test('the rule text is cleaned before it can reach a code span', () => {
  assert.equal(cleanRule('Edit(**/*.ps1)'), 'Edit(**/*.ps1)', 'an ordinary rule is untouched');
  // Same transform the hit table already applies: control characters and
  // whitespace runs collapse to one space, trimmed, 200 characters.
  assert.equal(cleanRule('  Bash(a\nb\tc)  '), 'Bash(a b c)');
  assert.equal(cleanRule('Bash(a\u0000b\u007fc)'), 'Bash(a b c)');
  assert.equal(cleanRule('x'.repeat(400)).length, 200);
  // Plus the two things a code span inside a marker-fenced block cares about: a
  // backtick closes the span, so everything after it renders as instructions
  // rather than as a quoted rule, and `<!--` opens a comment that swallows the
  // text after it — including a marker line.
  assert.equal(cleanRule('Bash(`whoami`)'), 'Bash(whoami)');
  assert.equal(cleanRule(`Bash(${END})`),
    'Bash(&lt;!-- END permission-wildcarding: shell style --&gt;)');
  const hostile = `Edit(**/*.ps1 \`x\`\n${markersFor('batch-file-edits').end})`;
  assert.equal(cleanRule(cleanRule(hostile)), cleanRule(hostile), 'idempotent');
  for (const bad of [null, undefined, 42, {}, []]) assert.equal(cleanRule(bad), '');
});

test('a hostile rule reaches the instruction file defused, and the advice survives', () => {
  const hostile = `Edit(**/*.ps1 \`x\`\n${markersFor('batch-file-edits').end})`;
  const derived = deriveMitigations([
    { rule: hostile, prompts: 300, decision: 'ask', tools: ['Edit'] },
  ], { limit: 10 });

  // Sanitising must not silently drop the advice: the shape is still an Edit.
  assert.equal(derived.length, 1);
  assert.equal(derived[0].id, 'batch-file-edits');
  assert.doesNotMatch(derived[0].rule, /[`\r\n]/,
    'no backtick to close the code span, no newline to break the block');
  assert.doesNotMatch(derived[0].body, /[\r\n]/, 'the body stays one line');
  assert.doesNotMatch(derived[0].body, /<!--|-->/,
    'and carries no comment delimiter to swallow a marker line');
  // The span closes where the rule ends, so nothing the rule carried is left
  // rendering as instructions.
  assert.ok(derived[0].body.startsWith(`\`${derived[0].rule}\` is a managed \`ask\``));
  assert.match(derived[0].body, /Measured 300 prompts/);

  const notes = '# my notes\n\nkeep these\n';
  const { begin, end } = markersFor('batch-file-edits');
  const installed = reconcileDerived(notes, derived, { accepted: ['batch-file-edits'] });
  assert.equal(installed.text.split(begin).length - 1, 1, 'exactly one begin marker');
  assert.equal(installed.text.split(end).length - 1, 1, 'and exactly one end marker');
  assert.deepEqual(installedDerivedIds(installed.text), ['batch-file-edits']);
  // Idempotent, so a forged marker cannot start the truncated-range accumulation.
  assert.equal(reconcileDerived(installed.text, derived,
    { accepted: ['batch-file-edits'] }).changed, false);
  // And the user's own file comes back byte for byte.
  assert.equal(reconcileDerived(installed.text, [], { accepted: [] }).text, notes);
});
