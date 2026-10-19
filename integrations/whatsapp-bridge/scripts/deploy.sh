#!/usr/bin/env bash
# Build the image and replace the running container. State (auth/, data/, secrets/) is in host volumes, so it survives.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$(pwd)
NAME=${WA_BRIDGE_CONTAINER:-wa-bridge}
IMAGE=${WA_BRIDGE_IMAGE:-wa-bridge:latest}

[ -f config.json ] || { echo "config.json missing (copy config.example.json)" >&2; exit 1; }
[ -d auth ] || { echo "auth/ missing: link the device first (OPERATIONS.md › Re-link)" >&2; exit 1; }
mkdir -p data secrets && chmod 700 secrets

docker build -t "$IMAGE" .

# Only one process may hold the WhatsApp connection: stop the old container before starting the new one.
if docker ps -a --format '{{.Names}}' | grep -qx "$NAME"; then
  docker stop -t 20 "$NAME" >/dev/null
  docker rm "$NAME" >/dev/null
fi

docker run -d --name "$NAME" \
  --restart unless-stopped \
  --network host \
  --user 110:114 \
  -v "$ROOT/auth:/app/auth" \
  -v "$ROOT/data:/app/data" \
  -v "$ROOT/secrets:/app/secrets:ro" \
  -v "$ROOT/config.json:/app/config.json:ro" \
  -v /opt/tm8/prod:/opt/tm8/prod:ro \
  --log-opt max-size=20m --log-opt max-file=5 \
  "$IMAGE" >/dev/null

echo "started $NAME; waiting for WhatsApp…"
for _ in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:8787/health 2>/dev/null | grep -q '"connected":true'; then
    curl -fsS http://127.0.0.1:8787/health; echo
    exit 0
  fi
  sleep 2
done
echo "not connected after 60 s; check: docker logs --tail 100 $NAME" >&2
exit 1
