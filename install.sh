#!/usr/bin/env bash
# =============================================================================
# tm8 INSTALL — one command from a fresh clone to a working tm8.
#
#   ./install.sh                        dev install, then RUN it (server + UI)
#   ./install.sh --no-start             install only, leave nothing running
#   ./install.sh --env prod --service   always-on install: systemd on Linux,
#                                        launchd on macOS — supervised + survives reboot
#   ./install.sh --env prod --systemd   the Linux spelling of --service (still works)
#   ./install.sh --status               what is installed and what is running
#   ./install.sh --reset                DROP the database and re-migrate (asks first)
#   ./install.sh --uninstall            stop + remove the service, keep the data
#   ./install.sh --dry-run              print every step, change nothing
#
# WHAT THIS FIXES
#
# Before this file there was NO install path in this repo — no script, no
# `bun run setup`, nothing. The advertised one-command story (`bun install &&
# bun run dev`) never created a database, because scripts/lib/env.mjs does not
# define TM8_DATABASE_URL, so a fresh clone booted a server that logged
#
#     graph: NOT CONFIGURED (set TM8_DATABASE_URL) — all operations answer 501
#
# and every one of the 80 catalog operations answered 501. The subsystem that was
# supposed to prevent this — packages/server/src/sidecar/, fourteen files of
# Postgres lifecycle management — is dead code: the only references to it from
# outside its own directory are `import type` in the scheduler, so nothing has
# ever constructed a SidecarManager and nothing in this repo has ever started a
# database. The comments in scripts/dev.mjs and scripts/start.mjs that say "the
# sidecar Postgres is started by tm8-server itself (R15)" describe code that does
# not run. Reviving it was considered and ruled against on 2026-08-12: tm8 uses
# the system Postgres, and this script is what puts it there.
#
# THE TWELVE THINGS A WORKING tm8 NEEDS, none of which were automated
#
#   1  node 22 + bun + a Postgres server and client of the same major
#   2  a running cluster on the slot's port, loopback-only
#   3  a superuser role that can connect over loopback without a password
#   4  loopback TRUST in pg_hba — not a nicety, see PHASE 3
#   5  the database, created empty
#   6  dependencies, plus node-pty's spawn-helper made executable
#   7  a tsc -b build AND a separate vite build (`bun run build` is tsc ONLY)
#   8  an env file carrying BOTH database URLs
#   9  the data and workspace directories
#  10  the 90-odd migrations applied — the server does NOT migrate at boot
#  11  something to keep the process alive
#  12  an agent CLI (claude or codex) the host is LOGGED IN to — tm8 stores no
#      agent credential, so a spawned session runs the host's login or nothing.
#      Checked in PHASE 1 (warn, never block) and authoritatively by `tm8 doctor`.
#
# Seeding is the one thing that already worked and still needs no step: once the
# schema is current and the server boots, the loopback auto-owner creates the
# first account and bootstrap/launch-resources seeds the teammate roster.
#
# PLATFORMS: Linux (Debian/Ubuntu, and RHEL family) and macOS via Homebrew.
# The macOS path HAS now been executed end to end on an Apple Silicon Mac
# (Homebrew, node 22, Postgres 18): install.sh --env private ran to exit 0 —
# cluster created/adopted, superuser + loopback trust in place, database
# migrated (131/131), server + UI built, and the node came up healthy on 7779.
# The one thing that used to NOT survive the Mac was a reboot: there was no
# service manager wired up, so both the Postgres cluster and the server were
# gone on Tuesday with nothing saying why. That gap is closed below — macOS now
# gets a launchd equivalent of the systemd path (--service / --systemd), so the
# cluster and the server come back at login and are restarted if they die.
# Debian remains this repo's CI machine; a Mac run is well-trodden now, but
# reading --dry-run first is still the cheapest way to see the whole plan.
# =============================================================================
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy/environments.sh
source "$HERE/deploy/environments.sh"

# --- output ------------------------------------------------------------------
BOLD=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; GRN=$'\033[32m'; YEL=$'\033[33m'; OFF=$'\033[0m'
if [[ ! -t 1 || -n "${NO_COLOR:-}" ]]; then BOLD=''; DIM=''; RED=''; GRN=''; YEL=''; OFF=''; fi

TOTAL_PHASES=11
phase_n=0
phase() { phase_n=$((phase_n + 1)); printf '\n%s[%d/%d] %s%s\n' "$BOLD" "$phase_n" "$TOTAL_PHASES" "$*" "$OFF"; }
info()  { printf '      %s\n' "$*"; }
dim()   { printf '      %s%s%s\n' "$DIM" "$*" "$OFF"; }
ok()    { printf '      %s✓%s %s\n' "$GRN" "$OFF" "$*"; }
warn()  { printf '      %s!%s %s\n' "$YEL" "$OFF" "$*"; }
die()   { printf '\n%serror:%s %s\n' "$RED" "$OFF" "$*" >&2; exit 1; }
# Confirmation that something was actually DONE. Silent under --dry-run, where a
# "✓ built" after building nothing is precisely the species of false success this
# installer exists to eliminate. Use ok() for observations, did() for actions.
did()   { (( DRY_RUN )) || ok "$@"; }

# --- flags -------------------------------------------------------------------
SLOT=dev
LAYOUT=""
DO_BUILD=1
DO_MIGRATE=1
# Start by default. An installer asked to "set tm8 up and make it running" that
# leaves you at a prompt has done most of a job: the last step is the one that
# tells you the other ten worked. --no-start opts out (CI, provisioning, or a
# build you intend to hand to systemd later).
DO_START=1
# A supervised, reboot-surviving service. The KIND is resolved from the platform
# after detection (systemd on Linux, launchd on macOS); the flags only record the
# intent. --systemd is the historical Linux spelling and stays working; --service
# is the neutral word that means the same thing on either OS.
USE_SERVICE=0
DRY_RUN=0
ASSUME_YES=0
CONFIGURE_HBA=""     # "" = only when we created the cluster; 1 = always; 0 = never
MODE=install

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env)          shift; [[ $# -gt 0 ]] || die "--env needs a value"; SLOT="$1" ;;
    --env=*)        SLOT="${1#*=}" ;;
    --service)      USE_SERVICE=1 ;;
    --systemd)      USE_SERVICE=1 ;;   # the Linux spelling of --service; still accepted
    --layout)       shift; [[ $# -gt 0 ]] || die "--layout needs a value"; LAYOUT="$1" ;;
    --start)        DO_START=1 ;;   # the default; accepted for explicitness
    --no-start)     DO_START=0 ;;
    --no-build)     DO_BUILD=0 ;;
    --no-migrate)   DO_MIGRATE=0 ;;
    --configure-pg-hba)    CONFIGURE_HBA=1 ;;
    --no-configure-pg-hba) CONFIGURE_HBA=0 ;;
    --status)       MODE=status ;;
    --reset)        MODE=reset ;;
    --uninstall)    MODE=uninstall ;;
    --print-env)    MODE=print-env ;;
    --dry-run)      DRY_RUN=1 ;;
    --yes|-y)       ASSUME_YES=1 ;;
    -h|--help)      sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)              die "unknown flag $1 (try --help)" ;;
  esac
  shift
done

tm8_env_load "$SLOT" || exit 2

# A Linux service implies the system layout (/opt, /etc, a system account) and
# vice versa, but each can be asked for alone: a --service install into a user
# checkout is a legitimate thing to want. macOS is different: its service is a
# per-user LaunchAgent that needs no root, so a macOS --service install stays in
# the USER layout (the clone, ~/.tm8-<slot>, ~/Library/LaunchAgents) rather than
# reaching for /opt and a system account that a laptop has no reason to grow.
if [[ -z "$LAYOUT" ]]; then
  if (( USE_SERVICE )) && [[ "$(uname -s)" != Darwin ]]; then LAYOUT=system; else LAYOUT=user; fi
fi
tm8_env_paths "$SLOT" "$LAYOUT" "$HERE" || exit 2

# prod and private serve a built bundle; dev and staging serve source through vite.
BUILD_UI="$TM8_ENV_BUILD_UI"

# --- run / dry-run -----------------------------------------------------------
# Every mutating command goes through `act`, so --dry-run is honest by
# construction rather than by remembering to check a flag at each call site.
act() {
  if (( DRY_RUN )); then
    printf '      %s(dry-run)%s %s\n' "$DIM" "$OFF" "$*"
    return 0
  fi
  "$@"
}

# The ambient tm8 SESSION identity, which must never reach the instance we are
# installing. Running this script from inside a tm8-spawned agent session is a
# completely ordinary thing to do — and such a session exports TM8_AGENT_TOKEN,
# TM8_BASE_URL, TM8_ACTOR_ID and friends, all pointing at the OTHER node that
# spawned it. Inherited, they make the verify step's CLI read fail with
# `unauthenticated: invalid token` against a server that is perfectly healthy,
# and they hand a freshly installed server a stranger's identity. `set -a; . envfile`
# does not help: it adds, it does not clear.
#
# Config the env FILE legitimately owns (TM8_PORT, TM8_DATABASE_URL, …) is not
# listed here — only the per-session identity a spawned agent carries.
TM8_SESSION_VARS=(
  TM8_AGENT_TOKEN TM8_BASE_URL TM8_ACTOR_ID TM8_SESSION_ID TM8_TEAM_MEMBER_ID
  TM8_SPACE_ID TM8_PROJECT_ID TM8_TASK_IDS TM8_MANIFEST_PATH TM8_JOURNAL_PATH
  TM8_MODE TM8_MODEL TM8_AGENT_TOOL TM8_GIT_LOGIN TM8_SESSION_COOKIE TM8_CLIENT_HEADER
)

# Build the `env -u A -u B …` prefix that strips them.
clean_env_prefix() {
  local v out=(env)
  for v in "${TM8_SESSION_VARS[@]}"; do out+=(-u "$v"); done
  printf '%s\n' "${out[@]}"
}

# Same, for a shell string (redirections, pipes).
act_sh() {
  if (( DRY_RUN )); then
    printf '      %s(dry-run)%s %s\n' "$DIM" "$OFF" "$1"
    return 0
  fi
  bash -c "$1"
}

# --- privilege ---------------------------------------------------------------
# Installing Postgres, creating a cluster and writing a unit file need root.
# A dev install into your own clone does not. So root is acquired only where it
# is needed, and its absence is reported as an exact command to run rather than
# as a failure two phases later.
IS_ROOT=0; [[ "$(id -u)" -eq 0 ]] && IS_ROOT=1
HAVE_SUDO=0
if (( ! IS_ROOT )) && command -v sudo >/dev/null && sudo -n true 2>/dev/null; then
  HAVE_SUDO=1
fi

# Run as root, or explain. Returns 1 without running when root is unavailable,
# so the caller can print a precise hint and stop.
as_root() {
  # --dry-run must never abort on a privilege it was never going to use. Showing
  # the WHOLE plan is the entire point of the flag: stopping at the first
  # root-only step hides every step after it, which on a system-layout install is
  # most of them.
  if (( DRY_RUN )); then
    printf '      %s(dry-run, as root)%s %s\n' "$DIM" "$OFF" "$*"
    return 0
  fi
  if (( IS_ROOT )); then act "$@"; return $?; fi
  if (( HAVE_SUDO )); then act sudo "$@"; return $?; fi
  return 1
}

need_root_hint() {
  warn "this step needs root and passwordless sudo is not available"
  info "run it yourself, then re-run this installer:"
  printf '        sudo %s\n' "$*"
}

# --- platform ----------------------------------------------------------------
PLATFORM=unknown
PKG=none
case "$(uname -s)" in
  Linux)
    PLATFORM=linux
    if   command -v apt-get >/dev/null; then PKG=apt
    elif command -v dnf     >/dev/null; then PKG=dnf
    elif command -v yum     >/dev/null; then PKG=yum
    fi
    ;;
  Darwin)
    PLATFORM=macos
    command -v brew >/dev/null && PKG=brew
    ;;
esac

# The service manager this platform speaks. --service and --systemd both request
# "a supervised, reboot-surviving instance"; which manager provides it is a
# property of the OS, not of the flag. Linux → systemd units; macOS → launchd
# LaunchAgents. A macOS box has no systemctl, so --systemd there resolves to
# launchd too rather than dying on a word.
SERVICE_KIND=none
case "$PLATFORM" in
  linux) SERVICE_KIND=systemd ;;
  macos) SERVICE_KIND=launchd ;;
esac

# =============================================================================
# helpers used by more than one phase
# =============================================================================

# Postgres client binaries for the standard major, wherever this platform keeps
# them. Order matters: an explicit TM8_PSQL wins, then the versioned path for the
# standard major, then any PATH psql LAST. A bare `psql` is frequently an older
# linked formula pointing at a different cluster, and pg_dump — unlike psql —
# refuses to talk to a server newer than itself.
find_psql() {
  local m="$TM8_ENV_PG_MAJOR" c
  for c in "${TM8_PSQL:-}" \
           "/usr/lib/postgresql/$m/bin/psql" \
           "/opt/homebrew/opt/postgresql@$m/bin/psql" \
           "/usr/local/opt/postgresql@$m/bin/psql" \
           "/usr/pgsql-$m/bin/psql" \
           "$(command -v psql 2>/dev/null || true)"; do
    [[ -n "$c" && -x "$c" ]] && { echo "$c"; return 0; }
  done
  return 1
}

# The real readiness test. NOT pg_isready: it reports OK while authentication is
# failing, so "the cluster is up" and "tm8 can use it" are different claims and
# only the second one matters. Every wait and verify below is an authenticated
# query.
can_query() {
  local url="$1"
  [[ -n "${PSQL:-}" ]] || return 1
  "$PSQL" "$url" -tAc 'select 1' >/dev/null 2>&1
}

# One scalar out of Postgres, or empty.
pg_scalar() {
  local url="$1" sql="$2"
  "$PSQL" "$url" -tAc "$sql" 2>/dev/null | head -1 | tr -d '[:space:]' || true
}

# A superuser psql invocation on this cluster, however we can get one.
# Sets SU_KIND=url|sudo and SU_URL / SU_SUDO_USER.
#
# Debian's pg_createcluster makes `postgres` the superuser with peer auth for the
# postgres OS user, so `sudo -u postgres psql` works before any TCP role exists.
# Homebrew's initdb makes the INSTALLING USER the superuser instead. Neither is
# the `tm8` role tm8's URLs use, so finding a way in is a real step.
SU_KIND=""; SU_URL=""; SU_SUDO_USER=""
find_superuser() {
  local port="$1" cand
  for cand in "$TM8_ENV_SUPERUSER" postgres "$(id -un)"; do
    [[ -n "$cand" ]] || continue
    if can_query "postgres://$cand@127.0.0.1:$port/postgres"; then
      SU_KIND=url; SU_URL="postgres://$cand@127.0.0.1:$port/postgres"
      return 0
    fi
  done
  # Peer auth as the postgres OS user — the Debian path before a TCP role exists.
  if (( IS_ROOT )) || (( HAVE_SUDO )); then
    local runner=(sudo -u postgres); (( IS_ROOT )) && runner=(runuser -u postgres --)
    if "${runner[@]}" "$PSQL" -p "$port" -tAc 'select 1' >/dev/null 2>&1; then
      SU_KIND=sudo; SU_SUDO_USER=postgres
      return 0
    fi
  fi
  return 1
}

# Run SQL as the superuser found above.
su_sql() {
  local sql="$1"
  case "$SU_KIND" in
    url)  act "$PSQL" "$SU_URL" -v ON_ERROR_STOP=1 -qc "$sql" ;;
    sudo)
      if (( IS_ROOT )); then act runuser -u "$SU_SUDO_USER" -- "$PSQL" -p "$TM8_ENV_PG_PORT" -v ON_ERROR_STOP=1 -qc "$sql"
      else act sudo -u "$SU_SUDO_USER" "$PSQL" -p "$TM8_ENV_PG_PORT" -v ON_ERROR_STOP=1 -qc "$sql"; fi
      ;;
    *) die "no superuser access to the cluster on $TM8_ENV_PG_PORT" ;;
  esac
}

# Read a scalar as the superuser found above (never routed through `act`: reads
# must still happen under --dry-run or every later decision is made blind).
su_scalar() {
  local sql="$1"
  case "$SU_KIND" in
    url)  "$PSQL" "$SU_URL" -tAc "$sql" 2>/dev/null | head -1 | tr -d '[:space:]' || true ;;
    sudo)
      if (( IS_ROOT )); then runuser -u "$SU_SUDO_USER" -- "$PSQL" -p "$TM8_ENV_PG_PORT" -tAc "$sql" 2>/dev/null | head -1 | tr -d '[:space:]' || true
      else sudo -u "$SU_SUDO_USER" "$PSQL" -p "$TM8_ENV_PG_PORT" -tAc "$sql" 2>/dev/null | head -1 | tr -d '[:space:]' || true; fi
      ;;
  esac
}

# Which node to run the server with. The major must match what CI builds and
# tests on (22) because that is the only major node-pty's N-API prebuilds are
# proven against here; the PATH is resolved rather than hardcoded, because an
# absolute path encodes one machine's layout and fails as "no node at …" instead
# of "wrong node" the day a package manager moves it.
find_node() {
  local c
  for c in "${TM8_NODE_BIN:-}" \
           "$(command -v node 2>/dev/null || true)" \
           /usr/bin/node \
           "$HOME/.local/bin/node" \
           /opt/homebrew/opt/node@22/bin/node; do
    [[ -n "$c" && -x "$c" ]] || continue
    [[ "$("$c" -p 'process.versions.node.split(".")[0]' 2>/dev/null)" == 22 ]] && { echo "$c"; return 0; }
  done
  return 1
}

# The env file's contents. ONE definition, used by the install and by
# --print-env, so a hand-written /etc/tm8/<slot>.env cannot drift from what the
# installer would have produced.
render_env_file() {
  cat <<ENVFILE
# tm8 ${TM8_ENV_NAME} — generated by install.sh on $(date -u '+%Y-%m-%dT%H:%M:%SZ').
# Regenerate with: ./install.sh --env ${TM8_ENV_NAME} --print-env
#
# Ports, database and paths come from deploy/environments.sh — the one table.
# Edit there, not here, or the next install will disagree with this file.

TM8_ENV=${TM8_ENV_SERVER_ENV}
TM8_BIND=127.0.0.1
TM8_PORT=${TM8_ENV_SERVER_PORT}
TM8_PG_PORT=${TM8_ENV_PG_PORT}
TM8_LOG_LEVEL=${TM8_ENV_LOG_LEVEL}

# The two variables without which every operation answers 501. Their absence
# from .env.example was the single most expensive omission in onboarding.
#
# TM8_DELIVERY_DATABASE_URL must AUTHENTICATE as tm8_delivery_worker — being
# able to SET ROLE to it is not enough; the server asserts the distinction. That
# is why loopback trust is an install step.
TM8_DATABASE_URL=${TM8_ENV_DATABASE_URL}
TM8_DELIVERY_DATABASE_URL=${TM8_ENV_DELIVERY_URL}

TM8_DATA_DIR=${TM8_ENV_DATA_DIR}
TM8_PROJECT_DIR=${TM8_ENV_PROJECT_DIR}

# Serve the built UI from the server itself, so the API origin is also a working
# app origin and no proxy is required to see something.
TM8_UI_DIR=${TM8_ENV_CHECKOUT}/packages/tm8_ui_2.0/dist

TM8_LAUNCH_BOOTSTRAP=1
TM8_SESSION_CAP=unlimited

# Two switches every working tm8 instance sets, for reasons that are not obvious:
#
# TM8_IDEMPOTENCY_ENABLED=0 — the ledger gate refuses saves from the authoring
#   lane's \`au-<n>\` clientMutationIds, which reset on every page load and walk
#   back onto ids already bound to a different operation. This also re-hides the
#   silent-replay path; the real fix is unique ids upstream.
# TM8_PREVIEW_ENABLED=0 — TM8_PREVIEW_PORT is a fixed 4613 that another instance
#   holds, so the listener dies with EADDRINUSE anyway. Worse, setting
#   config.preview makes http/security.ts DELETE \`localhost\` from this node's own
#   host allowlist, and every browser reaching the UI as localhost is then
#   refused with \`Host "localhost:PORT" is not this node\`.
TM8_IDEMPOTENCY_ENABLED=0
TM8_PREVIEW_ENABLED=0
ENVFILE
}

# The systemd unit. Matches the units actually running on the box
# (User=tm8, EnvironmentFile=/etc/tm8/<slot>.env, After=postgresql@<major>-<cluster>).
# The unit this replaces, deploy/tm8-server.service, was wrong in four ways at
# once: User=ubuntu, WorkingDirectory=/home/ubuntu/tm8-workspace, an ExecStart
# under /opt/tm8/current, and Requires=postgresql.service — a unit name that does
# not exist on a machine with per-cluster units. None of those paths or users
# have ever existed here.
render_unit_file() {
  cat <<UNIT
[Unit]
Description=tm8 ${TM8_ENV_NAME} server (${TM8_ENV_SERVER_PORT})
After=network-online.target postgresql@${TM8_ENV_PG_MAJOR}-${TM8_ENV_PG_CLUSTER}.service
Wants=network-online.target

[Service]
Type=simple
User=${TM8_ENV_RUN_USER}
Group=${TM8_ENV_RUN_USER}
WorkingDirectory=${TM8_ENV_CHECKOUT}
EnvironmentFile=${TM8_ENV_ENVFILE}
ExecStart=${NODE_BIN} --enable-source-maps ${TM8_ENV_CHECKOUT}/packages/server/dist/index.js
Restart=always
RestartSec=3
KillSignal=SIGTERM
TimeoutStopSec=20

[Install]
WantedBy=multi-user.target
UNIT
}

UNIT_NAME="tm8-${SLOT}.service"

# =============================================================================
# launchd — the macOS equivalent of the systemd path.
#
# WHY LaunchAgent, NOT LaunchDaemon. The dev/private slots are a user's own
# laptop. A LaunchDaemon runs as root out of /Library/LaunchDaemons and needs
# sudo to install; a per-user LaunchAgent runs as the logged-in user out of
# ~/Library/LaunchAgents and needs nothing. tm8 binds loopback only and stores
# its data under $HOME — there is no reason to hand it root. A LaunchDaemon also
# starts at BOOT (before login), which is wrong for a user's Postgres living in
# ~/.tm8: it should come up when the user logs in, which is exactly RunAtLoad in
# the gui/<uid> domain. So: LaunchAgent, user domain, no root. (A shared server
# Mac wanting boot-time start would be a LaunchDaemon under the system layout —
# not built here because this repo's always-on server is the Linux one.)
#
# TWO jobs, mirroring the two things that did not survive a reboot:
#   com.tm8.<slot>.postgres   the cluster (postmaster in the foreground)
#   com.tm8.<slot>.server     the node server
# launchd has no "After=" between agents, so the server does not formally wait
# for Postgres. It does not need to: KeepAlive restarts the server until the
# cluster answers, so the boot race self-heals within a ThrottleInterval.
LA_DIR="$HOME/Library/LaunchAgents"
LAUNCHD_PG_LABEL="com.tm8.${SLOT}.postgres"
LAUNCHD_SERVER_LABEL="com.tm8.${SLOT}.server"
LAUNCHD_PG_PLIST="$LA_DIR/$LAUNCHD_PG_LABEL.plist"
LAUNCHD_SERVER_PLIST="$LA_DIR/$LAUNCHD_SERVER_LABEL.plist"
LAUNCHD_DOMAIN="gui/$(id -u)"

# XML-escape a value before it is interpolated into a plist <string>. A plist is
# XML, so an unescaped & < or > in a path, username, URL or slot name makes the
# file malformed — and launchd does NOT reject that at write time, it fails at
# LOAD time, i.e. the next login: the exact reboot this file exists to survive.
# "Your node does not come back because your home dir has an ampersand in it" is
# the class of bug this whole path is fixing, so every interpolated <string> goes
# through here. Ampersand FIRST — escaping it after < / > would double-escape the
# entities they produce.
xml_escape() {
  local s="$1"
  s="${s//&/&amp;}"
  s="${s//</&lt;}"
  s="${s//>/&gt;}"
  printf '%s' "$s"
}

# The cluster's data dir on macOS — the same default phase 2 uses when it
# initdbs one. Overridable with TM8_PGDATA for a cluster that lives elsewhere.
macos_pgdata() { printf '%s' "${TM8_PGDATA:-$HOME/.tm8/pg-$SLOT}"; }

# The `postgres` binary that MATCHES the cluster on disk. A postmaster refuses to
# open a data dir written by a different major, so we read PG_VERSION and pick the
# matching keg rather than trusting whichever `postgres` is first on PATH — on a
# box with both postgresql@16 and @18 linked, guessing is a coin flip that fails
# as "database files are incompatible with server". Falls back to the sibling of
# the psql we already found, then to a PATH lookup.
macos_postgres_bin() {
  local data major c
  data="$(macos_pgdata)"
  if [[ -r "$data/PG_VERSION" ]]; then
    major="$(tr -dc '0-9' < "$data/PG_VERSION")"
    for c in "/opt/homebrew/opt/postgresql@$major/bin/postgres" \
             "/usr/local/opt/postgresql@$major/bin/postgres"; do
      [[ -x "$c" ]] && { printf '%s' "$c"; return 0; }
    done
  fi
  # No cluster yet (fresh initdb) or no versioned keg: the postgres beside psql is
  # the one this install would create the cluster with, so it matches by
  # construction.
  c="$(dirname "${PSQL:-}")/postgres"
  [[ -x "$c" ]] && { printf '%s' "$c"; return 0; }
  c="$(command -v postgres 2>/dev/null || true)"
  [[ -n "$c" ]] && { printf '%s' "$c"; return 0; }
  return 1
}

# The per-slot env, as it belongs INSIDE a plist's <EnvironmentVariables>. Same
# source as the env file (render_env_file), so the two cannot drift: strip the
# comments and blank lines, keep the KEY=VALUE lines. launchd has no
# EnvironmentFile=, so this dict IS how the slot's config reaches the process —
# and because it lists ONLY these keys, an ambient TM8_AGENT_TOKEN in the shell
# that ran install cannot ride along in it.
plist_env_dict() {
  local line key val
  render_env_file | while IFS= read -r line; do
    case "$line" in
      TM8_*=*) ;;
      *) continue ;;
    esac
    key="${line%%=*}"; val="${line#*=}"
    printf '    <key>%s</key><string>%s</string>\n' "$(xml_escape "$key")" "$(xml_escape "$val")"
  done
}

# The Postgres LaunchAgent. Runs the postmaster in the FOREGROUND (not `pg_ctl
# start`, which daemonises and returns — launchd must own the long-lived
# process, or KeepAlive has nothing to keep alive). LC_ALL/LANG are set
# EXPLICITLY: an empty or invalid locale makes macOS libc spawn a thread while
# resolving it, and Postgres refuses to fork a multithreaded postmaster. A
# launchd job inherits no shell locale, so without this the cluster that started
# fine by hand fails to come back after a reboot — the precise "it worked when I
# ran it" vs "it survives a reboot" gap this file exists to close.
render_launchd_postgres_plist() {
  local pgdata pgbin label port
  pgdata="$(xml_escape "$(macos_pgdata)")"
  pgbin="$(xml_escape "$(macos_postgres_bin || echo postgres)")"
  label="$(xml_escape "$LAUNCHD_PG_LABEL")"
  port="$(xml_escape "$TM8_ENV_PG_PORT")"
  cat <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${pgbin}</string>
    <string>-D</string><string>${pgdata}</string>
    <string>-p</string><string>${port}</string>
    <string>-c</string><string>listen_addresses=127.0.0.1</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>LC_ALL</key><string>en_US.UTF-8</string>
    <key>LANG</key><string>en_US.UTF-8</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>StandardOutPath</key><string>${pgdata}/postmaster.log</string>
  <key>StandardErrorPath</key><string>${pgdata}/postmaster.log</string>
</dict>
</plist>
PLIST
}

# The server LaunchAgent. ProgramArguments is `env -u <session vars> node …`:
# the strip is the launchd counterpart of the clean_env_prefix the foreground
# path uses. It is belt-and-suspenders — launchd does not inject the invoking
# shell's environment into a bootstrapped job — but it is not decoration: anyone
# who has run `launchctl setenv TM8_AGENT_TOKEN …` has put that token in the
# gui/<uid> domain, and every job in that domain would then inherit it. The strip
# guarantees the server gets THIS node's identity and nobody else's regardless.
# EnvironmentVariables carries the slot config (there is no EnvironmentFile= in
# launchd) plus a PATH that includes Homebrew and node@22 — a bare launchd PATH
# is /usr/bin:/bin only, and a server that spawns agent PTYs needs `node`, `bun`
# and `tm8` to be findable by what it spawns.
render_launchd_server_plist() {
  local nodedir strip w label node checkout logbase
  nodedir="$(xml_escape "$(dirname "$NODE_BIN")")"
  label="$(xml_escape "$LAUNCHD_SERVER_LABEL")"
  node="$(xml_escape "$NODE_BIN")"
  checkout="$(xml_escape "$TM8_ENV_CHECKOUT")"
  logbase="$(xml_escape "$HOME/Library/Logs/tm8-${SLOT}-server")"
  strip=""
  for w in "${TM8_SESSION_VARS[@]}"; do strip+="    <string>-u</string><string>$(xml_escape "$w")</string>
"; done
  cat <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/env</string>
${strip}    <string>${node}</string>
    <string>--enable-source-maps</string>
    <string>${checkout}/packages/server/dist/index.js</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${nodedir}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
$(plist_env_dict)
  </dict>
  <key>WorkingDirectory</key><string>${checkout}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>3</integer>
  <key>StandardOutPath</key><string>${logbase}.out.log</string>
  <key>StandardErrorPath</key><string>${logbase}.err.log</string>
</dict>
</plist>
PLIST
}

# Load / reload a plist into the user domain. bootout-then-bootstrap is the
# idempotent shape: bootstrap alone errors with "service already loaded" on a
# re-run, and a plain reload does not pick up a rewritten plist. A leading
# bootout of a not-loaded label is a harmless no-op we swallow.
launchd_bootstrap() {
  local plist="$1" label="$2"
  launchctl bootout "$LAUNCHD_DOMAIN/$label" 2>/dev/null || true
  launchctl bootstrap "$LAUNCHD_DOMAIN" "$plist"
}

# Stop and unload a job (used by --uninstall and by a re-install of the same
# slot). Never removes the plist — that is the caller's explicit act.
launchd_bootout() {
  local label="$1"
  launchctl bootout "$LAUNCHD_DOMAIN/$label" 2>/dev/null || true
}

# "active/inactive (pid)" for a label, the launchd analogue of systemctl
# is-active. `launchctl print` carries the live pid and last exit code; a job
# with a pid is running, one without is loaded-but-stopped or crashed.
launchd_status() {
  local label="$1" out pid
  out="$(launchctl print "$LAUNCHD_DOMAIN/$label" 2>/dev/null || true)"
  [[ -n "$out" ]] || { printf 'not loaded'; return; }
  pid="$(printf '%s' "$out" | sed -n 's/.*"*pid"* *= *\([0-9][0-9]*\).*/\1/p' | head -1)"
  if [[ -n "$pid" ]]; then printf 'active (pid %s)' "$pid"; else printf 'loaded, not running'; fi
}

# =============================================================================
# --print-env: emit the env file and stop
# =============================================================================
if [[ "$MODE" == print-env ]]; then
  render_env_file
  exit 0
fi

# =============================================================================
# --status
# =============================================================================
if [[ "$MODE" == status ]]; then
  printf '\n%stm8 %s%s\n' "$BOLD" "$SLOT" "$OFF"
  printf '      checkout   %s\n' "$TM8_ENV_CHECKOUT"
  # -e before -r. /etc/tm8/<slot>.env is root-owned, so a non-root reader gets
  # "not readable" — reporting that as MISSING sends someone off to recreate a
  # file that is already there and correct.
  if   [[ -r "$TM8_ENV_ENVFILE" ]]; then envstate='(present)'
  elif [[ -e "$TM8_ENV_ENVFILE" ]]; then envstate='(present, not readable by you)'
  else                                   envstate='(MISSING)'; fi
  printf '      env file   %s %s\n' "$TM8_ENV_ENVFILE" "$envstate"
  printf '      server     http://127.0.0.1:%s\n' "$TM8_ENV_SERVER_PORT"
  [[ -n "$TM8_ENV_PROXY_PORT" ]] && printf '      open       http://127.0.0.1:%s\n' "$TM8_ENV_PROXY_PORT"
  printf '      database   %s\n' "$TM8_ENV_DATABASE_URL"

  PSQL="$(find_psql || true)"
  if [[ -z "$PSQL" ]]; then
    warn "no psql found for major $TM8_ENV_PG_MAJOR — cannot report on the database"
  else
    dim "psql: $PSQL"
    if can_query "$TM8_ENV_DATABASE_URL"; then
      ok "authenticated query on $TM8_ENV_DATABASE succeeds"
      applied="$(pg_scalar "$TM8_ENV_DATABASE_URL" \
        "select count(*) from applied_migrations" )"
      if [[ -n "$applied" ]]; then
        # Count against the TARGET checkout, not the installer's own. Running
        # `./install.sh --env prod --status` from a feature branch otherwise
        # compares that branch's migration count to prod's database and reports
        # a drift that says more about where you are standing than about prod.
        total="$(ls -1 "$TM8_ENV_CHECKOUT"/db/migrations/*.sql 2>/dev/null | wc -l | tr -d ' ')"
        if   [[ "$total" == 0 ]];        then dim "migrations $applied applied (no checkout at $TM8_ENV_CHECKOUT to compare against)"
        elif [[ "$applied" == "$total" ]]; then ok "migrations $applied/$total applied"
        else warn "migrations $applied applied, $total in $TM8_ENV_CHECKOUT — run: node db/migrate.mjs up"; fi
      else
        warn "no applied_migrations table — the database has no schema yet"
      fi
      if can_query "$TM8_ENV_DELIVERY_URL"; then
        ok "tm8_delivery_worker can authenticate (message delivery will work)"
      else
        warn "tm8_delivery_worker CANNOT authenticate — messages will be stored but never pushed to a live terminal"
      fi
    else
      warn "cannot query $TM8_ENV_DATABASE_URL — is the cluster on $TM8_ENV_PG_PORT up?"
    fi
  fi

  # Build artifacts. A server build without a UI build is the classic silent
  # half-deploy: the API is new and the app is whatever was there before.
  [[ -f "$TM8_ENV_CHECKOUT/packages/server/dist/index.js" ]] \
    && ok "server build present" || warn "no server build (packages/server/dist/index.js)"
  if (( BUILD_UI )); then
    [[ -f "$TM8_ENV_CHECKOUT/packages/tm8_ui_2.0/dist/index.html" ]] \
      && ok "UI bundle present" || warn "no UI bundle (packages/tm8_ui_2.0/dist/index.html)"
  fi

  if command -v systemctl >/dev/null && systemctl list-unit-files "$UNIT_NAME" >/dev/null 2>&1; then
    printf '      unit       %s %s\n' "$UNIT_NAME" "$(systemctl is-active "$UNIT_NAME" 2>/dev/null || echo inactive)"
  fi

  # launchd jobs, on macOS. A half-installed service that --status cannot see is
  # worse than none, so a plist on disk is reported whether or not it is loaded,
  # and a loaded job that lost its plist is flagged rather than hidden.
  if [[ "$PLATFORM" == macos ]] && command -v launchctl >/dev/null; then
    for pair in "postgres:$LAUNCHD_PG_LABEL:$LAUNCHD_PG_PLIST" "server:$LAUNCHD_SERVER_LABEL:$LAUNCHD_SERVER_PLIST"; do
      which="${pair%%:*}"; rest="${pair#*:}"; label="${rest%%:*}"; plist="${rest#*:}"
      loaded="$(launchd_status "$label")"
      if [[ -f "$plist" ]]; then
        printf '      launchd    %-22s %s\n' "$label" "$loaded"
      elif [[ "$loaded" != "not loaded" ]]; then
        printf '      launchd    %-22s %s (no plist at %s — orphaned)\n' "$label" "$loaded" "$plist"
      fi
    done
  fi

  health="$(curl -fsS --max-time 3 "http://127.0.0.1:$TM8_ENV_SERVER_PORT/health" 2>/dev/null || true)"
  case "$health" in
    *'"db"'*ok*) ok "health on $TM8_ENV_SERVER_PORT — db:ok" ;;
    '')          warn "nothing answering on $TM8_ENV_SERVER_PORT" ;;
    *)           warn "health on $TM8_ENV_SERVER_PORT — $health" ;;
  esac
  echo
  exit 0
fi

# =============================================================================
# --uninstall
# =============================================================================
if [[ "$MODE" == uninstall ]]; then
  printf '\n%stm8 %s — uninstall%s\n' "$BOLD" "$SLOT" "$OFF"
  info "this stops and removes the service. The database, the data directory and"
  info "the checkout are LEFT ALONE — removing data is a separate, explicit act."
  if (( ! ASSUME_YES )) && (( ! DRY_RUN )); then
    printf '\n      type %suninstall %s%s to proceed: ' "$BOLD" "$SLOT" "$OFF"
    read -r reply
    [[ "$reply" == "uninstall $SLOT" ]] || die "aborted — nothing was changed."
  fi
  removed_any=0
  if command -v systemctl >/dev/null && systemctl list-unit-files "$UNIT_NAME" >/dev/null 2>&1; then
    as_root systemctl disable --now "$UNIT_NAME" || need_root_hint "systemctl disable --now $UNIT_NAME"
    as_root rm -f "/etc/systemd/system/$UNIT_NAME" || need_root_hint "rm -f /etc/systemd/system/$UNIT_NAME"
    as_root systemctl daemon-reload || true
    ok "$UNIT_NAME removed"
    removed_any=1
  fi
  # macOS: bootout and remove BOTH tm8 LaunchAgents. Both are ours and both were
  # registered by --service, so both are "the service" here. The cluster is
  # therefore stopped — but its data dir and database are LEFT ALONE, same as the
  # Linux path leaves the database behind.
  if [[ "$PLATFORM" == macos ]] && command -v launchctl >/dev/null; then
    for pair in "$LAUNCHD_SERVER_LABEL:$LAUNCHD_SERVER_PLIST" "$LAUNCHD_PG_LABEL:$LAUNCHD_PG_PLIST"; do
      label="${pair%%:*}"; plist="${pair#*:}"
      if [[ -f "$plist" ]] || launchctl print "$LAUNCHD_DOMAIN/$label" >/dev/null 2>&1; then
        if (( DRY_RUN )); then
          dim "(dry-run) would bootout $label and rm $plist"
        else
          launchd_bootout "$label"
          rm -f "$plist"
          ok "$label removed"
        fi
        removed_any=1
      fi
    done
  fi
  (( removed_any )) || info "no tm8 $SLOT service to remove"
  printf '\n      %sstill on disk:%s database %s, data %s, checkout %s\n' \
    "$DIM" "$OFF" "$TM8_ENV_DATABASE" "$TM8_ENV_DATA_DIR" "$TM8_ENV_CHECKOUT"
  [[ "$PLATFORM" == macos ]] && printf '      %s%s%s  cluster data %s (the cluster is now stopped)\n' \
    "$DIM" " " "$OFF" "$(macos_pgdata)"
  exit 0
fi

# =============================================================================
# install / reset
# =============================================================================
started_at=$(date +%s)
printf '\n%stm8 install%s  env %s · %s layout · %s\n' "$BOLD" "$OFF" "$SLOT" "$LAYOUT" "$PLATFORM"
dim "server $TM8_ENV_SERVER_PORT · pg $TM8_ENV_PG_PORT · database $TM8_ENV_DATABASE"
dim "checkout $TM8_ENV_CHECKOUT"
(( DRY_RUN )) && printf '      %s--dry-run: nothing will be changed%s\n' "$YEL" "$OFF"

# A system slot installs from /opt/tm8/<slot>, which is NOT the tree this script
# was invoked from, and nothing here clones it. Checked before phase 1 so the run
# stops on a one-line message instead of `cd: /opt/tm8/prod: No such file or
# directory` at phase 5, with Postgres already installed by then.
if [[ ! -d "$TM8_ENV_CHECKOUT" ]]; then
  die "no checkout at $TM8_ENV_CHECKOUT.
      The $SLOT slot installs from there, not from the directory you ran this in.
      Create it first, then re-run:
        git clone <this repo> $TM8_ENV_CHECKOUT"
fi

# --- PHASE 1: prerequisites --------------------------------------------------
phase "Prerequisites"

if [[ "$PLATFORM" == unknown ]]; then
  die "unsupported platform $(uname -s). tm8 installs on Linux and macOS."
fi

NODE_BIN="$(find_node || true)"
if [[ -z "$NODE_BIN" ]]; then
  found="$(command -v node >/dev/null && node --version || echo none)"
  die "node 22 is required (found: $found).
      packages/server and packages/execution load node-pty; CI builds and tests
      on major 22, so that is the major prod runs. Install it:
        Debian/Ubuntu  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs
        macOS          brew install node@22
      Or point at one: TM8_NODE_BIN=/path/to/node $0"
fi
ok "node $("$NODE_BIN" -p 'process.versions.node') ($NODE_BIN)"

command -v bun >/dev/null || die "bun is required (the workspace uses bun workspaces).
      Install it:  curl -fsSL https://bun.sh/install | bash"
ok "bun $(bun --version)"

command -v git  >/dev/null || die "git is required"
command -v curl >/dev/null || die "curl is required (the installer verifies over HTTP)"

# Postgres CLIENT. Install it if we can; otherwise say exactly what to run.
PSQL="$(find_psql || true)"
if [[ -z "$PSQL" ]]; then
  m="$TM8_ENV_PG_MAJOR"
  case "$PKG" in
    apt)  installed=0
          as_root apt-get update -qq && as_root apt-get install -y "postgresql-$m" "postgresql-client-$m" && installed=1
          if (( ! installed )); then
            need_root_hint "apt-get install -y postgresql-$m postgresql-client-$m"
            die "Postgres $m is not installed and this installer cannot install it."
          fi ;;
    dnf|yum)
          as_root "$PKG" install -y "postgresql$m-server" "postgresql$m" \
            || { need_root_hint "$PKG install -y postgresql$m-server postgresql$m"
                 die "Postgres $m is not installed and this installer cannot install it."; } ;;
    brew) act brew install "postgresql@$m" \
            || die "brew install postgresql@$m failed" ;;
    *)    die "Postgres $m is not installed and no supported package manager was found.
      Install Postgres $m and its client, then re-run." ;;
  esac
  PSQL="$(find_psql || true)"
  [[ -n "$PSQL" ]] || { (( DRY_RUN )) && PSQL=psql || die "still no psql after installing Postgres $TM8_ENV_PG_MAJOR"; }
fi
ok "psql $("$PSQL" --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+' | head -1 || echo '?') ($PSQL)"

# pg_dump must not be OLDER than the server, or every backup fails. psql
# tolerates the skew and pg_dump does not, so check the pair now rather than
# discovering it during a deploy's backup step.
PG_DUMP="$(dirname "$PSQL")/pg_dump"
if [[ -x "$PG_DUMP" ]]; then
  ok "pg_dump beside psql ($("$PG_DUMP" --version | grep -oE '[0-9]+' | head -1))"
else
  warn "no pg_dump beside $PSQL — backups before a migration will not be possible"
fi

# The AGENT CLI — the twelfth thing a working tm8 needs, and the one that was
# invisible here. tm8 never asks for, stores or checks an agent credential: a
# spawned session runs the HOST's `claude` or `codex` and inherits whatever
# login the machine already has (or does not). So a node can pass every check
# above — cluster, migrations, build, a real catalog read — and still not run a
# single agent, and the failure is QUIET: the session sits at "running" while
# only the terminal carries the refusal.
#
# WARN, never block. tm8 is useful without an agent (browsing the graph, the
# CLI, message history), and refusing to install over a missing agent CLI would
# be a worse outcome than saying so loudly. The authoritative check — presence
# AND login, honouring TM8_AGENT_CMD — is `tm8 doctor`; this phase runs before
# the CLI is built, so it is the early, cheap surfacing of the same fact, and it
# points there.
if [[ -n "${TM8_AGENT_CMD:-}" ]]; then
  acmd_bin="${TM8_AGENT_CMD%% *}"
  if command -v "$acmd_bin" >/dev/null 2>&1 || [[ -x "$acmd_bin" ]]; then
    ok "agent CLI: TM8_AGENT_CMD=$TM8_AGENT_CMD (found)"
  else
    warn "TM8_AGENT_CMD=$TM8_AGENT_CMD but '$acmd_bin' is not on PATH — every spawn would die with exit 127"
  fi
else
  agent_found=0
  if command -v claude >/dev/null 2>&1; then
    agent_found=1
    if [[ -f "$HOME/.claude.json" ]] && grep -q '"oauthAccount"' "$HOME/.claude.json" 2>/dev/null; then
      ok "agent CLI: claude ($(command -v claude)) — authenticated"
    else
      # Claude Code can keep its token in the login Keychain, which is not
      # cheaply readable here, so unknown is reported as unknown, not as broken.
      ok "agent CLI: claude ($(command -v claude)) — present; login state unknown (verify: tm8 doctor)"
    fi
  fi
  if command -v codex >/dev/null 2>&1; then
    agent_found=1
    if [[ -f "${CODEX_HOME:-$HOME/.codex}/auth.json" ]]; then
      ok "agent CLI: codex ($(command -v codex)) — authenticated"
    else
      warn "agent CLI: codex ($(command -v codex)) — present but NOT authenticated (run: codex login)"
    fi
  fi
  if (( ! agent_found )); then
    warn "no agent CLI found (claude or codex) — tm8 will install fine but cannot run an agent."
    info "a tm8 session runs the host's claude/codex; with neither installed every spawn"
    info "sits at \"running\" and never finishes, the refusal visible only in the terminal."
    info "install one and log in, then re-check with 'tm8 doctor':"
    printf '        npm i -g @anthropic-ai/claude-code    # then run: claude       (to log in)\n'
    printf '        npm i -g @openai/codex                 # then run: codex login\n'
  fi
fi

# --- PHASE 2: the cluster ----------------------------------------------------
phase "Postgres cluster on $TM8_ENV_PG_PORT"

CREATED_CLUSTER=0
cluster_listening() {
  "$PSQL" "postgres://127.0.0.1:$TM8_ENV_PG_PORT/postgres" -tAc 'select 1' >/dev/null 2>&1 && return 0
  # A refused ROLE still proves a listener; only a refused CONNECTION does not.
  local err
  err="$("$PSQL" "postgres://127.0.0.1:$TM8_ENV_PG_PORT/postgres" -tAc 'select 1' 2>&1 || true)"
  case "$err" in
    *"could not connect"*|*"Connection refused"*|*"could not translate"*) return 1 ;;
    '') return 1 ;;
    *) return 0 ;;
  esac
}

if cluster_listening; then
  ok "a cluster is already listening on $TM8_ENV_PG_PORT — adopting it"
  # macOS service install: make sure the adopted cluster is under launchd so it
  # survives a reboot. If launchd already owns it, this just refreshes the plist;
  # if a hand-started postmaster holds the port, we do NOT fight it — the plist is
  # written and takes over the next time the port is free (a reboot, or a manual
  # bootstrap once you stop the hand-started one).
  if (( USE_SERVICE )) && [[ "$PLATFORM" == macos ]]; then
    if (( DRY_RUN )); then
      dim "(dry-run) would install LaunchAgent $LAUNCHD_PG_LABEL for the adopted cluster"
    else
      act mkdir -p "$LA_DIR"
      render_launchd_postgres_plist > "$LAUNCHD_PG_PLIST"
      if launchctl print "$LAUNCHD_DOMAIN/$LAUNCHD_PG_LABEL" >/dev/null 2>&1; then
        ok "launchd already supervises the cluster ($LAUNCHD_PG_LABEL)"
      else
        warn "a postmaster is running on $TM8_ENV_PG_PORT that launchd does not own"
        info "wrote $LAUNCHD_PG_PLIST — it supervises the cluster after the current"
        info "postmaster stops (a reboot), or now with:"
        printf '        launchctl bootstrap %s %s\n' "$LAUNCHD_DOMAIN" "$LAUNCHD_PG_PLIST"
      fi
    fi
  fi
else
  info "nothing on $TM8_ENV_PG_PORT — creating a cluster"
  case "$PLATFORM" in
    linux)
      if command -v pg_createcluster >/dev/null; then
        # Debian/Ubuntu: a managed cluster, so it gets a systemd unit
        # (postgresql@<major>-<name>) and comes back after a reboot. That is the
        # whole difference between this and the hand-started postmaster that used
        # to serve this box and would not have survived one.
        as_root pg_createcluster --port "$TM8_ENV_PG_PORT" "$TM8_ENV_PG_MAJOR" "$TM8_ENV_PG_CLUSTER" \
          || { need_root_hint "pg_createcluster --port $TM8_ENV_PG_PORT $TM8_ENV_PG_MAJOR $TM8_ENV_PG_CLUSTER"; die "cannot create the cluster"; }
        as_root systemctl enable --now "postgresql@$TM8_ENV_PG_MAJOR-$TM8_ENV_PG_CLUSTER" \
          || { need_root_hint "systemctl enable --now postgresql@$TM8_ENV_PG_MAJOR-$TM8_ENV_PG_CLUSTER"; die "cannot start the cluster"; }
        CREATED_CLUSTER=1
        did "cluster $TM8_ENV_PG_MAJOR/$TM8_ENV_PG_CLUSTER created and enabled"
      else
        die "no pg_createcluster on this Linux. Install the postgresql-common tools
      (Debian/Ubuntu: apt-get install postgresql-common) or create a cluster on
      $TM8_ENV_PG_PORT yourself and re-run — an existing cluster is adopted."
      fi
      ;;
    macos)
      # Homebrew keeps postgresql@N keg-only and its `brew services` cluster is
      # on 5432, so tm8 gets its own data dir rather than sharing that one.
      PGDATA_DIR="${TM8_PGDATA:-$HOME/.tm8/pg-$SLOT}"
      PGBIN="$(dirname "$PSQL")"
      if [[ ! -f "$PGDATA_DIR/PG_VERSION" ]]; then
        if [[ -d "$PGDATA_DIR" && -n "$(ls -A "$PGDATA_DIR" 2>/dev/null)" ]]; then
          die "$PGDATA_DIR is not empty but holds no PG_VERSION — refusing to initdb over it."
        fi
        act mkdir -p "$PGDATA_DIR"
        # LC_ALL is exported explicitly, never inherited. An empty or invalid
        # locale makes macOS libc spawn a thread while resolving it, and Postgres
        # refuses to fork a multithreaded postmaster — so the cluster's ability
        # to START depends on whose shell ran initdb. A launchd job or a bare
        # cron has no locale, which is exactly why "it worked when I ran it" and
        # "it comes back after a reboot" are different claims.
        act_sh "export LC_ALL=en_US.UTF-8 LANG=en_US.UTF-8
                '$PGBIN/initdb' -D '$PGDATA_DIR' -U '$TM8_ENV_SUPERUSER' --encoding=UTF8 --locale=en_US.UTF-8 >/dev/null 2>&1 \
                || { export LC_ALL=C LANG=C; rm -rf '$PGDATA_DIR'; mkdir -p '$PGDATA_DIR'
                     '$PGBIN/initdb' -D '$PGDATA_DIR' -U '$TM8_ENV_SUPERUSER' --encoding=UTF8 --locale=C >/dev/null; }"
      fi
      if (( USE_SERVICE )); then
        # launchd owns the postmaster from the start, so "it started" and "it
        # survives a reboot" are the same event rather than two — the exact gap
        # the plain pg_ctl path below leaves open. The postmaster runs in the
        # foreground under launchd (see render_launchd_postgres_plist).
        if (( DRY_RUN )); then
          dim "(dry-run) would install and bootstrap LaunchAgent $LAUNCHD_PG_LABEL to run the postmaster"
        else
          act mkdir -p "$LA_DIR"
          render_launchd_postgres_plist > "$LAUNCHD_PG_PLIST"
          launchd_bootstrap "$LAUNCHD_PG_PLIST" "$LAUNCHD_PG_LABEL" \
            || die "launchctl bootstrap $LAUNCHD_PG_LABEL failed"
        fi
        CREATED_CLUSTER=1
        did "cluster started under launchd — $LAUNCHD_PG_LABEL (survives login/reboot)"
      else
        act_sh "export LC_ALL=en_US.UTF-8 LANG=en_US.UTF-8
                '$PGBIN/pg_ctl' -D '$PGDATA_DIR' -l '$PGDATA_DIR/postmaster.log' -w -t 60 \
                  -o '-p $TM8_ENV_PG_PORT -c listen_addresses=127.0.0.1' start >/dev/null"
        CREATED_CLUSTER=1
        did "cluster started from $PGDATA_DIR"
        warn "no service manager wired up — this cluster will NOT come back after a reboot."
        info "for one that does, re-run with --service (installs a launchd LaunchAgent);"
        info "or restart it by hand: $PGBIN/pg_ctl -D $PGDATA_DIR -o '-p $TM8_ENV_PG_PORT' start"
      fi
      ;;
  esac
fi

if (( ! DRY_RUN )); then
  deadline=$((SECONDS + 60))
  until cluster_listening; do
    (( SECONDS < deadline )) || die "nothing is listening on $TM8_ENV_PG_PORT after 60s"
    sleep 1
  done
fi

# --- PHASE 3: superuser + loopback auth --------------------------------------
phase "Superuser role and loopback authentication"

# WHY THIS PHASE IS NOT OPTIONAL, and why it is the subtle one:
#
# Migrations 001 and 015 create tm8_graph_owner, tm8_app and tm8_delivery_worker
# with LOGIN and no password. The server's delivery path must AUTHENTICATE as
# tm8_delivery_worker over TCP — packages/server/src/facade/services/w2/
# execution.ts rejects a connection that can only SET ROLE to it. With Debian's
# default pg_hba (`host all all 127.0.0.1/32 scram-sha-256`) a passwordless role
# simply cannot log in, so messages get stored and never pushed to a live
# terminal: a failure with no error anywhere, which reads as "delivery is flaky".
#
# So loopback must be TRUST. That is safe only because the cluster binds
# 127.0.0.1 and nothing else, which is asserted below rather than assumed.
if (( DRY_RUN )); then
  dim "(dry-run) would ensure role $TM8_ENV_SUPERUSER and loopback trust"
else
  find_superuser "$TM8_ENV_PG_PORT" \
    || die "no superuser access to the cluster on $TM8_ENV_PG_PORT.
      Tried roles '$TM8_ENV_SUPERUSER', 'postgres', '$(id -un)' over TCP, and peer
      auth as the postgres OS user. Grant one of those and re-run."
  dim "superuser access via ${SU_KIND}${SU_URL:+ $SU_URL}${SU_SUDO_USER:+ (peer as $SU_SUDO_USER)}"

  if [[ "$(su_scalar "select 1 from pg_roles where rolname='$TM8_ENV_SUPERUSER'")" == 1 ]]; then
    ok "role $TM8_ENV_SUPERUSER present"
  else
    su_sql "create role \"$TM8_ENV_SUPERUSER\" login superuser createdb createrole"
    ok "role $TM8_ENV_SUPERUSER created (superuser — it owns the schema and runs migrations)"
  fi
fi

# pg_hba: check first, change only when allowed.
hba_path=""
if (( ! DRY_RUN )); then
  hba_path="$(su_scalar 'show hba_file')"
fi

hba_trusts_loopback() {
  [[ -n "$hba_path" && -r "$hba_path" ]] || return 2      # cannot tell
  # pg_hba is FIRST MATCH WINS, so the presence of a trust line proves nothing:
  # it has to be the first rule matching a loopback host connection. A trust line
  # sitting below the distribution's default `host all all 127.0.0.1/32
  # scram-sha-256` never fires, phase 4 dies with `fe_sendauth: no password
  # supplied`, and every re-run still reports "already trusts loopback".
  local first
  first="$(grep -E '^[[:space:]]*host(ssl|nossl)?[[:space:]]+all[[:space:]]+all[[:space:]]+(127\.0\.0\.1/32|::1/128|samehost)[[:space:]]+' "$hba_path" | head -n 1)"
  [[ -n "$first" ]] || return 1
  [[ "$first" =~ [[:space:]]trust([[:space:]]|$) ]]
}

want_hba=0
if [[ "$CONFIGURE_HBA" == 1 ]]; then want_hba=1
elif [[ "$CONFIGURE_HBA" == 0 ]]; then want_hba=0
elif (( CREATED_CLUSTER )); then want_hba=1              # our cluster, our rules
fi

if (( DRY_RUN )); then
  dim "(dry-run) would verify loopback trust in pg_hba.conf"
elif hba_trusts_loopback; then
  ok "pg_hba already trusts loopback"
else
  rc=$?
  if (( want_hba )); then
    # Bind loopback ONLY before trusting loopback. In this order, never the
    # reverse: a cluster that trusts every host and listens on all of them has
    # no authentication at all, and this one holds every tm8 database on the
    # machine behind a passwordless superuser.
    listen="$(su_scalar 'show listen_addresses')"
    case "$listen" in
      127.0.0.1|localhost|127.0.0.1,*|*,127.0.0.1) ;;
      *) su_sql "alter system set listen_addresses = '127.0.0.1'"
         warn "listen_addresses was '$listen' — set to 127.0.0.1 (needs a RESTART, not a reload)"
         as_root systemctl restart "postgresql@$TM8_ENV_PG_MAJOR-$TM8_ENV_PG_CLUSTER" 2>/dev/null \
           || warn "restart the cluster yourself for listen_addresses to take effect" ;;
    esac
    if [[ -n "$hba_path" ]]; then
      # Prepended, never appended: pg_hba takes the FIRST matching rule, so below
      # the distribution's default scram-sha-256 lines these two would be dead
      # config. Rewritten through the original path so mode and owner survive.
      act_sh "printf '# tm8: loopback trust. tm8_app and tm8_delivery_worker are created by\n# migrations 001/015 with LOGIN and no password, and the delivery path must\n# AUTHENTICATE as tm8_delivery_worker rather than SET ROLE to it. Safe only\n# because listen_addresses is 127.0.0.1.\n# These sit at the top because pg_hba is first match wins.\nhost all all 127.0.0.1/32 trust\nhost all all ::1/128 trust\n\n' | cat - '$hba_path' > '$hba_path.tm8-new' && cat '$hba_path.tm8-new' > '$hba_path' && rm -f '$hba_path.tm8-new'"
      as_root systemctl reload "postgresql@$TM8_ENV_PG_MAJOR-$TM8_ENV_PG_CLUSTER" 2>/dev/null \
        || act "$PSQL" "${SU_URL:-postgres://$TM8_ENV_SUPERUSER@127.0.0.1:$TM8_ENV_PG_PORT/postgres}" -qc 'select pg_reload_conf()' >/dev/null 2>&1 \
        || warn "could not reload the cluster — reload it for pg_hba to take effect"
      ok "loopback trust added to $hba_path"
    else
      warn "could not locate pg_hba.conf — add loopback trust by hand"
    fi
  else
    if (( rc == 2 )); then
      warn "cannot read pg_hba.conf ($hba_path) — unable to confirm loopback trust"
    else
      warn "pg_hba does NOT trust loopback on this adopted cluster"
    fi
    info "tm8_delivery_worker is created passwordless by migration 015, so without"
    info "trust it cannot authenticate and messages are stored but never delivered."
    info "Add to ${hba_path:-pg_hba.conf}, then reload:"
    printf '        host all all 127.0.0.1/32 trust\n'
    info "Or re-run with --configure-pg-hba to have this installer do it."
  fi
fi

# --- PHASE 4: the database ---------------------------------------------------
phase "Database $TM8_ENV_DATABASE"

if (( DRY_RUN )); then
  dim "(dry-run) would create database $TM8_ENV_DATABASE if absent"
elif [[ "$(su_scalar "select 1 from pg_database where datname='$TM8_ENV_DATABASE'")" == 1 ]]; then
  ok "database $TM8_ENV_DATABASE present"
else
  su_sql "create database \"$TM8_ENV_DATABASE\" owner \"$TM8_ENV_SUPERUSER\""
  ok "database $TM8_ENV_DATABASE created EMPTY — it has no schema until phase 10"
fi

if [[ "$MODE" == reset ]]; then
  warn "--reset will DROP database $TM8_ENV_DATABASE and everything in it"
  if (( ! ASSUME_YES )) && (( ! DRY_RUN )); then
    printf '\n      type %sdrop %s%s to proceed: ' "$BOLD" "$TM8_ENV_DATABASE" "$OFF"
    read -r reply
    [[ "$reply" == "drop $TM8_ENV_DATABASE" ]] || die "aborted — nothing was dropped."
  fi
  su_sql "drop database if exists \"$TM8_ENV_DATABASE\" with (force)"
  su_sql "create database \"$TM8_ENV_DATABASE\" owner \"$TM8_ENV_SUPERUSER\""
  ok "database recreated empty"
fi

if (( ! DRY_RUN )); then
  can_query "$TM8_ENV_DATABASE_URL" \
    || die "created the database but cannot query $TM8_ENV_DATABASE_URL.
      This is the state pg_isready calls healthy. Check loopback trust in pg_hba (phase 3)."
  ok "authenticated query on $TM8_ENV_DATABASE succeeds"
fi

# --- PHASE 5: dependencies ---------------------------------------------------
phase "Dependencies"
cd "$TM8_ENV_CHECKOUT"
if [[ -d node_modules ]] && [[ -f bun.lock ]] && [[ node_modules -nt bun.lock ]]; then
  ok "node_modules is newer than bun.lock — skipping install"
else
  act bun install || die "bun install failed"
  did "bun install"
fi

# node-pty's spawn-helper must be executable or EVERY PTY spawn dies with
# "posix_spawnp failed", which reaches a user as a bare 503 on
# /v2/execution/spawn — a symptom that names nothing. bun extracts npm tarballs
# without the exec bit, so this is lost on every install; the root postinstall
# repairs it, and this asserts the repair actually happened.
act bash scripts/repair-node-pty.sh >/dev/null 2>&1 || true
if (( ! DRY_RUN )); then
  bad=0
  while IFS= read -r helper; do
    [[ -x "$helper" ]] || { warn "not executable: $helper"; bad=1; }
  done < <(find node_modules -path '*/node-pty/prebuilds/*/spawn-helper' -not -path '*/win32-*/*' 2>/dev/null)
  (( bad )) && die "node-pty's spawn-helper is not executable — every PTY spawn would fail.
      Fix: bash scripts/repair-node-pty.sh"
  ok "node-pty spawn-helper executable"
fi

# --- PHASE 6: build ----------------------------------------------------------
phase "Build"
if (( DO_BUILD )); then
  info "tsc -b (contract → cli) …"
  act bun run build || die "tsc -b failed — fix the type errors above and re-run"
  did "server + CLI built"
  # `bun run build` is tsc ONLY. Prod serves TM8_UI_DIR=packages/tm8_ui_2.0/dist, so
  # skipping this second build ships a stale UI against a new server with no
  # error anywhere — the classic silent half-deploy.
  if (( BUILD_UI )); then
    info "vite build (a SEPARATE build — \`bun run build\` does not touch the UI) …"
    act_sh "cd '$TM8_ENV_CHECKOUT/packages/tm8_ui_2.0' && bun run build" \
      || die "vite build failed"
    (( DRY_RUN )) || [[ -f packages/tm8_ui_2.0/dist/index.html ]] \
      || die "vite build reported success but packages/tm8_ui_2.0/dist/index.html is missing"
    did "UI bundle built"
  else
    dim "$SLOT serves the UI with vite dev against source — no bundle needed"
  fi
  (( DRY_RUN )) || [[ -f packages/server/dist/index.js ]] \
    || die "build produced no packages/server/dist/index.js"
else
  warn "skipped (--no-build)"
fi

# --- PHASE 7: env file -------------------------------------------------------
phase "Environment file $TM8_ENV_ENVFILE"
# -e, not -r. /etc/tm8/<slot>.env is root-owned, so a non-root run cannot READ a
# perfectly good prod env file — and testing readability would send this branch
# down the "write a new one" path and clobber the live configuration of a running
# instance. Existence is the question being asked; readability is not.
#
# ASSUME_YES does NOT override this. --yes means "do not stop to ask me", not
# "overwrite the file prod is currently running on".
if [[ -e "$TM8_ENV_ENVFILE" ]]; then
  warn "$TM8_ENV_ENVFILE already exists — leaving it alone"
  info "see what this installer would write:  $0 --env $SLOT --print-env"
  info "to replace it, move the old one aside first"
else
  envdir="$(dirname "$TM8_ENV_ENVFILE")"
  if [[ "$LAYOUT" == system ]]; then
    # The env file installs as 0640 root:<run-user> and the data dirs are chowned
    # to it, but nothing has ever created that account. On a clean host the first
    # install dies right here with `install: invalid group 'tm8'` — after Postgres
    # is already installed and migrated. Create it: a system account with nologin,
    # which is exactly what the rendered unit expects to run as.
    if (( DRY_RUN )); then
      getent passwd "$TM8_ENV_RUN_USER" >/dev/null \
        && dim "run user $TM8_ENV_RUN_USER present" \
        || dim "(dry-run) would create the system account $TM8_ENV_RUN_USER"
    else
      getent group "$TM8_ENV_RUN_USER" >/dev/null \
        || as_root groupadd --system "$TM8_ENV_RUN_USER" \
        || { need_root_hint "groupadd --system $TM8_ENV_RUN_USER"
             die "cannot create group $TM8_ENV_RUN_USER"; }
      getent passwd "$TM8_ENV_RUN_USER" >/dev/null \
        || as_root useradd --system --gid "$TM8_ENV_RUN_USER" \
             --home-dir "$TM8_ENV_CHECKOUT" --shell /usr/sbin/nologin "$TM8_ENV_RUN_USER" \
        || { need_root_hint "useradd --system --gid $TM8_ENV_RUN_USER --home-dir $TM8_ENV_CHECKOUT --shell /usr/sbin/nologin $TM8_ENV_RUN_USER"
             die "cannot create user $TM8_ENV_RUN_USER"; }
      ok "run user $TM8_ENV_RUN_USER present"
    fi
    as_root mkdir -p "$envdir" || need_root_hint "mkdir -p $envdir"
    if (( DRY_RUN )); then
      dim "(dry-run) would write $TM8_ENV_ENVFILE"
    else
      tmp="$(mktemp)"; render_env_file > "$tmp"
      # 0640 root:<run-user>, not 0600 root:root. The units read this file as
      # root via EnvironmentFile= so 0600 works for systemd — but it also makes
      # the file unreadable to the service user, and every recipe of the form
      # `runuser -u tm8 -- . /etc/tm8/prod.env` then fails with "Permission
      # denied". Readable by the group that runs tm8 is the shape that works for
      # both.
      as_root install -m 0640 -o root -g "$TM8_ENV_RUN_USER" "$tmp" "$TM8_ENV_ENVFILE" \
        || { rm -f "$tmp"; need_root_hint "install -m 0640 -o root -g $TM8_ENV_RUN_USER <rendered> $TM8_ENV_ENVFILE"
             die "cannot write $TM8_ENV_ENVFILE"; }
      rm -f "$tmp"
      ok "$TM8_ENV_ENVFILE written (0640 root:$TM8_ENV_RUN_USER)"
    fi
  else
    if (( DRY_RUN )); then dim "(dry-run) would write $TM8_ENV_ENVFILE"
    else
      render_env_file > "$TM8_ENV_ENVFILE"
      chmod 0600 "$TM8_ENV_ENVFILE"
      ok "$TM8_ENV_ENVFILE written"
      dim "scripts/dev.mjs reads .env.<env>.local ahead of .env, so this wins locally"
    fi
  fi
fi

# --- PHASE 8: data directories ----------------------------------------------
phase "Data directories"
for d in "$TM8_ENV_DATA_DIR" "$TM8_ENV_PROJECT_DIR"; do
  if [[ -d "$d" ]]; then
    dim "$d present"
  elif [[ "$LAYOUT" == system ]]; then
    as_root mkdir -p "$d" && as_root chown "$TM8_ENV_RUN_USER:$TM8_ENV_RUN_USER" "$d" \
      || { need_root_hint "mkdir -p $d && chown $TM8_ENV_RUN_USER:$TM8_ENV_RUN_USER $d"; die "cannot create $d"; }
    did "$d created (owned by $TM8_ENV_RUN_USER)"
  else
    act mkdir -p "$d"
    did "$d created"
  fi
done

# --- PHASE 9: migrations -----------------------------------------------------
phase "Migrations"
if (( DO_MIGRATE )); then
  total="$(ls -1 "$TM8_ENV_CHECKOUT"/db/migrations/*.sql 2>/dev/null | wc -l | tr -d ' ')"
  info "$total migration files on disk; forward-only and checksum-locked"
  # As the SUPERUSER url, not the service's. A tm8_app URL gets "permission
  # denied for schema public" trying to create applied_migrations.
  act_sh "cd '$TM8_ENV_CHECKOUT' && TM8_DATABASE_URL='$TM8_ENV_SUPERUSER_URL' TM8_PSQL='$PSQL' '$NODE_BIN' db/migrate.mjs up" \
    || die "migration failed. The database is left as the last successful file
      left it (one transaction per file), so fix forward and re-run."
  did "schema current"
else
  warn "skipped (--no-migrate) — the server will refuse to start on a schema mismatch"
fi

# --- PHASE 10: service -------------------------------------------------------
phase "Service"
if (( USE_SERVICE )) && [[ "$SERVICE_KIND" == systemd ]]; then
  command -v systemctl >/dev/null || die "--systemd asked for but systemctl is not present"
  unit_path="/etc/systemd/system/$UNIT_NAME"
  if (( DRY_RUN )); then
    dim "(dry-run) would write $unit_path and enable $UNIT_NAME"
    render_unit_file | sed 's/^/      | /'
  else
    tmp="$(mktemp)"; render_unit_file > "$tmp"
    as_root install -m 0644 -o root -g root "$tmp" "$unit_path" \
      || { rm -f "$tmp"; need_root_hint "install -m 0644 <rendered> $unit_path"; die "cannot write $unit_path"; }
    rm -f "$tmp"
    as_root systemctl daemon-reload || die "systemctl daemon-reload failed"
    # systemctl is still the verb used HERE, because this runs as root and a
    # restart is what is meant. The unit is Restart=always now, so `kill -TERM`
    # is also a correct restart for an operator without passwordless sudo —
    # which is what made the old on-failure setting dangerous: it left SIGKILL
    # as the only working restart, and SIGKILL runs no shutdown handler, so
    # nothing recorded why the live agents died (171).
    as_root systemctl enable "$UNIT_NAME" || die "systemctl enable $UNIT_NAME failed"
    # `restart`, NOT `enable --now`. `--now` only STARTS a unit that is stopped,
    # so on the case this installer exists to serve — upgrading a node that is
    # already running — it does nothing at all. The old process keeps serving,
    # against the schema this run just migrated and the UI bundle it just built,
    # and phase 11 then confirms a healthy `/health` from that very process. The
    # run reports success and the new code is never loaded.
    # `restart` starts a stopped unit and recycles a running one, which is the
    # only verb that means "load what I just built" in both cases.
    as_root systemctl restart "$UNIT_NAME" || die "systemctl restart $UNIT_NAME failed"
    ok "$UNIT_NAME installed, enabled and (re)started"
    dim "logs: journalctl -u $UNIT_NAME -f"
  fi
elif (( USE_SERVICE )) && [[ "$SERVICE_KIND" == launchd ]]; then
  # The server LaunchAgent. Postgres was already handed to launchd in phase 2, so
  # this is the second of the two jobs. RunAtLoad + KeepAlive means it comes up at
  # login and is restarted if it dies — the launchd analogue of enable --now with
  # Restart. KeepAlive here is UNCONDITIONAL (restart on any exit), which is the
  # right choice, and it is what the systemd side now does too: `Restart=always`
  # plus a clean exit 0 brings the unit back, so a signal "restart" is a real
  # restart. (Under the old `Restart=on-failure` it silently stopped the unit
  # instead.) launchd's KeepAlive=true brings the server back even after a clean
  # exit, so a node that shuts down cleanly on a transient DB blip is restarted
  # rather than left down. Stopping it is `launchctl bootout`, which --uninstall
  # and a re-install both do.
  if (( DRY_RUN )); then
    dim "(dry-run) would write $LAUNCHD_SERVER_PLIST and bootstrap $LAUNCHD_SERVER_LABEL"
    render_launchd_server_plist | sed 's/^/      | /'
  else
    act mkdir -p "$LA_DIR" "$HOME/Library/Logs"
    render_launchd_server_plist > "$LAUNCHD_SERVER_PLIST"
    launchd_bootstrap "$LAUNCHD_SERVER_PLIST" "$LAUNCHD_SERVER_LABEL" \
      || die "launchctl bootstrap $LAUNCHD_SERVER_LABEL failed"
    ok "$LAUNCHD_SERVER_LABEL installed, loaded and started"
    dim "logs: tail -f $HOME/Library/Logs/tm8-${SLOT}-server.err.log"
    dim "control: launchctl print $LAUNCHD_DOMAIN/$LAUNCHD_SERVER_LABEL"
  fi
else
  dim "no service installed (use --service for an always-on, reboot-surviving instance)"
fi

# --- PHASE 11: verify --------------------------------------------------------
phase "Verify"

start_foreground_hint() {
  printf '\n      %sstart it:%s\n' "$BOLD" "$OFF"
  if [[ "$SLOT" == dev ]]; then
    printf '        bun run dev                      # server on %s + vite UI on %s\n' \
      "$TM8_ENV_SERVER_PORT" "$TM8_ENV_VITE_PORT"
  else
    printf '        set -a; . %s; set +a\n' "$TM8_ENV_ENVFILE"
    printf '        %s --enable-source-maps packages/server/dist/index.js\n' "$NODE_BIN"
  fi
}

verify_running() {
  local waited=0 body=''
  while (( waited < 60 )); do
    body="$(curl -fsS --max-time 3 "http://127.0.0.1:$TM8_ENV_SERVER_PORT/health" 2>/dev/null || true)"
    case "$body" in *'"db"'*ok*) break ;; esac
    sleep 1; waited=$((waited + 1))
  done
  case "$body" in
    *'"db"'*ok*) ;;
    *) return 1 ;;
  esac
  ok "health on $TM8_ENV_SERVER_PORT — db:ok after ${waited}s"
  # A healthy /health proves SOMETHING is serving, not that it is what this run
  # built — a stale process answers exactly the same. Prove the unit entered
  # active during this run, so the no-op above cannot come back silently.
  if (( USE_SYSTEMD )) && command -v systemctl >/dev/null; then
    local entered entered_epoch
    entered="$(systemctl show "$UNIT_NAME" -p ActiveEnterTimestamp --value 2>/dev/null || true)"
    entered_epoch="$(date -d "$entered" +%s 2>/dev/null || echo 0)"
    if [[ -n "$entered" ]] && (( entered_epoch > 0 )) && (( entered_epoch < started_at )); then
      die "$UNIT_NAME has been running since $entered — it did not restart during
      this install, so the process serving requests is NOT the build this run
      produced. Restart it and re-run the verify:
        systemctl restart $UNIT_NAME"
    fi
  fi
  # /health carries BOTH counts and they mean different things: "operations" is
  # the catalog size, "implemented" is how many answer something other than 501.
  # Printing the first under the second's name is how "141 implemented" gets
  # believed about a node where two operations are still stubs.
  local ops impl
  ops="$(printf  '%s' "$body" | sed -n 's/.*"operations":\([0-9]*\).*/\1/p'  | head -1)"
  impl="$(printf '%s' "$body" | sed -n 's/.*"implemented":\([0-9]*\).*/\1/p' | head -1)"
  if [[ -n "$ops" && -n "$impl" ]]; then
    dim "catalog: $impl of $ops operations implemented (the rest answer 501 by design)"
  elif [[ -n "$ops" ]]; then
    dim "catalog: $ops operations mounted"
  fi

  # /health passing is not proof the product works — a real read through the
  # catalog is. This is the check that would have caught "graph: NOT CONFIGURED".
  local cli="$TM8_ENV_CHECKOUT/packages/cli/dist/tm8"
  if [[ -x "$cli" ]]; then
    # A CLEAN env, then our own base URL. Without the strip, an installer run
    # from inside a tm8 agent session reads that session's TM8_AGENT_TOKEN and
    # reports `unauthenticated: invalid token` against a server that is fine.
    local -a clean; while IFS= read -r w; do clean+=("$w"); done < <(clean_env_prefix)
    if "${clean[@]}" TM8_BASE_URL="http://127.0.0.1:$TM8_ENV_SERVER_PORT" \
         "$NODE_BIN" "$cli" space list >/dev/null 2>&1; then
      ok "a real catalog read succeeds (tm8 space list)"
    else
      warn "the server is healthy but \`tm8 space list\` failed — the graph may not be wired"
    fi
  fi
  return 0
}

if (( DRY_RUN )); then
  dim "(dry-run) would verify /health and one real catalog read"
elif (( USE_SERVICE )) && [[ "$SERVICE_KIND" == systemd ]]; then
  verify_running || {
    printf '\n'; warn "no db:ok on $TM8_ENV_SERVER_PORT within 60s"
    info "last 30 log lines:"
    journalctl -u "$UNIT_NAME" -n 30 --no-pager 2>&1 | sed 's/^/        /' || true
    # The unit is enabled with Restart=always/RestartSec=3, so a server that
    # cannot boot is now respawning every ~3s. Say so, and how to stop it — a
    # bare `die` would leave a crash-loop running with no way out named.
    warn "the unit is enabled and will respawn the server every ~3s until you stop it:"
    info "stop it now:      sudo systemctl stop $UNIT_NAME"
    info "remove it (keeps your data):  $0 --env $SLOT --uninstall"
    die "$UNIT_NAME started but did not become healthy"
  }
  active="$(systemctl is-active "$UNIT_NAME" 2>/dev/null || echo inactive)"
  [[ "$active" == active ]] || die "$UNIT_NAME is $active"
  ok "$UNIT_NAME active"
elif (( USE_SERVICE )) && [[ "$SERVICE_KIND" == launchd ]]; then
  verify_running || {
    printf '\n'; warn "no db:ok on $TM8_ENV_SERVER_PORT within 60s"
    info "last 30 log lines ($HOME/Library/Logs/tm8-${SLOT}-server.err.log):"
    tail -n 30 "$HOME/Library/Logs/tm8-${SLOT}-server.err.log" 2>/dev/null | sed 's/^/        /' || true
    # The LaunchAgent is loaded with KeepAlive=true, so a server that cannot boot
    # is now respawning every ~3s and will keep doing so across logins until it is
    # booted out — a laptop quietly burning CPU on a crash-loop nobody named. Tell
    # the user how to stop it rather than dying silently on top of it.
    warn "the LaunchAgent is loaded and KeepAlive will respawn it every ~3s until you stop it:"
    info "stop it now:      launchctl bootout $LAUNCHD_DOMAIN/$LAUNCHD_SERVER_LABEL"
    info "remove it (keeps your data):  $0 --env $SLOT --uninstall"
    die "$LAUNCHD_SERVER_LABEL started but did not become healthy"
  }
  st="$(launchd_status "$LAUNCHD_SERVER_LABEL")"
  case "$st" in active*) ok "$LAUNCHD_SERVER_LABEL $st" ;; *) die "$LAUNCHD_SERVER_LABEL is $st" ;; esac
elif (( DO_START )); then
  # Verify from a subshell while the foreground process holds the terminal, so
  # starting still PROVES the install rather than merely launching something.
  ( sleep 4
    if verify_running >/dev/null 2>&1; then
      printf '\n      %s✓%s tm8 is up and healthy on %s\n' "$GRN" "$OFF" "$TM8_ENV_SERVER_PORT"
      [[ -n "$TM8_ENV_VITE_PORT" ]] && printf '      %s✓%s open http://127.0.0.1:%s\n' "$GRN" "$OFF" "$TM8_ENV_VITE_PORT"
    fi ) &

  # Strip the spawning session's identity before exec. `set -a; . envfile` ADDS
  # variables; it never removes one, so an ambient TM8_AGENT_TOKEN would reach
  # this server and hand it a stranger's identity. (systemd needs none of this —
  # a unit starts from a clean environment plus EnvironmentFile.)
  declare -a clean; while IFS= read -r w; do clean+=("$w"); done < <(clean_env_prefix)

  # For a slot with a Vite dev port, "running" means the SERVER AND THE UI.
  # Starting only the server would leave a browser with nothing to open: the dev
  # and staging slots deliberately build no UI bundle (they serve source through
  # Vite), so a server started alone here answers the API and serves no app at
  # all. scripts/dev.mjs runs both and reloads them; it reads .env.<slot>.local
  # itself, so the env file does not need sourcing first.
  if [[ -n "$TM8_ENV_VITE_PORT" && -f "$TM8_ENV_CHECKOUT/scripts/dev.mjs" && "$LAYOUT" == user ]]; then
    info "starting tm8 — server on $TM8_ENV_SERVER_PORT, UI on $TM8_ENV_VITE_PORT (Ctrl-C stops both)"
    cd "$TM8_ENV_CHECKOUT"
    exec "${clean[@]}" TM8_ENV="$SLOT" "$NODE_BIN" scripts/dev.mjs
  fi

  info "starting the server on $TM8_ENV_SERVER_PORT in the foreground — Ctrl-C to stop"
  set -a; # shellcheck disable=SC1090
  . "$TM8_ENV_ENVFILE"; set +a
  exec "${clean[@]}" "$NODE_BIN" --enable-source-maps \
    "$TM8_ENV_CHECKOUT/packages/server/dist/index.js"
else
  if verify_running 2>/dev/null; then
    dim "(something was already serving $TM8_ENV_SERVER_PORT and it is healthy)"
  else
    ok "install complete — nothing started (--no-start)"
    start_foreground_hint
  fi
fi

# --- done --------------------------------------------------------------------
elapsed=$(( $(date +%s) - started_at ))
if (( DRY_RUN )); then
  printf '\n%s— dry run complete: nothing was changed.%s\n' "$YEL" "$OFF"
  printf '  Re-run without --dry-run to install tm8 %s.\n' "$SLOT"
  printf '  target: %s\n' "$TM8_ENV_CHECKOUT"
  exit 0
fi
printf '\n%s✓ tm8 %s installed%s  (%dm%02ds)\n' "$GRN" "$SLOT" "$OFF" $((elapsed / 60)) $((elapsed % 60))
if [[ -n "$TM8_ENV_PROXY_PORT" && "$SLOT" != dev ]]; then
  printf '  open http://127.0.0.1:%s   ·  server 127.0.0.1:%s  ·  db %s\n' \
    "$TM8_ENV_PROXY_PORT" "$TM8_ENV_SERVER_PORT" "$TM8_ENV_DATABASE"
else
  printf '  server http://127.0.0.1:%s  ·  db %s\n' "$TM8_ENV_SERVER_PORT" "$TM8_ENV_DATABASE"
fi
printf '  status:    %s --env %s --status\n' "$0" "$SLOT"
printf '  env file:  %s\n' "$TM8_ENV_ENVFILE"
# The agent login is the one prerequisite this installer can only WARN about, so
# it earns a line in the summary: a healthy node with no logged-in agent spawns
# sessions that sit at "running" forever. `tm8 doctor` reports presence AND login.
if [[ -x "$TM8_ENV_CHECKOUT/packages/cli/dist/tm8" ]]; then
  printf '  agents:    %s/packages/cli/dist/tm8 doctor   (claude/codex installed AND logged in? tm8 stores no agent login)\n' "$TM8_ENV_CHECKOUT"
else
  printf '  agents:    tm8 doctor   (claude/codex installed AND logged in? tm8 stores no agent login)\n'
fi
