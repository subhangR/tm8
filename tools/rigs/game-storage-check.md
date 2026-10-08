The durable Game acceptance runner uses a real compiled server, CLI, isolated
PostgreSQL database, and Chromium. Its synthetic browser harness mounts the
production GameMode, real Seam, map loader, HTTP adapter, and Three renderer. The renderer's actual
player/camera are checked independently of the saved DTO.

Create a dedicated loopback PostgreSQL cluster and database on a port other
than 5432/5442. Run the official migration chain from the exact checkout:

```sh
TM8_DATABASE_URL=postgresql://tm8@127.0.0.1:18431/tm8_storage node db/migrate.mjs up
bun run build
GAME_STORAGE_DATABASE_URL=postgresql://tm8@127.0.0.1:18431/tm8_storage \
GAME_STORAGE_RUN_DIR=/tmp/tm8-storage-acceptance \
node tools/rigs/game-storage-check.mjs
```

The connection role needs owner bootstrap permissions; production PgDb changes
to `tm8_app` for each authenticated transaction. Acceptance also queries as that
role with a nonmember identity and a positive owner control.

Override `GAME_STORAGE_API_PORT` (18432), `GAME_STORAGE_UI_PORT` (18433), and
`GAME_CHROMIUM` when needed. Set `GAME_STORAGE_API_ONLY=1` to run backend/CLI
checks while preparing a browser checkout, `GAME_STORAGE_BROWSER_ONLY=1` for
browser checks, or `GAME_STORAGE_COST=1` to add the 100-placement context and
128-memory save latency probes plus a 60-second real rendered walk. The latter
reports request counts and `pg_column_size` row growth, rather than WAL or disk
allocation. Linux Chromium may require `LD_LIBRARY_PATH` pointing to a local
dependency bundle; no system libraries are installed by this runner.
`GAME_STORAGE_COST_ONLY=1 GAME_STORAGE_BROWSER_ONLY=1 GAME_STORAGE_COST=1`
uses a separate fresh fixture for just the cost probes and rendered walk.

The runner launches a fresh Chromium process for each restored visit, with
empty browser storage. Chromium uses single-process SwiftShader and
`--no-zygote`; an earlier run stalled in an idle lock wait after a footprint
scene became ready without the current teardown guard. That interrupted run
retains its two completed checks and incomplete overall result. Browser launch,
evaluation and teardown have labelled before/after checkpoints. Context and
browser teardown are bounded at 15 seconds, then the rig kills only its own
BrowserServer process and records `browserCloseForced`. Screenshots have a 90-second
readback deadline; renderer readiness still requires actual drawn frames.
The software browser viewport is 800×600. Most visits use the standard
reduced-motion preference. A separate fresh visit uses default motion and
checks the independently observed restored scene immediately and after three
idle seconds. Exact scene
player/camera and stored current/stack/memory assertions remain unconditional.
Traffic separates the 60-second regular-send window (budget at most 20) from
pagehide flushes; this walk performs no route or visibility changes.
For a reserved shared-host window, set `GAME_STORAGE_WINDOW_END` to its
agreed ISO timestamp and launch `node tools/rigs/game-storage-window.mjs`.
This external watchdog starts owned-process cleanup five seconds before the
window ends, escalates after three seconds, and writes `window-closure.json`.
It captures only descendants of the runner it spawned and checks each PID
start time before signalling, including in the forced-stop path. Missing or
already-expired reservations are refused before launching. This guard covers
an unresponsive browser or runner; it does not change product timeouts or
functional assertions. The check runner stops its owned API/Vite children
on ordinary completion or failure; the caller owns cluster startup/teardown.

`acceptance.json` contains the exact head, active checkout, backend and adapter
heads, official map migration SHA256, full migration-chain SHA256, check names, counts,
booleans, timings and forced browser teardown count. Screenshots show only synthetic records. Auth tokens and
saves remain in memory; lifecycle logs stay local and are not published. A new
fixture is seeded per run, so reusing this isolated database is safe. Other lanes
must use separate named databases and listener ports in a shared test cluster.

The dependency manifest names the backend, adapter, event checkpoint, and
Taskland geometry used for validation. This verification does not establish
the full Game release. Placement changes are seen on reload; there is no map
live channel in the storage slice. Opening an implicit deleted map restores its
identity. A final pose during account switch remains browser-only because the
old identity's requests are aborted. Fingerprint retention follows the core
ledger cleanup window and removes eligible fingerprints on the next mutation.
A timed-out save that committed server-side currently halts and requires the
explicit Save action to read the revision and replace this visit. The failed
software-browser attempt committed on the server in 82 ms, while a starved
browser main thread caught the 15-second timeout after 26.1 seconds. It is
retained as failed evidence. Viewport changes are test-environment mitigations;
the production timeout, queue, and exact scene comparisons are unchanged.

For a separately authorized startup diagnosis, set
`GAME_STORAGE_DIAGNOSTIC_PROBE=1` when running the same external window guard.
The probe uses the exact acceptance binary and launch arguments, first loads
a simple `data:text/html` page, and opens the actual harness with WebGL only
after that succeeds. `startup-probe.json` is diagnosis and supplies no acceptance
result. No alternative launch flags are tried.

The guard enables `DEBUG=pw:browser*` and saves Chromium stderr to a new,
exclusive `browser-stderr.log` under the run directory. With
`GAME_STORAGE_BROWSER_DIAGNOSTICS=1`, the ordinary acceptance entry also captures
that local stderr and before/after service cgroup counters. Browser lifecycle
checkpoints identify page crashes, browser disconnections, and the registered
owned process's actual binary and exit code/signal. The public owned process's
stderr pipe is tapped before navigation because Playwright's `launchServer`
internal progress controller omits those lines from DEBUG output. The tap leaves
Playwright's existing pipe reader intact. Host snapshots retain a bounded kernel
tail or the permission-denied result. These raw diagnostic files remain local;
only selected synthetic failure details and counts belong in published evidence.

The host's headless-shell 1208 crashes during multi-process startup even on a
data page. The advisor reproduced the GPU-process sandbox error and SIGSEGV.
The shared launch options therefore use the same single-process SwiftShader
arguments as the earlier successful nested restart. Fresh owned BrowserServer
processes, bounded registered-only teardown and the external deadline guard
remain in use. A forced browser close is disclosed as an environment limit;
only checks that asserted their results before teardown can count as passes.
