#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
# Only this short-lived test process joins the database network namespace.
# The running web service keeps its restricted, non-superuser credentials.
task_pg=$(docker compose ps -q postgres)
task_app=$(docker compose ps -q tm8)
test -n "$task_pg" && test -n "$task_app"
task_options=(--user tm8)
if [[ ${1:-} == --docker ]]; then
  shift
  task_options=(--user root -v /var/run/docker.sock:/var/run/docker.sock -e TM8_TEST_DOCKER=1)
fi
docker run --rm --init --network "container:$task_pg" \
  --volumes-from "$task_app:ro" "${task_options[@]}" --workdir /workspace/tm8 \
  -e TM8_TEST_DATABASE_URL=postgres://tm8@127.0.0.1:5442/postgres \
  -e TM8_W1_ADMIN_DATABASE_URL=postgres://tm8@127.0.0.1:5442/postgres \
  -e TM8_PSQL=/usr/lib/postgresql/16/bin/psql \
  --entrypoint '' tm8-ubuntu24:dev "$@"
