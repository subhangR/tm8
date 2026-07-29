# TM8 UI — FINAL SPEC (independent architecture review + buildable specification)

**Status:** Review + final engineering spec. Written 2026-07-27 by an independent senior UI architect (Fable-5 session), commissioned by the team lead.
**Authority:** This document does not amend the design ledger. `WORKSPACE-LAYOUT-AND-TERMINOLOGY.md` v2.11 (hereafter **WLT**) and `TM8-CHAT-UI-AND-LAYOUT-DESIGN.md` (hereafter **CHAT**) remain the governing product design; the closed adversarial ledger (`WORKSPACE-LAYOUT-REVIEW.md`, Rounds 1–12, hereafter **REV**) is respected — no closed finding is relitigated here without new evidence. What this document adds: (a) an independent verdict, (b) a low-level-design review against the *actual code* in the working tree, (c) the buildable spec engineers implement from, resolving the ambiguities the governing docs leave open, and (d) explicitly marked **OPEN** items with recommendations.
**Precedence for implementers:** where this spec resolves something WLT/CHAT left unspecified, this spec binds. Where this spec would contradict a WLT/CHAT ruling, the ruling wins and the contradiction is a defect in this document — report it. **Exception:** the three §0 user directives (2026-07-27) post-date v2.11 and override it where they conflict; §0.1 records the one real conflict and its adjudication.

---

## 0. Post-review user directives (2026-07-27) — binding; fold-ins applied throughout

### 0.1 DIRECTIVE 1 — the terminal is a VERBATIM MAESTRO TRANSPLANT

User ruling: maestro's terminal (its streaming and handling — "that particular component and the wiring, all parts, even the backend part") is the reference standard and must be transplanted exactly. **This adjudication is grounded in a direct read of maestro main** (`~/Desktop/Projects/maestro/agent-maestro`, branch `main`; terminal stack: `maestro-ui/src/SessionTerminal.tsx` 1019 LOC · `maestro-ui/src/platform/terminal.ts` 762 · `maestro-ui/src/services/terminalVisibilityDriver.ts` 169 · `maestro-server/src/application/services/PtyHostService.ts` 842 · `maestro-server/src/infrastructure/websocket/PtyWebSocketServer.ts` 339 · `maestro-pty-protocol/src/index.ts` 126).

**Q1 — Streaming semantics: maestro main and the tm8 port are IN SYNC at the law level; the wire parser is byte-identical; three drift items found, each an adoption, not a redesign.**
- `diff maestro-pty-protocol/src/index.ts ↔ tm8 packages/pty-protocol/src/index.ts` is **empty** (verified this session). tm8 additionally carries the `golden-frames.json` fixture maestro's test dir lacks — a protective tm8 addition; keep it and upstream it if possible.
- The transport laws match clause for clause: `_received` raw-arrival offset snapped to `attached.next` (maestro `platform/terminal.ts:154-172` = tm8 `ptyTransport.ts:99-166`, same map names and comments); **epoch compared by equality only**, authoritative over the legacy base-rewind fallback (maestro `:166-172,184-227` = tm8 `:126-147`); persistent per-session `TextDecoder` (maestro `:151` = tm8 `:99`); fail-closed pending bounds `MAX_PENDING_BYTES = 256*1024` / `MAX_PENDING_ENTRIES = 1024` (maestro `:135-136` = tm8 `:87-88`). The visibility driver differs only in comments (`diff` = comment hunks): `HIDE_GRACE_MS = 10000`, `RECONCILE_INTERVAL_MS = 2000`, `WARM_LRU_SIZE = 3` (maestro `terminalVisibilityDriver.ts:43-55` = tm8 `visibilityDriver.ts:40-49`); flush-before-suspend enforced identically. Renderer: maestro main is **DOM-only by explicit in-code note** (`SessionTerminal.tsx:225-233`) — the WebGL experiment (`3d357dd`) is reverted at main, confirming tm8's stance.
- **Drift items (maestro wins per the directive):** **(a) cursor blink** — maestro main hard-disables it everywhere (`SessionTerminal.tsx:207` `cursorBlink: false`; commit `ef0dcbe`); tm8 runs active-only blink (`tm8 SessionTerminal.tsx:145,415,480`) → adopt `false`. **(b) WS heartbeat** — maestro's PTY WS server runs protocol-level ping/pong to reap dead subscribers (`PtyWebSocketServer.ts:6,50-78`; tests in `8e2e82a`); tm8's port explicitly states "NO heartbeat dependence" (`tm8 pty-ws-connection.ts:28,167`) → adopt the heartbeat. **(c)** commit `0539726` ("lazy stream suspension, bounded broadcasts, multi-viewer PTY size sync") — the suspension leg is in the tm8 port; the bounded-broadcast and multi-viewer size-sync legs need the diff → audit and adopt. **Verdict: v2.11's TerminalPool changes no streaming semantic, so no amendment is needed on this axis. The binding rule stands: layout and mounting may be adapted; byte handling may not.**

**Q2 — Mount model at maestro main: keep-ALL-live-mounted with stable keys, PLUS imperative DOM reparenting for multi-host views.** This corrects the pre-read adjudication (which demoted reparenting) — on the evidence, in reparenting's favor:
- The home surface keeps **every live session's terminal mounted** ("stable key ⇒ constructed once, never rebuilt"); the only unmount is a hidden EXITED agent terminal — and even that stays mounted while Team View is open so reparenting can find it (`components/app/AppWorkspace.tsx:542-553`). Maestro main has **no mounted-LRU bound**; tm8's `k=4` (`CenterPane.tsx:24`) is a deliberately *stricter* union stamped by maestro's own streaming owner because pure keep-all-mounted "fails on MEMORY (maestro lived it)" (`STATE.md:134`). **Re-grounded ruling on C-2:** maestro's real number is "unbounded live + unmount hidden exited"; the `k` bound is an allowed mounting adaptation, and raising the dial to WLT's floor `k ≥ MAX_PINNED + 2 = 5` remains a pure config change. The warm-sockets dial (3) is a separate dial with the identical constant in both repos.
- **Maestro DOES reparent live xterms.** TeamView moves `term.element` (the imperatively-created `.xterm` node) into slot host divs via `host.appendChild(xtermEl)`, refits under a double-`requestAnimationFrame`, and restores to `originalParent` on cleanup with another refit (`components/maestro/TeamView.tsx:468,492-526`); MultiProjectSessionsView does the same (`MultiProjectSessionsView.tsx:361-382`). The streaming stack is built to tolerate it: the visibility driver computes visibility from the DOM precisely so "TeamView / MultiProjectSessionsView, which reparent terminal elements imperatively," are covered transparently (`terminalVisibilityDriver.ts:9-12`), and the write scheduler is element-keyed for the same reason (`terminalWriteScheduler.ts:17`). **Revised ruling (supersedes the interim keep-mounted-primary ruling): WLT §5.2a's reparenting TerminalPool is a GENERALIZATION of maestro's own shipped mechanism, not a contradiction — the "parking container" is TeamView's `originalParent` home generalized; `acquireHost` is the slot move; `releaseHost` is the restore.** The pool must adopt maestro's conventions verbatim when reparenting: move `term.element` itself, double-rAF refit after every move, restore-then-refit on release, DOM-computed visibility, element-keyed write scheduling. The keep-mounted CenterPane model remains the shipped baseline and a legal §4.8.6 implementation of the same lease API; §6 R1's "spike" becomes a **port of TeamView's mechanism**, not an experiment.

**Q3 — Backend: a port, already done; closing to maestro main is an audit + two adoptions, not a rewrite.** tm8's `packages/server/src/pty/{pty-ws-server,pty-ws-connection}.ts` (341+195 LOC) implement the same `attached{base,gap,next,hasReplay,replayKind?,epoch?}` handshake and 16ms-coalesce contract maestro documents (`tm8 pty-ws-server.ts:15-30` ↔ maestro `PtyWebSocketServer.ts:21-35`), ported from maestro's shipped socket with the streaming owner pairing and Vega-verified with offset-resume/epoch/replay browser proofs (`STATE.md:188-190`). What moves to reach maestro main: the heartbeat (drift b), any unported `0539726` legs (drift c), and the replay-ordering test coverage from `8e2e82a`. The PTY *host* itself (`maestro-server/.../PtyHostService.ts` ↔ tm8's `packages/execution` lift) was the original W-phase lift and is not re-opened. Enumerated, bounded, port-shaped.

### 0.2 DIRECTIVE 2 — Chat is DEFERRED to Phase 2

Chat ships after the whole app runs and the terminal works properly. Effects, applied below: §4.9 is re-marked **PHASE 2** and leaves the build order's critical path. It stays fully specified so nothing built now forecloses it — the `contentSurface=` codec slot (§4.2.2), the Content-region toolbar seam (§4.6.2), and the feed-scope design remain designed-in. The C9 gate drops out of the near-term plan. The §3.5(b) server lane keeps the menu + handoff production mounts (Phase-1 workspace features) but defers the `entities.feed`/`entities.context` production mount to Phase 2 (the handlers already exist — see §3.5.1). Phase-1 sessions render **terminal-only with no surface switch** (CHAT §5.1's "unflavored session" presentation — no error copy, no empty Chat tab).

### 0.3 DIRECTIVE 3 — Tier 2/3/4 design surfaces are IN SCOPE

The user confirmed design work for: the domain-config surfaces (Menu editor, space settings, Linked Projects, node-admin Project Registry, projects+trust incl. RULING J's M:N association model, Interaction Profiles, custom-kind authoring); the never-designed surfaces (auth/login/first-run/onboarding, account, files, node settings, Graph canvas, inbox); and the cross-cutting state matrix incl. the F6 honest-degradation vocabulary. **The canonical, ranked designer-facing worklist now lives in the design-handoff package at `~/Desktop/tm8-ui-design/` (`04-DESIGN-WORKLIST.md`, Tier 0 → Tier 4 → Phase 2); it supersedes §5 below as the working list — §5 is retained as the engineering-side summary.** The package is the input to Claude Design; this document remains the engineering spec. Per the user's fuller direction the package is **self-contained**: requirements (01–04) plus the copied material — tokens (05), reference screenshots (06), reusable component source with verdicts (07), the spec corpus (08), and openable HTML (09: a generated static rendering of the current workspace with the real repo CSS inlined, a found maestro static mockup, and the Vite mount point labeled as such).

---

## 1. Verdict

**The design is sound and buildable as specified. Build it.** This is a genuine judgement, not a rubber stamp; the reasons and the exceptions follow.

### 1.1 Why it is sound

1. **The hard problems were actually solved, in the right order.** Twelve adversarial rounds (REV) forced the design through exactly the failure classes that killed the previous three attempts: layout starvation (the durable floor law, `STATE.md:149`), terminal identity across navigation (WLT §5.2a), honest at-most-once PTY delivery (WLT §5.7, exactly-once explicitly retracted at R6-1), route grammar with overflow semantics (WLT §2.2), and menu-as-data (WLT §2.3). The ledger's non-monotonic history — including a Round-6 NO-GO — is evidence the review was real.
2. **It is consistent with the code it plans to reuse.** I verified the load-bearing claims against the working tree: `MAX_PINNED = 3` matches (`collab-v2/stores/nav.ts:29`); the `p`/`pin`/`t` codec exists and round-trips (`nav.ts:158-217`); the Z3 four-tab anatomy is exactly the inherited one (`entity/EntityPanel.tsx:33-38`); the flush-before-suspend seam the TerminalPool must preserve is real and documented in code (`real/terminal/ptyTransport.ts:498-511`, `visibilityDriver.ts:108-110`); the two-dial model (mounted LRU vs warm sockets) the spec inherits is real (`CenterPane.tsx:24`, `visibilityDriver.ts:49`).
3. **The contract is ahead of the UI, not behind it.** The uncommitted working tree already carries the W0 amendment family: 20 new catalog operations (`packages/contract/src/catalog.ts:143-163`), `entities.feed` with the exact `session_chat_v1` scope and `around` semantics CHAT §8 requires (`schemas.ts:655-665, 687-707`), the frozen `MenuConfig` DTO (`schemas.ts:408-466`), the two-axis handoff saga types (`schemas.ts:592-653`), and `interaction_profile` in `CoreEntityKindSchema` (`schemas.ts:87-92`). The UI will not be designing against vapor.

### 1.2 What I would change (and do change, in §4)

- **C-1 — The TerminalPool is specified as a DOM-reparenting pool, but nothing in the codebase reparents an xterm today.** WLT §5.2a: "Acquire reparents the terminal's existing DOM node into the host (`appendChild` …). Portals are NOT the mechanism." Current reality: `SessionTerminal.tsx` owns one xterm per mounted React node, keyed by `[sessionId]` (`SessionTerminal.tsx:138-408`), with full dispose on unmount (`:381-407`); a repo-wide grep finds **no** pool, lease, parking container, or reparent anywhere. This is a *new mechanism*, not a harvest, and the plan's "extract, never fork" phrasing under-states it. The design itself is correct — reparenting a live xterm DOM node via `appendChild` preserves the terminal buffer and avoids React reconciliation of xterm internals — but it must be treated as the highest-risk unit with a spike-first mandate (§6 R1) and a defined fallback that preserves the lease API (§4.8.6). **[Revised by §0.1 after reading maestro main: "nothing reparents an xterm" is true of tm8 but FALSE of maestro — TeamView/MultiProjectSessionsView reparent live xterms via `appendChild` with restore-on-cleanup (`TeamView.tsx:492-526`). The pool is therefore a generalization of a maestro-proven mechanism; the "spike" becomes a port of TeamView's conventions.]**
- **C-2 — The pool floor contradicts the shipped dial.** WLT §5.2a requires `k ≥ MAX_PINNED + 2 = 5`; the shipped mounted-LRU is `k = 4` (`CenterPane.tsx:24`). Not a defect in either — the spec knowingly raises the floor for the multi-host world — but the spec never says so. §4.8.2 states it explicitly so nobody "harvests" the 4.
- **C-3 — The normalization loop has an unspecified terminal state.** WLT §5.2 bounds the demotion loop by `pinned.length ≤ 3` iterations, but if `centerWidth < 320` neither predicate can ever hold and the loop exits with `pinned = 0` and admission still false. WLT §5.6's breakpoints normally prevent this, but normalization can run transiently mid-resize before breakpoint reflow. §4.7.4 rules the exit state.
- **C-4 — `contentSurface` has a name but no wire encoding.** WLT §2.2 adds the param and its drop tier but never says how a *per-panel* value serializes in a flat query param. §4.2.3 rules it (same `id:value` pair encoding as `t=`).
- **C-5 — EntityListPanel is the least-specified primitive.** WLT §3 gives a survival list ("task current/completed sections, hierarchy expansion, … sessions lifecycle tabs, live count, quick launch, per-kind filters. Re-homed, never dropped") but no registry schema that could *carry* those behaviors as data. Without it, implementers will hard-code on kind — the exact failure R1-F13 rejected. §4.5.2 specifies the `ListConfig` schema.
- **C-6 — The legacy-redirect table is incomplete.** WLT §2.2 lists redirects for `tasks`, `sessions`, `sessions/{id}`, and "unchanged" routes, but the shipped nav has `docs`, `team`, `tracking`, `graph`, `leaderboard`, `home`, `inbox`, `settings` views too (`stores/nav.ts:43-47`). §4.2.5 completes the table.
- **C-7 — A known codec asymmetry survives in the code the plan harvests.** `router.ts:170-187` (`buildHash`) still serializes `view === 'channel'` as `/e/{id}`, diverging from the store codec — the exact class of bug UI-GAP-AUDIT §3.9 documented. The new route module must be built fresh (as planned) and this file must NOT be harvested; §3 and §4.2 make that explicit.
- **C-8 — The naming seam between CHAT C2 and the implemented contract.** CHAT §8.4/C2 asks for "a stable logical-operation key such as `clientMutationId`"; the implemented `FeedItem` carries it as `logicalOperationId` (`schemas.ts:676-685`) and has no `clientMutationId` field. Semantically identical; the contract's name wins. Recorded so nobody files it as drift.

### 1.3 What I would NOT change

- The **two-primitive** reduction (WLT §3). It is the correct generalization of TaskPanel/ResourcePanel and the Z3 panel, and the survival-list discipline answers R1-F13's "wishful reuse" objection.
- The **at-most-once handoff saga** and its two-axis state (WLT §5.7). Closed at Rounds 7–9 through real scrutiny; the retry identity/fingerprint split (R8-4) and edge-only-on-confirmed-delivery (R7-1/R7-4) are exactly right. Do not touch.
- **Message-first Chat with explicit-only capture** (CHAT §1, RULING M). The alternative — inferring bubbles from PTY bytes — is a permanent honesty debt. The design's willingness to let an agent's answer stay Terminal-only (CHAT §3) is a feature.
- The **browser-proof keyboard core** (WLT §5.8, R8-3). Plain keys and `g`-chords with `Mod` conveniences gated on receive tests is the only honest contract a web app can advertise.
- **MenuConfig-as-data** with the closed ViewRef union and depth-≤1 children (WLT §2.3, R8-2). Already implemented in the contract nearly verbatim (`schemas.ts:408-466`, including global ref uniqueness and mandatory `settings` in `validateMenu:434-449`).
- The **closed ledger findings**. Nothing I found in the code contradicts a closed ruling.

### 1.4 Doc-vs-doc conflicts, adjudicated

| Conflict | Winner | Why |
|---|---|---|
| `WAVE-1-RULINGS.md` R-UI-1 (terminal = session **Z4** view) vs WLT RULING D (terminal = `work_session` **Content renderer**, every host) | **WLT** | WLT v2.11 post-dates and governs; Wave-1 design is explicitly shelved (`STATE.md:145`). |
| `WAVE-1-RULINGS.md` addendum "composer delivers FIRST then records", Cmd+Enter=send | **CHAT §6/§10.5** (stored-first; Enter sends, Shift+Enter newline) | C6 formally superseded the deliver-first Composer (WLT RULING M; REV Round 12). The Wave-1 rule survives *only* for the §5.7 handoff saga, which is a different object. |
| `COLLAB_V2_UI_UX_BRIEF.md` §5 hard-coded left-rail sections | **WLT §2.3** (menu is per-space data) | RULING H. The brief remains the design-language authority (Z1–Z4, subsystems, drag grammar), not the nav authority. |
| UI-GAP-AUDIT claims (`registryFor` no fallback §3.7, `grantPoints` throws §3.3) | **The code** | Both were fixed in Wave 0: `registryFor` has a fallback (`KindRegistry.tsx:980-982`); `grantPoints` is live (`RealFacade.ts`). The audit is a historical snapshot; verify against the tree. |
| WAVE-1 R-UI-5 (`sessionIsAttachable()` one-predicate liveness) and R-UI-6 (terminate cascades / complete is intent-only) | **Survive** | Nothing in WLT/CHAT supersedes them; they bind the EntityListPanel session config (§4.5.3) and session actions. |

---

## 2. Review of the LLD, section by section

Standard applied: *could a competent engineer implement this without inventing product behavior?* Verdicts: **TIGHT** (implement as written), **TIGHT WITH RULING** (one ambiguity, resolved in §4), **UNDER-SPECIFIED** (this spec supplies the missing design).

### 2.1 The two primitives (WLT §3) — EntityListPanel UNDER-SPECIFIED, EntityDetailPanel TIGHT

**EntityDetailPanel** is tight because it is inherited, and the inheritance is real: header / action bar / Content·Discussion·Connections·Activity / footer exists verbatim at `entity/EntityPanel.tsx:243-424` with `PANEL_TABS` fixed at `:33-38`, capability-gated by `EntityCapabilities` (`types/contract.ts:136-137`) and registry `Content` selection with no kind branches (`EntityPanel.tsx:209,406`). The only new behavior is the `work_session` two-mode Content region, which CHAT §4.2/§5 specifies to interaction-level detail. Implementable.

**EntityListPanel** is not. The survival list names *what* must survive but no structure says *where each behavior lives*. The current sources are monoliths: `TaskPanel.tsx` (694 LOC) and `ResourcePanel.tsx` + tabs, with behavior spread across `useTasks.ts` (tree building, `:151`), `useSessions.ts` (liveness predicate `:54`, links cache `:128`), and `queries.ts`. Absent a per-kind list-configuration schema, "registry-driven capabilities" will decay into `if (kind === 'task')`. **Resolved in §4.5.2** with the `ListConfig` registry shape; the survival list becomes its acceptance matrix.

### 2.2 WorkspaceCenter composition adapter (WLT §5.2) — TIGHT WITH RULING

Correctly named an *adapter*: the nav-store state machine over `{stack, pinned, tabs}` is inherited (semantics verified at `nav.ts:112-147` — push/dedupe, pin moves stack→pinned, `MAX_PINNED` refusal), and the center owns composition. The spec rules visibility (top-of-stack + pinned), Esc (stack only), empty state, and `?session=` auto-open. Two holes, both resolved here:
- **Internal width distribution of the visible columns is unspecified.** The inherited PanelStack renders pinned frames as flex siblings `flex:1 1 0; min-width:320px` (`shell/PanelStack.tsx:244-278`, `shell.css:239`) and the peek stack at fixed 440px (`shell.css:229`). WorkspaceCenter cannot use the 440px fixed peek (it is a column, not an overlay). §4.7.2 rules: equal-flex columns, 320px floors, stack-top column rightmost.
- **Column order** (pins vs stack top) unstated. §4.7.2: pinned columns left→right in pin order; stack top rightmost (matches inherited PanelStack sibling order, preserving muscle memory).

### 2.3 Panel stack + pinned columns model — TIGHT

Inherited and verified. One correction to fold in: on a Z4 route the session must be removed from *both* sets (WLT §5.2c single-host invariant); current `promotePanel` removes only from `stack` (`nav.ts:143-147`). The new nav store must extend removal to `pinned`. Cross-set dedup at hydration (pin > stack) is new code; current hydrate only slices pins to `MAX_PINNED` (`nav.ts:215`).

### 2.4 The sizing law (WLT §5.2 + §5.6) — TIGHT WITH RULING

The math checks out. `C_min = max(320, V·320 + max(0,V−1)·8)` with `V = pinned.length + (stack.length > 0 ? 1 : 0)` is monotone in V and clamped at V=0. The demotion loop is correctly described as needing to *loop*: with `stack = ∅, pinned = 3` (V=3), the first demotion moves a pin onto the empty stack and V stays 3; the second reduces V — the spec itself flags this ("demoting a pin onto an empty stack keeps V constant"). Bounded by 3 iterations. Discrete toggle tracks (`S ∈ {0,48}`, `M ∈ {48,220}`, `minmax(0,…)` forbidden) directly encode the three-times-paid floor lesson (`STATE.md:149`; live grid at `workspace.css:73-78` already obeys it). Derived breakpoints measured at reference capture, not asserted — the R2-9 fix, kept.

The one genuine hole is the loop's exit state when admission can never hold (C-3). **Ruled in §4.7.4.**

### 2.5 TerminalPool (WLT §5.2a–c) — TIGHT as a contract, NEW as a mechanism

The lease API, eviction law, and activation model are among the tightest parts of the whole corpus: leased entries eviction-ineligible; LRU over *parked* only; `k ≥ MAX_PINNED + 2`; acquire-new-then-release-old atomic handoff with a transient `k+1`; dispose only at parked-LRU eviction with offset-0 full replay on return; `activeSessionId` succession deterministic and tested. Every named test in §5.2a/§5.2c is implementable.

But be honest about provenance (C-1): what exists is a *component-lifecycle* model — `CenterPane` renders one `SessionTerminal` per LRU slot, hides inactive layers with `visibility:hidden` (`CenterPane.tsx:186-211`), and the visibility driver suspends sockets after a 10s grace (`visibilityDriver.ts:40`). The pool inverts ownership: the xterm and its DOM node become pool-owned imperative objects; React renders only host divs. That means `SessionTerminal.tsx` is not "extracted" — it is *split*: transport wiring, settings reactions, clipboard/paste, fit gating (`:206-236`), and teardown discipline (`:381-407`) are harvested into an imperative `TerminalInstance`; the React component shell is discarded. Three invariants the pool must carry over verbatim, each with an existing code anchor:
1. **Flush-before-suspend, synchronous, no intervening await** (`ptyTransport.ts:498-511`, enforced order at `visibilityDriver.ts:108-110`). `releaseHost` → park → (driver) flush → suspend must preserve this exactly.
2. **Two dials stay separate**: mount bound `k` vs `WARM_LRU_SIZE = 3` warm sockets (`visibilityDriver.ts:49`). The code carries explicit warnings that collapsing them reproduces maestro's shipped RAM failure (`WorkspaceScreen.tsx:82-88`).
3. **Eviction is a full teardown + offset-0 `requestFullReplay` on return** (`ptyTransport.ts:574`); a naive resume-at-offset after dispose creates a silent client-side hole (`STATE.md:194` item 4).

Verdict: implement as specified, spike-first (§6 R1), with the §4.8.6 fallback.

### 2.6 Route grammar (WLT §2.2) — TIGHT WITH RULINGS

Params, the 2048 total cap, the ordered atomic drop (`t`-tier → `pin` → `p` → `q`), the R4-7 generalized notice, pin>stack dedup, `pushState` vs debounced `replaceState` discipline, and `replaceState` for surface toggles are all decidable and property-testable. Three resolutions needed, supplied in §4.2: the `contentSurface` pair-encoding (C-4), the `q` codec (WLT defers it to the dossier; the UI needs a v1 now — §4.2.4), and the complete redirect table (C-6). Also: build the codec fresh; do not harvest `router.ts` (`buildHash` channel asymmetry, C-7). The transport layer (`createBrowserTarget`/`createMemoryTarget`, `router.ts:36-97`) *is* harvestable — the bug is in the legacy link-builder, not the transport.

### 2.7 MenuConfig-as-data (WLT §2.3) — TIGHT

Frozen DTO, closed ViewRef union, depth-exactly-≤1 children, global ref uniqueness, mandatory `settings`, revision-free write payload + `expectedRevision`, future-version preservation vs malformed repair as separate paths — all specified, and the contract already implements the shapes (`schemas.ts:408-466`; ops `spaces.menu.get/update` at `catalog.ts:144-145`). One reality note: the server handler is complete and test-covered but **not mounted in production** — `registerW2MenuDefaultChannelHandlers` is called only by its own test (`packages/server/test/w2/menu-default-channel.test.ts:14`), never by `registerFacadeHandlers` (`facade/index.ts:74-110`), so the op 501s on a running server today (see §3.5.1). The spec's own fail-closed rule covers this: render the versioned shipped default when config is unavailable. The renderer must therefore treat "op unavailable" and "missing row" identically (§4.10).

### 2.8 Keyboard / focus priority chain (WLT §5.8) — TIGHT

The 6-layer consume-don't-cascade chain, dead-plain-keys-in-text-entry, browser-proof core (`/`, `g ,`, `p`), frozen exclusion list, and the physical `Ctrl+Backquote` blur chord intercepted in `attachCustomKeyEventHandler` (zero PTY bytes; focus lands on the owning panel's Content tab header supplied by the lease) are all implementable and mostly jsdom-testable as claimed. The Chat clause (layer 4 covers the composer; a hidden lease grants no keyboard authority, `WLT:243`) is coherent. The existing custom-key-handler precedent is in code (`SessionTerminal.tsx:294-311`). No changes.

### 2.9 Drag-drop + share-into-session (WLT §5.7, CHAT §4.5) — TIGHT

The saga is server-side; the UI surface area is: drop targets (session panel incl. both surfaces + Content toolbar, live-session bar + roster, live tiles), the file-onto-composer vs entity-onto-panel distinction (CHAT §4.5 — never silently convert a handoff into an attachment), rendering the two-axis state without collapsing it into one badge, withdrawal by correlation (badge decorates, never rewrites the message row), and the superseded undo token for row 8. Contract shapes are implemented (`handoffs.send/list/withdraw`, `catalog.ts:148-150`; two-axis unions with the legal-state superRefine, `schemas.ts:592-653`). Handler is complete and test-covered but not production-mounted — same gate class as menu (§3.5.1). One UI note the docs leave implicit: while `handoffs.*` is unavailable, the drop affordance must be **disabled-with-reason**, not inert — the F6/X4 lesson (UI-GAP-AUDIT: targets highlighted and ghosts promised while `placements` threw). §4.12 makes this a law for every drop row.

### 2.10 Chat (CHAT, whole doc) — TIGHT, correctly gated

The best-specified feature in the corpus: feed contract with closed `via` terms, single-cursor pagination, `around` focus windows, four-layer send state (draft / mutation-pending / stored / delivery facet), delivery-state table with exact labels, Send-again-not-Retry (C8), profile fallback ladder (§14.3), and a complete state matrix (§17). The contract implements the read/write shapes (`EntityFeedQuery`/`FeedItem`/`EntityFeedPage` at `schemas.ts:655-707`; delivery at `:563-590`; batch message send at `:329-364`). Gate that is real today: `entities.feed` **is implemented** (handler `handlers/w2/feed-context.ts:27` over a ~600-line service, with its own test suite) but, like the messages/handoffs/delivery and menu handlers, is **not mounted in production** (§3.5.1) — a running server 501s it. C9 ("Chat implementation is gated on the catalog/CLI/API amendments; PTY parsing is never an interim substitute") is the standing rule; build Chat last (Phase 2 per §0.2), behind capability detection (§4.9.5). The C-8 naming note applies (`logicalOperationId`).

### 2.11 Interaction Profiles surface (WLT §7.6, CHAT §14) — TIGHT for Phase-1 UI scope

The UI consumes: template key/version resolution, initial-surface preference, safe browser projection, and the §14.3 five-step fallback. Contract carries the kind, the lifecycle family, and `InteractionProfilePinView` (`schemas.ts:775-896`). Phase-1 UI needs no profile *authoring* surface beyond the registered-but-not-in-menu `k/interaction-profiles` collection with lifecycle capabilities off (WLT §7.6); correct scope.

### 2.12 Where the spec is over-specified — one place, deliberately accepted

WLT §5.7's kill-window and queue-seam detail is server implementation detail living in a "layout & terminology" doc. It is harmless here (the dossier mirrors it) and I do not propose moving it; noted so UI engineers know §5.7's UI obligations are only the ones extracted in §4.12.

---

## 3. Review of the implementation approach

The planned approach: new `packages/ui-next`; extract (never fork) the pty transport + SessionTerminal core into a shared package with TerminalPool wrapping it; copy tokens.css + kit primitives with byte-equality anti-drift tests; harvest logic, drop markup; build order = domain config registry → route grammar/nav → shell + sizing law → the two primitives → TerminalPool → Chat.

**Agree, with five amendments:**

1. **`packages/ui-next` — agree.** The current app is the only working UI and doubles as the behavioral oracle for the survival list. Freezing `packages/ui` and building beside it is strictly safer than in-place migration across a 270-file module. Accept the cost (temporary duplication) and time-box it: `ui` is deleted when the §4.14 surface inventory + WLT §3 survival list pass against `ui-next`, not before.
2. **"Extract, never fork" the terminal — agree for the transport stack, amend for SessionTerminal.** Extract verbatim into `@tm8/terminal-core`: `ptyTransport.ts`, `writeScheduler.ts`, `visibilityDriver.ts`, `runtime.ts`, `terminalSize.ts`, `useTerminalSettingsStore.ts`, clipboard helpers, and the already-vendored `@maestro/pty-protocol` with its golden-frames test (`packages/pty-protocol/test/goldenFrames.test.ts`). Two seams must be cut at extraction: `SessionTerminal`'s paste path reads `isUnavailable('uploadFile')` from `real/capabilities.ts` (`SessionTerminal.tsx:322,340`) — inject as config; settings-store persistence key stays shared so `ui` and `ui-next` see the same user settings. **SessionTerminal itself is split, not extracted** (per §2.5): its logic moves into the pool's `TerminalInstance`; its React shell dies with `ui`. Both `ui` and `ui-next` consume `@tm8/terminal-core` during the transition so the transport cannot fork.
3. **Byte-equality anti-drift — agree for tokens and protocol, amend for kit.** `tokens.css` copies byte-identical (the test is trivial and the `.cv2-root` scope + `[data-theme]` hooks at `tokens.css:10,118-149` come with it — keep the class name; renaming breaks byte-equality for zero benefit). `@maestro/pty-protocol` already has the golden-frames guarantee. **Kit primitives cannot be byte-equal** — import paths change by construction. Amend to: per-file structural-diff test that ignores import lines only, or (better) promote `kit/` to a shared `@tm8/kit` package imported by both apps, which makes drift impossible instead of detected. Recommend the package.
4. **Harvest list — agree, with a shared-data-package twist.** `RealFacade` (539 LOC), `capabilities.ts`, `usePolledCollection`, `useTasks`/`useSessions`/`queries.ts`, and the `CollabFacade` seam (~64 methods, `facade/CollabFacade.ts:45-161`) are the harvest. Since `ui` keeps running, extract these into `@tm8/ui-data` consumed by both, rather than copying into `ui-next` — otherwise every server wiring change during the transition lands twice. Do **not** harvest: `router.ts:buildHash` (C-7), `TaskPanel/ResourcePanel` markup (by design), `CenterPane`'s LRU (replaced by the pool), the stale `tm8Kinds` session-panel copy.
5. **Build order — agree, plus a parallel server lane and one insertion.** The order is correct (config registry first is right: routes, palette, menu, and both primitives all read it). Two amendments: **(a)** insert "shell skeleton renders real data via `@tm8/ui-data`" as the first integration milestone with a *real-path* test — the F5 lesson (all ~534 mock tests stayed green through every live defect) must not repeat in `ui-next`; **(b)** run a server lane in parallel from day 1 — but its shape is **mount + verify, not build** (corrected after independent checks; the evidence is §3.5.1). Four complete, test-covered W2 handler modules are mounted only by their own tests, never by production: mounting them is four import+call lines in `registerFacadeHandlers` plus one ordered swap (`messages-handoffs` re-registers `messages.post`, which duplicates the legacy wrapper at `facade/index.ts:84-88`; `register()` throws on duplicates per the `:97-99` comment, so the legacy `messages.list/post` block is removed in the same change). The lane's real work is verification: migrations 015–029 apply clean, the `packages/server/test/w2/*` suites stay green against the mounted composition, and conformance sees the new ops — registration and implementation size are verified; *correctness under production composition is not yet proven*. Per §0.2, the `entities.feed`/`entities.context` mount can ride with the rest or wait for Phase 2 — the UI consumes it only in Phase 2 either way. Additionally, per §0.1, schedule the **maestro-main drift audit** (heartbeat, cursor-blink, `0539726` legs) as an early, independent task.

#### 3.5.1 Server registration state — verified 2026-07-27 (supersedes both earlier counts)

Two earlier readings disagreed ("16 of 20 new ops unwired, `entities.feed` has no handler" vs "97 of 101 registered, `entities.feed` is registered"). Both are partly wrong; the verified state:

- The **only production registration path** is `main.ts:97-104` → `registerFacadeHandlers` (`facade/index.ts:74-110`) + `registerEventHandlers` + `execution?.register`. `registerFacadeHandlers` mounts the legacy `messages.list/post` pair (`:84-88`) plus eight W2 modules (`:102-109`: entities-commands-tracking, identity-spaces, edges-placements, graph-undo, projects-associations, files*, inbox-read-marks, saved-views-actions).
- Four W2 modules are **complete, implemented, and test-covered, but mounted ONLY by their own tests** — no production path calls them:

| Module | Ops it registers | Handler evidence | Only caller |
|---|---|---|---|
| `handlers/w2/feed-context.ts` | `entities.feed`, `entities.context` | `:27-28` (service ~600 LOC, `services/w2/feed-context.ts`) | `test/w2/feed-context.test.ts:27` |
| `handlers/w2/messages-handoffs.ts` | `messages.post/edit/delete`, `messages.attachments.add/remove`, `messages.delivery.get`, `handoffs.send/list/withdraw` | `:18-26` | `test/w2/messages-handoffs.test.ts:17` |
| `handlers/w2/entity-kinds-profiles.ts` | `entityKinds.list/create/update`, `interactionProfiles.propose/updateDraft/validate/preview/activate/retire`, both `*.interactionProfile.setDefault` | `:12-22` | `test/w2/entity-kinds-profiles.test.ts:17` |
| `handlers/w2/menu-default-channel.ts` | `spaces.menu.get/update`, `spaces.defaultChannel.set` | `:16-18` | `test/w2/menu-default-channel.test.ts:14` |

- Consequences: a running server **501s** `entities.feed`, `spaces.menu.*`, `handoffs.*`, `messages.delivery.get`, `messages.attachments.*`, and `interactionProfiles.*` today, even though every one has a real implementation. The reconciliation of the two earlier counts: "registered" is true of the modules' internal registration maps and their test harnesses; "unwired" is true of the production composition — the mount is the gap, and it is cheap. `STATE.md`'s "28 of 80 implemented" is badly stale either way. Note the standing gate: WLT §10.3 — W1 implementation awaits the coordinator start; the pure-UI lanes (tokens, kit, registry, route grammar, shell against *existing* ops) are not gated by the dossier, but the new-op consumers are.

---

## 4. THE FINAL UI SPEC

Everything below is buildable now. Contract references are to the working tree (101-op catalog). Behavior references cite WLT/CHAT where the rule originates; where a rule originates here, it is marked **[RULED HERE]**.

### 4.0 Package topology

```
packages/
  pty-protocol/        @maestro/pty-protocol — unchanged, golden-frames guarded
  terminal-core/       @tm8/terminal-core — extracted transport stack (§3.2) + TerminalPool (§4.8)
  kit/                 @tm8/kit — tokens.css (byte-equal) + kit primitives (§3.3)
  ui-data/             @tm8/ui-data — CollabFacade seam, RealFacade, capabilities, polled-collection,
                       data hooks (tasks/sessions/feed/menu/handoffs)   (§3.4)
  ui/                  frozen current app (oracle; deleted at parity per §3.1)
  ui-next/             the product UI specified below
```

### 4.1 Component tree

```
<App>                                    boot: identity, space list, install domain config
 └─ <ServerRail?>                        Phase 1: hidden or 48px, fixed at reference capture (WLT §5.6)
 └─ <SpaceTabBar>                        top; space switcher
 └─ <SpaceShell spaceId>
     ├─ <MenuRail>                       renders MenuConfig (§4.10); M ∈ {48, 220}
     ├─ <ViewHost>                       resolves route → view (registry-driven, ErrorBoundary per view)
     │   ├─ HomeView | FeedView | InboxView
     │   ├─ WorkspaceView               (§4.7)
     │   │   ├─ <EntityListPanel side="left">
     │   │   ├─ <WorkspaceCenter>
     │   │   │   ├─ <LiveSessionBar>
     │   │   │   ├─ <PinnedColumn>×0..3  each = <EntityDetailPanel>
     │   │   │   └─ <StackColumn>        top-of-stack <EntityDetailPanel> | <EmptyCenter>
     │   │   └─ <EntityListPanel side="right">
     │   ├─ EntityView (k/{slug})        <CollectionView> center + right-edge <PanelStack>
     │   ├─ ChannelsView | ChannelView   channel list; Thread + EntityListPanel (WLT §5.5)
     │   ├─ EntityFullView (e/{id})      Z4; work_session Z4 hosts the terminal (single-host law)
     │   └─ SettingsView (/projects /menu)
     ├─ <PanelStack>                     right-edge Z3 stack + pinned splits for non-workspace views
     ├─ <CommandPalette>                 ⌘K / `/`
     ├─ <TerminalParkingContainer>       hidden, retained, app-lifetime (§4.8)
     └─ <NoticeHost>                     R4-7 overflow notices, toasts
```

Every `EntityDetailPanel` body and every view mounts inside an `ErrorBoundary` (per-view + per-panel, as Wave 0 established). `TerminalParkingContainer` is mounted once at app root and never unmounts.

### 4.2 Route grammar and codec

#### 4.2.1 Routes (WLT §2.2, verbatim)

```
#/s/{spaceId}/home | feed | inbox
#/s/{spaceId}/workspace          ?session= & p= & pin= & t= & contentSurface=
#/s/{spaceId}/k/{slug}           ?mode= & q= & p= & pin= & t= & contentSurface=
#/s/{spaceId}/e/{entityId}       ?origin= & p= & pin= & t= & contentSurface=
#/s/{spaceId}/channels
#/s/{spaceId}/channel/{channelId}   [?msg={messageId}]
#/s/{spaceId}/settings[/projects|/menu]
```

`mode ∈ list|board|tree|feed|gallery|graph`. `origin = {slug}[.{mode}]` validated against the §4.5 registry. RFC 3986 percent-encoding throughout.

#### 4.2.2 Param encodings **[RULED HERE for the pair-params]**

- `p` = stack entity IDs, dot-joined, bottom→top (inherited encoding, `nav.ts:92-97`).
- `pin` = pinned entity IDs, dot-joined, pin order.
- `t` = comma-joined `{entityId}:{content|discussion|connections|activity}` pairs; omitted pairs default `content` (inherited).
- **`contentSurface`** = comma-joined `{entityId}:{terminal|chat}` pairs; only meaningful for `work_session` panels; omitted ⇒ resolve per CHAT §5.2 (deep-link value → viewer saved preference → profile initial → terminal). Never expands the `t` vocabulary (C7).
- `session` = one work_session ID; auto-opens its panel only when `p` and `pin` are both absent (WLT §2.2).

#### 4.2.3 Cap and drop (WLT §2.2)

Total serialized hash ≤ **2048** chars. Overflow drops whole params atomically, in order: **(1)** the `t` tier = `t` AND `contentSurface` together → **(2)** `pin` → **(3)** `p` → **(4)** `q` (atomically, to the canonical default query). Never over-cap, never mid-token; navigation always succeeds. Any drop emits ONE generalized notice via `NoticeHost` — class-naming, no raw IDs ("some tab/surface/pin/panel/filter state wasn't carried in this link"). Each tier has a codec + history test. Unparseable param → discarded atomically, canonical default renders. Hydration dedup: ID present in both `p` and `pin` keeps `pin` (WLT §2.2).

#### 4.2.4 `q` codec v1 **[RULED HERE — dossier may supersede; version byte makes that safe]**

`q = base64url(JSON)` of `{ v: 1, filters?, sortBy?, groupBy? }` — a strict subset of `CollectionQuery` (no `kinds`: the slug fixes the kind; no limit/cursor: never in URLs). Unknown `v` ⇒ treated as unparseable (atomic discard). The codec module exports `encodeQ/decodeQ` as pure functions with property tests (round-trip, cap interaction, unknown-version discard).

#### 4.2.5 History discipline & redirects

`pushState`: user navigation, explicit pin/unpin. Debounced idempotent `replaceState`: responsive normalization (demotions, dedup, overflow drops), and Terminal/Chat surface toggles (C7). One `replaceState` per normalization settle (WLT §5.2).

Complete legacy-redirect table (space always preserved; bare forms resolve against last-active space, else space picker) **[C-6 completion RULED HERE for the rows WLT omits]**:

| Legacy | New |
|---|---|
| `#/s/{s}/tasks` | `#/s/{s}/k/tasks` (WLT) |
| `#/s/{s}/sessions` | `#/s/{s}/k/sessions` (WLT) |
| `#/s/{s}/sessions/{id}` | `#/s/{s}/e/{id}?origin=sessions` (WLT) |
| `#/s/{s}/docs` | `#/s/{s}/k/docs` |
| `#/s/{s}/team` | `#/s/{s}/k/teammates` |
| `#/s/{s}/tracking` | `#/s/{s}/k/pulls` |
| `#/s/{s}/graph`, `#/s/{s}/leaderboard` | `#/s/{s}/home` + one R4-7-style notice (features deferred, WLT §9) |
| `#/s/{s}/home`, `/inbox`, `/settings`, `/e/{id}`, `/channel/{id}`, `/workspace` | unchanged |

Build the codec fresh; harvest only the router *transport* (`createBrowserTarget`/`createMemoryTarget`, `router.ts:36-97`). `buildHash` (`router.ts:170-187`) is explicitly condemned (C-7).

### 4.3 State ownership

| State | Owner | Persistence |
|---|---|---|
| space, view, `k/` slug+mode, `e/` origin, stack, pinned, per-panel tab, per-panel contentSurface, `q`, `session`, `msg` anchor | **URL** (nav store mirrors) | shareable/reloadable |
| `activeSessionId`, focus, palette open, selection, drag state | nav/ui store | none (never URL — matches `routeKey`, `router.ts:101-104`) |
| Terminal instances, offsets, decoder state, leases, parked set | TerminalPool (`@tm8/terminal-core`) | app lifetime |
| Terminal font/theme/cursor settings | settings store | localStorage (shared key with `ui`) |
| Viewer's per-session surface preference (Terminal/Chat) | client | localStorage keyed (member, workSession) — CHAT §5.3: never written to entity/profile/pin |
| Chat draft | client | durable local storage keyed (member, workSession) — CHAT §10.3 |
| Chat pages/cursors, optimistic journal | client cache | reconciled by `clientMutationId` / server truth (CHAT §16) |
| Side-panel kind selection in Workspace View | client | localStorage per (viewer, space) **[RULED HERE]**; defaults §4.7.1 |
| MenuConfig, delivery, pins, inbox read state | **server** | per contract |

### 4.4 Layout contract (geometry)

Tracks and equations verbatim from WLT §5.6:

- Servers rail `S ∈ {0, 48}` (fixed at reference capture). Menu rail `M ∈ {48, 220}`. `minmax(0,…)` forbidden anywhere.
- Workspace grid: `minmax(200px, var(--ws-left)) 8px minmax(C_min, 1fr) 8px minmax(220px, var(--ws-right))`; `C_min = max(320, V·320 + max(0,V−1)·8)`.
- Breakpoints DERIVED at reference capture by measurement (borders/scrollbars/resizers included): full 3-panel requires `W ≥ S + M + 200 + 8 + C_min + 8 + 220 + Σb`; right stacks below; then left; below `S + 48 + C_min + Σb` → full-width sheets.
- Shrink order: menu collapses → side panels to floors → pins demote (loop, §4.7.4) → center to 320.
- Non-workspace views: shell regions per inherited widths (IconRail-equivalent = SpaceTabBar per §4.1; PanelStack peek 440px, pinned `flex:1 1 0` min 320 — `shell.css:229,239`).
- Acceptance: real-browser measurement at max width and at each transition with worst-case content (UUID titles). jsdom never closes a layout lane (PIXEL-TRANSPLANT-SPEC §5).

Note the gap-width delta: WLT uses `G = 8px`; the shipped grid uses 6px resizer tracks (`workspace.css:73-78`). **WLT wins (8px)**; the resizer affordance lives inside the gap track.

### 4.5 Domain configuration registry

One module (`ui-next/src/domain/registry.ts`) drives routes, origin validation, palette, menu-ref validation, and both primitives. An exhaustiveness test asserts a row per member of `CoreEntityKindSchema` (15 kinds, `schemas.ts:87-92`) — the WLT §2.1 totality law.

#### 4.5.1 Row shape

```ts
interface DomainKindConfig {
  kind: CoreEntityKind | `c:${string}`;
  label: string; labelPlural: string;
  slug: string | null;                     // null for message (anchored strategy)
  strategy: 'collection' | 'special' | 'anchored';   // WLT §2.1
  routeBuilder?: (id) => Hash;             // strategy=special (channel)
  menuEligible: boolean;                   // strategy === 'collection' (derived, asserted)
  defaultMode: CollectionMode;             // per-kind default of the six layouts
  hiddenModes: CollectionMode[];           // hidden, never hard-coded away (WLT §3)
  z: KindEntry;                            // inherited Z1–Z4 registry entry (chip/card/content/fullLayout)
  list: ListConfig;                        // §4.5.2 — EntityListPanel behavior as data
  detail: DetailConfig;                    // capability defaults + Content variant selection
  palette: { createLabel?: string; primaryAction?: ActionRef };
}
```

The inherited `KindEntry` (`registry/types.ts:122-173`) is reused as the `z` member — the Z1–Z4 contract, `fallbackKindEntry` for unknown kinds (`KindRegistry.tsx:948-982`), and per-instance `EntityCapabilities` gating survive unchanged. The registry rows for the frozen set follow WLT §2.1 exactly (slugs `tasks sessions docs teammates pulls members spells skills collections files commits projects interaction-profiles`; reserved words `home feed inbox workspace settings channel e k`; `channel` special; `message` anchored with the tombstone rule; `c:{name}` → `c-{name}` collision-checked).

#### 4.5.2 `ListConfig` — EntityListPanel behavior as data **[RULED HERE — the C-5 fix]**

```ts
interface ListConfig {
  sections?: { id; label; filter: QueryFilter; collapsedByDefault?: boolean }[]; // task: current/completed
  lifecycleTabs?: { id; label; filter: QueryFilter }[];      // work_session: open/done/archived…
  tree?: { by: 'hierarchy'; guideLines: boolean };           // task subtree; session coordinator→worker (R-UI-3)
  tile: { badges: TileBadgeSpec[]; pulse?: (s: EntitySummary) => boolean };  // priority, live dot, model…
  liveCount?: { filter: QueryFilter; label: (n) => string }; // sessions '● N live'
  quickCreate: boolean;                                      // header '+'
  quickLaunch?: ActionRef;                                   // sessions quick launch
  primaryActions?: ActionRef[];                              // task: Run / Coordinate (kind-scoped, per WLT §3)
  filters: FilterSpec[];                                     // per-kind filter chips
  sort: SortSpec[];                                          // offered sorts
  needsAttentionGroup?: (s: EntitySummary) => boolean;       // session 'NEEDS YOU' (WAVE-1 addendum)
  liveness?: (s: EntitySummary) => Liveness;                 // sessionIsAttachable — ONE predicate (R-UI-5)
}
```

The WLT §3 survival list maps 1:1 onto these fields and becomes the acceptance matrix: every surviving behavior names the field that carries it and the harvested source (`useTasks.ts:151` tree; `useSessions.ts:54` liveness; `TaskPanel` sections/filters; `ResourcePanel` lifecycle tabs/live count). A behavior with no field is a spec defect, not an inline special case.

#### 4.5.3 Session rules that bind the config

- `liveness` implements R-UI-5: one predicate derives the row's click target AND the live affordance; a `status=running` row with no live PTY presents "stale — node restarted", never live.
- Terminate cascades with a blast-radius confirm; complete is intent-only (R-UI-6).
- Live count counts ALL live work_sessions in the space (WLT §5.2 bar contract).

### 4.6 The two primitives

#### 4.6.1 EntityListPanel

Anatomy (top→bottom): **kind selector** (registry-driven; collection-strategy kinds only) → **header row** (Create, quickLaunch, live count) → **filter row** (`ListConfig.filters` chips + sort) → **body** (sections | lifecycleTabs | flat, tile list per `tile`, tree per `tree`, virtualized above 200 rows using the Thread `VirtualList` engine) → nothing else. Data: one `usePolledCollection` subscription per (kind, filter) query key (shared poll registry, `usePolledCollection.ts:76`). Unavailable affordances render disabled-with-reason via the capability seam — never dropped, never faked (PIXEL-TRANSPLANT-SPEC §3; F6).

#### 4.6.2 EntityDetailPanel

The inherited Z3 anatomy, verbatim (`EntityPanel.tsx:243-424`): header (breadcrumb · glyph · inline title · status pill · overflow) → action bar (react/points/Link/Add child/Pull + registry primaries, gated by `EntityCapabilities`) → tabs **Content / Discussion / Connections / Activity** → footer (presence · created-by · `v{n} · active {t}`). Content renderer = `registryFor(kind).Content`; no kind branches outside the registry.

**`work_session` Content region** (RULING D + K; CHAT §4.2): a Content toolbar with the accessible **[ Terminal | Chat ]** tab list ("Work session surface", CHAT §18.1) → the active peer surface. Never split. Terminal is default, always present, never gated by profile. Terminal surface = chrome strip (identity · status · exit-terminal chip `⌃\``) → xterm host slot (pool lease) → exited fallback (read-only status + transcript link). Layout: `chrome auto · host flex:1 1 auto; min-height:160px; min-width:0; overflow:hidden` (WLT §5.2b). Chat surface per §4.9. The pool lease persists across surface switches; switching hides/suspends, never disposes (WLT §5.2b; CHAT §5.4).

### 4.7 WorkspaceCenter

#### 4.7.1 Composition

Fixed top row: **LiveSessionBar** — `● {focused session} — N live`; click = open/raise; count opens the roster popover; reload/reconnect reachability of every live session is acceptance (WLT §5.2). Below: the visible columns. Empty state (`stack ∪ pinned = ∅`): live-session roster + grammar hint; `?session=` auto-opens. Side panels default **left = tasks, right = sessions** **[RULED HERE — maestro heritage; per-viewer persisted per §4.3]**.

#### 4.7.2 Columns **[RULED HERE — the §2.2 rulings]**

Visible = pinned panels (left→right in pin order) then the stack-top panel rightmost. Each column `flex: 1 1 0; min-width: 320px`; inter-column gap 8px. Esc pops stack top only (never pins; only when no higher keyboard layer holds focus). Pins dismissed explicitly. Focus follows last user interaction.

#### 4.7.3 Admission

Pin admission requires measured `centerWidth ≥ C_min(V′)` for the post-admission V′ AND `pinned.length < MAX_PINNED = 3`, AND the pool lease constraint (§4.8.3). Refusal is a visible disabled-with-reason on the pin control, not a silent no-op.

#### 4.7.4 Normalization loop + terminal state **[C-3 RULED HERE]**

On any width change or state change: while (`centerWidth < C_min(V)` OR `pinned.length > 3`) demote the **oldest** pin onto the stack (push on top). Bounded by `pinned.length` iterations. **Exit rule:** if the loop exhausts pins (`pinned = 0`) and `centerWidth < 320` still holds, normalization STOPS — the stack-top column renders at the grid floor and WLT §5.6's breakpoint machinery (side-panel stacking → full-width sheets) is the responsible mechanism; normalization never empties the stack. One debounced canonical `replaceState` after the loop settles. Widening never auto-restores demoted pins. Browser tests: empty center; pinned-only 3→2→1; reload at each state; exactly one `replaceState` per settle; the sub-320 stop state.

### 4.8 TerminalPool

Lives in `@tm8/terminal-core`. One app-lifetime instance. **Per §0.1: the API below is the contract; byte handling is frozen maestro-verbatim. The implementation is maestro's own two-part mechanism — a kept-mounted home (AppWorkspace pattern) plus TeamView's proven `appendChild` reparent/restore for placing an instance into a host (§4.8.6). The keep-mounted CSS-positioning variant remains a legal implementation of the same API.**

#### 4.8.1 API

```ts
interface TerminalPool {
  acquireHost(sessionId: string, hostEl: HTMLElement, opts: { focusTarget: HTMLElement }): Lease;
  releaseHost(lease: Lease): void;          // idempotent; stale lease = no-op (StrictMode-safe)
  markWarm(sessionId: string): void;        // → visibilityDriver.touchWarm
  setActive(sessionId: string | null): void;
  onActiveChange(cb): Unsubscribe;
  setCapacity(k: number): void;             // clamped ≥ MAX_PINNED + 2
}
interface Lease { readonly token: symbol; readonly sessionId: string; }
```

`acquireHost` reparents the instance's existing DOM node into `hostEl` via `appendChild`, then re-fits (fit gating rules harvested from `SessionTerminal.tsx:206-236` — renderer-ready, fonts-ready, zero-rect fit is a test failure). `releaseHost` reparents into the hidden parking container. Portals are not the mechanism (WLT §5.2a). `opts.focusTarget` is the owning panel's Content tab header — the blur-chord destination, stable across reparent/park (WLT §5.8/R5-5).

#### 4.8.2 Instance & capacity

A `TerminalInstance` = xterm (DOM renderer only — `SessionTerminal.tsx:100-109` policy carried verbatim) + fit addon + transport registration + write-scheduler binding + settings subscription + resize observer + the container div it owns. Capacity **`k`, floor `MAX_PINNED + 2 = 5`** — deliberately above the shipped `MOUNTED_TERMINAL_LRU_SIZE = 4` (`CenterPane.tsx:24`) (C-2). Leased instances are eviction-ineligible; eviction selects the LRU among **parked** instances only; eviction = the full teardown discipline harvested from `SessionTerminal.tsx:381-407` (dispose observers, `onData.dispose`, unregister, `closeSession`, size-map cleanup, `term.dispose()`); return after eviction = fresh instance + `requestFullReplay` offset-0 (`ptyTransport.ts:574`). Visible-slot occupant change = acquire-new-then-release-old as one atomic handoff (transient `k+1` allowed for the handoff only). Pool full with no parked instance ⇒ grow transiently, shed at next release.

#### 4.8.3 Interaction with the two dials

The warm-socket LRU (`WARM_LRU_SIZE = 3`, `visibilityDriver.ts:49`) remains a separate dial inside the driver; the pool never conflates it with `k`. `markWarm` fires on `?session=` hydration, panel open, roster switch, and Terminal re-selection after Chat (WLT §5.2c). Pin admission never admits more simultaneous leases than `k − 1` (WLT §5.2a) — surfaced through §4.7.3.

#### 4.8.4 Visibility & activation

Visibility = rendered host lease (stack top, pinned column, or Z4 Content — Z4 is a first-class host) AND outer tab = Content AND `contentSurface = terminal` (WLT §5.2c). All other states: `visibility:hidden` + `aria-hidden`/`inert` on the parked/hidden layer + reconciliation kick + flush-before-suspend. The driver keeps computing visibility from the DOM (`visibilityDriver.ts:67`) — parking naturally reads as hidden; no second visibility source is introduced. Exactly one `activeSessionId` (blink, keyboard, fit/PTY-resize authority) = last user-interacted visible terminal; succession on release/hide → most-recently-interacted remaining visible, else `null` (keyboard reverts to chrome).

#### 4.8.5 Required tests (WLT §5.2a/c, verbatim — all are lane acceptance)

Identity survives Content→Discussion→Content; StrictMode double-mount; eviction-while-parked; four visible + opening a fifth (replace); lowering `k` at runtime; releasing the active lease; duplicate-route hydration; promote→collapse identity into Z4; two pinned live sessions (both stream, one blinks/fits); resize authority follows activation; Terminal→Chat→Terminal preserves exact PTY/decoder/scroll state and re-fits; activation succession; cold-deep-link-past-grace; zero PTY bytes on blur chord + exact focus landing across reparent/park.

#### 4.8.6 Implementation model — maestro's reparent mechanism, ported (per §0.1 Q2)

The pool owns each instance's DOM node in the retained parking container (the generalization of TeamView's `originalParent` home). `acquireHost` = TeamView's slot move, ported convention-for-convention: `host.appendChild(term.element)` (the imperatively-created `.xterm` node itself, `TeamView.tsx:468,492-499`), then a refit under a **double `requestAnimationFrame`** (`:504-508`); `releaseHost` = the restore: re-`appendChild` into the parking container, then refit (`:517-526`). Visibility stays DOM-computed (the driver is built for reparenting views, `terminalVisibilityDriver.ts:9-12`) and write scheduling stays element-keyed (`terminalWriteScheduler.ts:17`) — the two conventions that make reparenting safe in maestro. "Parked" = homed in the parking container (reads as hidden to the driver; socket suspend/warm handled by the unchanged driver). Identity, capacity, eviction, activation, and every §4.8.5 test hold exactly as written. The first implementation step is a direct port of TeamView's move/restore effect into `acquireHost`/`releaseHost` with the §4.8.5 suite as its harness. The keep-mounted CSS-positioning variant (the shipped `CenterPane.tsx:186-211` mechanism generalized) remains a legal fallback behind the identical lease API if the port surfaces a defect — with the failure documented, never for convenience.

### 4.9 Chat surface — **PHASE 2 (deferred per §0.2)**

Implements CHAT verbatim *when built*; sequenced after the app runs and the terminal works properly. Phase 1 ships terminal-only sessions with no surface switch; the toolbar seam and `contentSurface` codec slot are built now so nothing forecloses this section. The items below are the binding condensation plus rulings.

1. **Read**: `entities.feed` (`GET /v2/entities/:id/feed`, `catalog.ts:154`) with `scope=session_chat_v1`, `order=newest` initial, single opaque cursor; `around=<message|activity>:<id>` mutually exclusive with cursor (`schemas.ts:655-665`). Render chronological; prepend-preserving scroll; New-items control; exhaustion only via `nextCursor: null`; virtualized with focus-retention (reuse the Thread `VirtualList` engine).
2. **Items**: discriminated `FeedItem` (`schemas.ts:687-699`) — message rows with delivery facets (`DeliverySummary`), activity as typed cards over the closed verb set, unknown variants → safe generic card, grouping ONLY by `logicalOperationId` (C-8; never timestamp-only — CHAT §9.4), tombstones retained.
3. **Composer**: stored-first via the message facade (`PostMessageInput` batch shape, `schemas.ts:329-364`); modes new-message/reply; drafts per §4.3; four-layer send state (draft / "Saving…" reconciled by `clientMutationId` / stored / delivery facet); Enter sends, Shift+Enter newline, help text announces mode (CHAT §10.5); **Send again** never "Retry" (C8); exited session ⇒ readable Chat, composer explains stored-only (CHAT §10.6).
4. **Delivery**: read from the facet / `messages.delivery.get` (`schemas.ts:563-590`); the CHAT §11.2 label table verbatim; never inferred from bubble existence, exit codes, terminal output, or liveness.
5. **Availability gating**: Chat tab exists when the pinned profile resolves Chat-capable; resolution failure ⇒ Terminal selected + visible error state + core-renderer fallback, pin never rewritten (CHAT §5.1, §14.3). **Additionally [RULED HERE]:** while `entities.feed` is server-unavailable (today's state — implemented but not production-mounted, §3.5.1), the surface switch renders Terminal-only with no error copy, via the same capability seam as every other unavailable op — an unflavored session, not a degraded one.
6. **Never**: PTY bytes in the feed, second message store, client-side message+activity merging, durable unread badges (viewer-local "new since opened" only — C4), split view.

### 4.10 Menu (RULING H)

`MenuRail` renders the space's `MenuConfig` (`spaces.menu.get`; embedded in space settings read). Rendering rules (WLT §2.3): group headers label-only, never clickable; view item WITH children = caret row (row click = the view, caret expands children); without children = plain row; kind item = pre-filtered Entity View link via the registry route strategy. Fail-closed: missing row, malformed-of-understood-version, unsupported-future-version, **or op-unavailable (§2.7)** all render the versioned shipped default; `settings` always present. Admin edit surface at `settings/menu` sends `MenuConfigPayload` + `expectedRevision`; `menu_revision_conflict` ⇒ reload-and-retry UI; `menu_upgrade_required` ⇒ explicit "edited by a newer version" state. Convergence via the `menu.updated` full-payload event when the event lane lands; polling refresh until then. Shortcuts bind to registry/view refs, never menu positions (WLT §5.8).

### 4.11 Keyboard & focus

WLT §5.8 verbatim: the 6-layer priority chain; every layer consumes; plain keys dead in text entry; the `g` map (`g h/t/s/d/m/p/c/i`, `g ,` Settings); palette `/` guaranteed + ⌘K where receivable; pin `p`; ⌘\ menu rail; list bindings (`j/k`, Enter, ⌘Enter = registry primary, `c` create); Esc pops stack top last; terminal owns everything in Terminal mode except physical `Ctrl+Backquote` intercepted inside `attachCustomKeyEventHandler` with zero PTY bytes, focus → lease-supplied Content tab header, mandatory visible chip + `aria-describedby`. Frozen exclusion list and per-platform receive tests as design input (R8-3). Every table row = a unit test; terminal ownership + escape additionally browser-tested. Chat = ordinary text entry (layer 4); a hidden lease grants no keyboard authority.

### 4.12 Drag-drop & share-into-session

The inherited 7-row drop grammar is preserved; **row 8** = entity → live work_session = share-into-session (RULING F). UI obligations:
- Drop targets: session panel (either surface + Content toolbar), live-session bar + roster rows, live session tiles. File onto the **Chat composer** = attach to draft; any other entity onto the **panel** = handoff flow, never silently converted (CHAT §4.5).
- Issue `handoffs.send` with client-generated `handoffId` (= `clientMutationId`); render the two-axis state (`deliveryStatus × recordStatus`, `schemas.ts:592-653`) as two facets, never one badge; `unknown` never styled as success; re-attempt = new share with a new `handoffId` (R8-5). Withdrawal via `handoffs.withdraw` decorates the correlated message/edge with a badge by correlation — the message row is not rewritten (R6-3).
- Row 8 has **no undo token** (irreversible PTY delivery — WLT §9); the drop confirm/ghost must not promise undo.
- **Standing law [RULED HERE, generalizing F6/X4]:** every drop row whose executing op is unavailable renders its targets disabled-with-reason. A ghost label may never advertise an action the facade cannot perform.

### 4.13 Data/facade seam

`@tm8/ui-data` exports the `CollabFacade` seam (unchanged interface, `facade/CollabFacade.ts:45-161`) + `RealFacade` + `capabilities` + hooks. Additions for this spec: `getFeed` (entities.feed), `getMenu`/`updateMenu`, `sendHandoff/listHandoffs/withdrawHandoff`, `getMessageDelivery` — each declared in `capabilities` so every consumer gates uniformly. Conventions preserved: typed-empty reads, rejected-`not_implemented` writes, hollow-field captions; one polled subscription per query key (`usePolledCollection`); the feed-update abstraction wraps polling now, ordered subscription later (CHAT §16.1) — the UI never assumes the WS path is complete. **Real-path integration tests are a standing requirement from the first shell milestone** (the F5 mandate): each build-order stage lands with at least one test against a live server.

### 4.14 Surfaces that must exist (v1 inventory)

| Surface | Route | Status source |
|---|---|---|
| Home dashboard (frozen `spaces.home` verbatim) · Feed (default channel) · Inbox | `home` `feed` `inbox` | WLT §5.1 |
| Workspace View (this spec's core) | `workspace` | WLT §5.2 |
| Entity Views for every collection-strategy kind (six modes, registry defaults/hides) | `k/{slug}` | WLT §5.3, §3 |
| Channel list · Channel View (Thread + EntityListPanel, pinned shelf + auto-tabs inherited) | `channels` `channel/{id}` | WLT §5.5, R7-6 |
| Entity Z4 (kind fullLayout variants; work_session Z4 hosts the terminal) | `e/{id}` | WLT §5.3/§5.2c |
| Message anchored route + tombstone standalone (no companion, left panel collapsed) | `channel/{id}?msg=` / `e/{messageId}` | WLT §2.1 |
| Space settings + Linked Projects + Menu editor; node-admin Project Registry | `settings[/projects|/menu]` | WLT §2, §7.5 |
| Command palette (entities + implemented views; deferred features = disabled discovery rows only) | overlay | WLT §2/RULING E |
| Live-session bar + roster; spawn/Run flow (direct spawn, harvested `runTask.ts`) | in workspace | WLT §5.2 |
| Deferred, NOT feature-reachable: Leaderboard, Activity screen, saved-views/axes UI | — | WLT §9 |

### 4.15 OPEN items (cannot be resolved at this altitude)

| # | Question | Recommendation |
|---|---|---|
| O-1 | Exact default MenuConfig IDs/labels/icons + backfill payload (WLT §2.3 defers to dossier) | UI ships its versioned default constant mirroring the WLT §2 diagram; dossier value supersedes at adoption. |
| O-2 | `S` (servers rail) shown-or-hidden in Phase 1 — "fixed at reference capture" | Recommend **hidden (S=0)**: one implicit server earns no 48px; SpaceTabBar carries switching. Needs the user's reference-capture sign-off (RULING A). |
| O-3 | `q` codec — §4.2.4 v1 vs the dossier's eventual versioned DTO codec | Ship v1 behind the version byte; dossier bumps `v`. |
| O-4 | Reference capture + crop-specific pixel invariants for the terminal chrome strip (RULING A) | Block workspace *acceptance* on it, not workspace *construction*. Capture at the shell-skeleton milestone. |
| O-5 | `EntityListPanel` virtualization threshold (200 **[RULED HERE]**) and tile heights | Confirm against worst-case real data at reference capture. |
| O-6 | Whether `ui`'s Sessions/Graph screens get interim redirects into `ui-next` during co-existence | Recommend no cross-app redirects; the apps stay independent until cutover. |

---

## 5. What must be visually designed (nothing below exists in any document)

**Superseded as the working list by the designer-facing package: `~/Desktop/tm8-ui-design/04-DESIGN-WORKLIST.md` (Tier 0 → Tier 4 → Phase 2, per §0.3), which additionally carries the Tier 2/3 surfaces the user brought into scope.** Retained here as the engineering-side summary, ranked by whether it blocks the core layout. Note: item 7 (Chat) is now Phase 2 per §0.2.

**Blocks core layout:**
1. **The shell wireframe + new reference capture** (RULING A — the retired oracle's replacement; includes O-2). Nothing can be *accepted* without it.
2. **Terminal chrome strip** — session identity, status, exit-terminal chip; this is the crop-invariant region the pixel law still governs (WLT §5.2b/§6).
3. **EntityListPanel anatomy** — kind selector, header, filter chips, tile variants per kind (task badges/sections vs session tree/lifecycle tabs/live dot). The §4.5.2 config gives structure; the visual language is undesigned.
4. **WorkspaceCenter empty state** — live-session roster + grammar hint (WLT §5.2).
5. **Live-session bar** — height, density, roster popover.

**Blocks features, not the layout:**
6. **MenuRail rendering** — caret view items vs plain rows vs label-only headers, collapsed-48px iconography for view AND kind refs, the menu editor in settings.
7. **Chat surface** — bubbles, provenance labels ("To/From this session"), artifact cards, state-change rows, collapsed mutation groups, delivery badges for all 8 states, composer + reply context, every CHAT §17 state.
8. **Handoff affordances** — drop-target highlight on a terminal, ghost labels, two-facet state rendering, withdrawn badge, `sourceMissing` rendering.
9. **Overflow-drop notice + disabled-with-reason vocabulary** (R4-7; §4.12 law) — one consistent component.
10. **Palette** — disabled "not available yet" discovery rows; scope presentation.
11. **Breakpoint states** — right-stacked, both-stacked, full-width sheets (WLT §5.6 names them; nobody has drawn them).
12. **Profile-failure states** — Chat tab error indicator, core-renderer fallback notice (CHAT §14.3).

---

## 6. Risk register (ranked)

| # | Risk | Likelihood × impact | Mitigation (the one I'd actually use) |
|---|---|---|---|
| R1 | **Pool reparent port** — downgraded from "unproven mechanism" after the maestro read (§0.1 Q2): TeamView reparents live xterms in production. Residual risk is generalizing a two-view pattern (move + restore between two known parents) into an N-host pool with eviction | M × M | Port TeamView's move/restore conventions verbatim (double-rAF refit, restore-then-refit, DOM visibility, element-keyed scheduler); §4.8.5 suite as the harness; keep-mounted variant stays the documented fallback behind the same lease API (§4.8.6). |
| R2 | **Production mount gap**: four complete, test-covered W2 handler modules (feed, messages/handoffs, profiles, menu) are mounted only by their tests (§3.5.1) — a running server 501s menu, handoffs, delivery, and feed today; and correctness under *production composition* is unproven even after mounting | M × M | The §3.5(b) mount + verify lane: 4 import/call lines + the legacy-messages swap, then migrations 015–029 apply-clean, w2 suites green against the mounted composition, conformance over the new ops. Capability gating (§4.10, §4.12) keeps the UI honest meanwhile. |
| R2b | **Terminal drift vs maestro main** — three concrete items found (§0.1 Q1): cursor-blink hard-disable (`ef0dcbe`), PTY-WS heartbeat (`8e2e82a`), and the unverified `0539726` legs (bounded broadcasts, multi-viewer size sync) | M × M | The drift audit against `~/Desktop/Projects/maestro/agent-maestro`, early and independent; adopt maestro's behavior on every divergence; extend the golden-frames fixture with any new frame shapes. |
| R3 | **Mock-vs-real drift repeats in ui-next** (the F5 failure: ~534 green tests over a broken app) | M × H | Real-path integration test as a merge gate per build-order stage (§4.13); no stage closes on jsdom alone; layout lanes close on browser measurement (PIXEL-TRANSPLANT-SPEC §5). |
| R4 | **Suspend/flush ordering regression** inside the pool → silent terminal holes (the class `STATE.md:194` documents) | M × H | The flush→suspend order lives in ONE function inside `@tm8/terminal-core` with the golden-frames + transport tests extracted alongside; `releaseHost` may not touch the transport directly. Add the kill-test: park-while-streaming then return ⇒ byte-identical transcript. |
| R5 | **Codec/normalization complexity** (2048 ordered drop, demotion loop, replaceState debounce) breeds history bugs | M × M | Pure-function codec + property tests (round-trip, cap, drop order); ONE normalizer with an idempotence test (`normalize(normalize(s)) === normalize(s)`); the §4.7.4 browser suite. |
| R6 | **Two apps, one facade** — `ui` and `ui-next` drift on RealFacade/capabilities during co-existence | M × M | `@tm8/ui-data` + `@tm8/terminal-core` + `@tm8/kit` shared packages (§3) — drift becomes structurally impossible where it matters; tokens byte-equality test covers the rest. |
| R7 | **Keyboard contract regressions** — chrome shortcuts leaking bytes into a PTY, or Esc double-handling | L × H | The §5.8 per-row unit tests + the two browser tests (type `j` into focused terminal → PTY, list unmoved; blur chord → zero bytes + exact focus landing). These are cheap and already enumerated. |
| R8 | **Scope underestimation** — "rebuild the 270-file module's surfaces with two primitives" is a large program wearing a small spec | M × M | The build order is the control: each stage has a named acceptance (registry exhaustiveness test → codec property tests → measured breakpoints → survival-list matrix → §4.8.5 suite → CHAT §22). No stage starts before the previous one's acceptance is green; the survival list is the scope fence — anything not on it and not in §4.14 is out. |
| R9 | **Dossier/W1 gating friction** — ui-next consuming ops whose dossier adoption is pending (WLT §10.3) | L × M | Only new-op consumers are gated (§3.5); layout/registry/route/pool lanes proceed on existing ops. Capability seams make late-landing ops a flag flip. |
| R10 | **Reference-capture becomes a bottleneck** (RULING A blocks acceptance) | L × M | O-4: capture at the shell-skeleton milestone, not at the end; crop-specific invariants only for the terminal chrome strip, wireframe-level approval for the rest. |

---

*End of spec. Companion reading order for implementers: WLT → CHAT → this document §4 → the survival list (WLT §3) as the acceptance matrix.*
