# Combined Game test candidate

Draft PR [1151](https://github.com/subhangR/tm8/pull/1151), branch `feat/game-all-integration`, combines all 21 current Game and prerequisite inputs on main `42cd170ced7967b44d4195fc8201c77b58e58f74`. It is available for local testing while full combined CI runs. It is not a protected release acceptance or authorization to merge/deploy.

[source-manifest.json](source-manifest.json) freezes every included, covered and excluded PR/head and records a final refresh. [commit-coverage.json](commit-coverage.json) records 256 source commits and 153 stable patch groups. [resolution-table.json](resolution-table.json) identifies each source file's accepted base PR/blob, merged inputs and content comparisons. [conflicts.md](conflicts.md) explains reviewed resolutions and contract corrections. [storage-construction-variant.json](storage-construction-variant.json) accounts for the older 1146 construction variant. [verification-source-equality.json](verification-source-equality.json) checks accepted storage and Events rig bytes. [generation.json](generation.json) records measured inventories and generator hashes. [validation.md](validation.md) records passing checks, genuine failures and remaining limits.

Migrations 314–317 retain their canonical blobs. Migration 315 SHA256 is `9bef87f804c7d734d92e9d461b04eb64ae085b30c846682a82f62f2667b38618`. Original 1124–1126 are covered by 1127. Unrelated Jira 1128 and closed historical proof 1138/1139 are excluded.

## Checkout and local testing

Use a new worktree to keep an existing checkout untouched:

```sh
git fetch origin feat/game-all-integration
git worktree add -b game-all-local ../game-all-local origin/feat/game-all-integration
cd ../game-all-local
bun install --frozen-lockfile
bun run typecheck
bun run --cwd packages/tm8-ui build
bun run --cwd packages/tm8-ui test src/game src/data/game-maps.test.ts src/story/game/map-model src/story/game/maps src/story/game/taskland-motion.test.ts
bun run dev
```

Run the app in your configured development environment. Open Game from a space or story. Check hub/Office Back, Taskland construction/motion/progress/unread, Town placements, durable resume after reload, live worker scopes and cancellation expiry. At wide and 560px layouts with workers present, open Places and Workers, click their actions, collapse/reopen the minimap rapidly, travel on minimap/scene gaps, and use E/Back. The rapid-toggle observation remains unexplained.

For database suites, point all three variables below at an isolated test cluster with a database-creating admin role:

```sh
export TM8_W1_ADMIN_DATABASE_URL=postgres://USER@HOST:PORT/postgres
export TM8_W4_ADMIN_DATABASE_URL="$TM8_W1_ADMIN_DATABASE_URL"
export TM8_MIGRATION_DATABASE_URL="$TM8_W1_ADMIN_DATABASE_URL"
bash tools/ci/migrations-check.sh
bun run --cwd packages/server test test/db/game-maps.pg.test.ts test/db/task-cancellation-observations.pg.test.ts test/db/story-root-facts.pg.test.ts test/db/space-unread.pg.test.ts test/events/task-status-time-projection.pg.test.ts test/w2/tick-criteria.pg.test.ts
bun run --cwd packages/cli test test/map.test.ts
```

The optional combined HUD harness renders production WalkingMapView with synthetic worker data:

```sh
bun run --cwd packages/tm8-ui dev --host 127.0.0.1 --port 18653 --strictPort
# In another terminal, from the repository root; requires Playwright Chromium:
COMBINED_HUD_URL=http://127.0.0.1:18653/e2e/combined-hud.html node packages/tm8-ui/e2e/combined-hud-check.mjs
```

Set `COMBINED_HUD_CHROMIUM` to an installed Chromium path if needed. This is a software smoke check, not native GPU performance or full combined live-server browser acceptance. Historical lane proofs do not transfer to this tree.

The manifest's `integrationSourceHead` is the final source commit; the subsequent handoff commit changes only documentation. To inspect any input's composition delta, run `git diff <manifest-head-SHA> <integrationSourceHead> -- <file>` using the per-file resolution table. All included head objects are retained in merge ancestry.
