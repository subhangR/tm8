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

The runner launches a fresh Chromium process for each restored visit, with
empty browser storage. This also avoids single-process Chromium context reuse
crashes on the shared software-rendering host. Screenshots have a 90-second
readback deadline; renderer readiness still requires actual drawn frames.
The runner stops its owned API/Vite
children, including on failure; the caller owns cluster startup/teardown.

`acceptance.json` contains exact head, migration digest, check names, counts,
booleans, and timings. Screenshots show only synthetic records. Auth tokens and
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
