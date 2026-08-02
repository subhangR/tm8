# tm8 W1 Preflight and Integration Evidence

**Wave:** W1 — Contract, migration, and conformance foundation  
**Task:** `task_1785034451482_ujym6xiwd`  
**Coordinator:** `sess_1785038664819_e197jz26l`  
**Started:** 2026-07-26  
**Status:** W1 complete; G1 user-waived/authorized after the official migration-runner repair and required green integration suite  
**Scope law:** W1 may implement only the G0-bound amendment dossier. This artifact is new W1 evidence; it does not edit or replace either G0-bound file.

## 1. Entry gate and authority integrity

The original G0 APPROVE bound the following hashes, recomputed before the first W1 source edit:

```text
b852e62bf6da09aaa9adb65e21c80362082c083db77b87ea829d27f0a1e5c278  docs/history/program-w0-w5/W0-AMENDMENT-DOSSIER.md
fa2c304a5ee24ee7c5d9eb47e157c38eb8d5aa6145b8a4a99046ae0a21f11c60  docs/history/program-w0-w5/W0-CONSISTENCY-MATRICES.md
```

The launch packet cites `docs/architecture/03-DATA-MODEL.md`, which is absent. The repository's actual numbered architecture file is `docs/architecture/03-ENTITY-GRAPH-DELTAS.md`; W1 treats that file as the intended reference and records the filename correction here rather than inventing a missing authority.

W1 then stopped at a safe boundary when the migration stream found two literal dossier contradictions. W0-E resolved them through a narrow amendment, and fresh evidence-only Claude Opus 5 session `sess_1785040472762_0wsb78pdj` returned **APPROVE with 0 blockers and 0 majors**. The G0.1 binding set, independently recomputed before W1 resumed, is:

```text
b85a18304f3769ba88da67403a7d90331a17c6355df7b451d650b49990434805  docs/history/program-w0-w5/W0-AMENDMENT-DOSSIER.md
fa2c304a5ee24ee7c5d9eb47e157c38eb8d5aa6145b8a4a99046ae0a21f11c60  docs/history/program-w0-w5/W0-CONSISTENCY-MATRICES.md
b4f11818bcc9fc623392d1d7492f4b773c4b884d9b8452bc9166af53e704ce4f  docs/history/program-w0-w5/W0-GATE-REPORT.md
f26ad659a550ac50214699da6fb68388de54e69d8694421af9188b3e633c342b  docs/history/program-w0-w5/W0-W5-HANDOFF-STATE.md
b3d54cac1d86a2fe3151d6a9d997499f7c62a058852244a986cbab6f4c29ab9e  docs/history/program-w0-w5/FINAL-DESIGN-SET.md
7b58ae16fa8080f572f7577af020461f7231b4ab51ac83b9e25edc09d6914148  docs/history/program-w0-w5/W0-G0.1-AMENDMENT-REPORT.md
```

## 2. Source-derived shipped operation matrix

The coordinator parsed `packages/contract/src/catalog.ts`, `packages/server/src/facade/index.ts`, `packages/server/src/facade/execution-handlers.ts`, `packages/server/src/events/handlers.ts`, and `packages/server/src/facade/input-schemas.ts` before edits.

| Measure | Current source result |
|---|---:|
| Catalog rows | 81 |
| Status | 79 `v1`, 2 `reserved` |
| Methods | 31 GET, 32 POST, 8 PATCH, 6 DELETE, 3 PUT, 1 WS |
| Operation kinds | 33 read, 47 command, 1 stream |
| HTTP / WS | 80 / 1 |
| Registerable HTTP ceiling | 78 |
| Semantic HTTP handlers | 28 = 23 facade + 4 execution + 1 event poll |
| Input-schema bindings | 36 |
| Explicitly unbound commands | 13 |

The 13 source-derived unbound command names are:

```text
spaces.invites.create
spaces.invites.revoke
spaces.invites.redeem
spaces.taskAxes.delete
entities.delete
entities.restore
edges.delete
messages.delete
commands.undo
projects.unlink
inbox.markRead
readMarks.upsert
savedViews.delete
```

This is the W1 source-derived correction for G0 matrix row 47: `messages.delete` is unbound in the shipped source. The G0-bound matrix is not edited.

The 28 source-derived handler names are exactly:

- facade (23): `identity.get`, `spaces.list`, `spaces.create`, `spaces.get`, `spaces.home`, `spaces.navigation`, `projects.list`, `projects.create`, `projects.get`, `projects.update`, `projects.link`, `entities.get`, `entities.create`, `entities.patch`, `entities.children`, `entities.activity`, `entities.points.add`, `edges.create`, `collections.query`, `messages.list`, `messages.post`, `entities.commands.work`, `entities.commands.complete`;
- execution (4): `execution.spawn`, `execution.prompt`, `execution.terminate`, `execution.streams.attach`;
- events (1): `events.poll`.

`events.subscribe` remains the single WS skeleton. `search.query` and `bridge.fetchBlob` remain reserved and must stay honestly unavailable.

## 3. Source-derived shipped kind and migration matrix

`CoreEntityKindSchema` and the `001_core_graph.sql` global core seed are an exact 13-row bijection:

```text
channel, task, message, member, team_member, doc, file, spell, skill,
pull_request, commit, work_session, collection
```

The custom-kind arm remains `c:{name}`. `ui_template` remains a negative sentinel and must never enter the entity-kind registry.

The migration parser found 43 product `CREATE TABLE` statements, all in the shipped baseline:

| Migration | Tables |
|---|---:|
| `001_core_graph.sql` | 21 |
| `002_identity.sql` | 6 |
| `003_read_model.sql` | 7 |
| `004_ledgers.sql` | 3 |
| `005_custom_kinds.sql` | 1 |
| `006_execution_side.sql` | 5 |
| `007`–`014` | 0 new tables |

`applied_migrations` is runner bookkeeping and is not included. W1 therefore has exactly one legal forward-migration slot after `014`; shipped migration history is immutable.

## 4. Closed W1 delta allowlist

### 4.1 Additive operation names

The only additive operation names are A01–A20, in this exact order:

```text
spaces.menu.get
spaces.menu.update
spaces.defaultChannel.set
projects.associations.correct
handoffs.send
handoffs.list
handoffs.withdraw
messages.attachments.add
messages.attachments.remove
messages.delivery.get
entities.feed
entities.context
interactionProfiles.propose
interactionProfiles.updateDraft
interactionProfiles.validate
interactionProfiles.preview
interactionProfiles.activate
interactionProfiles.retire
teamMembers.interactionProfile.setDefault
spaces.interactionProfile.setDefault
```

After and only after these source rows land, the target accounting is 101. A16 is `POST /v2/interaction-profiles/:profileId/preview` with operation kind `read`; the stray word `read` in the G0 matrix binding cell is not part of the route. This artifact carries that W1 metadata correction without modifying the G0-bound matrix.

### 4.2 Frozen-row amendments

W1 may change only the following existing operation shapes/exposure metadata:

- `messages.post`: atomic `anchorIds`, optional `parentMessageId`, mention/file IDs, `MessageBatchResult`, deprecated singular `anchorId` input normalization;
- `messages.edit` and `messages.delete`: required `expectedVersion`;
- `entities.create`: repeatable atomic initial `connections`;
- `entities.connections`: flat typed filtered/sorted `Page<EdgeView>` with fingerprinted cursor;
- `files.uploadComplete`: finalized atomic `attached_to` targets;
- `execution.spawn`: `workdir`, `confirmUntrusted`, optional active `interactionProfileId`; existing optional `projectId` is not a new delta;
- `execution.prompt`: unchanged input, internal exposure metadata only; W2 owns the handler guard;
- `entities.commands.linkPr` and `entities.commands.linkCommit`: optional explicit `projectId`;
- `inbox.list` and `inbox.markRead`: discriminated Member/Teammate recipient and owner-inspection shape;
- `actions.list`: operation/target/version/epoch/authorization/exposure/help discovery metadata;
- `events.subscribe`: honest WS-skeleton status; no durable semantic-delivery claim in W1.

The DTO/Zod/error/event/kind changes are limited to the exact shapes and closed reason/event sets in dossier §§4, 6, and 9. All objects remain strict and reject unknown keys.

### 4.3 Kind, storage, conformance, and identity allowlist

- Add exactly two core kinds: `project` and `interaction_profile`.
- Add only the dossier-listed edge types: `in_project`, `shared_into`, `participates_in`, `authored_from`, `defaults_to_profile`, `selected_profile`.
- Add one forward migration containing only dossier §8 tables, columns, constraints, indexes, triggers, RLS, SECURITY DEFINER lock/RPC foundations, backfill/audit/repair/retention/forward-compensation seams.
- Add generated catalog/router/schema/help and total kind-disposition proof for the 101 target. This is a W1 foundation, not W4 CLI implementation.
- Add only the minimum non-public `system_delivery_adapter` principal seam described by dossier §§5.1 and 8.4. It must not be mintable from JSON, headers, CLI flags, `actorId`, Member/Teammate/session tokens, or act-as. W2 owns actual `execution.prompt` enforcement and delivery/budget behavior.

## 5. Companion proposals explicitly excluded from W1

The following appear in subordinate companions but are not approved W1 deltas in the G0-bound dossier, so W1 will not implement or normalize them:

- the proposed `entities.commands.work(status='done')` / `use_complete_command` guard;
- task acceptance-criterion command additions or generic task lifecycle redesign;
- `permissionMode` on `ExecutionSpawnInput`;
- entity-visibility mutation;
- provider `execution.agentEvents.*`, semantic replay, response-slot capture, or any non-`explicit-only` capture mode;
- a public prompt/report/progress/whoami alias or compatibility layer;
- file-upload resume as a new semantic operation;
- new presence-subscription operations/frames;
- coordinator-only graph mutations or unlisted `coordinated_by`/`spawned_by` relations;
- UI implementation, dynamic/UI-template entities or operations, and Remote Phase 2.

Any implementation diff outside §§4.1–4.3 stops W1 for a dossier amendment and a new gate.

## 6. Opus W1 first-read packet disposition

| # | Required cleanup | W1 disposition |
|---:|---|---|
| 1 | Workspace §5.7 sanitized `interaction_profile` projection cross-reference | Documentation task; no G0-bound edit |
| 2 | Date/narrow or re-derive DOMAIN §9 scores after K/L | Documentation task |
| 3 | Expand DOMAIN §7.2 API-family ownership | Documentation task |
| 4 | Continue DOMAIN proposed-voice labeling | Documentation task |
| 5 | Backend briefing: `default` is API-request-only and not pinnable | Documentation task |
| 6 | Chat-UI C1 three-value API enum wording | Documentation task |
| 7 | SCM acceptance 30 bare Member and act-as principals | Documentation task |
| 8 | Matrix row 47 `messages.delete` unbound | Corrected in §2 and later generated W1 evidence; G0 matrix unchanged |
| 9 | Matrix A16 stray `read` binding text | Corrected in §4.1 and later generated W1 evidence; G0 matrix unchanged |
| 10 | API guide profile-table de-duplication and A01–A20 labels | Documentation task |
| 11 | Workspace §7.6 retire as deletion analogue | Documentation task |
| 12 | Two residual ledger documentary-voice restatements | Documentation task |
| 13 | Workspace §8.2 moved-anchor citations | Documentation task |

## 7. Child-task integration order

1. W1.0 preflight freezes this allowlist and the current-source baseline.
2. W1.A changes `packages/contract/**` under TDD.
3. W1.B authors the single post-014 migration and package-disjoint DB tests under TDD.
4. W1.C consumes the integrated contract and migration metadata for generators/exhaustiveness.
5. W1.D adds only the package-disjoint internal-principal seam.
6. W1.E applies the 13 documentary/regeneration cleanups without touching the G0-bound files.
7. W1.I integrates and runs the complete W1 command/rehearsal suite.
8. W1.V independently reproduces strict, migration, RLS, race, and generator evidence.
9. A fresh narrow Opus gate returns the G1 verdict. W2 remains forbidden until APPROVE.

## 8. Integration evidence ledger

Pending worker reports, exact changed files, test-first failures, scoped green commands, compatibility impact, empty/current-state migration rehearsals, RLS negatives, lock races, generator accounting, independent verification, and G1 verdict.

### 8.1 Resolved authority seam and preserved resume boundary

The migration TDD stream stopped two inferred additions before writing them:

- dossier §8.1 declares its table/column list exact but does not name storage for the typed Space Interaction Profile default required by A20 and §6.4;
- dossier §5.1 names three database delivery RPCs (`reserve_session_message_delivery`, `claim_session_message_delivery`, and `settle_session_message_delivery`) plus one non-database execution-adapter write, while §8.4 says the delivery role may execute “the four delivery RPCs” without naming a fourth.

W1 did not infer `spaces.default_interaction_profile_id`, `expire_session_message_deliveries`, or any substitute. It paused with one intentional red contract test, zero migration/DB changes, and four isolated identity files with focused 6/6 green.

G0.1 now freezes `spaces.settings_revision integer NOT NULL DEFAULT 1 CHECK (settings_revision >= 1)` plus `spaces.default_interaction_profile_id uuid NULL REFERENCES interaction_profiles(entity_id) ON DELETE RESTRICT` and its partial index. The migration must create `interaction_profiles` before adding that Space FK. A03 and A20 intentionally share the one Space-settings revision token; cross-operation races must prove that one expected revision cannot commit both writes.

The delivery database-role allowlist is exactly `reserve_session_message_delivery`, `claim_session_message_delivery`, and `settle_session_message_delivery`. The governed `proc.write` effect is non-database. W1 will not add an expiry, recovery, retention, cleanup, or notification RPC; W2 must use an existing owner path for expiry or obtain an amendment.

### 8.2 Reproducible pre-resume source digest

W0-E's package/migration source digest was reproduced from the repository root immediately before resumed implementation with this exact recipe:

```sh
rg --files packages db/migrations | LC_ALL=C sort | xargs shasum -a 256 | shasum -a 256
```

Expected and observed standard output:

```text
143f7b14879a29506f2390899ab72983d9139971debd674fdb86aa9754f83cc9  -
```

The recipe hashes every path emitted by `rg --files` below `packages` and `db/migrations`, sorts the path stream under `LC_ALL=C`, computes each file's SHA-256, and hashes the ordered checksum stream. This is the preserved G0.1 resume-boundary digest; implementation is expected to change it.

### 8.3 G0.1 minor dispositions and resume audit

1. Digest evidence hygiene is closed by §8.2.
2. Migration statement order is assigned explicitly to W1.B: create `interaction_profiles` before adding the Space FK.
3. The shared A03/A20 revision token gets database race evidence in W1.B and generated conformance evidence in W1.C.
4. The pre-existing A16 stray `read` binding word is corrected only in W1-generated metadata; the unchanged G0/G0.1 matrix is not edited.
5. Pending-delivery expiry ownership remains W2 scope and may not be invented as a delivery-role RPC.

The three preserved implementation sessions were re-audited before resume. Each uses team member `tm_1785033707528_3qfm30abt`, `provider=openai`, `agentTool=codex`, `model=gpt-5.6-sol`, `reasoningEffort=xhigh`, and `accessMode=fullAccess`:

- W1.A contract: `sess_1785039346257_ukft1tkxp`;
- W1.B migration: `sess_1785039346261_2o27fu99s`;
- W1.D identity seam: `sess_1785039346255_3k7wyfexn`.

### 8.4 W1.D identity/system-principal evidence

W1.D completed within its exclusive four-file boundary:

- created `packages/server/src/identity/system-delivery-principal.ts`;
- modified `packages/server/src/identity/types.ts` and `packages/server/src/identity/index.ts`;
- created `packages/server/test/identity/system-delivery-principal.test.ts`.

The focused TDD command first failed 6/6 because the two seam functions did not exist, then passed 6/6 after implementation. Resume verification produced:

```text
cd packages/server && bun run build                                      PASS
cd packages/server && bun run test -- test/identity                      PASS (7 files, 67 tests)
cd packages/server && bun run test -- --exclude test/sidecar/lifecycle.live.test.ts
                                                                         PASS (19 files, 183 tests; 6 files/64 tests skipped)
```

The unfiltered Server suite reached 186 passing tests but failed nine cases downstream of the local `initdb` failure in `test/sidecar/lifecycle.live.test.ts`, with one lifecycle error. W1 integration retains that as database-environment evidence to reproduce after the migration stream establishes its supported rehearsal path; it is not represented as a green full-Server run.

The seam uses a private type brand plus module-private `WeakSet` provenance, exact validated/frozen claims, tuple binding, and exclusive expiry. Member, Teammate, session bearer, owner/admin, act-as, structural clone, HTTP body/header, `actorId`, and JSON-roundtrip inputs all fail closed. It contains no database capability list, graph authority, public parser, handler guard, or fourth RPC; W2 still owns minting from pre-reserved Server state and the pre-queue handler enforcement.

### 8.5 W1.E Opus documentation-packet evidence

OpenAI/Codex Terra xhigh session `sess_1785041529777_vdaiza3wx` completed the thirteen W1 packet dispositions in exactly seven non-bound files:

- `WORKSPACE-LAYOUT-AND-TERMINOLOGY.md`;
- `WORKSPACE-LAYOUT-REVIEW.md`;
- `DOMAIN-ARCHITECTURE-DECISIONS.md`;
- `BACKEND-BRIEFING-FOR-CHAT-TEMPLATES.md`;
- `CHAT-UI-AND-LAYOUT-DESIGN.md`;
- `SESSION-COMMUNICATION-MODEL.md`;
- `API-CATALOG-GROUPED-GUIDE.md`.

The API guide now has exactly twenty sequential A01–A20 rows, a separate Kind column with A16 represented as POST/read, and no duplicate Interaction Profile operation table. The workspace spec has the explicit sanitized profile share renderer and retire-as-deletion-analogue wording. DOMAIN has dated adopted-target scoring/voice and expanded amendment-family ownership; the backend, Chat UI, and SCM documents carry the requested scope/principal corrections. Exactly two remaining RULING-J ledger sentences were changed from operative voice to “the design specifies” documentary voice.

Coordinator re-verification confirmed that the six G0.1-bound artifact hashes remained exactly the §1 values. The bound matrix was not edited: row 47 and A16 remain W1 generated-evidence corrections only.

### 8.6 W1.V0 in-flight independent gap audit

OpenAI/Codex Terra xhigh session `sess_1785049818553_9gxuozozl` performed a read-only snapshot audit with no edits, tests, database commands, or git. Its preliminary W1.A schema/export findings were closed during the audit; the stable handoff must use the later W1.A completion evidence rather than retain those preliminary gaps.

The audit independently observed the exact A01–A20 catalog order/bindings, A16 POST/read metadata, 101/99+2 accounting, the two new kinds and both generic-create exclusions, and the required `interaction_profiles`-before-Space-FK migration order. It classified the remaining in-flight work without moving W2/W3 semantics into W1:

- W1.B: exact trailing PUBLIC/application revocations and three-RPC delivery-role grant, RLS/read/direct-write boundaries, A03/A20 shared-revision races/replay/no-op/lock/principal negatives, current-supported-state apply, project/participant/B2/handoff lock tests, and conservative backfill/audit/repair/forward-compensation evidence;
- W1.C: generated 101 operation/router/schema/help proof, total kind disposition, internal-only prompt help, reserved-operation 501 honesty, and WS-skeleton honesty;
- W2/W3: public B1 pre-queue and B2 semantic behavior plus later public end-to-end verification, not W1 implementation defects.

### 8.7 W1.A contract/catalog/schema evidence

W1.A completed in `packages/contract/**` after its original 81-row acceptance red. Authored source/test files are `src/catalog.ts`, `src/contract.ts`, `src/schemas.ts`, `test/contract.test.ts`, and new `test/w1-amendment.test.ts` plus `test/w1-strict-schemas.test.ts`; the contract build refreshed the corresponding `dist/**` output and TypeScript build metadata.

Coordinator-independent commands produced:

```text
bun run build:contract                                             PASS
bun run test:contract                                              PASS (3 files, 42 tests)
```

The final source/dist catalog accounting is exact:

| Measure | Result |
|---|---:|
| total / v1 / reserved | 101 / 99 / 2 |
| HTTP / WS | 100 / 1 |
| GET / POST / PATCH / DELETE / PUT / WS | 36 / 41 / 9 / 7 / 7 / 1 |
| read / command / stream | 39 / 61 / 1 |
| unique names / unique method-path bindings | 101 / 101 |

The last twenty rows are A01–A20 in dossier order. A16 is `POST /v2/interaction-profiles/:profileId/preview` with kind `read`; the generated catalog does not reproduce the matrix cell's stray word. Reserved names remain exactly `search.query` and `bridge.fetchBlob`. The only new core kinds are `project` and `interaction_profile`, with both restricted generic-create exclusion legs tested.

Strict coverage includes the additive/frozen request and result objects, nested Menu/Profile/Handoff/Feed/Inbox/Delivery/Action objects, adopted durable events, enriched PaletteAction metadata, closed ErrorCode and AmendmentErrorReason schemas, dossier-exact `ErrorDetails.reason: string` with strict object keys, A03/A20 shared settings-revision shapes, unknown-key failures, and legacy singular message anchor input normalization. Runtime handlers, DB conflict behavior, and W2 semantics remain outside W1.A.

### 8.8 W1.V1 independent stable contract verdict

Intentional Claude Sonnet 5 session `sess_1785060688978_ycv41ls3y` independently reviewed the stable W1.A package read-only and returned **APPROVE — 0 blockers, 0 majors, 0 minors**. It reproduced both G0.1 authority hashes, `build` success, all 42 contract tests, runtime `dist/catalog.js` accounting, the exact A01–A20 tail/A16 metadata, strict DTO/event/reason/kind behavior, all frozen-row amendments, source/dist export parity, the API-guide table, and the negative search for excluded companion proposals. It found no unlisted operation, field, reason, event, kind, or relation in `packages/contract` and made no edit or git invocation.

### 8.9 W1.C in-flight conformance foundation and artifact incident

OpenAI/Codex Sol xhigh session `sess_1785060553858_1elqqxpp5` established the conformance foundation test-first under `tools/conformance/**`. The first focused run failed because `src/foundations/generator.js` did not exist. Its latest scoped run passes eleven tests across `w1-foundations.test.ts` and `stub-honesty.test.ts`, and the deterministic stale check passes. Generated source inventory currently reports 101 operations as 99 v1 plus two reserved, 100 HTTP plus one WS, a registerable HTTP ceiling of 98, 28 existing handlers, 36 input bindings, 13 unbound commands, A01–A20 as unimplemented foundations, and A16 as POST/read. The separate live semantic command remains intentionally red against an explicit stub, proving that a 501 skeleton is not misreported as a 200 implementation. Migration-derived proof remains unset until W1.B freezes the final migration objects and digest.

While reporting that milestone, Markdown backticks embedded in a Maestro shell argument were evaluated by zsh. This unintentionally invoked the root build once, as well as the intended conformance command; an initial root test subcommand without a matching script failed harmlessly. No git, destructive action, or source edit outside `tools/conformance/**` occurred, but existing generated build metadata may have been refreshed. W1 does not attribute those outputs to W1.C, will not revert them, and will establish final evidence through fresh source-driven integration builds rather than generated-file timestamps.

The root build exposed pre-amendment Server producers that cannot compile against the adopted contract: missing `EdgeView.updatedAt`, `NotificationItem.recipient`, and message `messageBatchId`; stale `work_session.projectId`; unsupported scratch forwarding; and stale singular message input reads. These are assigned to the narrow W1.F stream, not folded into conformance ownership.

### 8.10 W1.F contract-to-Server compatibility launch

W1.F task `task_1785061533535_dx3n9f4qg` runs in audited OpenAI/Codex Sol xhigh full-access session `sess_1785061686569_7p7bmtgg0`. Its exclusive production allowlist is:

- `packages/server/src/events/mapper.ts`;
- `packages/server/src/events/projector.ts`;
- `packages/server/src/facade/entity-read.ts`;
- `packages/server/src/facade/execution-handlers.ts`;
- `packages/server/src/facade/handlers/entities.ts`;
- `packages/server/src/facade/handlers/messages.ts`.

It owns only new `packages/server/test/w1-contract-compat*.test.ts` focused tests. It may populate truthful adopted DTO fields and restore Server/root compilation. It may not implement canonical message batching or scratch execution: those W2-only paths must refuse explicitly before side effects, while existing compatible behavior remains intact. Contract, migration/DB tests, conformance, identity, documentation, generated outputs, CLI/UI, Remote Phase 2, and git are excluded.

## 9. Pending freeze-bound evidence

The following remaining entries are intentionally not populated before their evidence exists:

1. final integrated independent W1.V verdict;
2. fresh G1 gate verdict and the evidence-backed handoff rotation.

No pending section is evidence of completion, and W2 remains forbidden until the final G1 entry records a fresh Opus APPROVE.

### 9.1 W1.B frozen migration and database-test evidence

W1.B completed and froze exactly three owned files:

| File | SHA-256 |
|---|---|
| `db/migrations/015_w1_foundations.sql` | `47817dadf78ea833c60aa941cc49fcfe873a6d2b2788475ddb2c8058c0c1aa90` |
| `packages/server/test/db/w1-foundations.test.ts` | `96ca31b9005f0fd45c90481572badb1c8f1e0de5545ec141a528058522257da0` |
| `packages/server/test/db/w1-pg.ts` | `d161606953cb5c8c523170f4057daf659e14d98ee91c52af0715363441971026` |

The owner reported no edit after hashing. The published digest recipe produced `b6211234f086f829525ec2ab2ce3de98ac78843ea683c95343cbf8e747ff1a39` at `2026-07-26T10:31:08Z`; this is only a concurrent snapshot because W1.C and W1.F were still active, and is not the final W1 digest.

The frozen validation commands are:

```text
PATH=/opt/homebrew/opt/postgresql@18/bin:$PATH TM8_MIGRATION_DATABASE_URL=postgres://tm8@127.0.0.1:5442/postgres bun run check:migrations
  PASS: 15 static migrations; disposable tm8_migcheck_5044 applied 001–015

bun run --cwd packages/server test -- test/db/w1-foundations.test.ts
  PASS: 1 file, 15 tests; 1.685 s tests, 2.10 s total
```

The suite applies 001–015 from empty. Its current-supported rehearsal separately applies 001–014, seeds a Space, Member, Teammate, channel, Project/link, live session, and `relates_to` facts, then applies 015 and proves conservative backfill plus repeat repair.

The frozen SQL object inventory is:

- ten tables: `project_links`, `project_projection_details`, `space_menu_configs`, `interaction_profiles`, `interaction_profile_versions`, `work_session_interaction_pins`, `work_session_view_preferences`, `session_wake_budgets`, `session_message_deliveries`, and `session_handoffs`;
- additive columns on Projects, Spaces, Messages, Notifications, Activity, and Work Sessions, including the typed nullable Space profile FK after `interaction_profiles`, integer `settings_revision` baseline 1, message batch identity, teammate recipient, activity work-session provenance, and the adopted scratch mode check;
- exactly two kinds and six edges from §4.3;
- 24 indexes and 27 triggers, with the latter count including `entities_w1_recompute_incident_counters`;
- exactly eight new application RPCs: `set_space_default_channel`, `set_space_profile_default`, `set_space_menu_config`, `reset_session_wake_budget_for_member_reply`, `set_teammate_profile_default`, `inspect_owned_teammate_inbox`, `repair_w1_foundations`, and `compensate_w1_foundations`;
- exactly three delivery-role RPCs: `reserve_session_message_delivery`, `claim_session_message_delivery`, and `settle_session_message_delivery`; there is no fourth RPC;
- replacements of shipped `create_space`, `mark_read`, and `mark_notification_read` for additive compatibility;
- RLS enabled on all ten new tables with one select policy each, plus a replaced `notifications_select` policy for mutually exclusive Member/Teammate projections;
- guarded cluster role `tm8_delivery_worker` as LOGIN/NOINHERIT with database CONNECT and public-schema USAGE, no table/sequence/internal-helper rights, and EXECUTE only on the three delivery functions after explicit PUBLIC/application revocation;
- conservative materialization/backfill/repair helpers, 30-day delivery and seven-day eligible-budget pruning, and drain-gated forward compensation that preserves immutable pins/history.

The 15-test suite covers exact objects and ACLs; RLS non-member/direct-write negatives; Member versus acting-as-Teammate inbox separation and read-only owner inspection; application denial, tuple forgery, and legal reserve/claim/settle; the A03/A20 one-Space shared-revision race and full A20 target/principal/revision/replay/no-op/NULL laws; participant and Project caps; Project association-create versus unlink; five-way B2 reservation and member-reset races; launch/message/recorder-edge/profile/pin guards; idempotent repair; retention; and drain-gated compensation.

An in-flight full Server run reached 199 passing tests and 64 skipped but was not represented as green: nine failures were downstream of the known local live-sidecar `initdb` fixture on port 5443, and two existing frame/event contract-shape failures plus the Server build errors belonged to the separately assigned W1.F compatibility seam. Fresh integration commands after W1.F freezes supersede this diagnostic snapshot.

The delivery row deliberately retains pair/version snapshots without a foreign key to the seven-day budget row, allowing budget deletion before the delivery's thirty-day retention horizon; trigger/RPC tuple enforcement remains mandatory. Role creation is cluster-global but guarded, while grants are per database. The migration adds no HTTP or `proc.write` behavior, no expiry/cleanup RPC, no UI/CLI/Remote work, and no W2 semantics.

Independent read/test-only W1.V2 task `task_1785061768420_wtpyz6m1n` is running in audited OpenAI/Codex Terra xhigh session `sess_1785062005199_uh1zwxrhi`; its verdict is still pending.

### 9.2 W1.C frozen conformance-generation evidence

W1.C completed under `tools/conformance/**`. The first focused run failed to load the absent foundations generator. After W1.B froze, a second intentional red passed nine tests and failed the migration-binding assertion because the generator still returned a pending null digest. The final source-derived implementation made both reds green without adding semantic API behavior.

Key frozen checksums are:

| File | SHA-256 |
|---|---|
| `generated/w1-conformance-manifest.json` | `0fc90585daf1884f7309eecb8941d5ec25d29d74d981b190131232c8ae20f695` |
| `src/foundations/conformance-cases.ts` | `e0016a8083b5c0ba84a8b329fee744ee57a60e2ae1490c0dff9b68491130c43e` |
| `src/foundations/generator.ts` | `852c5b753f76409696966abbbdd23bbb1cfd6925a4d1a35c650913edb437cbcc` |
| `src/foundations/kind-dispositions.ts` | `c7d3b85a0d2881c3415deba3e3599ddd3d90b500174b0d109cda85c4cb7daf02` |
| `src/foundations/migration-inventory.ts` | `b572ba8c24a98f6015335ab6994351340b0a0b02ab11015baa6cacf0074a502f` |
| `src/foundations/schema-dispositions.ts` | `7d0f8c19b16fd2cf2dd1fab7c3641bd9547731199d75e0fd7afa27112d3ee07a` |
| `src/foundations/source-inventory.ts` | `6a5c9a541b53894d99d17ef2757bf6ea5d14431a7bc526c8b031c6824c529987` |
| `src/generate.ts` | `820df9d185120118607070270c621bfa8bc6117f8831429b83996465cdbebe5c` |
| `test/foundation/stub-honesty.test.ts` | `27ac321b51d58c2034df6cc886e22948ecf63d90f482bfb83730c5433e170f6f` |
| `test/foundation/w1-foundations.test.ts` | `a155452263cd75feddd12396020894381f9f6ace2782b34a27ae667b08af3b2c` |

The generated `dist/**` checksum stream has aggregate SHA-256 `3b805ced72e6d3fb1161e4d03284d8d44e3123511e8e268634f3b7dbf06d9130`; `tsconfig.tsbuildinfo` is `4657107c971ca6d0330a4072f4d2fc2e7576584981b0ef246d2bfafaf1919e11`. The README, package scripts, global setup, exports, and focused/live Vitest configurations were updated within the same ownership boundary. The generated output is byte-stable under its stale check.

Final commands all pass:

```text
cd tools/conformance && bun run generate                              PASS
cd tools/conformance && bun run vitest run test/foundation/w1-foundations.test.ts
                                                                        PASS (10/10)
cd tools/conformance && bun run check:generated                       PASS
cd tools/conformance && bun run build                                 PASS
cd tools/conformance && bun run test                                  PASS (2 files, 12/12)
bun run test:conformance                                              PASS (2 files, 12/12)
```

The manifest binds migration SHA-256 `47817dadf78ea833c60aa941cc49fcfe873a6d2b2788475ddb2c8058c0c1aa90` and independently parses the §9.1 inventory counts. Contract accounting is exactly 101 = 99 v1 + two reserved, 100 HTTP + one WS, registerable v1 HTTP ceiling 98, methods 36/41/9/7/7/1, kinds 39/61/1, and 101 unique names/bindings. A01–A20 are ordered exactly, with A16's `read` value present only as kind. Existing runtime truth stays explicit: 28 handlers, 36 input-schema bindings, 13 unbound commands, and 70 unimplemented v1 HTTP operations.

The normal W1 package/root suites use the local stub as a known-operation 501 and unknown-operation 404 oracle. Live semantic suites remain separately named `test:live`; a diagnostic envelope run against the stub had two expected semantic failures and two envelope passes and is W2-boundary evidence, not a W1 gate failure. W1.C added no API handler, CLI grammar, UI, Remote, migration, or semantic operation implementation.

### 9.3 W1.F frozen contract-to-Server compatibility evidence

The adopted strict contract exposed six pre-amendment Server producers/handlers. W1.F captured a focused eight-test red for exactly those missing fields and honesty boundaries, then froze this source/test set:

| File | SHA-256 |
|---|---|
| `packages/server/src/events/mapper.ts` | `bfbcdb953d876acdcdd19be695768894bc2cb470f518fd1ab190c5075d5283ac` |
| `packages/server/src/events/projector.ts` | `865344f9795b3846af12a1f889afd132d7fe0ca2f0aa5333f5e37c269e62b4ca` |
| `packages/server/src/facade/entity-read.ts` | `f75bfd36b02ed419fd375f0c7d040f274983f58f177353a8fff7d9df9c2d44fa` |
| `packages/server/src/facade/execution-handlers.ts` | `63f43bdad9e87920c64eda274496969215f7002a86fba89a6c13804731f67a2d` |
| `packages/server/src/facade/handlers/entities.ts` | `38f1bb52bb0b56eab15780067040614333c12c25c653b3a3f1951d8ae001a9df` |
| `packages/server/src/facade/handlers/messages.ts` | `cf92e9d40ad10fd96507c2a44a8dbaad4bb8af8f14afa31bd70140db6b79e5a5` |
| `packages/server/test/w1-contract-compat.test.ts` | `7f4846d75014668a2909219f1ac12a3515e0496a9fb8ebf04988a329f21f662f` |
| `packages/server/test/frame.test.ts` | `7423f8a2dde21ac504679924ab17998af2c17a7faaec18357a2305e45a0bc096` |

The last file was a coordinator-approved test-only allowlist expansion: its existing `entities.create` status fixture omitted the newly required `clientMutationId`, so strict validation correctly returned 400 before the handler could return its asserted 201. Adding one deterministic mutation ID made that existing test exercise its original purpose without weakening schema or handler behavior.

Final commands are:

```text
cd packages/server && bun run test -- test/w1-contract-compat.test.ts
  RED: 1 file, 8/8 failed for the intended missing producer/refusal/forwarding laws
  PASS after implementation: 1 file, 8/8

cd packages/server && bun run test -- test/frame.test.ts             PASS (25/25)
cd packages/server && bun run test -- test/events/mapper.test.ts test/w1-contract-compat.test.ts
                                                                       PASS (2 files, 19/19)
cd packages/execution && bun run test                                PASS (4 files, 43/43)
cd packages/server && bun run build                                  PASS
bun run typecheck                                                    PASS
cd packages/server && bun run test -- --exclude test/sidecar/lifecycle.live.test.ts
                                                                       PASS (21 files, 206 tests; 6 files/64 tests skipped)
```

The unfiltered Server diagnostic reached 209 passing tests and 64 skips but retained the known local `initdb` failure in `test/sidecar/lifecycle.live.test.ts`, cascading to nine failures and one backup error. No W1.F assertion failed; the exact-file exclusion remains explicit and the independent 001–015 database gates are green.

DTO producers now use the persisted edge `updated_at`, mutually exclusive notification recipient columns, persisted message `message_batch_id` with truthful null for legacy rows, and the shipped work-session Project provenance as `launchProjectId`. Canonical `messages.post` input returns the standard 501 `not_implemented` before owner resolution or database transaction because W1 does not implement atomic batching. Scratch workdir and `interactionProfileId` likewise return 501 before owner/DB/spawn; `confirmUntrusted` is forwarded to the already-capable SpawnService. Focused spies prove zero side effects for every refusal. No batching, scratch/profile execution, A01–A20 behavior, contract/migration/conformance/documentation, CLI/UI/Remote, or git work was added.

### 9.4 Coordinator integration evidence

After W1.B, W1.C, and W1.F froze, the coordinator ran the required sequence serially from the repository root:

```text
bun run build:contract                                               PASS
bun run test:contract                                                PASS (3 files, 42/42)
bun run test:conformance                                             PASS (2 files, 12/12; generated evidence current)
bun run typecheck                                                    PASS
bun run build:server                                                 PASS

PATH=/opt/homebrew/opt/postgresql@18/bin:$PATH \
TM8_MIGRATION_DATABASE_URL=postgres://tm8@127.0.0.1:5442/postgres \
bun run check:migrations
  PASS: static checks over 15; disposable tm8_migcheck_7656 applied 001–015

bun run --cwd packages/server test -- test/db/w1-foundations.test.ts
  PASS: 1 file, 15/15; 1.520 s tests, 1.88 s total

bun run --cwd packages/execution test                               PASS (4 files, 43/43)
bun run --cwd packages/server test -- --exclude test/sidecar/lifecycle.live.test.ts
                                                                       PASS (21 files, 206 tests; 6 files/64 tests skipped)
```

The exact §8.2 recipe, run after these source-driven builds, produced the final package/migration digest:

```text
69cb185b1bd11dac9f5e16f8fbc95050012fd23bfd505ee465cb8f53c9f2d7db  -
```

Runtime accounting from the built contract reproduced 101 total, 99 v1, the exact two reserved names, 100 HTTP, one WS, registerable v1 HTTP ceiling 98, method counts 36/41/9/7/7/1, kind counts 39/61/1, and 101 unique names and method-path bindings. The last twenty rows are the exact A01–A20 sequence, and A16 is POST/read.

The six G0.1 authority artifacts retained exactly the §1 hashes, including dossier `b85a…4805`, matrix `fa2c…1c60`, gate `b4f1…ce4f`, handoff `f26a…342b`, index `b3d5…ab9e`, and G0.1 report `7b58…4148`. The handoff remains at its G0.1 hash until G1 actually approves; it is not preemptively rewritten.

The unfiltered live-sidecar failure is not concealed: separate owner and coordinator diagnostics both found the local Postgres lifecycle fixture unable to initialize its dedicated port-5443 throwaway cluster, with nine downstream failures and a cascading backup error. The required 001–015 empty/current database tests, ACL/RLS negatives, and races use separate validated scratch databases and are green. G1 therefore carries the exact live-sidecar environmental exclusion rather than claiming an unfiltered Server pass.

### 9.5 W1.V2 independent database verdict

OpenAI/Codex Terra xhigh session `sess_1785062005199_uh1zwxrhi` returned **APPROVE — 0 source blockers, 0 majors, 0 minors** with zero source edits and no git. At completion it rechecked the dossier, matrix, migration, DB test, and DB helper hashes exactly as §§1 and 9.1 record them.

Its independent mandatory commands passed: `check:migrations` statically checked fifteen files and applied 001–015 to disposable `tm8_migcheck_5834`; the frozen DB suite passed 15/15. A separate explicit current-state rehearsal applied 001–014, seeded the supported graph, applied 015, observed revision 1/null default plus one each link/projection/pin/participant/association/audit, and proved two repair calls preserve the four materialized counts.

Source- and catalog-driven queries independently reproduced ten tables, 24 indexes, 27 triggers including `entities_w1_recompute_incident_counters`, ten RLS tables, and zero application DML rights. The delivery role is LOGIN/NOINHERIT, non-superuser/non-create-role/non-create-database/non-replication/non-bypass-RLS, has zero memberships, and holds only database CONNECT, schema USAGE, and the exact reserve/claim/settle EXECUTE surface. It has zero tables, sequences, or internal helpers; PUBLIC/internal execute count is zero; the application role has SELECT on all ten tables and no delivery grant. The intentional absence of a delivery-to-budget FK was confirmed, as were the eight application RPCs, three delivery RPCs, and absence of HTTP, `proc.write`, fourth, expiry, or cleanup RPC behavior.

Independent direct probes produced:

- A03 success racing A20's `40001` conflict, final Space revision 2 with exactly one setting changed;
- A20 act-as `42501`, exact set/replay/no-op revisions, clear to null, and two events;
- B2 five-way reservation with four pending and the capped one permanently failed, budget wakes/version 4/4, legal dispatch/settle, and application/tuple/expiry/table `42501` negatives;
- last-participant `23514`, seventeenth Project association `53400` with sixteen retained, and create-versus-unlink as one success/one `23514` with consistent link/edge counts;
- mutually exclusive Member and acting-as-Teammate inbox projections, owner inspection without marking read, outsider zero visibility, and direct-write `42501`.

The authored suite additionally passed full wrong-Space/readability/live/retired/inactive/generated-confirmation, thirty-day delivery/seven-day budget retention, and drain-gated forward-compensation cases. The verifier removed its three named audit databases.

Four ad hoc verifier commands were superseded before acceptance: a glob accidentally reapplied 015, an inline shell command stripped the SQL owner literal, an inbox print referenced a misspelled local variable, and an optional retention transition omitted transaction-local identity. Each failed before its intended acceptance assertion and made no source edit. The corrected explicit commands above are the accepted evidence. The only operational note is that guarded cluster-role creation assumes an existing same-named role was not maliciously pre-provisioned; the tested role is correctly configured with zero memberships.

## 10. Final official-runner repair and user-authorized G1 close

The final independent W1.V review approved the integrated foundation with zero blockers, zero majors, and one documentation-only lifecycle-description minor. Direct coordinator reproduction then showed the lifecycle symptom was a real official-runner compatibility defect: raw-SQL scratch gates applied 015, but `node db/migrate.mjs up` created `public.applied_migrations` under the migration session and 015 later attempted blanket table ACL cleanup while still under `SET ROLE tm8_graph_owner`. The mixed-owner statement failed at former line 2186 and rolled back 015.

W1.B2 captured that exact red on both empty and current 001–014 runner-ledger paths, then added one `RESET ROLE` before the existing delivery table/sequence ACL closure. It did not edit the runner, change product ownership, expand privileges, or add behavior. Final rotated files are:

```text
9f3258054fb1a0a3cbc80928edcea87760715f2402671534bd32a232773b5ee7  db/migrations/015_w1_foundations.sql
c7acbd3a57c336750b90bb69e6551201abce616428183e2e7c727e3def080ce9  packages/server/test/db/w1-migration-runner.test.ts
96ca31b9005f0fd45c90481572badb1c8f1e0de5545ec141a528058522257da0  packages/server/test/db/w1-foundations.test.ts
d161606953cb5c8c523170f4057daf659e14d98ee91c52af0715363441971026  packages/server/test/db/w1-pg.ts
062ec620b8f9be87bc0a96f3bb30e900d0befff540b37e2ddc3ff418c3b9ce5a  tools/conformance/generated/w1-conformance-manifest.json
a1c56457baa53a56ee0bb6057c7149db81e48bd1b4c86b6b9a1566882973dc4b  tools/conformance/src/foundations/migration-inventory.ts
f9c8d4af606687bdefe9665593fdbdfa27fde28c1b1414c9d3724ff8eb6b6933  tools/conformance/test/foundation/w1-foundations.test.ts
```

Final required commands are green:

```text
official migration-runner regression                           PASS (2/2: empty and current-ledger)
W1 database foundation                                         PASS (15/15)
check:migrations                                                PASS (15 static; 001–015 scratch apply)
contract                                                        PASS (42/42)
generated conformance                                           PASS (12/12; manifest current)
root typecheck                                                  PASS
Server excluding the separately owned live-sidecar fixture     PASS (22 files, 208 tests; 6 files/64 tests skipped)
```

The runner test also proves fifteen ledger rows, runner ownership of `applied_migrations`, graph-owner ownership of product tables, zero delivery-role table/ledger/sequence privileges, and the unchanged exact reserve/claim/settle EXECUTE surface. The conformance manifest was regenerated against the rotated 015 hash without changing its 101-operation or storage-object accounting.

The final published-recipe package/migration digest is:

```text
5f1a6ace0566d4bff0fbbef48c66a2a189207eb8dc53c96c7d4bcd8eeac88e0d  -
```

By explicit user priority override relayed by the full-program coordinator, the fresh W1 Opus gate is waived. G1 is therefore recorded as **USER-WAIVED/AUTHORIZED** after the required runner repair and green integration suite. Future G2–G5 gate rules remain unchanged unless separately overridden. W2 may begin; W1 adds no W2 API semantics, CLI/UI, or Remote Phase 2 work.
