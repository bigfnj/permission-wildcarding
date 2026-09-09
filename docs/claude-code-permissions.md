# Claude Code permission semantics

Reference for how Claude Code actually matches permission rules, why some of the
rules this tool writes cannot reduce friction, and which friction levers exist
that are not bypass mode.

Every claim below is tagged:

- **[docs]** stated in the official documentation, with the page cited
- **[measured]** observed on a real machine, with the command that showed it
- **[inferred]** a reading that follows from the above but is not stated outright

Sources: `code.claude.com/docs/en/permissions.md`,
`.../permission-modes.md`, `.../hooks-guide.md`, `.../auto-mode-config.md`.
Read against docs current on 2026-09-02.

---

## 1. Rule syntax

A rule is `Tool(specifier)`. All of these are supported **[docs: permissions]**:

| Form | Example | Matches |
|---|---|---|
| exact | `Bash(npm run build)` | only that command, no arguments after |
| trailing star, space | `Bash(npm run *)` | `npm run` plus any arguments |
| trailing star, colon | `Bash(npm run:*)` | equivalent to the space form |
| bare tool | `Bash` or `Bash(*)` | every Bash command |

A `*` in a Bash rule matches any text **including spaces** **[docs]**. The
matcher is positional glob, not regex.

### The bare-command rule, which is easy to get wrong

> "A `*` at the end, with a space before it, also matches the bare command.
> `Bash(ls *)` matches `ls`, and `Bash(git log *)` matches `git log`. That holds
> only when the trailing `*` is the rule's only wildcard." **[docs: permissions]**

So `Bash(pwd *)` covers a bare `pwd`, and the space-star form this tool emits is
correct. The qualifier matters: the bare-command allowance holds **only when the
trailing star is the rule's only wildcard**, so an entry carrying a second `*`
(a glob inside an argument, which `generalizePermission` preserves) does not
cover the argument-less invocation.

Wildcards before a subcommand, like `Bash(git * main)`, produce a startup
warning **[docs]**. Put the star after the subcommand.

### How this project implements it

`src/permission-match.js` is the single implementation, used by both
`isCoveredBy` in `src/permissions.js` and `permissionMatches` in
`vscode-extension/autoLearnUi.js`. Before it existed those were two regexes
that modelled neither the `:*` suffix nor the bare-command rule, and reported:

```
Bash(pwd)           vs rule Bash(pwd *)      -> no match   (docs say it matches)
Bash(docker exec *) vs rule Bash(docker:*)   -> no match   (docs say it matches)
```

Both errors ran in the "more work than there is" direction: the Review list kept
candidates an existing rule already covered, and the dashboard could not read a
managed policy at all, since managed rules use the colon spelling exclusively.

Both new behaviours are scoped to `Bash` and `PowerShell`. Other tools have
their own specifier grammar, a `Read(**/x)` path glob or a `Skill(name:args)`
where the colon is a field separator, and applying command semantics there would
be an inference whose cost is pruning a rule someone still needs.

---

## 2. Compound commands

Claude Code is aware of shell operators. A rule must match **each subcommand
independently** **[docs: permissions]**. Recognised separators: `&&`, `||`, `;`,
`|`, `|&`, `&`, and newlines.

So `cd "/path" && ffprobe x` needs both `Bash(cd *)` and `Bash(ffprobe *)`, and
one root wildcard per command is enough. You never need a pattern spanning `&&`.

Two consequences worth remembering:

- Approving a compound with "don't ask again" saves a **separate rule per
  subcommand**, not one rule for the whole string **[docs]**.
- A dangling operator (`npm test &&` with nothing after) is treated as
  unparseable and is **not** split, so `Bash(npm *)` will not approve it
  **[docs]**.

This is why dropping `compound-command` from `COMPLEX_REASONS` was correct: a
chain link is an independently matched command, so learning a family from one is
exactly right.

---

## 3. Wrappers

Stripped, so a rule matches through them **[docs: permissions]**:

```
timeout 30 npm test          matches Bash(npm test *)
NODE_ENV=test npm test       matches Bash(npm test *)
command npm test  /  builtin npm test
```

`deriveBaseInvocation` strips the same set, so the family learned from
`timeout 30 git status` is `git status` rather than `timeout`. Learning the
wrapper would have proposed `Bash(timeout *)`, a grant for every command
`timeout` can run. An unrecognised shape is left alone: `timeout npm test` with
no duration, or a duration with no command, strips nothing.

An env prefix is the same case, and it used to null the permission outright. It
no longer does, because the matcher strips it too: `Bash(cat *)` already covers
`LD_PRELOAD=x cat f`, so refusing to propose the rule denied the grant without
denying the injection. The reason is retained and still bars the automatic path
through `isAutoSafeCandidate` and `AUTO_UNSAFE_REASONS`, so evidence carrying an
injection vector can only reach policy through an explicit review.

**Not** stripped: `bash -c`, `python -c`, `npx`, `docker exec`, `devbox run`,
`direnv exec`, `mise exec`. To approve work inside a runner you must name both,
as in `Bash(devbox run npm test)` **[docs]**.

`watch`, `setsid`, `ionice` and `flock` with `-exec` or `-delete` always prompt
and need exact-match rules **[docs]**.

### Why the blanket wrapper grants in the starter pack matter

Because a wrapper is not stripped, a rule naming the wrapper covers everything
it runs, and a deny rule naming the inner command does not apply. The docs do
not state outright whether deny inspects a quoted payload; the safe reading is
that deny matches the outer command only **[inferred]**. Measured against a real
allow list containing `Bash(bash *)`, `Bash(python *)` and `PowerShell(& *)`:

```
DENY   Bash(rm -rf ~)                              deny: Bash(rm -rf ~)
ALLOW  Bash(bash -c "rm -rf ~")                    allow: Bash(bash *)    deny: (none)
ALLOW  Bash(python -c "...rmtree(expanduser(~))")  allow: Bash(python *)  deny: (none)
```

**[measured]** The learner refuses to propose these shapes for exactly this
reason. `patterns/starter-pack.json` seeds 13 of them anyway. See
`patterns/starter-pack.md` for the removal note.

---

## 4. Redirections and the suffix-closure gate

> A rule such as `Bash(git commit *)` allows the command but not the target of
> an output redirection like `> out.txt`. The redirection target is checked as a
> file write. A `/dev/null` target is not checked. **[docs: permissions]**

**This contradicts the premise of `AUTO_SUFFIX_CLOSED_ROOTS`.** That gate exists
in both `src/auto-learn.js` and `src/policy-exporters.js` on the stated reasoning
that an auto-applied `Bash(<root> *)` also matches `<root> ... > <path>` because
"redirection is shell syntax rather than an argument and no Claude Code allow
pattern can exclude it". If the redirection target is separately checked as a
file write, that reasoning does not hold, and the gate is costing auto-safe
promotions for no security benefit.

### Result: measured, and the gate stays

**[measured 2026-09-03, Claude Code 2.1.258]** Five probes, `Bash(echo *)` in
allow, target `<workspace>\redirect-probe.tmp`:

| # | run | tool denial | target | outcome |
|---|---|---|---|---|
| A | `-p` manual | Write, Edit | absolute, forward slashes | blocked |
| B | `-p` manual | Write, Edit | absolute, backslashes | blocked |
| C | `-p` manual | none | absolute, backslashes | blocked |
| D | `-p` manual | none | relative, resolved into the session cwd | blocked |
| E | interactive manual | none | same as D | **succeeded, no prompt, file written** |

The refusal text in A through D:

```
Output redirection to '<workspace>/redirect-probe.tmp' was blocked. For security,
Claude Code may only write to files in the allowed working directories for this
session: '<workspace>'.
```

Two conclusions, and they point opposite ways.

The redirect target **is** intercepted independently of the command rule. `echo`
alone runs, `echo … > file` is a separate decision, and C and D show that holds
with no tool denial in play. So the old rationale, that no allow pattern can
exclude a redirection, was wrong.

The gate survives anyway. In probe E the identical redirect succeeded silently
and wrote the file, because a tool-wide `Write` grant satisfies the check, and
`patterns/starter-pack.json` seeds exactly that grant. So with `Write` allowed,
an auto-applied `Bash(echo *)` really does write arbitrary content to an
arbitrary path. What the guard changes is blast radius: the session's working
directories rather than anywhere on disk. `AUTO_SUFFIX_CLOSED_ROOTS` was left in
place and its comment corrected.

Loose end, not acted on: A through D refused a path the refusal itself lists as
allowed, and no redirect could be made to succeed non-interactively. That reads
as `-p` failing closed because it cannot prompt, with a message that names the
wrong reason.

Related **[docs]**: read-only commands carrying write-capable or exec-capable
flags, such as `find -delete` or `sort -o`, still prompt in Manual mode.

---

## 5. Precedence

Rules evaluate **deny, then ask, then allow**, and the first match in that order
wins. Rule specificity does not change the order **[docs: permissions]**.

Settings layer with **managed settings highest**, and a deny at any level cannot
be overridden by an allow at another **[docs: settings precedence]**. Scalars are
overridden by the higher layer; `permissions.allow` / `ask` / `deny` arrays merge
across layers **[measured]**.

The operational consequence for this tool: **a managed `ask` entry beats
anything written into user `permissions.allow`.** A grant for such a family is
inert, and no amount of wildcarding changes that.

---

## 6. What this means on an enterprise-managed machine

Measured against a real server-pushed managed policy, cached by Claude Code at
`~/.claude/remote-settings.json` **[measured 2026-09-02]**. The specific rules
are an employer's internal security configuration and are deliberately not
reproduced here; what generalises is the shape, which is what the tool has to
cope with.

The shape, in that sample:

- a few dozen managed `allow` prefixes, covering coreutils and the common test,
  build and lint tools
- a few dozen managed `ask` prefixes, covering version-control publication,
  container and cloud CLIs, infrastructure apply and destroy, network fetch
  tools, and package installers generally
- a managed `deny` list, all of it file-path and web-fetch globs rather than
  command rules
- every managed command rule scoped to `Bash`, **none to PowerShell**
- `defaultMode` pinned, bypass mode disabled, and user hooks restricted to the
  events the policy itself defines

Cross-referencing the learned families carrying a permission against it, out of
roughly 150:

| verdict | families | observed runs |
|---|---|---|
| overridden outright by a managed ask, so the grant is inert | 3 | ~36 |
| partially overridden | 1 | ~4 |
| redundant with a managed allow | 16 | ~3,600 |

The inert ones were a network fetch tool and two version-control publication
subcommands: exactly the categories an enterprise policy asks about.

Two lessons that outrank the rest:

1. **The redundant column dwarfs the useful one for Bash.** `Bash(head *)` at
   1629 runs, `tail` at 699, `grep` at 384, `echo` at 321 are all already
   allowed by managed policy, and most are in Claude Code's built-in read-only
   set as well (`ls`, `cat`, `echo`, `pwd`, `head`, `tail`, `grep`, `find`,
   `wc`, `which`, `diff`, `stat`, `du`, `cd`, read-only `git`) **[docs]**. Those
   grants never prevented a prompt.
2. **PowerShell is where user settings are sovereign.** The managed policy has
   zero PowerShell rules, so every PowerShell family this tool learns is a real
   grant. When measuring value, weight the PowerShell half.

Also: where `allowManagedHooksOnly` is set and `PreToolUse` is not among the
events the policy itself defines, **a user `PreToolUse` hook is silently
dropped**. That disables the
project's own MAX-mode approve-all hook on such a machine, and it disables the
most powerful non-bypass lever in the next section.

`src/managed-policy.js` reads this file so the tool can act on it:
`assessPermission` labels a permission `inert` when a managed ask or deny covers
every command it would match, `partial` when the grant is broader than such a
rule, `redundant` when a managed allow already covers it, and `effective`
otherwise. An `inert` family is withheld from the Claude review list, because
writing that rule cannot stop the prompt. `hookEventAllowed` answers the hook
question, and `maxLayers` now returns `hookBlocked` so MAX mode names a layer
that cannot run instead of reporting itself as on.

`rulePrefix` models command tokens, which only `Bash` and `PowerShell` have, so
a `Read`, `Edit`, `WebFetch(domain:...)` or `mcp__server__tool` rule used to
assess as `unknown` and go unreported. Those now fall through to
`coversPermission`, which matches the whole permission string the way
`shadowedByManaged` in `src/policy-guard.js` always has, plus the one case no
regex expresses: a bare `Edit` with no specifier governs every Edit call, so it
reads as `partial` against a managed `Edit(**/*.ps1)` rather than as effective.
Measured on this workstation's ~300-entry list, `unknown` went from 30 of 176 to
zero, and the largest single prompt source on the machine turned out to be a
managed `Edit` glob that no earlier version could name.

Two verdicts is not the same as knowing the cost. A shell family carries its own
run count, but a file tool renders no permission by design, so `Edit(**/*.ps1)`
had evidence nowhere. The scan now tests each observed path against managed
policy while the path is still in hand and keeps only the RULE it matched, which
is org policy rather than user data; `managed.costliestRules` ranks both halves
together. `--learn hits` derives the same table from the whole corpus in one
pass, because cursors mean a normal scan on an established machine sees almost
nothing and the number worth acting on would otherwise take weeks to reappear.

Three deliberate limits. The file is a client-refreshed CACHE, so it is advisory:
it can withhold a proposal, never widen one. Absence is not an empty policy, and
an unreadable file reports `unreadable` rather than passing as unmanaged. And
`hookBlocked` is the policy's own declaration, not an observation; per-event
enforcement has changed across policy versions, so confirm with a canary that
appends to a file before relying on it in either direction.

---

## 7. Reducing friction without bypass mode

Ranked by leverage, with availability under a managed policy noted.

**Permission modes** **[docs: permission-modes]**, per session:

| Mode | Auto-approves | Note |
|---|---|---|
| `default` | read-only only | what a managed `defaultMode: default` pins |
| `acceptEdits` | reads, file edits, common filesystem Bash on in-scope paths | |
| `plan` | reads plus classifier-approved commands | |
| `auto` | everything subject to classifier review; deny and ask still prompt | needs `disableAutoMode` unset, plus client and org enablement |
| `dontAsk` | only allow-listed tools, read-only Bash, and PreToolUse `allow` | |

A managed `defaultMode` overrides the settings-resolved startup mode, but a host
passing `--permission-mode` with `hostOwnsPermissionMode` outranks it
**[measured]**.

**`permissions.allow` rules.** Persistent, and the surface this project
automates. Subject to everything in section 5.

**PreToolUse hook returning a decision.** Persistent, configured in a settings
file, and the only mechanism that can decide per invocation rather than per
pattern **[docs: hooks-guide]**:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow",
    "permissionDecisionReason": "why"
  }
}
```

An `allow` decision skips the prompt but **does not** override deny rules,
including enterprise managed deny lists, and cannot suppress the prompt for MCP
tools marked `requiresUserInteraction` **[docs]**. Unavailable where
`allowManagedHooksOnly` excludes the `PreToolUse` event.

This is the interesting one for a learner. A hook can reuse the same
classification the exporters already run and answer per command, which sidesteps
pattern-matching gaps entirely. It cannot beat a managed `ask`, so the three
inert families above stay inert.

**Auto-mode configuration** **[docs: auto-mode-config]**: `autoMode.environment`
describes trusted infrastructure, `autoMode.allow` carves exceptions out of
soft-deny, `autoMode.soft_deny` and `autoMode.hard_deny` set the floor.
Persistent, in user or managed settings, and only active in auto mode.

**`permissions.additionalDirectories`** extends read and edit access beyond the
working directory **[docs]**. Persistent.

**Tool-level rules** with no argument filter: `Edit`, `Read(src/**)`,
`WebFetch(domain:example.com)`, `mcp__server__tool` **[docs]**. The docs
recommend denying `curl` and `wget` and allowing `WebFetch(domain:...)` instead,
because argument-constraining Bash patterns are fragile.

**Sandbox auto-allow**: with `sandbox.enabled`, Bash commands staying inside the
sandbox boundary can run unprompted **[docs: permission-modes]**.

### Auto mode discards part of your allow list

This is the one that changes how you read every number above. In auto mode the
classifier is the decider, and Claude Code **refuses to load** any allow entry
that would bypass it, one debug line per entry:

```
[DEBUG] Ignoring dangerous permission Bash(*) from <file> (bypasses classifier)
```

`scripts/auto-mode-audit.js` measures this against a real settings file. It is
free and cannot touch your configuration: `CLAUDE_CONFIG_DIR` points at an empty
sandbox, only a copy of the allow array is written there, and with no
credentials the run stops at "Not logged in" AFTER the permission load, so the
answer arrives without an API call. It reports when it did not get that far
rather than presenting an empty result as a clean bill.

Measured on a ~300-entry list **[measured 2026-09-02, Claude Code 2.1.258]**:

```
mode auto   : ~300 entries, 19 discarded, the rest loaded
mode manual : ~300 entries,  0 discarded, all loaded
```

The 19 are exactly the interpreter and shell-wrapper class:

```
Bash(bash|lua|node|npx|perl|python|python3|ssh|xargs *)
PowerShell(Add-Type|Start-Process|cmd|node|powershell|powershell.exe|python|python3|ssh|wsl.exe *)
```

Two consequences worth holding onto. Sibling spellings are not interchangeable:
`Bash(powershell *)` survives while `PowerShell(powershell *)` does not, and
`PowerShell(& *)` survives in both modes, so a call-operator grant is live even
under the classifier. And the blanket wrapper grants a seed installs are inert
while you run auto, which means switching to manual mode activates all of them
at once. MAX mode switches you to manual by design (`MAX_MODE = 'default'` in
`src/permissions.js`), so that is exactly when they go live.

### Levers that do not work

Narrowing arguments in a Bash rule. `Bash(curl http://github.com/ *)` does not
prevent `curl -X GET http://...`, a protocol change, a redirect via `-L`, a
variable (`URL=... && curl $URL`), or extra spaces **[docs]**. Argument
constraints in Bash rules are documented as fragile; prefer a different tool.

---

## 8. Corrections this document exists to prevent

Both of these were believed during the 2026-09-02 investigation and both were
wrong. Check here before repeating them.

**"`Bash(pwd *)` does not cover a bare `pwd`, so we grant rules that keep
prompting."** False. The docs state the space-star form matches the bare
command. What is true is narrower: our own `permissionMatches` models it
incorrectly, and an entry with a second wildcard loses the guarantee.

**"A pipeline-tail family like `PowerShell(Select-Object *)` can never match,
because Claude Code matches the whole command string."** False. Subcommands are
matched independently, so a pipeline tail is a real, matchable command.

A third near-miss worth recording: a coverage check keyed on
`candidate.claudePermission` reports every learner-refused family as uncovered,
because that field is `null` for exactly those candidates. That produced a
phantom 24-family "friction gap" that `PowerShell(& *)` already covered. Probe
the form that would actually be typed.
