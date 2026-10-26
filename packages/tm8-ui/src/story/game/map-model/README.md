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
| Town | Completed tasks/sessions and their produced deliverables | Shipping Yard; user-authored placement is a future input |

Place ids equal real entity ids. Robot ids derive from real claim ids; one robot represents one active `working_on` edge, and several robots can share a session. Ended claims and sessions have no robot. `status`, `processState`, `outcome`, `endedKind`, `constructionStage`, and `progress` are separate. Accepted completion wins over a later process failure. Cancelled tasks remain rubble (and retain their prior plot when a cache exists); time-based rubble expiry requires an event/time input and is not implemented here.

Weighted `percent` becomes a 0–1 fraction at the projection boundary. Missing progress stays `null`. A done root is not recomputed as 100% subtree progress. Server `size` drives the building-size bucket. Per-kind adapter hooks can enrich asset, label, badges, attention and root mailbox, but cannot replace entity identity or graph state. Root mailbox counts aggregate the visible same-kind subtree; bounded StoryPage reads mark them approximate. Counts are message totals, never fabricated unread counts.

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

`model.test.ts` exercises all six maps, shuffled-input determinism, empty/orphan/cyclic inputs, five-level containment and building/sibling non-overlap, local status moves, root translation, freed-slot reuse, cancelled plot retention, multiple active claims, session outcome versus process state, query/StoryPage adapters, scope integrity, authoritative weighted progress, root mailbox aggregation, hooks, hex alignment, and 32 repeated varied-size status moves. The 1,000-place fixture must finish below 300 ms; the final separate local run measured 62.0 ms (1,000 places) after rectangle compaction. Timing is environment-dependent.

```sh
# From the UI package, or pass its absolute path to --root:
vitest run src/story/game/map-model/model.test.ts
```

Fixtures are synthetic and can be committed. Private imported workspace snapshots must remain local and must not be added to the repository or an exported preview.
