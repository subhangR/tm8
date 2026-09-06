#!/usr/bin/env bash
set -euo pipefail

ENVFILE="${1:?usage: repair-ui-env.sh <env-file> <deploy-root>}"
DEPLOY_ROOT="${2:?usage: repair-ui-env.sh <env-file> <deploy-root>}"

set_env_value() {
  local key="$1"
  local value="$2"
  if grep -q "^${key}=" "$ENVFILE"; then
    sed -i "s|^${key}=.*|${key}=${value}|" "$ENVFILE"
  else
    printf '%s=%s\n' "$key" "$value" >> "$ENVFILE"
  fi
}

set_env_value TM8_UI_DIR "$DEPLOY_ROOT/packages/tm8-ui/redesign-1.0"
sed -i '/^TM8_UI_1_0_DIR=/d' "$ENVFILE"
set_env_value TM8_UI_2_0_DIR "$DEPLOY_ROOT/packages/tm8_ui_2.0/dist-2.0"
