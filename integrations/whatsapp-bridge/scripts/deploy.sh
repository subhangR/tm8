#!/usr/bin/env bash
# Build the image and replace the running container. State (auth/, data/, tokens/) is in host volumes, so it survives.
#   ./scripts/deploy.sh          the main bridge: state in the repo root, container wa-bridge
#   ./scripts/deploy.sh <inst>   another WhatsApp number: state in instances/<inst>/, container wa-bridge-<inst>
# Every instance builds from this repo's code, shares secrets/ (ro) and data/models (ro), and serves on its config's http.port.
set -euo pipefail
cd "$(dirname "$0")/.."
REPO=$(pwd)
INST=${1:-}
if [ -n "$INST" ]; then
  [[ "$INST" =~ ^[a-z0-9][a-z0-9-]*$ ]] || { echo "instance name must match [a-z0-9][a-z0-9-]*" >&2; exit 1; }
  ROOT="$REPO/instances/$INST"
  NAME=${WA_BRIDGE_CONTAINER:-wa-bridge-$INST}
else
  ROOT=$REPO
  NAME=${WA_BRIDGE_CONTAINER:-wa-bridge}
fi
IMAGE=${WA_BRIDGE_IMAGE:-wa-bridge:latest}
cd "$ROOT"

[ -f config.json ] || { echo "$ROOT/config.json missing (copy config.example.json)" >&2; exit 1; }
[ -d auth ] || { echo "$ROOT/auth missing: link the device first (./scripts/link.sh $INST, OPERATIONS.md › Re-link)" >&2; exit 1; }
mkdir -p data tokens "$REPO/secrets" && chmod 700 "$REPO/secrets" tokens
PORT=$(node -e "console.log(JSON.parse(require('fs').readFileSync('config.json','utf8')).http?.port ?? 8787)")

docker build -t "$IMAGE" "$REPO"

# Only one process may hold a WhatsApp connection: stop the old container before starting the new one.
if docker ps -a --format '{{.Names}}' | grep -qx "$NAME"; then
  docker stop -t 20 "$NAME" >/dev/null
  docker rm "$NAME" >/dev/null
fi

# Other instances use the main repo's whisper models (read-only) instead of their own copy.
MODELS=()
if [ "$ROOT" != "$REPO" ] && [ -d "$REPO/data/models" ]; then MODELS=(-v "$REPO/data/models:/app/data/models:ro"); fi

docker run -d --name "$NAME" \
  --restart unless-stopped \
  --network host \
  --user 110:114 \
  -v "$ROOT/auth:/app/auth" \
  -v "$ROOT/data:/app/data" \
  "${MODELS[@]}" \
  -v "$REPO/secrets:/app/secrets:ro" \
  -v "$ROOT/tokens:$ROOT/tokens" -e WA_BRIDGE_TOKEN_DIR="$ROOT/tokens" \
  -v "$ROOT/config.json:/app/config.json:ro" \
  -e HEALTH_URL="http://127.0.0.1:$PORT/health" \
  -v /opt/tm8/prod:/opt/tm8/prod:ro \
  --log-opt max-size=20m --log-opt max-file=5 \
  "$IMAGE" >/dev/null

echo "started $NAME; waiting for WhatsApp…"
for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:$PORT/health" 2>/dev/null | grep -q '"connected":true'; then
    curl -fsS "http://127.0.0.1:$PORT/health"; echo
    exit 0
  fi
  sleep 2
done
echo "not connected after 60 s; check: docker logs --tail 100 $NAME" >&2
exit 1
