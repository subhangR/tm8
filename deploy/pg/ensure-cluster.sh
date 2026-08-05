#!/usr/bin/env bash
# =============================================================================
# tm8 LOCAL Postgres cluster — make 5442 exist and be usable, idempotently.
#
#   ./deploy/pg/ensure-cluster.sh            # ensure running + roles + database
#   ./deploy/pg/ensure-cluster.sh --status   # report, change nothing
#   ./deploy/pg/ensure-cluster.sh --stop     # stop the cluster
#   ./deploy/pg/ensure-cluster.sh --db NAME  # also ensure NAME exists (repeatable)
#
# WHY THIS EXISTS
#
# Nothing in tm8 started a database. `packages/server/src/sidecar/` is a complete
# ten-file Postgres lifecycle subsystem — cluster.ts, health.ts, upgrade.ts, the
# lot — and it is imported by NOTHING (checked 2026-08-05: no file outside
# src/sidecar/ imports it). `deploy/prod/deploy.sh` therefore opens with an
# assertion that 5442 already answers, and dies if it does not. The cluster that
# has been serving prod was a hand-started postmaster that happened to still be
# up; a reboot ends it and every one-command story on this machine with it.
#
# This script is the missing half. It does NOT replace the sidecar subsystem —
# that one vendors its own binaries for shipping to end users. This is the
# developer-machine bootstrap: use the Homebrew PG that is already here.
#
# TRAPS ENCODED HERE (each one has cost someone a session)
#
#   * pg_isready is not a readiness check. It answers OK while authentication is
#     failing, so "the cluster is up" and "tm8 can use it" are different claims.
#     Every wait and every verify below is a REAL authenticated query.
#   * There are TWO Postgres clusters on this Mac — this one, and a PG17 at
#     /Library/PostgreSQL/17/data on the default 5432. A bare `psql` reaches the
#     WRONG one. Every call here carries an explicit URL with an explicit port.
#   * PG18 on macOS DIES AT STARTUP with `FATAL: postmaster became multithreaded
#     during startup` unless LC_ALL is set to a valid locale. Not at initdb — that
#     part succeeds and looks fine. macOS libc spawns a thread while resolving an
#     absent or invalid locale, and PG18 refuses to fork a multithreaded
#     postmaster. The cluster that has been serving prod only starts because the
#     human who launched it happened to have a locale in their shell; a launchd
#     job or a bare cron would not, which is exactly why "it worked when I ran it"
#     and "it comes back after a reboot" are different claims. So we export LC_ALL
#     explicitly for both initdb and pg_ctl instead of inheriting it.
#   * PG18 `initdb` also refuses some locale spellings outright. We ask for the
#     locale the existing cluster actually uses (en_US.UTF-8) and fall back to C
#     rather than dying, because a cluster with a working locale beats no cluster.
#   * We never initdb over a non-empty data dir, and never touch a cluster that
#     is already running. Two postmasters over one data dir is heap corruption.
# =============================================================================
set -euo pipefail

# The data dir is NOT a fresh path. ~/.tm8-dev/pg is where the live cluster —
# tm8_stable, tm8_staging and ~130 other databases — already lives, despite the
# "dev" in the name. Pointing this elsewhere creates a SECOND empty cluster and
# every existing database silently vanishes from view.
PGDATA_DIR="${TM8_PGDATA:-$HOME/.tm8-dev/pg}"
PGPORT_="${TM8_PG_PORT:-5442}"
SUPERUSER="${TM8_PG_SUPERUSER:-tm8}"
LOCALE_="${TM8_PG_LOCALE:-en_US.UTF-8}"
LOGFILE="${TM8_PG_LOG:-$HOME/.local/share/tm8-prod-logs/postgres.log}"

# Roles the tm8 schema and services expect. Observed on the live cluster
# 2026-08-05. `tm8_graph_owner` deliberately CANNOT log in — it owns objects.
# A missing role is the failure mode that passes every check and then dies on
# the first RPC that SET ROLEs to it.
ROLES_LOGIN=(tm8_app tm8_delivery_worker)
ROLES_NOLOGIN=(tm8_graph_owner)

DATABASES=()
MODE=ensure

while [[ $# -gt 0 ]]; do
  case "$1" in
    --status) MODE=status ;;
    --stop)   MODE=stop ;;
    --db)     shift; [[ $# -gt 0 ]] || { echo "--db needs a name" >&2; exit 2; }; DATABASES+=("$1") ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "ensure-cluster.sh: unknown flag $1 (try --help)" >&2; exit 2 ;;
  esac
  shift
done

BOLD=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; GRN=$'\033[32m'; YEL=$'\033[33m'; OFF=$'\033[0m'
info() { printf '      %s\n' "$*"; }
dim()  { printf '      %s%s%s\n' "$DIM" "$*" "$OFF"; }
ok()   { printf '      %s✓%s %s\n' "$GRN" "$OFF" "$*"; }
warn() { printf '      %s!%s %s\n' "$YEL" "$OFF" "$*"; }
die()  { printf '\n%serror:%s %s\n' "$RED" "$OFF" "$*" >&2; exit 1; }

# --- locate the binaries -----------------------------------------------------
# Pinned to the Homebrew keg, not to whatever a login shell resolves. `psql` on
# PATH is frequently the PG17 install's, which speaks to a different cluster and
# can be an older major than the data dir — refusing to start over PG18 data.
find_pgbin() {
  local c
  for c in "${TM8_PG_BIN:-}" \
           /opt/homebrew/opt/postgresql@18/bin \
           /opt/homebrew/opt/postgresql@17/bin \
           /usr/local/opt/postgresql@18/bin; do
    [[ -n "$c" && -x "$c/pg_ctl" && -x "$c/psql" ]] && { echo "$c"; return 0; }
  done
  # A running postmaster is authoritative about its own binaries even when no
  # keg matches — derive the bindir from its argv rather than giving up.
  local argv
  argv="$(ps -o command= -p "$(postmaster_pid || true)" 2>/dev/null | awk '{print $1}' || true)"
  if [[ -n "$argv" && -x "$(dirname "$argv")/psql" ]]; then dirname "$argv"; return 0; fi
  return 1
}

postmaster_pid() {
  [[ -r "$PGDATA_DIR/postmaster.pid" ]] || return 1
  local pid; pid="$(head -1 "$PGDATA_DIR/postmaster.pid" 2>/dev/null || true)"
  [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null && { echo "$pid"; return 0; }
  return 1
}

PGBIN="$(find_pgbin || true)"
[[ -n "$PGBIN" ]] || die "no PostgreSQL 18 binaries found.
      Install them:  brew install postgresql@18
      Or point at an existing install:  TM8_PG_BIN=/path/to/pg/bin $0"
PSQL="$PGBIN/psql"
PG_CTL="$PGBIN/pg_ctl"

su_url() { echo "postgres://$SUPERUSER@127.0.0.1:$PGPORT_/${1:-postgres}"; }

# The locale every PG18 invocation below runs under. NOT inherited: an empty or
# invalid LC_ALL is what triggers "postmaster became multithreaded during
# startup", and inheriting it makes the cluster's ability to boot depend on whose
# shell ran the script. Set once, exported to initdb and pg_ctl alike.
export LC_ALL="$LOCALE_"
export LANG="$LOCALE_"

# Setting LC_ALL to a locale this system does not have is just as fatal as leaving
# it empty, so confirm it against `locale -a` instead of trusting the constant.
# C always exists.
#
# Note the shape: `locale -a` is captured FIRST and matched second. The obvious
# `locale -a | grep -qixF "$LOCALE_"` is wrong under `set -o pipefail` — grep -q
# exits the instant it matches, `locale` dies of SIGPIPE, and pipefail reports the
# pipeline's last non-zero status. A successful match becomes a false negative,
# and the only symptom is a cluster quietly built with C collation instead of
# en_US.UTF-8 — different sort order, no error, found only by diffing two
# clusters. Same pipefail trap deploy.sh documents around legacy_supervisor_pids.
available_locales="$(locale -a 2>/dev/null || true)"
locale_available() {
  case $'\n'"$(echo "$available_locales" | tr 'A-Z' 'a-z')"$'\n' in
    *$'\n'"$(echo "$1" | tr 'A-Z' 'a-z')"$'\n'*) return 0 ;;
    *) return 1 ;;
  esac
}
if ! locale_available "$LOCALE_"; then
  warn "locale '$LOCALE_' is not available on this system — using C"
  LOCALE_=C
  export LC_ALL="$LOCALE_" LANG="$LOCALE_"
fi

# The real readiness test. Not pg_isready: that reports OK while auth fails, so
# it cannot distinguish "up" from "usable", and the difference is the whole bug.
can_query() { "$PSQL" "$(su_url)" -tAc 'select 1' >/dev/null 2>&1; }

# =============================================================================
# status / stop
# =============================================================================
if [[ "$MODE" == status ]]; then
  printf '\n%stm8 local Postgres%s  port %s  data %s\n' "$BOLD" "$OFF" "$PGPORT_" "$PGDATA_DIR"
  dim "binaries: $PGBIN"
  if pid="$(postmaster_pid)"; then ok "postmaster running (pid $pid)"; else warn "no postmaster for this data dir"; fi
  if can_query; then
    ok "authenticated query as '$SUPERUSER' succeeds"
    "$PSQL" "$(su_url)" -tAc "select '      db: '||datname from pg_database where datname in ('tm8_stable','tm8_staging') order by 1"
  else
    warn "cannot run an authenticated query as '$SUPERUSER' (this is what pg_isready would hide)"
  fi
  exit 0
fi

if [[ "$MODE" == stop ]]; then
  if postmaster_pid >/dev/null; then
    "$PG_CTL" -D "$PGDATA_DIR" -m fast stop && ok "cluster stopped"
  else
    ok "already stopped"
  fi
  exit 0
fi

# =============================================================================
# ensure
# =============================================================================
printf '\n%s[pg] ensure cluster%s  port %s  data %s\n' "$BOLD" "$OFF" "$PGPORT_" "$PGDATA_DIR"
dim "binaries: $PGBIN"

# --- 1. the data directory ---------------------------------------------------
if [[ -f "$PGDATA_DIR/PG_VERSION" ]]; then
  dim "existing cluster, PG_VERSION $(cat "$PGDATA_DIR/PG_VERSION")"
elif [[ -d "$PGDATA_DIR" ]] && [[ -n "$(ls -A "$PGDATA_DIR" 2>/dev/null)" ]]; then
  # Non-empty but no PG_VERSION: initdb would refuse anyway, and forcing it
  # would destroy whatever is in there. Stop and let a human look.
  die "$PGDATA_DIR is not empty but holds no PG_VERSION — refusing to initdb over it."
else
  info "initdb — creating a new cluster"
  mkdir -p "$PGDATA_DIR"
  # PG18 rejects some locale spellings. Ask for the one the real cluster uses,
  # then degrade to C rather than leaving the machine with no database at all.
  if ! "$PGBIN/initdb" -D "$PGDATA_DIR" -U "$SUPERUSER" \
        --encoding=UTF8 --locale="$LOCALE_" >/dev/null 2>&1; then
    warn "initdb refused locale '$LOCALE_' (a known PG18 behaviour) — retrying with C"
    # The retry must also RUN under C, not just be told --locale=C: the startup
    # multithreading check reads LC_ALL, not the cluster's recorded locale.
    LOCALE_=C; export LC_ALL=C LANG=C
    rm -rf "$PGDATA_DIR"; mkdir -p "$PGDATA_DIR"
    "$PGBIN/initdb" -D "$PGDATA_DIR" -U "$SUPERUSER" --encoding=UTF8 --locale=C >/dev/null \
      || die "initdb failed even with --locale=C"
  fi
  ok "cluster created, superuser '$SUPERUSER'"
fi

# --- 2. the postmaster -------------------------------------------------------
# Never start a second one over the same data dir. If it is already up we leave
# it strictly alone: bouncing it would drop every PTY-backed session's pool.
if pid="$(postmaster_pid)"; then
  ok "postmaster already running (pid $pid) — left untouched"
else
  mkdir -p "$(dirname "$LOGFILE")"
  info "starting postmaster on $PGPORT_ (log: $LOGFILE)"
  # Bind loopback only. This cluster holds every tm8 database on the machine and
  # has a passwordless superuser; it must not be reachable off-host.
  "$PG_CTL" -D "$PGDATA_DIR" -l "$LOGFILE" -w -t 60 \
      -o "-p $PGPORT_ -c listen_addresses=127.0.0.1" start >/dev/null \
    || die "pg_ctl start failed — read the tail of $LOGFILE"
  ok "postmaster started"
fi

# --- 3. wait for a REAL query ------------------------------------------------
# pg_ctl -w already waited, but it waits on pg_isready semantics. Auth can still
# be broken, and that failure surfaces later as "loading workspace" forever.
deadline=$((SECONDS + 30))
until can_query; do
  (( SECONDS < deadline )) || die "cluster is listening but '$SUPERUSER' cannot query it.
      This is exactly the state pg_isready calls healthy. Check $LOGFILE, and that
      role '$SUPERUSER' exists and pg_hba.conf trusts loopback."
  sleep 0.5
done
ok "authenticated query as '$SUPERUSER' succeeds"

# --- 4. roles ----------------------------------------------------------------
# Idempotent per role. A missing role passes every static check and then fails on
# the first RPC that SET ROLEs to it, which reads as an unrelated permissions bug.
for role in "${ROLES_LOGIN[@]}"; do
  if [[ "$("$PSQL" "$(su_url)" -tAc "select 1 from pg_roles where rolname='$role'")" == 1 ]]; then
    dim "role $role present"
  else
    "$PSQL" "$(su_url)" -qc "create role \"$role\" login" >/dev/null
    ok "role $role created (login)"
  fi
done
for role in "${ROLES_NOLOGIN[@]}"; do
  if [[ "$("$PSQL" "$(su_url)" -tAc "select 1 from pg_roles where rolname='$role'")" == 1 ]]; then
    dim "role $role present"
  else
    "$PSQL" "$(su_url)" -qc "create role \"$role\" nologin" >/dev/null
    ok "role $role created (nologin — it owns objects, it does not connect)"
  fi
done

# --- 5. databases ------------------------------------------------------------
# Created EMPTY only. Schema is `db/migrate.mjs up`'s job and nothing else's —
# the server does not migrate at boot, on purpose.
for db in "${DATABASES[@]:-}"; do
  [[ -n "$db" ]] || continue
  if [[ "$("$PSQL" "$(su_url)" -tAc "select 1 from pg_database where datname='$db'")" == 1 ]]; then
    dim "database $db present"
  else
    "$PSQL" "$(su_url)" -qc "create database \"$db\" owner \"$SUPERUSER\"" >/dev/null
    ok "database $db created EMPTY — it has no schema until \`node db/migrate.mjs up\` runs"
  fi
done

printf '\n      %spostgres ready%s  %s\n' "$GRN" "$OFF" "$(su_url)"
