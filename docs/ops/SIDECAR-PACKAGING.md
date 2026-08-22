# tm8 — Sidecar Postgres Packaging & Lifecycle (R15 PLAN)

**Status:** PLAN — normative for W1 implementation. Not code.
**Owner:** Vela (CI & packaging, tm8 Ops) · **Lead:** Argo · **CTO:** Vega
**Implements:** R15 (07-ARCHITECTURE-REVIEW §7), Q5 (06-SEQUENCING §4.5), 09-IMPLEMENTATION-PLAN §3.3
**Implemented by:** Altair / Castor (sidecar *lifecycle code* in `packages/server`) at W1
**Date:** 2026-07-25
**Success test:** Castor can implement the sidecar lifecycle from this doc alone, without redesigning it.

---

## 0. Context primer (read this if you have not read the architecture corpus)

tm8 is a rebuild of Maestro as one entity-graph binary. **There is no Tauri** — that half of
AM-1/T-D21 stands. But **AM-7/T-D24 (2026-08-21) reversed the "no desktop app" half**: tm8 also
ships an **Electron** shell (`apps/desktop/`, macOS, arm64 first). `tm8-server` (a Node process,
port **4610**) serves the browser UI (Vite dev on **4611**, prod bundle served by tm8-server) and
owns a **Postgres** database directly (no Supabase, no PostgREST in v1). The Electron shell does
not change that shape — it *forks the same `packages/server/dist/index.js`* under
`ELECTRON_RUN_AS_NODE=1` on `TM8_PORT=0` and loads the resulting URL in a `BrowserWindow`, so the
UI stays a pure browser bundle and the server-side PTY host stays the only spawn path.

**What this means for THIS document:** every lifecycle mechanism below is unchanged and is what the
desktop app runs. Two deltas apply to the desktop profile only, and neither is a redesign:

- **§2's "unpack the tarball at first run" is wrong for a `.app`** and must be **unpack at *build*
  time** instead — binaries materialised at runtime into a user directory carry no signature, and on
  arm64 macOS an unsigned Mach-O will not execute at all. The desktop build ships the tree already
  unpacked at `Contents/Resources/pg/<ver>/` and sets `TM8_PG_BIN_DIR` to it, which is
  `binaries.ts` resolution **step 1** — so this costs **zero sidecar changes**. The archive path
  (steps 2–3) stays for the server install.
- **Desktop Postgres is unix-socket-only** (`listen_addresses = ''`), so the port number below names
  only the socket file and the `5442` row in the table cannot collide with a developer's own node.

Postgres is used *fully*: triggers, recursive CTEs, GIN indexes, row-level security (RLS),
and native `uuidv7()` keys. PGlite (a WASM Postgres) cannot substitute in the general case — it is
single-connection and weaker on extensions — so **the default local database is a real Postgres
server run as a child process of tm8-server: the "sidecar."** The product now has **two** install
stories over that one mechanism: **one-command start** for a server install (`tm8-server` boots,
starts the sidecar Postgres, runs migrations, serves the UI), and **double-click** for the macOS
app (Electron main boots, does the identical sequence against a bundled Postgres, then shows the
window). Making that reliable — bundling the Postgres binary, starting it,
health-checking it, migrating it safely across versions, backing it up, and never letting two
instances corrupt one data dir — is what this document specifies.

**Fixed constraints (settled law — do not relitigate):**

| | tm8 prod | tm8 dev | must never collide with live maestro |
|---|---|---|---|
| tm8-server HTTP | 4610 | 4610 (one at a time) | maestro 4567–4569, 4571 |
| UI (Vite dev) | — | 4611 | — |
| Sidecar Postgres | socket in the data dir; **5442** loopback (default) | socket in the data dir; **5442** loopback (default) | maestro has no PG |
| Data dir | `~/.tm8` | `~/.tm8-dev` | `~/.maestro`, `~/.maestro-staging` |

- `packages/server` runs under **node, never bun** (node-pty breaks under bun). The sidecar is a
  child process of tm8-server.
- **ONE migration sequence**, laptop and hub (`db/migrations/NNN_*.sql`, lexical order). PGlite must
  **never** fork the schema.
- Windows is **explicitly deferred** to a later phase; this plan targets darwin-arm64, darwin-x64,
  linux-x64, linux-arm64.
- Settled law names **one** sidecar port, 5442, and does not split it by environment. The app never
  connects over TCP anyway — it uses the socket in the data dir (§7), which is what actually makes
  the dev and prod clusters unable to collide. `TM8_PG_PORT` therefore defaults to **5442 in both
  environments**; a *second concurrent* stack overrides it (5443 is the suggested value) along with
  `TM8_PORT`. See `docs/ops/CONFIG.md` §3 — that split is a recommendation awaiting Vega's
  ratification, not law, and this plan does not assume it.

---

## 1. Summary of decisions

| # | Question | Decision | Primary failure mode if wrong |
|---|---|---|---|
| 1 | Which PG binary, per platform, how delivered? | **theseus-rs/postgresql-binaries**, **vendored in the release tarball** for all four platforms; SHA-256 verified at unpack. | Wrong/absent binary → sidecar never starts → dead product on first run. |
| 2 | Pinned PG major + uuidv7 | **Pin PG 18** (`18.4.0` at cut). Native `uuidv7()` (RFC 9562), no extension. Auto-accept minors, never auto-accept majors. | uuidv7 unavailable → keyset cursors non-uniform; wrong major → forced dump/restore surprise. |
| 3 | Backup-before-migrate on major change | Read `PG_VERSION`. Same major → in-place start. Bundled newer → **pre-migration `pg_dump -Fc`, initdb new cluster, restore, verify, keep dump**. Any failure → **REFUSE TO START**, surface backup path. Bundled older → **REFUSE**, never touch data. Never silent `pg_upgrade`. | Silent/failed upgrade → data corruption or loss with no recovery artifact. |
| 4 | Scheduled + on-demand backup | `pg_dump -Fc` (custom format). Scheduled daily via R26 scheduler; on-demand `backupNow()`/`exportTo()`. Retention: keep 7 daily + 4 weekly, prune rest. Under `<dataDir>/backups/`. | No backup → single-homed space loss is unrecoverable (T-L5 trust backstop gone). |
| 5 | Health-check-then-start | `pg_isready` over the socket, then one `SELECT 1`. 60×250 ms backoff (~15 s), then hard-fail. tm8-server serves nothing DB-backed until ready. | Serving before ready → cascade of 500s, half-migrated reads. |
| 6 | Single-instance locking | **Unix-domain socket inside the data dir** (primary isolation) + advisory `sidecar.lock` (pid+port+socket) + Postgres's own `postmaster.pid`. Distinct data dirs **and** ports for dev/prod. | Two instances on one data dir → catastrophic heap corruption (the old-maestro dual-stack lesson). |
| 7 | PGlite fallback trigger | **Distribution failure only** — never preference, never schema fork. Tripwires in §7. Watched-and-unbuilt until a tripwire fires. | Casual fallback → schema forks → the one-migration-sequence law breaks. |
| 8 | packages/server API surface | `SidecarManager` (`ensureStarted/stop/status/backupNow/exportTo`), `ResolvedSidecarConfig`, explicit lifecycle state machine, typed `SidecarError` taxonomy. §8. | Ambiguous surface → Castor redesigns at W1 → wave slip. |

---

## 2. Decision 1 — Which PG binary distribution, per platform, and how it reaches the machine

**DECISION: Bundle prebuilt server binaries from
[`theseus-rs/postgresql-binaries`](https://github.com/theseus-rs/postgresql-binaries), one archive
per platform, VENDORED inside the tm8 release tarball (not downloaded on first run). Verify each
archive's SHA-256 against a pin baked into the release before unpacking into `<binariesDir>`.**

### Options evaluated (real numbers)

| Option | Arch coverage (our 4 targets) | Size (compressed, PG 18.4.0) | License | Verdict |
|---|---|---|---|---|
| **theseus-rs/postgresql-binaries** | darwin-arm64 ✅, darwin-x64 ✅, linux-x64-gnu ✅, linux-arm64-gnu ✅ (all as first-class release assets) | arm64-darwin **12.45 MB**, x64-darwin **12.84 MB**, x64-linux-gnu **11.59 MB**, arm64-linux-gnu **11.40 MB** (verified via GitHub releases API, tag `18.4.0`) | PostgreSQL License (permissive, redistributable) | **CHOSEN** |
| zonky/embedded-postgres-binaries | darwin-arm64v8 ✅, darwin-amd64 ✅, linux-amd64 ✅, linux-arm64v8 ✅ | ~10 MB "reduced" bundles; PG **18.4.0** published | Apache-2.0 (tooling); binaries repackaged from Debian/Alpine apt | **Fallback** (see below) |
| EDB installers | all 4 (+ Windows) | ~300 MB installers, GUI/interactive, bundle StackBuilder | EDB terms; redistribution of the *installer* is restricted | **Reject** — not headless-embeddable, licensing friction, huge |
| System / Homebrew PG | host-dependent, not shippable | n/a | n/a | **Reject as primary** — cannot assume it exists or its major; **allowed as explicit opt-in override** (`TM8_PG_BINDIR`) for power users |
| initdb-from-source | build-per-platform in CI | n/a | PostgreSQL License | **Reject** — turns first-run/CI into a C toolchain problem; defeats "one-command start" |

Both theseus and zonky ship PG 18.4.0 for all four targets today; theseus wins on three counts:
(a) release assets are **plain `.tar.gz` per Rust target triple** with published **SHA-256 sidecar
files** — trivial to pin and verify from Node, no Maven/Gradle/Docker in our path; (b) it is a
**standard full PostgreSQL build layout** (`bin/postgres`, `initdb`, `pg_ctl`, `pg_isready`,
`pg_dump`, `pg_restore`, `psql`) rather than a size-stripped test bundle; (c) versioning is
`<pg-major>.<pg-minor>.<build>` so our pin maps cleanly. Zonky stays as the drop-in fallback (same
platform set) if theseus ever stops shipping a major we need.

**Target-triple mapping** (resolved by `binaries.ts` from `process.platform`/`process.arch`):

| `process.platform`/`arch` | theseus asset |
|---|---|
| `darwin`/`arm64` | `postgresql-18.4.0-aarch64-apple-darwin.tar.gz` |
| `darwin`/`x64` | `postgresql-18.4.0-x86_64-apple-darwin.tar.gz` |
| `linux`/`x64` | `postgresql-18.4.0-x86_64-unknown-linux-gnu.tar.gz` |
| `linux`/`arm64` | `postgresql-18.4.0-aarch64-unknown-linux-gnu.tar.gz` |

> Linux note: use the **`-gnu`** (glibc) assets as default; a `-musl` variant exists for Alpine but
> is larger (~2×) and only needed if we ship an Alpine-based container image — defer.

### Delivery: vendored vs first-run download

**DECISION: Vendor in the release tarball. Do NOT download on first run.** We publish a per-platform
tm8 release (`tm8-<version>-<platform>.tar.gz`) that already contains the matching Postgres archive
under `vendor/pg/`. On first boot, tm8-server unpacks it into `<binariesDir>` after SHA-256
verification.

| Axis | Vendored (CHOSEN) | First-run download |
|---|---|---|
| Bundle size | +~12 MB compressed per platform (negligible vs a Node/UI bundle) | smaller initial download |
| First-run network | **none** — works offline, on a plane, behind a corp proxy | requires reaching GitHub on first run; a flaky network = dead first-run |
| Supply chain | one artifact we build, sign, and host; pin is immutable in the release | depends on GitHub asset availability + a live TLS fetch each new install |

Twelve megabytes buys us an **offline, deterministic, single-artifact first run** — the whole point
of "one-command start." Downloading-on-first-run trades that for a smaller number nobody is counting,
and introduces a network dependency at the exact moment the product must feel instant. Vendoring
wins. (We still keep the SHA-256 verification step even though the bytes are local — it catches a
corrupted/truncated tarball before we hand bytes to `initdb`.)

**Failure mode if wrong:** an absent, mismatched-arch, or corrupted binary means the sidecar never
starts, which means tm8 has no database, which means a **completely dead product on first run** — the
worst possible first impression. This is why the binary is vendored (no network to fail), verified
(no silent corruption), and its absence is a *typed, actionable* error (`BinaryMissing`, §8), not a
stack trace.

---

## 3. Decision 2 — Pinned PG major + uuidv7 story

**DECISION: Pin PostgreSQL major = 18 (at cut: `18.4.0`). Use the native `uuidv7()` function
(built into PG 18 per RFC 9562) — no extension, no vendored SQL. Pin policy: auto-accept minor/patch
bumps within the pinned major; NEVER auto-accept a major bump (a major bump is a deliberate,
backup-gated migration per §3 below).**

### uuidv7 verification

PostgreSQL **18** (released 2025-09-25) ships a built-in `uuidv7()` returning RFC-9562
version-7 (time-ordered) UUIDs — confirmed against the PG 18 release notes and multiple independent
writeups. So `id uuid PRIMARY KEY DEFAULT uuidv7()` works with **zero extensions** on our pinned
major, and theseus publishes PG 18.4.0 for all four target platforms (§2). This is the happy path
and it holds today.

**Contingency (documented, not currently active):** *if* a future required platform lacked an 18+
build from our distribution, the fallback is a **vendored SQL `uuidv7()`** shim in migration `001`
(a small pl/pgsql or SQL function generating an RFC-9562 v7 UUID), used *only* on that platform, with
the **column type and default name identical** (`uuidv7()`), so the schema does not fork — the
function body differs, the contract does not. We are **not** shipping `pg_uuidv7` (the extension),
because an extension needs `CREATE EXTENSION` privileges and a matching `.so` per platform/major —
strictly more packaging risk than a pure-SQL function, and unnecessary given native 18 support.

### Pin policy details

- The pinned major lives in **one place**: `PINNED_PG_MAJOR = 18` in `packages/server` config,
  echoed in `db/README.md`. The bundled binary's actual version is read from the archive at build
  time and asserted `=== PINNED_PG_MAJOR` in CI (a mismatch fails the build).
- **Minors/patches** (18.4 → 18.5): binary is swapped in a normal release; data dir major is
  unchanged; **in-place start** (§3 state machine, "same major" branch). No dump.
- **Majors** (18 → 19): a deliberate decision that ships a new bundled major and triggers the
  backup-before-migrate machine (§4/decision 3). Never automatic, never silent.

**Failure mode if wrong:** a non-uniform id-generation story breaks **keyset pagination cursors**
(the whole read model paginates on time-ordered ids). If one platform silently used `gen_random_uuid()`
(v4, random) while others used `uuidv7()`, cursors would order inconsistently across nodes and the
schema would have forked in spirit even if the DDL looked the same. Pinning the major and the
function name forecloses this.

---

## 4. Decision 3 — Backup-before-migrate on major-version change (full state machine)

**DECISION: On every startup, read `<pgDataDir>/PG_VERSION` (the cluster's major) and compare to the
bundled major. Branch as follows. There is NEVER a silent `pg_upgrade`.**

```
readClusterMajor(dataDir)            // parse PG_VERSION; absent => "no cluster yet"
bundledMajor = PINNED_PG_MAJOR       // e.g. 18

case NO CLUSTER (fresh install):
    initdb(pgDataDir)                        // create cluster with bundled major
    start; run db/migrations 001..NNN
    -> RUNNING

case cluster.major == bundledMajor:          // the overwhelmingly common path
    start in-place
    run any pending db/migrations (idempotent runner)
    -> RUNNING

case bundledMajor > cluster.major:           // MAJOR UPGRADE (e.g. data=18, bundled=19)
    backupPath = <dataDir>/backups/pre-migration/premigrate_<from>-<to>_<UTCstamp>.dump
    1. start OLD cluster read-only-ish, pg_dump -Fc  -> backupPath      (fail => REFUSE)
    2. stop OLD cluster
    3. move old data dir aside: pg/<from>.pre-<stamp>/                  (never deleted here)
    4. initdb NEW cluster at pg/<to>/
    5. start NEW cluster; run base migrations to create schema
    6. pg_restore --data-only (or full) backupPath into NEW cluster    (fail => REFUSE)
    7. VERIFY: row-count + checksum probe on a fixed set of tables vs the dump manifest
    8. on success: keep backupPath (do NOT delete), keep old dir aside, -> RUNNING
    ANY failure in 1..7 => REFUSE TO START, surface backupPath, leave NEW dir removed,
                           OLD data dir untouched/restored to its original path

case bundledMajor < cluster.major:           // DOWNGRADE (e.g. data=19, bundled=18)
    REFUSE TO START. Do NOT touch data. Instruct user to install matching/newer tm8.
```

### Exact refuse-to-start error text

On major-upgrade failure (any step 1–7):

```
tm8: FATAL — Postgres major upgrade 18 -> 19 failed and tm8 will not start.
Your data was NOT modified. A complete pre-migration backup was written to:
  /Users/<you>/.tm8/pg/backups/pre-migration/premigrate_18-19_20260725T140322Z.dump
Restore it into a matching tm8 build (Postgres 18) with:
  pg_restore --clean --if-exists -d <db> premigrate_18-19_20260725T140322Z.dump
Nothing was upgraded. Report this with the log above to the tm8 team.
```

On downgrade:

```
tm8: FATAL — this tm8 build bundles Postgres 18 but your data dir was created by
Postgres 19 (~/.tm8/pg). tm8 will not start and will NOT touch your data.
Install a tm8 build with Postgres 19 or newer to open this workspace.
```

**Why refuse instead of best-effort:** `pg_upgrade` across majors on a user's laptop, unattended, is
the single highest-risk operation in the whole lifecycle. A partial upgrade can leave a cluster that
*looks* fine and silently drops or mangles rows. The only safe posture for a single-homed database
that is the user's source of truth (T-L5) is: **take a complete, restorable dump first; do the
migration into a brand-new cluster; verify; and if anything at all is off, stop and hand the user a
dump path they can trust.** Keeping the dump *and* the aside old data dir means even a botched verify
step is fully recoverable by hand. The downgrade case refuses outright because an older binary cannot
safely read a newer catalog — attempting it is how you corrupt a cluster.

**Failure mode if wrong:** a silent or partial upgrade corrupts or loses the user's entire graph with
no recovery artifact — unrecoverable data loss, the worst outcome in the system. The state machine
exists so that *the pessimal outcome of a version mismatch is "tm8 won't start and here's your
backup," never "your data is gone."*

---

## 5. Decision 4 — Scheduled `pg_dump` + on-demand export

**DECISION: Back up with `pg_dump -Fc` (PostgreSQL custom format). Run it (a) on a schedule via the
R26 server-block scheduler — **daily**, and (b) on demand via `backupNow()` / `exportTo(path)`.
Layout under `<dataDir>/backups/`. Retention: keep the last **7 daily** + **4 weekly**; prune older.**

### Format: `-Fc` (custom) over plain SQL

`-Fc` is chosen for **restore ergonomics**: it is compressed, and it supports **selective,
parallel, and reordered restore** via `pg_restore` (`--jobs`, `--table`, `--data-only`,
`--clean --if-exists`) — none of which a plain `.sql` dump (which you can only replay top-to-bottom
through `psql`) can do. Since these dumps are both the disaster-recovery artifact (§4) *and* the
substrate for the Phase-2 space-export story (see below), the restore flexibility of `-Fc` is worth
more than the human-readability of plain SQL. (An on-demand `exportTo()` MAY additionally offer
`-Fp` plain SQL when a human explicitly wants a readable diff-able artifact — a flag, not the
default.)

### Path layout

```
<dataDir>/pg/                                # the live cluster (major-scoped: pg/18/)
<dataDir>/backups/
  scheduled/
    daily/   tm8_<UTCstamp>.dump             # -Fc; pruned to last 7
    weekly/  tm8_<UTCstamp>.dump             # promoted from daily on the 1st daily each ISO week; last 4
  pre-migration/
    premigrate_<from>-<to>_<UTCstamp>.dump   # §4; NEVER auto-pruned
  on-demand/
    <caller-named>.dump                      # exportTo(path) may write elsewhere entirely
```

### Cadence, retention, hooks

- **Cadence:** daily, wall-clock, via the R26 scheduler (`packages/server`, the same job runner that
  does ledger-TTL / event-pruning / soft-delete purge). The scheduler calls
  `SidecarManager.backupNow({ tier: 'daily' })`. No separate cron.
- **Retention/prune:** after each successful daily dump, prune `daily/` to the newest 7 and `weekly/`
  to the newest 4. **`pre-migration/` is exempt** — those are safety artifacts and are only removed by
  the user. Log every prune (never silently drop a backup without a log line — the
  no-silent-truncation rule).
- **Concurrency:** a backup takes a lightweight, non-blocking dump (`pg_dump` uses a consistent
  snapshot; it does not lock out writers). Guard against overlapping runs with a `backup-in-progress`
  flag in the state machine so a slow daily dump and a manual `backupNow()` don't collide.

### Relationship to Q7 (space export)

A `pg_dump` of the whole cluster covers **~80%** of the Phase-2 space-export story (Q7) — it is the
disaster-recovery / trust-backstop artifact for single-homed spaces. It is **not the same artifact**
as a portable *space* export: Q7's space export is a **space-scoped** manifest (one space's rows +
`spaces/<id>/…` blobs + custom `entity_kinds` rows, with identity remapped on rehome per R13). This
plan delivers the node-level `pg_dump` backup now; the space-scoped export is built in Phase 2 on top
of the same `pg_dump`/`pg_restore` plumbing. Naming them distinctly here prevents W1 from
accidentally implementing one and calling it the other.

**Failure mode if wrong:** with single-homed spaces (a space lives on exactly one node), a lost or
corrupt data dir with no backup is **unrecoverable loss of the user's work** — backups *are* the
trust backstop that makes single-homing acceptable. No backup = the architecture's central trade
(T-L5) has no safety net.

---

## 6. Decision 5 — Health-check-then-start

**DECISION: After launching the postmaster, probe readiness with `pg_isready` against the sidecar's
socket, then confirm with one `SELECT 1` on a real pooled connection. Retry with backoff: up to
**60 attempts × 250 ms ≈ 15 s**, then hard-fail with `StartTimeout`. tm8-server does not accept
DB-backed requests until the probe passes.**

### Probe: `pg_isready` **then** `SELECT 1`

- `pg_isready -h <socketDir> -p <port>` answers "is the postmaster accepting connections" — cheap,
  purpose-built, no auth needed. It is the **liveness** gate.
- But `pg_isready` can report ready a beat before the database is truly serving queries (e.g. still in
  recovery/startup). So we follow it with **one real `SELECT 1`** over the app connection pool — the
  **readiness** gate — which also validates that our role, socket, and pool config actually connect.
- Only after both pass does `SidecarManager` transition to `RUNNING` and tm8-server begin serving.

### Backoff and hard-fail

- Fresh `initdb` + first start is the slow case; a warm restart is sub-second. 15 s of 250 ms polls
  comfortably covers cold start on a laptop without hanging the boot indefinitely.
- While waiting, tm8-server is in `STARTING`: it may bind its HTTP port and serve a
  **"database starting…"** health page / 503 on API routes, but it issues **no** DB queries.
- On timeout: transition to `FAILED`, kill the postmaster child if it is half-up, emit `StartTimeout`
  (§8) with the last `pg_isready` output and the postmaster log tail. Do **not** loop forever.

**Failure mode if wrong:** if tm8-server serves DB-backed routes before the sidecar is ready, the
user gets a cascade of 500s on first paint, and worse, a request could hit a half-migrated or
mid-recovery cluster. Health-check-then-start makes "not ready yet" a clean 503 with a spinner, never
a corrupt read.

---

## 7. Decision 6 — Single-instance locking + dev/prod non-interference

**DECISION: The sidecar listens on a **Unix-domain socket inside its own data dir** as the primary
connection path (so two clusters *physically cannot* share a listening endpoint), backed by a tm8
advisory `sidecar.lock` file (pid + port + socket path) and Postgres's own `postmaster.pid`. Dev and
prod get **distinct data dirs**, which is what makes the sockets distinct; when both stacks run
**concurrently** they also get distinct loopback ports (`~/.tm8` : 5442, `~/.tm8-dev` : 5443).**

### Mechanism (three layers, defense in depth)

1. **Unix-domain socket in the data dir (primary isolation).** Configure the postmaster with
   `unix_socket_directories = '<dataDir>/run'` and connect the Node `pg` pool via
   `host: '<dataDir>/run'`. The socket path is *derived from the data dir*, so the prod cluster and
   the dev cluster are reachable only through their own sockets — there is no shared namespace to
   collide on, even if a TCP port were misconfigured. This is the strongest guarantee and the one the
   app relies on.
2. **Loopback TCP as a secondary/tooling endpoint.** Also bind `127.0.0.1:$TM8_PG_PORT` (default
   5442 in both environments) so `psql`, `pg_isready` from a shell, and debugging tools work. Give a
   *concurrently running* second stack its own port (5443) so dev and
   prod can run **simultaneously** — the explicit old-maestro lesson (staging 4569 / prod 3001, plus
   `~/.maestro-staging` vs `~/.maestro`; a dual stack MUST get distinct dirs *and* ports or it
   corrupts). Binding TCP is best-effort: a port already in use is a hard `PortInUse` error (§8), not
   a silent second bind.
3. **tm8 advisory `sidecar.lock`** in the data dir, written on `ensureStarted()`: `{ pid, pgPort,
   socketDir, startedAt, tm8Version }`. Checked before every start.
4. **Postgres `postmaster.pid`** — Postgres's own guard; we never delete it by hand.

### Stale-lock detection / crash reclaim

On `ensureStarted()`, if `sidecar.lock` (or `postmaster.pid`) exists:

- Read the pid. If **no process** with that pid is alive → **stale** (previous crash). Reclaim:
  validate the postmaster is truly down (no listener on the socket/port), remove the stale
  `sidecar.lock`, let Postgres do its own WAL crash recovery on start (Postgres owns durability — WAL
  replay is automatic and we do not second-guess it).
- If a process **is** alive on that pid **and** it is our postmaster (matches port/socket) → the
  sidecar is already up; `ensureStarted()` is idempotent and returns the running status (do not start
  a second one).
- If a process is alive but is **not** ours (pid reused by an unrelated program) → treat the lock as
  stale but log loudly; proceed to reclaim only after confirming nothing is listening on our socket.

### Dev/prod isolation summary

| | prod | dev |
|---|---|---|
| Data dir | `~/.tm8` | `~/.tm8-dev` |
| Cluster | `~/.tm8/pg/18/` | `~/.tm8-dev/pg/18/` |
| Socket dir | `~/.tm8/run/` | `~/.tm8-dev/run/` |
| Loopback TCP | 127.0.0.1:`$TM8_PG_PORT` (**5442**) | 127.0.0.1:`$TM8_PG_PORT` (**5442**; set **5443** to run alongside prod) |
| Lock | `~/.tm8/sidecar.lock` | `~/.tm8-dev/sidecar.lock` |

**Failure mode if wrong:** two postmasters pointed at one data dir is the classic way to get
**catastrophic heap/WAL corruption** — precisely the failure the old maestro dual-stack narrowly
avoided by giving staging and prod distinct dirs and ports. The socket-in-data-dir design makes the
collision *structurally impossible* for the app path; the lock file and distinct ports make it
impossible for the tooling path too.

---

## 8. Decision 7 — PGlite fallback trigger

**DECISION: PGlite is a **distribution-failure-only** fallback. It is adopted for a target platform
**only if** the real sidecar binary genuinely cannot ship there — never as a preference, never for
size, never for convenience. Until a tripwire fires, PGlite stays **watched and unbuilt** (a
documented contingency, no code). It must **NEVER** fork the schema — the one-migration-sequence law
(T-L11) applies unchanged.**

### Concrete tripwires (any one fires the contingency, and only then)

1. A required target platform has **no shippable ≥18 build** from theseus **and** zonky (both
   distributions stop publishing our pinned major for that arch).
2. A platform's binary cannot be distributed for **signing/notarization/policy** reasons that block
   vendoring (e.g. an OS hardening rule that refuses an unsigned unpacked `postgres` binary — a real
   risk on future macOS; today it is not blocking because the sidecar runs from the user's own data
   dir, not a system location).
3. On-disk footprint of the vendored binary becomes a hard blocker for a specific channel (not the
   case at ~12 MB compressed / ~40–50 MB unpacked — **unverified uncompressed figure, measure at
   W1**).

### What changes vs what must NOT change if a tripwire fires

- **MAY change (per-platform, isolated):** the *connection driver* on that platform (an in-process
  PGlite instance instead of a socket to a child postmaster); acceptance that PGlite is
  single-connection (tm8-server must serialize DB access on that platform) and weaker on some
  extensions.
- **MUST NOT change:** the **schema** — `db/migrations/NNN_*.sql` run **verbatim** against PGlite;
  no PGlite-specific migration, no feature flag that drops a trigger/RLS policy/GIN index. If a
  migration cannot run on PGlite, that is a **blocker to shipping PGlite on that platform**, not a
  license to fork the schema. The contract (types, operation catalog, RLS posture) is identical.

**Failure mode if wrong:** if PGlite is adopted casually (because it is "simpler" or "smaller"), the
temptation to trim the schema to fit PGlite's limits forks the one migration sequence — and then
laptop and hub diverge, RLS/triggers behave differently per platform, and the entire
"one graph, one schema, everywhere" premise collapses. Gating PGlite behind distribution-failure
tripwires keeps the real Postgres the default everywhere it can possibly run.

---

## 9. Decision 8 — The implementation surface for `packages/server` (most important section)

This is the TypeScript-signature-level contract Castor/Altair implement at W1. **Signatures, states,
and prose only — no bodies.** Everything above is enforced *here*; each rule's enforcement point is
named.

### 9.1 Resolved config

```ts
/** Fully-resolved sidecar config. Produced by resolveSidecarConfig(env) at boot;
 *  every path is absolute; no further env reads happen after this. */
export interface ResolvedSidecarConfig {
  /** ~/.tm8 (prod) or ~/.tm8-dev (dev). The root of all sidecar state. */
  readonly dataDir: string;
  /** <dataDir>/pg/<major>/ — the live cluster for the pinned major. */
  readonly pgDataDir: string;
  /** Unpacked postgres bin/ dir for THIS platform (contains postgres, initdb,
   *  pg_ctl, pg_isready, pg_dump, pg_restore, psql). */
  readonly binariesDir: string;
  /** <dataDir>/run — unix_socket_directories; primary connection path (§7). */
  readonly socketDir: string;
  /** Loopback TCP port from TM8_PG_PORT: 5442 in both environments by default
   *  (§7). Secondary/tooling endpoint — the app connects over socketDir. */
  readonly pgPort: number;
  /** Pinned major, e.g. 18. Asserted === bundled binary major in CI (§3). */
  readonly pgMajor: number;
  /** <dataDir>/backups — scheduled/, pre-migration/, on-demand/ (§5). */
  readonly backupsDir: string;
  /** Low-privilege app role name (never superuser/table-owner — R2). */
  readonly appRole: string;
  /** Database name tm8 uses. */
  readonly database: string;
}

export function resolveSidecarConfig(env: NodeJS.ProcessEnv): ResolvedSidecarConfig;
```

### 9.2 Lifecycle state machine

States and the ONLY legal transitions. `SidecarManager` holds exactly one `SidecarState` at a time.

```
                 ensureStarted()
   STOPPED  ─────────────────────────►  STARTING
      ▲                                    │
      │ stop() ok                          │ (resolve/verify binary, lock, initdb-if-needed)
      │                                    ▼
   STOPPING ◄───────────── stop() ──── MIGRATING   (only if major mismatch — §4)
      ▲                        │           │
      │                        │           │ backup+initdb+restore+verify ok
      │                        │           ▼
      │                        └─────►  HEALTHCHECK  (pg_isready → SELECT 1 — §6)
      │                                    │
      │                                    │ both probes pass
      │                                    ▼
      └──────────────── stop() ───────  RUNNING
                                           │
        any unrecoverable error from       │  fatal error
        STARTING/MIGRATING/HEALTHCHECK ───►▼
                                        FAILED   (terminal; requires operator action)
```

- **STOPPED** — no postmaster; no lock held by us.
- **STARTING** — resolving/verifying binary (§2), acquiring `sidecar.lock` (§7), `initdb` if no
  cluster (§4 "no cluster"). On major mismatch → **MIGRATING**; else → **HEALTHCHECK**.
- **MIGRATING** — the §4 major-upgrade machine (dump → initdb new → restore → verify). Success →
  HEALTHCHECK. **Any failure → FAILED** with the backup path surfaced.
- **HEALTHCHECK** — §6 probes. Pass → RUNNING. Timeout → FAILED.
- **RUNNING** — serving. `status()` reports healthy; `backupNow()`/`exportTo()` allowed here.
- **STOPPING** — graceful `pg_ctl stop -m fast`; release lock; → STOPPED.
- **FAILED** — terminal. tm8-server does not serve DB routes. Requires operator action (usually:
  install matching build, or restore the surfaced backup). `ensureStarted()` from FAILED is a no-op
  that re-throws the stored fatal error until the process restarts.

**Downgrade** (bundled < cluster) is detected in STARTING and goes **straight to FAILED** (never
MIGRATING) — we do not touch data (§4).

### 9.3 `SidecarManager` API

```ts
export interface SidecarStatus {
  state: 'STOPPED' | 'STARTING' | 'MIGRATING' | 'HEALTHCHECK' | 'RUNNING' | 'STOPPING' | 'FAILED';
  pgMajor: number;
  clusterMajor: number | null;      // from PG_VERSION; null if no cluster yet
  pid: number | null;               // postmaster child pid
  socketDir: string;
  pgPort: number;
  lastError?: SidecarError;         // set in FAILED
  migration?: {                     // present during/after a major upgrade
    from: number; to: number; backupPath: string; verified: boolean;
  };
}

export interface BackupResult {
  path: string;                     // absolute .dump path
  format: 'custom' | 'plain';       // -Fc default; -Fp only when explicitly requested
  bytes: number;
  tier: 'daily' | 'weekly' | 'pre-migration' | 'on-demand';
  startedAt: string; finishedAt: string;  // ISO-8601 UTC (no Date.now() in workflow scripts; server uses real clock)
}

export interface SidecarManager {
  /** Idempotent. Resolve+verify binary (§2) → lock (§7) → initdb/migrate (§3/§4)
   *  → health-check (§6) → RUNNING. If already RUNNING, returns current status.
   *  Throws a typed SidecarError (§9.4) on any unrecoverable failure; on a major
   *  upgrade failure the thrown error carries the backup path. */
  ensureStarted(): Promise<SidecarStatus>;

  /** Graceful shutdown (pg_ctl stop -m fast), release lock, → STOPPED. Idempotent. */
  stop(): Promise<void>;

  /** Non-throwing snapshot of current state (safe to poll for the health page). */
  status(): SidecarStatus;

  /** On-demand pg_dump -Fc into <backupsDir>/on-demand (or scheduled tier when
   *  called by the R26 scheduler). Guarded against overlap (§5). RUNNING only. */
  backupNow(opts?: { tier?: 'daily' | 'weekly' | 'on-demand' }): Promise<BackupResult>;

  /** Export a dump to an explicit path (Q7 groundwork; §5). Default -Fc; pass
   *  format:'plain' for a readable -Fp artifact. RUNNING only. */
  exportTo(path: string, opts?: { format?: 'custom' | 'plain' }): Promise<BackupResult>;
}
```

### 9.4 Error taxonomy (what it throws, and where each is raised)

```ts
export type SidecarErrorCode =
  | 'BinaryMissing'        // §2  no vendored archive / unpacked bin for this platform (STARTING)
  | 'BinaryChecksumFail'   // §2  SHA-256 mismatch on the vendored archive (STARTING)
  | 'InitdbFailed'         // §4  initdb of a new cluster failed (STARTING/MIGRATING)
  | 'MajorDowngrade'       // §4  bundled major < cluster major; refuse, data untouched (STARTING)
  | 'MigrationBackupFailed'// §4  pre-migration pg_dump failed; carries no partial cluster (MIGRATING)
  | 'MigrationRestoreFailed'//§4  restore/verify into new cluster failed; carries backupPath (MIGRATING)
  | 'StartTimeout'         // §6  health probes never passed within budget (HEALTHCHECK)
  | 'PortInUse'            // §7  loopback TCP port already bound (STARTING)
  | 'LockHeld'             // §7  a live, foreign sidecar holds the data dir (STARTING)
  | 'BackupFailed'         // §5  scheduled/on-demand pg_dump failed (RUNNING)
  | 'SchemaMigrationFailed';// db/migrations runner failed applying NNN_*.sql (STARTING/MIGRATING)

export class SidecarError extends Error {
  readonly code: SidecarErrorCode;
  readonly backupPath?: string;   // set for Migration* errors (§4) — the recovery artifact
  readonly detail?: string;       // postmaster log tail / pg_isready output / stderr
}
```

Rules a Migration* error must satisfy: it **always** carries `backupPath` when a dump was taken, and
raising it transitions the manager to **FAILED** without deleting the backup or the aside old data
dir (§4). `MajorDowngrade` is raised **before any write** — nothing on disk is touched.

### 9.5 Where each R15 rule is enforced

| Rule | Enforced in |
|---|---|
| Binary choice + verify (§2) | `resolveSidecarConfig` + `ensureStarted` (STARTING): resolve triple, SHA-256, unpack |
| Pinned major + uuidv7 (§3) | `pgMajor` in config; CI asserts binary major === `PINNED_PG_MAJOR`; schema uses `uuidv7()` in migration 001 |
| Backup-before-migrate (§4) | MIGRATING state; `SidecarError` (`Migration*`, `MajorDowngrade`) → FAILED with `backupPath` |
| Scheduled + on-demand backup (§5) | `backupNow()` (R26 scheduler calls daily) / `exportTo()`; retention prune after each daily |
| Health-check-then-start (§6) | HEALTHCHECK state; `pg_isready` then `SELECT 1`; `StartTimeout` on budget exhaustion |
| Single-instance locking (§7) | STARTING: socketDir in data dir + `sidecar.lock` + `postmaster.pid`; stale reclaim; `LockHeld`/`PortInUse` |
| PGlite fallback (§8) | Not built. Contingency documented; tripwires watched; schema never forks if it fires |

---

## 10. Open questions for Vega

1. **Ports for a concurrent dev+prod stack.** Settled law names one triple (4610 / 4611 / 5442) and
   two data dirs, so a *simultaneous* dev and prod stack has no canonical second port set. Defaults
   here and in `docs/ops/CONFIG.md` §3 stay on the law's numbers for both environments; the second
   stack overrides `TM8_PORT` / `TM8_UI_PORT` / `TM8_PG_PORT`. Ops recommends `+10` for the server
   pair (4620/4621) and **5443** for the sidecar. Ratify or replace. Note this is a *tooling*
   convenience only: socket-in-data-dir (§7) already makes the app path collision-proof, and the
   launchers refuse to start on an occupied port rather than silently rebinding.

2. **Release channel / hosting for vendored binaries.** Vendoring means the tm8 release tarball
   carries the ~12 MB Postgres archive per platform, and CI produces four platform tarballs. Confirm
   the release pipeline/host (GitHub Releases? a CDN?) so I can pin the SHA-256 baseline and wire the
   `binaries.ts` resolver + CI major-assertion. This is a packaging decision that touches how CI
   builds the release, which is my surface.

3. **theseus vs zonky as the pinned distribution of record.** Both ship PG 18.4.0 for all four
   targets today. I recommend **theseus** (plain per-triple tarballs + published SHA-256 + full build
   layout). If you'd rather pin **zonky** (Apache-2.0 tooling, apt-repackaged), say so before W1 —
   it changes the resolver and the pin manifest, not this plan's shape.

4. **Backup retention numbers.** I've proposed 7 daily + 4 weekly, pre-migration dumps never
   auto-pruned. If you want a different cadence or a disk-budget cap (prune by total size rather than
   count), it's a one-line policy change in the scheduler hook — flag it now.

5. **`exportTo()` scope for Q7.** This plan delivers the node-level `pg_dump` backup now and names the
   space-scoped Phase-2 export as *distinct*. Confirm Castor/Altair should build **only** the node
   backup at W1 (not the space export), so W1 doesn't over-build.

6. **Unverified figure to measure at W1.** Compressed archive sizes are verified (§2). The
   **uncompressed on-disk** footprint (~40–50 MB estimate) is **unverified** — I did not unpack an
   archive. Castor should measure it during W1 and record it, since it feeds tripwire 3 (§8).
