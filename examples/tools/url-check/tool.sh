#!/usr/bin/env bash
set -euo pipefail

# Whitespace separates URLs. Read each line without evaluating shell syntax.
failed=0
count=0
while IFS= read -r line || [[ -n "$line" ]]; do
  read -r -a urls <<< "$line"
  for url in "${urls[@]}"; do
    count=$((count + 1))
    case "$url" in
      http://*|https://*) ;;
      *) printf 'FAIL %s (expected http or https)\n' "$url"; failed=1; continue ;;
    esac
    if code=$(curl --silent --show-error --location --output /dev/null \
      --write-out '%{http_code}' --max-time "$TIMEOUT" --proto '=http,https' \
      --proto-redir '=http,https' --url "$url"); then
      if [[ "$code" =~ ^[23][0-9][0-9]$ ]]; then
        printf 'OK %s %s\n' "$code" "$url"
        continue
      fi
    fi
    printf 'FAIL %s %s\n' "${code:-000}" "$url"
    failed=1
  done
done <<< "$URLS"
if (( count == 0 )); then
  printf 'No URLs supplied\n' >&2
  exit 2
fi
exit "$failed"
