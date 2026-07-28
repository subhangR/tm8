# @tm8/conformance

W1 contract-generation and exhaustiveness evidence, plus a separately invoked
black-box HTTP semantic suite for W2/W3.

## Historical W1 green gate

```sh
bun run generate          # refresh deterministic generated evidence
bun run check:generated   # fail when committed evidence is stale
bun run build
bun run test              # generated/foundation/honesty tests only
```

`bun run test` is the command behind root `bun run test:conformance`. It does
not require a Server and does not claim API semantics exist. It verifies:

- exact catalog accounting: 101 total, 99 v1, 2 reserved, 100 HTTP, 1 WS;
- actual catalog-derived Router accounting and stub route reachability;
- the immutable checked-in W1 handler/input-schema snapshot (28 handlers,
  36 bindings, 13 explicitly unbound commands), with every operation and
  contract schema entry validated before generation;
- A01–A20 order/bindings, A16 POST/read metadata, strict additive and frozen
  schema reachability;
- exact-operation help/exposure foundations, including internal-only
  `execution.prompt`, honest reserved operations, and WS-skeleton status;
- total 15-core-kind + `c:*` route/collection/projection/capability/menu/
  migration dispositions and the `ui_template` negative sentinel;
- stable W0/harness case IDs for later W2–W5 execution.

The generated manifest is
`generated/w1-conformance-manifest.json`. It contains no timestamp and is
checked byte-for-byte for staleness. Its migration section is bound to the
coordinator-frozen `db/migrations/015_w1_foundations.sql`, verifies that file's
SHA-256 before generation, and derives its tables, registry seeds, indexes,
triggers, RLS coverage, policies, and closed RPC allowlists from the SQL.

The W1 registry snapshot is historical gate evidence, not a claim that current
Server composition remains at the W1 boundary. Generation never reads the
generated manifest as input.

## Current W2 source inventory — I01 tranche only

The foundation test separately parses current Server source. For the facade it
follows only local exported `register*` seams that are imported and invoked by
`packages/server/src/facade/index.ts`, then parses literal registrations in
those directly mounted modules. Execution/events retain their direct source
inventory. Unknown, duplicate, computed, or otherwise nonliteral operation
registrations fail closed.

This current-source check proves the frozen I01 tranche-v1 boundary only:
57 facade + 4 execution + 1 event handler = 62, 47 input-schema bindings,
exactly three unfinished unbound commands, 36 unimplemented registerable v1
HTTP operations, and neither reserved operation mounted. It does not rewrite
the W1 manifest, claim all W2 semantics, or add a discovery surface.

## W2/W3 live semantic gate — pending

```sh
TM8_CONFORMANCE_BASE_URL=http://host:port bun run test:live
```

`test:live` runs the unchanged black-box suites in `test/*.test.ts` against a
real Server. They cover envelopes, taxonomy, cursors, idempotency, reads,
commands, events, execution, projects, and files. These suites are not part of
the historical W1 green gate. The W1 manifest records its frozen 28-handler
boundary, while the separate current-source I01 inventory records 62 mounted
handlers; remaining W2 groups and public semantic verification are still
outside this tool-only check.

If no Server is reachable, the live command starts `src/stub-server.ts`. The
stub returns contract-shaped `501 not_implemented` for every known HTTP route,
`404 not_found` for unknown routes, and implements no semantics. Consequently
the live suite fails loudly against it. The command never skips, weakens an
assertion, or reports semantic verification from the stub.

## Stub oracle

```sh
bun run stub
```

The stub is only a route/error-honesty oracle. Do not add domain behavior to
it; production semantics belong to W2 and public-boundary verification to
W3.
