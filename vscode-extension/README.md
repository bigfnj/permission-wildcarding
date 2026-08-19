# Permission Wildcarding (VS Code extension)

Watches `~/.claude/settings.json` and live-generalizes approved Claude Code
permissions to depth-aware wildcards. Adds an Activity Bar dashboard: an
"Active" status card, live tallies (approved / wildcards / specific), a
**Wildcard Now** button, and a collapsible list of tracked wildcards, each with
a one-click prune.

On every write it also saves a high-water-mark backup of the allow list **and the
deny list** to `~/.claude/backups/allow-list.latest.json`, so a managed-settings
refresh that resets `settings.json` can't lose your accumulated wildcards or your
safety boundary. Recover both with **Restore prunes from backup** (dashboard
button, title-bar `history` icon, or the `Permission Wildcarding: Restore prunes from
backup` command).

deny is restored alongside allow deliberately: every other feature here ends its
safety argument at "deny still wins", so bringing permissions back without the
rules that bound them would be worse than not restoring at all. Both halves land
in a single atomic write, and an older allow-only backup file is still read and
upgraded in place.

## Review noise

The Auto Learn review list hides candidates an existing allow rule already
covers — proposing `Bash(rg --files *)` when `Bash(rg *)` is already granted
changes no prompt, and the wildcarding pass prunes the entry on its next run
anyway. The count is shown in the picker title so nothing disappears silently.
Only your user settings are visible to that check, so it can hide redundancy but
never risk; deny- and ask-governed families still reach review, labelled with the
rule that overrides them.

The confirmation step before applying is driven by **risk and policy override**,
not by auto-safe eligibility. `autoSafe` answers "may a machine apply this
unattended" — the wrong question for someone who has just ticked rows in a
picker, and since auto-safe narrowed to suffix-closed roots nothing in the review
list is ever auto-safe, so that prompt fired on every selection and could not be
avoided. An unavoidable confirmation is a click-through, not a gate. Now a plain
read-only grant applies without a prompt, and anything else is confirmed with the
specific entries named — what the grant can do, and whether policy overrides it
anyway.

## Cross-agent Auto Learn

Auto Learn incrementally scans local Claude Code history
(`~/.claude/projects/**/*.jsonl`) and Codex history (`~/.codex/sessions/**/*.jsonl`). It
correlates each requested tool call with its matching result. Confirmed successes add positive
evidence. Confirmed failures are retained as negative evidence and block `auto-safe`
eligibility; they do not increase the success threshold. Unanswered, incomplete, and pending
calls are ignored until a result arrives. Ambiguous outer success from a multi-command Codex
`functions.exec` is not assigned to every nested command.
Even a single nested call needs a statically unconditional call shape and explicit nested
exit-code evidence before it is counted as successful.

Both adapters feed one normalized learner, while separate exporters preserve each agent's
policy model. Claude Code receives supported Bash / PowerShell patterns merged into
`~/.claude/settings.json`; Codex receives exact argv-prefix `prefix_rule` entries and literal
unions in a dedicated rules file. Claude-style globs are not copied into Codex rules.

One `tool_result` carries one exit status however many commands the string held, so an outcome
is credited only where it is provable: every link of an all-`&&` chain, or the final segment of
a `;`, newline or pipe chain. A `||` branch and an ambiguous failure credit nothing. Heredoc
and here-string bodies are masked before splitting, so file contents and commit prose never
become commands.

Beyond the shell, the same transcripts feed three Claude-only families that are **never applied
automatically**: an MCP call proposes the exact `mcp__server__tool` observed and never a server
wildcard; a web fetch proposes `WebFetch(domain:host)` from the observed URL; and file tools are
counted per tool with no path and no inferred rule at all. The review list also marks a
candidate that the current deny or ask policy would override.

The extension scans at startup, watches both agents' JSONL history, and reconciles every five
minutes by default. Incremental reconciliation, stable observation IDs, and deduplication
prevent gaps and double counting. Workspace-partitioned state stays under the user profile at
`~/.claude/wildcarding/auto-learn-state.<workspace-hash>.json` (or
`auto-learn-state.json` without a workspace). It contains normalized families, source labels,
outcome counts, stable hashes, and `path-sha256:<24-hex>` cursor locators — never raw command
arguments, transcript text, prompts, or absolute transcript filenames.

### Modes and safety

- **`observe`** — collect evidence only; do not recommend or apply policy.
- **`recommend`** — the default; show learned candidates for explicit review.
- **`auto-safe`** — automatically apply only deterministic, low-risk, read-only candidates
  after `permissionWildcarding.autoLearn.successThreshold` confirmed successes (default **3**) and
  only while the candidate has zero confirmed failures.

Auto-safe excludes destructive, administrative, credential-related, network-capable,
package-install, arbitrary-wrapper, and ambiguous candidates. They may appear in review, but
are never automatically applied. Claude `deny` entries and managed policy continue to win.
Read-only classification alone is insufficient: an automatically exported prefix must remain
safe for every later argument it authorizes. File/secret readers, remote-capable prefixes, and
other broad read families therefore stay review-only.

Suffix closure is judged on the pattern, not the observation. An auto-applied
`Bash(<root> *)` is matched against whole future command strings, and a trailing `*` admits
shell syntax as readily as arguments — `Bash(echo *)` also matches `echo <anything> >
<anywhere>`, and no allow pattern can exclude a redirection. Auto-safe is therefore limited to
roots where no argument can reach stdout, which excludes `echo`, `printf`, the `Write-*`
cmdlets, `basename`, `dirname`, `Get-Date`, and `git cat-file` (its `--textconv` runs the diff
driver the repository names). All stay available for review. One residual is accepted: an
auto-safe root can still truncate an arbitrary path with fixed content (`whoami > somefile`),
so catastrophic paths belong in `permissions.deny` — which this extension never writes.

### Review and policy output

The dashboard and Command Palette provide **Scan now**, **Review candidates**,
**Apply safe candidates**, **Undo last application**, **Cycle mode**, and
**Why did this prompt?** Apply keeps a recoverable snapshot; Undo restores the most recent
Auto Learn application. The repository CLI uses the same service:

```bash
bin/wildcard-perms --learn scan
bin/wildcard-perms --learn status
bin/wildcard-perms --learn apply
bin/wildcard-perms --learn undo
```

The CLI uses its current directory as the workspace partition and user Codex rules by
default. Run it from the same workspace as VS Code, or pass `--workspace <path>` plus
`--codex-scope user|workspace|off`, `--threshold <count>`, `--mode`, and
`--codex-executable` to mirror the extension settings.

Codex rules default to `~/.codex/rules/permission-wildcarding.rules`. The
`permissionWildcarding.autoLearn.codexScope` setting can target the trusted workspace's
`.codex/rules/permission-wildcarding.rules`, or be `off` to learn without exporting Codex policy.
Auto Learn never overwrites `default.rules`. Every generated rule must pass
`codex execpolicy check` before a write; validation failure leaves active rules unchanged.
Claude and Codex applications use separate snapshots and output targets. Restart Codex after
applying or undoing Codex rules because it loads them at startup.

**Why did this prompt?** evaluates Claude user-settings precedence or runs `codex execpolicy
check` against visible user and trusted-workspace rules. Its result explicitly notes that
managed/system policy, session approval state, and sandbox restrictions are outside that view.
See the official Codex [rules](https://learn.chatgpt.com/docs/agent-configuration/rules) and
[permissions](https://learn.chatgpt.com/docs/permissions) documentation.

Other settings are `permissionWildcarding.autoLearn.enabled`,
`permissionWildcarding.autoLearn.intervalMinutes` (default **5**), and
`permissionWildcarding.autoLearn.codexExecutable` (default `codex`).

### Future local CPU assistance

Auto Learn is currently pure Node and does not call a model. CPU BGE embeddings for clustering
and local Ollama labels or explanations are future advisory extension points; neither is wired
into Auto Learn today. If added, they will not override deterministic parsing, risk
classification, or `codex execpolicy check`. The separate Memory card can rebuild the
standalone `memory/recall.py` BGE index; that index does not participate in Auto Learn.

## Memory-index lint

The extension also keeps the Claude Code **file-memory index** honest. `MEMORY.md`
is loaded into every session, so each entry should stay a one-line hook (running
status belongs in the per-fact memory file or the project repo). This feature is
pure Node — no Python, no model, no Claude Code hook — so it ships in the VSIX and
works under a managed policy.

- A **status-bar gauge** (`$(book) mem: 1.9k tok · N to fix`) shows the always-loaded
  token cost and, warning-tinted, how many issues it found. Click it for the full
  report (an output channel: over-budget lines, broken links, unresolved `[[links]]`).
- **Editor diagnostics** squiggle each `MEMORY.md` hook line over the budget and any
  index link pointing at a missing file.
- It auto-discovers every `~/.claude/projects/*/memory/MEMORY.md`, updates on save and
  on external edits, and can be pinned or tuned via the `permissionWildcarding.memory.*`
  settings (`enabled`, `dir`, `lineBudget`, `totalBudget`). Command:
  `Permission Wildcarding: Lint memory index`.

The semantic-recall side of memory hygiene (`memory/recall.py`) is a separate CPU
tool in this repo, deliberately not bundled into the extension.

## Memory card (dashboard)

The dashboard also carries a **Memory card** that surfaces what the lint gauge
doesn't — the state of the CPU recall model and the vector cache — all by passive
filesystem probe, so no Python runs until you ask for it:

- **CPU LLM** status: `ready` when both `bge-small.onnx` and the DevToolbox venv
  (which carries `onnxruntime`) are present, otherwise it names what's missing.
- **Stats**: tokens loaded per session (red past the byte budget), memory-file count,
  and how many memories are in the recall vector cache (read straight from
  `recall_index.json`).
- An **issues line** (`N over budget · N broken links`) that links to the full lint
  report; or `✓ index clean` when there's nothing to fix.
- **⟳ Rebuild recall index** — the one button, and the only place Python is spawned.
  It runs `recall.py --rebuild` in the DevToolbox venv to force a full CPU re-embed
  (model + corpus pinned via env so the cache matches the card). The card also
  triggers a silent background rebuild automatically — on startup and whenever
  `MEMORY.md` changes — when the embedded count lags behind the memory file count.
  A 15-minute cooldown prevents back-to-back rebuilds. A status-bar message
  confirms each auto-rebuild; any failure is logged to the extension host console
  without a notification.

Set `permissionWildcarding.memory.recallScript` to your repo's `memory/recall.py` if you
run the installed VSIX (the dev/source layout auto-detects it). The status probe works
regardless; only the rebuild button needs the path.

## Install

Download the `.vsix` from the repository's
[Releases](https://github.com/bigfnj/permission-wildcarding/releases), then in
VS Code: **Extensions view (`Ctrl+Shift+X`) → `···` menu → Install from VSIX…**
and pick the file. Installing via the GUI registers the extension into the
active profile (a plain `code --install-extension` or folder copy does not, and
the Activity Bar icon will not appear).

The `PostToolUse` hook (the non-GUI half of this tool) is installed separately
from the repository root — see `install.sh` / `install.ps1`.

MIT licensed.

## Skip every prompt — two agents, two switches

Each switch names the agent it applies to, writes a different file, and leaves a
different floor underneath. They are siblings, not one setting.

| Switch | Agent | Writes | Floor left underneath |
| --- | --- | --- | --- |
| **Claude MAX** (recommended) | Claude Code | `~/.claude/settings.json` | `permissions.deny` + circuit breakers |
| **Codex MAX** | Codex | `~/.codex/config.toml` | the sandbox (`sandbox_mode` untouched) |

The status bar shows both agents at once (`Claude MAX · Codex prompts`), so an
active "skip everything" is never ambiguous about what it covers.

**Codex MAX** targets `approval_policy = "never"` and deliberately leaves
`sandbox_mode` alone. Codex has no deny list, so the sandbox is its only floor —
removing it too would leave nothing able to refuse a command. You still get
stopped for out-of-workspace writes and network access, which are the cases worth
being asked about. On a console-managed org an `allowed_approval_policies` cap
may prevent `never`; the switch settles for the least-friction value the policy
allows and reports what it set. Restart Codex to apply; it reads config at startup.

`config.toml` is edited surgically, line by line, so literal-string paths, inline
arrays and nested `[plugins."x@y"]` tables survive. Turning it off restores the
file byte for byte.

## When managed policy lands

Org policy does not necessarily arrive as a file. A console-managed org
configures restrictions server-side, where the only local trace is
`~/.claude/policy-limits.json` — sometimes nothing at all — so a guard keyed to
an admin-dropped `managed-settings.json` would watch nothing. The trigger is
therefore "approvals stopped being there": checked on every settings change, on
any policy-file change, and once at startup.

Only a bulk loss is repaired without asking; a small one prompts with a one-click
re-assert. The ✕ prune drops its entry from the backup, so a deliberate removal
is never resurrected. Approvals are affected two ways, and only one is recoverable:

- **Missing** — the refresh reset `settings.json`. Re-asserted automatically from
  the backup. If nothing was lost, nothing is written, so a policy that keeps
  rewriting the file never becomes a write loop.
- **Shadowed** — managed `deny`/`ask` outranks a user `allow` entry, by Claude
  Code's precedence. Reported with the exact managed rule responsible, never
  rewritten, because rewriting cannot win.

It also flags when `allowManagedHooksOnly` makes MAX's approve hook inert — the
allow-wildcard layer keeps working, which is why MAX has two layers.

## Why did this prompt?

The diagnostic reads org policy, not just your user settings. On a console-managed
org there is no `managed-settings.json` to check, so "check managed policy" was
useless advice and an unqualified **ALLOW** was the wrong answer to give someone
whose org was prompting them.

- **Claude** — the verdict is reported as your user settings only, followed by the
  server-delivered restrictions found in `~/.claude/policy-limits.json`, named
  individually. Precedence is stated as managed/org > deny > ask > allow > default.
- **Codex** — the signed enterprise bundle
  (`~/.codex/cloud-config-bundle-cache.json`) is checked **first**, because its
  `[[rules.prefix_rules]]` outrank anything Auto Learn can write. If a rule governs
  the command root, the diagnostic names the rule and its justification and says
  plainly that a user rule cannot override it. It also reports an
  `allowed_approval_policies` cap when one applies.

## Auto Learn card

Four buttons: **Scan now**, **Review (N)**, **Undo**, **Why prompt?**

**Review** shows a live count of candidates the picker will actually offer —
candidates an existing allow rule already covers are excluded from the count, since
approving them changes no prompt. **Wildcard Now (N)** in the title bar shows how
many allow entries the wildcarding pass would change; it reads 0 when your policy
is already fully generalized.

**Apply safe** and **Cycle mode** were dropped from the card and remain in the
Command Palette. Apply safe is a no-op wherever nothing is auto-safe — which, once
auto-safe narrowed to suffix-closed roots, is most real machines — and Cycle mode
cycles between one useful mode and two that do nothing there.
