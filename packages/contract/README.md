# @tm8/contract — THE LAW

Types + zod schemas + operation catalog + WorkspaceEvent + error taxonomy +
keyset-cursor helpers + wire envelope. The only shared dependency across
packages (T-L12 / api-design L1). Runtime-agnostic (bun or node).

## Provenance

- `src/contract.ts` §1 — near-verbatim transcription of the Collab V2 UI's
  `types/contract.ts` (vendored at `docs/ui-snapshot/ui-types-contract.ts.txt`).
  Keep the diff ~zero: the W3 UI transplant depends on it.
- `src/contract.ts` §2 — tm8 extensions per `docs/tm8-architecture/03-ENTITY-GRAPH-DELTAS.md`:
  `work_session` + `collection` core kinds, custom `c:*` kinds (R7–R9),
  `execution.*` inputs (R16/R17), `entity_kinds` registry shapes.
- `src/catalog.ts` — the closed operation catalog (api-design `02 §4` +
  `execution.*` + `entityKinds.*`), with HTTP bindings and the reserved
  (`501 not_implemented`) markers. `search.query` is the only reserved v1 slot
  (DEV-13).
- `src/schemas.ts` — zod schemas for every shape, compile-bound to the types
  via `z.ZodType<T>`. DTO schemas are `.strict()` (drift = failure); command
  inputs are `.strict()` (unknown field = `invalid_input`, DEF-1/2/3).
- `src/cursor.ts` — DEV-5 keyset cursors (`{v:2,k:[...]}` base64url).
- `src/envelope.ts` — DEV-6 `{data, requestId}` + DEV-8 wire error body.

## Rules for consumers

- Server validation, CLI `--json`, and MCP tool schemas derive from
  `src/schemas.ts` — never re-declare shapes.
- Contract changes are authored ONLY by the platform lead (Rigel) and
  broadcast via STATE.md. Do not extend unions or the catalog in downstream
  packages.
- `work_session` is not client-creatable via `entities.create`; it is born
  only from `execution.spawn` (R16), and its `status` has a single writer
  (R29).

## Verify

```sh
bun run build   # tsc -b
bun run test    # vitest (18+ self-tests: taxonomy, cursors, catalog, schemas)
```
