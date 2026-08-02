# tm8 W3 Public and Agentic Verification Evidence

**Wave:** W3 — independent public API and agentic verification  
**Task:** `task_1785034451796_fhqepjeyl`  
**Coordinator:** `sess_1785092163476_4on0tyohq` (resumed 2026-07-27 under M-1; supersedes terminated `sess_1785068799199_cazksrch4`)  
**Started:** 2026-07-26  
**Status:** resumed under M-1; tranche-v1 regression sweep re-verified green; eight groups hold public PASS  
**Scope:** production `Server` HTTP/WS behavior and database-observable outcomes only. No CLI, UI, Remote Phase 2, production edits, fake registry, direct-handler acceptance, or git.

## 1. Gate protocol

The user authorized W3 to run as a rolling stream before all W2 groups finish and designated this W3 coordinator as the independent public gate. The normal separate Opus review at the W2-to-W3 handoff is waived. This does not waive the final W3 G3 requirements.

For each W2 group:

1. W2 marks the implementation verified/frozen and separately declares its production-Server registration public-ready.
2. W3 exercises every operation through the actual production `Server` HTTP or WebSocket boundary. Direct handler imports, a custom registry, and mocked public acceptance are forbidden.
3. W3 verifies standard envelopes/errors, strict input, database-observable state, replay/idempotency, cursor/version behavior, authorization negatives, and honest unavailable behavior relevant to the group.
4. A public failure returns to W2 with exact reproduction evidence for a fresh scoped Sol-xhigh fix. Agentic verification does not start for a failing group.
5. Only after public PASS does W3 create a dedicated child task and spawn an independent agentic discovery-and-use tester. That tester starts only from the bounded W3 evaluator projections described in §1.1, selects operations without a hidden operation list, invokes them through public HTTP/WS, and proves database-visible results.
6. Any fix is independently retested. No implementation author verifies their own work.

The production boundary is `bootstrap()`/`main()` in `packages/server/src/main.ts`, with the catalog router, shared `INPUT_SCHEMAS`, the one loopback identity resolver, and the configured database-backed handler registry. With no `TM8_DATABASE_URL`, the registry is intentionally empty and catalog operations return `501`; that mode is not an implementation verdict.

### 1.1 API-only agentic discovery ruling

The full-program coordinator clarified the W3-only interpretation of generated discovery. W3 must not add or request an unlisted Server HTTP discovery operation or resource. The real CLI/help bootstrap is W4/W5 scope.

For W3, a W3-owned evaluator adapter reads `tools/conformance/generated/w1-conformance-manifest.json`, mechanically verifies that its catalog digest matches the current contract catalog, and exposes only bounded root/noun summaries plus lazy exact-operation lookup to the agentic tester. It must not expose repository source, implementation files, database internals, or a hidden hardcoded operation list. The tester receives the API base URL and bearer environment-variable name; every actual read or command still executes through the production Server HTTP/WS boundary and must prove public/database-visible outcomes.

W2 C01 later reconfirmed that the generated manifest itself remains byte-identical at SHA-256 `062ec620b8f9be87bc0a96f3bb30e900d0befff540b37e2ddc3ff418c3b9ce5a`, with generator/check tests 14/14. This artifact hash is distinct from, and consistent with, the adapter-emitted catalog digest `sha256:df96ff5a4c2d11e41ec1d7b9c5e460bdcb8ae8d9c2c99b140f59e08305f8d604`. Historical W1 implementation counts are not substituted for the frozen current production inventory of 57 facade and 62 total handlers.

The earlier idea of a production Server resource for `tm8://help/operation/*` was explicitly superseded before W2 implemented it. No such production surface is a W3 deliverable.

## 2. Authority and entry evidence

Read in full before public testing:

- `IMPLEMENTATION-ORCHESTRATION-W0-W5.md`
- `FINAL-DESIGN-SET.md`
- `API-CATALOG-GROUPED-GUIDE.md`
- `SESSION-COMMUNICATION-MODEL.md`
- `AGENT-HARNESS-AND-COMMAND-DISCOVERY.md`
- `BACKEND-BRIEFING-FOR-CHAT-TEMPLATES.md`
- `W0-AMENDMENT-DOSSIER.md`
- `W0-CONSISTENCY-MATRICES.md`
- `W1-PREFLIGHT-AND-INTEGRATION-EVIDENCE.md`
- `W2-PREFLIGHT-AND-INTEGRATION-EVIDENCE.md`
- `W0-W5-HANDOFF-STATE.md`

W1 closed with 101 catalog rows = 99 v1 + 2 reserved, 100 HTTP + 1 WS, and a registerable v1 HTTP ceiling of 98. The two reserved operations remain exactly `search.query` and `bridge.fetchBlob` and must return honest `501 not_implemented`. Unknown routes must return `404 not_found`.

## 3. Rolling W2 handoff

W2 coordinator `sess_1785063923929_t2hz3v5an` reported 69/69 focused coordinator checks across the initial frozen groups. These are registration-ready implementation handoffs, not yet production-public-ready. Current `501` responses are therefore not classified as defects until W2 supplies the explicit public-ready base URL/registered count handoff.

| Group | Operations | W2 focused evidence | Public status | Known hold |
|---|---|---:|---|---|
| G01 identity and Spaces | `identity.get`; all 18 `spaces.*` baseline operations | 19/19 | HOLD — shared registration/input binding pending | none beyond shared wiring |
| G03 edges and placements | `edges.list`, `edges.create`, `edges.patch`, `edges.delete`, `edgeTypes.list`, `placements.apply` | 13/13 | HOLD — shared registration/input binding pending | placement `embed` creates a truthful `messages.delete` undo token, but X01 redemption waits for G04 migration 019 |
| G05 collections, graph, undo | `collections.query`, `graph.query`, `commands.undo` | 10/10 | HOLD — shared registration/input binding pending | X01 only for redemption of the G03 message-tombstone inverse |
| G08 inbox and read marks | `inbox.list`, `inbox.markRead`, `readMarks.upsert` | 14/14 | HOLD — shared registration/input binding pending | none beyond shared wiring |
| G09 saved views and actions | `savedViews.list`, `savedViews.create`, `savedViews.update`, `savedViews.delete`, `actions.list` | 13/13 | HOLD — shared registration/input binding pending | none beyond shared wiring |
| G06 projects and associations | `projects.list`, `projects.create`, `projects.get`, `projects.update`, `projects.link`, `projects.unlink`, `projects.associations.correct` | 15/15 (6 handler + 9 PostgreSQL) | HOLD — shared registration/input binding pending | none beyond shared wiring |
| G02 entities, commands, tracking | 13 uniform `entities.*`; five `entities.commands.*`; `tracking.refresh` | 16/16 (4 handler + 12 PostgreSQL) | registration-ready for the next integration tranche; explicitly excluded from tranche-v1 100/62 | provider queue consumer is later owner |

G07 files is frozen and registration-ready at 15/15 focused tests, Server build, and root typecheck. Its public handoff still requires raw upload routing before JSON parsing plus `dataDir` and effective file-limit composition. The four semantic operations are `files.uploadInit`, `files.uploadComplete`, `files.uploadAbort`, and `files.download`; `bridge.fetchBlob` remains reserved/unregistered. The raw grant PUT is a non-catalog support transport and is part of the G07 public byte-lifecycle gate.

G06 projects and associations is frozen and registration-ready at 15/15 focused tests, Server build, and root typecheck. W2 also proved full-order compatibility for migrations 001–015 + 017 + 021 and all six named RPC identities. Its seven operations replace the existing five project wrappers rather than duplicate-registering them. Public acceptance therefore expects the production implemented count to become 62 once I01 composes all seven currently frozen groups.

Shared public wiring is owned by W2 and currently remains pending in:

- `packages/server/src/facade/index.ts`
- `packages/server/src/facade/input-schemas.ts`
- `packages/server/src/main.ts`

W3 owns no production file and will not modify those seams.

### 3.1 Tranche-v1 PUBLIC-READY handoff

At 2026-07-26, W2 explicitly froze the production composition for G01/G03/G05/G06/G07/G08/G09. `bootstrap()`/`main()` reports 100 mounted HTTP catalog operations and exactly 62 implemented handlers: 57 facade handlers plus the existing five event/execution handlers. Overlapping legacy handlers are replaced without duplicate registration. The exact FileUploadGrant PUT is the sole non-catalog support transport; there is no generic pre-body hook and no manifest/help/discovery Server route.

W2 reported its production tranche suites at 37/37, official current migration gates at 19/19 over repository migrations 001–018 and 020–024 (019 is absent and belongs to the held G04), Server build/root typecheck green, and broad Server 373 pass/64 skip. Nine broad live-sidecar `initdb` failures under the user-level PostgreSQL lifecycle directory were classified as environmental and outside I01. This is entry evidence only; it is not substituted for independent W3 execution.

The accepted public startup is loopback `http://127.0.0.1:4610` by default after `bun run build:server` and `bun run dev:server`, with `TM8_DATABASE_URL` set to an isolated migrated database and `TM8_DATA_DIR` set to an absolute private directory. W3 uses the same production `bootstrap()` composition on ephemeral loopback ports per isolated test. Phase-1 identity is the database-resolved loopback auto-owner; no bearer authentication is invented.

I01 snapshot addendum: its exact closed ephemeral listener was `http://127.0.0.1:53399` and returned `{ok:true,server:"tm8-server",contractVersion:"0.1.0",operations:100,implemented:62}`. The standalone production command is `bun run build:server`, then `TM8_DATABASE_URL=<postgres-url> TM8_DATA_DIR=<absolute-private-dir> TM8_BIND=127.0.0.1 TM8_PORT=4610 node --enable-source-maps packages/server/dist/index.js`.

Frozen I01 SHA-256 evidence:

- `facade/index.ts`: `58ff8b7f3c61c5e99f23a0c6096725c477f98e110aab9a250f7b513fec42df76`
- `facade/input-schemas.ts`: `8d4627fbb3b0765e90b0f0425520f22fe19020840dbb4f8757ad94fa9024140e`
- `main.ts`: `33a0deef882b180b215d0290a15c79d8565cc20356de99b18d6070fb1dfc449a`
- `http/config.ts`: `b949b5f8a0865e3df570b32020683bb14b1f4e0f2be47eb5ebb9cb9dd1939714`
- `http/server.ts`: `b7ffc54abeba9afc17e553aa42e5b772343baf734ed033e687f072ce1c8043e5`
- rolling-public integration test: `b6b966ddf4a93f825345b2dd71edd0bad60a9fc2b99b8154a1928117e5ae3a16`
- migration-order test: `0dd2e8435b30bde9c0b3b8f67072dc5a35cc5030348ff51d127b088fbebe5dd1`
- repaired W1 runner: `1556171af703d36857685c5633d5ec7e15ace1b94852930cebc3fadec8fa07d6`
- W1 foundations: `74cc90e20b86abb1aa5bd113775fda4451c2fa612e6fc3da46b91d1d6f4c6548`

## 4. Public gate acceptance matrix

Every accepted group must prove:

- the production Server reports the expected implemented count and mounts the catalog-derived route;
- success uses `{data, requestId}` and the response header carries the same request ID; raw file downloads are the documented exception;
- strict inputs reject unknown keys and malformed payloads with the closed error envelope;
- commands persist the expected rows/events through named RPCs and refuse direct application-role writes;
- same `clientMutationId` plus same intent replays the stored result without a duplicate effect;
- mutation-ID reuse with changed frozen intent fails according to the operation contract;
- optimistic revisions/versions conflict without partial writes where the DTO exposes one;
- list cursors are keyset-stable and reject a different filter/sort fingerprint;
- ordinary identity, membership, act-as, and RLS negatives do not reveal hidden rows;
- catalogued unavailable/reserved operations remain honest, and unknown routes remain distinct;
- process/restart or race cases explicitly assigned to the group retain durable, deterministic outcomes.

Group-specific minimums:

- **G01:** create/list/get/update/navigation/home/settings/members/invites/task axes/leaderboard/awards; Space-before-child authorization; invite replay/revoke/redeem; protected axes; unread-anchor non-leak; settings revisions unchanged by unrelated writes.
- **G03:** exact-microsecond edge cursor; endpoint/type/props validation; Server-owned origin; mutable ordinary versus immutable materialized/recorder/message-owned edges; `in_project` 16/17 cap and create/unlink race; placement direction and atomic rollback. X01 redemption is separately held.
- **G05:** collection cursor fingerprint; bounded graph traversal and live endpoints; undo original-actor/one-token/replay rules; atomic failure; only registered reversible inverses.
- **G06:** ProjectResource-first lock order; active linked-Space projection; stable restore ID and multi-Space fanout; launch-project immutability and union unlink guard; 16/17 association cap; correction role/version/replay; create-versus-unlink loser rollback.
- **G08:** Member versus Teammate recipient isolation; explicit owner inspection without read-state sharing; child authorization; null/tombstone/readability projection; monotonic read marks and concurrent recipient isolation.
- **G09:** private versus Space-shared visibility; owner-only saved-view writes and replay; selected entities remain unchanged; `actions.list` reflects live catalog/capability metadata and excludes internal `execution.prompt`, WS, and reserved rows.

## 5. Environment and evidence rules

Public acceptance uses an isolated, test-owned PostgreSQL database migrated by the official runner from either empty or current supported state, a test-owned absolute `TM8_DATA_DIR`, loopback binding, and the production Server. Phase-1 loopback identity is auto-owner resolved from the database; no bearer authentication is assumed. Domain fixtures must be created through public APIs where those prerequisites are public-ready. W1 scratch helpers may establish only infrastructure identity/bootstrap state that cannot yet be created publicly; direct `tm8_app` DML is never accepted as proof of a domain operation.

Each verdict records:

- exact public base URL/startup command and Server implemented count;
- exact requests and response status/envelopes;
- database queries showing authoritative effects or absence of effects;
- request/mutation IDs, cursors, versions, and event sequence where applicable;
- restart/race process boundaries where applicable;
- test files, commands, counts, and any environmental exclusion;
- collision audit and confirmation that neither production source nor git was touched by W3.

### 5.1 Production-harness baseline

W3 added only new test-owned files under `packages/server/test/w3/`:

- `public-harness.ts` creates an isolated scratch database, applies the current official migration set, starts `bootstrap()` with its default production registry on an ephemeral loopback port, sends public HTTP requests, and permits independent database observations. It never imports or registers a W2 group handler.
- `public-harness.test.ts` proves the database-backed production composition starts, reports all 100 mounted HTTP operations, keeps both reserved routes at `501 not_implemented`, and keeps an unknown route at `404 not_found`, with request-header/body IDs joined.
- `discovery-adapter.ts` is the evaluator-only generated-discovery adapter. It mechanically hashes the live `OPERATIONS` catalog and refuses a stale generated manifest, exposes root noun counts, pages at most 12 operation summaries for one exact noun, and returns transport/schema-reference metadata only for one exact operation lookup. It has no Server route and exposes no source or database internals.
- `discovery-adapter.test.ts` proves the digest/count guard, bounded root/noun behavior, lazy exact-operation transport lookup, and refusal of unknown nouns/operations or malformed cursors.
- `g01-public.test.ts`, `g03-public.test.ts`, `g05-public.test.ts`, `g06-public.test.ts`, `g07-public.test.ts`, `g08-public.test.ts`, and `g09-public.test.ts` are drafted public-boundary group cases. They remain deliberately unexecuted and carry no verdict until W2 supplies the explicit I01 PUBLIC-READY handoff.

Baseline command before shared W2 registration:

```text
cd packages/server && bunx vitest run test/w3/public-harness.test.ts
PASS — 1 file, 2/2 tests
```

Evaluator discovery command:

```text
cd packages/server && bunx vitest run test/w3/discovery-adapter.test.ts
PASS — 1 file, 3/3 tests
```

Collection-only syntax/import check (no hooks, servers, or operation calls executed):

```text
cd packages/server && bunx vitest list test/w3/g*-public.test.ts
PASS — 35 public cases collected across G01/G03/G05/G06/G07/G08/G09
```

After PUBLIC-READY, W3 reran the production build and tightened the harness to the exact tranche count:

```text
bun run build:server
PASS
cd packages/server && bunx vitest run test/w3/public-harness.test.ts
PASS — 1 file, 2/2 tests; health 100/62, reserved 501, unknown 404
```

## 6. Rolling verdict ledger

| Group | W2 public-ready handoff | W3 public verdict | Agentic task/session | Agentic verdict | Defects/retests |
|---|---|---|---|---|---|
| G01 | tranche-v1 accepted; 100/62 | **PASS — 7/7 independent public cases** | `task_1785070821930_fcihktlya` / `sess_1785070869682_uzcqo39wa` | **PASS — worker 1/1 + coordinator rerun 1/1** | none |
| G03 | tranche-v1 accepted; 100/62 | **PASS — 5/5 independent public cases; X01 redemption held** | invalidated original; clean retest `task_1785071300063_txk3rsz5c` / `sess_1785071317607_twans5nkj` | **PASS — worker 1/1 + coordinator rerun 1/1** | original protocol violation only; no product defect |
| G05 | tranche-v1 accepted; 100/62 | **PASS — 4/4 independent public cases; X01 redemption held** | `task_1785071048705_35qxjtziz` / `sess_1785071075671_x25zdtcuv` | **PASS — worker 1/1 + coordinator rerun 1/1** | none outside X01 |
| G08 | tranche-v1 accepted; 100/62 | **PASS — 5/5 independent public cases** | `task_1785071498031_wphjmbipr` / `sess_1785071516416_legr1qwa3` | **PASS — worker 1/1; purity revision + coordinator rerun 1/1** | no product defect; assisted recipient path excluded |
| G09 | tranche-v1 accepted; 100/62 | **PASS — 4/4 independent public cases** | `task_1785071689148_zcjv4001o` / `sess_1785071783351_2urns6wvk` | **PASS — worker 1/1 + coordinator rerun 1/1** | verifier collection/envelope corrections only; no product defect |
| G07 | tranche-v1 accepted; 100/62 + named raw PUT | **PASS — 4/4 independent public cases** | `task_1785071366560_p5gsgl8f1` / `sess_1785071387906_4icqnk2g8` | **PASS — worker 1/1 + coordinator rerun 1/1** | transient migration-019 bootstrap blocker repaired outside G07 |
| G06 | tranche-v1 accepted; 100/62 | **PASS — 6/6 independent public cases** | `task_1785071192240_enb6pa1xm` / `sess_1785071211416_oqujwynco` | **PASS — worker 1/1 + coordinator rerun 1/1** | none |
| G02 | next tranche pending; excluded from 100/62 | not started | not permitted | pending | — |
| G15 | frozen evidence-only; no production registration | **PASS — 4/4 independent public cases** (2026-07-27) | `task_1785092718851_cu6zitrnk` / `sess_1785092809839_l6ly7rh3d` | **PASS — worker 8/8 + coordinator rerun 8/8** | one W3-owned verifier correction; no product defect; discovery availability-signal finding referred to W4/W5 |

No G3 or W4 release is recorded here until all fifteen groups, the required cross-group cases, the independent agentic discovery/use gate, and the final fresh limited-scope Opus gate have complete passing evidence.

W2 later froze G15 as a test-only honesty handoff with no production registration. Its reported hashes are `2df6df67723ca4fb2f0bd08b6b515de04bb9b07e364dace1096abf8c8f48720d` for `packages/server/test/w2/reserved-honesty.test.ts` and `32012f3b3516d391dec4980fd88742b1ae8475afca5fba6eb5114820ea543a8f` for `tools/conformance/test/w2-reserved-honesty.test.ts`; W2 reproduced Server 6/6, focused conformance 1/1, root conformance 14/14, build, and typecheck. W3 has not adopted those author tests as independent proof. Its own public gate is queued to verify the mechanically derived 62 mounted/36 residual behavior, exact reserved 501s, WS-only event operation, unknown 404, and pre-validation 501 honesty after the official migration chain can bootstrap again.

### 6.1 G01 independent public PASS

```text
cd packages/server && bunx vitest run test/w3/g01-public.test.ts
PASS — 1 file, 7/7 tests
```

The production Server resolved the loopback owner and exercised all 19 G01 operations across identity, Space create/list/get/update, navigation/Home/settings/members, invite create/list/redeem/revoke, task-axis create/list/update/delete, leaderboard, and awards. The cases proved request-ID envelope joining, Space child/default rows, mutation replay with one ledger effect, settings-revision isolation, cursor pagination, and strict input refusal without writes. No production file was edited by W3.

The post-PASS agentic task is `task_1785070821930_fcihktlya`, session `sess_1785070869682_uzcqo39wa`. Spawn audit: team member `tm_1785033707778_ftdfirdey`, provider `openai`, agent tool `codex`, model `gpt-5.6-terra`, reasoning `xhigh`, access `fullAccess`. Its only writable artifact is `packages/server/test/w3/agentic/g01-agentic.test.ts`.

Agentic G01 verdict: **PASS**. Generated discovery followed root → `identity` noun → paged `space` noun (12 + 10) → seven lazy exact-operation lookups, all at digest `sha256:df96ff5a4c2d11e41ec1d7b9c5e460bdcb8ae8d9c2c99b140f59e08305f8d604`. The selected production workflow used identity, Space create/replay/update/get/settings, and task-axis create/list, with strict invalid-input refusal and a bounded DB oracle confirming one Space, one Member, one default channel, one manual axis, no invite, and exactly the expected three mutation labels. Worker run passed 1/1 at `http://127.0.0.1:54866`; coordinator rerun passed 1/1 at `http://127.0.0.1:55170`.

### 6.2 G03 independent public PASS

```text
cd packages/server && bunx vitest run test/w3/g03-public.test.ts
PASS — 1 file, 5/5 tests
```

All six G03 operations passed through production HTTP. Evidence covered the edge-type registry schema, Server-owned `origin` refusal before write, public edge create/replay, exact timestamp-and-ID keyset traversal with a filter-bound cursor, patch/delete replay and DB state, placement normalization to a hard `depends_on` edge with one token/ledger effect, and malformed/schema-invalid no-write paths. X01 remains only the separately declared redemption of the truthful `messages.delete` token produced by embed placement; it is not misclassified as a G03 failure.

The post-PASS agentic task is `task_1785070955515_bihbi2fcv`, session `sess_1785070980098_tgu4dcqcc`. Spawn audit: team member `tm_1785033708049_5hlkaowi2`, intentional provider `claude`, model `claude-sonnet-5`, access `fullAccess`. Its only writable artifact is `packages/server/test/w3/agentic/g03-agentic.test.ts`.

The original G03 agentic session reported functional 7/7 but explicitly disclosed running `git status --porcelain -uall`, violating the wave-wide no-git invariant. It also described `GET /v2/edges?entityId=...` as filtered even though `entityId` is not a G03 edge-list query field. W3 therefore rejects that session as gate evidence without classifying a production defect. A fresh clean-room agentic task must not read or reuse its artifact.

Clean retest task `task_1785071300063_txk3rsz5c`, session `sess_1785071317607_twans5nkj`, owns only `packages/server/test/w3/agentic/g03-agentic-retest.test.ts`. Spawn audit: team member `tm_1785033707778_ftdfirdey`, provider `openai`, agent tool `codex`, model `gpt-5.6-terra`, reasoning `xhigh`, access `fullAccess`.

Agentic G03 clean-room verdict: **PASS**. Generated discovery used bounded paged `space` and `entity` nouns plus `edge`, `edge-type`, and `placement`, followed by lazy exact lookups at the unchanged digest. The production workflow created a Space and two tasks, inspected `depends_on`, rejected forged Server ownership, created/re-observed/deleted an edge through the unfiltered public list, and normalized a placement into one hard dependency. The bounded oracle found exactly that remaining edge and the four requested successful mutation labels. The clean worker ran no git or prohibited inspection and passed 1/1; the coordinator inspected the exact artifact and reran it 1/1. X01 message-tombstone redemption remains the separately declared hold.

### 6.3 G05 independent public PASS

```text
cd packages/server && bunx vitest run test/w3/g05-public.test.ts
PASS — 1 file, 4/4 tests
```

All three G05 operations passed through production HTTP. Evidence covered stable collection keysets and sort/filter fingerprint refusal, bounded two-hop live graph traversal over public edge state, single-token actor-bound undo with same-mutation replay and different-mutation refusal, authoritative edge/token/ledger outcomes, and malformed graph/undo inputs with no write. X01 remains only the declared G03 message-tombstone inverse dependency.

The post-PASS agentic task is `task_1785071048705_35qxjtziz`, session `sess_1785071075671_x25zdtcuv`. Spawn audit: team member `tm_1785033707778_ftdfirdey`, provider `openai`, agent tool `codex`, model `gpt-5.6-terra`, reasoning `xhigh`, access `fullAccess`. Its only writable artifact is `packages/server/test/w3/agentic/g05-agentic.test.ts`.

Agentic G05 verdict: **PASS**. Generated discovery used bounded `space`, `entity`, `edge`, `collection`, `graph`, and `undo` nouns followed by six lazy exact lookups at the current catalog digest. The production workflow created a Space and three tasks, traversed collection pages, rejected a malformed cursor, built a two-edge graph, queried it, redeemed one edge token, and correctly refused a second redemption under a different mutation ID. The bounded oracle confirmed three tasks, only the non-undone edge live, one redeemed token, and exactly six successful mutation labels. Worker and coordinator runs each passed 1/1; the coordinator fresh URL was `http://127.0.0.1:56931`.

### 6.4 G06 independent public PASS

```text
cd packages/server && bunx vitest run test/w3/g06-public.test.ts
PASS — 1 file, 6/6 tests
```

All seven G06 operations passed through production HTTP. Evidence covered ProjectResource creation/replay and complete read shapes, two-Space active mappings and restricted projections, resource update fanout with explicit `repoUrl:null` and one version increment, unlink/relink restoration of the stable projection ID, the 16/17 active-Space-link cap with zero failed ledger effect, and a materialized artifact correction with stale-version refusal, replay, strict-body refusal, and authoritative edge/ledger outcome.

The post-PASS agentic task is `task_1785071192240_enb6pa1xm`, session `sess_1785071211416_oqujwynco`. Spawn audit: team member `tm_1785033708049_5hlkaowi2`, intentional provider `claude`, model `claude-sonnet-5`, access `fullAccess`. Its only writable artifact is `packages/server/test/w3/agentic/g06-agentic.test.ts`.

Agentic G06 verdict: **PASS**. Generated discovery and real production HTTP created two Spaces and one ProjectResource, proved same-mutation create replay without duplication, linked into both Spaces, read/listed, updated name and nullable `repoUrl`, strictly refused a bodyless unlink, unlinked and relinked one Space, and used the bounded oracle to prove the stable projection ID and exact selected ledger labels. Static coordinator inspection found only permitted harness/oracle imports and public requests; the serial coordinator rerun passed 1/1.

### 6.5 G07 independent public PASS

```text
cd packages/server && bunx vitest run test/w3/g07-public.test.ts
PASS — 1 file, 4/4 tests
```

All four G07 semantic operations plus the exact FileUploadGrant PUT passed through production transport. Evidence covered deterministic grant replay and server-generated contained storage, absent/wrong token refusal, exact byte staging and retry, completion/attachment replay and ledger state, byte-identical download with checksum/length/nosniff/ETag/disposition headers, pending abort replay and no graph/blob outcome, failed checksum staging cleanup, and oversized/unknown semantic input refusal without slots or ledger effects. `bridge.fetchBlob` remained reserved and was not substituted for the file lifecycle.

The post-PASS agentic task is `task_1785071366560_p5gsgl8f1`, session `sess_1785071387906_4icqnk2g8`. Spawn audit: team member `tm_1785033708049_5hlkaowi2`, intentional provider `claude`, model `claude-sonnet-5`, access `fullAccess`. Its only writable artifact is `packages/server/test/w3/agentic/g07-agentic.test.ts`.

Agentic G07 verdict: **PASS**. Generated discovery, production HTTP, and the exact returned raw PUT URL created a Space and task, computed fresh bytes/checksum, obtained a grant, proved missing/wrong token refusal, uploaded exact bytes, completed and replayed, attached the file through a discovered live edge type, downloaded byte-identical content with integrity headers, and used the bounded oracle to prove completed slot/file/attachment/ledger state. Static coordinator inspection found only permitted harness/oracle imports, public HTTP, and raw grant/download fetches. The first coordinator rerun was blocked before Server startup by a newly appeared migration 019 reference to nonexistent `internal.request_id()`; the G04 owner repaired that official-chain bootstrap issue using `internal.claim_text('tm8.request_id')` plus the ACL-tail role reset. The resumed serial G07 rerun then passed 1/1, so no G07 product defect is recorded.

### 6.6 G08 independent public PASS

```text
cd packages/server && bunx vitest run test/w3/g08-public.test.ts
PASS — 1 file, 5/5 tests
```

All three G08 operations passed through production HTTP. Evidence covered fingerprinted personal versus Teammate pages, explicit owner inspection without read-state sharing, personal mark-read replay with Teammate isolation, refusal to mutate Teammate state while merely inspecting it, Member read-mark replay with one timestamp/row/ledger effect, unread filtering, and strict query/body refusal without writes. Notification rows were test-infrastructure fixtures because their public producers belong to later groups; no direct application-role DML was used as G08 proof.

The post-PASS agentic task is `task_1785071498031_wphjmbipr`, session `sess_1785071516416_legr1qwa3`. Spawn audit: team member `tm_1785033707778_ftdfirdey`, provider `openai`, agent tool `codex`, model `gpt-5.6-terra`, reasoning `xhigh`, access `fullAccess`. Its only writable artifact is `packages/server/test/w3/agentic/g08-agentic.test.ts`.

Agentic G08 verdict: **PASS after purity revision**. Generated discovery selected Space/entity setup plus `inbox.list`, `inbox.markRead`, and `readMarks.upsert` at the unchanged digest. The adapter intentionally exposed only `InboxListQuerySchema`, so an initial worker path requested and received one coordinator-supplied Teammate discriminator. W3 excluded that assisted path from gate evidence and required a narrow artifact revision before acceptance. The accepted test uses only the independently discovered default personal inbox, malformed-recipient refusal, personal mark-read replay, unread filtering, and Member read-mark replay. Its bounded oracle proves the personal notification is read, the seeded Teammate notification remains unread, one read mark exists, and exactly the two expected mutation labels exist. The worker did not rerun after revision; the coordinator inspected the revised file and ran it serially 1/1. No accepted request or assertion uses the coordinator-supplied discriminator.

### 6.7 G09 independent public PASS

```text
cd packages/server && bunx vitest run test/w3/g09-public.test.ts
PASS — 1 file, 4/4 tests
```

All five G09 operations passed through production HTTP. Evidence covered private and Space-shared view creation, mutation replay without duplication, authorized listing/update/delete with the selected entity left unchanged, global and entity-context action discovery restricted to live registered and target-applicable operations, omission of reserved/WS/execution rows, exact help references and target versions, and strict unknown-input refusal without a saved-view or ledger effect.

The post-PASS agentic task is `task_1785071689148_zcjv4001o`, session `sess_1785071783351_2urns6wvk`. Spawn audit: team member `tm_1785033707778_ftdfirdey`, provider `openai`, agent tool `codex`, model `gpt-5.6-terra`, reasoning `xhigh`, access `fullAccess`. Its only writable artifact is `packages/server/test/w3/agentic/g09-agentic.test.ts`. Because the host initially reported approximately 92 MiB free, its DB-backed run was held until the G08 harness closed. After cleanup showed approximately 1.6 GiB free, G09 was released into the sole DB-backed slot.

Agentic G09 verdict: **PASS**. Generated discovery selected all four saved-view operations, the global `actions.list` route, and public Space/entity prerequisites. Live validation established mutation IDs, `query.spaceId`, root-field refusal, and graph-layout object shape. The production workflow created/read a task, created and identically replayed one saved view, listed/updated it, created/deleted a second, refused invalid input, and obtained the generated global action set with `savedViews.create` present and the exact forbidden rows `execution.prompt`, `events.subscribe`, `search.query`, and `bridge.fetchBlob` absent. The bounded oracle proved the task version unchanged, the primary view updated, the secondary absent, and exactly the three requested G09 mutation labels. Initial repo-root Vitest collection and later verifier envelope/action-expectation errors were corrected without a product change; the final worker run passed 1/1 and the coordinator inspected and reran the exact package-level file 1/1.

### 6.8 G15 independent public PASS

```text
cd packages/server && bunx vitest run test/w3/g15-public.test.ts
PASS — 1 file, 4/4 tests
```

The reserved/residual honesty gate now executes because the official migration chain
bootstraps again (migration 019 is present and repaired). Evidence is mechanically derived
from the live catalog joined to real production HTTP responses, not from a hardcoded list:
production health reports `operations:100, implemented:62`; both reserved operations
`search.query` and `bridge.fetchBlob` return standard `501 not_implemented` envelopes with
joined request IDs and the operation name in the message; exactly **36** residual v1 HTTP
bindings return standard pre-validation `501`s; exactly **62** v1 HTTP operations respond
non-501; `events.subscribe` remains WS-only at `/v2/ws` and is never reachable over HTTP;
an unknown path remains `404 not_found`. The accounting closes exactly:
62 implemented + 36 residual = the 98 registerable v1 HTTP ceiling, +2 reserved = 100 HTTP,
+1 WS = 101 catalog rows.

One W3-owned verifier correction was required and is disclosed in full. The drafted case
passed the `/health` response through `successData()`, the `{data, requestId}` envelope
extractor. `/health` is the infrastructure liveness route rather than a catalog operation
and is deliberately outside the envelope; the production Server returned exactly the frozen
I01 body `{ok:true,server:"tm8-server",contractVersion:"0.1.0",operations:100,implemented:62}`
recorded in §3.1. The corrected case reads the bare body, matching the already-accepted
`public-harness.test.ts` baseline. This was a defect in the W3 test file only. **No
production file was edited and no product defect is recorded.** Post-correction root
typecheck is green and the file hash is
`1539ba48267585b9826cf95627cfad1b5f43310438222c360c73c9302e3b01bc`.

### 6.9 M-1 resumption preflight and tranche-v1 regression sweep (2026-07-27)

Resumed coordinator `sess_1785092163476_4on0tyohq`, team member `tm_1785091986796_aiatw3m39`,
`provider=claude`, `agentTool=claude-code`, `model=claude-opus-5`, `reasoningEffort=xhigh`,
`accessMode=fullAccess`. No git command was run. No production file was edited.

Baseline re-established against the current working tree:

```text
bun run build:server                                          PASS (tsc -b, exit 0)
cd packages/server && bunx vitest run test/w3/public-harness.test.ts     PASS — 2/2
cd packages/server && bunx vitest run test/w3/discovery-adapter.test.ts  PASS — 3/3
```

Health reports `operations:100, implemented:62`; both reserved routes `501`; unknown route
`404`. The live catalog digest recomputed directly from built `OPERATIONS` is unchanged at
`sha256:df96ff5a4c2d11e41ec1d7b9c5e460bdcb8ae8d9c2c99b140f59e08305f8d604` over 101 rows, so
all prior agentic discovery evidence remains bound to the same catalog.

**Regression sweep — no stop-the-line event.** The seven previously-passed public suites were
rerun serially against the current tree, which now contains the ungated G12/G14 work
(migrations `027_w2_entity_kinds_profiles.sql` and `029_w2_menu_default_channel.sql`, plus
their handler/service files) that landed after those verdicts were recorded:

```text
g01 7/7   g03 5/5   g05 4/4   g06 6/6   g07 4/4   g08 5/5   g09 4/4     total 35/35 PASS
```

The harness applies every migration present in `db/migrations`, so this sweep genuinely
exercised the ungated 027 and 029 migrations — 26 migration files, 001–024 plus 027 and 029,
with 025/026/028 absent. All five frozen I01 shared seams reproduce their recorded SHA-256
values with zero drift:

```text
58ff8b7f3c61c5e99f23a0c6096725c477f98e110aab9a250f7b513fec42df76  facade/index.ts
8d4627fbb3b0765e90b0f0425520f22fe19020840dbb4f8757ad94fa9024140e  facade/input-schemas.ts
33a0deef882b180b215d0290a15c79d8565cc20356de99b18d6070fb1dfc449a  main.ts
b949b5f8a0865e3df570b32020683bb14b1f4e0f2be47eb5ebb9cb9dd1939714  http/config.ts
b7ffc54abeba9afc17e553aa42e5b772343baf734ed033e687f072ce1c8043e5  http/server.ts
```

This is the mechanism behind the clean sweep and is the load-bearing conclusion of the
preflight: **G12 and G14 exist on disk but are not registered into the production
composition.** `implemented` remains exactly 62 and the G15 residual count remains exactly
36, so the ungated work is inert at the public boundary rather than silently live. G12/G14
therefore still require their own W2 freeze plus an explicit PUBLIC-READY handoff before any
W3 public verdict, and their presence does not alter the tranche-v1 gate.

Environment note: the host volume is critically low at approximately **274 MiB free (100%
capacity)**, worse than the ~92 MiB condition that previously held a G09 run before cleanup.
One orphaned zero-connection scratch database
(`tm8_w1_w3_agentic_g03_probe_49854_ef7249ee1079`) left by the terminated G03 agentic session
was dropped exactly; no user or development database was touched. All DB-backed runs are held
serial and every harness tore down cleanly, leaving zero `tm8_w1_%` scratch databases.

### 6.10 G15 agentic PASS and the discovery availability-signal finding

Agentic task `task_1785092718851_cu6zitrnk`, session `sess_1785092809839_l6ly7rh3d`. Spawn
audit: team member `tm_1785091987382_089qna7hk`, `provider=claude`, `agentTool=claude-code`,
`model=claude-opus-5`, `reasoningEffort=high`, `accessMode=fullAccess` — M-1 compliant. Its
only writable artifacts were `test/w3/agentic/g15-agentic.test.ts` plus one appended bounded
oracle in `test/w3/agentic-observer.ts`.

Agentic G15 verdict: **PASS**. Worker 8/8; coordinator independent rerun 8/8.

Coordinator static inspection confirmed compliance independently of the worker's claim:
imports are exactly `node:crypto`, `vitest`, the bounded oracle, the discovery adapter, and
the public harness — no production source, no `child_process`, no filesystem or migration
reads. A modification-time audit showed exactly two changed files, both W3-owned. The
appended oracle returns only canonical facts (ledger entries for the supplied client mutation
IDs plus ledger/entity/edge row totals); no table layout or row contents cross the boundary.

Discovery navigation was root → all 26 nouns walked to cursor exhaustion (`entity` paged
12+8) → 101 lazy exact-operation lookups, with the digest
`sha256:df96ff5a4c2d11e41ec1d7b9c5e460bdcb8ae8d9c2c99b140f59e08305f8d604` asserted on every
call. The reserved pair was derived by filtering the walked catalog, not hardcoded.

Because discovery does not distinguish implemented from unimplemented, the tester classified
the entire 100-operation HTTP surface by **live behavior**: 12×200, 38×400 `invalid_input`,
8×403 `forbidden`, 4×404, and **38×501** = 2 reserved + 36 residual across 11 nouns. Each of
the 38 carried `not_implemented`, a body request ID equal to the `x-tm8-request-id` header,
the operation name in the message, `retryable:false`, and no `data` key. This independently
reproduces the §6.8 accounting from a different direction, and `100 − 62 = 38` from `/health`
corroborates it a third time.

Pre-validation honesty is proven rather than asserted: 24 of the 38 received a deliberately
invalid body and still returned `501`, never a validation error, while implemented operations
given the same body returned `400 invalid_input` — so the invalid body was genuinely capable
of triggering validation and the Server does not leak that it would have validated.

The central case is that a `501` leaves no trace. The tester added an unrequested **C0
calibration** case first, proving a real implemented mutation (`spaces.create` → 201) *is*
visible to the oracle, so the subsequent absence assertion cannot pass vacuously on a
misdirected oracle. Then 8 refused attempts (2 reserved + 6 residual commands) each carried a
fresh real `clientMutationId`: before and after both showed zero matching ledger entries, with
ledger, entity, and edge totals unchanged. A `501` reserves no mutation ID, writes no ledger
row, and partially applies nothing. `events.subscribe` answered `404` over plain HTTP for both
GET and POST. Unknown paths returned `404 not_found`, cleanly distinct from `501`. All eight
anti-fooling attempts — alternate method, trailing slash, alternate casing, query parameters,
collection path — produced only `404` or `501`, never a 2xx and never a `data` key; no hidden
mutation seam and no workaround performing reserved work was found.

The tester also disclosed that one of *its own* assertions failed during development (it
expected `200` for a create; the Server correctly returns `201`) and that it fixed its test
rather than the Server. That is the required standard and is recorded as such.

#### Finding: discovery carries no per-operation availability signal

The tester reported this as a discovery-surface honesty gap. W3 verified the mechanism
independently before classifying it, and the verification materially changes the
characterization:

- `catalogStatus` is **absent from the generated manifest for all 101 operations**. The
  adapter synthesizes it at `discovery-adapter.ts:178` from the manifest's *route* entries.
- The manifest route field is `status` with `source:"server-router"` and values
  `registered:98, reserved:2, skeleton:1`. It accurately reports **whether a route is mounted
  in the server router**, which is true — the production Server mounts all 100 HTTP routes and
  reports `operations:100`.
- The contract catalog's own `status` field has only `v1:99` and `reserved:2`.

So nothing in the pipeline states a falsehood. `registered` means *mounted*, not
*implemented*, and it has meant that since W1, when only 28 handlers existed. The correct
statement is therefore **not** that discovery lies, but that **discovery exposes no
per-operation implemented/available signal at all**, so an agent planning from discovery alone
cannot tell which of the 98 mounted operations will actually do work. The only machine-readable
split is the `/health` aggregate `implemented:62`, which names no operations. The tester's
impact analysis stands even though its "dishonest" framing does not.

Two qualifications W3 records:

1. **Partly transitional.** The 36 residual operations shrink to zero as W2 composes G02, G04,
   G10, G12, G13, and G14. At a complete G3 the mounted and implemented sets coincide and the
   discrepancy disappears on its own.
2. **The semantic gap may nonetheless survive.** The production refusal message is
   *"operation `<name>` is not implemented on this node"*, which implies per-node
   implementation variation is a designed concept rather than purely a build-in-progress
   artifact. If a deployed node may legitimately implement a subset, then an agent-facing
   discovery surface needs a per-operation availability signal permanently, not just until G3.

**Disposition.** This is **not** a G15 failure, **not** a production Server defect, and **not**
a manifest falsehood. The production Server has no discovery route at all — that surface was
explicitly superseded under §1.1 and the real CLI/help bootstrap is W4/W5 scope. W3 therefore
records this as a **forward-looking design input for W4/W5**: when the agent-facing discovery
and help surface is built, it should carry a per-operation implemented/available flag, and the
mechanism already exists unused — the manifest's `reason` field is populated for the two
reserved operations and null for the 36 residual ones. No W2 defect is filed and no W2 work is
blocked by this.


## 7. Pre-staged acceptance matrices for groups not yet handed off

**These carry no verdict.** They exist so that the independent gate is designed before the
implementation handoff arrives, not retrofitted to whatever the handoff happens to do. No
group below may be gated until W2 declares an explicit PUBLIC-READY handoff with base URL,
startup command, measured `operations`/`implemented` counts, shared-seam SHA-256s, included
groups, and known holds. Until that handoff lands, a `501` for any operation below is **not**
a defect.

### 7.1 Sequencing declared by W2 (2026-07-27)

W2 is proceeding under a serialized single-DB-slot pipeline:
G14-FIX → X01 → G13 → G10/G11 (G11 carries B1 and B2) → **tranche-v2 PUBLIC-READY composing
G02 + G04 + G12 + G14**.

W2 additionally disclosed that G12 and G14 have **no worker report at all** — their sessions
died before reporting, so no red-first evidence exists for either — and that each will get a
fresh scoped audit-and-complete pass before reaching W3. W3 endorses that stricter rule and
records explicitly that the 2026-07-27 regression sweep grants G12/G14 **no credit**: it
proves only that migrations 027 and 029 apply without breaking tranche-v1, and nothing about
whether either group is correct or complete.

### 7.2 G02 universal entities, commands, tracking — pre-staged, ungated

W2's *predicted* delta, to be replaced by measured values at handoff: one seam
`registerW2EntitiesCommandsTrackingHandlers` registering 19 operations, of which **8 replace**
currently-registered legacy handlers (`entities.get`, `entities.create`, `entities.patch`,
`entities.children`, `entities.activity`, `entities.points.add`, `entities.commands.work`,
`entities.commands.complete`) and **11 are net new** (`entities.move`, `entities.delete`,
`entities.restore`, `entities.hierarchy`, `entities.connections`, `entities.versions`,
`entities.react`, `entities.commands.pull`, `entities.commands.linkPr`,
`entities.commands.linkCommit`, `tracking.refresh`). Predicted health `operations:100,
implemented:73`; predicted residual `36 → 25`.

W3 will verify independently at the public boundary rather than on trust:

- **replacement, not duplicate registration** — `implemented` must rise by exactly **11**, not
  19, which is the same check G06 passed;
- **residual must fall to exactly 25** — the G15 honesty gate derives this mechanically from
  the live catalog joined to real production responses and does not hardcode 36, so it should
  track automatically; any mismatch is recorded as a finding rather than retuned;
- **non-200 successes are not anomalies** — `entities.create` returns **201** and
  `tracking.refresh` returns **202**; both are encoded as expected successes so the gate does
  not emit a false red;
- **optimistic concurrency** — `entities.patch` guarded by `expectedVersion`, conflicting on a
  stale version with no partial write;
- **command-safety negative** — `entities.commands.work` must refuse `done` with
  `invariant_violation` and `details.reason='use_complete_command'`; only
  `entities.commands.complete` may cross the criteria/completer/award gate;
- **restricted materialized kinds** — `work_session`, `message`, and the `project` projection
  refuse generic creation/mutation, so their owning command/materializer stays the only writer;
- **keyset paging** on `entities.children`, rejecting a changed filter/sort fingerprint;
- **`entities.react`** mutual exclusion across like/dislike/star with correct counters;
- **`entities.points.add`** appends to the immutable ledger and never edits a total directly;
- **idempotency** — same `clientMutationId` with same intent replays one effect; reuse with
  changed frozen intent fails per contract.

**Declared hold, not a defect:** X01 message-tombstone undo redemption stays open. Migration
020's inverse allowlist remains exactly `('edges.delete','entities.move','entities.restore')`,
so `entities.move` becoming *registered* does not make its undo *redeemable*. W3 will not
record a defect for that.

### 7.3 G14 menu and default channel — pre-staged, ungated

W2 self-reported two failing tests on `spaces.defaultChannel.set`, classified as a
**stale-test** defect rather than a production one: dossier A03 freezes the response as the
strict 8-key `SpaceSettingsView`, migration 029 and the service produce it, but both G14 test
expectations still assert a superseded narrow 2-key acknowledgement. A fresh session, not the
original author, is repairing the expectations and is barred from loosening an assertion to
reach green.

W3 will **re-derive rather than inherit** this classification: at handoff it verifies the
response against the strict 8-key `SpaceSettingsView` at the real public boundary and checks
strict-input refusal, independently of what any W2 test asserts. An independent public check
is exactly what would surface a loosened assertion if one slipped through.

### 7.4 Verdict binding to composition hash (adopted 2026-07-27)

At 00:46 on 2026-07-27, while W3 was idle-blocked, `packages/server/src/facade/index.ts`
changed from the frozen I01 value `58ff8b7f...df76` to `e46a4cc5...4998`, and
`facade/input-schemas.ts` changed with it. Inspection confirmed the cause is legitimate and
expected: the facade now imports and calls `registerW2EntitiesCommandsTrackingHandlers`, so
W2 is actively composing the G02-only I02 tranche. `main.ts` is unchanged. This is **not** a
stop-the-line event and no gate was run against the moving tree.

It does establish a rule W3 now adopts explicitly:

> **A W3 public verdict is bound to the composition it was measured against, identified by the
> shared-seam SHA-256 set. When any shared seam changes, every prior verdict becomes evidence
> about a superseded composition rather than about the current one.**

The seven tranche-v1 group verdicts and the G15 verdicts in §6 were all measured against
`facade/index.ts = 58ff8b7f...df76`. That composition no longer exists on disk. Those verdicts
remain accurate records of what was true when taken, and nothing about them is retracted, but
they do not automatically carry forward.

Therefore, when W2 declares the I02 PUBLIC-READY handoff, W3 will **re-run the full
eight-group regression sweep** (G01, G03, G05, G06, G07, G08, G09, G15) against the new
composition *before* issuing any G02 verdict, and will re-record the measured seam hashes. A
composition that newly registers 19 operations — 8 of them replacing existing registrations —
is exactly the change most capable of silently disturbing an already-passed group, and
replacement-not-duplication is precisely the property that cannot be verified from the
handoff's own numbers alone.

W3 tree integrity is separately baselined: all 22 files under `packages/server/test/w3/**`
verified unchanged after W4 went live in parallel under M-2. W4 is hard-prohibited from that
tree, and W3 re-verifies the baseline rather than assuming compliance.

### 7.5 Program ruling: per-node capability variation is literal (2026-07-27)

W3 escalated the §6.10 finding asking whether the production refusal text *"not implemented on
this node"* is literal or vestigial. The full-program coordinator ruled **LITERAL**, verified in
source rather than from memory:

- `PHASE-2-REMOTE-SERVER-INTEGRATION.md` §4.1 — the Server advertises its identity, contract
  version, **capabilities**, and visible Spaces;
- §5 — `execution.spawn` is available *"when capability permits"*, and "Capability availability"
  is named as an axis that changes under remote access, while operation names, entity DTOs,
  Space membership semantics and the error taxonomy explicitly do **not**;
- §11 freeze-requirement 6 — "Capability discovery and contract-version negotiation";
- `packages/ui/src/real/workspace/Unavailable.tsx` already implements `isUnavailable(method)`
  with per-operation `disabledBecause(<operation>, ...)`, so the UI layer is already built on the
  premise that operations vary per node.

Consequences recorded so the reasoning survives into W5/W6:

1. The availability signal is a **permanent** first-class field, not a scaffold to delete at G3.
   Had W3 closed the finding as transitional, the discrepancy would have self-resolved at G3 by
   coincidence while the underlying design need survived unaddressed.
2. The recommendation is routed to **W4**, not W2. Nothing is filed against W2 and no tranche is
   blocked. The data-source question is open; W4 may **not** add a Server surface, and a
   production Server discovery/help/manifest route remains superseded. Any Server-side
   requirement goes to the program coordinator for arbitration and may need a dossier amendment.
3. **G3 is not gated on this.** It is a W4/W5 deliverable gated at G4/G5. The §1.1 bounded-adapter
   ruling stands unchanged for W3 purposes.

### 7.6 Standing cross-group requirement: cursor filter-order equivalence

W2's G04 audit found a real defect in code that was passing 13/13: `enumFilter()` preserved URL
insertion order into the cursor fingerprint while the SQL matched with `= any(...)`, which is
order-insensitive. Two semantically identical filters therefore produced different fingerprints
and a valid cursor was rejected with `invalid_cursor`. W3 was asked to judge whether the same
divergence exists in already-passed groups.

W3 traced the class through every closed group before answering. `enumFilter` is **local** to
`services/w2/messages-handoffs.ts` (defined `:212`, used only at `:503`/`:504`) and is not shared.
Per-group status, each read against the SQL it must agree with:

| Group | Fingerprint builder | Status |
|---|---|---|
| G02 | `entities-commands-tracking.ts:100` raw `JSON.stringify` | safe — `listParam` `:407-411` dedupes via `Set` and terminates in `.sort()` |
| G03 | `edges-placements.ts:98` | immune — all fields `string \| null`; no array exists |
| G05 | `collections.ts:83` | immune — `stable()` recursively sorts arrays **and** object keys |
| G08 | `inbox-read-marks.ts:145` | immune — scalars plus a hardcoded sort constant |
| G09 | — | no cursor fingerprint |
| G04 | `messages-handoffs.ts:212` | was defective; fixed at `:225` with `values.sort()` |

**No verdict is reopened and no retro-sweep is run.** On G03 and G08 the test would be vacuous
because no user-supplied array exists to reorder, and adding a vacuous case to claim coverage is
theatre. A hypothesis that G02's raw `JSON.stringify` at `:100` was defective — it feeds four
order-insensitive array filters (`types`, `peerIds`, `peerKinds`, `createdByIds`, matched with
`= any(...)` at `:486`–`:493`) — was **formed and then disproved** by reading through to
`listParam`'s terminating `.sort()`. It is recorded because filing it would have cost a fix cycle
on correct code.

The durable finding is architectural rather than a live defect: five groups are safe for five
**different ad-hoc reasons**, with no shared canonicalization helper expressing the invariant
"canonicalize the filter before fingerprinting it". Four happen to be right; one was wrong until
an audit caught it. Correctness here is therefore per-group and accidental, so it must be proven
**behaviourally per group** rather than inherited from a shared seam.

**Adopted standing requirement.** For every group exposing a multi-valued list filter, the public
gate proves both directions:

- **positive (new):** two filters differing only in value *order* — and, where both spellings are
  accepted, comma-separated versus repeated-key — must accept each other's cursor and return an
  identical page;
- **negative (already covered):** a genuinely different filter or sort must still reject the
  cursor with `invalid_cursor`.

Both matter. A fingerprint that is too *loose* silently resumes from the wrong position, which is
worse than a rejection, and the pre-existing W3 evidence proved only the rejection half. Applies
forward to G02 `entities.connections`, G04 `handoffs.list` (order-equivalence, not only
difference-rejection), and G10/G13 on arrival.

### 7.7 The G15 detector is pinned and will go red at I02, by design

The tranche-v1 boundary is pinned as exact literals in **four** places across **two** files:

```text
test/w3/public-harness.test.ts:35   expect(body.implemented).toBe(62)
test/w3/g15-public.test.ts:68       implemented: 62
test/w3/g15-public.test.ts:85       expect(residual).toHaveLength(36)
test/w3/g15-public.test.ts:94       expect(implemented).toHaveLength(62)
```

Against the I02 composition all four **must fail**. W3's own §7.7 draft originally catalogued only
the three `g15-public.test.ts` pins; the fourth, in `public-harness.test.ts`, was identified by the
W4 coordinator (`sess_1785093404712_3h87437sp`) in an unsolicited read-only heads-up and is
recorded here with attribution. It matters because `public-harness.test.ts` is the **baseline**
suite — had it been missed, the resumption baseline itself would have gone red at the next
preflight and been misread as an environment or composition fault rather than a stale pin. That is the drift detector working, not a G02 defect
and not a regression — the same role C01's frozen conformance literals played when composing
tranche-v2 correctly took them to 13/14.

W3 will **not** pre-emptively re-pin it. Editing a detector before it detects destroys the only
evidence that the boundary moved and would mean the move was never independently confirmed. The
sequence is: run it, let it fail, read the failure as the measurement, confirm the new boundary
independently through `/health`, `registry.size`, and W3's own mechanical catalog-join
classification, and only then re-pin to **exact literals** 25 and 73. It will not be loosened to a
range, a live-computed value, or a lower bound, so that it keeps catching the next drift.

**Independently corroborated composition numbers.** W2's own
`test/w2/rolling-public.integration.test.ts` already encodes the post-I02 truth — `registry.size`
68 facade at `:237`, `{operations:100, implemented:73}` at `:405`, total registry 73 at `:406`, and
`residual` 25 at `:414`. W3 reproduced these lines read-only. The arithmetic independently confirms
replacement rather than duplication: 57 facade + 19 registered − 8 replaced = 68 facade, and
68 + 5 event/execution = 73. This is entry evidence only and is **not** a W3 verdict; G02 remains
composed-but-ungated until W2 declares the I02 PUBLIC-READY handoff.

**Cross-team non-interference verified, not assumed.** W4 went live in parallel under M-2 and is
prohibited from editing `packages/server/test/w3/**`. W4 stated it had only read. W3 verified that
claim independently against its own 22-file SHA-256 baseline: **zero mismatches**. W4 also declined
to claim G02 as verified W4 coverage while no W3 verdict exists, on the stated ground that it would
rather under-claim than borrow credit from a verdict not issued. W3 records that as the correct
posture: a W4 CLI test passing against an operation never substitutes for a W3 public verdict on it.

## 8. Live-surface security finding: unauthorized ledger replay (2026-07-27)

**Status: CONFIRMED PUBLICLY REACHABLE by W3.** Recorded against the composed surface, not
against W2's tranche-v2 declaration — the defect lives in W1-era migrations and predates I02.

### 8.1 Origin and division of proof

W2's INV-1, scoped for an unrelated low-severity `unreadTotal` question, found that four RPCs
return a stored command result **before any authorization runs**. W2 proved this **at the SQL
layer only** and explicitly asked W3 to measure public reachability *either way*, warning both
against upgrading it to "publicly exploitable" on assumption and against dismissing it as
theoretical. That measurement is W3's.

W3 verified the source independently before testing. The **live** `internal.ledger_replay` is
`db/migrations/016_w2_identity_spaces.sql:17` — a `create or replace` that **supersedes** the
`004:103` and `012:66` definitions (W3 initially cited the superseded ones; W2's citation is the
correct one). It selects `where client_mutation_id = p_cmid` with **no identity, Space, or actor
predicate**, checking only that the stored operation name matches. In `public.w2_update_space`
the replay returns at `016:83-84` with a bare `return`, while `internal.require_space_admin`
is only reached at `016:113`, 29 lines later.

### 8.2 The public red — reachable

Test: `packages/server/test/w3/xg01-ledger-replay-authz.test.ts` (W3-owned, cross-group),
**deliberately left RED**. Production HTTP, real `bootstrap()`, full 26-migration chain.

```text
POST  /v2/spaces                -> Space A
POST  /v2/spaces                -> Space B
PATCH /v2/spaces/{A}  cmid=w3-xg01-shared-replay-cmid  -> 200, A's projection
PATCH /v2/spaces/{B}  SAME cmid                        -> 200, no error,
                                                          RETURNS SPACE A's id AND name
```

A request that **addressed Space B** received **Space A's** identity and stored projection.
The facade does not constrain the `clientMutationId`. Reproducible across runs with fresh UUIDs.

**Non-vacuous:** a second case in the same file **passes** — the same cmid under a *different*
operation is refused with `>=400` and writes nothing. So the ledger *is* consulted on this path;
this is a genuine authorization-ordering bypass, not the ledger being skipped wholesale and not
a test passing by inertia.

### 8.3 The severity input — NOT harvestable (good news, and it is load-bearing)

The exploit requires knowing a cmid another principal recorded, so severity turns on whether a
cmid can be **harvested**. Nobody had measured this. W3 recorded a distinctive cmid via
`entities.create` and swept **eleven** composed read projections for that exact string:
`entities.get`, `entities.activity`, `entities.versions`, `entities.children`,
`entities.connections`, `entities.hierarchy`, `spaces.get`, `spaces.navigation`, `inbox.list`,
`actions.list` (entity context), and `collections.query`.

**Result: zero exposures.** The cmid appears in none of them. **Non-vacuous by construction** —
the same case then asserts the marker *is* present in `public.command_ledger` (count = 1), so an
empty exposure list means genuinely absent rather than "the probe never looked at a real cmid".

**Net framing, to be used in place of either extreme: reachable, but not self-serving.** An
attacker still needs out-of-band cmid knowledge or a guess, because the composed read surface
does not disclose one. Materially better than "publicly exploitable end-to-end"; materially
worse than "blocked by the facade".

**Declared limits.** Eleven projections is targeted, not exhaustive. The WS/events surface is
**not** covered (G10 uncomposed). Phase-1's single loopback identity means W3 proved *absent from
readable projections*, which is the necessary precondition for *never echoed to a non-recorder*,
not that statement itself. And these cmids are human-chosen strings, so this says nothing about
whether client-**generated** cmids are predictable — W4's "deterministically derived" upload
mutation IDs remain the live risk and belong to W2/INV-2 and W4.

### 8.4 Effect on W3's own verdicts — coverage hole, not retraction

Per the standing program ruling, a branch that is both unexercised and in an already-gated group
is a **coverage hole closed forward**, not a retraction. G01 keeps its public and agentic PASS:
its recorded case replayed `spaces.update` against the **same** `spaceId`, which is the
idempotency property and it holds. It never tested one cmid against a **different** Space.

W3 records the pattern plainly: this is the **second** gated group in one session — after the G03
embed hole — whose unexercised **branch** was found by someone else's inventory rather than by
this gate. That is a statement about the gate, not about W2's implementation:
**per-operation coverage was never per-branch coverage.** It is the strongest argument for §7's
gap analysis and is not softened here.

### 8.5 Binding requirement on the fix (SEC-1, `task_1785095801437_s0axjxesk`)

W2's Stage 1 promotes `023_w2_inbox.sql`'s **principal-pinning** — *a replay may not be returned
to a principal other than the one that recorded it*. Necessary, supported, **and not sufficient**.

W3's reproduction is **same-principal**: one owner, two Spaces. Principal-pinning passes that
check and would still return Space A's row to a request addressing Space B. The law must bind the
replay to **both the recording principal and the addressed resource**. If SEC-1 ships
principal-only, `xg01` stays red and W3 will not pass it. W3 confirmed independently — rather than
assuming — that its gated replay cases are all same-principal, which is precisely why
principal-only pinning would not have disturbed them *and* would not have caught this.

Because SEC-1 rotates G01's frozen `016` and `007`, it unbinds G01's verdicts under §7.4. W3 will
run a real re-sweep on landing, not a formality — the same standing as migration `030`.

## 9. Bound rebaseline, G02 verdict, and instrument discipline (2026-07-27)

### 9.1 Chain identity — canonical recipe

The earlier published recipe was **cwd-dependent**: it hashed `shasum`'s output *lines*, which
embed the path exactly as typed, so the same 28 byte-identical files produced four different
digests depending on the caller's directory and glob form. W2 authored it, W3 adopted it, and W4
reproduced it faithfully from a third session — which validated **reproducibility** and said
nothing about **correctness**. Three parties agreeing on one recipe's output is the same
one-mechanism agreement recorded in §7.6, applied without noticing.

**Canonical recipe of record**, verified cwd-independent from four starting directories and still
rename-sensitive:

```text
(cd <repo>/db/migrations && shasum -a 256 *.sql | shasum -a 256 | cut -c1-16)
28 files -> 6848bb5f20a21a8d
020 33915548b445ddd3 · 027 477c4dd6140f99a3 · 030 8bbc3e6043840cbc · 031 ca473b0cae0052fc
```

Retired as cwd artifacts or superseded content: `2a969baf9d98f300`, `125b007f6ba268a0`,
`6e3593a1d5fa4df6`, `2bbaf608880519ba`, `41ae15d7b9890cc4`, `1f1ec2afda56bda6`, `6540207bdefd5bb9`.

### 9.2 The bound rebaseline — and why the re-label is sound

Bound sweep, taken inside a granted migration freeze window after **three discarded attempts**:

```text
BIND START == BIND END   28 files
  measured label (cwd-dependent recipe, run from packages/server): 41ae15d7b9890cc4
  canonical label for the SAME tree (cwd-independent recipe):      6848bb5f20a21a8d
g01 7/7 · g03 6/6 · g05 4/4 · g06 6/6 · g07 4/4 · g08 5/5 · g09 4/4 · g15 5/5 · harness 2/2 = 43/43
g02 18/20
```

The bind survives the recipe defect for a specific reason. It read the digest at start and end
using the **same cwd and the same glob**, so the path component was constant; with paths held
constant the digest is still a pure function of content, and any content change would have moved
it. `START == END` therefore genuinely proves the tree was unchanged **during** the sweep. What
the broken recipe destroyed was **cross-session comparability**, not **intra-sweep validity** — the
bind compared W3's number to W3's own number seconds earlier under identical conditions.

**Not over-claimed:** this rescues *this* bind only. The earlier discarded sweeps cannot be
retroactively separated into real rotations versus cwd artifacts, because the cwd varied between
some of those readings. At least two of the three discards may have been unnecessary.

### 9.3 G02 public gate — FAIL (18/20)

**Confirmed product defect: `tracking.refresh` returns 403 on any multi-Space fan-out.** One Space
→ `202`; two Spaces → `403 forbidden`; unscoped whole-account form → `403`. The three forms differ
*only* in loop-iteration count. Root cause reproduced by W3 in source: `017:655-656` calls
`bind_actor` **inside** the per-Space loop, so iteration 2's
`resolve_actor` → `coalesce(requested, actor_id(), current_member_id(target))` short-circuits on
iteration 1's already-bound Space-A member and `can_act_as(memberA, spaceB)` fails with `42501`.
The exception aborts the transaction, rolling back iteration 1's queued row — all-or-nothing with
the "all" branch unreachable for any multi-Space caller. The server's own
`facade/context.ts:1-25` documents this exact hazard and avoids it per-request;
`queue_tracking_refresh` reintroduces it per-loop-iteration. Not the already-ruled missing
consumer: Form 1's clean `202` proves the path is built, so it is broken rather than unbuilt.

**Second reported defect WITHDRAWN — the W3 packet was wrong, not the product.** W3 instructed the
tester to require `details.reason === 'use_complete_command'`. That string appears **nowhere** in
`W0-AMENDMENT-DOSSIER.md` or `W0-CONSISTENCY-MATRICES.md` — the sole authority for W1–W5 —
and exists only in `API-CATALOG-GROUPED-GUIDE.md:137` labelled *"Proposed safety amendment"*.
The server behaviour is correct: `409 invariant_violation`, status unchanged, zero ledger rows,
zero completion edges. **The safety property holds.** This was single-source propagation committed
by W3 — one document read once, a proposal stated as an obligation — and it is the first W3 method
error that would have produced a **false defect against another wave**. Withdrawn loudly before it
cost a fix cycle.

The tester also corrected W3's own briefing and proved it empirically: the legacy
`SUPPORTED_CREATE_KINDS` handler is no longer mounted, G02's service builds far more than
task/doc, and restricted kinds are refused at `400` by `CreateEntityInputSchema` **before any
handler runs** — not `501`. Demonstrated by creating a `team_member` through the public boundary.

### 9.4 Verifying the instrument, not only the result

Two counterfeit-tool traps were found program-wide: `npx vitest` from the repo root resolves a
**different project's** vitest (1.6.1) that reports "no tests" for every file here, and `npx tsc`
from **outside** the repo downloads an unrelated deprecated package literally named `tsc` (2.0.4).
The first fakes a green-looking nothing; the second fakes a red.

W3 audit result — **clean**. W3's runner is `vitest/2.1.9`, byte-identical to the package-local
binary; both tester packets specify `cd packages/server && bunx …` with cwd never leaving the
repo; no `npx` appears in any W3 packet, the evidence doc, or the test tree.

W3 then **mutation-tested its own typecheck instrument** rather than trusting a silent pass:

```text
bunx tsc --version                        -> Version 5.9.3   (real TypeScript)
baseline                                  -> exit 0, clean
inject `const x: number = "not a number"` -> TS2322 CAUGHT, exit 2
restore, re-verify                        -> exit 0, clean
```

A silent pass from that config now means something. Going forward W3 accepts a **declared no-op
rebind** only when the shared-object statement is backed by an **executable catalog diff** — apply
the chain with and without the migration and diff the entire `public`+`internal` catalog,
mutation-testing the proof itself — the standard G13 set for migration `030`. A carefully verified
prose statement now buys a real sweep, because a strictly stronger artifact exists and is cheap.

### 9.5 Standing

G3 readiness remains **blocked and unrecorded**: SEC-1 outstanding, G02 failing, 91/20 textual and
78/20 live replay sites (72 live-exposed once `031` lands), and six frozen groups carrying exposed
sites. Migration `031` is landed and is **not** new-objects-only — it `create or replace`s six
pre-existing live functions — so G01 and G14 both require fresh public **and** agentic retests, and
`xg01` is re-run as SEC-1's acceptance criterion.

## 10. Invite-code escalation and the credential axis (2026-07-27)

### 10.1 SEC-1's resource binding VERIFIED WORKING — by the gate, not the author

Migration `031` landed and W3's `spaces.update` red went **green**:
`PATCH /v2/spaces/{B}` carrying Space A's `clientMutationId` now returns **409** with
`leakedSpaceAProjection: false`, where it previously returned **200 with Space A's id and name**.

W3 also **relaxed its own over-strict assertion**: it had additionally required
`returnedId === spaceB`, but a refusal is an equally correct outcome. The test was wrong and the
fix was right. A gate that tightens an assertion when the product disagrees manufactures defects.

### 10.2 The escalation chain does NOT close — the producer half is still open

Measured on the current 28-file chain **with `031` landed**:

```text
POST /v2/spaces/{A}/invites  cmid=X   -> 201, invite created in Space A
POST /v2/spaces/{B}/invites  SAME cmid -> 201, response CONTAINS SPACE A's LIVE INVITE CODE
leakedSpaceAInviteCode: TRUE
```

`create_invite` (`007:583`) returns the replay with a bare `return` before
`internal.require_space_admin`, and its stored result is `to_jsonb(invite)` — the full
`space_invites` row **including the live `code`**.

**`031` does not cover it.** Its replaced functions are exactly `w2_update_space`,
`grant_stream_attach`, `join_public_space`, `redeem_invite`, `set_space_default_channel`,
`update_space_menu`, plus two new `internal.require_replay_*` helpers. Zero matches for
`create_invite`. So Stage 1 hardened the **consumer** (`redeem_invite`) and left the **producer**
open — the wrong half, because **the invite code is a bearer credential: once obtained, the
attacker never needs the replay path again.** A consumer-side fix against a leaked credential is
theatre.

**Method note — a false negative was one step away.** W3's first probe assumed the public DTO
shape, got an empty string, and would have reported "no leak" on the worst site in the program.
It was corrected to measure against **storage** — read the actual code out of `public.space_invites`
and search the Space-B response for that exact string. Adopted as a standing packet requirement:
**any probe reporting a NEGATIVE must first demonstrate it can detect the corresponding POSITIVE.**

### 10.3 Correction to W3's own reasoning: this is NOT evidence for `032`

W3 argued that moving the principal check inside `ledger_replay` would have covered
`create_invite` "and the other 85 without anyone having to enumerate correctly." **That is wrong**,
and W3 verified the correction in source rather than conceding it:

- `internal.require_replay_principal` (`031:145-158`) compares `ledger_identity` to
  `internal.identity_id()` — **identity only**. W3's red is **same-principal, different-resource**
  under the single loopback auto-owner, so the pin would match, pass, and hand the code over.
- `internal.require_replay_subject` (`031:172-178`) takes the **addressed** resource as an
  argument supplied by the call site; its own comment (`031:779-782`) says it must be called inside
  the replay branch because it needs the stored subject.

So the resource half is **irreducibly per-site**: `ledger_replay` cannot know what resource the
request addressed. The measurement supports the **credential-first sort axis**, and argues that
enumeration quality is load-bearing precisely because structural coverage is unavailable for that
half. Recorded because using a real measurement as evidence for a claim it does not support is the
corroboration error of §7.6 in new clothes — committed by W3, on its own finding.

### 10.4 Gap-analysis Phase 1, credential axis: three sites, and a one-operator defence

Applying the adopted primary sort — *does the stored result contain something that functions as a
credential* — across every `ledger_record` site storing a whole row:

| Site | Function → operation | Stored result | Status |
|---|---|---|---|
| `007:591` | `create_invite` → `spaces.invites.create` | `to_jsonb(invite)` **includes live `code`** | **CONFIRMED leaking publicly** |
| `007:612` | `revoke_invite` → `spaces.invites.revoke` | `to_jsonb(invite)` **includes live `code`** | static match, legacy path |
| `016:360` | `w2_revoke_invite` → `spaces.invites.revoke` | `to_jsonb(invite_row)` **includes live `code`** | static match — **the LIVE G01 path** |
| `007:2223`, `031:351` | `grant_stream_attach` | `to_jsonb(grant_row) - 'token_hash'` | **strips its credential — the existing defence** |

`016:360` is the one nobody had named: `016` supersedes `007` for W2, so `w2_revoke_invite` is the
live implementation behind `spaces.invites.revoke` — a G01 operation, **composed, holding W3's
public and agentic PASS**.

**The codebase already has the defence and applies it to grants but not invites.**
`grant_stream_attach` strips `token_hash` from its stored result; the three invite sites strip
nothing. Recommended as **defence in depth independent of the ordering fix**: `to_jsonb(invite) -
'code'`. SEC-1's per-site resource binding stops a replay reaching the wrong resource; stripping
the code means that even if a future author reintroduces an ordering mistake at any of the 91
sites, there is no credential in the stored result to leak. Two independent defences, and the
second is one operator and cannot race.

Generalised as a proposed stated law: **a ledger-stored result must never contain a value that
functions as a bearer credential**, because the ledger is by design replayable and long-lived.
`grant_stream_attach` already obeys it.

**Not over-claimed:** only `007:591` has been measured publicly. `007:612` and `016:360` are static
shape matches, not executed, and a revoked invite may be materially less dangerous — W3 has not
checked whether every path revokes before returning.

### 10.5 A limit on W3's own SEC-1 green: sequential only, does not cover the race

W3's `spaces.update` result — `PATCH /v2/spaces/{B}` carrying Space A's `clientMutationId` returns
`409` with `leakedSpaceAProjection: false` — is a **sequential** measurement: two requests, one
after the other, one connection.

SEC-1 subsequently demonstrated **executably** that **all 21 of its sequential tests passed on the
raced build** while a non-member racing the victim's uncommitted ledger row received the victim's
full Space projection. W3's green falls in exactly that category: it would have been green on the
raced `ca473b0c` too, because the sequential path was already correct there.

**Honest statement: W3's gate verified the RESOURCE BINDING sequentially. It did NOT verify the
concurrency ordering and could not have.** SEC-1's two-connection test — which polls `pg_locks` for
a non-granted advisory lock and *asserts* the attacker is genuinely parked, so a lucky interleaving
cannot pass as coverage — is what covers the race, and that is the **author's** test rather than
the gate's. That is a real gap in W3's coverage, not a criticism of SEC-1. W3 has no concurrent
harness today.

Recorded so the `409` is not inherited as full verification of `031`. This is the third instance
of *"a true green that means less than it appears"* in one session, after the counterfeit runner
and the sequential-test-over-a-concurrent-hole; naming W3's own instance is preferable to having it
counted as a fourth by someone else.

### 10.6 Binding status and adopted acceptance rules

W3's last coherent bind was `28 files / 6848bb5f20a21a8d`, which contained the **raced** `031`
(`ca473b0c`). That file is now `940f9eb1d5d8e259` and the chain is `8c5227dfe17923c2`, so **the
43/43 sweep and the G02 18/20 verdict are currently UNBOUND** — accurate for what they measured,
not current. W3 is holding rather than chasing, at W2's request, pending a single batch landing
(`027` tier fix + `031` Stage 1b + `032`), and will then run **one** sweep covering the eight closed
groups, the harness, G02, and `xg01`.

Two acceptance rules adopted from W2 and G13:

1. **Verify an edit against its DELTA, never against the whole file.** W2's own grep of `027` hit
   that file's *original* `create trigger` and revokes and would have produced a false positive
   against a statement that was in fact true.
2. **An executable catalog diff proves a migration adds no catalog OBJECT; it does NOT prove
   semantic inertness.** A `create or replace` at an identical signature — exactly `031`'s six
   functions and `027`'s two — leaves the catalog byte-identical while changing behaviour. For that
   class the diff is **silent**, so no declared no-op is available and a real W3 rebind is the only
   instrument.
