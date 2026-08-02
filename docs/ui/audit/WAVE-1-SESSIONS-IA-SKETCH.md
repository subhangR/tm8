# Sessions surface — IA sketch (Wave 1 starting point)

**Status:** DRAFT for discussion. Not a spec, not approved, nothing built from it.
**Author:** Atlas · **For:** Vega, and the Wave 1 design decision.
**Inputs:** the audit's D-lane verdict (*no design exists for work_session*), the
C-lane benchmark of old maestro, the contract's `work_session` shape, and what
Wave 0 shipped.

> Wave 0 built the *minimum honest* sessions surface — a list and a detail view —
> to close the "live agent unreachable" bug. It was deliberately not designed.
> This sketch is about what the surface should actually be.

---

## 0. The constraints any design must satisfy

| # | Constraint | Source |
|---|---|---|
| C1 | Composition maxim: a surface must be buildable from entity components (Z1–Z4) + collection views + the two axes | T-L2 |
| C2 | `work_session` is a CORE kind — it gets Z1/Z2/Z3/Z4 like everything else | contract §1.1 |
| C3 | DOM renderer only, forever. No WebGL/Canvas addons | STATE.md:140 |
| C4 | Every mounted xterm costs a socket + a repaint loop — mount only what is visible | the visibility driver, unobservable today |
| C5 | Sessions are spawn-only; never client-creatable | contract:421 |
| C6 | Status is polled (1.5s). The events WS cannot carry graph events yet | audit F-realtime |

**C1 is the one that bites.** A terminal is not an entity component and cannot be
composed from one — T-L10 already concedes this ("the panel around it is an
entity component; the canvas inside it is not"). So the sessions surface is the
first place the composition maxim needs an explicit, written exception. **That
ruling is Wave 1's first deliverable, before any layout.**

---

## 1. Where the terminal lives — three options

### Option A · Terminal as the Z4 full view *(recommended)*

```
┌──────┬────────────┬──────────────────────────────────────────┬───────────┐
│ icon │ left rail  │  CENTER = session Z4                     │ Z3 panel  │
│ rail │            │ ┌──────────────────────────────────────┐ │ (task the │
│      │ Sessions ◀ │ │ ● running · Forge · opus · 12m       │ │  session  │
│      │            │ │ [Prompt] [Terminate]        [⤢][⋯]  │ │  works on)│
│      │            │ ├──────────────────────────────────────┤ │           │
│      │            │ │                                      │ │           │
│      │            │ │        xterm (fills)                 │ │           │
│      │            │ │                                      │ │           │
│      │            │ ├──────────────────────────────────────┤ │           │
│      │            │ │ > prompt composer            [send]  │ │           │
│      │            │ └──────────────────────────────────────┘ │           │
└──────┴────────────┴──────────────────────────────────────────┴───────────┘
```

*Why:* the terminal gets the space it needs; the panel stack stays free for the
*task* the agent is working on — which is the pairing a human actually wants
(watch the agent, read the task). Matches old maestro's centre-pane instinct (C)
without inheriting its right-panel session list. Honours C4 trivially: one
visible session, one mounted terminal.

*Cost:* watching two agents at once means splitting or switching.

### Option B · Terminal inside the Z3 panel

Consistent with "everything is a panel", but a 440px-wide terminal is not usable
for real agent output, and panels stack — implying N mounted terminals, which is
exactly what C4 forbids. **Not recommended.**

### Option C · Dockable terminal dock (bottom or right)

An editor-style dock, independent of the current view, with session tabs. Best
for "keep half an eye on the agent while working elsewhere", and the natural home
for a future multi-terminal view. **Recommended as a Phase 2 addition to A**, not
instead of it — it doubles the layout surface and needs the visibility driver to
be genuinely exercised first.

**Proposal: build A now; keep C as the known extension.** Decide A-vs-C before
building, because A's chrome is reusable in C and the reverse is not.

---

## 2. The list

```
SESSIONS                                             [ Refresh ]  [ ⌘K ]
  Filter: [ All ▾ ] [ Agent ▾ ] [ Project ▾ ]     Group: ( Status | Task | Agent )

LIVE · 2
  ● running    Forge · opus-4.8      T-101 Schema foundation    12m    [→]
  ◐ spawning   Scout · sonnet        T-104 Entity panel UI       3s    [→]
FINISHED · 14
  ○ exited     Probe · sonnet        T-102 RLS policies         2h     [→]
  ⨯ failed     Forge · opus-4.8      T-100 Conformance epic     1d     [→]
```

- **Rows are Z2 `EntityCard`s for `work_session`** — satisfies C1/C2, and means
  the row gets reactions/counters/badges for free. Wave 0 used a bespoke row to
  stay minimal; that should be replaced, not extended.
- **Filters** map to `CollectionQuery` filters, so the list is a saved view like
  every other collection. Group-by uses the axis machinery.
- **The task chip is the point.** A session without its task is an orphan; the
  row should always carry the `working_on` target.

### Two behaviours worth stealing from old maestro (C)

1. **The single-click contract.** Old maestro derived *both* the click target and
   the Resume button's visibility from one predicate, so the UI could not lie
   about whether a terminal was alive. tm8 should do the same: one function
   `sessionIsAttachable(session)` drives the row's affordance *and* what opening
   it shows.
2. **Subtree semantics.** Closing a coordinator cascaded to descendants;
   "mark done" was a pure intent marker that left processes running. tm8 has no
   session hierarchy yet — but it will (coordinators spawn workers), so **decide
   now whether `work_session` nests via `parentId`**, because retrofitting the
   list grouping later is expensive.

---

## 3. Session Z4 — anatomy

| Region | Content | Notes |
|---|---|---|
| Header | status pill · persona · model · project · elapsed · node | Status is the one thing that must never be stale-looking (C6 — poll, and say so) |
| Actions | Prompt · Terminate · Copy id · open transcript | Terminate needs a confirm; it kills a real process |
| Body | **the terminal** | Fills. DOM renderer. Its own scrollback |
| Composer | prompt input, history, what-was-sent record | Replaces `window.prompt()` |
| Rail (Z3) | the task it works on, the transcript doc, sibling sessions | All real edges: `working_on`, `transcriptDoc` |

**The composer is the highest-value undesigned piece.** Today prompting is a
browser `window.prompt()`: no history, no record of what was sent, no multi-line.
An agent you cannot converse with legibly is barely steerable. Minimum: multi-line
input, submit affordance, and an in-view record of prompts sent this session.

---

## 4. Terminal chrome — what to put around it

Old maestro shipped a rich strip (context gauge, token counts, tool count,
duration, model pill, attach-files, hide). tm8 has two words. Not all of that is
earned yet — several inputs don't exist server-side. Ordered by value/cost:

| Element | Value | Available today? |
|---|---|---|
| Status + elapsed | high | ✅ `state.startedAt/status` |
| Persona + model | high | ✅ `state.agentTool/model` |
| Project + cwd | high | ✅ `content.projectId` |
| Link to the task | high | ✅ `working_on` edge |
| Connection state (attached/reconnecting) | high | ✅ client-side |
| Token/context gauge | high | ❌ **no server field** — would need a contract addition |
| Tool-call count | medium | ❌ same |
| Font size / theme | low | ✅ client-only |

**Do not design the gauge in.** It needs data tm8 does not collect; flag it as a
contract question rather than drawing a dial with nothing behind it.

---

## 5. Open questions — these need a ruling before layout

1. **The C1 exception.** Write down that a terminal canvas is exempt from the
   composition maxim, and bound the exemption so it is not a loophole.
2. **Does `work_session` nest?** Coordinator→worker trees change the list's
   grouping model. Decide before building §2.
3. **`session_modals` has no lawful home.** The design says it is "never an
   entity", so it can never render through Z1–Z4 (D-lane finding). Old maestro's
   modal UI has nowhere to go. Either grant an exception or drop the feature —
   but it should be a decision, not an omission.
4. **Ghost sessions.** A restart leaves rows at `running` with no PTY, and they
   count against the 8-slot cap. The list will show them as live and lie. Needs
   either the startup reconciliation (already specced in STATE) or a "stale —
   node restarted" presentation.
5. **Cap-exceeded UX.** `limit_exceeded` has a taxonomy entry and no UI concept.
   What does the user see when the 9th spawn is refused?
6. **Multi-terminal.** Not needed for Wave 1, but §1's A-vs-C decision depends on
   whether we intend it — and the suspend/resume machinery already built is
   waiting for it.

---

## 6. What I would build first, if this were approved

1. The C1 ruling + the nesting decision (§5.1, §5.2) — cheap, unblocks everything.
2. Z2 card for `work_session` → the list becomes a real collection view.
3. Session Z4 per §3, Option A.
4. The prompt composer (§3) — the single biggest usability gain.
5. Ghost-session honesty (§5.4) — because a list that lies about liveness is
   worse than no list.

Filters, grouping, the dock, and terminal chrome beyond the free fields come after.
