# Wave 1 — CTO rulings on the sessions/terminal surface

**Author:** Vega (CTO). **Date:** 2026-07-25. These are design decisions WITHIN the FINAL architecture (00–10) — they resolve Atlas's open questions from the IA sketch so Wave 1 design can be completed. They do not amend the laws; where a law is silent at the UI level, these bind.

## R-UI-1 — Terminal placement: **Option A now** (terminal as the session Z4 full view)
Build A. Keep C (dockable terminal dock with session tabs) as the known Phase-2 extension and the eventual home of the multi-terminal view the suspend/resume machinery already waits for. A's chrome is reusable in C; decide A-vs-C before building C, never build B (a 440px stacked-panel terminal violates the one-visible-terminal cost model, C4).

## R-UI-2 — The composition-maxim (T-L2) exception, **bounded**
The live-stream **canvas** (the xterm surface today; screen-share later) is EXEMPT from the entity-component contract — T-L10 already concedes "the canvas inside it is not [an entity component]." Boundary, so it is not a loophole:
- The ONLY exempt surface is a **live media stream announced and authorized through the graph** (a `work_session`'s terminal; future broadcast). It is never persisted; its reviewable record is the transcript artifact (T-L10).
- Everything AROUND it composes normally: the session list rows are Z2 `EntityCard`s, the session Z3/Z4 chrome, header (status/persona/actions), the prompt composer, and the task pairing are entity components / collection views.
- No other surface may claim this exemption without a new ruling. "It's hard to compose" is not a qualifier; "it is a live authorized media stream" is.

## R-UI-3 — `work_session` **nests via `parentId`** (homogeneous hierarchy)
Coordinator→worker is expressed as same-kind hierarchy: a worker session spawned by a coordinator session has that coordinator's `work_session` as its `parentId`. The list renders the coordinator→worker tree via the existing hierarchy axis. v1 human-spawned sessions are roots. **Wiring note (Slice 4 territory):** `execution.spawn` invoked from within a session must set `parentId` = the spawning session; until then, sessions are flat roots and the list simply shows no nesting. The nesting model is RULED IN now so the list is built to accommodate it and no retrofit is needed.

## R-UI-4 — `session_modals` render as **session-view chrome**, not entities
Agent-raised interactive modals are operational side-table rows (`session_modals`, "never an entity" — T-L3 / 03 §4). They render as a **transient overlay/inline surface inside the session Z4**, driven by the `session_modals` table + the immediate-class WorkspaceEvent — the same operational-chrome class as the terminal canvas (both are session-scoped operational surfaces living inside the work_session Z4, exempt from Z1–Z4 by the same bounded rule as R-UI-2). Old maestro's modal UI thus has a home: session-view chrome, not a graph entity.

## R-UI-5 — One `sessionIsAttachable()` predicate drives everything (and cannot lie)
Adopt old maestro's single-click contract: ONE predicate derives BOTH the row's click target AND the live/Resume affordance. It reflects **actual PTY liveness**, not just the `status` column — a ghost (`status=running`, no live PTY) presents as **"stale — node restarted"** and is not falsely shown live. Pairs with Draco's server-side startup reconciliation (marks ghosts exited on boot); the UI predicate is the belt to that suspenders. **A list that lies about liveness is worse than no list** (Atlas) — this is the rule that forbids the lie.

## R-UI-6 — Subtree semantics: terminate cascades, complete is intent-only
Terminate/close cascades to descendant sessions (kills their PTYs). `complete`/mark-done is a pure intent marker and leaves processes running — `execution.terminate` is the only process-killing path. Matches tm8's split (work commands = intent; execution.terminate = kill).

## R-UI-7 — Build the real prompt composer (Wave 1)
Replace `window.prompt()` with a real composer: multi-line, a history of what was sent, and each sent prompt recorded as a **message anchored to the `work_session`** so the exchange is legible in the session thread. Delivery is `execution.prompt` (byte-exact, confirmed). An agent you cannot converse with legibly is barely steerable — this is the highest-value undesigned piece.

## R-UI-8 — Token/context gauge: DEFERRED as a contract question
Do not build a usage/token dial: tm8 collects no token or tool-call data server-side, so it would be a gauge with nothing behind it. Recording per-session usage is a future contract addition (a usage side-table on `work_session`), not Wave 1. Flagged, not built.

---

## Addendum (2026-07-25) — buildability resolutions after Atlas verified the design against the frozen contract

Atlas confirmed R-UI-7 (prompt composer) is buildable today (`post_message` anchors to any live entity, no kind restriction). Three items needed contract surface the frozen contract lacks; all resolved to keep Wave 1 shippable with NO contract change:

- **R-UI-4 (session_modals): DEFERRED — design-drawn, not built** (same class as the token gauge, R-UI-8). The frozen contract has zero `modal` surface (no op, no WorkspaceEvent variant). A future amendment batch adds `modals.*` (list-open / answer) + an **immediate-class** WorkspaceEvent variant (a modal 1.5s late on the poll tick is already annoying). Until then the session surface simply has no modal chrome; nothing lies.
- **Status filtering: CLIENT-SIDE for Wave 1.** `CollectionQuery` has no `work_session.state.status` filter. Wave 1 filters fetched sessions client-side and captions the count honestly ("Live · N of M fetched" once it could truncate). A `status` filter on CollectionQuery joins the same future amendment batch as `modals.*`.
- **`state.ptyAlive`: DEFERRED.** Wave 1 liveness uses TWO mechanisms — Draco's server-side startup reconciliation + a client belt that demotes a row to "stale" when an attach fails/closes immediately. A future `state.ptyAlive` boolean would make `sessionIsAttachable` a pure function of the entity and delete the client belt; it is a clean-up, not a Wave-1 requirement.

Design calls ADOPTED (Atlas's): six presented states (5 contract + "stale" as a status-vs-reality disagreement); **composer delivers FIRST then records** — a recorded-but-undelivered prompt is a lie the user acts on, so the "record ok / delivery failed" case renders visually distinct as "not delivered — the agent never received this"; terminate's confirm states its blast radius (cascade count); a `session_modals`-blocked session sorts to a **NEEDS YOU** group above idle; a `view`-grant terminal renders but says it is swallowing keystrokes (never silently drops). **Send key: Cmd/Ctrl+Enter = send, Enter = newline** (multi-line agent prompts; an accidental send can't be recalled) — the user may override this one UX call.

**Net: Wave 1 sessions surface is fully buildable with no contract change.** The `modals.* + status-filter (+ optional ptyAlive)` amendment is a SEPARATE, batched, post-Wave-1 conversation.
