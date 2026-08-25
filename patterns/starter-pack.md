# Starter Pack — permission-wildcarding

Seed list of commonly-approved Claude Code permissions. `patterns/starter-pack.json`
is the source of truth and now carries a comprehensive snapshot (290+ entries) taken
from a real, fully-wildcarded allow list — command roots for the standard dev toolbox
(git, gh, node/npm/npx, uv, ripgrep/fd/jq/yq, ffmpeg/imagemagick/poppler/ghostscript/
pandoc/tesseract, duckdb, sqlite-utils, and more), a broad set of PowerShell cmdlets
(`Select-Object`, `Where-Object`, `Format-Table`, `Get-ChildItem`, …), tool-wide grants
(`Edit`, `Write`, `Read(*)`, `WebFetch(*)`), and per-server MCP wildcards. A few
**destructive** roots are included too (`rm`, `Remove-Item`, `Stop-Process`) — see the
note at the bottom on removing them. Machine-specific entries
(absolute paths, env-var-prefixed commands, project binaries) are intentionally left
out so the seed stays portable. All entries are already in wildcarded final form;
`processAllowList` passes them through and prunes redundancies against your allow list.

The category tables below are readable highlights, not the full list — see the JSON
for everything.

---

## MCP / Built-in

| Permission | Purpose |
|---|---|
| `WebSearch` | Allow Claude to search the web |
| `Read(*)` | Allow reading any file (no path restriction) |
| `WebFetch(*)` | Allow fetching any URL |

---

## Skills

| Permission | Purpose |
|---|---|
| `Skill(update-config)` | Run the update-config skill |
| `Skill(update-config:*)` | Run update-config with any argument |
| `Skill(claude-api)` | Run the claude-api reference skill |
| `Skill(claude-api:*)` | Run claude-api skill with any argument |

---

## Shell & Filesystem

| Permission | Purpose |
|---|---|
| `Bash(git *)` | All git operations |
| `Bash(bash *)` | Run bash scripts directly |
| `Bash(ls *)` | List directory contents |
| `Bash(find *)` | Filesystem search |
| `Bash(cp *)` | Copy files |
| `Bash(mv *)` | Move / rename files |
| `Bash(chmod *)` | Change file permissions |
| `Bash(which *)` | Locate binaries (Linux/macOS) |
| `Bash(where *)` | Locate binaries (Windows/WSL2) |
| `Bash(mktemp *)` | Create temporary files/dirs |
| `Bash(mkdir *)` | Create directories |
| `Bash(cd *)` | Change directory (standalone) |
| `Bash(wait *)` | Wait for background processes |
| `Bash(cat *)` | Print file contents |
| `Bash(awk *)` | Text processing |
| `Bash(sed *)` | Stream editor / in-place substitution |
| `Bash(sort *)` | Sort lines |
| `Bash(tee *)` | Pipe + write to file |
| `Bash(printf *)` | Formatted output |
| `Bash(command *)` | Run command bypassing shell functions |
| `Bash(exit *)` | Exit a shell / script |
| `Bash(printenv *)` | Print environment variables |
| `Bash(ip route *)` | Routing table inspection |
| `Bash(grep nameserver *)` | Check DNS resolver config |
| `Bash(journalctl *)` | Systemd journal log inspection |
| `Bash(unzip *)` | Extract ZIP archives |
| `Bash(zip *)` | Create ZIP archives |
| `Bash(gunzip *)` | Decompress gzip archives |
| `Bash(rsync *)` | File sync / transfer |
| `Bash(scp *)` | Secure copy over SSH |
| `Bash(fc-list *)` | List installed fonts |

---

## Python

| Permission | Purpose |
|---|---|
| `Bash(python3 *)` | Run Python scripts |
| `Bash(.venv/bin/python *)` | Run Python from a local venv |
| `Bash(uv *)` | uv package/project management |
| `Bash(ipython *)` | Interactive Python shell |
| `Bash(pipx install *)` | Install pipx-managed CLI tools |
| `Bash(pipx environment *)` | Inspect pipx environment |
| `Bash(pipx runpip *)` | pip commands inside a pipx venv |
| `Bash(pip show *)` | Inspect installed packages (read-only) |
| `Bash(pip3 show *)` | Inspect installed packages (read-only) |
| `Bash(pip index *)` | Query PyPI index (read-only) |

---

## Node / npm

| Permission | Purpose |
|---|---|
| `Bash(node *)` | Run Node scripts |
| `Bash(pnpm *)` | pnpm package management |
| `Bash(npx --yes *)` | Run npx packages without prompt |
| `Bash(npx playwright *)` | Playwright CLI via npx |
| `Bash(npx --version *)` | Query npx version (read-only) |

---

## Shell Scripts

| Permission | Purpose |
|---|---|
| `Bash(./bootstrap.sh *)` | Run project bootstrap scripts |
| `Bash(./install.sh *)` | Run project install scripts |
| `Bash(./deploy-local.sh *)` | Run local deploy scripts |
| `Bash(./build.sh *)` | Run project build scripts |

---

## .NET

| Permission | Purpose |
|---|---|
| `Bash(dotnet *)` | All dotnet subcommands (build, run, test, publish…) |
| `PowerShell(dotnet *)` | The same, from a PowerShell session |
| `Bash(msbuild *)` | MSBuild invocations (`msbuild x.sln /t:Rebuild`) |
| `PowerShell(msbuild *)` | The same, from a PowerShell session |

> **Note:** This starter entry intentionally keeps the legacy root-wide scope.
> Newly observed `dotnet` approvals now retain their subcommand boundary, but seeding
> `Bash(dotnet *)` remains the friction-first choice documented here. Use
> `permissions.deny` if you want to carve any operations back out.

> **`msbuild` is fixed-purpose, not a dispatcher.** Its arguments are project files and
> `/t:` switches rather than subcommands, so it is deliberately absent from
> `MIXED_FAMILY_ROOTS`: a newly observed approval collapses to `Bash(msbuild *)` on its
> own, matching what the seed grants. Both tools are listed because a .NET repo prompts
> for `dotnet build` and `msbuild` interchangeably, and `Bash(...)` and `PowerShell(...)`
> are separate permission namespaces — granting one never covers the other.

---

## C / C++ (CMake)

| Permission | Purpose |
|---|---|
| `Bash(cmake *)` | Configure and build (`cmake -B build`, `cmake --build build`) |
| `PowerShell(cmake *)` | The same, from a PowerShell session |
| `Bash(ctest *)` | Run the configured test suite (`ctest --test-dir build`) |
| `PowerShell(ctest *)` | The same, from a PowerShell session |

> **`ctest` is listed separately because `cmake` does not cover it.** They are distinct
> executables, so a `cmake` wildcard never matches a `ctest` invocation, and a
> configure-build-test loop prompts on its last step otherwise. Both are fixed-purpose:
> their arguments are paths and switches rather than subcommands, so a newly observed
> approval collapses to the root on its own, matching what the seed grants.

---

## GitHub CLI

| Permission | Purpose |
|---|---|
| `Bash(gh repo *)` | Repo operations (create, clone, view, fork…) |
| `Bash(gh api *)` | Raw GitHub API calls |
| `Bash(gh auth *)` | Auth login/status/token |
| `Bash(gh search *)` | Search repos, code, issues |
| `Bash(gh release *)` | Create, list, upload release assets |

> **Note:** The starter pack itself retains the legacy `Bash(gh *)` entry, which
> covers the subcommand examples above. Newly observed `gh` approvals now retain
> their subcommand boundary; an existing or seeded root-wide wildcard is preserved.

---

## Media

| Permission | Purpose |
|---|---|
| `Bash(ffmpeg *)` | Video/audio encoding and manipulation |
| `Bash(ffprobe *)` | Media file inspection (read-only) |
| `Bash(yt-dlp *)` | Download video/audio from URLs |

---

## Image Processing

| Permission | Purpose |
|---|---|
| `Bash(magick *)` | ImageMagick v7 (convert, resize, composite…) |
| `Bash(convert *)` | ImageMagick v6 legacy CLI |
| `Bash(identify *)` | ImageMagick file inspection (read-only) |
| `Bash(potrace *)` | Bitmap to vector tracing |
| `Bash(autotrace *)` | Bitmap to vector tracing (alternative) |
| `Bash(rsvg-convert *)` | SVG rasterizer / converter |
| `Bash(inkscape *)` | Inkscape CLI (SVG edit, export) |

---

## PDF / Documents

| Permission | Purpose |
|---|---|
| `Bash(qpdf *)` | PDF manipulation (linearize, merge, split) |
| `Bash(pdfinfo *)` | PDF metadata inspection (read-only) |
| `Bash(pdftoppm *)` | PDF page rendering to images (poppler) |
| `Bash(pdftotext *)` | Extract text from PDF (poppler) |
| `Bash(pdfimages *)` | Extract images from PDF (poppler) |
| `Bash(soffice *)` | LibreOffice CLI (convert, headless render) |
| `Bash(pandoc *)` | Universal document converter |
| `Bash(tesseract *)` | OCR — image to text |

---

## System / Package Info

| Permission | Purpose |
|---|---|
| `Bash(dpkg *)` | Query installed Debian packages |
| `Bash(apt-cache *)` | Query apt package cache |
| `Bash(apt list *)` | List apt packages |

---

## GPU / CUDA / AI

| Permission | Purpose |
|---|---|
| `Bash(nvidia-smi *)` | GPU status and info |
| `Bash(nvcc *)` | CUDA compiler |
| `Bash(realesrgan-ncnn-vulkan *)` | AI image upscaling (Real-ESRGAN) |
| `Bash(iopaint *)` | AI inpainting / object removal |
| `Bash(ollama *)` | Local LLM runtime |

---

## Data

| Permission | Purpose |
|---|---|
| `Bash(duckdb *)` | DuckDB analytical queries (SQL, JSON, Parquet) |

---

## Dev Environment (ai-dev-envbuild)

| Permission | Purpose |
|---|---|
| `Bash(devtools *)` | Tool inventory: report, check, outdated |
| `Bash(smoke-test *)` | End-to-end smoke test |
| `Bash(claude *)` | The Claude Code CLI itself (`config`, `mcp`, `setup-token`, …) |
| `Bash(sh *)` | POSIX shell, alongside the existing `bash` entry |
| `PowerShell(code *)` / `PowerShell(tokei *)` | VS Code and LOC stats from a PowerShell session |

---

## Containers

| Permission | Purpose |
|---|---|
| `Bash(docker *)` / `PowerShell(docker *)` | Docker CLI |
| `Bash(podman *)` / `PowerShell(podman *)` | Podman CLI (rootless containers) |
| `PowerShell(docker-compose *)` | Compose v1 binary |

> **Why `docker-compose` needs its own entry:** `docker *` as a glob requires the
> space after `docker`, so it never matches `docker-compose ...`. Same reason
> `wsl *` and `wsl.exe *` are both listed.

---

## Windows / WSL2

| Permission | Purpose |
|---|---|
| `Bash(explorer.exe *)` | Open Windows Explorer |
| `Bash(wslpath *)` | Convert between WSL and Windows paths |
| `Bash(wslview *)` | Open files/URLs with the Windows default handler |
| `Bash(cmd.exe *)` | Run Windows Command Prompt |
| `Bash(powershell.exe *)` | Run Windows PowerShell |
| `Bash(pwsh *)` | Run PowerShell 7+ (cross-platform) |
| `Bash(wsl *)` / `PowerShell(wsl *)` / `PowerShell(wsl.exe *)` | Run WSL distros |
| `PowerShell(Get-ScheduledTask *)` | Inspect scheduled tasks (read-only) |
| `PowerShell(Get-WindowsOptionalFeature *)` | Query optional Windows features |
| `PowerShell(Get-WmiObject *)` | Legacy WMI queries (read-only) |
| `PowerShell(Get-ExecutionPolicy *)` | Read the current execution policy |

> **`Set-ExecutionPolicy` is deliberately absent.** The pack ships destructive
> *file* and *process* roots (`rm`, `Remove-Item`, `Stop-Process`) because those
> are routine work; changing the machine's script-signing posture is a different
> class of thing and stays a prompt.

---

## MCP Tools — Playwright

| Permission | Purpose |
|---|---|
| `mcp__playwright__browser_navigate` | Navigate browser to a URL |
| `mcp__playwright__browser_snapshot` | Capture accessibility snapshot |
| `mcp__playwright__browser_take_screenshot` | Screenshot the current page |
| `mcp__playwright__browser_evaluate` | Run JS in the browser context |
| `mcp__playwright__browser_wait_for` | Wait for a selector or condition |
| `mcp__playwright__browser_resize` | Resize the browser viewport |
| `mcp__playwright__browser_console_messages` | Read browser console output |
| `mcp__playwright__browser_click` | Click an element |
| `mcp__playwright__browser_close` | Close the browser |

> Requires the Playwright MCP server configured in your Claude Code settings.

---

## MCP Tools — GitHub

| Permission | Purpose |
|---|---|
| `mcp__github__search_repositories` | Search GitHub repos |
| `mcp__github__get_file_contents` | Fetch file contents from a repo |
| `mcp__github__search_code` | Search code across GitHub |
| `mcp__github__create_repository` | Create a new GitHub repository |
| `mcp__github__fork_repository` | Fork a GitHub repository |

> Requires the GitHub MCP server configured in your Claude Code settings.

---

## What's NOT in the starter pack

These are intentionally excluded — either too machine-specific, or destructive roots you
should opt into on your own machine rather than inherit from a seed:

- **Absolute paths** (`/home/user/projects/...`) — machine-specific, repopulate naturally
- **Catastrophic roots** (`dd *`, `mkfs *`, `kill *`, `Clear-Disk *`, `Format-Volume *`) —
  left out of the seed; approve them yourself if you need them, and gate the truly
  dangerous forms in `permissions.deny` (e.g. `Bash(rm -rf /*)`, `Bash(dd * of=/dev/*)`)
- **`sudo *`** — rare on Windows; approve per machine
- **Project-specific binaries & env var prefixes** (`WE="..."`, `WP_DIR=...`, personal
  scripts) — repopulate per project

> **⚠ A few everyday destructive roots ARE in the seed** — `Bash(rm *)`,
> `PowerShell(Remove-Item *)`, and `PowerShell(Stop-Process *)` (plus the `rm` PowerShell
> alias). They came from a real allow list where deleting files and killing processes are
> routine, and `permissions.deny` still blocks the catastrophic forms (`rm -rf /*` etc.).
> **If you'd rather be prompted for these, delete their lines** from
> `patterns/starter-pack.json` before seeding, or remove them from
> `~/.claude/settings.json` afterward (the VS Code dashboard's per-row ✕ does this in one
> click).

---

## Known Limitations

### Auto mode discards the interpreter roots

Claude Code's `auto` permission mode routes every decision through its classifier, and it
drops any allow entry that would bypass that classifier. Twenty of the seed's entries are
affected: `Bash(bash *)`, `Bash(sh *)`, `Bash(python *)`, `Bash(python3 *)`, `Bash(node *)`,
`Bash(npx *)`, `Bash(ssh *)`, `Bash(perl *)`, `Bash(xargs *)`, `Bash(lua *)`, and the
`PowerShell(...)` twins for `python`, `python3`, `node`, `ssh`, `cmd`, `powershell`,
`powershell.exe`, `wsl.exe`, `Start-Process` and `Add-Type`.

They are **not** dead entries. Load the same `settings.json` in `default` mode and every one
of them applies; only auto mode filters them, logging `Ignoring dangerous permission …
(bypasses classifier)` for each. So the seed keeps them, and which mode you run decides
whether they do anything. Measured against 2.1.238 and 2.1.245, so this tracks the mode
rather than the version.

Two things follow. Sibling spellings are not interchangeable: `Bash(powershell *)`,
`Bash(cmd.exe *)`, `Bash(pwsh *)`, `Bash(wsl *)`, `Bash(scp *)`, `Bash(timeout *)` and
`Bash(nohup *)` all survive auto mode while their `PowerShell(...)` counterparts do not, and
`Bash(scp *)` survives where `Bash(ssh *)` does not. And narrowing the argument does not
help: a managed `Bash(python -m pytest:*)` is refused for the same reason. If you need those
families to be pre-approved, run in `default` mode; if you want the classifier deciding, run
auto and expect these to be ignored.

### Compound commands are checked per sub-command

Claude Code (verified on v2.1.202) decomposes a compound command and checks each sub-command
against your allow rules **independently**, splitting on `&&`, `||`, `|`, `;`, `&`, and
newlines. So `cd "/path" && ffprobe file.mp4` needs both `Bash(cd *)` and `Bash(ffprobe *)`
in allow, and then runs with no prompt. A single root wildcard per command is enough; you do
**not** need a pattern that spans `&&`.

The exception: **command substitution** `$(...)` and **subshells** `(...)` are matched as a
whole, not decomposed, so those can still prompt.

`cd` is also redundant in Claude Code — each Bash tool call spawns a fresh subprocess, so `cd`
has no lasting effect. Prefer absolute paths:

```bash
# Redundant — cd has no effect on later calls
cd "/home/user/project" && ffprobe file.mp4

# Simpler — covered by Bash(ffprobe *)
ffprobe /home/user/project/file.mp4
```
