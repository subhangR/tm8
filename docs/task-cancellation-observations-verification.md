# Cancellation observation verification

Open when reviewing PR 1145's transaction proof or assembling the migration prerequisites for release.

The runtime reviewed by the Taskland advisor is `dce18be41825150d4b0949371e99068929064093`. The final follow-up changes only the PostgreSQL proof test and this record. Migration 317, its restore guard, the authorized read, the cold consumer and the CI runner remain byte-identical to that accepted runtime.

## Source chain

The isolated proof checkout was `/tmp/tm8-legacy-combined-proof-01a11c44`, local assembly commit `6d3bc89a85e31ff19111cee1fbefadbf06f0b2fc`. It was not pushed or merged. The sources were:

| Source | Reviewed revision |
| --- | --- |
| Common main prerequisite | `42cd170ced7967b44d4195fc8201c77b58e58f74` |
| Release 314 and the two 313 identity approvals, PR 1131 | `8d081dacd5e87c12226e8686b07d68107002b477` |
| Storage 315, PR 1144 | `7a98b7a0713c275e0a700e80716147e823a9b194` |
| Frozen events 316, PR 1132 | `5aafdb384f12735387cb55d7df10044cf569413b` |
| Frozen task timestamp projection, PR 1136 | `a1dcd971fa0490b610426e7b01f19b608060730f` |
| Observation 317 and per-file CI transaction, PR 1145 | `dce18be41825150d4b0949371e99068929064093` |

Only the exact storage migration file was added for the storage prerequisite. The 1131 cherry-pick's schema-test comment conflict was resolved by retaining its existing `entities.markSeen` exemption; no gate was weakened. All three reviewed identity entries survived: `public.mark_entity_seen`, the `entity_seen_select` policy, and `internal.stamp_task_initial_status`.

SHA-256 fingerprints of the applied files:

| File | SHA-256 |
| --- | --- |
| `314_seen_entities_ci.sql` | `9ae7b83e0dd8dcb039186e52deaa49caad3bf8a18c9f5f144e88c7aef66eca22` |
| `315_game_maps.sql` | `9bef87f804c7d734d92e9d461b04eb64ae085b30c846682a82f62f2667b38618` |
| `316_task_game_events.sql` | `5819268c4c2c7aad419a9f99f2344923530462433a7575aa6038d484b56a6a1e` |
| `317_task_cancellation_observations.sql` | `1ebca236e204a39f4d02057f9c9fba415147d0a2827aa4c0c64bdb90c824b1b7` |
| `tools/ci/migrations-check.sh` | `d3f847249e66c7542c54c55bebd89a557cf8c050237151f7858269295f4953f8` |

## Actual database controls

On 2026-10-08, PostgreSQL 16 ran on the worker's isolated port 18444 with commit timestamp tracking enabled. No shared or production database was used.

The committed PostgreSQL suite passed **12/12**. It now executes migration 317 with the exact CI apply command, `psql "$SCRATCH_URL" -v ON_ERROR_STOP=1 -1 -q -f "$path"`. The test observes the migration waiting for an existing task writer's lock, commits that writer, and compares the bound with its actual commit timestamp. A second test takes 317's exact lock prefix, creates and populates a probe table, then fails with division by zero. The command exits nonzero and the probe table is absent afterward.

The unchanged full CI driver ran with `CI=true TM8_MIGRATION_DATABASE_URL=postgres://tm8@127.0.0.1:18444/postgres bash tools/ci/migrations-check.sh`. All **282** migration files through 317 applied to a fresh scratch database. The identity gate passed with **261** live readers, all approved. The scratch database was dropped by the driver's normal cleanup.

For the full-runner negative control, a separate fixture checkout copied that same chain and unchanged CI scripts. Only its private 317 file was changed: after the task lock, it created and populated `public.cancellation_rollback_probe`, then executed `select 1 / 0`. The driver exited **1**, reporting the 317 failure; the underlying apply command exited **3**. An observing `psql` wrapper checked the database before the normal cleanup and returned `t|t` for both probe-table absence and observation-table absence. The probe row therefore did not survive. The fixture did not modify any source checkout or gate.

Retained local evidence is `/tmp/tm8-legacy-01a11c44-db-tests.log`, `/tmp/tm8-legacy-01a11c44-combined-chain.log`, `/tmp/tm8-legacy-01a11c44-ci-negative.log`, and `/tmp/tm8-legacy-01a11c44-ci-rollback-evidence.log`. The injected fixture is `/tmp/tm8-legacy-ci-failure-01a11c44`.

## Bounded application-path audit

Repository searches inspected migration-file iteration, file reads and `psql -f` invocations. The standard migration-file application paths all wrap each file:

- `db/migrate.mjs` uses `psql -1` for a migration and its ledger insert. Install, deployment, sidecar migration, scratch-template creation, database-test setup and the UI integration fixture delegate to this runner.
- `tools/ci/migrations-check.sh` uses the reviewed `psql -1` apply loop, preserving `ON_ERROR_STOP`, failure handling and the static and identity gates.
- `packages/server/test/db/w1-pg.ts` uses `psql -1` per file.
- `tools/rigs/mcp-browser-fixture.mjs` uses `psql -1` per file.
- The external candidate application in `w2-entities-commands-tracking.pg.test.ts` also uses `psql -1`.

Two historical candidate-only test branches have no explicit transaction wrapper: `w2-sec1-032-replay-resource-binding.pg.test.ts` and `w2-sec1-036-entities-create-resource-binding.pg.test.ts` send the complete candidate SQL string to `database.query`. Both branches are skipped on this chain because 032 and 036 are already landed. They are reported here without changing unrelated tests. Extracted single-statement test shims and administrative create/drop or fixture queries are outside the migration-file runner audit.

This receipt establishes the scoped migration/read/consumer checks. Storage's rendered SAVE/ACK diagnosis, live preservation across title upserts, integrated rendering verification, prerequisite integration and manual merge remain with their respective owners.
