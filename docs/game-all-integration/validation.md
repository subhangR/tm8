# Validation receipt

Final source: `0bd5425479e80cf45c18a06d64486a70420073b0`. Subsequent handoff commits contain only documentation. Checks below ran on this combined tree or on unchanged source files before the final documentation commit; no separate-lane CI is counted as combined evidence.

## Local results

| Check | Result |
| --- | --- |
| Workspace core typecheck; final UI typecheck | Pass, including final full workspace rerun |
| UI production build | Pass; existing large-chunk warning |
| Focused UI data/Game/map/model/scene/navigation tests | 300 passed in 29 files |
| UI hex-ban, prompts and Taskland scene controls after token fixes | 49 passed in 4 files |
| Full contract suite | 496 passed in 25 files |
| Conformance suite and regenerated inventory check | 14 passed; generator output unchanged on final source |
| GPU harness core unit tests | 9 passed; does not establish GPU performance |
| Migration clean-apply/identity check | Pass: 282 migrations, 261 identity allowlist entries; canonical 314–317 preserved |
| Focused CLI resume/catalog/discovery | 73 passed in 4 files |
| Full CLI first run | 2210 passed, 13 stale inventory assertions failed, 1 skipped |
| Full CLI corrected run | 2223 passed, 1 skipped; nonzero exit from edge.test suite teardown hook timeout at 10s. Isolated rerun: 39 passed; full-suite exit remains nonzero |
| Focused server Game/cancellation/root-facts/unread/seen/events/criteria/schema/registry suites | All seven initial failures corrected with focused reruns; original 120 passed, 7 failed, 12 skipped. Corrected six-file controls pass across the reruns (58 tests) |
| Additional server fixtures/inventories | Assignment, strict human-gate, public counts, composition and bound-schema controls pass after corrections |
| Server discovery and regenerated context goldens | 62 passed in 2 files |
| Server agentic discovery/status-event classification | 18 passed in 2 files |
| Server historical status-category/public harness and migration laws | 43 passed; 2 genuine migration-law failures retained |
| Combined HUD software smoke at final source | Pass at 800×600, 560×740, 560×600, real clicks; [raw receipt](combined-hud-result.json) |
| Git whitespace/conflict checks | Pass |

The HUD check uses production WalkingMapView and synthetic workers. It proves the bounded workers/tools/Places/minimap geometry and normal button/portal/toggle actionability in those fixtures. It does not prove live subscriptions, storage restart behavior, native rendering performance, arbitrary viewport sizes or repeated rapid input. An earlier one-off rapid collapse/reopen failure is unexplained and remains a local-test limit.

## Remaining genuine failures

`test/db/rls-membership-once-per-statement.pg.test.ts` still fails its exact empty-policy assertion. Migration 315 policies `editors.map_read`, `terrain_chunks.map_read`, `player_states.player_self`, `navigation_states.navigation_self`, `placements.placement_visible`, `edits.edit_visible`, `activity.activity_visible`, and migration 317 `task_cancellation_observations.task_cancellation_observations_select` call per-row membership helpers.

`test/db/never-analyzed-tables.pg.test.ts` still fails its exact empty-table assertion for migration 317's `task_cancellation_observations`. These are source migration findings requiring owning-lane release remediation. No assertion is skipped or broadened, no canonical migration is edited, and no migration 318 is added.

The full CLI corrected run's edge-suite teardown timeout is a distinct local cleanup failure. All executed test assertions passed. The isolated rerun disposition is recorded below; the full run itself is not called green.

## First combined GitHub CI accounting

Run [37861084710](https://github.com/subhangR/tm8/actions/runs/37861084710), head `e7007c76727bba04ea52c78ae8cd78881ecd3d5d`, was superseded/cancelled after reporting failures. Typecheck, execution, migrations, script wiring and UI shard 2 passed. UI shard 1, CLI, small, server shards 1/2/4 failed; server shard 3 was cancelled with partial failures logged. Its results do not certify any later head.

| Failed control family | Disposition on final source |
| --- | --- |
| Small contract/conformance exact catalog inventory | Regenerated digest and measured exact counts; 496 + 14 local tests pass |
| CLI 13 exact catalog/command inventories | Corrected; all 2223 executed assertions pass in the full rerun, with teardown caveat above |
| UI hex/CSS/component palette law and empty task noun | Five exact RGB tokens; no exemption; empty `pr` fixture plus positive task read; 49 controls/typecheck/build pass |
| Server 1 identity-spaces/reserved/public/schema/criteria pins/fixtures | Add unread operation, measured exact counts, defer 316/317 until after historical seed, deduplicate only duplicated markSeen entry; focused reruns pass |
| Server 2 assignment-provenance/current read schema | Nullable 316 clock column only; all historical assertions and triggers preserved |
| Server 2 six feed-context goldens | Generated additive statusChangedAt:null; byte sizes +23 per occurrence; 62-test rerun passes |
| Server 2/4 public/discovery/composition/generator inventories | Measured exact totals/digest/noun and schema counts; targeted checks pass |
| Server 4 historical status-category/current read schema | Nullable column only; 32 tests pass in the final known-limits run |
| Server 4 subject-set/status-clock/strict-gate caller set | Fixture seam, authoritative 317 INSERT clock contract, two 315 navigation callers; assertions remain exact and reruns pass |
| Server 3 partial rolling-public failures | Exact list retains all operations once, including unread/cancellation; focused rerun passes |
| Server 3 partial agentic discovery and entity-event classification | Exact measured digest/counts; preserves exactly two FULL upserts and adds exactly one 316 status event with exact payload; 18 pass |
| Server 2/4 statistics and RLS policy laws | Genuine failures retained and detailed above |

Latest PR CI is triggered for the final published head. Its exact run URL/status is reported in the PR and coordinator receipt; pending/running is not a passing result. Full combined selection includes CLI, execution, small, both UI shards, all four server PG shards, typecheck, migrations and script wiring. Native GPU, full combined storage/Events/Taskland browser restart/performance acceptance, manual release gates and protected merge acceptance remain pending.

## Final bounded reruns and resource closure

The six CLI inventory control files pass: 223 tests, 1 skipped. The isolated edge suite passes all 39 tests, without raising its teardown timeout. The full CLI run is still reported as nonzero because its original 10s teardown failure occurred. Final `bun run typecheck` passes.

Only the private test resources owned by this worker are closed: PostgreSQL 16 on port 18651 (scratch pg-data) and Vite on port 18653. The isolated checkout and evidence remain available; no shared cluster, feature branch or seed checkout was mutated.
