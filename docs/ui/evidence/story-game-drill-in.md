# Story map drill-in: Enter a child story, Inspect everything else

Open this evidence when reviewing the W5 drill-in PR, or when changing how the story game navigates into child stories, opens entity details, or handles Esc. It records the behaviour, the reproducible browser check and its limits.

Task: `01a1090f-eed3-7024-9fc8-e4ee91da78af`. Plan doc: `01a1090e-7ff7-7f6f-8e45-2249f6e4eaee`.

## Behavior

- **Portal (child story)**: the approach card says **Enter**. E, Enter/Space, the button, or the scene's open-on-arrival click call `enterStory` (`story/game/enter.ts`). It saves the child's view mode as `game` and pushes the child onto the navStore with `navStore.navigate`. When the parent is the routed entity, the route keeps its shape: the same `origin` and the same `full` flag, with the parent's `hops`/`kinds` filter dropped. So the host (`RoutedStoryHost`, keyed by entity id) swaps to the child and mounts it straight into its map. Anywhere else, the child opens in the full view (`e/{id}?full=1`), which is what the nav port's promote does for a kind with a full view.
- **Hub**: no action button; E does nothing.
- **Every other place**: **Inspect**. It calls the page's `open` port exactly as before and records the visit. Session duels still Inspect the session.
- **Aggregate places**: when a place carries `members` (the Library / Code Factory aggregates from the sibling unit), the card lists up to six members, each with its own Inspect, plus "and N more". The field is read defensively and is absent at this base.
- **Esc**: only when no duel is open and the story has a `page.parent`, and only on the page that routes to this story. Otherwise the host's own Esc (closing the beside panel, leaving the full view) is untouched. Esc saves the parent's mode as `game`. If the last navStore move was this drill-in, it calls `history.back()`, so history stays `[parent, child]`. On any other arrival (a link, a reload, a later navigation) it navigates up to the parent in the same route shape. The parent's StoryGame remounts from its own save, so the player stands where they left.
- **Flat (no-WebGL) world**: the same split. Portal rows carry the Enter verb and enter; other rows Inspect; aggregate rows list their members with Inspect.

## Browser check

Harness: `packages/tm8-ui/e2e/story-drill-harness.html`. It renders the story page for whatever entity the navStore routes to, and mirrors navStore pushes into browser history and popstate back into the store, which is the slice of GateApp's URL sync this round trip needs. Script: `packages/tm8-ui/e2e/story-drill-audit.mjs`.

```
cd packages/tm8-ui && bun run dev --host 127.0.0.1 --port 4781 --strictPort
LD_LIBRARY_PATH=… DRILL_BROWSER=…/chromium-1243/chrome-linux64/chrome DRILL_THEME=light node e2e/story-drill-audit.mjs   # and DRILL_THEME=dark
```

Both themes passed with no page errors:

| Step | Result |
| --- | --- |
| Walk to portal "Story so far: the daily recap" | approach card button `Enter E` |
| Press E | route `{view:'entity', entityId:'fx-cs1', origin:null, full:true}`, child mode `game`, child map renders |
| Walk to a child root with a live session, Esc | duel closes, still in the child |
| Inspect | `open → fx-r1` through the page port |
| Esc | route back to `fx-story`, mode `game`, parent save `(-59.87, 2.60)` unchanged, `history.length` unchanged (3), player standing at the portal again |
| Enter again, then browser Back | parent story |

Screenshots (light and dark): tm8 artifact `01a10931-1f20-76ff-885d-7718f98afd9e` ("Story map W5 drill-in evidence", v1). The original PNGs and JSON reports are in the worker's scratch `evidence/` directory.

**Rendering:** all captures used SwiftShader software rendering in headless Chromium (`--enable-unsafe-swiftshader`). They are not GPU evidence, and no frame rate or timing is claimed.

## Limits

- The member list has unit coverage only (a grafted `members` field in `StoryGame.drill.test.tsx`). No browser capture yet, because the aggregate places do not exist at this base.
- With an Inspect panel open beside the map, Esc pressed inside the map climbs to the parent story instead of closing the panel first. The panel's own close control still works.
