#!/usr/bin/env bash
# =============================================================================
# tm8 UTHO deploy — build and deploy a pushed git ref to the Utho box.
#
#   ./deploy/utho/deploy.sh staging <ref> [--from-scratch]
#   ./deploy/utho/deploy.sh prod    <ref> [--no-backup]
#   ./deploy/utho/deploy.sh <staging|prod> --status
#   ./deploy/utho/deploy.sh <staging|prod> <ref> --plan     # show, change nothing
#
#   <ref> is a BRANCH, TAG or SHA THAT ALREADY EXISTS ON origin. This script never
#   pushes and never rsyncs your working tree: the box fetches from GitHub, so what
#   runs there is always a commit you can name. Uncommitted local edits are, by
#   design, invisible to it.
#
# TOPOLOGY (verified on the box 2026-08-05, not assumed)
#
#              | STAGING                        | PROD
#   -----------|--------------------------------|------------------------------
#   checkout   | /opt/tm8/staging  detached HEAD| /opt/tm8/prod  detached HEAD
#   server     | 127.0.0.1:8887                 | 127.0.0.1:17777
#   nginx      | :8888                          | :7777
#   UI         | vite DEV on 18888 — NO BUILD   | built dist — SEPARATE vite build
#   database   | tm8_staging @ 5443             | tm8_prod @ 5442
#   units      | tm8-staging, tm8-staging-ui    | tm8-prod
#
#   There is a THIRD unit on the box, tm8-private.service. It is not a deploy
#   target and nothing here touches it.
#
# THE FIVE THINGS THAT MAKE THE OBVIOUS RECIPE WRONG
#
#  1. STAGING HAS NO UI BUILD; PROD'S IS SEPARATE. `bun run build` is `tsc -b`
#     only. Prod serves TM8_UI_DIR=packages/tm8-ui/dist (plus the alternate 2.0
#     bundle at packages/tm8_ui_2.0/dist-2.0), so prod needs a second,
#     explicit `vite build` — skip it and you ship a stale UI against a new server
#     with no error anywhere. Staging runs vite DEV against source, so the
#     checkout alone updates its UI and a build there is wasted work.
#
#  2. ROOT FETCHES, tm8 BUILDS. The tm8 user has no ~/.ssh and cannot reach
#     GitHub ("Host key verification failed"). Root can. But root building leaves
#     root-owned files the services cannot read, so the build is handed to tm8 and
#     the tree is chowned between the two.
#
#  3. /etc/tm8/*.env IS 0600 root:root — tm8 CANNOT READ IT. The recipe that says
#     `runuser -u tm8 -- ... . /etc/tm8/prod.env` fails with "Permission denied"
#     (confirmed 2026-08-05). Env is resolved as ROOT and the values needed are
#     passed explicitly.
#
#  4. THE SERVICE URL CANNOT MIGRATE. staging.env's TM8_DATABASE_URL is a tm8_app
#     URL, which gets "permission denied for schema public" creating
#     applied_migrations. Migrations therefore run under an explicit SUPERUSER URL
#     derived from the env's host/port/database, never the env's own URL.
#
#  5. NEVER SIGNAL THE SERVICE. A clean Node shutdown exits 0, so with
#     Restart=on-failure systemd leaves the unit INACTIVE — a `kill -TERM` "restart"
#     silently leaves prod DOWN. Only systemctl stop/start/restart appear here.
#
# The migration delta is printed IN FULL and prod requires typed confirmation
# before anything is stopped. That gate is not optional: a migration that reached
# prod unread once killed every messages.post on the box.
# =============================================================================
set -euo pipefail

SSH_HOST="${TM8_UTHO_SSH:-utho}"

BOLD=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; GRN=$'\033[32m'; YEL=$'\033[33m'; OFF=$'\033[0m'
step_n=0
step() { step_n=$((step_n+1)); printf '\n%s[%d] %s%s\n' "$BOLD" "$step_n" "$*" "$OFF"; }
info() { printf '      %s\n' "$*"; }
dim()  { printf '      %s%s%s\n' "$DIM" "$*" "$OFF"; }
ok()   { printf '      %s✓%s %s\n' "$GRN" "$OFF" "$*"; }
warn() { printf '      %s!%s %s\n' "$YEL" "$OFF" "$*"; }
die()  { printf '\n%serror:%s %s\n' "$RED" "$OFF" "$*" >&2; exit 1; }

usage() { sed -n '2,12p' "$0"; exit "${1:-0}"; }

# --- arguments ---------------------------------------------------------------
TARGET=""; REF=""; MODE=deploy; FROM_SCRATCH=0; DO_BACKUP=1; ASSUME_YES=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    staging|prod)   [[ -z "$TARGET" ]] || die "two targets given: $TARGET and $1"; TARGET="$1" ;;
    --status)       MODE=status ;;
    --plan)         MODE=plan ;;
    --from-scratch) FROM_SCRATCH=1 ;;
    --no-backup)    DO_BACKUP=0 ;;
    --yes|-y)       ASSUME_YES=1 ;;
    -h|--help)      usage 0 ;;
    -*)             die "unknown flag $1 (try --help)" ;;
    *)              [[ -z "$REF" ]] || die "two refs given: $REF and $1"; REF="$1" ;;
  esac
  shift
done
[[ -n "$TARGET" ]] || usage 2

case "$TARGET" in
  # UNITS is COMMA-joined, never space-joined: it crosses ssh as one argument.
  staging) DIR=/opt/tm8/staging; PORT=8887; ENVFILE=/etc/tm8/staging.env
           UNITS="tm8-staging,tm8-staging-ui"; BUILD_UI=0 ;;
  prod)    DIR=/opt/tm8/prod;    PORT=17777; ENVFILE=/etc/tm8/prod.env
           UNITS="tm8-prod";     BUILD_UI=1 ;;
esac

if [[ "$FROM_SCRATCH" == 1 && "$TARGET" == prod ]]; then
  die "--from-scratch is staging-only. Branch builds land in the staging slot (ruled
      2026-08-05); a from-scratch wipe of prod's checkout is not a deploy, it is an
      outage. Deploy the ref to staging first, then promote it to prod."
fi

remote() { ssh -o ConnectTimeout=15 "$SSH_HOST" "$@"; }
# Remote logic is piped to `bash -s`, never interpolated into an ssh command line.
# Quoting a script through an ssh argument mangles it silently — backticks and
# $(...) get eaten by the local shell first, and the corruption shows up as a
# nonsense remote error a long way from its cause.
#
# Every argument must be a SINGLE SHELL WORD. `ssh host bash -s -- a b "c d"` does
# NOT preserve quoting: ssh joins the arguments into one command string and the
# remote shell re-parses it, so "c d" arrives as two positional parameters and
# every argument after it shifts down by one. That silently turned $ENVFILE into a
# unit name here. Multi-word values are passed comma-joined and split remotely;
# multi-line values (the migration diff) are not passed as arguments at all.
remote_script() { ssh -o ConnectTimeout=15 "$SSH_HOST" bash -s -- "$@"; }

# =============================================================================
# status
# =============================================================================
if [[ "$MODE" == status ]]; then
  printf '\n%stm8 %s on %s%s\n' "$BOLD" "$TARGET" "$SSH_HOST" "$OFF"
  remote_script "$DIR" "$PORT" "$UNITS" <<'REMOTE'
set -u
DIR="$1"; PORT="$2"; UNITS="$(echo "$3" | tr ',' ' ')"
sha="$(git -c safe.directory="$DIR" -C "$DIR" rev-parse --short HEAD 2>/dev/null || echo '?')"
desc="$(git -c safe.directory="$DIR" -C "$DIR" log -1 --format='%s' 2>/dev/null || true)"
echo "      checkout $DIR @ $sha"
echo "      subject  $desc"
for u in $UNITS; do
  printf '      %-18s %s\n' "$u" "$(systemctl is-active "$u" 2>/dev/null || echo inactive)"
done
# Health on the SERVER port directly. nginx :8888 redirects http→https and the
# server enforces a host allowlist, so a curl through the proxy returns 301 or
# "is not this node" and neither means the deploy is broken.
echo "      health   $(curl -s --max-time 5 "http://127.0.0.1:$PORT/health" || echo UNREACHABLE)"
REMOTE
  exit 0
fi

[[ -n "$REF" ]] || die "no ref given. Usage: $0 $TARGET <branch|tag|sha>"

# =============================================================================
# 1. the ref must already be on origin
# =============================================================================
step "resolve $REF on origin"
# ls-remote, not rev-parse: a local branch that was never pushed resolves fine
# locally and then fails on the box, after it has already been stopped.
SHA="$(git ls-remote origin "$REF" 2>/dev/null | awk 'NR==1{print $1}')"
if [[ -z "$SHA" ]]; then
  # Could still be a full sha that ls-remote does not advertise. Accept it only if
  # it is an ancestor of something on origin, so we never deploy a local-only commit.
  if git cat-file -e "$REF^{commit}" 2>/dev/null; then
    cand="$(git rev-parse "$REF^{commit}")"
    if [[ -n "$(git branch -r --contains "$cand" 2>/dev/null)" ]]; then
      SHA="$cand"
    else
      die "$REF exists locally ($(git rev-parse --short "$cand")) but is on NO remote branch.
      This script deploys pushed refs only. Push it first:
          git push origin HEAD:refs/heads/<branch>"
    fi
  else
    die "$REF does not exist on origin (git ls-remote origin '$REF' found nothing)."
  fi
fi
ok "$REF → $SHA"

# =============================================================================
# 2. plan: what changes, and above all WHICH MIGRATIONS
# =============================================================================
step "plan against the deployed checkout"
CURRENT="$(remote_script "$DIR" <<'REMOTE'
set -u
git -c safe.directory="$1" -C "$1" rev-parse HEAD 2>/dev/null || echo unknown
REMOTE
)"
CURRENT="${CURRENT//[$'\r\n ']/}"
info "deployed: ${CURRENT:0:12}"
info "target:   ${SHA:0:12}"

if [[ "$CURRENT" == "$SHA" ]]; then
  warn "the box is ALREADY on this commit — a deploy would rebuild and restart identically"
fi

# The delta is computed LOCALLY, so it works even when the box has not fetched the
# target yet. It needs both commits present locally.
git cat-file -e "$SHA^{commit}" 2>/dev/null || { info "fetching $SHA locally"; git fetch -q origin "$REF" 2>/dev/null || true; }
MIGRATION_DELTA=""
if [[ "$CURRENT" != unknown ]] && git cat-file -e "$CURRENT^{commit}" 2>/dev/null && git cat-file -e "$SHA^{commit}" 2>/dev/null; then
  MIGRATION_DELTA="$(git diff --name-status "$CURRENT" "$SHA" -- db/migrations/ || true)"
  commits="$(git rev-list --count "$CURRENT..$SHA" 2>/dev/null || echo '?')"
  info "commits to apply: $commits"
else
  warn "cannot compute the delta locally (a commit is missing) — treating migrations as UNKNOWN"
  MIGRATION_DELTA="UNKNOWN"
fi

printf '\n      %smigrations in this deploy%s\n' "$BOLD" "$OFF"
if [[ -z "$MIGRATION_DELTA" ]]; then
  ok "none — no file under db/migrations/ changed. No dump and no \`migrate up\` needed."
elif [[ "$MIGRATION_DELTA" == UNKNOWN ]]; then
  warn "UNKNOWN — cannot enumerate. Treat as risky."
else
  printf '%s\n' "$MIGRATION_DELTA" | sed 's/^/      /'
  printf '\n      %sfull text of the migrations above%s\n' "$BOLD" "$OFF"
  # Printed in full ON PURPOSE. "I read the filenames" is how a migration that
  # broke every message send on this box got deployed.
  git diff "$CURRENT" "$SHA" -- db/migrations/ | sed 's/^/      /'
fi

if [[ "$MODE" == plan ]]; then
  printf '\n      %s--plan: nothing was changed.%s\n' "$DIM" "$OFF"
  exit 0
fi

# =============================================================================
# 3. the gate
# =============================================================================
if [[ "$TARGET" == prod && "$ASSUME_YES" == 0 ]]; then
  step "confirm"
  info "This will STOP tm8-prod, apply the migrations printed above to tm8_prod,"
  info "and restart on the new build. Read them before answering."
  printf '\n      type %sdeploy prod%s to proceed: ' "$BOLD" "$OFF"
  read -r reply
  [[ "$reply" == "deploy prod" ]] || die "aborted — nothing was changed."
  ok "confirmed"
fi

# =============================================================================
# 4. do it, on the box
# =============================================================================
step "deploy $TARGET → ${SHA:0:12}"
# The remote side only ever branches on WHETHER migrations are pending, so it gets a
# single-word flag. Passing the diff itself would shatter it into one positional
# parameter per word the moment it crossed ssh.
HAS_MIGRATIONS=0
[[ -n "$MIGRATION_DELTA" ]] && HAS_MIGRATIONS=1

remote_script "$DIR" "$SHA" "$PORT" "$ENVFILE" "$UNITS" "$BUILD_UI" "$DO_BACKUP" "$FROM_SCRATCH" \
              "$HAS_MIGRATIONS" <<'REMOTE'
set -euo pipefail
DIR="$1"; SHA="$2"; PORT="$3"; ENVFILE="$4"; UNITS="$(echo "$5" | tr ',' ' ')"; BUILD_UI="$6"
DO_BACKUP="$7"; FROM_SCRATCH="$8"; HAS_MIGRATIONS="${9:-0}"

say()  { printf '      %s\n' "$*"; }
rok()  { printf '      \033[32m✓\033[0m %s\n' "$*"; }
rdie() { printf '\n\033[31mremote error:\033[0m %s\n' "$*" >&2; exit 1; }

[[ $(id -u) -eq 0 ]] || rdie "must run as root on the box (root fetches; tm8 builds)."

# --- env, read as ROOT -------------------------------------------------------
# tm8 cannot read this file (0600 root:root), so the values must be lifted here.
[[ -r "$ENVFILE" ]] || rdie "$ENVFILE is unreadable even as root"
SERVICE_DB_URL="$(sed -n 's/^TM8_DATABASE_URL=//p' "$ENVFILE" | tail -1)"
PG_PORT="$(sed -n 's/^TM8_PG_PORT=//p' "$ENVFILE" | tail -1)"
DB_NAME="${SERVICE_DB_URL##*/}"; DB_NAME="${DB_NAME%%\?*}"
[[ -n "$DB_NAME" && -n "$PG_PORT" ]] || rdie "could not read the database name/port out of $ENVFILE"
# Superuser URL for migrations. The service's own URL may be a tm8_app one, which
# cannot create applied_migrations.
MIGRATE_URL="postgres://tm8@127.0.0.1:$PG_PORT/$DB_NAME"
say "database $DB_NAME @ $PG_PORT (migrating as superuser tm8, not the service role)"

# --- fetch, as root ----------------------------------------------------------
git -c safe.directory="$DIR" -C "$DIR" fetch --quiet origin || rdie "git fetch failed as root"
git -c safe.directory="$DIR" -C "$DIR" cat-file -e "${SHA}^{commit}" 2>/dev/null \
  || rdie "$SHA is not on the box after fetch — is it pushed to origin?"
rok "fetched; $SHA present"

# --- checkout ----------------------------------------------------------------
# Both checkouts are detached HEAD, so --detach is the move for either. It also
# cannot fast-forward the wrong branch by accident.
if [[ "$FROM_SCRATCH" == 1 ]]; then
  say "--from-scratch: discarding the checkout's build state"
  git -c safe.directory="$DIR" -C "$DIR" checkout --detach --force "$SHA" >/dev/null 2>&1 \
    || rdie "checkout --detach failed"
  # -x removes ignored files (dist, node_modules); -e keeps nothing back. This is
  # why --from-scratch is refused for prod.
  git -c safe.directory="$DIR" -C "$DIR" clean -xdff >/dev/null || rdie "git clean failed"
  rok "checkout wiped clean and detached at $SHA"
else
  git -c safe.directory="$DIR" -C "$DIR" checkout --detach --force "$SHA" >/dev/null 2>&1 \
    || rdie "checkout --detach failed"
  rok "detached at $SHA"
fi

# Root just wrote into the tree; hand it back before tm8 tries to build.
chown -R tm8:tm8 "$DIR"

# --- backup, before the schema is touched -----------------------------------
# Only when migrations are actually pending: a dump of an unchanged schema is
# noise, and this box's dumps are large.
if [[ "$DO_BACKUP" == 1 && "$HAS_MIGRATIONS" == 1 ]]; then
  mkdir -p /var/backups/tm8
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  dump="/var/backups/tm8/${DB_NAME}_before_${SHA:0:12}_${stamp}.dump"
  # The restrictive umask is SCOPED TO THIS SUBSHELL. Leaving the deploy shell at
  # umask 077 once produced root-owned 0600 source and dist files that the tm8
  # services could not read — a working build that would not boot.
  ( umask 077; pg_dump --format=custom --dbname="$MIGRATE_URL" --file="$dump" ) \
    || rdie "pg_dump failed — refusing to migrate without a backup"
  echo "$dump" > /var/backups/tm8/LAST_BACKUP
  rok "backup $dump ($(stat -c %s "$dump") bytes, mode $(stat -c %a "$dump"))"
elif [[ "$HAS_MIGRATIONS" == 1 ]]; then
  say "! --no-backup with pending migrations — you own that"
else
  say "no migrations pending; skipping the dump"
fi

# --- build, as tm8 -----------------------------------------------------------
# umask 022 explicitly: the services must be able to read what we produce.
say "building as tm8 (bun install --frozen-lockfile, tsc -b)"
runuser -u tm8 -- bash -lc "cd '$DIR' && umask 022 && bun install --frozen-lockfile >/dev/null && bun run build" \
  || rdie "build failed — nothing has been stopped, the old build is still serving"
rok "server + CLI built"

if [[ "$BUILD_UI" == 1 ]]; then
  # Prod only. `bun run build` above is tsc -b and does NOT touch the UI; prod
  # serves packages/tm8-ui/dist, so skipping this ships a stale UI, silently.
  #
  # TWO BUNDLES SINCE 2026-09-03. packages/tm8-ui is the product UI at `/`;
  # packages/tm8_ui_2.0 is the alternate at `/ui-2.0/`, from `dist-2.0`.
  #
  # STALE SYMLINKS FIRST. Both of these have existed on this box: tm8-ui/dist
  # pointed at ../tm8_ui_2.0/dist while a root-owned env named the old path, and
  # tm8_ui_2.0/dist was pointed at a hand-built root bundle during the 2026-09-03
  # zero-restart swap. Either one makes a vite build write THROUGH it into the
  # other package. Remove them before building; idempotent, and a no-op on a box
  # that never had one.
  for stale in "$DIR/packages/tm8-ui/dist" "$DIR/packages/tm8_ui_2.0/dist"; do
    if [[ -L "$stale" ]]; then
      rm -f "$stale"
      rok "removed stale symlink $stale -> (gone)"
    fi
  done

  say "building the product UI bundle (separate vite build — prod serves dist)"
  runuser -u tm8 -- bash -lc "cd '$DIR/packages/tm8-ui' && umask 022 && bun run build >/dev/null" \
    || rdie "vite build failed — nothing has been stopped"
  [[ -f "$DIR/packages/tm8-ui/dist/index.html" ]] || rdie "vite build reported success but dist/index.html is missing"
  rok "product UI bundle built"

  # NOT `rdie` ON FAILURE, unlike the product UI: this bundle is optional. A
  # deploy that cannot build the alternate UI must still ship the product one —
  # failing the whole rollout over a rollback affordance would make the
  # affordance more dangerous than the thing it exists to protect against.
  say "building the alternate 2.0 UI bundle (/ui-2.0/, from dist-2.0)"
  if runuser -u tm8 -- bash -lc "cd '$DIR/packages/tm8_ui_2.0' && umask 022 && bun run build >/dev/null" \
     && [[ -f "$DIR/packages/tm8_ui_2.0/dist-2.0/index.html" ]]; then
    rok "alternate UI bundle built"
  else
    say "! 2.0 UI build failed — shipping without it; the version switch will report it unavailable"
  fi

  # /etc/tm8/prod.env is 0600 root:root, so the checkout update alone cannot move
  # these pointers — and a stale TM8_UI_DIR serves the WRONG UI with every other
  # check green. Fix them here, where we are root anyway. Both edits are
  # idempotent: no-ops once the env file already points right.
  if grep -q "packages/tm8_ui_2.0/dist" "$ENVFILE"; then
    sed -i 's|packages/tm8_ui_2.0/dist|packages/tm8-ui/dist|' "$ENVFILE"
    rok "TM8_UI_DIR moved to packages/tm8-ui/dist in $ENVFILE"
  fi
  # The mount is opt-in and this box has never had the variable. Without it
  # /ui-2.0/ 404s and the switch refuses with its reason — correct, but not what
  # the swap asked for, so seed it rather than leaving it to be noticed.
  if ! grep -q '^TM8_UI_2_0_DIR=' "$ENVFILE"; then
    sed -i '/^TM8_UI_1_0_DIR=/d' "$ENVFILE"
    printf 'TM8_UI_2_0_DIR=%s/packages/tm8_ui_2.0/dist-2.0\n' "$DIR" >> "$ENVFILE"
    rok "TM8_UI_2_0_DIR seeded in $ENVFILE (the /ui-2.0/ mount)"
  fi
else
  say "staging runs vite DEV against source — no UI build (the checkout already updated it)"
fi
[[ -f "$DIR/packages/server/dist/index.js" ]] || rdie "packages/server/dist/index.js missing after build"

# --- stop, migrate, start ----------------------------------------------------
# systemctl only. A clean node exit is status 0, so Restart=on-failure will NOT
# bring back something killed with a signal — that leaves the unit dead.
if [[ "$HAS_MIGRATIONS" == 1 ]]; then
  say "stopping $UNITS (the old build must not run against a changing schema)"
  systemctl stop $UNITS || rdie "systemctl stop failed"
  say "migrating $DB_NAME"
  if ! runuser -u tm8 -- bash -lc "cd '$DIR' && TM8_DATABASE_URL='$MIGRATE_URL' node db/migrate.mjs up"; then
    printf '\n      \033[31mmigration FAILED and the services are STOPPED.\033[0m\n'
    say "the pre-migration dump is at $(cat /var/backups/tm8/LAST_BACKUP 2>/dev/null || echo '(none)')"
    say "restarting the old code against the partially-migrated schema is NOT safe."
    rdie "migration failed — fix forward or restore the dump, then: systemctl start $UNITS"
  fi
  rok "migrations applied"
  systemctl start $UNITS || rdie "systemctl start failed"
else
  say "no migrations — restarting in place"
  systemctl restart $UNITS || rdie "systemctl restart failed"
fi

# --- verify ------------------------------------------------------------------
# On the SERVER port. Through nginx you get a 301 (http→https) or a host-allowlist
# refusal, and neither is evidence about the deploy.
for i in $(seq 1 30); do
  health="$(curl -s --max-time 3 "http://127.0.0.1:$PORT/health" 2>/dev/null || true)"
  case "$health" in *'"db"'*'ok'*|*'db:ok'*) break ;; esac
  sleep 1
done
case "$health" in
  *ok*) rok "health on 127.0.0.1:$PORT — $health" ;;
  *)    rdie "unhealthy after 30s: ${health:-no response}
      journalctl -u ${UNITS%% *} -n 50 --no-pager" ;;
esac
for u in $UNITS; do
  a="$(systemctl is-active "$u")"
  [[ "$a" == active ]] || rdie "$u is $a after deploy"
done
rok "units active: $UNITS"
# Prove the checkout is what we asked for, rather than trusting the steps above.
got="$(git -c safe.directory="$DIR" -C "$DIR" rev-parse HEAD)"
[[ "$got" == "$SHA" ]] || rdie "checkout is $got, expected $SHA"
rok "checkout verified at ${SHA:0:12}"
REMOTE

printf '\n      %s%s deployed%s  ref %s → %s\n' "$GRN" "$TARGET" "$OFF" "$REF" "${SHA:0:12}"
case "$TARGET" in
  staging) dim "UI https://tm8-server.tail28ac62.ts.net:8888  ·  server 127.0.0.1:8887" ;;
  prod)    dim "UI https://tm8-server.tail28ac62.ts.net:7777  ·  server 127.0.0.1:17777" ;;
esac
dim "A /health pass is not proof the product works. Prove it with a real read or write:"
dim "  TM8_BASE_URL=http://127.0.0.1:$PORT tm8 space list   (on the box)"
