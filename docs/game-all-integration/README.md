# Combined Game test candidate

One isolated branch on main42cd170ced7967b44d4195fc8201c77b58e58f74 combines all21 current Game/prerequisite inputs. This draft is for local testing while combined CI runs. Publication does not authorize merging to main or deployment.

`source-manifest.json` freezes every included/covered/excluded PR and SHA. `commit-coverage.json` records256 source commits and153 stable patch groups. `resolution-table.json` records each final source file's accepted base PR/blob, merged inputs and exact content comparisons. `conflicts.md` explains every conflict and the two integration corrections. `storage-construction-variant.json` explains the older1146 construction variant. `verification-source-equality.json` verifies accepted storage/Events tooling bytes. Migrations314–317 coexist;315 retains official SHA2569bef87f804c7d734d92e9d461b04eb64ae085b30c846682a82f62f2667b38618.

## Checkout and checks

```sh
git fetch origin feat/game-all-integration
git switch --create game-all-test --track origin/feat/game-all-integration
bun install --frozen-lockfile
bun run typecheck
bun run --cwd packages/tm8-ui build
bun run --cwd packages/tm8-ui test src/game src/data/game-maps.test.ts src/story/game/map-model src/story/game/maps src/story/game/taskland-motion.test.ts
```

Start the application with `bun run dev` in your configured development environment. Open Game from a space or story. Check hub/Office Back, Taskland motion/progress/unread, Town placements, server resume after reload, live worker scopes and cancellation expiry. Test wide and560px layouts with workers present: open Places and Workers, click their actions, toggle/collapse the minimap, travel on minimap/scene gaps, and use E/Back.

Database suites require an explicitly configured test database cluster. Set `TM8_W1_ADMIN_DATABASE_URL` and `TM8_MIGRATION_DATABASE_URL` to its admin URL; run `bun run --cwd packages/server test test/db/game-maps.pg.test.ts test/db/task-cancellation-observations.pg.test.ts test/db/story-root-facts.pg.test.ts test/db/space-unread.pg.test.ts test/events/task-status-time-projection.pg.test.ts test/w2/tick-criteria.pg.test.ts`, `bun run --cwd packages/cli test test/map.test.ts`, and `bash tools/ci/migrations-check.sh`.

## Validation and limits

At draft publication,300 focused UI tests in29 files pass; combined core typecheck and regenerated conformance inventory pass. The initial UI typecheck caught duplicated loader declarations from shared patches; the single composed loader is fixed and its rerun is in progress. UI typecheck/build, isolated database/migration suites and CLI/conformance tests continue after publication. Exact results will be added in `validation.md` and the PR.

No native GPU hardware is available. Historical software/browser proofs covered separate heads and do not prove this aggregate. Full combined storage/Events/Taskland browser restart/performance acceptance and protected/manual release gates remain pending unless explicitly rerun. All real verification/tooling branches are included; Jira1128 and closed historical proof1138/1139 are excluded.1124–1126 are covered by1127.
