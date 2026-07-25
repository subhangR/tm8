# @tm8/conformance — the contract conformance suite

Black-box HTTP suite that runs against ANY base URL. It is the M1 gate
artifact (G1: "conformance green headless") and runs RED today by design
(G0: harness executes against a stub).

## Running

```sh
bun run test                                    # default target http://localhost:4610
TM8_CONFORMANCE_BASE_URL=http://host:port bun run test   # any deployment
bun run stub                                    # standalone stub on :4610
```

If nothing is listening on the default target, the vitest global setup starts
the in-package stub automatically — the suite always executes end-to-end.

## What the stub is (and is not)

`src/stub-server.ts` answers every catalog operation with an honest,
contract-shaped `501 not_implemented` (unknown routes 404, malformed JSON
400). It proves the wire-error envelope and 501-honesty rules and makes every
semantic suite fail red. It is NOT `packages/server` and must never grow
semantics.

## Suites

| File | Covers |
|---|---|
| `envelope.test.ts` | DEV-6 `{data, requestId}`; wire error body shape |
| `taxonomy.test.ts` | DEV-8 closed codes + status mapping; reserved ops 501; v1 ops never 501 |
| `cursors.test.ts` | DEV-5 keyset cursors: opacity, no overlap/skip, `invalid_cursor` |
| `idempotency.test.ts` | DEV-9 command-ledger replay; cross-op id reuse → `invariant_violation` |
| `events.test.ts` | WorkspaceEvent shape, `clientMutationId` threading, eventId dedupe, `since` catch-up (ported: reconciliation/stores-replay core) |
| `reads.test.ts` | ported UI foundation `contract-reads` (world built via the API) |
| `commands.test.ts` | ported `commands` + `validation` (versions, conflicts, edges, placements/undo, completion→award→unblock, DEF-1/2/3) |
| `execution.test.ts` | R16 family: honest gating pre-M3, work_session shapes, spawn-only creation |

`src/world.ts` replaces the UI's seeded MockFacade: each suite builds its
narrative through the public API in `beforeAll` — on a non-conformant server
the build itself fails red.
