Run `bun run dev -- --port 4631` from `packages/tm8-ui`, then open
`http://127.0.0.1:4631/e2e/game-phase1-harness.html`.

This harness mounts the real GateApp, GameMode and walking renderer. Synthetic
records live only in this harness; the Game loader executes cursor-paged read
ports, including two-row pages for hierarchy and story queries. The production
loader has no fixture fallback. Read `window.__phase1GameHarness.queries` to
inspect the queries and verify scope after entering each story.

1. Choose Game from Work's view selector. Confirm the address remains `/game`.
2. Walk to Taskland, Office, Library, Code Factory and Completed Town, entering
   each portal and returning to the space hub with one-level Back or Escape.
3. Inspect an entity. Its existing detail panel opens beside the map. Escape
   dismisses the panel first and the selected map stays mounted.
4. Enter Harness story, visit all five typed maps, then return to its hub.
5. Enter Nested harness story and check Back returns to the parent story hub.
6. Walk, change the camera, then reload. Check the selected map, player,
   camera and return path restore. Leave for Work and choose Game again.
7. Repeat with WebGL disabled to exercise the renderer's accessible fallback.

Take screenshots of the hub, a typed map and its detail panel. Record browser
console failures and the renderer used. Software-renderer screenshots verify
appearance and interactions; they do not establish native GPU performance.
