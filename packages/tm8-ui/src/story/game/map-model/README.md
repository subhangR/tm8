# Entity map model

Open this module when changing map inputs, entity routing, nested placement, or adding a renderer. It is a pure UI derivation; it creates no domain entities and changes no server state.

```ts
import { fromStoryView, buildMapModel } from './map-model';
const input = fromStoryView(storyView);
const model = buildMapModel(input, {
  type: 'taskland', scope: { kind: 'story', id: storyView.id }, previous,
});
```

`MapRendererProps` accepts the model plus entity-selection and portal-navigation callbacks. `MapRenderer<Result>` lets React return a ReactNode without importing React into this module. The R3F implementation lives in the sibling `maps` directory. `fromProjection(unknown, scope?)` also accepts normalized `{entities, edges}`, graph `{nodes, edges}`, query rows with `state`/`content`/`props`, and `{id, kind: 'story', page: StoryPage}` snapshots. Source scope takes precedence over a conflicting requested scope and produces a warning. The model preserves snapshot-depth and truncation warnings; it does not claim a bounded story import is a whole-space live view.

## Map semantics

| Map | Real places | Grouping |
| --- | --- | --- |
| Hub | No invented buildings; map landmarks are `decor`, destinations are `portals` | Typed destinations and actual child-story portals |
| Taskland | Tasks; shipped parents with open children retain a marker with their real id | Repeated status yards inside each compound |
| Office | Sessions, staff, skills; completed sessions leave | Proposed process/outcome lanes, explicitly labelled |
| Library | Docs, drawings, artifacts, files | Generic nested collections, no task-status districts |
| Factory | Projects, PRs, commits, worktrees | Generic nested collections, no task-status districts |
| Town | Completed tasks/sessions and their produced deliverables, each independently | Shipping Yard and optional persisted Town placements |

Place ids equal real entity ids. Robot ids derive from real claim ids; one robot represents one active `working_on` edge, and several robots can share a session. Ended claims and sessions have no robot. Claim statuses `working`, `waiting`, `blocked`, and legacy missing status are accepted. A blocked task drives a blocked pose. An authoritative session outcome `open` overrides an obsolete `endedKind` after reopening; a terminal process still prevents a robot. The loader checks all admitted session rows, including story trail nodes absent from the bounded session preview. `status`, `processState`, `outcome`, `endedKind`, `constructionStage`, and `progress` are separate.

`taskConstructionProgress` implements Design Rules §9 over the admitted task forest: `w=pointsEstimate ?? 1`, criteria contribute `completed/total`, criteria-free parents exclude their own weight from the progress denominator, and cancelled child subtrees have weight zero. Size includes the parent's own weight. Done task progress is always 1, including done tasks with open descendants. Server aggregate percent is preserved on input but has different semantics. Zero total weight uses own completion when available, otherwise zero. Size rounds upward to Fibonacci buckets 1, 2, 3, 5, 8, 13 (capped at 13). A missing estimate adds a tent marker without changing construction stage. Stage comparisons use exact fractions at .34, .67, and 1: 2/3 remains scaffolding and .999 remains walls.

Summary rows hide `pointsEstimate` but expose `acceptance`, `progress.own`, `progress.tent`, and subtree `size`. Only `MapInput.taskHierarchyComplete=true` permits recovering a hidden own estimate from subtree size minus direct-child sizes. The loader asserts this for fully paged space primary reads. Bounded story imports leave it false; hidden estimates then retain authoritative aggregate progress/size with an explicit approximation warning. Explicit estimates and missing-estimate tents use the Design Rules calculation directly. Cycles are repaired consistently with the layout forest.

Root mailbox counts aggregate the entire admitted same-kind task forest, including shipped children and expired rubble. `basis` identifies `messages` or `unread`; this loader supplies message totals until a separate unread reader joins viewer-specific counts. Mixed bases downgrade to approximate message counts, never an unread claim. Missing contributors and bounded StoryPage reads make the aggregate approximate. Adapter mailbox/attention enrichment replaces only the root's own contribution; descendant totals survive. Required lifecycle/tent badges survive custom badges.

## Lifecycle, events and storage boundary

`BuildMapOptions.now` injects epoch milliseconds; omitted clocks sample `Date.now()` once. `MapEntity.cancelledAt` must be an authoritative timezone-bearing cancellation instant. The projection maps task `state.statusChangedAt` to it only while cancelled (`state.workStatus` and summary `state.status` are both accepted). `updatedAt`, `createdAt`, and reload time never become cancellation dates. Known rubble disappears exactly at cancellation + 24 hours. When exact evidence is absent, `cancelledNotAfter` carries a proven upper bound from the entity's `updatedAt`: the database task-update trigger always advances that timestamp on status changes. Such rubble can safely leave by upper bound + 24 hours, but never before it. A later title edit pushes this conservative deadline later. `MapPlace.rubbleRemovalNotAfter` exposes that bound separately; `rubbleExpiresAt` and `cancelledAt` stay null and the unknown-time badge remains. Exact evidence always wins. Without either form of evidence, rubble remains with a warning. An immediately previous rubble model can retain known exact evidence; reopening clears lifecycle state. `MapModel.nextLifecycleAt` is the earliest future exact or conservative removal deadline, or null. Events own scheduling and rebuild at that time; this module starts no timers or mutations. Optional entity `version`/`updatedAt` and edge `updatedAt` remain available for replay guards.

Done tasks and completed sessions enter Town immediately. A done child building ships independently. While open grandchildren or unexpired rubble remain, only its foundation marker stays in its old yard; this is the recursive interpretation of the root-marker rule, approved by the Taskland coordinator. Markers have no robots and only root markers have mailboxes. The last descendant's shipping or rubble expiry removes the marker. With a previous model, terminal lots retain their prior group/slot. A cold load uses event-provided `terminalFromStatus`, or deterministic To-do when historical lot evidence is unavailable; there are no dedicated cancelled/shipped districts. Exact historical coordinates require an existing layout cache.

Town lays out shipped entities independently (`parentId=null`). Active `produces` edges from done tasks admit only already scoped library items. `MapInput.townPlacements?: readonly TownPlacement[]` supplies authoritative `{entityId,x,z,actorId?,layer?}` positions. Finite placements apply only to admitted shipped entities and are respected even when overlapping (with a warning). Unplaced buildings keep stable Shipping Yard slots clear of placed buildings. Unknown, invalid and reopened placements do not admit entities; source placements remain untouched for storage to retain. Other map types ignore Town placements.

Town's `shippingYard` supplies fixed `position:{x:0,z:-12}` and `waitingIds`, the single source for the waiting count. Gate bounds are included even in an empty Town. Storage/UI owns expiry/permission filtering, actor/layer provenance and editing. Durable map identity, route state, walking resume and animations remain outside this model. The loader keeps scoped primary rows authoritative and makes one bounded relations read; graph-only rows never become map membership.

Dependency `roads` represent only actual `depends_on` edges. `paths` are explicitly decorative. Roads currently provide endpoint polylines; obstacle-aware routing is a renderer/future routing concern. Unknown semantic asset keys must use a visible renderer fallback rather than creating a fake domain object.

## Layout and stability

`layoutForest` repairs missing/self parents and breaks a cycle at its lexically smallest id. It processes the forest iteratively, sizes child compounds bottom-up, and translates them top-down. Deterministic ordering is group, descending creation order, title, id. Positions use an axial hex lattice with a common three-unit pitch.

Each parent owns an independent cache of occupied and vacant slots. `BoundsIndex`, a spatial hash over rectangles, performs nearby compound collision checks. A parent's own building occupies a header; child parcels pack below it. Slots use each compound's own width/height, rather than giving all siblings the largest circle's pitch. Existing unchanged slots are inserted before moved/new nodes. Status moves use reserved local horizontal offsets, and eligible vacancies are reused before adding a new parcel. Moving a root preserves descendant local offsets. Cache use requires the same map type and scope. Structural growth may move the enlarged compound to avoid overlap; repeated status-only changes preserve unrelated positions.

**Geometry refinement from the original circular layout:** `radius` is the physical building circle, `compoundBounds` is the world-space rectangular occupied/reserved subtree parcel, and `footprint` is a conservative diagnostic circle radius. Collision placement, group boundaries, and map bounds use rectangles. Keeping circles for collision placement caused exponential empty space in unary nesting; header rows make depth growth linear instead. Renderers should draw `compoundBounds` for hierarchy/footprint overlays, not square `±footprint`. Ancestor parcels intentionally contain descendants; sibling parcels and actual building circles do not overlap. Status groups repeat locally; their enclosing display rectangles can overlap empty space between group members, so a group rectangle is not a solid collision obstacle.

Final measured extents (world units, rounded), using a local private StoryPage snapshot of 209 source nodes / 412 edges at follow depth 3. The snapshot itself is not committed. All five entity maps passed a separate exhaustive building/sibling-parcel non-overlap and parent-containment audit.

| Input / map | Places | Width × depth |
| --- | ---: | ---: |
| Small fixture / Taskland | 7 | 62 × 67 |
| Depth-five fixture / Taskland | 12 | 176 × 90 |
| Snapshot / Hub | 0 (5 portals) | 42 × 37 |
| Snapshot / Taskland | 38 (4 robots) | 136 × 327 |
| Snapshot / Office | 62 | 159 × 321 |
| Snapshot / Library | 47 | 70 × 129 |
| Snapshot / Factory | 23 | 27 × 75 |
| Snapshot / Town | 48 | 61 × 152 |

Dense overviews still need progressive labels and entity/subtree camera focus. The underlying snapshot is bounded, not a complete whole-space hierarchy. Rectangle placement is a visual-foundation implementation, not a migration of the retained walking renderer.

## Verification

`model.test.ts` retains six-map, determinism, containment, stability, collision and performance checks. `progress.test.ts` checks weighting, criteria, cancelled descendants, completeness, zero weights and Fibonacci buckets. `lifecycle.test.ts` drives both scopes through status yards, child/root shipping, nested markers, 24-hour expiry, reload, reopen/recancel, growth and stable neighbours; it checks exact fractions and claim completion/reset/resume. `shipping.test.ts` verifies independent shipping, persisted positions, collision avoidance, waiting ids, reopened placement retention and full-forest mailboxes. `data/game-maps.test.ts` verifies normalized task/session evidence and real story claim admission without expanding read budgets. Walking tests retain local-resume/collision coverage. The 1,000-place fixture must finish below 300 ms; timing depends on the environment.

```sh
# From the UI package, or pass its absolute path to --root:
vitest run src/story/game/map-model src/data/game-maps.test.ts
```

Fixtures are synthetic and can be committed. Private imported workspace snapshots must remain local and must not be added to the repository or an exported preview.
