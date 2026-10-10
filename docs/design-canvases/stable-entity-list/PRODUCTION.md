# Shared entity placement — production review

PR #1118 now includes production integration. Migration
`313_shared_entity_placement.sql` keeps `entities.parent_id` and
`entities.position` as the authoritative shared placement. The prototype's
localStorage order is not used by production.

## Behavior and implementation

- New roots and children prepend within their space/kind/parent sibling set.
  Placement writes serialize with a transaction advisory lock per space. Normal
  status, activity, unread and session lifecycle writes do not change placement.
- `entities.move` accepts either a legacy numeric position or a relative
  `placement: { targetId, relation: 'before' | 'after' | 'inside' }`, with
  `expectedVersion` and the existing mutation envelope. `parentId` remains
  required for compatibility; relative requests resolve their parent on the server.
  Null target plus `inside` means first at the root.
- The new authorized `move_entity_relative` RPC resolves neighbors against the
  complete sibling set under the lock. It rebalances exhausted floating point
  ranks while preserving `(position,id)` order. Membership, replay binding,
  expected versions, same-kind/space parents and cycle guards still apply.
  Moving a parent keeps every descendant attached. Session moves change entity
  placement without mutating the execution row or session lifecycle.
- Existing durable entity events publish placement and maintenance updates.
  Loaded client projections re-sort by position after upserts. Collection
  queries default to position, including filtered queries. A per-space revision
  invalidates position cursors after moves/rebalancing; the UI reloads the loaded
  prefix and then continues. Continuous concurrent moves can cause a visible
  retry error instead of silently omitting rows.
- The All tab and Manual order are the defaults. Status tabs and explicit
  alternative sorts remain available. Manual session lists have no lifecycle
  grouping. Filters, including Needs me, preserve position and do not write
  or replace placement; attention priority does not reshuffle the filtered list.
- Existing production card components, controls and styles are retained.
  Movement attaches to the surrounding tree: 450 ms long press, an 8 px
  pre-pickup scroll threshold, upper/lower edges for before/after, center for
  nesting, Escape/blur/pointercancel to cancel. Interactive card controls never
  initiate pickup. No dotted grips are added.
- Move selected, context menu/Shift+F10, Move up/down, Indent/Outdent and
  Alt+arrows provide explicit alternatives. The parent picker describes its
  loaded-row scope; the database validates the complete tree. Placement is
  disabled during search and when an explicit non-position sort is selected.
- Title-only creation opens the detail draft immediately and focuses an inline
  title. Inline, detail and tab titles share the existing draft store. Save/Enter
  creates one titled entity; blank submission and Escape create nothing. Add
  child appears only where the capability permits it. Session launch, file
  upload and other specialized composers retain their existing creation paths.

## Validation

All database runs used an isolated PostgreSQL cluster on loopback port 55439.
Production was neither migrated nor deployed.

- Full migration replay, static migration checks and the identity-reader gate pass.
- Database placement suite: 5 tests pass (concurrent inserts/moves, two identities,
  subtree/cycle/kind/space safety, precision maintenance and session stability).
- Server placement/event/pagination suites: 18 tests pass, including two
  independent authorized database/event clients and an unauthorized reader.
- Focused UI suites: 312 tests pass across 11 files, including card DOM equality,
  pointer/menu/keyboard behavior, live client projections, pagination recovery,
  registry defaults and draft/title synchronization.
- Contract suite: 484 tests pass. Core/UI TypeScript checks and the production
  UI build pass. Prototype model/DOM suite: 7 tests pass.
- Full UI run: **7,952 passed, 5 failed, 5 skipped; 1 unhandled error**, across
  573 files (569 passed, 3 failed, 1 skipped), in 519.63 seconds. The remaining
  failures and error are the baseline issues detailed below.
- Additional checks for the final changes: interaction/draft suite **10 passed**;
  attention/placement/filter suite **62 passed**; workspace wiring **4 passed**.

The wider UI run and baseline comparison are recorded in the PR validation
receipt. Five existing failures reproduce in a separate, untouched worktree at
starting commit `3fa20e7e4a1d9ee5b77db38d3434a4fd33bf7a2c`:

| Test | Baseline evidence |
| --- | --- |
| `data/real/seam-real.test.ts` command inventory | Actual commands also contain `createEntityKind` and `updateMenu`. |
| `panels/detail/launch-context-section.test.tsx` launch order | The first section is `CHILDREN · 4`; the assertion expects `LAUNCH CONTEXT · 7`. |
| `panels/no-branching.test.ts` kind literals | Existing `linksModel.ts` / `linksViews.tsx` literals fail the guard. |
| `panels/no-branching.test.ts` kind comparisons | Existing `linksModel.ts` / `linksViews.tsx` comparisons fail the guard. |
| `panels/no-branching.test.ts` layout floors | Existing `panels.css` contains `minmax(0,…)`. |

The baseline comparison command (from `packages/tm8-ui`) was:

```sh
bun run test src/data/real/seam-real.test.ts src/views/gate.test.tsx src/files/port-seam.test.tsx src/panels/detail/launch-context-section.test.tsx src/panels/no-branching.test.ts --maxWorkers=2
```

Result: **64 passed, 5 failed, 1 skipped** across five files. Separately,
`bun run test src/panels/detail/instant-arrival.test.tsx --maxWorkers=1` on the
same baseline yields **4 passed and 1 unhandled error**:
`TypeError: target.getClientRects is not a function` from ProseMirror in jsdom.
None of the offending production files above is changed by this implementation.

Chromium still fails during page navigation on this host (frame detached /
ERR_ABORTED), including after supplying its missing libraries locally. No
browser screenshot, layout, touch-device or drag-smoothness verification is
claimed. Pointer behavior and exact card DOM preservation are tested in jsdom;
the two-client checks exercise real PostgreSQL and the durable event projector.

### Reproduce the focused checks

After `bun install --frozen-lockfile`, use a **disposable test database** with
the migrations applied. The example URLs below are the isolated cluster used
for this review, not the production server.

```sh
TM8_MIGRATION_DATABASE_URL=postgres://tm8@127.0.0.1:55439/postgres bash tools/ci/migrations-check.sh
TM8_DATABASE_URL=postgres://tm8@127.0.0.1:55439/placement_test node --test db/test/entity_placement.test.mjs
bun run typecheck
bun run test:contract
cd packages/server
TM8_W1_ADMIN_DATABASE_URL=postgres://tm8@127.0.0.1:55439/postgres bun run test test/db/shared-entity-placement.pg.test.ts test/events/projector-entity-read-parity.test.ts test/w2/collections-total-elision.test.ts
cd ../tm8-ui
bun run test src/panels/list/entity-placement.test.tsx src/tab-workspace/view/inline-draft.test.tsx src/views/reload-list-prefix.test.ts src/domain/registry.test.ts src/data/project/projection.test.ts src/panels/list-band-scope.test.tsx src/panels/panels.test.tsx src/tab-workspace/adapters/instant-kinds.test.ts src/panels/list-sort-filter.test.tsx src/panels/session-tabs.test.tsx src/settings-credentials/mounted.test.tsx --maxWorkers=3
```

## Two-user review steps

1. Run this branch and migration on a test instance. Sign in as two different
   authorized users of the same space in separate browser profiles. Open Tasks
   and Sessions in All / Manual order on both.
2. Create two roots and two children. Each new row should be first among its
   siblings on both clients. New should immediately open the detail draft;
   type in each title field and verify the other field and tab follow. Save
   once, and test blank submission and Escape cancellation separately.
3. Move a parent with a child and grandchild using long press. Both clients
   should show the same placement; reload both to verify persistence. Try
   Move selected, Shift+F10 and Alt+arrows. Existing card buttons should retain
   their original behavior; quick clicks and scrolling should not drag.
4. Reparent a session beneath another session. Verify its execution, content,
   controls and descendants remain intact. Trigger activity/unread changes,
   rename it, and change work/lifecycle status: its parent and position should
   remain unchanged in All.
5. Filter a list containing more than one page, load more, move a row from the
   other client, and load more again. The final filtered order should match a
   fresh reload without duplicate or missing rows. Remove filters and confirm
   the same underlying manual order.
6. Make competing moves from both users. Stale expected versions should report
   a refusal without an optimistic reshuffle. Try a descendant as a parent;
   it must refuse. The database suites also exercise cross-kind/space targets
   that the UI does not offer.
7. On a working Chromium installation and a touch device, verify the 450 ms
   hold, scroll-before-hold cancellation, drop previews, Escape, native touch
   context menus, narrow layouts and unchanged card visuals.

The branch is for user testing. Do not merge or deploy as part of this task.
