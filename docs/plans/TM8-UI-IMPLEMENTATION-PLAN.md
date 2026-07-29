# tm8 UI — Implementation Plan

**Status:** DRAFT for review. Companion to `TM8-UI-SPEC-FINAL.md` (what to build) — this document is *how, in what order, and how we know each stage is done*.
**Date:** 2026-07-27.

---

## §0 Premises — all four verified

This plan does not rest on STATE.md, which was found stale twice during preparation.

| # | Premise | Status | Evidence |
|---|---|---|---|
| P1 | The v2.11 design is sound and buildable | ✅ | 12 adversarial review rounds (FINAL GO) + independent Fable-5 architecture review → `TM8-UI-SPEC-FINAL.md` |
| P2 | Maestro's terminal is transplantable, and TerminalPool doesn't fight it | ✅ | Maestro read @ main: `pty-protocol` diff **empty**; transport laws identical clause-for-clause; **maestro already reparents live xterms** (`TeamView.tsx:492-526`) |
| P3 | The database is sound | ✅ | All 24 migrations (001–030) apply clean to a fresh DB, verified this session |
| P4 | The backend is far more complete than recorded | ✅ with caveat | ~4,848 LOC of W2 handlers; **4 complete modules never mounted in production** |

**The one open question, stated honestly:** the server suite is **not green** — 11 failed / 565 passed / 73 skipped. Failures cluster in W3 production-server and agentic-discovery tests. I could not establish whether they are real defects or load artifacts: `g01` in isolation fails on a **5-second test timeout**, not a 501, matching STATE.md's documented isolation flake. One failure is trivially a stale migration-count pin. **Stage 0 exists to resolve this before it can surprise us.**

---

## §1 Shape of the work

This is **not** "rewrite every screen." The spec *collapses* screens into collection views + entity panels — screen count goes down. It is a **shell + state-model rewrite**, plus a **mounting** change to a terminal whose byte handling is frozen, plus design work that is the true long pole.

**Two tracks run in parallel from day one.** The design track gates Stage 5; if it starts when engineering reaches Stage 5, the program stalls.

```
ENGINEERING   S0 verify ─ S1 packages ─ S2 registry ─ S3 routes ─ S4 layout ─ S5 primitives ─ S6 pool ─ S7 surfaces ─ S8 cutover
DESIGN                 Tier 0 ──────────────────────────────────────┘ (must land here)
                                    Tier 1 ─────────────────────────────────┘
                                              Tier 2/3/4 ──────────────────────────┘
PHASE 2                                                                                        Chat ──▶
```

---

## §2 Lanes

### Stage 0 — Verification & terminal drift (unblocks everything; 3 parallel lanes)

**0a · Suite triage.** Run the server suite **serially, isolated**, with no dev server or concurrent PG load. Triage the 11 failures into real defects vs. timing artifacts. Fix the stale migration-count pin in `test/db/w2-profiles.pg.test.ts`.
> *This lane has authority to stop the program.* If the W3 production-server failures are real, they are backend defects on the exact surfaces the new UI consumes, and they precede all UI work.

**0b · Mount the four orphaned modules.** `feed-context`, `messages-handoffs`, `entity-kinds-profiles`, `menu-default-channel` are complete and test-covered but reachable only from their own tests. Add 4 import/call lines to `facade/index.ts` + swap the legacy `messages.post` (`register()` throws on duplicates, so collisions are loud). Then re-run the W2 suites **under the mounted composition** — passing in isolation is not evidence of passing in production.

**0c · Terminal drift adoptions** (from the maestro read; maestro wins on every one):
- cursor blink → hard-disabled everywhere (maestro `:207`, `ef0dcbe`), replacing tm8's active-only
- PTY-WS heartbeat → adopt maestro's protocol ping/pong (`PtyWebSocketServer.ts:50-78`)
- `0539726`'s bounded-broadcast + multi-viewer size-sync legs → audit and adopt
- `8e2e82a`'s replay-ordering test coverage → port

**Gate S0:** migrations clean (done) · suite green serially · conformance sees the 4 newly-mounted families · golden-frames still passes · drift adoptions landed with tests.

---

### Stage 1 — Package skeleton + shared extraction

New package `packages/ui-next`. The current `packages/ui` stays running and untouched — it is both the working product and the reference oracle until cutover.

Extract three shared packages so the two apps **cannot** drift where it matters:

| Package | Contents | Why shared, not copied |
|---|---|---|
| `@tm8/terminal-core` | `ptyTransport`, `writeScheduler`, `visibilityDriver`, `runtime`, `terminalSize`, settings store, clipboard helpers | Highest-risk code in the repo. One copy or it forks. |
| `@tm8/kit` | Base primitives | Byte-equality is impossible across import paths; a shared package makes drift structurally impossible instead of merely detected |
| `@tm8/ui-data` | `RealFacade`, `capabilities`, `TmClient`, `events`, data hooks | Both apps consume the same facade during coexistence |

`tokens.css` is **copied** with a byte-equality test (one small stable file; a test is cheaper than an extraction). `SessionTerminal` is **split, not extracted** — its logic moves into the pool's `TerminalInstance`; its React shell dies with `ui`.

**Gate S1:** both apps build · both suites green · tokens byte-equal · golden-frames green · `ui` behaviorally unchanged.

---

### Stage 2 — Domain configuration registry ⚠️ *before layout, deliberately*

**This ordering is the single most important decision in the plan.** In v2.11, layout is a *function of* the registry. Today the app hardcodes what the spec makes data: `RAIL_SECTIONS` is a literal array, `ViewName` is a closed union, collection layouts are kind-special-cased. Build layout first and we will hardcode again, and the registry lands as decoration.

- Extend `KindRegistry`: route strategy, layout defaults, panel anatomy, `ListConfig`
- Slug + route-strategy registry (`collection` / `special` / `anchored`) with an **exhaustiveness test over `CoreEntityKindSchema`**
- `MenuConfig` runtime (read + render) + the frozen default config

**Gate S2:** exhaustiveness test green · every core kind has a registry row · left rail renders from data, not an array.

---

### Stage 3 — Route grammar + nav store

Build the codec **fresh — do not harvest `router.ts`**, which carries a known channel `/e/{id}` asymmetry (`buildHash` serialises `view:'channel'` one way and `hydrateFromHash` maps it back another).

Implements: `p` / `pin` / `t` / `contentSurface`; the **2048-char cap with ordered whole-parameter drop** (`t` tier → `pin` → `p` → `q`, never mid-token); dedup precedence pin > stack; history discipline (user nav = `pushState`, normalization = debounced `replaceState`, surface toggle = `replaceState`); legacy redirects.

**Gate S3:** property tests — round-trip, cap enforcement, drop order, `normalize(normalize(s)) === normalize(s)`.

---

### Stage 4 — Layout shell + sizing law

- Discrete toggle tracks: servers rail `S ∈ {0, 48}`, menu rail `M ∈ {48, 220}`. `minmax(0, …)` forbidden.
- `C_min = max(320, V·320 + max(0, V−1)·8)` → **320 / 320 / 648 / 976 / 1304** for V=0..4
- Looping normalization (demote oldest pin until both predicates hold), then one debounced canonical `replaceState`
- Derived breakpoints; right-stacked, both-stacked, full-width-sheet modes

**Gate S4 — browser measurement, not jsdom.** This is the core of the spec and the test environment is structurally blind to it. Measured breakpoints must match the arithmetic; no track may starve; normalization must be idempotent under resize storms.

---

### Stage 5 — The two primitives ← *design-gated*

- `EntityListPanel` driven by `ListConfig` so the **survival list is carried as data, not kind-branches**
- `EntityDetailPanel` — adapt `EntityPanel`, whose four-tab anatomy already matches
- `WorkspaceCenter` adapter — stack + pinned columns + live-session bar + empty state

**Gate S5:** a **survival-list matrix** — every item in v2.11 §3 demonstrably present (task current/completed sections, hierarchy expansion, inline status/edit/complete, Run/Coordinate, session lifecycle tabs, live count, quick launch, per-kind filters) — plus a browser pass.

---

### Stage 6 — TerminalPool

**Downgraded from "invent a mechanism" to "port a shipped pattern."** The maestro read found `TeamView.tsx:492-526` already doing `host.appendChild(term.element)` with double-rAF refit and restore-to-original-parent, and the visibility driver and write scheduler are explicitly built to tolerate it.

Port those conventions verbatim to N hosts. Lease API + parking container + `k ≥ MAX_PINNED + 2` (= 5; the shipped 4 is a config value, not a law). Single-host invariant per session; `activeSessionId` succession.

**Frozen — no spec clause may alter these:** streaming, offsets, replay, suspend, flush, decoder, dispose.

**Gate S6:** the kill-test — park a streaming terminal, return to it, transcript must be **byte-identical**. Plus browser-driven attach / stream / type / resize / switch / terminate.

---

### Stage 7 — Views & surfaces · Stage 8 — Cutover

S7 builds the view inventory on the primitives as Tier 0–1 design lands. S8 flips the default route and deletes `packages/ui` — **only** once the survival list is fully satisfied. Keep both running until then.

### Phase 2 — Chat

Off the critical path entirely. Seams preserved now so nothing forecloses it: the `contentSurface` codec slot, the Content toolbar row, and the feed-scope design. `entities.feed` mounting moves to this phase.

---

## §3 Risk register (re-ranked after verification)

| # | Risk | Was | Now | Mitigation |
|---|---|---|---|---|
| R1 | **Design debt is the schedule** — Tier 0 gates Stage 5, and this team already burned a full cycle on "built it, looked wrong" | #2 | **#1** | Design track starts day one, parallel to S0. Tier 0 is the gate on S5, tracked as such. |
| R2 | **Backend correctness under production composition unproven** — 4,848 LOC, 4 modules never mounted, 11 unexplained failures | — | **#2** | Stage 0a/0b, with stop authority |
| R3 | **F5 recurrence** — mock-green / live-broken | #4 | #3 | Real-path integration test as a per-stage merge gate; no stage closes on jsdom alone |
| R4 | **Browser verification is not systematized** — the sizing law is invisible to 691 tests | #3 | #4 | S4 gate is a browser measurement; layout lanes close on measurement, never on a green suite |
| R5 | Two apps drift during coexistence | #5 | #5 | The three shared packages make drift structurally impossible where it counts |
| R6 | Scope creep — "two primitives" is a large program wearing a small spec | #6 | #6 | The survival list is the fence: not on it and not in the view inventory ⇒ out |
| ~~R0~~ | ~~xterm reparenting is unproven~~ | **#1** | **RETIRED** | Maestro ships it; S6 is a port |

**The headline change:** what I originally ranked as the top risk — inventing a terminal reparenting mechanism — is gone, because maestro already does it. In its place, **design debt is now the critical path**, which is a scheduling problem rather than a technical unknown, and therefore addressable by starting the design track immediately.

---

## §4 What I want reviewed

1. **Is Stage 2 before Stage 4 right?** I hold that registry-before-layout is load-bearing. Argue it if you disagree.
2. **Does Stage 0a deserve stop authority?** It could gate the entire program on a flaky suite.
3. **Is the S5 survival-list matrix a sufficient gate**, or does it need per-kind browser coverage?
4. **Cutover criteria** — is "survival list satisfied" enough to delete `packages/ui`, or is there a usage bar?
5. **Anything the maestro read implies for stages beyond S6** that I've missed.
