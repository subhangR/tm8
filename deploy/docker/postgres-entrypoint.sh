#!/usr/bin/env bash
set -euo pipefail
data_dir=/var/lib/postgresql/data
if [[ $(id -u) == 0 ]]; then
  mkdir -p "$data_dir" /tmp/tm8-pg
  if [[ ! -f "$data_dir/PG_VERSION" && -f /legacy/.tm8-dev/pg/PG_VERSION ]]; then
    if [[ -f /legacy/.tm8-dev/pg/postmaster.pid ]]; then
      echo 'Stop the previous tm8 container before copying its PostgreSQL cluster.' >&2
      exit 1
    fi
    echo '[postgres] Copying the previous development cluster; the original is retained'
    cp -a /legacy/.tm8-dev/pg/. "$data_dir/"
  fi
  chown -R postgres:postgres "$data_dir" /tmp/tm8-pg
  chmod 700 "$data_dir"
  exec setpriv --reuid=postgres --regid=postgres --init-groups bash "$0"
fi
export PATH=/usr/lib/postgresql/16/bin:/usr/local/bin:/usr/bin:/bin
export LANG=C.UTF-8 LC_ALL=C.UTF-8
if [[ ! -f "$data_dir/PG_VERSION" ]]; then
  initdb -D "$data_dir" -U tm8 --encoding=UTF8 --locale=C.UTF-8 --auth-local=trust --auth-host=scram-sha-256 >/dev/null
fi
# Bootstrap connections are possible only inside this PostgreSQL container.
cat > "$data_dir/pg_hba.conf" <<'HBA'
local all all trust
host all all 127.0.0.1/32 trust
host all all ::1/128 trust
host all all 0.0.0.0/0 scram-sha-256
host all all ::/0 scram-sha-256
HBA
pg_ctl -D "$data_dir" -l /tmp/tm8-pg/bootstrap.log -w -o '-p 5442 -c listen_addresses=127.0.0.1 -c unix_socket_directories=/tmp/tm8-pg' start >/dev/null
trap 'pg_ctl -D "$data_dir" -m fast -w stop >/dev/null || true' EXIT
if [[ $(psql -X -U tm8 -h 127.0.0.1 -p 5442 -d postgres -Atc "select count(*) from pg_database where datname='tm8_dev'") == 0 ]]; then
  createdb -U tm8 -h 127.0.0.1 -p 5442 tm8_dev
fi
TM8_DATABASE_URL=postgres://tm8@127.0.0.1:5442/tm8_dev node /workspace/tm8/db/migrate.mjs up
node /workspace/tm8/deploy/docker/postgres-roles.mjs
pg_ctl -D "$data_dir" -m fast -w stop >/dev/null
trap - EXIT
touch /tmp/tm8-pg/ready
exec postgres -D "$data_dir" -p 5442 -c listen_addresses='*' -c unix_socket_directories=/tmp/tm8-pg
