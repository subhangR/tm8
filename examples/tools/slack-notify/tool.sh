#!/usr/bin/env bash
set -euo pipefail

# JSON encoding preserves quotes, newlines and Unicode without interpolation.
python3 -I -c 'import json, os; payload = {"text": os.environ["TEXT"]}; channel = os.environ.get("CHANNEL"); payload.update({"channel": channel} if channel else {}); print(json.dumps(payload))' \
  | curl --fail --silent --show-error --max-time 30 --proto '=http,https' \
    --header 'Content-Type: application/json' --data-binary @- --url "$SLACK_WEBHOOK_URL"
printf '\n'
