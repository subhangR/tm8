#!/bin/sh
# rea-sandbox setup jeb [--interactive] — runs inside the RE Lab sandbox (gVisor, no network)
# with only this slot mounted, read-write, at /engines/jeb. Unpacks the owner's JEB from drop/
# into install/, starts its headless MCP server on the fixture, and writes READY only after
# REA's inspect-jeb-client has reached it. JEB asks for its EULA and licence key on first use,
# so the first setup needs --interactive (a terminal). Exit 0 ready, 2 waiting for the owner,
# 1 failed. Prints no licence material.
set -eu
slot=/engines/jeb
out=/case/out/setup-jeb
mkdir -p "$out"
say() { printf 'setup jeb: %s\n' "$*" >&2; }
rm -f "$slot/READY"

if [ ! -f "$slot/install/bin/app/jeb.jar" ]; then
  src=
  for d in "$slot"/drop/*/; do
    d=${d%/}
    if [ -f "$d/bin/app/jeb.jar" ]; then src=$d; break; fi
  done
  if [ -z "$src" ]; then
    for z in "$slot"/drop/*.zip; do
      [ -f "$z" ] || continue
      say "archive $(basename "$z") sha256 $(sha256sum "$z" | cut -d' ' -f1)"
      rm -rf /exec/jeb-unpack && mkdir -p /exec/jeb-unpack
      unzip -q "$z" -d /exec/jeb-unpack
      jar=$(find /exec/jeb-unpack -maxdepth 5 -path '*/bin/app/jeb.jar' | head -1)
      [ -n "$jar" ] || { say "$(basename "$z") holds no bin/app/jeb.jar"; exit 1; }
      src=${jar%/bin/app/jeb.jar}
      break
    done
  fi
  if [ -z "$src" ]; then
    say "waiting for the owner's files: no JEB zip or JEB folder in $slot/drop; see $slot/README.md"
    exit 2
  fi
  rm -rf "$slot/install.tmp"
  cp -R "$src" "$slot/install.tmp"
  rm -rf "$slot/install" /exec/jeb-unpack
  mv "$slot/install.tmp" "$slot/install"
fi
cd "$slot/install"
"$JAVA_HOME/bin/java" -jar bin/app/jeb.jar -c --help > "$out/help.txt" 2>&1 || true
grep -q -- '--mcp' "$out/help.txt" || say "this JEB's -c --help does not list --mcp (see $out/help.txt); REA's CLI route needs a build that does"

# Probe the MCP server REA will use, then stop JEB. The probe runs beside JEB so JEB keeps the
# terminal for its first-use EULA and licence prompts.
rm -f /tmp/jeb-reached
(
  i=0
  while [ "$i" -lt 120 ]; do
    sleep 5
    i=$((i + 1))
    if rea inspect-jeb-client --json > "$out/inspect.json" 2> "$out/inspect.err"; then
      touch /tmp/jeb-reached
      break
    fi
    pgrep -f 'bin/app/jeb.jar' > /dev/null || break  # JEB has exited
  done
  pkill -f 'bin/app/jeb.jar' || true
) &
if [ -t 0 ]; then
  say "starting JEB; answer its EULA and licence prompts here if it asks"
  "$JAVA_HOME/bin/java" -Xmx1536m -XX:ActiveProcessorCount=1 -jar bin/app/jeb.jar \
    -c --mcp --interface=127.0.0.1 --port=8425 --infile=/case/targets/hello || true
else
  "$JAVA_HOME/bin/java" -Xmx1536m -XX:ActiveProcessorCount=1 -jar bin/app/jeb.jar \
    -c --mcp --interface=127.0.0.1 --port=8425 --infile=/case/targets/hello \
    < /dev/null > "$out/jeb.log" 2>&1 || true
fi
wait
if [ ! -f /tmp/jeb-reached ]; then
  say "REA could not reach JEB's MCP server (details in $out: inspect.err, jeb.log)"
  [ -t 0 ] || say "if this is JEB's first run here, run: rea-sandbox setup jeb --interactive"
  exit 1
fi
printf 'JEB %s\n' "$slot/install" > "$slot/READY"
say "ready: REA reached JEB's MCP server ($out/inspect.json)"
