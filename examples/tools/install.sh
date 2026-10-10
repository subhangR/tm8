#!/usr/bin/env bash
set -euo pipefail
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# Global options (for example --space <id>) are passed through before the noun.
for name in url-check gh-pr-status space-digest slack-notify; do
  runtime=bash
  source=tool.sh
  if [[ "$name" == space-digest ]]; then runtime=python; source=tool.py; fi
  tm8 "$@" tool create "$name" --runtime "$runtime" \
    --source "@$root/$name/$source" --spec "@$root/$name/spec.json" \
    --description "Starter tool: $name" \
    --when-to-use "Open when running or configuring $name" \
    --summary "Runnable $runtime starter with declared inputs; source in examples/tools/$name"
done
