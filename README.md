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
  `--learn scan|status|apply|undo`, `--seed`, `--max on|off|status` (MAX mode), and
  `--bypass on|off|status` (see below).
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
- **`patterns/starter-pack.json`** / **`patterns/starter-pack.md`** — a curated
  seed of common, safe wildcard patterns (documented in the `.md`).
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
  external edits (so it catches an agent editing the file too), and is tunable via the
  `permissionWildcarding.memory.*` settings (`enabled`, `dir`, `lineBudget`, `totalBudget`).
  Command: `Permission Wildcarding: Lint memory index`.

The semantic-recall side of memory hygiene lives in this repo at
[`memory/recall.py`](memory/README.md) — a CPU (bge-small ONNX) tool, deliberately kept as
a standalone script rather than bundled into the extension.

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

The extension scans at startup, watches both agents' JSONL directories, and reconciles every
five minutes by default (`autoLearn.intervalMinutes`). A watcher-driven scan is debounced so a
burst of transcript writes coalesces into one scan once activity settles — `autoLearn.debounceSeconds`
(default 20s) controls that quiet window. Raise it to scan less often during active work; the
periodic reconcile is the backstop, and because reads are incremental a later scan simply
processes a larger batch, so nothing is lost. Incremental cursors, stable observation IDs, and
deduplication avoid double counting and catch writes missed while VS Code was suspended. The observation index is
capped and trimmed oldest first, so a long-lived install does not grow without limit, and the
dashboard answers from one state read cached against the state file rather than reparsing it.

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
deterministic parsing, risk classification, or `codex execpolicy check`. The standalone
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

## Claude — MAX mode (recommended) or bypass mode

Wildcarding whittles the prompts down; these toggles remove them entirely. There are
two mechanisms, because they fail in different ways.

### MAX mode (recommended)

`MAX` skips every prompt using **two independent layers**, and never touches
`defaultMode` — so it keeps working even where corporate policy blocks Claude Code's
own bypass mode (`disableBypassPermissionsMode`):

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

## When managed policy lands

**Org policy does not necessarily arrive as a file.** A console-managed organization
configures restrictions server-side: on such a machine no `managed-settings.json` ever
appears, the only local trace is `~/.claude/policy-limits.json`, and some restrictions leave
no local artefact at all. A guard keyed to the admin-dropped file would watch nothing.

So the trigger is **"approvals stopped being there"** — source-agnostic, and it catches every
cause: a managed refresh, a role change pushed from the console, a bad edit, a reinstall. The
check runs on every `settings.json` change, on any change to the policy files
(`%PROGRAMDATA%\ClaudeCode\managed-settings.json`, `~/.claude/policy-limits.json`), and once
at startup so a change made while VS Code was closed is still caught.

"Missing" means **no longer granted**, not "no longer present verbatim". A backup entry is
still granted if a broader live wildcard covers it — which is the normal state, not damage:
the wildcarding pass generalizes `Bash(git status *)` into `Bash(git *)`, and MAX collapses
every specific entry under `Bash(*)`. The guard uses the wildcarder's own coverage test, so a
covered entry is never counted as lost. Without this, turning MAX on (which collapses the
whole list under `Bash(*)`) reads as losing hundreds of entries and auto-"restores" them on
every change — the churn that makes MAX look like it re-enables itself.

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
gh release create v1.2.0 --generate-notes
# -> workflow packages permission-wildcarding-1.2.0.vsix and attaches it to the release
```

## Note

The live `PostToolUse` hook only generalizes permissions persisted to
`~/.claude/settings.json` (approved with *"always / don't ask again"*). Auto Learn is the
history-aware path: it can learn from confirmed successful one-time executions while retaining
failures as negative evidence and ignoring unanswered calls.

Requires Node >= 18. MIT licensed.
