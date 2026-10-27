# Native MCP journey against the real backend

Use this when changing the native MCP adapter, attachment picker, or launch wiring.
The harness mounts the production components and `createRealSeam`; it does not
intercept requests or replace the MCP port. Only the vendor executable and remote
MCP provider are synthetic, started by `tools/rigs/mcp-browser-fixture.mjs`.

1. Build the assembled repository with `bun run build` and start that disposable
   backend fixture. It applies migrations to its own database, seeds an owner,
   task and teammate, and prints a private local `fixture.json` path. Use the
   fixture's configured test PostgreSQL instance, never production.
2. In `packages/tm8-ui`, run Vite with `TM8_SERVER_ORIGIN` set to the fixture's
   backend URL and `--host 127.0.0.1 --port 5173 --strictPort`.
3. Run `node e2e/mcp-real-browser-check.mjs` from the UI package, with
   `MCP_UI_URL=http://127.0.0.1:5173`, `MCP_JOURNEY_SETUP` set to that fixture file,
   and optionally `MCP_CHROMIUM_PATH` for a locally installed Chromium.
   `MCP_JOURNEY_EVIDENCE` selects the output directory (default
   `/tmp/mcp-real-browser`). Browser system libraries must be available.
4. Stop the backend fixture to terminate its children and drop its owned database.

The driver registers and approves a connector, attaches it to a task, verifies
that missing credentials block launch, creates a private synthetic key account,
discovers real fixture tools, selects that named account, and calls production
spawn. It checks the resulting session's actual child bridge JSONL for a tool
result. Revoking the account must disable browser readiness and produce a child
bridge error on subsequent calls. It also rejects synthetic key disclosure in
child output. Each run uses unique connector/account labels.

`results.json` records checks, session-scoped bridge results, and HTTP methods,
paths and statuses; `complete.png` records the final native UI. Request bodies,
authorization headers and session setup tokens are not recorded. This verifies
the API-key journey; OAuth callback and permission-denied cases have separate
component and backend security tests.
