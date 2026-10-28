#!/usr/bin/env bash
# Link a WhatsApp number to an instance's empty auth/ (operator only; the instance's container must be stopped).
#   ./scripts/link.sh <inst>                 pair instances/<inst> (pairing code if config.pairingPhone is set, else a QR)
#   ./scripts/link.sh <inst> --list-groups   connect once and write data/groups.json (the groups this number is in)
# Without <inst> (or with "main") it uses the repo root, i.e. the main bridge (stop wa-bridge first).
# Runs detached as wa-bridge[-<inst>]-link; the code/QR is in its logs and in data/pairing-code.txt / data/qr.png.
set -euo pipefail
cd "$(dirname "$0")/.."
REPO=$(pwd)
INST=${1:-main}
MODE=${2:---link}
[[ "$MODE" == --link || "$MODE" == --list-groups ]] || { echo "mode must be --link or --list-groups" >&2; exit 1; }
if [ "$INST" = main ]; then ROOT=$REPO; SVC=wa-bridge; else ROOT="$REPO/instances/$INST"; SVC=wa-bridge-$INST; fi
[ -f "$ROOT/config.json" ] || { echo "$ROOT/config.json missing" >&2; exit 1; }
if docker ps --format '{{.Names}}' | grep -qx "$SVC"; then
  echo "$SVC is running and holds this number's connection: docker stop $SVC first" >&2; exit 1
fi
if [ "$MODE" = --link ] && [ -f "$ROOT/auth/creds.json" ] && grep -q '"registered": *true' "$ROOT/auth/creds.json"; then
  echo "$ROOT/auth already holds a linked device; move it aside first (OPERATIONS.md › Re-link)" >&2; exit 1
fi
APP_USER=${WA_BRIDGE_USER:-$(id -u tm8 2>/dev/null):$(id -g tm8 2>/dev/null)}
[[ "$APP_USER" =~ ^[0-9]+:[0-9]+$ ]] || { echo "no tm8 user on this host: set WA_BRIDGE_USER=<uid>:<gid>" >&2; exit 1; }
mkdir -p "$ROOT/auth" "$ROOT/data" && chmod 700 "$ROOT/auth"
docker rm -f "$SVC-link" >/dev/null 2>&1 || true
docker run -d --name "$SVC-link" --network host --user "$APP_USER" \
  -v "$ROOT/auth:/app/auth" -v "$ROOT/data:/app/data" -v "$ROOT/config.json:/app/config.json:ro" \
  -v "$REPO/secrets:/app/secrets:ro" -v /opt/tm8/prod:/opt/tm8/prod:ro \
  wa-bridge:latest node --import tsx src/main.ts "$MODE" >/dev/null
echo "started $SVC-link. Follow: docker logs -f $SVC-link   (wait for '[wa] connected', then: docker rm -f $SVC-link)"
