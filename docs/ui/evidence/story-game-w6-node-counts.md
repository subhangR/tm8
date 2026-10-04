# Story map W6 — StoryPage per-node counts (evidence)

Server/contract only; no pixels. Task 01a1090f-f0ec-7c9d-9513-8bc9f264820d, branch
`feat/story-page-node-counts`, base `main` 6427de72 (PR 1039 merged).

## Field

```ts
StoryNode.counts?: { messages: number; pendingAttention: number }   // StoryNodeCounts
StoryNodeCountsSchema  // zod, strict, non-negative ints
```

- `messages`: rows of `public.messages` anchored on the node, `redacted_at is null`,
  message entity `deleted_at is null` — the recentMessages window's predicate, no window.
- `pendingAttention`: `public.attention_requests` with `entity_id = node` and
  `status in ('open', 'acknowledged')` — the predicate `internal.story_summary` (289)
  uses for `StoryState.pendingAttentionCount`, so the nodes sum to the summary.
- Optional: pages from a server without this change carry no `counts`; readers treat
  `undefined` as unknown, not 0. The running production server does not carry it until
  the owner deploys.

## Server

Two set-based queries in `packages/server/src/facade/story-page.ts`, after the
recentMessages window: `group by m.anchor_id` over `feedAnchorIds`, `group by ar.entity_id`
over every page id. No per-node loop. `recentMessages` (limit 50), `feedAnchorIds` and every
other output are unchanged.

## Verification (2026-10-04, local scratch Postgres 16 on port 5455, migrations applied clean)

```
bun run typecheck:core            ok
bun run typecheck:ui              ok (fixture untouched: the field is optional)
packages/contract: vitest run     19 files, 459 tests passed (incl. test/story-node-counts.test.ts)
packages/server:   vitest run test/db/story-page-node-counts.pg.test.ts
                              test/db/story-progress-kinds.pg.test.ts
                              test/db/story-rollup-scope.pg.test.ts
                              test/db/story-stale-progress.pg.test.ts
                                  4 files, 23 tests passed
```

The new facade test seeds a node with 2 live + 1 redacted + 1 deleted message, a node with
open + acknowledged + resolved + dismissed requests, and a node with only a resolved request;
asserts `{2,0}`, `{0,2}`, `{0,0}`, the story node `{1,0}`, the summary total, the unchanged
recentMessages order, and that exactly two grouped queries ran.

## Worktrees in STORY_FOLLOWED_EDGE_TYPES (report only, not implemented)

Edge: `in_worktree`, src kinds `task | work_session | pull_request | commit`, dst `worktree`
(migration 057; origin-stamped, not recorder-owned, no unique index — several sessions may
share one worktree). Not cheap as a contract-only change: `internal.story_trail` (283:396)
hardcodes the followed list as a SQL constant, so it needs a new migration replacing that
function (shared object), plus the contract constant, a `STORY_EDGE_FAMILY` entry (`code`)
and a UI view for the `worktree` kind. Risk: the trail follows edges in both directions, and
a worktree is a fan-in point — following it inward would pull sibling sessions and tasks from
other stories into this trail and spend the 500-row limit. Recommend following it OUTWARD only
as a leaf (reached, never walked out of), the ruling already applied to reactions and access.
