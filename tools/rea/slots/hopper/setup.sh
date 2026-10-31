#!/bin/sh
# rea-sandbox setup hopper — runs inside the RE Lab sandbox (gVisor, no network) with only this
# slot mounted, read-write, at /engines/hopper. Unpacks the owner's Hopper Linux package from
# drop/ into install/, keeps the owner's Hopper user state (licence activation) from drop/home/,
# and writes READY only after REA has analysed the fixture through Hopper, which REA runs on a
# private Xvfb display (REA docs/installation.md#hopper). Exit 0 ready, 2 waiting for the
# owner's files, 1 failed. Prints no licence material.
set -eu
slot=/engines/hopper
out=/case/out/setup-hopper
mkdir -p "$out"
say() { printf 'setup hopper: %s\n' "$*" >&2; }
rm -f "$slot/READY"

find_exe() { find "$1" -path '*/bin/*' -type f \( -name Hopper -o -name hopper \) -perm -u+x 2>/dev/null | head -1; }
exe=
[ -d "$slot/install" ] && exe=$(find_exe "$slot/install")
if [ -z "$exe" ]; then
  src=
  for p in "$slot"/drop/*.deb; do
    [ -f "$p" ] || continue
    say "package $(basename "$p") sha256 $(sha256sum "$p" | cut -d' ' -f1)"
    rm -rf "$slot/install.tmp" && mkdir -p "$slot/install.tmp"
    dpkg-deb -x "$p" "$slot/install.tmp"
    src=deb
    break
  done
  if [ -z "$src" ]; then
    for d in "$slot"/drop/*/; do
      d=${d%/}
      [ "$(basename "$d")" = home ] && continue
      if [ -n "$(find_exe "$d")" ]; then
        rm -rf "$slot/install.tmp" && cp -R "$d" "$slot/install.tmp"
        src=folder
        break
      fi
    done
  fi
  if [ -n "$src" ]; then
    rm -rf "$slot/install" && mv "$slot/install.tmp" "$slot/install"
    exe=$(find_exe "$slot/install")
    [ -n "$exe" ] || { say "the package holds no bin/Hopper"; exit 1; }
  fi
fi
# REA checks the launcher with ldd, so HOPPER_LAUNCHER_PATH names Hopper's own binary;
# slot-env.json carries it into every later sandbox.
if [ -n "$exe" ]; then
  export HOPPER_LAUNCHER_PATH="$exe"
  printf '{"HOPPER_LAUNCHER_PATH": "{path}%s"}\n' "${exe#"$slot"}" > "$slot/slot-env.json"
fi

# The owner's Hopper user state (an activated licence); the image's entrypoint restores the
# slot's home/ into each sandbox's fresh $HOME.
mkdir -p "$slot/home"
chmod 0700 "$slot/home"
if [ -d "$slot/drop/home" ]; then
  cp -R "$slot/drop/home/." "$slot/home/"
  chmod -R go-rwx "$slot/home"
fi

rc=0
rea doctor --json --provider hopper > "$out/doctor.json" 2> "$out/doctor.err" || rc=$?
say "rea doctor --provider hopper: exit $rc ($out/doctor.json)"
if [ -z "$exe" ]; then
  say "waiting for the owner's files: no Hopper Linux package (*.deb) or Hopper folder in $slot/drop; see $slot/README.md"
  exit 2
fi

# Libraries the image lacks would stop Hopper before REA sees it.
find "$slot/install" -type f -perm -u+x -exec ldd {} \; 2>/dev/null | grep 'not found' | sort -u > "$out/ldd-missing.txt" || true
if [ -s "$out/ldd-missing.txt" ]; then
  say "Hopper needs libraries tm8/rea lacks (list: $out/ldd-missing.txt)"
fi

# The proof: REA analyses the fixture through Hopper and returns Hopper-attributed Evidence.
cp -R "$slot/home/." "$HOME/"
rc=0
REA_ANALYSIS_PROVIDER=hopper rea function /case/targets/hello main --json > "$out/smoke.json" 2> "$out/smoke.err" || rc=$?
ev=$(python3 -I - "$out/smoke.json" <<'EOF' || true
import json, sys
def find(o):
    if isinstance(o, dict):
        p = o.get("provider")
        pid = p.get("id") if isinstance(p, dict) else p
        if str(o.get("evidence_id", "")).startswith("ev_") and str(pid or "").startswith("hopper"):
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
  say "smoke test failed (exit $rc, no Hopper Evidence); details in $out/smoke.err, $out/smoke.json, $out/doctor.json"
  exit 1
fi
if grep -qi demo "$out/smoke.json" "$out/doctor.json" 2>/dev/null; then
  say "note: REA's output mentions Hopper's demo mode; if your licence is not active, see $slot/README.md"
fi
printf 'Hopper %s\nevidence %s\n' "$exe" "$ev" > "$slot/READY"
say "ready: REA analysed the fixture through Hopper (Evidence $ev)"
