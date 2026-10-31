#!/bin/sh
# rea-sandbox setup ida — runs inside the RE Lab sandbox (gVisor, no network) with only this
# slot mounted, read-write, at /engines/ida. Installs the owner's IDA Pro from drop/, wires
# REA's headless IDA profile (REA docs/ida-provider.md) and writes READY only after REA has
# analysed the fixture through IDA. Exit 0 ready, 2 waiting for the owner's files, 1 failed.
# Prints no licence material.
set -eu
slot=/engines/ida
bridge=$slot/bridge
out=/case/out/setup-ida
mkdir -p "$out"
say() { printf 'setup ida: %s\n' "$*" >&2; }

[ -x "$bridge/bin/idalib-mcp" ] || { say "no bridge: run tools/rea/build-engines.sh ida on the host"; exit 1; }
say "bridge: $(cat "$bridge/BUILT")"
rm -f "$slot/READY"

# The owner's IDA: an installed folder (a previous setup, or one dropped whole), else the installer.
ida=
for d in "$slot/install" "$slot"/drop/*/; do
  d=${d%/}
  if [ -d "$d/idalib/python" ]; then ida=$d; break; fi
done
if [ -z "$ida" ]; then
  for f in "$slot"/drop/*.run; do
    [ -f "$f" ] || continue
    say "installer $(basename "$f") sha256 $(sha256sum "$f" | cut -d' ' -f1)"
    cp "$f" /exec/ida-installer.run && chmod 0700 /exec/ida-installer.run
    if ! /exec/ida-installer.run --mode unattended --prefix "$slot/install" > "$out/installer.log" 2>&1; then
      say "the installer failed (log: $out/installer.log); drop an installed IDA folder instead"
      exit 1
    fi
    rm -f /exec/ida-installer.run
    [ -d "$slot/install/idalib/python" ] || { say "no idalib in this IDA: headless mode needs IDA Pro 9.0 or newer"; exit 1; }
    ida=$slot/install
    break
  done
fi

# The licence: a .hexlic file (offline; a floating licence needs a server the sandbox cannot reach).
lic=
for f in "$slot"/drop/*.hexlic; do
  if [ -f "$f" ]; then lic=$f; break; fi
done
if [ -z "$lic" ] && [ -n "$ida" ]; then
  for f in "$ida"/*.hexlic; do
    if [ -f "$f" ]; then lic=$f; break; fi
  done
fi
if [ -n "$ida" ] && [ -n "$lic" ] && [ "$(dirname "$lic")" != "$ida" ]; then
  install -m 0600 "$lic" "$ida/"
fi

# IDA's per-user state (EULA acceptance in ida.reg, idalib's ida-config.json) lives in
# $HOME/.idapro, a fresh tmpfs in every sandbox; the image's entrypoint restores the slot's
# home/ into it on each start.
mkdir -p "$slot/home/.idapro"
chmod 0700 "$slot/home" "$slot/home/.idapro"
if [ -f "$slot/drop/ida.reg" ]; then
  install -m 0600 "$slot/drop/ida.reg" "$slot/home/.idapro/ida.reg"
fi

# REA's documented headless registration. IDA's working copy of the input goes under the
# case's work/, not the small /tmp.
cat > "$slot/rea-ida-mcp.json.tmp" <<EOF
{
  "command": "$bridge/bin/idalib-mcp",
  "args": ["--stdio", "--max-workers", "1"],
  "mode": "headless",
  "env": { "IDADIR": "${ida:-$slot/install}" },
  "timeoutMs": 300000,
  "workspaceRoot": "/case/work"
}
EOF
mv "$slot/rea-ida-mcp.json.tmp" "$slot/rea-ida-mcp.json"
rc=0
rea doctor --json --provider ida > "$out/doctor.json" 2> "$out/doctor.err" || rc=$?
say "rea doctor --provider ida: exit $rc ($out/doctor.json)"

if [ -z "$ida" ] || [ -z "$lic" ]; then
  [ -n "$ida" ] || say "waiting for the owner's files: no IDA installer (*.run) or installed IDA folder in $slot/drop"
  [ -n "$lic" ] || say "waiting for the owner's files: no licence (*.hexlic) in $slot/drop"
  say "see $slot/README.md"
  exit 2
fi

# IDA's own Python package, offline from the owner's install, into the bridge venv, then
# idalib's documented activation, which records IDADIR in $HOME/.idapro/ida-config.json.
if ! "$bridge/bin/pip" install --no-index --no-deps --no-build-isolation "$ida/idalib/python" > "$out/pip.log" 2>&1; then
  say "could not add IDA's idapro package to the bridge (log: $out/pip.log)"
  exit 1
fi
cp -R "$slot/home/." "$HOME/"
if [ -f "$ida/py-activate-idalib.py" ]; then
  "$bridge/bin/python" "$ida/py-activate-idalib.py" -d "$ida" > "$out/activate.log" 2>&1 \
    || say "py-activate-idalib.py failed (log: $out/activate.log); IDADIR from the registration still applies"
fi

# The proof: REA analyses the fixture through IDA and returns IDA-attributed Evidence.
rc=0
REA_ANALYSIS_PROVIDER=ida rea function /case/targets/hello main --json > "$out/smoke.json" 2> "$out/smoke.err" || rc=$?
cp -R "$HOME/.idapro/." "$slot/home/.idapro/"  # keep what IDA recorded (EULA, activation) for later runs
ev=$(python3 -I - "$out/smoke.json" <<'EOF' || true
import json, sys
def find(o):
    if isinstance(o, dict):
        p = o.get("provider")
        pid = p.get("id") if isinstance(p, dict) else p
        if str(o.get("evidence_id", "")).startswith("ev_") and pid == "ida":
            return o["evidence_id"]
        o = list(o.values())
    if isinstance(o, list):
        for v in o:
            r = find(v)
            if r:
                return r
    return None
try:
    r = find(json.load(open(sys.argv[1])))
except ValueError:
    r = None
print(r or "")
EOF
)
if [ "$rc" -ne 0 ] || [ -z "$ev" ]; then
  say "smoke test failed (exit $rc, no IDA Evidence); details in $out/smoke.err and $out/smoke.json"
  if grep -qi 'eula\|license agreement' "$out/smoke.err" "$out/smoke.json" 2>/dev/null; then
    say "IDA wants its EULA accepted: copy ~/.idapro/ida.reg from a machine where this IDA version"
    say "has been run once into $slot/drop/ and run setup again"
  fi
  exit 1
fi
printf 'IDA %s\nevidence %s\n' "$ida" "$ev" > "$slot/READY"
say "ready: REA analysed the fixture through IDA (Evidence $ev)"
