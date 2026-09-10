# permission-wildcarding

Auto-generalizes approved Claude Code **Bash and PowerShell** permissions to
command-family wildcards, so you stop re-approving the same family of commands. It
runs as a Claude Code `PostToolUse` hook against `~/.claude/settings.json`: once
you approve, say, `Bash(git status)`, it collapses that and its siblings into a
single `Bash(git status *)` entry. Fixed-purpose tools still collapse at their
root (`Bash(rg *)`); newly observed mixed-capability dispatchers such as `git`,
`gh`, `docker`, and package managers keep the subcommand boundary. Existing
wildcards are preserved rather than silently narrowed, so legacy root-wide entries
already in settings or in the starter pack remain root-wide. Because Claude Code checks each sub-command of a
compound (`a && b`, `a | b`, `a; b`) independently, one root wildcard per command
also clears prompts inside pipelines and chains.

Simple fixed-purpose commands generalize to their root, including destructive
ones such as `rm`; mixed-capability commands generalize only to the observed
subcommand. The safety boundary for the legacy hook is still your
`permissions.deny` list, which always wins and is evaluated per sub-command.

## What's here

- **`bin/wildcard-perms`** — the hook executable and CLI (Node); also supports
  `--learn scan|status|apply|undo|hits`, `--seed`, `--drain [--dry-run]` (project-local
  approvals), `--guidance on|off|status` (agent shell style),
  `--guidance derived|accept|decline|reset` (mitigations earned from measured cost),
  `--gates on|off|status|refresh` (memory gates), `--max on|off|status`
  (MAX mode), and `--bypass on|off|status` (see below).
- **`src/permissions.js`** — the live Claude allow-list generalization logic, a
  legacy syntax-only mining helper, and the MAX-mode and bypass toggles.
- **`src/auto-learn.js`**, **`src/history-adapters.js`**, **`src/auto-learn-manager.js`**,
  **`src/auto-learn-worker.js`**, and **`src/policy-exporters.js`** — the shared
  cross-agent learner, correlated-outcome history adapters, background worker, state manager,
  and separate Claude Code / Codex policy exporters.
- **`src/tool-learn.js`** — the non-shell families (MCP tool, web fetch, file tool) and the
  limits on what each may ever propose.
- **`src/policy-lock.js`** — the advisory lock every policy writer takes, so Auto Learn and
  the wildcarding pass cannot interleave on `settings.json`.
- **`src/local-settings.js`** — the project-local drain: which of a project's
  `.claude/settings.local.json` approvals are portable enough to promote to user scope,
  and the promote-verify-prune order that makes removing one loss-free (see below).
- **`src/agent-guidance.js`** — the marker-fenced shell-style block written into each
  installed agent's user-scope instruction file (`~/.claude/CLAUDE.md`, and
  `~/.codex/AGENTS.md` when Codex is present), the only way to fix the approvals no
  generalizer can ever match twice (see below). `createManagedBlock` is the marker-fenced
  primitive both blocks are built from.
- **`src/agent-gates.js`** — the second managed block: your own standing orders, compiled
  out of your Claude Code file memory by `recall.py --gates-compile`. Separate markers and
  a separate switch, so neither block can turn the other off (see below).
- **`memory/recall.py`** / **`src/recall-index.js`** — the CPU semantic-recall script
  (bge-small ONNX), which the VSIX bundles, and the shared staleness predicate the
  extension uses to decide whether re-embedding is needed at all.
- **`patterns/starter-pack.json`** / **`patterns/starter-pack.md`** — a curated
  seed of common, safe wildcard patterns (documented in the `.md`).
- **`scripts/mirror-pack.js`** — keeps the starter pack's PowerShell half in step with
  its Bash half, since Bash sits under a built-in read-only set and (in an enterprise) a
  managed allow list while PowerShell has neither. Run it bare to report, `--write` to
  apply; a test asserts the pack stays closed under the rule.
- **`scripts/auto-mode-audit.js`** — reports which of your allow entries Claude Code
  actually loads, because auto mode discards the ones that would bypass its classifier.
  Free and sandboxed: it points `CLAUDE_CONFIG_DIR` at an empty directory, writes only a
  copy of your allow array there, and stops before any API call.
- **`docs/claude-code-permissions.md`** — how Claude Code actually matches permission
  rules, cited to the official docs and cross-checked against a real enterprise-managed
  policy: rule syntax and the bare-command rule, per-subcommand matching, which wrappers
  are stripped, redirection targets, precedence, every friction lever that is not bypass
  mode, and a list of beliefs about matching that turned out to be wrong. **Read it before
  changing anything about the shape of an emitted permission**, and before assuming a grant
  will stop a prompt.
- **`vscode-extension/`** — optional VS Code extension. Watches `settings.json` live
  and wildcards on change, and adds an **Activity Bar dashboard** (asterisk icon):
  an "Active" status card, live tallies (approved / wildcards / specific), a
  **Wildcard Now** button, cross-agent **Auto Learn** controls (see below), and a
  collapsible list of tracked wildcards — each with a one-click prune (✕), and a **⚡ MAX**
  toggle (skip every prompt — see below) with a status-bar indicator while it's on. It also
  keeps a high-water-mark backup of the allow list **and the deny list** at
  `~/.claude/backups/allow-list.latest.json` and offers **Restore prunes from backup**, so an
  org policy that resets `settings.json` (e.g. `allowManagedHooksOnly`) can't permanently lose
  your wildcards — or your safety boundary. Restoring allow without deny would hand back every
  permission with the killswitch still off, so both halves travel together in one atomic write.
  That primary copy lives *inside* `~/.claude`, which covers a `settings.json` rewritten in
  place and not that directory being **recreated** — so the same payload is mirrored off-tree
  to `~/.permission-wildcarding/allow-list.latest.json`, or wherever
  `permissionWildcarding.backupMirrorPath` points (put it on another volume to survive more
  than a reset). The mirror is written second and best-effort, so a bad path can never cost
  you the primary; restore reads the primary first and falls back to the mirror. It is a
  fallback rather than a union on purpose — unioning a stale mirror would hand back the entry
  you deliberately pruned.
  Because it's a VS Code
  extension — not a Claude Code hook — it keeps working even where managed settings disable
  user hooks. It also **lints the Claude Code file-memory index** (`MEMORY.md`): a status-bar
  bloat gauge plus editor diagnostics on over-budget hook lines and broken links (see below).

The hook and VS Code extension install independently. The hook performs live Claude
wildcarding. The extension adds the dashboard and automatic cross-agent history learner; the
same Auto Learn service is also available through the CLI. Both need **Node >= 18**.

## Install the hook

Registers the `PostToolUse` hook in `~/.claude/settings.json`.

```bash
./install.sh        # macOS / Linux / Git Bash
./uninstall.sh      # remove it
```

```powershell
.\install.ps1       # Windows PowerShell
```

Then seed the starter-pack patterns into your allow list if you want its
friction-first legacy defaults (optional; see `patterns/starter-pack.md` for what's included):

```bash
bin/wildcard-perms --seed
```

> **Heads up — the seed intentionally includes broad and destructive roots.**
> Legacy entries such as `Bash(git *)`, `Bash(gh *)`, `Bash(npm *)`, and
> `Bash(docker *)` stay broad, while `Bash(rm *)`, `PowerShell(Remove-Item *)`,
> and `PowerShell(Stop-Process *)` are in the starter pack
> because deleting files and killing processes are routine on a real machine, and your
> `permissions.deny` list still blocks the catastrophic forms (`rm -rf /*`, `mkfs`,
> `dd of=/dev/*`, disk-format). **If you'd rather keep being prompted for those, remove
> their lines** from `patterns/starter-pack.json` before seeding, or delete them from
> `~/.claude/settings.json` afterward (the VS Code dashboard's per-row ✕ removes one in a
> click). See `patterns/starter-pack.md` for the full rationale.

Restart your Claude Code session so the hook takes effect.

## Install the VS Code extension

1. Download `permission-wildcarding-<version>.vsix` from the latest
   [Release](https://github.com/bigfnj/permission-wildcarding/releases).
2. In VS Code, open the **Extensions** view — `Ctrl+Shift+X`.
3. Click the **`···`** (Views and More Actions) menu at the top of that panel.
4. Choose **Install from VSIX…** and select the downloaded file.
5. **Reload** the window if prompted.

The asterisk icon appears in the Activity Bar; click it for the dashboard.

> **Install through the GUI ("Install from VSIX"), not `code --install-extension`
> or a folder copy into `~/.vscode/extensions`.** Those put files on disk but do
> not register the extension into VS Code's active *profile*, so it activates
> without ever showing the Activity Bar icon or its view.

To build a `.vsix` locally instead of downloading one:

```bash
node scripts/package.mjs            # -> permission-wildcarding-<version>.vsix
```

## Project-local approvals (the file that actually fills up)

Claude Code persists an "always approve" into the **project's**
`.claude/settings.local.json`, not the user-scope `settings.json` that every pass above
targets. So the file where approvals actually accumulate was the one nothing generalized.
Measured on one real repo: 167 entries, **68% already covered** by a user-scope wildcard,
and most of the rest multi-statement PowerShell that can never match a second command.

The drain moves them in one direction only — upward:

- Each local entry goes through the same generalization pass the hook uses.
- A **portable** command family (`Bash(<root> *)`, or the dispatcher form
  `Bash(<root> <sub> *)`) is promoted to user scope, where one entry covers every project.
- The local entry is removed **only once the promotion is verified on disk**. Coverage is
  re-read from `settings.json` after the write, never assumed from what this pass intended
  to write, so a failed or policy-filtered promotion can never revoke a grant the project
  already had.
- Everything else stays local: script blobs, absolute-path or quoted executables, `&` call
  forms, shell keywords, and the non-shell families (`Read`/`Edit`/`Write`, MCP tools,
  `WebFetch`). Those are the families Auto Learn keeps review-only, for the same reason — a
  directory rule inferred from observed paths, or an opaque MCP tool, is not something one
  project's approval should grant everywhere.
- A `deny` rule beats a user `allow` entry, so a candidate your deny list matches is
  reported, never promoted.
- **Refused while Claude MAX is on.** Its blanket `Bash(*)` covers every local entry, so a
  drain would empty the file — and MAX-off restores only the user-scope snapshot, so the
  project's own grants would be gone for good.

One redundancy the glob test cannot see is handled too: `Bash(git status)` is *not* matched
by `Bash(git status *)`, which as a glob needs the space and something after it. When the
family is granted and the entry differs from it only by that missing argument list, the entry
is dead weight and goes. That check requires the family to key on the entry's own first
token, which is what keeps an env-prefixed approval (`Bash(PYTHONUTF8=1 python -c ...)`,
whose generalization drops the prefix) from being pruned against a family that would not
match it.

Before pruning anything it snapshots the project's pre-drain list to
`~/.claude/backups/settings.local.<hash>.json` — a high-water union, one file per workspace.

```bash
bin/wildcard-perms --drain --dry-run                # report only, writes nothing
bin/wildcard-perms --drain                          # promote, verify, prune
bin/wildcard-perms --drain --workspace /path/to/repo
```

The hook does it automatically: Claude Code hands `cwd` to `PostToolUse`, which is exactly
the project whose local file just changed. The extension does it on activation, on every
write to a watched `.claude/settings.local.json`, and from the dashboard's
**Project-local approvals** card (promote / redundant / project-only tallies plus a
**Drain into user scope** button). Untrusted workspaces are read-only, and
`permissionWildcarding.localDrain.enabled` turns the automatic pass off while leaving the
button available.

Codex has no counterpart to drain: it does not persist per-project approvals. Its
`prefix_rule` file is authored by Auto Learn, at whichever scope `codexScope` names, and
that choice is not second-guessed here.

## Shell style the agent can wildcard

Everything above acts *after* a prompt: approve once, generalize, never prompt for that
family again. One class of friction escapes it completely. An approval is stored as the
command **string** that was approved, and a compound command — `cd x && dotnet build`, or a
multi-statement PowerShell block — has no single command root to key on, so
`src/permissions.js` deliberately leaves it verbatim rather than shattering a quoted path
into junk. Such an entry can never match a second command. A few hundred of them is what a
full `settings.local.json` actually is.

No generalizer can repair that after the fact, so the fix goes upstream: if the agent writes
one command per call, the approval it produces is a family instead of a string literal. That
is a prompt-side change, so it belongs in the agent's instructions — and the agent cannot
install it itself, because editing its own permission surface is precisely what a permission
classifier stops. So the extension writes it, into every installed agent's user-scope
instruction file — `~/.claude/CLAUDE.md`, and `~/.codex/AGENTS.md` when Codex is present —
as one short marker-fenced block:

- one command per tool call — no `&&` / `;` / `|` chains, no multi-statement PowerShell
- use the tool's own path flag rather than `cd`: `git -C <path> status`,
  `npm --prefix <dir> run build`, `dotnet build <path>`, `tail -n 50 <file>`
- call executables by bare name; a quoted absolute path can never be wildcarded at all
- put multi-step work in a script and run the script — one permission, reusable forever,
  which is the right answer whenever a build or a full verify needs several steps in order
- `VAR=value <cmd>` prefixes are fine; they are stripped before matching

A chain built only from already-allowed commands is fine — Claude Code checks each
sub-command independently. The cost lands when a chain needs a *new* approval.

Codex gets the same block for a different reason, and the block says so: Codex policy is an
argv prefix for the program it actually executes, so a `bash -lc` wrapper around
`cd x && dotnet build` is a `bash` invocation, and a learned `dotnet` prefix never applies to
it. Neither agent's file is created unless that agent is installed — a target counts only if
its config directory already exists, so a Claude-only machine never grows a `~/.codex`. Each
file is backed up under its own name (`CLAUDE.md.pre-guidance`, `AGENTS.md.pre-guidance`)
before it is first changed.

The block is fenced by `<!-- BEGIN/END permission-wildcarding: shell style -->`, so it is
idempotent to refresh, replaced rather than duplicated when a release changes the wording,
and removed byte-for-byte when turned off. It is written on activation while
`permissionWildcarding.guidance.enabled` is on (the default), from the dashboard's
**Shell-style guidance** card, or from the CLI:

```bash
bin/wildcard-perms --guidance status
bin/wildcard-perms --guidance on
bin/wildcard-perms --guidance off
```

## Memory gates: your standing orders, made resident

The block above carries wording that ships in this repo. This one carries **yours**.

Claude Code's file memory has two different things in it. **Reference material** ("which
model crashes", "where that venv lives") only matters once you are already on the subject,
so it is fine on demand. **Standing orders** ("never `git add -A` in a shared checkout",
"0 em dashes in prose") are not, because *you cannot recall a rule you are already
breaking*, because nothing triggers the lookup. And `MEMORY.md` is a list of one-line hooks, so
the enforceable half of a rule sits in a file that only loads if a recall happens to
surface it.

So mark the standing orders and compile them into the instruction file:

```markdown
---
name: my_rule
metadata:
  type: feedback
  scope: global          # global -> ~/.claude/CLAUDE.md; anything else -> that repo
---

<!-- gate -->
- **Writing file content with escapes.** Use Write/Edit, never a heredoc. Verify with `cat -A`.
<!-- /gate -->

**Why:** the long version, for a human. Not compiled.
```

Selection is on `scope`, **not** `type`: a `reference` earns residency exactly when its
failure is silent. The gate text lives in the memory file so the compiler needs no
judgement at runtime. The compression happens once, when you write the memory.

```bash
python memory/recall.py --gates-compile   # -> ~/.claude/gates.generated.md, deterministic + hashed
bin/wildcard-perms --gates status
bin/wildcard-perms --gates on             # install into every installed agent's file
bin/wildcard-perms --gates refresh        # compile then install; silent when unchanged
bin/wildcard-perms --gates off
```

`--gates refresh` is built for a `SessionStart` hook, so an edited gate is live in the next
session with nothing to remember:

```json
"SessionStart": [
  { "hooks": [ { "type": "command",
      "command": "node \"/abs/path/to/bin/wildcard-perms\" --gates refresh" } ] }
]
```

It prints nothing when nothing changed, because a hook's stdout can be folded into session
context. A compile failure is deliberately non-fatal: a hook that errors on every session
start is worse than a slightly stale block, and `--gates status` still reports staleness.

> **Under a managed policy the hook may never fire.** `allowManagedHooksOnly` is enforced
> *per event*: a user hook runs only on an event the managed policy itself defines. On a box
> whose policy defines only `PostToolUse`, a user `SessionStart` entry is dropped silently.
> Measured, with a real session start and a `/clear` both leaving the compiled file
> untouched, while a `PostToolUse` canary fired 4 times out of 4. (`claude -p` runs no hooks
> at all, so it cannot be used to test this.) **The extension does not depend on the hook:**
> it watches the memory dir directly and recompiles on change, which is the better trigger
> anyway and is not something a policy can switch off.

Notes worth knowing:

- **Separate markers** from the shell-style block, with independent switches, so
  `--guidance off` cannot take your gates with it (and vice versa). Both are tested
  byte-for-byte.
- **Nothing compiled means nothing installed.** The installer refuses rather than fencing
  off a heading with no rules under it and reporting success.
- The extension **installs** on activation (a file read) and watches both the compiled file
  and the memory dir itself, recompiling 2 s after a memory changes. That watcher only runs
  once the block is installed, so it never spawns Python for someone who has not opted in.
  A first compile stays an explicit action on the **Memory gates** card.
- `recall.py --lint` reports what is still uncompiled: `scope: global` with no gate block,
  `type: feedback` with no `scope:`, resident entry count, and demotion candidates. It also
  flags **source drift**: a gate block edited but never recompiled, which `--gates status`
  cannot see because it compares the installed block to the compiled file, not to the memory.
- Repo-scoped gates belong in that repo's **gitignored `CLAUDE.local.md`**, so a personal
  judgement call stays out of shared history.

## Memory-index lint

The extension also keeps the Claude Code **file-memory index** honest. `MEMORY.md`
is loaded into every session, so each entry should stay a one-line hook — running
status belongs in the per-fact memory file or the project repo, not the index. This
feature is **pure Node** (no Python, no model, no Claude Code hook), so it ships in the
VSIX and works under a managed policy.

- A **status-bar gauge** (`$(book) mem: 1.9k tok · N to fix`) shows the always-loaded
  token cost and, warning-tinted, how many issues were found. Click it for the full
  report — over-budget lines, links to missing files, and unresolved `[[links]]` — in an
  output channel.
- **Editor diagnostics** squiggle every `MEMORY.md` hook line over the character budget
  and any index link pointing at a file that doesn't exist.
- It auto-discovers every `~/.claude/projects/*/memory/MEMORY.md`, re-lints on save and on
  external edits (so it catches an agent editing the file too), and reconciles on a short
  timer so a store that **moves** — Claude Code derives the project slug from the working
  directory, so renaming a working root relocates the whole store to a new slug — is picked
  up rather than freezing the gauge on a now-deleted path. Tunable via the
  `permissionWildcarding.memory.*` settings (`enabled`, `dir`, `lineBudget`, `totalBudget`).
  Command: `Permission Wildcarding: Lint memory index`.

The semantic-recall side of memory hygiene is [`memory/recall.py`](memory/README.md) — a CPU
(bge-small ONNX) tool. The **script** ships inside the VSIX, so a fresh install can rebuild
the index with no checkout on disk. The **32MB model** does not: a versioned extension dir
would re-download it on every upgrade, so the Memory card fetches it on first use into
`~/.claude/wildcarding/models/` — outside both the extension dir and any checkout, so it
survives upgrades, a deleted clone, and a synced OneDrive folder. An existing copy anywhere
on the usual search path is used as-is rather than re-fetched, and the vocab is seeded beside
it first, because a model without its vocab fails at embed time rather than download time.

No Python runs until you click **Rebuild recall index** (a full `--rebuild`, because you
asked for one). The background sync is incremental instead: it fires only when the cache is
genuinely behind the corpus — compared by name, size and mtime, excluding `MEMORY.md`, which
is the index and is never embedded — and then re-embeds only the files that changed, without
even loading the ONNX session when there is nothing to do.

## Auto Learn: Claude Code + Codex history

Auto Learn incrementally reads Claude Code and Codex history. A requested tool call or
approval alone is never treated as a successful execution.
It reads Claude Code history from `~/.claude/projects/**/*.jsonl` and Codex history from
`~/.codex/sessions/**/*.jsonl`. Each Claude `tool_use` is correlated with its `tool_result`,
and each Codex function call with its `function_call_output`. Confirmed successes add positive
evidence. Confirmed failures are retained as negative evidence and prevent `auto-safe`
eligibility; they never increase the success threshold. Unanswered, incomplete, and pending
calls are ignored until a correlated result arrives. A multi-command Codex `functions.exec`
outer success is not attributed to every nested command when individual outcomes are ambiguous.
For a single nested call, Auto Learn still requires a statically unconditional call shape and
explicit nested exit-code evidence before it records success.

The same rule governs a Claude shell call, because one `tool_result` carries one exit status
however many commands the string contained. An all-`&&` chain proves every link ran and
exited 0. The final segment of a `;`, newline or pipe chain carries the overall status. A
`||` branch proves nothing about either side, and a failure never says which link of a chain
failed. A segment whose outcome cannot be attributed earns no evidence and no family, so
`false` in `git status; false; rg --version` is never recorded as a success. Heredoc and
here-string bodies are masked before a command is split, including bodies nested inside
quotes or a command substitution, so file contents and commit prose never become commands.

Both formats feed one normalized learner, while separate exporters preserve each agent's
policy model. Claude Code permissions are merged into `~/.claude/settings.json` using supported
Bash / PowerShell patterns. Codex receives exact argv-prefix `prefix_rule` entries and literal
unions in its own generated rules file; Claude-style globs are never copied into Codex policy.

### Beyond the shell

Shell commands are only part of what prompts, so the same transcripts also feed three
Claude-only families. **None of them is ever applied automatically at any threshold**, and
none reaches Codex, whose policy is an argv prefix for a program it executes.

| Family | Proposes | Why review only |
| --- | --- | --- |
| MCP tool | `mcp__server__tool`, exactly the tool observed, never a server wildcard | An MCP tool is opaque by construction; nothing can classify what it does |
| Web fetch | `WebFetch(domain:host)` from the observed URL | Network access. The path and query are evidence, not policy, and are never persisted |
| File tool | nothing | A directory rule would have to be inferred from observed paths, guessing wider than the evidence and persisting absolute paths the state never keeps. `Edit`, `Write`, `Read` are counted as one family each, with no path, so you can see the volume |

Because a deny or ask rule beats a user allow entry, and managed policy can supply either,
the review list marks a candidate whose grant the current policy would override.

A family a managed rule overrides *entirely* is withheld from the list, because writing that
rule cannot stop its prompt. Withholding it silently was a defect: the prompts kept arriving
with nothing in Review to explain them, and an allow entry the user had already written looked
like it had simply failed. Review now reports the count and, behind **Show blocked**, names each
family, its observed run count, and the managed rule that outranks it:

```
Bash(<root> *) — 12 successful runs — managed ask: Bash(<root>:*)
```

(Illustrative. As elsewhere in this repository, a real managed policy's rules are an employer's
internal security configuration and are not reproduced here.)

That list is a palette command, **Auto Learn - Show families blocked by managed policy**, so it is
reachable whatever Review is showing. It first hung off the "no candidates" notification, which is
the one moment nobody is being prompted; a busy review list is exactly when you want to know which
prompts cannot be fixed.

**Auto Learn - Why did this prompt?** names the managed rule too. Before, a command whose allow
entry matched was reported as `ALLOW` with a vague pointer at org policy, which is the wrong cause
and implies a fix (write a rule) that cannot work.

The same report lists allow entries already in your `settings.json` that those rules outrank.
They are reported and **never removed**: the managed file is a client-refreshed cache, and
deleting a live grant because a stale copy calls it dead is the worse failure. `--learn status`
carries all of it under `managed`, with per-verdict counts. When the policy file cannot be
parsed the report says so and returns null counts rather than a confident zero, so "could not
check" never reads as "nothing is blocked".

### Which rules actually cost you prompts

Naming a blocked family is not the same as knowing what it costs, and the report used to be able
to name only the command half. `rulePrefix` models command tokens, which only `Bash` and
`PowerShell` have, so every `Read`, `Edit`, `WebFetch` or `mcp__` rule assessed as `unknown` and
went unreported. Measured on one real ~300-entry allow list, that was 30 of 176 permissions, and it
hid the single largest prompt source on the machine: a managed `Edit(**/*.ps1)` glob, on a Windows
box where `.ps1` is application source rather than deploy tooling.

Those now fall through to a whole-string match, the same one `policy-guard.js` always used, plus the
case no regex expresses: a bare `Edit` rule with no specifier governs every Edit call, so it reads
`partial` against a managed glob rather than effective.

Cost needs evidence, and the two halves carry it differently. A shell family has its own run count.
A file tool renders no permission at all, on purpose: inferring a path glob from the paths you
happened to touch would propose a rule wider than the evidence and would mean keeping those paths.
So the scan tests each observed path against managed policy while the path is still in hand and
keeps only the **rule** it matched, which is org policy rather than your data. No path reaches an
observation or the state file, and one test asserts exactly that.

`managed.costliestRules` ranks both halves together, highest cost first:

```bash
bin/wildcard-perms --learn hits      # derive the table from the whole corpus, once
bin/wildcard-perms --learn status    # managed.costliestRules
```

`--learn hits` exists because cursors mean a normal scan on an established machine sees almost
nothing new, so the table would start empty and the number worth acting on would take weeks to
reappear. It reads with empty cursors and discards the ones it produces, so it neither advances nor
rewinds a scan, and it replaces rather than accumulates.

### Derived guidance: the prompt no rule can stop

A managed `ask` outranks every user allow, so for those rules the wildcard this project writes is
inert and the prompt is permanent. What is left is behaviour, and behaviour is what an instruction
file changes. Derived guidance turns a measured cost into the one sentence that reduces it: batch
the edits, batch the fetches, script the multi-step work, read the gated file once.

```bash
bin/wildcard-perms --guidance derived              # what the evidence implies, and why
bin/wildcard-perms --guidance accept <id>          # write that one, in its own marker pair
bin/wildcard-perms --guidance decline <id>         # never offer it again
bin/wildcard-perms --guidance reset <id>           # back to pending
```

Four limits, because this writes into a file you own:

- **Nothing is installed that you did not accept by id.** Deriving is separate from installing.
- **Nothing derives at install time.** The evidence that justifies a permanent line does not exist
  until a corpus has been scanned, so a static paragraph shipped at install is the thing this
  replaces, not the thing it extends.
- **A rule shape with no known mitigation produces nothing, never filler.** Advice that does not
  change what the agent does is pure context cost, and it teaches you to skim the block that
  carries the real rules.
- **A threshold (50 prompts) and a cap (3 items).** An allow entry is paid for once; a line in an
  instruction file is paid for on every session forever, so the bar is far higher than the one a
  single grant has to clear.

Each accepted mitigation lands in its own marker pair, so declining one later removes exactly that
one. The measured count is written into the text on purpose: it is the justification, so when the
cost falls below the threshold the block is swept rather than left asserting a number that has
stopped being true. If the managed policy cannot be read, the decision is recorded and the write is
withheld rather than reconciled against an empty derivation, because a policy this tool cannot read
is not a policy with no rules.

The same review is a palette command, **Derived guidance - review mitigations for prompts no rule
can stop**, which lists each item with its measured count and current state and then asks for one
decision. There is deliberately no "apply all" button: accepting a mitigation writes a standing
instruction into a file you own, and a bulk write leaves every line in it indistinguishable from
every other.

The extension scans at startup, watches both agents' JSONL directories, and reconciles every
five minutes by default (`autoLearn.intervalMinutes`). A watcher-driven scan is debounced so a
burst of transcript writes coalesces into one scan once activity settles — `autoLearn.debounceSeconds`
(default 20s) controls that quiet window. Raise it to scan less often during active work; the
periodic reconcile is the backstop, and because reads are incremental a later scan simply
processes a larger batch, so nothing is lost. Incremental cursors, stable observation IDs, and
deduplication avoid double counting and catch writes missed while VS Code was suspended. The observation index is
capped and trimmed oldest first, so a long-lived install does not grow without limit, and the
dashboard answers from one state read cached against the state file rather than reparsing it.

### The hook is fast now

The `PostToolUse` hook fires after every tool call, and it was spending most of
that time proving nothing had changed. `ruleMatches` rebuilt a RegExp on every
call, and `isCoveredBy` sits inside both quadratic passes of `processAllowList`,
so one pass over a real 317-entry allow list was **192,150 regex compilations**.

The matcher now memoizes the normalized rule and the compiled pattern, keyed on
the rule string. Both are pure functions of that string, so nothing can go
stale, which is the property that earns a cache here; contrast the deliberate
refusal to cache a managed-policy verdict, where the file underneath is a
client-refreshed copy. The maps are capped, because the hook process exits after
one pass while the extension host holds the module for a whole session.

Measured end to end, real process launches with a Claude Code style payload on
stdin, before and after interleaved on the same machine:

```
hook BEFORE (v1.3.0)   min 511.6  p50 548.1  p90 562.5   ms
hook AFTER             min 103.5  p50 109.8  p90 119.1   ms
```

Five times faster per tool call, with output proven byte-identical rather than
assumed. What remains is mostly Node itself: 50 ms of that 110 is bare process
startup. Two smaller wins came with it, `codex-max`/`agent-guidance`/
`agent-gates` moved to lazy requires since the hook path never uses them, and
`drainFromHook` now checks whether the project has a `settings.local.json`
before taking the policy lock rather than after.

Auto Learn and the wildcarding pass are two writers of one `settings.json`, so both take the
same lock at `~/.claude/wildcarding/auto-learn-policy.lock`; the wildcarding pass defers and
retries rather than failing while a scan holds it. **Undo** releases this claimant's grants
through the claims registry instead of restoring the file byte for byte, so an approval that
Claude Code persisted in the meantime does not make Undo unavailable, and a permission another
workspace still claims is never revoked.

### Modes and safety boundary

- **`observe`** — update local evidence only; do not recommend or apply policy.
- **`recommend`** — the default; learn continuously and present candidates for review.
- **`auto-safe`** — automatically apply only deterministic, low-risk, read-only candidates
  after `successThreshold` confirmed successes (default **3**) and only while the candidate has
  zero confirmed failures.

Auto-safe never applies destructive, administrative, credential-related, network-capable,
package-install, arbitrary-wrapper, or ambiguous candidates. These deterministic exclusions
remain in force even if an optional model suggests a friendlier label. Existing Claude
`deny` entries and managed policy continue to win.
Read-only classification alone is not enough: the exported prefix must also be suffix-closed,
meaning later arguments cannot broaden it into file/secret access, remote access, mutation, or
arbitrary execution. Other observed read commands remain available for explicit review.

**Suffix closure is about the pattern, not the observation.** An auto-applied
`Bash(<root> *)` is matched against whole future command strings, and a trailing `*` admits
shell syntax as readily as arguments — `Bash(echo *)` also matches
`echo <anything> > <anywhere>`. A Claude Code allow pattern cannot exclude a redirection, so
the auto-safe list is restricted to roots where **no argument can reach stdout**. That rules
out `echo`, `printf` and the `Write-*` cmdlets (the argument *is* the output), `basename` and
`dirname` (`basename 'text'` echoes its argument back), and `Get-Date` (`-Format "'text'"`
emits literals). It also rules out `git cat-file`, whose `--textconv` runs the diff driver the
repository names. All of them remain review candidates; they are simply never applied without
a human.

One residual is accepted rather than closed: every auto-safe root still permits
`whoami > somefile`, i.e. truncating an arbitrary path with fixed, non-attacker-controlled
content. Keep catastrophic paths in `permissions.deny` — nothing here ever writes that list.

### State, review, and output

Auto Learn persists stable observation hashes, normalized families, source labels, outcome
counts, and hashed cursor locators — not raw transcript arguments, prompt text, or absolute
transcript filenames. State remains under the user's home directory and is partitioned by
workspace:

```text
~/.claude/wildcarding/auto-learn-state.<workspace-hash>.json
```

The non-workspace fallback is `auto-learn-state.json`. Cursor keys use
`path-sha256:<24-hex>` locators, so persisted state does not disclose history paths.

Generated Codex rules default to `~/.codex/rules/permission-wildcarding.rules`. Set
`permissionWildcarding.autoLearn.codexScope` to `workspace` to use the trusted workspace's
`.codex/rules/permission-wildcarding.rules`, or `off` to learn from Codex without writing its
policy. The generated file is dedicated to Auto Learn; `default.rules` is not overwritten.

Use the dashboard or Command Palette to **Scan now**, **Review candidates**,
**Apply safe candidates**, **Undo last application**, or **Why did this prompt?**. The diagnostic
checks Claude user-settings precedence or visible Codex user/trusted-workspace rules. It cannot
see managed/system policy, session approval state, or sandbox restrictions, and labels that
limitation in its result. The CLI equivalents are:

```bash
bin/wildcard-perms --learn scan
bin/wildcard-perms --learn status
bin/wildcard-perms --learn apply
bin/wildcard-perms --learn undo
```

The CLI uses the current directory as its workspace partition and defaults Codex output to
the user rules file. Run it from the same workspace as the extension, or pass
`--workspace <path>`. Use `--codex-scope user|workspace|off`, `--threshold <count>`,
`--mode observe|recommend|auto-safe`, and `--codex-executable <path>` to mirror the
extension settings explicitly.

Apply keeps recoverable snapshots for each policy target. Every Codex policy must pass
`codex execpolicy check` before it is written; a validation failure leaves active rules
unchanged. Claude changes affect Claude's settings output only, and Codex changes affect its
dedicated rules output only. Restart Codex after applying or undoing a Codex rule change because
Codex loads rules at startup.

The Codex behavior follows the official [rules](https://learn.chatgpt.com/docs/agent-configuration/rules)
and [permissions](https://learn.chatgpt.com/docs/permissions) documentation.

### Future local CPU model extension point

The current Auto Learn path is pure Node and does not call an LLM. CPU BGE embeddings for
clustering and local Ollama labels or explanations are possible future advisory extensions,
but neither is wired into Auto Learn today. If added, model output will not override
deterministic parsing, risk classification, or `codex execpolicy check`. The
`memory/recall.py` BGE index described above is a separate memory-search feature and does not
participate in permission learning.

## Skip every prompt

There are two agents and three switches. Each one names the agent it applies to, writes a
different file, and leaves a different floor underneath:

| Switch | Agent | Writes | Floor left underneath |
| --- | --- | --- | --- |
| **Claude MAX** (recommended) | Claude Code | `~/.claude/settings.json` | `permissions.deny` + hard circuit breakers |
| **Codex MAX** | Codex | `~/.codex/config.toml` | the sandbox (`sandbox_mode` is never touched) |
| **Claude bypass** (advanced) | Claude Code | `~/.claude/settings.json` | `permissions.deny` + circuit breakers |

The two MAX switches are siblings, not one setting — different agents, different files,
different floors. The status bar shows both at once (`Claude MAX · Codex prompts`), so an
active "skip everything" is never ambiguous about which agent it covers.

## Claude — MAX mode or bypass mode

Wildcarding whittles the prompts down; these toggles remove them entirely. There are
two mechanisms, because they fail in different ways.

### MAX mode

> **Read this before turning it on.** Measured 2026-09-03 against Claude Code
> 2.1.258: MAX and Claude Code's **auto** mode are mutually exclusive, so the
> toggle moves you to `manual`. Auto mode refuses to load any allow entry that
> would bypass its classifier, which on one real ~300-entry list was 19 of them,
> all interpreter and shell-wrapper grants (`Bash(bash *)`, `Bash(python *)`,
> `PowerShell(cmd *)` and the like). Manual loads all of them. So switching MAX
> on removes the classifier and activates every arbitrary-execution grant in your
> allow list in the same action.
>
> If you run auto mode, that is very likely both **safer and lower friction**
> than MAX, because the classifier approves a large surface no allow list
> enumerates. Check what your own list actually loads first:
> `node scripts/auto-mode-audit.js` (free, sandboxed, writes nothing). MAX still
> earns its place where auto mode is unavailable, or where you want a rule file
> rather than a classifier deciding.

`MAX` skips every prompt using **two independent layers**, and never needs bypass mode
— so it keeps working even where corporate policy blocks Claude Code's own
(`disableBypassPermissionsMode`):

- **Layer 1 — blanket allow-list wildcards.** Injects `Bash(*)`, `PowerShell(*)`,
  `Read(*)`, `Edit`, `Write`, `WebFetch(*)`, `WebSearch`, and a `mcp__<server>__*` for
  every MCP server already in your allow list. This is the normal, sanctioned
  permission path, so it survives an org that disables *user hooks*
  (`allowManagedHooksOnly`). `Bash(*)` matches the whole command string, so compound
  `a && b`, `$(...)`, and subshells all clear too.
- **Layer 2 — a PreToolUse auto-approve hook** (`matcher: "*"`) that returns
  `permissionDecision: "allow"` for every tool call. This covers *all* tools —
  including brand-new MCP servers the allow list can't express — closing Layer 1's only
  gap. Being a user hook, it's the layer an org "managed hooks only" policy would
  disable, which is exactly why Layer 1 is the fallback.

**MAX and Claude Code's `auto` mode are mutually exclusive**, and the toggle handles that
for you. Auto mode routes every decision through Claude Code's classifier, and it discards
any allow entry that would bypass the classifier: load the same `settings.json` under both
modes and auto mode logs `Ignoring dangerous permission Bash(*) … (bypasses classifier)`,
along with every interpreter root (`Bash(bash *)`, `Bash(python *)`, `Bash(node *)`,
`Bash(npx *)`, `Bash(ssh *)`, `Bash(xargs *)`, `Bash(lua *)`, and their `PowerShell(...)`
twins), while default mode loads all of them intact. Layer 1 *is* a blanket wildcard, so in
auto mode it grants nothing — and MAX would still have collapsed your specific entries
underneath it, leaving a shorter list and no blanket to stand in for it. So MAX-on moves
`defaultMode` off `auto`, records what it was, and MAX-off puts it back. A mode you changed
by hand while MAX was on is left alone. Measured against 2.1.238 and 2.1.245; this is a
property of the mode, not of the version.

Turning MAX **on** snapshots your real allow list to `~/.claude/backups/wildcarding-max.json`
and writes the hook to `~/.claude/wildcarding/approve-all.js`; turning it **off** restores
your allow list and removes the hook. Because MAX-on collapses the specific entries under
`Bash(*)`, MAX-off rebuilds the list from that snapshot **unioned with whatever is present
now** — so a permission granted while MAX was on (an Auto Learn application, or one Claude
Code persisted from a real approval) survives the round trip instead of being discarded.

Both toggles take the same policy lock as Auto Learn and the wildcarding pass, so a toggle
cannot land between Auto Learn's settings write and its claims-registry write. If a scan is
mid-flight the toggle reports that and makes no change, rather than retrying silently.

```bash
bin/wildcard-perms --max on       # skip every prompt (both layers)
bin/wildcard-perms --max off      # restore your allow list + remove the approve hook
bin/wildcard-perms --max status   # show state (allow-wildcards / approve-hook)
```

Or click **⚡ Turn MAX ON** in the VS Code dashboard / status bar.

### bypass mode (alternative)

If your environment allows it, Claude Code's own `bypassPermissions` mode is a lighter
one-liner. It flips `permissions.defaultMode` (stashing the prior mode in
`~/.claude/backups/wildcarding-bypass.json` so `off` restores it):

```bash
bin/wildcard-perms --bypass on|off|status
```

The catch: an org can disable it with managed `disableBypassPermissionsMode`, and it's
read only at session start / context rollover (a per-folder UI mode selection can also
override it). MAX mode sidesteps both.

### What still stops you at max

Neither toggle can weaken these — by Claude Code's design, not ours:

- **`permissions.deny`** rules still *block* matching commands (a hook `allow` cannot
  override a deny rule, in any mode). Keep catastrophic forms there
  (e.g. `Bash(rm -rf /*)`, `Bash(mkfs* *)`, `Bash(dd * of=/dev/*)`) — that's your killswitch.
- Claude Code's **hard circuit breakers** — removals targeting `/` or your home dir,
  including command-substitution forms — always fire.

Both toggles take full effect on the next Claude Code **window reload** (the VS Code
toggles offer a one-click reload).

## Codex — MAX mode

Codex friction comes from three independent layers, and only one of them is a permission rule:

1. **`approval_policy`** — when Codex asks before running a command. The dominant lever.
2. **`sandbox_mode`** — `read-only` / `workspace-write` / `danger-full-access`. A permission
   rule cannot lift a sandbox denial.
3. **`rules`** — the `prefix_rule` entries Auto Learn writes. The narrowest of the three.

Codex MAX sets **`approval_policy = "never"`** in `~/.codex/config.toml` and deliberately
leaves `sandbox_mode` alone:

```bash
bin/wildcard-perms --codex-max on       # Codex stops asking
bin/wildcard-perms --codex-max off      # restore the prior policy (or remove the key)
bin/wildcard-perms --codex-max status   # approval_policy + sandbox_mode
```

Or click **⚡ Turn Codex MAX ON** in the dashboard. **Restart Codex** to apply — it reads
config at startup.

> **If your org forbids `approval_policy = "never"`.** A console-managed Codex bundle can cap
> the legal policies (e.g. `allowed_approval_policies = ["on-request", "untrusted"]`). Since
> `never` is the only value that actually skips every prompt, Codex MAX has nothing to set on
> such a machine — the least-friction policy it could write is the org's own default. So the
> dashboard shows Codex MAX **unavailable** and the toggle changes nothing, rather than writing
> that default and reporting it as "on" (a config carrying the org default is never read as MAX
> for the same reason). Codex keeps prompting; set its `untrusted` policy yourself if you want
> fewer prompts within what the org allows.

> **Why not `sandbox_mode = "danger-full-access"` too?** Because Codex has no deny list. Claude
> MAX can skip every prompt and still refuse `rm -rf ~`, since `permissions.deny` and the
> circuit breakers sit underneath it. Codex's only equivalent floor is the sandbox, so removing
> it as well would leave *nothing* able to refuse a command. Keeping `workspace-write` means
> you still get stopped for out-of-workspace writes and network access — which are exactly the
> cases worth being asked about. Set `danger-full-access` yourself if you want it; this toggle
> won't do it behind your back.

The config file is edited **surgically, line by line** — never parsed and re-serialised — so
literal-string Windows paths, inline arrays and nested `[plugins."x@y"]` tables survive
untouched. `off` restores the file byte for byte, including removing the key entirely if you
never had one. A bare key is always written into the top-level table, never appended at
end-of-file where it would land inside the last `[table]` and be silently ignored.

## Design principle: watch the cause, don't hook the event

This whole tool rests on one decision. **The automation lives in a VS Code extension, not in a
Claude Code hook**, and that is what makes it survive a locked-down managed policy.

A `SessionStart` or `PreToolUse` hook is the obvious way to make an agent do something
automatically, and it is exactly what an org policy can take away. `allowManagedHooksOnly` is
enforced **per event**: a user hook runs only on an event the managed policy itself defines. On
a machine whose policy defines only `PostToolUse`, a user `SessionStart` hook is dropped
silently. The entry sits in `settings.json` and never fires. Measured, not assumed: a
`PostToolUse` canary fired on 4 of 4 tool calls, while a real session start and a `/clear` both
left the hook's output untouched. (`claude -p` runs no hooks at all, so it cannot even be used
to test the question.)

The extension is not a hook, so no policy toggle can reach it. That reframes the whole build:

- **Trigger on the cause, not the ceremony.** The thing you actually care about is a file
  changing, so watch that file. Memory gates recompile when a memory in the corpus changes,
  which is better than a session hook on the merits: it is the real cause, it fires once per
  edit instead of once per session, and it needs no session to have started. The `MAX` restore
  watches "approvals stopped being granted" rather than any single policy file, for the same
  reason (see below).
- **Keep a CLI that does the work, and let both the watcher and a hook call it.** `wildcard-perms
  --gates refresh` is one command. The extension's watcher calls it; a `SessionStart` hook calls
  the same command where policy permits one. The behavior does not depend on which fired.
- **Write to instruction files, not to the agent's live state.** A managed policy can stop a hook
  from running but cannot stop the agent from reading `~/.claude/CLAUDE.md`. Anything that must be
  resident every session goes there as a marker-fenced block, which is also how the agent-guidance
  and memory-gates blocks work.
- **Everything ships as pure Node or a bundled CPU script**, with no dependency on a hook being
  allowed to fire, so the same VSIX behaves identically on an unrestricted box and a locked one.

The rule of thumb: if a behavior would normally hang off a hook, ask what filesystem change that
hook was really reacting to, and watch that instead. A hook is a convenience the environment can
revoke; a file is not.

## When managed policy lands

**Org policy does not necessarily arrive as a file.** A console-managed organization
configures restrictions server-side: on such a machine no `managed-settings.json` ever
appears, the only local trace is `~/.claude/policy-limits.json`, and some restrictions leave
no local artefact at all. A guard keyed to the admin-dropped file would watch nothing.

So the trigger is **"approvals stopped being there"** — source-agnostic, and it catches every
cause: a managed refresh, a role change pushed from the console, a bad edit, a reinstall. The
check runs on every `settings.json` change, on any change to the policy files
(`%PROGRAMFILES%\ClaudeCode\managed-settings.json`, `%PROGRAMDATA%\ClaudeCode\managed-settings.json`,
`~/.claude/policy-limits.json`), and once at startup so a change made while VS Code was closed
is still caught. Watcher events are debounced before the check runs: a single Claude Code start
re-saves `policy-limits.json` several times while `settings.json` is being rewritten, and the
conclusion this pass draws is too large to draw mid-burst.

"Missing" means **no longer granted**, not "no longer present verbatim". A backup entry is
still granted if a broader live wildcard covers it — which is the normal state, not damage:
the wildcarding pass generalizes `Bash(git status *)` into `Bash(git *)`, and MAX collapses
every specific entry under `Bash(*)`. The guard uses the wildcarder's own coverage test, so a
covered entry is never counted as lost. Without this, turning MAX on (which collapses the
whole list under `Bash(*)`) reads as losing hundreds of entries and auto-"restores" them on
every change — the churn that makes MAX look like it re-enables itself.

"Missing" also requires having **looked**. A `settings.json` that exists but does not parse is
not a `settings.json` that grants nothing: Claude Code rewrites that file in place on every
`/model`, `/effort` and approval, so a watcher event lands inside a write often enough to
matter, and the zero-byte window of a truncate-then-write parses as no permissions at all.
Unknown is reported as unknown — the guard says nothing, writes nothing, and looks again on the
next event. A file that is genuinely **absent** is a different case and still restores, because
then there is nothing to lose. The same distinction guards every write: rebasing onto a fallback
snapshot when the real file cannot be parsed is how a recovery feature would emit a
`settings.json` holding nothing but `permissions`, taking `model`, `env` and `hooks` with it.

Only a **bulk** loss is repaired without asking — losing most of the list is damage, whereas
pruning one entry with the ✕ button is an instruction. The prune drops that entry from the
backup too, so a deliberate removal is never resurrected. A small unexplained loss prompts
with **Re-assert them** or **Forget them** instead of acting on its own — so entries you
removed by editing `settings.json` directly (which the ✕ button can't catch) can be dropped
from the backup for good rather than nagging on every policy change.

Two different things happen to accumulated approvals then, and only one is recoverable:

- **Missing** — the refresh reset `settings.json`. The backup has them, so they are
  **re-asserted automatically**. If nothing was lost, nothing is written — a policy that keeps
  rewriting the same file never turns this into a loop.
- **Shadowed** — managed `deny`/`ask` rules outrank a user `allow` entry. Nothing user-side
  beats that; it's Claude Code's precedence, by design. These are **reported, never rewritten**,
  with the exact managed rule responsible, so you can see which approvals went back to
  prompting and why.

It also flags when `allowManagedHooksOnly` makes MAX's approve hook inert — the allow-wildcard
layer keeps working, which is the whole reason MAX has two layers.

## Releasing

Cutting a GitHub Release builds and attaches the `.vsix` automatically via
[`.github/workflows/release.yml`](.github/workflows/release.yml). The version is
taken from the release tag, so you don't hand-edit `package.json`:

```bash
gh release create v1.2.3 --generate-notes
# -> workflow packages permission-wildcarding-1.2.3.vsix and attaches it to the release
```

Before tagging, run the tests and the memory-index lint. The lint also fails on gate
source drift, so a release cannot ship with the resident block behind its source memories:

```bash
node --test test/*.test.js          # all pass
python memory/recall.py --lint      # index clean, gates not stale vs source
```

## Note

The live `PostToolUse` hook generalizes the permissions an *"always / don't ask again"*
approval persists — in `~/.claude/settings.json`, and in the project's
`.claude/settings.local.json`, which is where Claude Code puts them now. Auto Learn is the
history-aware path: it can learn from confirmed successful one-time executions while retaining
failures as negative evidence and ignoring unanswered calls. The guidance block is the
prompt-side path: it stops un-generalizable approvals from being created at all.

Requires Node >= 18. MIT licensed.
