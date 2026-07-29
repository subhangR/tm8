# Design-Surface Coverage Audit (Opus 5, read-only)

Mission: enumerate every surface the design suite draws, and report which are NOT implemented (or only partially implemented) in `packages/tm8-ui`. You are an auditor: read-only everywhere except your one report file. No git, no servers, no browser driving (a live user session is running — do not disturb it).

## Inputs
- **The design suite (authoritative)**: `/Users/subhang/Desktop/Projects/tm8/T0-1 workspace structure review (1)/*.dc.html` — 18 canvases: T0-1 Wireframes + Hi-Fi (master screen), T0-2/T0-5 (terminal + live bar), T0-3 (list panel), T0-4 (detail panels, all kinds), T1-1/T1-2 (menu rail + palette), T1-3/4/5 (responsive/honesty/stacking), T2 (settings/trust/authoring), T3 (auth/onboarding), T3 (files/node/inbox), T3-3 (account menu), T4 (state matrix), T5-1 (home), T5-2 (board/feed/gallery), T5-3 (doc authoring), T5-5/6 (launch + teammate authoring), T5-7 (discussion body), T10 (chat surface). Extract each canvas's SURFACES (screens, panels, modes, states) — not every pixel, but every distinct thing a user could see or do.
- **The implementation**: `packages/tm8-ui/src/**` (committed + uncommitted working tree — audit the tree as-is and record `git log -1 --format=%h` as your snapshot marker; the tree is moving: five detail-body workers are actively adding task/doc/teammate/session/channel bodies and a graph screen exists in src/graph/). `packages/tm8-ui/DECISIONS.md` and `GATE-REPORT.md` tell you what was consciously ruled.
- **Ruled-deferred (report as DEFERRED, not missing)**: undo/version-history/handoff-withdraw (T5-4 was never designed), leaderboard/awards, saved-views/axes control, search results view, session Terminal|Chat switch (seam reserved), server rail (build exists as menu rail only), NEEDS YOU + presence signals (designed-but-dormant states). Graph canvas was deferred but is NOW ACTIVE (src/graph/) — audit it as in-scope.

## Output
Write ONE file: `docs/plans/tm8-ui-orchestration/DESIGN-SURFACE-AUDIT.md`:
1. A summary table: surface → canvas source → status (IMPLEMENTED / PARTIAL / ABSENT / DEFERRED-BY-RULING) → evidence (file path or absence).
2. Per-canvas sections listing each surface with one-line status + what specifically is missing for PARTIAL.
3. A ranked "not touched at all" list — the surfaces with zero implementation trace, ordered by user-visible importance.
4. An honest coverage statement: what your method can and cannot see (e.g., you assess presence, not pixel fidelity; the parity sweep owns fidelity).
Method notes: search the src tree by component/feature names AND by behavior (registry entries, routes, menu refs); a surface counts IMPLEMENTED only if it is reachable (wired into a route/menu/panel), not merely a file that exists — state reachable-vs-file-exists explicitly where they differ.
Report completion via `maestro task report complete` with the file path + the top-5 absent surfaces in one line each. Do not prompt other sessions.
