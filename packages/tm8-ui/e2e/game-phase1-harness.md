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

Run the scripted journey with `node e2e/game-phase1-check.mjs`. Set
`GAME_CHROMIUM` to an installed browser executable, `GAME_EVIDENCE_DIR` to an
output directory and `GAME_HARNESS_URL` when the dev server uses another port.
The runner repeats the journey with WebGL and with WebGL disabled. It checks
all typed portals at both scopes, E inspection with the renderer focused,
Escape overlay ordering, nested Back, and exact position/camera/stack reload.

Real-space measurements (2026-10-08, authenticated Seam, cold type-hinted
reads):

| Map | Records | Query pages | Graph reads | Time |
| --- | ---: | ---: | ---: | ---: |
| Hub | 21 | 1 | 0 | 2.7 s |
| Taskland | 902 | 5 | 1 | 7.1 s |
| Office | 440 | 3 | 0 | 0.8 s |
| Library | 1,569 | 8 | 0 | 6.5 s |
| Code Factory | 301 | 2 | 0 | 0.6 s |
| Completed Town | 2,971 | 15 | 1 | 14.3 s |

Each scope also performs one spaces read. There are no per-entity connections
reads. The bounded graph contributes only relations among admitted primary
endpoints; it does not decide story membership or add places. The existing
server bounds graph reads to 200 nodes and 1,000 edges with no cursor. Reaching
either budget displays a warning that some roads, workers or deliverables may
be absent. Paged primary records and their hierarchy remain available.

Phase 1 has no per-scope fetch cache, so returning to a map repeats its reads.
Synthetic harness timing does not predict real-space load time. Before the
bounded relation change, a complete space read took 23.1 s and 902 connection
requests. These timings are observations from this node, not GPU benchmarks.
