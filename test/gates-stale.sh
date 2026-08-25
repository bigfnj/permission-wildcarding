#!/usr/bin/env bash
#
# recall.py gate-staleness check, proven in isolation.
#
# Not part of `node --test`: recall.py needs the local toolbox Python (numpy + onnxruntime),
# which GitHub CI does not have, so this is a local check in the same spirit as recall.py's
# own `--selftest`. Run it where the toolbox lives:
#
#     bash test/gates-stale.sh
#
# What it guards: editing the text inside a <!-- gate --> block without recompiling leaves
# the resident CLAUDE.md block out of date, and `--gates status` cannot see it (it compares
# installed to gates.generated.md, so when both are stale together it reads "current"). The
# `recall.py --lint` drift check is the one place source is compared to what a recompile
# would produce. Everything runs under a throwaway HOME, so the real ~/.claude is untouched.
set -e

PY="${TOOLBOX_PYTHON:-$LOCALAPPDATA/DevToolbox/python/.venv/Scripts/python.exe}"
RECALL="$(dirname "$0")/../memory/recall.py"

HOME_TMP="$(mktemp -d)"
MEM="$HOME_TMP/mem"
mkdir -p "$MEM" "$HOME_TMP/.claude"
trap 'rm -rf "$HOME_TMP"' EXIT

cat > "$MEM/a-rule.md" <<'EOF'
---
name: a-rule
scope: global
type: feedback
---
<!-- gate -->
- **Test.** Original wording. Pass: nothing.
<!-- /gate -->
EOF
printf '# Memory Index\n\n- [a](a-rule.md) hook\n' > "$MEM/MEMORY.md"

lint()    { HOME="$HOME_TMP" USERPROFILE="$HOME_TMP" RECALL_MEMORY_DIR="$MEM" RECALL_REEXEC=1 "$PY" "$RECALL" --lint; }
compile() { HOME="$HOME_TMP" USERPROFILE="$HOME_TMP" RECALL_MEMORY_DIR="$MEM" RECALL_REEXEC=1 "$PY" "$RECALL" --gates-compile >/dev/null; }

fail() { echo "FAIL: $1"; exit 1; }

compile
lint | grep -q STALE && fail "stale right after compile" || echo "ok: fresh compile is not stale"

sed -i 's/Original wording/CHANGED wording/' "$MEM/a-rule.md"
lint | grep -q STALE && echo "ok: drift detected" || fail "drift NOT detected after a gate edit"

compile
lint | grep -q STALE && fail "still stale after recompile" || echo "ok: recompile clears it"

rm -f "$HOME_TMP/.claude/gates.generated.md"
lint | grep -q STALE && fail "a never-compiled corpus must not report stale" || echo "ok: uncompiled is not stale"

echo "ALL PASS"