#!/bin/sh
# Start JEB's MCP server on loopback (127.0.0.1:8425, REA_JEB_MCP_URL) for one target, inside
# a sandbox container (`rea-sandbox jeb <target>`). REA docs/jeb-analysis.md: JDK 21, a 1536 MiB
# heap, one active processor, the target chosen at startup with --infile. Prints no licence material.
set -eu
slot=/engines/jeb
target=${1:?usage: start-jeb-mcp.sh /case/targets/<file>}
[ -f "$slot/READY" ] || { echo "start-jeb-mcp: the JEB slot is not ready; run rea-sandbox setup jeb" >&2; exit 2; }
[ -f "$slot/install/bin/app/jeb.jar" ] || { echo "start-jeb-mcp: no JEB in $slot/install; see $slot/README.md" >&2; exit 2; }
# JEB writes its config and logs beside itself and the slot is read-only, so run a private copy.
run=/tmp/jeb
rm -rf "$run"
cp -R "$slot/install" "$run"
cd "$run"
exec "$JAVA_HOME/bin/java" -Xmx1536m -XX:ActiveProcessorCount=1 -jar bin/app/jeb.jar \
  -c --mcp --interface=127.0.0.1 --port=8425 --infile="$target"
