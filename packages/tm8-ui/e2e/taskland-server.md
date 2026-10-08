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

Legacy cancelled tasks with no authoritative status transition timestamp are an explicit limitation: the model warns that their expiry is unknown. Tests create fresh transitions and require real clock truth, no-op cancellation timestamp preservation and exact injected 24-hour expiry; they never write invented dates into database rows.
