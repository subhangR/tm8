#!/usr/bin/env bash
# =============================================================================
# tm8 PROD deploy — ONE command: build this checkout from scratch, migrate the
# prod database, and (re)start prod on 7777 / 7778.
#
#   bun run prod                       # or: ./deploy/prod/deploy.sh
#   ./deploy/prod/deploy.sh --rollback # swap the previous build back in
#   ./deploy/prod/deploy.sh --restart  # restart the current build, no rebuild
#   ./deploy/prod/deploy.sh --status   # what is actually running right now
#   ./deploy/prod/deploy.sh --stop     # stop prod
#
# Flags: --no-backup  skip the pre-migration pg_dump
#        --no-migrate skip `db/migrate.mjs up` (it will then refuse to start on
#                     a schema mismatch — you own that)
#        --build-only stage + compile only, then stop. Prod keeps running and
#                     nothing is stopped, migrated or rotated. Use it to prove
#                     the checkout builds before you take the downtime — and
#                     from INSIDE a tm8-spawned session, where a real deploy
#                     would kill the session along with the server that spawned it.
#
# WHAT IT DOES, and why in this order
#
#   1  preflight     node/bun/psql/rsync, a REAL query against tm8_stable (not
#                    pg_isready — that reports OK while auth is failing), and a
#                    complete node_modules in the source tree
#   2  stage         rsync this checkout → <prod>-next. Prod is a FROZEN build:
#                    it must not run out of the working tree, because staging's
#                    `tsc -b --watch` rewrites packages/server/dist in place and
#                    prod's next restart would pick up half-built code.
#   3  link deps     hardlink node_modules — root AND every workspace package.
#                    bun's isolated linker needs a real node_modules inside each
#                    package (packages/server/node_modules/@tm8/contract, the
#                    tm8-ui .bin/vite shim). Copying only the root one produces a
#                    tree where `tsc -b` cannot find @tm8/contract and vite
#                    cannot resolve itself.
#   4  build         tsc -b --force (contract→cli) + a SEPARATE `vite build` for
#                    packages/tm8-ui. `bun run build` is tsc only; skipping the
#                    vite half ships a stale UI against a new server and is the
#                    classic silent failure here.
#   5  backup        pg_dump tm8_stable before anything touches the schema
#   6  stop          the old prod, by ABSOLUTE PATH into the live dir — never a
#                    bare `pkill -f packages/server/dist/index.js`, which also
#                    kills staging
#   7  migrate       forward-only, against the pending files in the NEW build
#   8  rotate        live → -prev, next → live (rollback is one mv)
#   9  start         supervised server, then supervised UI
#  10  verify        /health db:ok on 7778, the same through the 7777 proxy, and
#                    listener→process proof that both ports are served by the
#                    directory we just rotated in
#
# The build happens BEFORE anything is stopped: a compile error costs zero
# downtime, and prod keeps serving the previous build.
# =============================================================================
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/env.sh"

SRC="$TM8_PROD_ROOT"                     # this checkout
LIVE="$TM8_PROD_DIR"
NEXT="$TM8_PROD_NEXT"
PREV="$TM8_PROD_PREV"
LOGDIR="${TM8_PROD_LOG_DIR:-$HOME/.local/share/tm8-prod-logs}"
LOCK="$LIVE.deploy.lock"

DO_BACKUP=1
DO_MIGRATE=1
BUILD_ONLY=0
MODE=deploy

for arg in "$@"; do
  case "$arg" in
    --no-backup)  DO_BACKUP=0 ;;
    --no-migrate) DO_MIGRATE=0 ;;
    --build-only) BUILD_ONLY=1 ;;
    --rollback)   MODE=rollback ;;
    --restart)    MODE=restart ;;
    --status)     MODE=status ;;
    --stop)       MODE=stop ;;
    -h|--help)    sed -n '2,40p' "$0"; exit 0 ;;
    *) echo "deploy.sh: unknown flag $arg (try --help)" >&2; exit 2 ;;
  esac
done

# --- output helpers ----------------------------------------------------------
BOLD=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; GRN=$'\033[32m'; YEL=$'\033[33m'; OFF=$'\033[0m'
step_n=0
step() { step_n=$((step_n + 1)); printf '\n%s[%d/%d] %s%s\n' "$BOLD" "$step_n" "$TOTAL_STEPS" "$*" "$OFF"; }
info() { printf '      %s\n' "$*"; }
dim()  { printf '      %s%s%s\n' "$DIM" "$*" "$OFF"; }
ok()   { printf '      %s✓%s %s\n' "$GRN" "$OFF" "$*"; }
warn() { printf '      %s!%s %s\n' "$YEL" "$OFF" "$*"; }
die()  { printf '\n%serror:%s %s\n' "$RED" "$OFF" "$*" >&2; exit 1; }

# =============================================================================
# process control
# =============================================================================

# Every pattern is anchored to an ABSOLUTE path inside the prod directory.
# `pkill -f packages/server/dist/index.js` would also match staging, which runs
# the same relative path out of the working tree.
# The pre-2026-08-02 layout kept supervise.sh at the directory root and was
# launched RELATIVELY (`bash ./supervise.sh run-ui.sh`), so no absolute path
# appears in its argv and no anchored pattern can find it. Matching it loosely by
# script name is not safe on its own — that pattern also matches a rehearsal
# instance's supervisors, and a scratch-port rehearsal would then kill real prod.
# So: match loosely, then keep only the pids whose CWD is under $root.
legacy_supervisor_pids() {
  local root="$1" pid cwd
  for pid in $(pgrep -f 'supervise\.sh run-(server|ui)\.sh' 2>/dev/null || true); do
    cwd="$(lsof -a -d cwd -p "$pid" -Fn 2>/dev/null | sed -n 's/^n//p' | head -1 || true)"
    if [[ "$cwd" == "$root" || "$cwd" == "$root"/* ]]; then echo "$pid"; fi
  done
  # Must return 0. `set -o pipefail` makes a pipeline take the last NON-ZERO
  # status, so a helper that ends on a false test poisons `pids="$(helper)"`
  # and set -e kills the deploy silently — mid-stop, with prod already down.
  return 0
}

supervisor_pids() {
  local root="$1"
  { pgrep -f "$root/deploy/prod/supervise.sh" || true; legacy_supervisor_pids "$root"; } | sort -u
  return 0
}

prod_pids() {
  local root="$1"
  {
    supervisor_pids "$root"
    pgrep -f "$root/packages/server/dist/index.js" || true
    pgrep -f "$root/packages/tm8-ui/node_modules/.bin/vite" || true
    pgrep -f "$root/node_modules/.bun/@esbuild" || true
  } | sort -u
  return 0
}

port_pid() { lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null | head -1 || true; }

stop_prod() {
  local root="$1" pids
  # Supervisors first — kill a child while its supervisor lives and it comes
  # straight back.
  pids="$(supervisor_pids "$root")"
  if [[ -n "$pids" ]]; then
    dim "supervisors: $(echo "$pids" | tr '\n' ' ')"
    echo "$pids" | xargs -r kill 2>/dev/null || true
    sleep 1
  fi

  pids="$(prod_pids "$root")"
  if [[ -n "$pids" ]]; then
    dim "processes: $(echo "$pids" | tr '\n' ' ')"
    echo "$pids" | xargs -r kill 2>/dev/null || true
  fi

  # Orphaned vite/esbuild children outlive their supervisor and keep the port
  # bound, so wait on the PORTS, not on the pids.
  local waited=0 pui papi
  while (( waited < 20 )); do
    pui="$(port_pid "$TM8_UI_PORT")"; papi="$(port_pid "$TM8_PORT")"
    if [[ -z "$pui" && -z "$papi" ]]; then break; fi
    sleep 1; waited=$((waited + 1))
  done
  pui="$(port_pid "$TM8_UI_PORT")"; papi="$(port_pid "$TM8_PORT")"
  if [[ -n "$pui$papi" ]]; then
    warn "ports still held after ${waited}s — SIGKILL ${pui} ${papi}"
    kill -9 $pui $papi 2>/dev/null || true
    sleep 2
  fi
  ok "prod stopped ($TM8_UI_PORT and $TM8_PORT free)"
}

# TM8_NODE_BIN is PROBED for by env.sh (first candidate reporting major 22 wins)
# and is EMPTY when the machine has no such node — which a `brew upgrade` moving
# the bare node off 22 is enough to cause. Asserting it is not optional bookkeeping:
# run-server.sh would otherwise `exec ""` and die at 127 on every supervised
# restart. Kept as a function because the modes that skip preflight — --restart
# and --rollback — start prod too, and used to start it straight into that loop.
require_node() {
  [[ -n "$TM8_NODE_BIN" && -x "$TM8_NODE_BIN" ]] \
    || die "no node 22 found (server+execution load node-pty, which is broken under bun).
       env.sh probes ~/.local/bin/node, the node@22 keg, then PATH. Install one:
         brew install node@22
       or point at it: TM8_NODE_BIN=/path/to/node $0"
}

start_prod() {
  mkdir -p "$LOGDIR"
  local ts; ts="$(date '+%Y-%m-%dT%H:%M:%S')"

  echo "=== deploy $ts ===" >> "$LOGDIR/server.log"
  nohup "$LIVE/deploy/prod/supervise.sh" run-server.sh >> "$LOGDIR/server.log" 2>&1 &
  local server_sup=$!
  disown || true
  info "server supervisor started → $LOGDIR/server.log"

  local waited=0 body=''
  while (( waited < 90 )); do
    body="$(curl -fsS --max-time 3 "http://127.0.0.1:$TM8_PORT/health" 2>/dev/null || true)"
    if [[ "$body" == *'"db"'*'"ok"'* ]]; then break; fi
    # A supervisor that is GONE has given up (child exited 78 — no build, no node).
    # It never exits on its own otherwise, so waiting out the remaining timeout
    # only delays the same failure and buries its cause under a health-check story.
    if ! kill -0 "$server_sup" 2>/dev/null; then
      echo "--- last 40 lines of $LOGDIR/server.log ---" >&2
      tail -40 "$LOGDIR/server.log" >&2
      die "the server supervisor gave up after ${waited}s — see the cause above"
    fi
    sleep 1; waited=$((waited + 1))
  done
  [[ "$body" == *'"db"'*'"ok"'* ]] || {
    echo "--- last 40 lines of $LOGDIR/server.log ---" >&2
    tail -40 "$LOGDIR/server.log" >&2
    die "server did not report db:ok on $TM8_PORT within ${waited}s"
  }
  ok "server up on $TM8_PORT (db:ok) after ${waited}s"

  echo "=== deploy $ts ===" >> "$LOGDIR/ui.log"
  nohup "$LIVE/deploy/prod/supervise.sh" run-ui.sh >> "$LOGDIR/ui.log" 2>&1 &
  local ui_sup=$!
  disown || true
  info "ui supervisor started → $LOGDIR/ui.log"

  waited=0
  while (( waited < 60 )); do
    curl -fsS --max-time 3 -o /dev/null "http://127.0.0.1:$TM8_UI_PORT/" 2>/dev/null && break
    if ! kill -0 "$ui_sup" 2>/dev/null; then
      echo "--- last 40 lines of $LOGDIR/ui.log ---" >&2
      tail -40 "$LOGDIR/ui.log" >&2
      die "the ui supervisor gave up after ${waited}s — see the cause above"
    fi
    sleep 1; waited=$((waited + 1))
  done
  curl -fsS --max-time 3 -o /dev/null "http://127.0.0.1:$TM8_UI_PORT/" 2>/dev/null || {
    echo "--- last 40 lines of $LOGDIR/ui.log ---" >&2
    tail -40 "$LOGDIR/ui.log" >&2
    die "UI did not answer on $TM8_UI_PORT within ${waited}s"
  }
  ok "ui up on $TM8_UI_PORT after ${waited}s"
}

# Never identify an instance by probing a port: vite proxies /health through, so
# 7777 and 8888 both answer "healthy tm8-server" and tell you nothing about which
# build you reached. Identify by listener → process → script path.
verify_prod() {
  local fail=0 pid cmd cwd
  for port in "$TM8_PORT" "$TM8_UI_PORT"; do
    pid="$(port_pid "$port")"
    [[ -n "$pid" ]] || { warn "nothing listening on $port"; fail=1; continue; }
    cmd="$(ps -o command= -p "$pid" 2>/dev/null || true)"
    # argv identifies the SERVER, whose command line carries an absolute
    # …/packages/server/dist/index.js. It cannot identify the UI: run-ui.sh cds
    # into the build and runs `node_modules/.bin/vite`, so every path in vite's
    # argv is relative and no absolute path appears anywhere in it. Fall back to
    # the process's cwd — the same evidence legacy_supervisor_pids() already uses
    # for the same reason, and the only thing that distinguishes prod's vite from
    # staging's, since both run byte-identical command lines.
    cwd="$(lsof -a -d cwd -p "$pid" -Fn 2>/dev/null | sed -n 's/^n//p' | head -1 || true)"
    if [[ "$cmd" == *"$LIVE"* ]]; then
      ok "$port ← pid $pid ($LIVE)"
    elif [[ -n "$cwd" && ( "$cwd" == "$LIVE" || "$cwd" == "$LIVE"/* ) ]]; then
      ok "$port ← pid $pid (cwd $cwd)"
    else
      warn "$port ← pid $pid is NOT the prod build: $cmd${cwd:+  [cwd $cwd]}"
      fail=1
    fi
  done

  local direct proxied
  direct="$(curl -fsS --max-time 5 "http://127.0.0.1:$TM8_PORT/health" 2>/dev/null || true)"
  proxied="$(curl -fsS --max-time 5 "http://127.0.0.1:$TM8_UI_PORT/health" 2>/dev/null || true)"
  [[ "$direct"  == *'"db"'*'"ok"'* ]] && ok "$TM8_PORT/health db:ok"              || { warn "$TM8_PORT/health: ${direct:-no answer}"; fail=1; }
  [[ "$proxied" == *'"db"'*'"ok"'* ]] && ok "$TM8_UI_PORT/health db:ok (proxied)" || { warn "$TM8_UI_PORT/health: ${proxied:-no answer}"; fail=1; }

  local ops
  ops="$(printf '%s' "$direct" | sed -n 's/.*"operations":\([0-9]*\).*/\1/p' || true)"
  if [[ -n "$ops" ]]; then dim "operations advertised: $ops"; fi

  return $fail
}

print_status() {
  printf '%stm8 prod%s  UI http://127.0.0.1:%s   server http://127.0.0.1:%s\n' "$BOLD" "$OFF" "$TM8_UI_PORT" "$TM8_PORT"
  printf '          build   %s\n' "$LIVE"
  if [[ -f "$LIVE/DEPLOYED.json" ]]; then sed 's/^/          /' "$LIVE/DEPLOYED.json"; fi
  printf '          db      %s\n' "$TM8_DATABASE_URL"
  printf '          logs    %s/{server,ui}.log\n' "$LOGDIR"
  echo
  verify_prod || true
  if [[ -d "$PREV" ]]; then dim "rollback available: $PREV"; fi
  return 0
}

# =============================================================================
# modes that do not build
# =============================================================================
case "$MODE" in
  status)
    TOTAL_STEPS=0
    print_status
    exit 0
    ;;
  stop)
    TOTAL_STEPS=1
    step "Stopping prod"
    stop_prod "$LIVE"
    exit 0
    ;;
  restart)
    TOTAL_STEPS=3
    [[ -x "$LIVE/deploy/prod/supervise.sh" ]] || die "no deployable build at $LIVE (run a full deploy first)"
    require_node          # before stopping: a restart that cannot start must not take prod down
    step "Stopping prod";  stop_prod "$LIVE"
    step "Starting prod";  start_prod
    step "Verifying";      verify_prod || die "prod restarted but did not verify"
    printf '\n%s✓ prod restarted%s — http://127.0.0.1:%s\n' "$GRN" "$OFF" "$TM8_UI_PORT"
    exit 0
    ;;
  rollback)
    TOTAL_STEPS=4
    [[ -d "$PREV" ]] || die "no previous build at $PREV"
    require_node          # same reason as --restart: do not stop what cannot restart
    step "Stopping prod"; stop_prod "$LIVE"
    step "Swapping $PREV back in"
    tmp="$LIVE.rollback.$$"
    mv "$LIVE" "$tmp" && mv "$PREV" "$LIVE" && mv "$tmp" "$PREV"
    ok "rolled back; the build just removed is now at $PREV"
    step "Starting prod"; start_prod
    step "Verifying";     verify_prod || die "rolled back but did not verify"
    printf '\n%s✓ prod rolled back%s — http://127.0.0.1:%s\n' "$GRN" "$OFF" "$TM8_UI_PORT"
    exit 0
    ;;
esac

# =============================================================================
# full deploy
# =============================================================================
TOTAL_STEPS=10

mkdir "$LOCK" 2>/dev/null || die "another deploy holds $LOCK — two concurrent rebuilds silently
       corrupt each other (one procedure's 'rm -rf …-next' deletes the other's staged build,
       and identical trees produce identical vite hashes, so the collision looks like success).
       If you are sure none is running: rmdir '$LOCK'"
trap 'rmdir "$LOCK" 2>/dev/null || true' EXIT

started_at=$(date +%s)
printf '%stm8 prod deploy%s  %s → %s\n' "$BOLD" "$OFF" "$SRC" "$LIVE"

# --- 1. preflight ------------------------------------------------------------
step "Preflight"
require_node
command -v bun   >/dev/null || die "bun not on PATH"
command -v rsync >/dev/null || die "rsync not on PATH"

PSQL="${TM8_PSQL:-$(command -v psql || true)}"
[[ -n "$PSQL" ]] || die "psql not on PATH (db/migrate.mjs drives it)"

# A real query, not pg_isready: the sidecar answers pg_isready while auth fails.
"$PSQL" "$TM8_DATABASE_URL" -tAc 'select 1' >/dev/null 2>&1 \
  || die "cannot query $TM8_DATABASE_URL — is the 5442 sidecar up, and does role tm8 exist?"
ok "postgres reachable: tm8_stable @ 5442"

# pg_dump refuses to dump a server newer than itself, and step 5 runs AFTER the
# build but BEFORE the migrate — late enough that a mismatch discovered there
# has already cost time, early enough that we can just check it now. Take it
# from the same bin dir as $PSQL so the pair cannot drift.
PG_DUMP="$(dirname "$PSQL")/pg_dump"
[[ -x "$PG_DUMP" ]] || die "no pg_dump beside $PSQL — set TM8_PSQL to a full Postgres 18 client path"
dump_major="$("$PG_DUMP" --version | grep -oE '[0-9]+' | head -1)"
srv_major="$("$PSQL" "$TM8_DATABASE_URL" -tAc 'show server_version' | grep -oE '^[0-9]+')"
(( dump_major >= srv_major )) \
  || die "pg_dump $dump_major cannot dump a server $srv_major ($PG_DUMP).
       Homebrew keeps postgresql@18 keg-only; bare pg_dump is an older linked formula.
       Fix: TM8_PSQL=/opt/homebrew/opt/postgresql@18/bin/psql $0"
ok "pg_dump $dump_major vs server $srv_major"

# bun's isolated linker needs a real node_modules per workspace package; we
# hardlink them from here, so a missing one is a build failure two steps later.
missing=()
[[ -d "$SRC/node_modules" ]] || missing+=("<root>")
for d in "$SRC"/packages/*/ "$SRC"/tools/*/; do
  [[ -f "$d/package.json" ]] || continue
  [[ -d "$d/node_modules" ]] && continue
  # A package that declares no deps (packages/pty-protocol) never gets a
  # node_modules from bun, and step 3 skips it for the same reason. Counting it
  # as missing re-ran `bun install` on EVERY deploy and trained the eye to
  # ignore this warning — which is the one that catches a real partial install.
  if "$TM8_NODE_BIN" -e '
        const p = require(process.argv[1] + "/package.json");
        process.exit(Object.keys({...p.dependencies, ...p.devDependencies}).length ? 1 : 0);
      ' "$d"; then continue; fi
  missing+=("${d#$SRC/}")
done
if (( ${#missing[@]} )); then
  warn "no node_modules in: ${missing[*]}"
  info "running bun install in $SRC …"
  (cd "$SRC" && bun install)
fi
ok "workspace dependencies present"

# node-pty's spawn-helper must be executable or EVERY PTY spawn dies with
# "posix_spawnp failed", which reaches the user as a bare 503 on
# /v2/execution/spawn — a symptom that names nothing. bun extracts npm tarballs
# without the exec bit, `postinstall` repairs that, and step 3 hardlinks
# node_modules, so the mode here IS the mode prod will run with. The install
# above is conditional, so a node_modules left over from an install that predates
# the postinstall would otherwise be rotated in unrepaired. Repair, then assert.
bash "$SRC/scripts/repair-node-pty.sh" >/dev/null 2>&1 || true
while IFS= read -r helper; do
  [[ -x "$helper" ]] || die "not executable: $helper
       Every PTY spawn would fail with posix_spawnp. Fix: bash $SRC/scripts/repair-node-pty.sh"
done < <(find "$SRC/node_modules" -path '*/node-pty/prebuilds/*/spawn-helper' -not -path '*/win32-*/*')
ok "node-pty spawn-helper executable"

GIT_SHA="$(git -C "$SRC" rev-parse --short HEAD 2>/dev/null || echo unknown)"
GIT_BRANCH="$(git -C "$SRC" rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"
GIT_DIRTY="$(git -C "$SRC" status --porcelain 2>/dev/null | wc -l | tr -d ' ' || true)"
GIT_DIRTY="${GIT_DIRTY:-0}"
info "branch $GIT_BRANCH @ $GIT_SHA${GIT_DIRTY:+  ($GIT_DIRTY uncommitted files — they WILL be deployed)}"

# --- 2. stage ----------------------------------------------------------------
step "Staging the checkout → $NEXT"
rm -rf "$NEXT"
mkdir -p "$NEXT"
# dist and *.tsbuildinfo are excluded on purpose: "from scratch" means the build
# outputs are produced here, not inherited from whatever state the tree is in.
rsync -a --delete \
  --exclude='.git/' \
  --exclude='node_modules/' \
  --exclude='dist/' \
  --exclude='*.tsbuildinfo' \
  --exclude='*.log' \
  --exclude='.DS_Store' \
  --exclude='.vite/' \
  --exclude='coverage/' \
  --exclude='test-results/' \
  --exclude='playwright-report/' \
  --exclude='graphify-out/' \
  --exclude='utho/backups/' \
  --exclude='T0-1 workspace structure review*' \
  "$SRC/" "$NEXT/"
ok "staged $(du -sh "$NEXT" 2>/dev/null | cut -f1 || true) of source"

# --- 3. link deps ------------------------------------------------------------
step "Hardlinking dependencies"
# `cp -al` shares inodes, so this costs no disk and no reinstall. Safe because
# package.json/bun.lock are byte-identical to the tree we linked from, and
# nothing in the build writes into node_modules. Build outputs (dist) are NOT
# hardlinked — writing through a hardlink would corrupt the source tree.
cp -al "$SRC/node_modules" "$NEXT/node_modules"
linked=1
for d in "$SRC"/packages/*/ "$SRC"/tools/*/; do
  [[ -d "$d/node_modules" ]] || continue
  rel="${d#$SRC/}"; rel="${rel%/}"
  cp -al "$d/node_modules" "$NEXT/$rel/node_modules"
  linked=$((linked + 1))
done
# vite's dep cache is the one thing under node_modules a build may rewrite.
rm -rf "$NEXT/node_modules/.vite" "$NEXT"/packages/*/node_modules/.vite
ok "$linked node_modules trees linked (root + workspace packages)"

# --- 4. build ----------------------------------------------------------------
step "Building (tsc -b --force, then vite build)"
cd "$NEXT"
info "server + cli …"
"$TM8_NODE_BIN" node_modules/typescript/bin/tsc -b --force \
  packages/contract packages/prompt packages/server packages/execution packages/cli tools/conformance \
  || die "tsc -b failed — prod is untouched and still serving the previous build"
chmod +x packages/cli/dist/index.js
ln -sf index.js packages/cli/dist/tm8
ok "tsc -b"

info "ui (vite build — this is a SEPARATE build; \`bun run build\` is tsc only) …"
(cd packages/tm8-ui && node_modules/.bin/vite build) \
  || die "vite build failed — prod is untouched and still serving the previous build"
ok "vite build"

[[ -f "$NEXT/packages/server/dist/index.js"    ]] || die "build produced no packages/server/dist/index.js"
[[ -f "$NEXT/packages/tm8-ui/dist/index.html"  ]] || die "build produced no packages/tm8-ui/dist/index.html"
ok "artifacts present: server/dist/index.js, tm8-ui/dist/index.html"

if (( BUILD_ONLY )); then
  elapsed=$(( $(date +%s) - started_at ))
  printf '\n%s✓ build only%s — %s is staged and compiled (%dm%02ds).\n' "$GRN" "$OFF" "$NEXT" $((elapsed / 60)) $((elapsed % 60))
  printf '  Prod was NOT stopped, migrated or rotated; %s is still serving the previous build.\n' "$LIVE"
  printf '  Finish with a full run: %s\n' "$0"
  exit 0
fi

# --- 5. backup ---------------------------------------------------------------
step "Backing up tm8_stable"
if (( DO_BACKUP )); then
  mkdir -p "$TM8_PROD_BACKUP_DIR"
  BACKUP="$TM8_PROD_BACKUP_DIR/tm8_stable-$(date -u '+%Y%m%dT%H%M%SZ').dump"
  "$PG_DUMP" -Fc -f "$BACKUP" "$TM8_DATABASE_URL" || die "pg_dump failed"
  echo "$BACKUP" > "$TM8_PROD_BACKUP_DIR/LAST_PROD_BACKUP"
  ok "$(du -h "$BACKUP" | cut -f1) → $BACKUP"
  # keep the 10 most recent
  ls -1t "$TM8_PROD_BACKUP_DIR"/tm8_stable-*.dump 2>/dev/null | tail -n +11 | xargs -r rm -f || true
else
  warn "skipped (--no-backup)"
fi

# --- 6. stop -----------------------------------------------------------------
step "Stopping the running prod"
stop_prod "$LIVE"

# --- 7. migrate --------------------------------------------------------------
step "Migrating tm8_stable"
if (( DO_MIGRATE )); then
  # From NEXT, so the migration files are exactly the ones this build expects.
  # The server does NOT auto-migrate at boot. Forward-only and checksum-locked:
  # a file edited after it was applied is a loud error here, not silent drift.
  (cd "$NEXT" && TM8_DATABASE_URL="$TM8_DATABASE_URL" "$TM8_NODE_BIN" db/migrate.mjs up) \
    || die "migration failed — prod is STOPPED and $LIVE is still the old build.
       Fix the migration, then re-run. Restore with:
         pg_restore -c -d '$TM8_DATABASE_URL' \"\$(cat $TM8_PROD_BACKUP_DIR/LAST_PROD_BACKUP)\"
       Bring the old build back up meanwhile with: $0 --restart"
  ok "schema current"
else
  warn "skipped (--no-migrate)"
fi

# --- 8. rotate ---------------------------------------------------------------
step "Rotating the build in"
rm -rf "$PREV"
if [[ -d "$LIVE" ]]; then mv "$LIVE" "$PREV"; fi   # absent on a first-ever deploy
mv "$NEXT" "$LIVE"
cat > "$LIVE/DEPLOYED.json" <<JSON
{
  "deployedAt": "$(date -u '+%Y-%m-%dT%H:%M:%SZ')",
  "branch": "$GIT_BRANCH",
  "commit": "$GIT_SHA",
  "uncommittedFilesAtDeploy": $GIT_DIRTY,
  "source": "$SRC",
  "database": "$TM8_DATABASE_URL"
}
JSON
if [[ -d "$PREV" ]]; then
  ok "$LIVE is the new build; previous kept at $PREV"
else
  ok "$LIVE is the new build (nothing to keep — first deploy into this directory)"
fi

# --- 9. start ----------------------------------------------------------------
step "Starting prod"
start_prod

# --- 10. verify --------------------------------------------------------------
step "Verifying"
verify_prod || die "prod started but failed verification (see above). Roll back with: $0 --rollback"

elapsed=$(( $(date +%s) - started_at ))
printf '\n%s✓ prod is live%s  http://127.0.0.1:%s   (%dm%02ds)\n' "$GRN" "$OFF" "$TM8_UI_PORT" $((elapsed / 60)) $((elapsed % 60))
printf '  %s @ %s%s  ·  db %s  ·  logs %s\n' "$GIT_BRANCH" "$GIT_SHA" "$(if [[ $GIT_DIRTY -gt 0 ]]; then echo " +$GIT_DIRTY uncommitted"; fi)" "${TM8_DATABASE_URL##*/}" "$LOGDIR"
printf '  rollback: %s --rollback\n' "$0"
