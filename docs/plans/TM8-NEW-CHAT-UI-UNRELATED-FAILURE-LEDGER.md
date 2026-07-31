# New Chat UI — unrelated current-tree failure ledger

Observed on 2026-07-30 while expanding the New Chat UI verification ladder.
These failures are not waived and their assertions have not been weakened.

| ID | Suite | Failing behavior | Chat overlap |
|---|---|---|---|
| U1 | `packages/tm8-ui/src/panels/panels.test.tsx` | `THE GATE: activity on a NON-LIVE row never streams and never pulses` | None; EntityListPanel row presentation. |
| U2 | `packages/tm8-ui/src/panels/panels.test.tsx` | `a LIVE row with activity streams; the same row without activity says running` | None; EntityListPanel row presentation. |
| U3 | `packages/tm8-ui/src/panels/panels.test.tsx` | `renders Maestro session metadata: provider icon, model, completion mark, and linked task` | None; EntityListPanel row metadata. |
| U4 | `packages/tm8-ui/src/panels/panels.test.tsx` | `unknown liveness renders neutral and never as live` | None; EntityListPanel row presentation. |
| U5 | `packages/tm8-ui/src/panels/panels.test.tsx` | `D34: at the floor the row renders the SHORT word, and the title survives` | None; compact EntityListPanel row presentation. |
| U6 | `packages/tm8-ui/src/panels/panels.test.tsx` | `D34: a compact STREAMING row keeps its own word — "streaming" fits any floor` | None; compact EntityListPanel row presentation. |
| U7 | `packages/tm8-ui/src/panels/panels.test.tsx` | `the seam VERDICT outranks the record status badge on a session row` | None; EntityListPanel row presentation. |
| U8 | `packages/tm8-ui/src/views/gate.test.tsx` | `THE DOOR: the launch sheet is REACHABLE from the running view` | None; launch quick-action expectation. |
| U9 | `packages/tm8-ui/src/data/real/seam-real.test.ts` | `the seam surface matches the locked interface, method for method` now observes concurrent `resolveAttention`, while its exact commands-surface expectation is unchanged. | None; external attention-command seam work. |
| U10 | `packages/server/test/w3/g02-public.test.ts` | `C: replays a repeated clientMutationId with exactly one ledger row and one entity` | None; legacy W3 integration expectation against the current database/server tranche. |
| U11 | `packages/server/test/w3/g02-public.test.ts` | `E: entities.commands.work REFUSES status=done with invariant_violation/use_complete_command and no status change` | None; task command behavior. |
| U12 | `packages/server/test/w3/g02-public.test.ts` | `E2: only entities.commands.complete crosses into done, and it pays the completion gate atomically` | None; task completion behavior. |
| U13 | `packages/server/test/w3/g02-public.test.ts` | `G: round-trips delete → restore with DB-observable soft deletion, and refuses a BODY-LESS delete` | None; generic entity deletion behavior. |
| U14 | `packages/server/test/w3/g02-public.test.ts` | `J: entities.points.add APPENDS to the immutable ledger and never edits a total directly` | None; points ledger behavior. |
| U15 | `packages/server/test/w3/g02-public.test.ts` | `M: entities.move reparents under version control, issues an undo handle, and conflicts when stale` | None; generic entity movement behavior. |
| U16 | `packages/server/test/w3/g02-public.test.ts` | `P: entities.commands.pull pins an immutable projection and refuses a version that does not exist` | None; task pull behavior. |
| U17 | `packages/server/test/w3/g02-public.test.ts` | `T: linkPr / linkCommit materialize tracked artifacts, and tracking.refresh queues them (202)` | None; tracking behavior. |
| U18 | `packages/server/test/w3/g02-public.test.ts` | `R: tracking.refresh accepts one Space, several Spaces, and the unscoped whole-account form` | None; tracking behavior. |
| U19 | `packages/server/test/w3/g02-public.test.ts` | `X: entities.feed and entities.context belong to G13 and still answer an honest 501` now receives the currently mounted `entities.feed` 200 response. | The test names the canonical feed used by Chat, but it is a stale legacy availability expectation; this task did not mount or change the server feed handler. |
| U20 | `packages/server/test/w2/rolling-public.integration.test.ts` | `replaces G02's eight and G04's two legacy registrations and mounts the exact 92-operation facade tranche` | None; pre-existing handler-count expectation (current surface contains four additional registrations). |
| U21 | `packages/server/test/w2/rolling-public.integration.test.ts` | `reports the exact 99-handler production composition and preserves 501/404 honesty` | None; pre-existing production handler-count expectation (current surface contains four additional registrations). |
| U22 | Complete serial server census after the stable contract build | 62 additional failures across legacy W3/W5 public/discovery, database-sidecar, event, cursor-allowlist, file, and schema-generator gates; exact names are preserved below. | None exercises a changed Chat presentation/store/composer path. File/message operations named by these suites are server-side legacy gates; this task only consumed their existing public operations. |

The Chat integration assertion originally added to `panels.test.tsx` was moved
to `panels/bodies/WorkSessionContent.integration.test.tsx`, returning the
unrelated failing suite to its pre-task content. If a failure begins executing
a New Chat UI implementation path, it must be escalated rather than retained
as unrelated.

Final stable-contract recheck on 2026-07-30: U1–U7 passed in
`panels.test.tsx` (68/68), and U8 passed in `gate.test.tsx` (13/13), without
changing their assertions. U9 remains the sole UI-suite failure. The complete
eight-shard UI run covered 1,518 tests: 1,517 passed and U9 failed. U10–U21
remain unchanged broader server-suite failures.

The stable-contract server census ran serially in four shards to avoid test
database cross-talk. It covered 1,123 tests: 975 passed, 74 failed, and 74 were
skipped. Twelve failures are U10–U21. U22 preserves the other 62 exact names:

- W3 public/discovery and replay: `W3.G05 collections, graph, and undo through the production Server redeems one registered undo token idempotently and persists one inverse`; all five failing `W3.G06 projects and associations through the production Server` cases; both failing `W3.G09 saved views and actions through the production Server` cases; `W3 production-Server public harness starts the real database-backed production composition`; both `W3.XG02 clientMutationId harvestability through composed reads` cases; `W3.XG03 same-principal replay across resources, outside 032 does not hand Space A's created entity to an entities.create replay naming Space B`; the G01, G05, and G06 agentic discovery workflows; four failing `W3.G01 identity and Spaces through the production Server` cases; three failing `W3.G07 file/blob lifecycle through the production Server` cases; both failing `W3.G08 inbox and read marks through the production Server` cases; both failing `W3.G03 clean-room/agentic public protocol` cases; the G08 and G09 agentic discovery cases; all six `G15 reserved and residual honesty, via generated discovery only` cases; `W3 evaluator-owned generated discovery adapter validates the live catalog digest and exposes only bounded noun summaries at root`; all four failing `W3.G03 edges and placements through the production Server` cases; `W3.G14 menu and default channel through the production Server BRANCH: replaying the same clientMutationId does not apply a second effect`; both `W3.XG01 ledger replay is bound to the request it replays` cases; and the G07 agentic file lifecycle case.
- W5 idempotency/schema gates: all five failing `W5.C migration 038 — resource binding at the PUBLIC HTTP boundary` cases and all three `W5.C generator proof` cases.
- Local environment/event gates: all nine `sidecar lifecycle (live cluster on 5443)` cases; `Delta 1 passthrough (the generic mapper arm, live) A9: menu.updated (RPC-authored, no entity row) reaches a subscribed socket end-to-end`; and `cursor timestamp truncation detector still sees the allowlisted site, so the allowlist is not hiding a fixed file`.

Representative diagnostics remain unrelated to Chat: the production root now
reports 109 operations where a legacy harness pins 105, and an isolated G06
replay receives a duplicate `projects_working_dir_key` conflict. Assertions
were not weakened and no server cleanup or fixture mutation was performed.
