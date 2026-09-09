# Backlog

Open items with the evidence that justifies them, so a later session does not
re-derive the reasoning. Anything measured says so and names the date; anything
unverified says that too. Closed items are removed rather than archived, since
git holds the history.

## Verified working, nothing to do

Auto Learn applies. Both symptoms that opened the 2026-09-02/03 work are gone,
confirmed on a real machine 2026-09-03: `~/.codex/rules/permission-wildcarding.rules`
written with 43 `prefix_rule` entries, state `applied.claude` 23 and
`applied.codex` 50, `lastApplication` set across `claude`, `claude-claims` and
`codex`, Review count back to 0.

## Open

### The claims registry can claim an entry the allow list no longer holds

After an apply, the wildcarding pass prunes any new entry a broader existing rule
already covers. Measured 2026-09-03: 12 entries written, 8 pruned
(`Bash(git diff *)` under `Bash(git *)`, `PowerShell(dotnet run *)` under
`PowerShell(dotnet *)`, and so on), leaving `claude-policy-claims.json` claiming
8 permissions absent from `settings.json`.

Impact today is nil: every pruned family is still allowed through its parent, and
Undo releases claims rather than restoring bytes, so a claim for an absent entry
is a no-op. It would matter only if the parent were later removed, at which point
the child would not return. Fix would be to reconcile claims against the file
after the wildcarding pass, or to record the covering parent alongside the claim.

### Non-interactive runs refuse every output redirection

Measured 2026-09-03, Claude Code 2.1.258. Four `-p` probes were refused with
"Output redirection to '<path>' was blocked … may only write to files in the
allowed working directories", including a target inside the session's own working
directory that the refusal itself listed as allowed. The identical redirect
succeeded in an interactive session. Reads as `-p` failing closed because it
cannot prompt, with a message naming the wrong reason. Not this project's bug;
recorded because it invalidates any redirect experiment run through `-p`.

### Claude Code's built-in read-only command set is not fully known

`hostname` ran with no matching allow entry and no prompt, so the built-in set is
wider than the 14 commands `docs/claude-code-permissions.md` lists from the docs.
The list is used to argue which pack entries are redundant, so it is worth
pinning down before acting on that argument again. `scripts/auto-mode-audit.js`
is the wrong tool (it reads load-time warnings); this needs a per-command probe.

### `.exe` spellings split a family's evidence

`git.exe status` keys as `powershell:git.exe status`, separate from
`powershell:git status`, with its own permission string. Risk classification
already normalizes `.exe` away, so only the key and prefix differ, and runs
spread across the two spellings each count toward their own threshold. Largest
such family observed: 15 runs. Costs nothing while `PowerShell(& *)` covers the
call-operator form those invocations use. Fix would unify the family for evidence
while still emitting both permission spellings.

### State file growth is unbounded in one dimension

2.9 MB at last check: ~13.5k observation hashes against a 20,000 cap, ~790
cursors with no cap, 234 candidates. Measured cost is 14 ms to parse and 9 ms to
serialize, so this is not urgent. Cursors are the only uncapped structure; they
accumulate one entry per transcript file ever seen and never shrink when a
transcript is deleted. Revisit if the file passes roughly 20 MB.

### Inert bookkeeping candidates

Around a quarter of candidates are complex with no permission, so they can never
render a rule, never appear in Review, and cost no prompts: shell keywords
(`for`, `done`) and quoted-executable basenames. Masking is not at fault, checked
against bash heredocs and both PowerShell here-string forms. Cosmetic only.

## Deferred by the maintainer

### The 13 blanket wrapper grants in the starter pack

`Bash(bash|sh|python|python3|node|npx|pwsh|powershell *)`, `PowerShell(& *)`,
`PowerShell(python|python3|powershell|node *)`. Each is an arbitrary-execution
grant, the learner refuses to propose these exact shapes, and the Codex exporter
rejects one of them as "too broad" while the Claude seed installs it. Left in
place on the maintainer's call 2026-09-03. Note that auto mode discards most of
this class at load, so they are inert there and live in manual, which is the mode
MAX switches to.

### An audit of a live allow list

Turning the same measurement on a real ~300-entry list to report which entries
are broader than the evidence supports. Offered and deferred.
