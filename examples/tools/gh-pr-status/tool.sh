#!/usr/bin/env bash
set -euo pipefail

# Scope the declared credential to gh; do not rely on the node's gh login.
GH_TOKEN="$GITHUB_TOKEN" gh pr list --repo "$REPO" --state "$STATE" \
  --limit "$LIMIT" --json number,title,url,state,isDraft,statusCheckRollup
