#!/usr/bin/env bash
# Smoke gate: does the real thing work on this box?
#
# Exercises the CLI surface (state load, policy read, guidance/gates read) and the
# hook entry point the way Claude Code invokes it. Regression (`npm test`) is a
# separate gate; this one is about the live machine, so it reads the REAL
# ~/.claude/settings.json rather than a fixture.
#
# Paths are resolved, not hardcoded. This script previously lived in a session
# scratchpad with an absolute repo path, an absolute settings path and an absolute
# mirror path baked in — which made it unrunnable by anyone else and meant the gate
# every phase of the work depended on was itself untracked.
#
# Overridable for a non-default layout, same contract as scripts/verify-release.ps1:
# an unset value is discovered, never required.
#   PW_SETTINGS   path to settings.json      (default: $HOME/.claude/settings.json)
#   PW_MIRROR     off-tree backup mirror     (default: $HOME/.permission-wildcarding/allow-list.latest.json)
#   PW_FPCACHE    hook fixed-point cache key (default: $HOME/.claude/wildcarding/fixed-point.json)
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI="$REPO/bin/wildcard-perms"
SETTINGS="${PW_SETTINGS:-$HOME/.claude/settings.json}"
MIRROR="${PW_MIRROR:-$HOME/.permission-wildcarding/allow-list.latest.json}"
FPCACHE="${PW_FPCACHE:-$HOME/.claude/wildcarding/fixed-point.json}"

fail=0
pass=0

check() { # name, expected-ERE, output
  if printf '%s' "$3" | grep -Eq "$2"; then
    pass=$((pass+1)); echo "  PASS  $1"
  else
    fail=$((fail+1)); echo "  FAIL  $1"; echo "        expected /$2/ in: $(printf '%s' "$3" | head -c 200)"
  fi
}

ok() { # name, detail — an unconditional pass, for checks that assert by construction
  pass=$((pass+1)); echo "  PASS  $1"; [ -n "${2:-}" ] && echo "        $2"
}

no() { # name, detail
  fail=$((fail+1)); echo "  FAIL  $1"; [ -n "${2:-}" ] && echo "        $2"
}

if [ ! -f "$CLI" ]; then
  echo "  FAIL  cli present"; echo "        no $CLI — wrong repo?"; echo ""; echo "smoke: 0 pass, 1 fail"; exit 1
fi

echo "== CLI status verbs"
# Each pattern asserts a real invariant of the output. Three of these used to be
# the pattern `.` — which matches any non-empty output, so `--max`, `--bypass` and
# `--learn` were passing on literally anything the process printed, including an
# error message. Same vacuous-check family as the hook-quiet one below.
check "--gates status"    'gates \[claude\]'                          "$(node "$CLI" --gates status 2>&1)"
check "--guidance status" 'guidance \[claude\]'                       "$(node "$CLI" --guidance status 2>&1)"
check "--max status"      'MAX: (ON|OFF)'                             "$(node "$CLI" --max status 2>&1)"
check "--bypass status"   'bypass: (ON|OFF)'                          "$(node "$CLI" --bypass status 2>&1)"
# --learn status emits the state file as JSON, not prose. Pin the one field whose
# value set is closed, so a malformed or empty state cannot pass.
check "--learn status"    '"mode": *"(observe|recommend|auto-safe)"'  "$(node "$CLI" --learn status 2>&1)"

echo "== hook entry point (PostToolUse payload on stdin)"
# The real invocation shape: Claude Code pipes a JSON event on stdin. A hook that
# throws here is paid on EVERY tool call, so this is the highest-value check.
#
# stdout and stderr are captured SEPARATELY from the exit code. The previous
# version merged them and then ran the blob through
# `tr -d '[:space:]' | grep -o 'rc=0' | head -1 | sed …`, which manufactures the
# string "rc=0" whenever the exit code was 0 no matter what else was printed.
# Verified with fabricated input: it passed on "rc=0", on
# "wildcard-perms: read error: boom\nrc=0", and on arbitrary multi-line noise.
# It could not fail. So the hook's "quiet by design" contract — the single
# property paid on every tool call — reported green while testing nothing.
HOOK_EVENT='{"tool_name":"Bash","tool_input":{"command":"git status"},"tool_response":{"stdout":"ok"}}'
HOOK_ERR_FILE="$(mktemp)"
HOOK_STDOUT="$(printf '%s' "$HOOK_EVENT" | node "$CLI" 2>"$HOOK_ERR_FILE")"
HOOK_RC=$?
HOOK_STDERR="$(cat "$HOOK_ERR_FILE")"
rm -f "$HOOK_ERR_FILE"

if [ "$HOOK_RC" -eq 0 ]; then ok "hook exits 0"; else no "hook exits 0" "exit was $HOOK_RC"; fi

# Emptiness asserted directly on the captured bytes, so noise cannot pass.
HOOK_NOISE="${HOOK_STDOUT}${HOOK_STDERR}"
if [ -z "$HOOK_NOISE" ]; then
  ok "hook is quiet"
else
  no "hook is quiet" "printed $(printf '%s' "$HOOK_NOISE" | wc -c) bytes: $(printf '%s' "$HOOK_NOISE" | head -c 160)"
fi

# The check above now exercises the CACHE HIT path, which returns before parsing
# settings.json, before requiring the generalizer, and before the writer or the
# lock — about twenty lines. That is worth gating, but on its own it means the
# gate's headline check gets shallower the moment the cache warms, and its depth
# depends on hidden state: delete the key file and the same script suddenly tests
# the full path instead. So run it BOTH ways, deterministically.
#
# The cache is pure: deleting the key costs one slow hook call and nothing else,
# which is why it is safe for a gate to remove it.
echo "== hook entry point again, with the fixed-point cache forced to miss"
FP_SAVED=""
if [ -f "$FPCACHE" ]; then
  FP_SAVED="$(cat "$FPCACHE")"
  rm -f "$FPCACHE"
fi

MISS_ERR_FILE="$(mktemp)"
MISS_STDOUT="$(printf '%s' "$HOOK_EVENT" | node "$CLI" 2>"$MISS_ERR_FILE")"
MISS_RC=$?
MISS_STDERR="$(cat "$MISS_ERR_FILE")"
rm -f "$MISS_ERR_FILE"

if [ "$MISS_RC" -eq 0 ]; then ok "hook exits 0 on a cold cache"; else no "hook exits 0 on a cold cache" "exit was $MISS_RC"; fi

# The live list is a fixed point, so even a full pass writes nothing and says
# nothing. A miss that had to WRITE would legitimately print one diagnostic —
# which is why this asserts silence only for the no-op case the live file gives.
MISS_NOISE="${MISS_STDOUT}${MISS_STDERR}"
if [ -z "$MISS_NOISE" ]; then
  ok "hook is quiet on a cold cache"
else
  no "hook is quiet on a cold cache" "printed $(printf '%s' "$MISS_NOISE" | wc -c) bytes: $(printf '%s' "$MISS_NOISE" | head -c 160)"
fi

# And the miss must have re-earned the key, or the cache is write-broken and
# every future call pays the full pass with nothing to show for it.
if [ -s "$FPCACHE" ]; then
  ok "the cold run re-earned its cache key" "$(cat "$FPCACHE")"
else
  no "the cold run re-earned its cache key" "no key at $FPCACHE"
fi

echo "== settings.json is still parseable and populated"
ALLOW=$(PW_SETTINGS="$SETTINGS" node -e '
  const fs = require("fs");
  const s = JSON.parse(fs.readFileSync(process.env.PW_SETTINGS, "utf8"));
  console.log(((s.permissions || {}).allow || []).length);
' 2>&1)
check "allow list non-trivial" '^[0-9]{2,}$' "$ALLOW"
echo "        allow entries: $ALLOW"

echo "== off-tree backup mirror present"
# INFO rather than PASS/FAIL when absent, because the mirror is written by the
# extension on its first pass after a reload and a fresh install legitimately has
# none. But when it IS there, assert something about it: `ok` with no condition
# was an unconditional pass, i.e. the same could-not-fail shape this script was
# committed to remove. A mirror that exists but is empty or unparseable is worse
# than one that is missing, because it reads as protection that is not there.
if [ ! -f "$MIRROR" ]; then
  echo "  INFO  mirror not written yet (needs the extension to run a pass post-reload)"
elif [ ! -s "$MIRROR" ]; then
  no "mirror is non-empty" "0 bytes at $MIRROR"
else
  MIRROR_N=$(node -e '
    const fs = require("fs");
    try {
      const j = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      console.log(Array.isArray(j.allow) ? j.allow.length : -1);
    } catch { console.log(-1); }
  ' "$MIRROR" 2>/dev/null)
  if [ "${MIRROR_N:--1}" -gt 0 ]; then
    ok "mirror holds a populated allow list" "$MIRROR_N entries, $(wc -c < "$MIRROR") bytes"
  else
    no "mirror holds a populated allow list" "unparseable or empty allow at $MIRROR"
  fi
fi

# Leave the machine as we found it. The run above re-earns the key on its own,
# so this only matters when the cold run failed to write one.
if [ -n "$FP_SAVED" ] && [ ! -s "$FPCACHE" ]; then
  mkdir -p "$(dirname "$FPCACHE")"
  printf '%s\n' "$FP_SAVED" > "$FPCACHE"
fi

echo ""
echo "smoke: $pass pass, $fail fail"
exit $((fail > 0 ? 1 : 0))
