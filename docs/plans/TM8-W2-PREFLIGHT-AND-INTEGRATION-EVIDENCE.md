# tm8 W2 Preflight and Integration Evidence

**Wave:** W2 — API implementation by catalog group  
**Task:** `task_1785034451639_y52nw6141`  
**Original coordinator:** `sess_1785063923929_t2hz3v5an` (terminated mid-wave, 2026-07-26)  
**Resumed coordinator:** `sess_1785092145056_w4oq8qoel` — `tm8 W2 Coordinator Opus`, `claude-opus-5` xhigh, under HANDOFF-STATE §8 amendment M-1  
**Started:** 2026-07-26; resumed 2026-07-27  
**Status:** in progress; G1 user-waived/authorized entry verified; tranche-v1 frozen and W3-passed; resumption triage complete (§5.4); rolling pipeline active  
**Scope:** complete public tm8 Server HTTP/WS semantics for every v1 catalog group, functionality first. No CLI, UI, Remote Phase 2, W3 independent gate work, or git.

> **§5.4 supersedes any group status stated in §3 or §5.3.** Those sections record the state as
> the original coordinator last wrote it and are preserved as historical evidence. Where they
> disagree with §5.4, §5.4 is authoritative — it was re-derived from the working tree and a real
> test run rather than from this document.

## 1. Entry gate and frozen authority

W1 is complete and the user waived G1 for this round only after the official migration-runner repair and required green integration suite. The following entry hashes were reproduced before W2 delegation:

```text
9f3258054fb1a0a3cbc80928edcea87760715f2402671534bd32a232773b5ee7  db/migrations/015_w1_foundations.sql
062ec620b8f9be87bc0a96f3bb30e900d0befff540b37e2ddc3ff418c3b9ce5a  tools/conformance/generated/w1-conformance-manifest.json
e6827ec3d41d1ab7e0eed86389bb7f9b4a763b8774395b2fbe8967c4dca8dea5  docs/plans/TM8-W1-PREFLIGHT-AND-INTEGRATION-EVIDENCE.md
76d4186c5aa9b44bf57fdfcd1f7c0d4d63423349a14641c4cc5550b0b6e3ebea  docs/plans/TM8-W0-W5-HANDOFF-STATE.md
b85a18304f3769ba88da67403a7d90331a17c6355df7b451d650b49990434805  docs/plans/TM8-W0-AMENDMENT-DOSSIER.md
fa2c304a5ee24ee7c5d9eb47e157c38eb8d5aa6145b8a4a99046ae0a21f11c60  docs/plans/TM8-W0-CONSISTENCY-MATRICES.md
```

The implemented W1 boundary is exact:

| Measure | Value |
|---|---:|
| Catalog rows | 101 = 99 v1 + 2 reserved |
| HTTP / WS | 100 / 1 |
| Registerable v1 HTTP ceiling | 98 |
| Existing semantic HTTP handlers | 28 |
| Existing schema bindings | 36 |
| Existing explicitly unbound commands | 13 |
| Unimplemented v1 HTTP operations | 70 |
| Intentionally reserved operations | `search.query`, `bridge.fetchBlob` |

The package/migration digest at the W1 close was `5f1a6ace0566d4bff0fbbef48c66a2a189207eb8dc53c96c7d4bcd8eeac88e0d`.

## 2. Interpretation and implementation laws

- Server is the root product domain; Space is the authorization, graph, event-ordering, and replay boundary; Workspace is a view.
- ProjectResource is configuration truth. Per-Space `project` is a restricted projection. Work-session Project association is M:N through writable `in_project`; `launchProjectId` is immutable provenance only.
- Messages are stored first. Chat and Discussion use one message store. Terminal bytes never author messages.
- `execution.prompt` is frozen v1 but callable only by the audited `system_delivery_adapter` for a pre-reserved stored-message attempt. Every Member/Teammate/owner/admin/session/act-as caller is rejected before queue admission with `forbidden/use_message_send` and zero PTY bytes.
- Every Teammate-authored top-level send/reply live wake reserves under one durable locked unordered work-session pair. A new message/thread/process restart does not reset the four-reservation allowance.
- Interaction Profiles are restricted entities; static templates are registry assets, never entities. A validated immutable pin is runtime authority. `providerCaptureMode` is `explicit-only`.
- Durable live publication must reconcile from `workspace_events` and per-Space sequence. Presence and terminal bytes never advance the durable cursor.
- Handlers use the one identity path, RLS reads, and enumerable SECURITY DEFINER RPC writes. No handler performs raw DML or invents a DTO/error.
- Reserved routes remain honest 501. Unknown routes remain 404. A mounted route or fake 200 is not implementation.

## 3. Group task DAG and ownership

| Group | Child task | Operation family | State/session |
|---:|---|---|---|
| G01 | `task_1785064367104_lko600uu6` | identity + Spaces | complete and frozen / `sess_1785064481104_76sd6z77h` |
| G02 | `task_1785064368282_5a8xkwf9p` | universal entities + commands + tracking | complete and frozen / `sess_1785068043906_mo8jc1qyl` |
| G03 | `task_1785064369468_lmvkvrfb5` | edges + edge types + placements | complete and frozen / `sess_1785066230796_kmm7x2m2q` |
| G04 | `task_1785064370641_y6feb7za8` | messages + attachments + delivery + handoffs | active rolling wave / `sess_1785070051283_5u07ivppq` |
| G05 | `task_1785064372111_lyo2ow81i` | collections + graph + undo | complete and frozen / `sess_1785064483552_i0zc7mc6n` |
| G06 | `task_1785064373273_tcfwy1ck6` | Projects + projections + associations | complete and frozen / `sess_1785068101395_b16zd7y0j` |
| G07 | `task_1785064374597_jtdyzdczy` | files | complete and frozen / `sess_1785066292758_tokl8uyqx` |
| G08 | `task_1785064375915_f6qljuzqw` | inbox + read marks + notifications | complete and frozen / `sess_1785066344350_3itooje2b` |
| G09 | `task_1785064377387_f9ud929h8` | saved views + actions | complete and frozen / `sess_1785064484990_sd79avi5a` |
| G10 | `task_1785064378775_svjvqke3r` | durable events + WS + presence + replay | pending |
| G11 | `task_1785064380344_vcp74k5m7` | execution + session lifecycle + B1/B2 adapter | pending |
| G12 | `task_1785064382030_mnux7wbpc` | entity kinds + Interaction Profiles/defaults/pins | pending |
| G13 | `task_1785064386758_4qqm4rbfk` | feed + context + activity provenance + focus | pending |
| G14 | `task_1785064388426_76n0lpcdx` | menu + default channel | active rolling wave / `sess_1785070729092_gs32adsc4` |
| G15 | `task_1785064389762_x9tqmk7qv` | reserved search/bridge + honesty accounting | active / `sess_1785071919403_d8vzaufg2` |
| X01 | `task_1785066786237_ohcal7h0r` | post-G04 placement-embed undo compatibility | pending dependency fix |
| I01 | `task_1785068989766_d99pu0gcy` | rolling public registration/integration tranche 1 | complete/frozen; W3 gate active / `sess_1785069410139_2jfwvewou` |
| C01 | `task_1785070973185_w4xpcjqe0` | historical W1 conformance + current seam inventory | complete/frozen / `sess_1785071021096_kz8nm1qkx` |

All fifteen tasks were created before delegation and received their exact relevant authority documents. Every code session uses team member `tm_1785033707528_3qfm30abt` with canonical `provider=openai`, `agentTool=codex`, `model=gpt-5.6-sol`, `reasoningEffort=xhigh`, and `accessMode=fullAccess`.

A source-derived assignment check compared the group operation sets to built `OPERATIONS`: `catalog=101`, `assigned=101`, with zero missing, zero extra, and zero duplicate names. Group counts are `19,19,6,10,3,7,4,3,5,3,4,11,2,3,2` for G01–G15 respectively.

## 4. Rolling dependency schedule

Per the user direction received during Batch 2, the three worker slots are a
rolling pipeline: every coordinator-verified completion immediately hands its
owned seams, migrations, tests, and risks to the next dependency-safe group.
The coordinator no longer waits for every peer in a numbered batch before
filling a freed slot. Package/file disjointness and semantic prerequisites still
control eligibility.

1. Batch 1: G01, G05, G09 — complete/frozen.
2. Batch 2: G03, G07, G08 — complete/frozen.
3. Rolling lanes: G02, G04, and I01 are active. G06 froze and its slot immediately advanced to dependency-ready G04; I01 took the prior free slot before G14 under the public-gate priority override.
4. Then G04 waits for G03 and G07; G12 follows G06/G14; G13 follows the universal entity/message seams.
5. Cross-group repair: X01 runs after G04 freezes, adding the named message-tombstone inverse to migration 020 and focused G03/G05 integration coverage.
6. Batch 5: G10, G11, G15. G11 follows the message/project/profile provider seams; G10 follows durable event producers.
7. Shared integration: a fresh scoped Sol task/session exclusively owns facade registration, input-schema binding, composition-root wiring, cross-group entity projection, event publication integration, generated conformance updates, and migration-order integration.
8. Independent W2 verification: fresh Terra-xhigh or intentional Sonnet read/test session.
9. Blocking/major fixes: new scoped Sol-xhigh sessions.
10. Gate override: W3 coordinator `sess_1785068799199_cazksrch4` performs the rolling independent real-Server public gate. Per user direction, there is no separate Opus review for this W2-to-W3 handoff; W3 spawns agentic verification only after its public PASS.

## 5. Batch evidence ledger

Every group must return:

- owned changed files and collision audit;
- failing test written/tightened first and exact red result;
- implementation and exact scoped green commands/counts;
- operation-by-operation behavior, database effects, idempotency, authorization, and cursor/race evidence;
- compatibility impact and unresolved risks;
- explicit confirmation that no git command ran.

### 5.1 Batch 1

All three launch manifests were audited before acceptance: OpenAI/Codex,
`gpt-5.6-sol`, xhigh reasoning, full access, and the scoped child task attached.

| Group | Session | Exclusive production/test ownership | Current boundary |
|---:|---|---|---|
| G01 | `sess_1785064481104_76sd6z77h` | existing `handlers/spaces.ts`, new `handlers/w2/identity-spaces.ts`, `services/w2/identity-spaces.ts`, migration `016_w2_identity_spaces.sql`, group unit/PG tests | complete and frozen; red-first missing seam/migration followed by authorization/actor/unread repairs; worker green 11 unit + 8 PostgreSQL, Server build, root typecheck; coordinator rerun 2 files / 19 tests green |
| G05 | `sess_1785064483552_i0zc7mc6n` | existing `handlers/collections.ts`, new `handlers/w2/graph-undo.ts`, migration `020_w2_collections_graph_undo.sql`, group unit/PG tests | complete and frozen; red-first missing module; worker green 4 unit + 6 PostgreSQL, Server build, root typecheck; coordinator rerun 2 files / 10 tests green |
| G09 | `sess_1785064484990_sd79avi5a` | new `handlers/w2/saved-views-actions.ts`, `services/w2/saved-views-actions.ts`, migration `024_w2_saved_views_actions.sql`, group unit/PG tests | complete and frozen; red-first missing module/migration; worker green 6 handler/service + 7 PostgreSQL, Server build, root typecheck; coordinator rerun 2 files / 13 tests green |

No collision or authority blocker has been reported. Batch 2 remains closed until
all Batch 1 production ownership is frozen and each scoped result is verified.

G09 operation evidence: RLS remains the private/Space-shared visibility
authority; create/update/delete use owner-only SECURITY DEFINER RPCs, command
ledger replay, and row locking; direct `tm8_app` DML is denied; concurrent
replay creates one row/ledger result; query/layout writes leave selected entity
version/timestamps unchanged. `actions.list` derives only live registered
capabilities, carries target/version/epoch/authz/exposure/help metadata, and
excludes `execution.prompt`, WS, and reserved rows. The frozen SavedView input
has no expected-version carrier, so serialization is row-lock plus ledger
replay rather than an invented optimistic-version DTO.

G05 operation evidence: collection cursors bind the normalized query, sort,
and operation scope; graph projections reuse RLS-filtered collection candidates,
force live endpoints, and bound traversal to 200 nodes, three hops, and 1,000
edges. Undo uses one opaque-token RPC with row locking, original-actor checks,
ledger replay bound to the same token/mutation ID, and atomic rollback on inverse
failure. Its allowlist is exactly `edges.delete`, `entities.move`, and
`entities.restore`; irreversible handoff/delivery facts are excluded. The broad
Server run reported 13 non-G05 failures: W1 migration tests hard-code the old
001–015/latest-015 boundary while W2 migrations now coexist, plus sidecar
`initdb` lifecycle environmental failures. These remain explicit integration
work rather than scoped-group failures.

G01 operation evidence: all 19 identity/Space rows are exported through one
registration seam. Reads use claim-bound RLS; leaderboard and awards are real
keyset pages; settings returns the frozen menu/default-channel/profile/revision
shape. Commands require mutation IDs and use enumerated RPCs with no handler
raw DML. Migration 016 adds five route-bound RPCs, serializes non-empty ledger
mutation IDs before effects, authorizes a route Space before child lookup,
validates actors inside the target Space, and excludes unread rows whose
canonical anchors are not readable. Concurrent replay, role negatives,
cross-Space child binding, invite limits/revocation, protected axes, point-event
RLS, restricted unread non-leak, null repo clearing, and unchanged settings
revision are covered. The scratch suite applied 001–016; the live sidecar probe
was unavailable at `localhost:5442` and is recorded as environmental.
The coordinator reproduced the worker-reported SHA-256 values for all six G01
owned files after the final report; no post-report drift was present.

Batch 1 is closed with coordinator reruns green at G01 19/19, G05 10/10,
and G09 13/13: 42 focused tests across six files.

### 5.2 Batch 2

All three launch manifests were supplied and audited as `provider=openai`,
`agentTool=codex`, `model=gpt-5.6-sol`, xhigh reasoning, and full access.

| Group | Session | Exclusive production/test ownership | Current boundary |
|---:|---|---|---|
| G03 | `sess_1785066230796_kmm7x2m2q` | `handlers/w2/edges-placements.ts`, `services/w2/edges-placements.ts`, migration `018_w2_edges_placements.sql`, two group tests | complete and frozen; red-first missing modules; worker green 6 unit + 7 PostgreSQL, Server build, root typecheck; coordinator combined rerun 13/13 green |
| G07 | `sess_1785066292758_tokl8uyqx` | `handlers/w2/files.ts`, `services/w2/files.ts`, `files/w2-blob-store.ts`, `http/w2-file-upload.ts`, migration `022_w2_files.sql`, two group tests | complete and frozen; red-first missing seam/migration plus tightened intended reds; worker and coordinator green 7 unit + 8 PostgreSQL, Server build, root typecheck |
| G08 | `sess_1785066344350_3itooje2b` | `handlers/w2/inbox-read-marks.ts`, `services/w2/inbox-read-marks.ts`, migration `023_w2_inbox.sql`, two group tests | complete and frozen; red-first missing seam/migration; worker green 7 handler + 7 PostgreSQL, Server build, root typecheck; coordinator combined rerun 14/14 green |

Shared facade/input-schema/main/server mounting and event publication remain
reserved for the later integration session. Each PostgreSQL slice must prove it
applies against exactly migrations 001–015 plus its owned migration.

G03 identified one honest cross-group dependency: `placements.apply` with
`embed` must create a message and return an undo token, but migration 020
currently constrains registered inverses to `edges.delete`, `entities.move`,
and `entities.restore`. G03 will issue the truthful named `messages.delete`
inverse token and test atomic creation/token shape without pretending isolated
redemption works. Pending task `task_1785066786237_ohcal7h0r` runs after G04
migration 019 defines the named message-tombstone RPC; it will extend migration
020 and integration tests. Handoffs remain intentionally irreversible.

G03 additionally proves exact-microsecond cursor paging, RLS/live endpoint
joins, edge registry schema enforcement, server-owned origin preservation,
mutable normal `in_project` edges, immutable materialized/recorder/message-owned
edges, placement direction/atomic rollback, ProjectResource-first association
locking, 16/17 cap behavior, and create-vs-unlink rollback.

G08 proves Member versus acting-Teammate recipient separation, read-only owned
Teammate inspection, authorization before child lookup, readable/null/tombstone
target projection, exact replay/concurrent recipient isolation, Member-only
monotonic read marks, frozen partial-index use, closed RPC ACLs, command-ledger
counts, and direct application-role DML refusal.

G07 proves exact binary upload/download, bounded streaming and SHA-256,
path/header/filename/symlink containment, grant plus identity binding,
idempotent staged retries and abort, conservative download headers, RLS-hidden
restricted/deleted metadata, configurable positive-safe-integer deployment
limits above the 512 MiB default, closed RPC/helper ACLs, direct application-role
DML refusal, advisory-locked concurrent init with one slot/ledger result,
single-file concurrent completion, replay target binding, and atomic attachment
rollback. `bridge.fetchBlob` remains reserved and unregistered. The raw grant PUT
is the one narrow non-catalog support transport and awaits I01 composition.

G06 exports `registerW2ProjectsAssociationsHandlers` for all seven project
operations. Worker and coordinator gates are green at 6/6 handler and 9/9
PostgreSQL plus Server build/root typecheck. A disposable 001–015+017+021
compatibility apply proved the two G02 provider-link RPCs and four G06 RPCs
coexist with executable application grants. Focused evidence covers stable
restricted projections, multi-Space updates including `repoUrl:null`,
ProjectResource-first lock order and active-link rechecks, immutable launch
provenance plus the union unlink guard, the 16/17 association cap, correction
promotion/demotion and replay, counter/invalidation parity, direct DML and
generic deletion refusal, and deterministic create-versus-unlink rollback.

### 5.3 Rolling next wave

| Group | Session | Predecessor handoff | State |
|---:|---|---|---|
| G02 | `sess_1785068043906_mo8jc1qyl` | G01/G05/G09 plus frozen G08 recipient/read-state seam | complete and frozen; coordinator rerun 4 handler + 12 PostgreSQL, Server build and root typecheck green; held for the next public tranche |
| G04 | `sess_1785070051283_5u07ivppq` | frozen G03 embed/messages.delete inverse requirement plus G07 protected attachment seam | active |
| G06 | `sess_1785068101395_b16zd7y0j` | frozen G03 association lock/cap/race and RPC signatures | complete and frozen; coordinator rerun 6 handler + 9 PostgreSQL, Server build, root typecheck; 001–015+017+021 compatibility green |
| G14 | `sess_1785070729092_gs32adsc4` | frozen G01 Space settings/menu/default-channel read contract | active; migration-029 creation briefly held to preserve W3 tranche-v1 ledger |
| I01 | `sess_1785069410139_2jfwvewou` | frozen G01/G03/G05/G06/G07/G08/G09 seams and 99/99 focused coordinator evidence | complete/frozen; 57 facade/62 production, health 100/62, owned 6/6, production 37/37, migration 19/19, build/typecheck, exact hashes recorded |
| G15 | `sess_1785071919403_d8vzaufg2` | two reserved-honesty/current-residual tests only | active; no DB, production, migration, generated, or shared-file ownership |
| C01 | `sess_1785071021096_kz8nm1qkx` | W1 generated manifest plus current I01 exported-seam registry shape | complete/frozen; conformance 14/14, build/typecheck/check-generated green, historical manifest hash unchanged |

Per the W3 gate override, pending task `task_1785068989766_d99pu0gcy`
prioritizes a first rolling public-integration tranche for all frozen groups. It
took the next verified free slot before G14, mounts only completed seams, and
will hand a real production-Server base URL and evidence to W3 while remaining
groups continue in parallel. By full-program coordinator ruling, I01 adds no
manifest/help/discovery HTTP or resource route; W3 owns an evaluator-only lazy
adapter over the generated conformance manifest, while every real operation is
tested through production HTTP/WS. I01's initial red used a generic pre-body
route extension; coordinator review rejected it as a hidden mutation seam. The
corrected composition exposes only a named `fileUploadRoute` and gates it to
the exact canonical G07 raw PUT path before JSON parsing; focused tests prove
similar and unknown paths remain 404.

I01 tranche-v1 is frozen at exactly G01/G03/G05/G06/G07/G08/G09. Its live
production test listener reported
`{operations:100,implemented:62}` (57 facade plus five event/execution
handlers), and the exact gate ledger is owned 6/6, frozen-group focused 51/51,
production public 37/37, migration order 19/19, Server build and root
typecheck. Reserved `search.query`/`bridge.fetchBlob` remain 501, unfinished
`entities.move` remains 501 outside this tranche, and an unknown path is 404.
The coordinator reproduced all nine reported SHA-256 snapshot values. A later
parallel coordinator DB replay exhausted the host volume and failed before
assertions; five zero-connection disposable databases created by that failed
run were removed exactly, no user/development database was touched. W3's
independent rolling gate returned production PUBLIC PASS for every tranche-v1
group: G01 7/7, G03 5/5, G05 4/4, G06 6/6, G07 4/4, G08 5/5, and G09 4/4,
35/35 group tests with no product defect. Its separate agentic verification
follows. The temporary migration-019/029 creation holds used to preserve this
snapshot were released immediately after the public PASS.

```text
58ff8b7f3c61c5e99f23a0c6096725c477f98e110aab9a250f7b513fec42df76  packages/server/src/facade/index.ts
8d4627fbb3b0765e90b0f0425520f22fe19020840dbb4f8757ad94fa9024140e  packages/server/src/facade/input-schemas.ts
33a0deef882b180b215d0290a15c79d8565cc20356de99b18d6070fb1dfc449a  packages/server/src/main.ts
b949b5f8a0865e3df570b32020683bb14b1f4e0f2be47eb5ebb9cb9dd1939714  packages/server/src/http/config.ts
b7ffc54abeba9afc17e553aa42e5b772343baf734ed033e687f072ce1c8043e5  packages/server/src/http/server.ts
b6b966ddf4a93f825345b2dd71edd0bad60a9fc2b99b8154a1928117e5ae3a16  packages/server/test/w2/rolling-public.integration.test.ts
0dd2e8435b30bde9c0b3b8f67072dc5a35cc5030348ff51d127b088fbebe5dd1  packages/server/test/db/w2-migration-order.pg.test.ts
1556171af703d36857685c5633d5ec7e15ace1b94852930cebc3fadec8fa07d6  packages/server/test/db/w1-migration-runner.test.ts
74cc90e20b86abb1aa5bd113775fda4451c2fa612e6fc3da46b91d1d6f4c6548  packages/server/test/db/w1-foundations.test.ts
```

C01 repaired the historical/current conformance boundary without changing the
generated W1 artifact. A typed, deep-frozen and validated source snapshot owns
the historical 28-handler/36-binding/13-unbound boundary. A separate current
AST inventory follows only local exported `register*` seams actually imported
and invoked by `facade/index.ts`; it proves 57 facade + four execution + one
event handler, 47 input bindings, three unfinished unbound commands, and 36
unimplemented registerable HTTP operations at tranche-v1. Coordinator replay
is green at conformance 14/14, generated check, tools build and root typecheck;
the W1 manifest remains 124718 bytes with SHA-256
`062ec620b8f9be87bc0a96f3bb30e900d0befff540b37e2ddc3ff418c3b9ce5a`.

### 5.4 Resumption triage — 2026-07-27, coordinator `sess_1785092145056_w4oq8qoel`

**This section is authoritative for group state.** The GPT-5.6 provider became unavailable, the
original W2 coordinator and every Codex worker were terminated mid-wave, and this document was
left stale. Per HANDOFF-STATE §8.1 the resuming coordinator re-derived state from the working tree
and a real test run. Every claim below was measured by the resumed coordinator itself, read-only,
with zero edits, zero spawns, and zero git commands during triage. Nothing on disk was deleted,
reverted, or cleaned up.

**Provider audit (M-1).** Coordinator: `tm_1785091986509_qebvn6dn2`, provider `claude`, agentTool
`claude-code`, model `claude-opus-5`, reasoning `xhigh`, access `fullAccess`. Implementation
worker member `tm_1785091987091_id0qite2j` audited before first use: `tm8 Opus Impl xhigh`, model
`claude-opus-5`, agentTool `claude-code`, mode `coordinated-worker`. No `gpt-5.6-*` member is
spawned for the remainder of this program. Recorded provider audits earlier in this document
remain historically accurate for the sessions they describe and are not rewritten.

#### Measured baseline

| Check | Command | Result |
|---|---|---|
| Server build | `bun run build:server` | EXIT 0 |
| Root typecheck | `bun run typecheck` | EXIT 0 |
| Contract | `bun run test:contract` | 3 files / **42 pass** |
| Conformance | `bun run test:conformance` | `check:generated` current + 2 files / **14 pass** |
| Official runner, current chain | `test/db/w2-migration-order.pg.test.ts` | **2/2 pass** |
| Broad Server, excl. `test/w3`, serialized | `bunx vitest run --no-file-parallelism --exclude 'test/w3/**'` | 54 files: 46 pass / 6 skip / **2 fail**; 463 tests: **397 pass / 64 skip / 2 fail** |
| `test/w2/` only | `bunx vitest run test/w2/ --no-file-parallelism` | 13 files / 90 tests: **89 pass / 1 fail** |

The official migration runner applies **all 26 repository migrations — 001–024, 027, 029 — in
lexical order from empty and is idempotent**, and upgrades a supported 001–015 runner state
through every later migration. Migration 019 is in the chain and the chain is green. The 64-skip
count is identical to the W1/I01 record, and this run recorded **zero environmental failures**:
the nine sidecar `initdb` failures previously classified as environmental now present as skips.

Per-slice PG reruns, each in its own serialized process. Frozen-group regression, **64/64 green**:
identity-spaces 8/8, edges-placements 7/7, collections-graph-undo 6/6, projects 9/9, files 8/8,
inbox 7/7, saved-views-actions 7/7, entities-commands-tracking 12/12. Undecided groups:
messages-handoffs 5/5, profiles 6/6, menu-default-channel 11/12.

#### No W3 regression

All nine frozen I01/tranche-v1 SHA-256 values in §5.3 reproduce **byte-identically**, so the
tranche-v1 production composition is exactly what W3 accepted. `test/w2/rolling-public.integration.test.ts`
passes 6/6 through the production `bootstrap()` composition. The facade registers exactly the
tranche-v1 seven groups; G02, G04, G12 and G14 are built but deliberately uncomposed.

The live W3 coordinator `sess_1785092163476_4on0tyohq` independently corroborated this: a 35/35
sweep of all seven previously-passed public suites against the current tree (its harness applies
every migration file present, so it ran against all 26 including 027 and 029), the same five
shared-seam hashes with zero drift, and a catalog digest recomputed from built `OPERATIONS` at
`sha256:df96ff5a4c2d11e41ec1d7b9c5e460bdcb8ae8d9c2c99b140f59e08305f8d604` across 101 rows,
identical to tranche-v1. Two independent derivations agreeing is the evidence of record.
**New W3 verdict: G15 reserved/residual honesty PASS 4/4.**

#### Group state re-derived — corrections to §3 and §5.3 in bold

| Group | §3 said | **Triage verdict** |
|---:|---|---|
| G04 messages/attachments/delivery/handoffs | active | **implementation-complete but NOT freezable — no worker report, no recorded red-first evidence.** Seam registers exactly 10/10 catalog operations. 13/13 green (8 handler + 5 pg). Migration-019 repair **confirmed still present**: zero `internal.request_id` references under `db/migrations/`; `019:1199` uses `coalesce(internal.claim_text('tm8.request_id'), p_handoff_id)`; ACL tail `set role tm8_graph_owner` at `019:10`, `reset role;` at `019:1359`; delivery boundary is exactly the three RPCs at `019:676/794/820`; `pair_budget_version` threaded through reserve. Assigned to audit task `task_1785092866292_x7eae2y82`. |
| G12 entity kinds + Interaction Profiles | **pending — FALSE** | **implementation-complete but NOT freezable, same reason.** 11/11 operations registered. 17/17 green (11 handler + 6 pg). Its pg slice proves it applies after the frozen tranche and before G14's 029. Audit pass pending. |
| G14 menu + default channel | active | 3/3 operations registered, **19/20** — the only red in the repository. Assigned to fix task `task_1785092853993_uemxwsq1u`. |
| G15 reserved search/bridge honesty | active | **confirmed test-only**, zero production/migration/shared-file ownership, 6/6 green, and now **W3 public PASS 4/4**. |
| X01 placement-embed undo compatibility | pending dependency fix | **confirmed NOT done, by source**: `db/migrations/020_w2_collections_graph_undo.sql:18` still constrains the inverse allowlist to `('edges.delete','entities.move','entities.restore')`. Its dependency is now unblocked because migration 019 defines `w2_tombstone_message`. |

**Freeze rule applied.** G04 and G12 pass their suites under the resumed coordinator's own reruns,
but neither has a worker report or any recorded red-first evidence — their sessions died before
reporting. Freezing them would mean accepting green with no recorded red, which this wave rejects.
Each therefore receives a fresh Opus-xhigh **audit-and-complete** pass that verifies the orphaned
implementation operation-by-operation against the dossier and produces the missing evidence
packet, with any conformance gap treated as a genuine red. W3 has endorsed this bar and confirmed
that neither group inherits credit from its regression sweep.

**B1/B2 remain G11 scope, and are not a G04 hold.**
`packages/execution/src/pty/w2-message-delivery.ts` exists and explicitly documents
`isSystemDeliveryPrincipalFor` as a G11 injection point; the G04 service contains no pair-budget
or reservation code. This matches the binding dependency order.

#### The only red in the repository — G14 `spaces.defaultChannel.set`, 2 tests

A **stale-test defect, not a production defect.** Accepted by the full-program coordinator and
independently re-derivable by W3.

- Dossier **A03** freezes the operation as `SetDefaultChannelInput → SpaceSettingsView`.
  `SpaceSettingsViewSchema` (`packages/contract/src/schemas.ts:1683`) is a strict 8-key object:
  `space, members, invites, taskAxes, menu, defaultChannelId, defaultInteractionProfileId,
  settingsRevision`.
- Production is correct: `set_space_default_channel` in migration 029 does
  `result := internal.w2_space_settings_view(p_space_id)` then `return internal.ledger_record(...)`,
  returning the full 8-key view in the same transaction; and
  `services/w2/menu-default-channel.ts:114` correctly enforces the schema.
- Both tests are stale at the superseded narrow 2-key ack:
  `test/db/w2-menu-default-channel.pg.test.ts:617` asserts
  `toEqual({ defaultChannelId, settingsRevision })`, and the `FakeDb` in
  `test/w2/menu-default-channel.test.ts` returns the same 2-key shape so the service correctly
  raises `upstream_unavailable`. That test's own title already agrees with production; only its
  mock does not.

The fix is scoped to the two test files, is assigned to a **fresh** session rather than the
original author, and is mandated to leave coverage **strictly greater, never looser**: the pg
slice must positively `SpaceSettingsViewSchema.parse` the RPC result, and the handler slice must
retain a separate negative proving a narrow or malformed result still raises
`upstream_unavailable`. If the reading is disprovable against the dossier the task stops for
amendment rather than changing production.

#### Honest residual accounting, mechanically derived

`test/w2/reserved-honesty.test.ts` reports `mounted=62 residual=36` and enumerates the residuals.
They reconcile exactly: G02 11 + G04 8 + G10 1 (`presence.get`) + G12 11 + G13 2 + G14 3 = **36**,
and 98 registerable − 36 = **62 implemented**; +2 reserved 501 = 100 HTTP; +1 WS = 101 catalog.

#### Environmental stop-the-line — host volume

`/System/Volumes/Data` is **100% full: ~274–283 MiB free of 460 GiB (422 GiB used)**. Each scratch
database costs ~11–14 MiB after the full 26-migration chain. This is the same condition that
exhausted a prior coordinator's parallel DB replay before assertions and forced W3 to serialize
G09. The full triage sweep came back green **only** because every PG suite ran strictly serially
with `--no-file-parallelism`; free space stayed flat at ~283 MiB across 11 consecutive PG suites,
confirming scratch databases tear down cleanly.

The full-program coordinator imposed a **single serialized DB slot, host-wide, arbitrated by the
W2 coordinator**: W2 holds the slot by default as critical path, W3 requests it and is yielded to
between group runs rather than mid-run, either coordinator escalates immediately if free space
drops below 200 MiB, and every scratch database is torn down at end of run. Every worker packet
carries the protocol, plus `--no-file-parallelism` always, one vitest process per session, a
`df` check before and after, and an abort-and-report threshold of 150 MiB.

No database was deleted by W2. `tm8_w1_w3_harness_90900_1b8229e4369c`, initially recorded as an
orphan, was a live transient W3 scratch database caught mid-sweep and tore down cleanly; the only
genuine orphan was `tm8_w1_w3_agentic_g03_probe_49854_ef7249ee1079` from the terminated G03
agentic session, dropped by W3 itself. Zero leaks on either side.

Host note for all packets: **`timeout(1)` is not installed on this host.**

#### Rolling pipeline opened at resumption

All three sessions are `claude-opus-5` xhigh via `tm_1785091987091_id0qite2j`, with provably
disjoint file ownership. No shared seam is held by two workers.

| Slot | Task | Session | Exclusive ownership |
|---|---|---|---|
| I02 tranche-v2 (G02 composition) | `task_1785092847643_s9wem7q6u` | `sess_1785092934946_otztjk9sv` | `facade/index.ts`, `facade/input-schemas.ts`, `test/w2/rolling-public.integration.test.ts` |
| G14-FIX | `task_1785092853993_uemxwsq1u` | `sess_1785093008009_s3b2snxp5` | `test/w2/menu-default-channel.test.ts`, `test/db/w2-menu-default-channel.pg.test.ts` |
| G04-AUDIT | `task_1785092866292_x7eae2y82` | `sess_1785093081198_1vaql5noa` | G04 handler/service/migration-019/pty + its two tests |

**I02 tranche-v2 is G02 only.** G02 is already frozen and re-reproduced at 12/12 pg + 4/4 handler,
and the live W3 coordinator is idle-blocked on exactly G02 and nothing else. Composing it now
follows the standing rolling-tranche override rather than stranding an independent gate behind the
remainder of W2. Predicted delta, to be replaced by measured values in the handoff: implemented
**62 → 73** (8 replacements of legacy entity/command handlers + 11 net new), residual **36 → 25**,
with the 98 ceiling, 2 reserved 501s, 1 WS row and 101 catalog rows unchanged. `entities.create`
returns 201 and `tracking.refresh` returns 202. G04/G12/G14 are excluded — composing an unfrozen
group would hand W3 a false gate.

Remaining dependency order: G04-AUDIT → X01 (depends on 019's `w2_tombstone_message`) → G12-AUDIT
→ G13 → G10/G11 (G11 carries B1 and B2) → later tranches → PUBLIC-READY handoffs to W3.

### 5.5 Resumption pipeline results — 2026-07-27

All sessions `claude-opus-5` xhigh via `tm_1785091987091_id0qite2j` (M-1 compliant; audited before first
use). Every count below was **reproduced by the coordinator independently**; a worker's own green is entry
evidence only.

#### Frozen this session

| Group | Coordinator-independent rerun | Notes |
|---|---|---|
| **G14** menu + default channel | `test/w2/menu-default-channel.test.ts` **15/15** + `test/db/w2-menu-default-channel.pg.test.ts` **12/12** = **27/27** | The two stale A03 expectations were the only red in the repository. Handler count rose 8 → 15: the `upstream_unavailable` guard is now a deliberate 7-case `it.each` instead of an accidental pass. Load-bearing citation: `db/migrations/029_w2_menu_default_channel.sql:306-310`, whose header comment reads *"Build the exact A03 response while the command still owns the Space lock."* — proving the in-transaction 8-key return is documented design intent, not drift. A `docs/` grep for the superseded 2-key shape returned nothing. |
| **G04** messages/attachments/delivery/handoffs | `test/w2/messages-handoffs.test.ts` **13/13** + `test/db/w2-messages-handoffs.pg.test.ts` **5/5** = **18/18** | All ten operations audited against the dossier. **One real defect found in code that was passing 13/13** — see below. A10 truncation disclosed as a batched amendment. |
| **I02** tranche-v2 composition (G02) | see §5.6 | G02 composed; W3 + W4 handoff issued. |

**G04's named RPC set is nine, not six** — the coordinator's packet omitted `w2_add_message_attachments`,
`w2_remove_message_attachments`, and the load-bearing `w2_claim_handoff_dispatch` (the durable pre-write
claim). All nine are enumerable SECURITY DEFINER, revoked from `public`, granted to `tm8_app` at
`019:1328-1348`. The delivery boundary remains exactly three RPCs, revoked from `public`/`tm8_app` at
`019:1352-1354` and granted only to `tm8_delivery_worker` at `019:1355-1357`. The worker corrected the
coordinator; that is recorded deliberately.

#### Defects found by audit in fully-green code

1. **G04 `handoffs.list` (A06) — order-dependent cursor fingerprint.** `enumFilter()` returned
   `[...new Set(values)]` in URL insertion order and fed that array to the fingerprint, while the SQL
   matched with `= any($2::text[])`, which is order-insensitive. Two semantically identical filters produced
   different fingerprints, so a valid page-1 cursor was rejected with `invalid_cursor`. **Aggravating and
   more important: G04 cursor coverage was ZERO** — the only prior cursor assertion was `nextCursor:null` on
   a single-row page. Fixed by canonicalising (`values.sort()`) before fingerprinting **and** feeding the
   same canonical array to the SQL so the two cannot diverge again. `enumFilter` is file-local and reachable
   only from `handoffs.list` (call sites `:503`/`:504`), so the blast radius is confined.
2. **G12 — unauthorized ledger replay (SECURITY, cross-Space disclosure).** All nine ledgered RPCs in
   migration 027 return `internal.ledger_replay(cmid, op)` **before any authorization**, and
   `ledger_replay` is keyed on the caller-supplied `cmid` **globally** — not by identity, Space, or input.
   Any authenticated caller supplying a `cmid` already used by another principal for the same operation
   receives the stored result with no membership, role, or human-principal check. For
   `interactionProfiles.propose`/`updateDraft` that stored result is the full `InteractionProfileView`
   **including `promptPolicy` and `toolDiscoveryPolicy`**, which dossier §6.4 says must never leave the
   authorized surface. `cmid`s are arbitrary caller-chosen text. **G12-only outlier:** G14's 029 authorizes
   via `w2_require_human_space_admin` before returning the replay, and the saved-views RPCs re-authorize the
   replayed row. Prior coverage: zero.
3. **G12 — no `details.reason` on any error (contract violation).** Migration 027 raises its five frozen
   reasons as bare `DETAIL` strings; `db/errors.ts parseDetail` only JSON-parses `DETAIL`, so a bare string
   falls back to `{detail: '…'}` and **no G12 error ever surfaces `details.reason`**, contradicting dossier
   §4 `ErrorDetails = {reason: string}`. `normalizeProfileError` lifts nothing and is wired into only 5 of
   11 operations — `propose` and `validate` are unwrapped. The existing handler test **enshrined the wrong
   key** by asserting `details: {detail: 'profile_referenced_default'}`.
4. **G12 A20 conflict code.** Dossier `:385` is explicit: *"A mismatch returns `conflict` with
   `details.currentRevision`."* The implementation raises `40001`, which maps to `version_conflict`.
   **Ruled a conformance defect and fixed now**, because the dossier states it outright. The dossier is
   **silent** for G14's A03, so A03 was left alone and batched — see §5.7.

#### ⛔ CONFIRMED DEFECT IN G03, WHICH HOLDS A W3 PUBLIC **AND** AGENTIC PASS

`placements.apply` with **`embed`** fails outright on the shipped chain and **destroys the user's posted
message**. Empirically confirmed by X01 against migration 020 with the X01 fix removed, on a full
26-migration fixture:

```text
AssertionError: expected { ok: false, code: '23514', …(1) } to deeply equal { ok: true }
-   "ok": true,
+   "code": "23514",
+   "messagesAfter": 0,
+   "ok": false,
```

`messagesAfter: 0` is the verdict — the **message row is absent**. 020's inverse allowlist is an
`ALTER TABLE public.undo_tokens ADD CONSTRAINT … check (operation in (…))`, enforced at **INSERT** on the
token row rather than only at dispatch. `internal.issue_undo_token` (`004:181`) INSERTs into
`undo_tokens`, and `place_entity`'s embed branch (`018:387`) calls it with `'messages.delete'` **inside
`post_message`'s transaction**; the constraint violation rolls the whole transaction back.

**The earlier characterization in this document and in W3's G03 hold — "the token is honest but
unredeemable" — is REFUTED.** The token is never inserted at all, so no unredeemable-token state is
reachable. The failure is at **placement** time, never at redemption time.

**Why five gates missed it.** `test/db/w2-edges-placements.pg.test.ts` applies only **001–015 + 018** and
**never applies 020**, so the constraint is absent from the fixture that was supposed to prove G03. No G03
or G05 fixture exercises 018 and 020 together. W3's recorded G03 PASS covers "placement normalization to a
hard `depends_on` edge" — the **non-embed** branch.

#### Named structural correction: an invalid inference this program had been running on since W1

> "Every migration applies in sequence" **plus** "each group passes against its own migration" does **NOT**
> imply "every operation works under the full chain."

Cross-migration constraint interactions live precisely in that gap. The resumed coordinator's own triage
(§5.4) cited the chain gate 2/2 as strong evidence, and it **structurally could not have caught this**.
Program-coordinator rulings now in force:

- **per-group PG fixtures are ISOLATION proofs, NOT coverage proofs.** Every W2 evidence packet must state
  which migrations its fixture applies, and no packet may cite a per-group fixture as operational coverage
  under the full chain;
- the full-chain operational vehicle already exists — W3's public harness applies every migration present
  and runs the production `bootstrap()` — so **no duplicate smoke gate is built in W2**; a W2-authored
  artifact must not start looking like coverage evidence;
- W3 gains an explicit requirement to exercise every distinct **branch** reachable from a group's
  operations, to **state which migrations its harness applied** in every verdict, and to produce a
  gap analysis of branches never exercised under the full chain.

X01 hardened its own fixture accordingly: it applies the full chain via `migrationFiles()` rather than a
hand-listed slice, with a guard test asserting the chain length, sorted official order, and the presence of
018, 019 and 020 so the fixture cannot silently narrow again. It did not touch G03's frozen fixture;
widening that is referred to the program coordinator.

#### Second named structural correction: `bun run typecheck` type-checks no test file

`packages/server/tsconfig.json` sets `"include": ["src"]`, so `tsc -b` never sees `test/**`, and vitest
transpiles without type-checking. **Therefore "root typecheck green" in every evidence packet this program
has produced — W1's, I01's, and §5.4 of this document — was overstated as to tests.** It is not theoretical:
a separate check against `tsconfig.base.json` caught a real `TS2322` in new test code that both vitest and
`bun run typecheck` passed over. Every packet now requires a separate test-file typecheck reported as its
own named result. Widening the tsconfig `include` is deliberately **deferred** to its own scoped task gated
after G3, because it would drop every pre-existing test file under `tsc -b` at once and could produce a
large surprise red across frozen, W3-gated work.

#### Method adopted program-wide: two honest substitutes for an unobtainable red

When a law already holds and a production red cannot be obtained without breaking production, a worker must
either **mutation-test** the production line (break it, show the new test fails, revert, and *verify* the
revert) or **probe-red** its own assertion (feed it the input that should pass while still asserting
failure, showing it fails, which proves the assertion discriminates) — and must **label which was used**.
Manufacturing a fake red is rejected. Reference examples: G04 declined to fake a red when three of four
cursor cases passed on arrival and mutation-tested instead; G14 could not obtain a production red at all and
labelled its probe red honestly rather than dressing it as a production red.

### 5.6 Tranche-v2 PUBLIC-READY — coordinator-verified, handed to W3 and W4

Declared to both the W3 coordinator (`sess_1785092163476_4on0tyohq`, gating consumer) and the W4
coordinator (`sess_1785093404712_3h87437sp`, coverage-widening consumer) under amendment M-2.

**Measured from a real production `bootstrap()` listener** — not predicted, not the worker's number:

```text
{"ok":true,"server":"tm8-server","contractVersion":"0.1.0","operations":100,"implemented":73}
```

`registry.size` 73; residual derived live from `V1_OPERATIONS` minus the live registry = **25** (not a
literal); refusals **27**; `73 + 25 = 98` = the registerable ceiling. Unchanged: 98 ceiling, 2 reserved
forever-501, 1 WS row, 101 catalog rows. Corroborated four ways, three by detectors the composing worker
did not author: the live listener; G15's `test/w2/reserved-honesty.test.ts` run **unmodified**, printing
`mounted=73 residual=25` at 6/6 in the coordinator's own run; C01's AST inventory; and the catalog
decomposition.

Coordinator-independent reruns: `rolling-public.integration` **9/9**; broad `packages/server` excluding
`test/w3`, serialized — **48 files passed / 6 skipped; 414 passed / 64 skipped / 0 FAILED**; contract
**42/42**; conformance **14/14** with `check:generated` EXIT 0; `build:server` and `typecheck` EXIT 0;
full chain **2/2**.

```text
e46a4cc5c6f55f10f5feeb07f692a8835653977de46787268b4fbe6e09d44998  facade/index.ts          ROTATED (was 58ff8b7f…df76)
6497175ede77adcabb00ee5d6fb308213f735535e2bb8a90d229d63bf61bf5d4  facade/input-schemas.ts  ROTATED (was 8d4627fb…140e)
33a0deef882b180b215d0290a15c79d8565cc20356de99b18d6070fb1dfc449a  main.ts                  UNCHANGED = frozen I01
b949b5f8a0865e3df570b32020683bb14b1f4e0f2be47eb5ebb9cb9dd1939714  http/config.ts           UNCHANGED = frozen I01
b7ffc54abeba9afc17e553aa42e5b772343baf734ed033e687f072ce1c8043e5  http/server.ts           UNCHANGED = frozen I01
b8c927e98c8de67ae868ab9bd2363cb7d088fa04509b4fd17f1562c8cca0274d  test/w2/rolling-public.integration.test.ts
c4f4536f19f724b9a991cedf773ecfc386ebb8d04bbab28b0aad82867bf287de  tools/conformance/test/foundation/w1-foundations.test.ts
```

The three unchanged transport/composition-root seams reproducing byte-for-byte **is itself the proof** that
no second non-catalog transport, no generic pre-body mutation hook, and no discovery/help/manifest route was
added — those files were never opened. The W1 generated manifest did **not** rotate:
`062ec620b8f9be87bc0a96f3bb30e900d0befff540b37e2ddc3ff418c3b9ce5a`, 124718 bytes.

**Composition:** tranche-v1 seven + **G02** = G01, G02, G03, G05, G06, G07, G08, G09. **G04, G12 and G14
remain deliberately uncomposed** — verified by zero references to `messages-handoffs`,
`entity-kinds-profiles` or `menu-default-channel` in `facade/index.ts`, and exactly 8 `registerW2*` seams.

**Replacement, not duplicate registration — structurally guaranteed.** `HandlerRegistry.register()`
(`facade/registry.ts:49`) throws on a duplicate name, so the eight legacy inline registrations had to be
**deleted** for the server to boot at all; a merge could not have shipped. `implemented` rose **62 → 73 =
exactly +11**. Of the eight replaced names, `entities.points.add`, `entities.commands.work` and
`entities.commands.complete` re-export the **same** legacy factories byte-identically, so only
`entities.get`, `entities.create`, `entities.patch`, `entities.children` and `entities.activity` are
genuinely new implementations of an already-passed surface — which is where the regression risk actually is,
and where W3's behavioural sweep was directed.

**Two invariants proven with non-vacuousness arguments**, both requested by W3: all 27 refusing operations
return `501` for a deliberately invalid body, **non-vacuous** because the identical body returns
`400 invalid_input` against five freshly composed G02 operations (structurally, `http/server.ts:163-167`
throws `notImplemented` before reading `INPUT_SCHEMAS`); and a refused `501` plus a failed `404`, each with
a fresh real `clientMutationId`, produced zero `command_ledger` rows and unchanged entity/edge/ledger
totals — deliberately covering both a refusal that never reaches a handler and one that reaches it, opens a
transaction, and aborts inside it.

**C01 drift-detector baseline** was updated under four constraints: literals stayed **exact and brittle**
(a range or a live-computed value would have permanently killed the detector that had just caught the
change), the historical 28/36/13 snapshot and the frozen manifest were untouched, the handler-list SHA was
**recomputed** rather than hand-edited (`4d45ae29…` → `47f96949…`), and the before/after table was written
into the file as a comment so the tranche-v1 boundary is recoverable from source and not only from this
ledger. Conformance recovered 13/14 → **14/14**.

**A public-surface change requiring deliberate assertion:** `entities.delete` and `entities.restore` are now
bound to `RequiredCommandContextSchema`, so a body-less `DELETE /v2/entities/:id` is **`400 invalid_input`,
not a silent success**. This is the established treatment for every catalog row the matrices mark `unbound`
and matches G02's own frozen suite, but it is a real decision. W4 recorded it as a CLI binding requirement,
since a naively generated CLI emits DELETE with no body.

**Verdict binding.** A public verdict is bound to the composition it was measured against, identified by the
shared-seam SHA-256 set. A rotation does not make a prior verdict *wrong* — it makes it a statement about a
**superseded** composition. `facade/index.ts` rotating therefore unbound all eight verdicts W3 held (the
seven tranche-v1 groups plus G15), and W3 re-ran its eight-group regression sweep and re-recorded hashes
**before** gating G02. W2 carries the mirror obligation: every handoff leads with the measured seam set and
explicitly flags which prior verdicts a rotation unbinds.

### 5.7 Open amendment batch (G0.2) and other holds

Dossier edits rotate `TM8-W0-AMENDMENT-DOSSIER.md`'s hash and require a fresh narrow Opus gate per the
masthead rule, so amendment candidates are **collected into one revision and gated together** as G0.2
rather than one gate per field. Nothing below may be implemented until that batch is closed. Affected
groups stay frozen with the item disclosed, and W3 tests **current** behaviour, not amended behaviour.

| # | Item | Disposition |
|---|---|---|
| 1 | **A10 `messages.delivery.get` silent truncation.** `MessageDeliveryQuery` accepts `cursor` + `limit` (frozen, W1-gated, strict), but `MessageDeliveryViewSchema` is a bespoke `{message, deliveries[]}` that neither uses the canonical `pageOf<T>()` idiom nor carries `nextCursor`, and the SQL selects `limit N` not N+1. So it truncates at 50 (max 100) and the cursor is **unreachable by construction**. Dossier §3 names the DTO pair but §4 never defines the view's fields. | **Ruled option (a):** add `nextCursor: CursorSchema.nullable()` alongside `deliveries` — do **not** restructure into `pageOf()` — and move the SQL to N+1. Removing the frozen input fields was rejected as the strictly larger amendment; accepting it as-is was rejected as the dishonest surface this wave has been eliminating. |
| 2 | **`unreadTotal` frozen into a replay snapshot.** `internal.w2_space_settings_view` computes `space.unreadTotal` **per-viewer** via `internal.identity_id()`, but the whole projection is frozen into `command_ledger` so a replay is byte-identical. A replay by a *different* owner/admin therefore returns the **first** caller's unread count. `029:307` justifies freezing membership, invites, axes, menu and profile defaults — all Space-relative; `unreadTotal` is the single viewer-relative field and is not mentioned. | Real, **low severity** (requires an owner/admin replaying another owner/admin's `clientMutationId` in the same Space; discloses one integer between two already-privileged principals). Amendment prep requires an **inventory** of every other frozen ledger projection for viewer-relative fields, so the amendment can state a general law if the pattern recurs rather than patching one instance. |
| 3 | **A03 revision-mismatch error code.** Dossier `:385` explicitly requires `conflict` for **A20**; the default-channel paragraph `:300` is **silent** for **A03**, whose implementation yields `version_conflict` by the same `40001` mechanism. | A20 fixed now as a conformance defect. **A03 left untouched and batched** — G14 is frozen, and making it match would normalize an unlisted difference. Only the program coordinator can reopen a frozen group. |
| 4 | **`profile_principal_required` reused for a missing `confirmAgentGenerated`.** Dossier `:238` defines that reason as *"attempted by agent/act-as"*; `:383` mandates the confirmation but **names no error** for its absence, and no other frozen reason fits a human admin who simply omitted it. | Batched. Behaviour unchanged; reported rather than invented. |

Non-amendment holds: **X01** changes `db/migrations/020`, a file G03's and G05's verdicts were measured
against, so both need rebinding and G03 needs a fresh retest of the **embed path specifically**. G02's
provider queue consumer for `tracking.refresh` is a later owner — 202-accepted-and-queued is the frozen
contract, not a stub. `tools/conformance/test/w2-reserved-honesty.test.ts` sits outside the conformance
vitest include (`./test/foundation/**`) and so is not in the 14/14 gate; it may carry stale tranche-v1
literals and should not be brought in casually. `messages.list` is implemented outside G04's ownership, so
G04's `CONFORMS` for it is recorded as an **audit opinion, not freeze evidence**.

Two coordinator rulings recorded rather than escalated, both affirmed by the program coordinator:
`handoffs.list` returning an **empty page** rather than `not_found` for an unreadable or nonexistent work
session is correct non-leaking behaviour — RLS at `019:1310-1313` makes absence indistinguishable from
emptiness, and `not_found` would confirm existence to an unauthorized caller; and new G13 migrations take
the **next number above the highest existing file (030)** rather than backfilling the unused `025`/`026`/
`028` gaps, because the runner applies migrations in lexical order and a backfilled number would be an
out-of-order insert against any ledger that has already applied 027/029.

### 5.8 Environment record

The host volume reached **100% capacity (274–283 MiB free of 460 GiB)** during triage — the same condition
that had already exhausted a prior coordinator's parallel DB replay before assertions and forced W3 to
serialize G09. Triage came back green only because every PG suite ran strictly serially with
`--no-file-parallelism`; free space stayed flat across 11 consecutive suites, confirming scratch databases
tear down cleanly. The program coordinator then reclaimed ~13 GiB of regenerable caches under explicit user
authorization, and the single-serialized-DB-slot regime was withdrawn at **12 GiB free**. Retained as
standing hygiene regardless of headroom: `--no-file-parallelism` always, one vitest process per session,
tear down every scratch database, `df` before and after, abort-and-report below 150 MiB, escalate below
200 MiB, and announce DB-backed runs across coordinators so no one misreads another's transient scratch
database as a leak. No W2 session deleted any database. Host note: **`timeout(1)` is not installed.**

## 6. Integration gate checklist

- [ ] all 15 complete operation sets implemented;
- [ ] exact catalog/router/input-schema/help parity;
- [ ] 98 registered v1 HTTP handlers; zero unimplemented v1 HTTP operations;
- [ ] exactly two reserved HTTP routes remain non-registerable/honest 501;
- [ ] single WS operation delivers authorized durable events and replay/reconnect reconciles with storage;
- [ ] public HTTP and WS behavior exercised with database-observable effects;
- [ ] B1 zero-queue/zero-byte negatives and internal pre-reserved positive;
- [ ] B2 top-level/reply concurrency, fifth attempt, Member reset, retry, restart, and cleanup;
- [ ] message batch/attachment/handoff/profile/project/feed/menu/inbox invariants;
- [ ] FileUploadGrant raw PUT is capability-bound, data-dir-contained, absent from catalog/help/action discovery, and the only non-catalog support transport (never a generic public mutation seam);
- [ ] migration runner from empty and current supported state;
- [ ] contract, conformance, root typecheck/build, Server, execution, DB, and live API suites green;
- [ ] environmental exclusions recorded honestly;
- [ ] independent W2 verification complete;
- [ ] rolling W3 real production-Server public PASS recorded before agentic verification.

## 7. Final evidence

Pending integration, independent verification, corrections, and G2.

---

## 8. Tranche-v3 composition and the SEC-1 batch landing — 2026-07-27, closure coordinator `sess_1785111933513_162e35vc8`

### 8.1 Tranche-v3 PUBLIC-READY — composed, measured, handed to W3 and W4

The composition brake was lifted unconditionally by user direction (M-5). SEC-1 became a documented
pre-ship blocker rather than a compose gate; the confusion was reading *"must be fixed before anything
ships"* as *"must be fixed before anything composes"*, which are different gates and only the first is real.

**Composed:** G04 messages/attachments/delivery/handoffs, G12 entity kinds + Interaction Profiles,
G13 universal feed/context/activity, G14 menu + default channel.

**Measured from a real production `bootstrap()` listener — not predicted:**

```text
/health                        {"operations":100,"implemented":97}
reserved-honesty.test.ts       mounted=97 residual=1 [presence.get]   (unmodified, independent detector)
test/w2/ full suite            157/157 pass, including the DB-backed production block
```

Previous state was `mounted=73 residual=25`. **Read 97 as REGISTERED, never as implemented** — `/health`'s
`implemented` field reports `registry.size`, i.e. mounted handlers.

**Transport seams byte-identical, and that is itself the proof** that no second non-catalog transport, no
generic pre-body mutation hook and no discovery/help/manifest route was added — those files were never opened:

```text
33a0deef882b180b215d0290a15c79d8565cc20356de99b18d6070fb1dfc449a  main.ts
b949b5f8a0865e3df570b32020683bb14b1f4e0f2be47eb5ebb9cb9dd1939714  http/config.ts
b7ffc54abeba9afc17e553aa42e5b772343baf734ed033e687f072ce1c8043e5  http/server.ts
```

`messages.list` is the **same `messagesList(deps)` reader in both paths** — behaviour-preserving by
construction, not by assertion. `messages.post` is the one operation whose behaviour **changes** rather than
begins; it was an unconditional 501 stub at `handlers/messages.ts:175-182`.

**Knowingly accepted risk, recorded at full strength rather than downgraded:** composing G04 activates
`clientMutationId` publication through composed read paths (`entity-read.ts:583` projects `messageBatchId`;
only G04's `019` populates it). This was accepted because the node is undeployed with a single loopback
identity — and it has since been **measured true**, see §8.4.

### 8.2 The SEC-1 batch — landed, after one reverted attempt

```text
chain 31 files, digest 7e42a0d58f7b555d      (was 28 / 8c5227dfe17923c2)
032_w2_sec1_stage1b_replay_resource_binding.sql   74cc4e34f571e991329e04f3ec667147f44f3d2b2458d08cf82b26a8f15e210b
033_w2_sec1b_ledger_replay_principal_pin.sql      3ee5e0363bd7151b18451be1e99c66ae3763c98971cd3ef3a0fe4b0f6996aba5
034_w2_g02fix_tracking_refresh_actor_binding.sql  ddfa9821faa44141cc95784a5f6c07c232bbe6e2d59f5ffa416f0b3bf17f8641
```

Gate results, run **inside the landing window, before announcing**:
`w2-migration-order.pg.test.ts` **2/2** (full chain from empty, idempotent, 001–015 upgrade path);
`w2-entities-commands-tracking.pg.test.ts` **24/24** — the four `tracking.refresh` multi-Space 403 reds are gone.

**032** binds principal *and* addressed resource at seven sites — `create_invite` 007:573,
`revoke_invite` 007:596, `w2_revoke_invite` 016:330, `update_project_w2` 021:214, `w2_edit_message` 019:501,
`w2_tombstone_message` 019:627, `post_message` 007:1680 — plus **strip-at-rest** and
**rehydrate-after-binding** at the three invite sites, so the live invite code is no longer stored in
`command_ledger` and a replay re-reads the live row *after* the guard has already refused a stranger.

**033** moves the principal comparison **inside `internal.ledger_replay`**, after the SELECT, under the
already-held advisory lock — closing **92** previously unpinned call sites at once, and removing the `23514`
oracle that interpolated the caller's cmid and the true owner's operation label onto the wire.

**Deliberately excluded:** `w2_post_message_batch` (019:343) self-guards via a hash over
`internal.identity_id()` plus the request canonicalization, binding both halves on its own path.

### 8.3 The first landing attempt failed — and the failure was predicted in writing

`033` was the **only** migration in the repository with `set role tm8_graph_owner` and no matching
`reset role`, so `db/migrate.mjs` could not record into `public.applied_migrations` afterwards and the whole
transaction rolled back. Reverted within minutes; tree restored byte-identical and re-gated green.

**It had been called in advance.** W3's sufficiency review of `033`'s own acceptance suite listed as gap (c):
*"the candidate is applied via `database.query(sql)` on a pool connection, whereas the real chain is applied
via psql … the candidate is NOT APPLIED THE WAY THE CANDIDATE WILL SHIP."* The coordinator read it, filed it
as a minor note among more alarming items, and did not action it.

**New failure mode, distinct from single-source propagation and false corroboration:** *not a false claim
believed, but a **true claim correctly filed and never converted into an action**.* The mechanism is triage
order — **delivery defects always look low-severity**, because they say nothing about behaviour, right up
until they roll back the transaction. **A gap describing a difference between how a thing is TESTED and how
it will SHIP is never a minor note.**

**Adopted rule:** *verifying the artifact is not verifying the artifact's **delivery**.* Every migration
candidate is now proven through `db/migrate.mjs` itself before handoff. The applier is a third thing, and
nobody was testing it. This program had already learned it once — W1.B2 exists because `015` attempted ACL
cleanup while still elevated — and the rule decayed. **Rules decay; detectors do not.**

**Detector built and wired into the same gate:** a static *never-left-elevated* state machine over
`db/migrations`. Two traps found by building it that no specification anticipated — the string `reset role`
**contains** `set role`, so a naive count reports all 31 files unbalanced; and set/reset inside dollar-quoted
bodies, comments and string literals are not statements. `set local role` is deliberately excluded as
transaction-scoped. Validated **red** on `033`-as-it-was, **green** on `033`-fixed and on all 31 landed files
including `015` (which legitimately carries `set=1 reset=2`).

### 8.4 Findings that survive this wave as permanent record

- **A `clientMutationId` IS harvestable — measured, not inferred**, through five composed read routes:
  `entities.get` on a message, `messages.list`, `entities.feed`, `entities.context`, `collections.query`.
  Two of those did not exist before this tranche. The severity reduction that rested on non-harvestability is
  **falsified by measurement**. *"Reachable but not self-serving" is retired phrasing.*
- **Cursor timestamp truncation is a class, not an incident.** `timestamptz` holds microseconds; node-pg
  parses to a JS `Date` holding milliseconds. **Direction determines severity:** ASC keysets re-admit the
  boundary row and **loop** (loud); DESC keysets **silently skip** every row sharing the truncated
  millisecond. Rows written in one transaction share an identical `now()`, so **batch-written rows cluster in
  exactly the dropped window**. The correct idiom (`to_char(… 'US"Z"')`) already existed in the codebase,
  applied to three sites and missed on eight.
- **Sequential fixtures cannot detect it.** A symptom test walked over a proven-defective site and reported
  green. **Mechanism assertion primary, symptom assertion secondary.**
- **`015:1497` still writes an unauthenticated ledger row.** `033` closed the *replay*, not the *record*: an
  unbound `tm8_app` caller still commits a `command_ledger` row with `identity_id` NULL through
  `reset_session_wake_budget_for_member_reply`. Disclosure closed; the write is open. Reduced severity, not fixed.
- **No independent executable race harness was ever built.** `033`'s race-correctness rests on its author's
  own two-connection test plus a read-only adversarial sufficiency review. The harness was stood down to buy
  the tranche-v3 composition — a trade recorded here as a **trade**, because a trade recorded only as its
  benefit is not a recorded trade. With no W5, this is **permanent**, not deferred.
- **"94 of 97 sites gated" is a verified LOWER BOUND**, not a proven count — single-reader, with two of its
  three original candidates already disproved as false positives. Its second reader was deferred to a wave
  that no longer exists. Also **permanent**.

### 8.5 ⚠ ERRATUM — TWO FALSE CLAIMS IN DELIVERED WORK, AND ONE DOWNGRADED CLAIM

Recorded **before** any remediation, deliberately. *A record that waits for the fix to tell the truth
lies for exactly as long as the fix is pending* — and with no W5, that could be permanently.

#### 8.5.1 `031` and `032` claim two bindings they do not have

Migrations `031` and `032` are recorded above as binding `spaces.update` and `projects.update`.
**They do not.** Measured from live `pg_catalog` on the applied chain:

| Label | Bound door | **Granted, UNBOUND sibling** | Status |
|---|---|---|---|
| `spaces.update` | `w2_update_space` (bound by `031`) | **`public.update_space`** (007) — granted to `tm8_app`, bare `return replay`, stores its result verbatim | **LIVE bypass** |
| `projects.update` | `update_project_w2` (bound by `032`) | **`public.update_project`** (007) — granted to `tm8_app`, bare `return replay`, stores `to_jsonb(project)` | **LIVE bypass** |

`internal.ledger_replay` keys on **cmid + operation label** and cannot tell which function called it, so a
row recorded through the bound door is replayable through the unbound sibling. **Both siblings are
granted**, which makes these **live**, not latent — the distinction that separates them from
`post_message`, which is latent precisely because `tm8_app` *cannot* execute it.

**These are false claims in delivered work, not undiscovered scope.** The distinction that governs the
repair boundary: **we fix what we falsely claimed; we do not fix what we merely failed to claim.** That set
is closed by construction and cannot creep.

#### 8.5.2 `entities.create` is eleven doors, not one function

`create_task`, `create_channel`, `create_collection`, `create_document`, `create_team_member`,
`create_file_entity`, `create_spell_entity`, `create_skill_entity`, `create_pull_request_entity`,
`create_commit_entity`, `create_custom_entity` — **all eleven granted, all with a bare `return replay`, all
storing a resource-bearing projection.**

**Binding only the door XG03 drives would make XG03 go green while the defect remained fully open**,
converting the acceptance criterion into a false negative. *A fix that makes the test lie is worse than no
fix* — it destroys the instrument that would have detected the defect, and with no W5 that instrument is
the last one pointed at it.

Full measured picture: **63 distinct labels across 98 live callers; 16 are collisions; 12 of the 16 have
more than one granted door.** Protection tally: **82 unbound (79 granted), 13 bound, 3 self-guarded.**

#### 8.5.3 The race claim is UNPROVEN, not proven-pending-tightening

The parked-attacker assertion in **both** the landed `031` suite (`:466-467`, `:661`) **and** the `033`
suite is an unscoped, cluster-wide

```sql
select count(*) from pg_locks where locktype='advisory' and not granted
```

— **no pid predicate, no lock-key predicate, no database filter**, while a parallel wave runs on the same
host. Any ungranted advisory lock held by any connection to any database satisfies it.

**It cannot produce a false green of the security property, but it CAN produce a false claim of race
coverage** — satisfied on iteration zero by a foreign lock, then committing before the attacker reaches
`ledger_replay`, passing as a sequential test wearing a concurrency label. Do not flatten this into "the
test was broken"; it was not.

**Both halves of the permanent-gap entry are recorded together, because either alone misleads:** the
independent race harness **was never built**, *and* the assertion the existing suites use to claim race
coverage **was unscoped**. A reader seeing only the first thinks the suites cover it; a reader seeing only
the second thinks a harness will catch what they miss.

#### 8.5.4 The class these three share

**A condition satisfiable by something other than the thing it is checking for.** Three instances in one
day: a lint that would fire on every file (because `reset role` contains `set role`); an exactly-once
assertion that walked over a proven-defective site on a sequential fixture; and a synchronization barrier
satisfiable by unrelated noise. Every gate should sweep its own barriers for this shape.

And the governance instance: **a correct ruling on one label was never asked whether it generalised.**
`spaces.invites.revoke` is the *only* two-door label where **both** doors are bound — because the unrouted
sibling was deliberately ruled in on the grounds that *"unreachable today is a statement about today."*
The same ruling applied twice more would have closed both defects in §8.5.1. *A defect found in one group
is evidence about a class, not an incident* — written as a rule earlier the same day, then instantiated.

---

## 9. Closure record — 2026-07-27

### 9.1 What landed

```
chain 34 files · recipe: (cd db/migrations && shasum -a 256 *.sql | shasum -a 256 | cut -c1-16)
                 MEASURE IT. A digest written in a document is stale on the day it is read;
                 this one moved five times in the program's final hours.
032  SEC-1 Stage 1b — resource binding + strip-at-rest + rehydrate-after-binding at 3 invite sites
033  the shared replay principal pin inside internal.ledger_replay — 92 unpinned sites, fail-closed
     on the NULL cases, which were PROVEN REACHABLE before it was authored
034  tracking.refresh multi-Space 403 — actor binding poisoning later loop iterations
035  space_event_seq — grant AND policy, because a bare grant is worse than the defect
036  entities.create resource binding at ELEVEN doors + 2 repairs of bypassable bindings
037  absent-means-merge (set_work_state, w2_edit_message) + unauthenticated ledger write + claim_text
```

Every landing gated **before** announcing. Two failed and were reverted inside their window.

### 9.2 The class this wave actually found

**A CONDITION SATISFIABLE BY SOMETHING OTHER THAN THE THING IT IS CHECKING FOR.** Confirmed instances,
all measured, all found within one day:

- A lint that would fire on **every** file, because `reset role` contains `set role` — and it would have
  passed its mutation test perfectly. **A mutation test proves a detector RESPONDS; only a negative
  control proves it DISCRIMINATES.**
- An exactly-once paging assertion that **walked over a proven-defective site and reported green**,
  because the defect needs two rows sharing a millisecond. **Sequential fixtures report clean green
  across every defective paging site.**
- A `pg_locks` barrier satisfiable by any unrelated lock on the host. Could not fake the security
  property; **could fake race coverage.** Tightened, re-run, and **the claim survived** — evidence that
  was *under-evidenced, not wrong*.
- An assertion that became a **tautology exactly when its own trigger fired** — it compared a value to
  itself once the condition it watched for arrived.
- A guard whose **textual proxy** (`contains set_config AND contains tm8.`) diverged from the property
  it stood for.

### 9.3 Three disguises of one defect, and why each instrument missed it

Cursor timestamp truncation, found and closed at every reachable site:

| disguise | where the damage happens | why the obvious check missed it |
|---|---|---|
| direct | at the encode site | none — this one was findable |
| downstream | a correct SQL fix undone by a helper after it | the SELECT looks right |
| **inherited through a DTO** | **upstream of an innocent encode site** | **the file *had* adopted the fix, three times** |

**Direction decides severity.** Ascending keysets re-admit the boundary row and **loop** — loud.
Descending keysets **silently skip** every row sharing the truncated millisecond. Rows written in one
transaction share an identical `now()`, so **batch-written rows cluster in exactly the dropped window.**
Demonstrated concretely: a mutated site returned **1 of 6 rows, exit 0, no error.**

### 9.4 Governance failures, recorded because they cost more than the code

- **A descope survives the re-scope.** Removal is explicit and written down; restoration is one word.
- **An item held in two states because its two statements had different audiences.** Nobody saw both.
- **A destructive instruction framed as a measurement instruction** — "reap X *and report the count*" —
  read as instrumentation and executed as deletion.
- **"Is it safe" and "is it lossy" are different questions.** The first is checkable in seconds; the
  second requires knowing what you have. Only the first was asked.
- **A true number in a misleading frame.** A correct database count, printed beside orphan discussion,
  nearly authorised deleting the dev database.

**Every coordinator figure that was challenged today fell — fourteen of them.** Every one fell to
somebody opening the file. **The errors that survived longest were never wrong numbers; they were correct
measurements carrying a scope wider than their mechanism supported.**

### 9.5 What is open, stated as open

- **A migration can create a distinction the layer above it cannot express.** Both of `037`'s residuals
  share this root. The audit is driven **from the lower layer** — find where storage distinguishes absent
  from null, then check whether the handler can express it. *Not* a sweep of every `??`.
- **`internal.require_delivery_principal` accepts an assumed role.** `session_user <> X AND
  current_setting('role') <> X` raises only if **both** limbs fail, so a superuser satisfies it by
  assuming the role. A startup assertion mitigates one wiring; **the defect is open for every other
  client.** Tightening it turns two existing suites red — they pass *because of* the hole.
- **No independent executable race harness was ever built**, and the assertion the suites use to claim
  race coverage was unscoped until today. Both halves must be read together.
- **64 tests skipped since W1.** Count stable across every landing; **no session ever established what
  any of them are gated on.**
- **A restatement has no owner.** The original moves, the copy does not, and nothing in the copy records
  what it was copied *from*. Tests have mechanisms that go red; **prose has none.** Partial countermeasure,
  derived from today rather than invented: **a restatement carrying a `file:line` is checkable in seconds
  by anyone who doubts it.** Not a solution.
