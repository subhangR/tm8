Run from an isolated checkout after `bun run build`:

```sh
TASKLAND_TEST_ADMIN_URL=postgresql://test_role@127.0.0.1:18431/postgres \
TASKLAND_TEST_API_PORT=18441 TASKLAND_TEST_UI_PORT=18442 \
TASKLAND_EVIDENCE_DIR=/tmp/taskland-evidence \
node packages/tm8-ui/e2e/taskland-server-run.mjs
```

The PostgreSQL cluster must be an approved test cluster. The runner refuses ordinary/prod PostgreSQL ports, creates a fresh `tm8_taskland_*` database, applies the official migration runner from this checkout, builds an immutable browser harness, and starts private API/Vite preview processes. It never resets a preexisting database or owns the shared PostgreSQL process. Use free API and Vite ports. Dependencies can be shared read only; workspace package links, TypeScript outputs and the Vite cache must belong to the checkout. Check the test host separately with `node node_modules/typescript/bin/tsc -p packages/tm8-ui/e2e/taskland-server.tsconfig.json`.

The fixture creates synthetic space, story, task hierarchy, member and teammate records through real HTTP endpoints. A local synthetic provider executable runs the real `echo-agent` harness, exercising tm8's production spawn/resume arguments and server-issued session identity without a model or provider credential. This verifies tm8's durable runtime lifecycle, not a real provider conversation. A fixture-only credential rotation binds the local token to that runtime. The token stays in memory and is never included in reports or screenshots. Task/status/criterion/edge/read/placement mutations go through the real tm8 API, with action and current-version reads before entity commands.

The browser uses the production real Seam, Game map loader, GameMode, model and WalkingMapView. Synthetic data lives on the server; the page does not replace server DTOs with decorative or in-memory fixtures. Diagnostic before/after models contain only synthetic identities and selected map fields. Screenshots must wait for the actual canvas, loaded assets and projected scene labels. Chromium software WebGL acceptance is explicitly separate from native GPU evidence.

All owned API/Vite/browser processes and the runner's database are cleaned up on success or failure. Local lifecycle logs remain in the private run directory for diagnosis; publish only `checks.json`, approved synthetic screenshots and aggregate check/build logs. Never publish raw runtime files, credentials, private snapshots or unfiltered server logs.

The runner first stages an unchanged private migration tree through 316, creates a historical cancelled task with a null transition date, then applies 317 using this checkout's official runner. This gives the cold loader a real bounded observation. Checks cover its deadline, exact-date precedence after reopen/re-cancel, no-op timestamp preservation and exact injected 24-hour expiry without invented database dates. Historical rows without either authoritative evidence remain unknown.

The immutable build also includes the existing synthetic Taskland harness. After closing the real-server browser, the runner invokes the supplied `taskland-check.mjs` unchanged against the same preview and commit. Its both-scope motion screenshots and actual Three worker frame readback are linked from the aggregate report. Reserve one exclusive software browser window for these sequential captures. `TASKLAND_RENDER=0` runs the HTTP/loader checks without either rendered sequence and explicitly records that omission.

For a shared host, set `TASKLAND_RENDER_GATE` to a fresh private file path. HTTP/model work finishes first; rendered work waits for a JSON receipt containing this exact `head` and the actual peer closure/release message references. Write that file only after the agreed window is explicitly released. A missing receipt fails after 30 minutes; elapsed time never authorizes capture. The standalone host enables the same real session-visibility liveness cadence as the app and refreshes the node's actual PTY live set before static model receipts.
