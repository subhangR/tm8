#!/usr/bin/env bash
set -euo pipefail

curl --fail --silent --max-time 2 http://127.0.0.1:14611/ >/dev/null
curl --fail --silent --max-time 2 http://127.0.0.1:14610/health \
  | node -e 'let body = ""; process.stdin.on("data", chunk => body += chunk); process.stdin.on("end", () => { try { process.exit(JSON.parse(body).db === "ok" ? 0 : 1); } catch { process.exit(1); } });'
