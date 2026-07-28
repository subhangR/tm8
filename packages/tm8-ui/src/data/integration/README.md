# `src/data/integration/` — the real seam against a real node

Bridge lane B4. These suites drive the **shipped** client (`../real/`, via
`createRealSeam()`) against a **real** tm8 node: the production composition root
booted in-process from `packages/server/src`, over a throwaway database built
from the full official migration chain, on an ephemeral loopback port.

## Run it

```
cd packages/tm8-ui
./node_modules/.bin/vitest run --config src/data/integration/vitest.config.ts
```

Requires the Postgres sidecar on `127.0.0.1:5442`. Nothing else — no build, no
running server, no `pg` npm dependency.

**Not** `bunx vitest` (charter: server code never runs under bun) and **not** a
bare `vitest` — measured on this machine, a bare `vitest` resolves to
`…/maestro/agent-maestro/node_modules/.bin/vitest`, a real runner answering
about the wrong tree.

## Four rules that look like details and are not

**1. `.itest.ts`, never `.test.ts`.** The package's own `vite.config.ts`
includes `src/**/*.{test,spec}.{ts,tsx}` and the package-root runner never loads
the config in this directory. A `.test.ts` file here is collected by every FE
worker's `vitest run` and fails at import, because the bare specifiers resolve
only under this directory's aliases. That failure runs *zero* tests, so the
"Tests passed" line stays green and blind while the exit code is 1. An
`INTEGRATION_ENABLED` env gate does **not** help: `describe.skipIf` gates
execution, and the import chain resolves first. The filename suffix is the only
mechanism, deliberately — a second mechanism that is silently useless is how
this recurs.

**2. Boot from source, never from `dist`.** `packages/server/dist` predates the
Delta 1 mapper passthrough arm. A dist-booted node reports `menu.updated` as not
flowing, which is indistinguishable from the Delta 1 MERGED signal being wrong.
Nothing in this lane builds or promotes anything.

**3. Scratch databases only, `tm8ui_b4_*`.** Booting a node is a **write**:
`bootstrap()` runs `reconcileGhosts()`, which retires every `work_sessions` row
still at `running`. `assertNotSharedDatabase` refuses any name outside the
prefix before the first byte is written, and `db/migrate.mjs` gets an explicit
`TM8_DATABASE_URL` on every invocation because its no-env fallback is `tm8_dev`.

**4. Ground truth comes from the table.** Every exact-set assertion compares the
wire against a superuser `psql` read of `workspace_events` — never only against
another reader of the same log. Two readers can truncate identically and agree
perfectly on a lie; that is the W5 cursor-truncation class (9 seeded, 3
returned, no error).

## The suites

| file | acceptance (LLD §11) |
|---|---|
| `seq-spine.itest.ts` | WS and poll agree on the seq spine, and both agree with the table |
| `kill-resume.itest.ts` | socket severed mid-stream — no loss, no duplicate, honest `live → polling → live` |
| `cursor-integrity.itest.ts` | cursor round-trip integrity with a seeded-count control, **plus negative controls** |
| `delta1-passthrough.itest.ts` | `menu.updated` + `space.default_channel.updated` flow live, verbatim, on both transports |
| `optimistic-echo.itest.ts` | optimistic round-trip via `clientMutationId` — all three exits |
| `liveness.itest.ts` | `execution.liveness` serves real data (A21, Delta 2); second life of the retired scheduled-failure `liveness-absent.itest.ts`, whose disposition executed as written |

## Known scaffolding, to be removed rather than maintained

`server-src.d.ts` hand-declares the node builtins and the two server modules
this lane imports, because `packages/tm8-ui` deliberately ships no
`@types/node`. Delete it the day `@types/node` is resolvable here and the server
exposes a test entry point — it is scaffolding around an absence, not a design.
