# Wave 1 — the sessions surface: design

**Status:** DESIGN ONLY. Nothing here is built. For user review before any build.
**Author:** Atlas · **Rulings:** `WAVE-1-RULINGS.md` (R-UI-1…8) · **Sketch:** `WAVE-1-SESSIONS-IA-SKETCH.md`
**Supersedes** the sketch where they differ.

> Wave 0 shipped the *minimum honest* sessions surface — a list and a detail view —
> to close the "a live agent becomes unreachable" bug. It was deliberately not
> designed. This is the design for the real one.

---

## 0. Buildability, stated up front

Design is cheap; the truthful part is which of it the backend can actually feed.
I verified each of these against the frozen contract and the shipped migrations
rather than assuming.

| Piece | Buildable in Wave 1? | Evidence |
|---|---|---|
| Session list from `collections.query` | ✅ yes | verified live in Wave 0 |
| Z2 `EntityCard` rows for `work_session` | ✅ yes | registry entry exists |
| Session Z4 + terminal + attach | ✅ yes | shipped in Wave 0, PTY WS proven |
| **Prompt recorded as a message on the session** | ✅ **yes** | `post_message` anchors to *any* live entity — `internal.live_entity(p_anchor_id)` with only a space-membership check, no kind restriction (`007_rpc_catalog.sql:1696`) |
| Coordinator→worker tree | ⚠️ **design now, empty until Slice 4** | `parentId` exists; `execution.spawn` does not yet set it (R-UI-3) |
| **Server-side filtering by session status** | ❌ **not expressible** | `CollectionQuery.filters` has `workStatus` (a *task* field), axes, assignees, edges — **no `work_session.state.status`**. See §3.3 |
| **`session_modals` chrome (R-UI-4)** | ❌ **no contract surface at all** | zero matches for `modal` in `contract.ts`, `catalog.ts`, `schemas.ts`; no `modal` variant in the `WorkspaceEvent` union. See §6 |
| Token/context gauge | ❌ deferred | R-UI-8 — no server-side usage data |

**Two of the eight rulings cannot be built as written.** R-UI-4 (modals) needs a
contract amendment before a line of it is buildable; §3.3 (status filtering) needs
either an amendment or an accepted client-side limit. Both are designed here so
the amendment has a target, and both are flagged rather than quietly assumed.

---

## 1. Session lifecycle — the six presented states

The contract has five statuses (`spawning | running | idle | exited | failed`).
The UI presents **six**, because a ghost is not a status — it is a *disagreement*
between the status column and reality, and R-UI-5 forbids resolving it in the
status column's favour.

| Presented | Glyph | Tone | Means | Terminal | Composer |
|---|---|---|---|---|---|
| **spawning** | ◐ | waiting | process starting, no PTY yet | "starting…" | disabled |
| **running** | ● pulsing | run | attached, agent working | live | enabled |
| **idle** | ● steady | run (dim) | PTY alive, agent awaiting input | live | **enabled** |
| **exited** | ○ | idle | ended cleanly | replay, read-only | disabled |
| **failed** | ⨯ | block | ended non-zero; show reason | replay, read-only | disabled |
| **stale** | ⚠ | wait | status says alive, **no live PTY** | replay if any | disabled |

`idle` is the state most easily got wrong: it is *alive and steerable*, not
finished. It is the state a coordinator sits in between assignments, and it must
read as available, not as over.

### 1.1 `sessionIsAttachable()` — the one predicate (R-UI-5)

```
sessionIsAttachable(session) -> 'attachable' | 'replay-only' | 'stale'
```

One function derives **both** the row's click target **and** its live affordance,
so the two can never disagree. It is the rule that forbids the lie.

- `attachable` — `running | idle` **and** the PTY is believed live → click opens
  the live terminal; row shows the live dot.
- `replay-only` — `exited | failed` → click opens the transcript/replay; no live dot.
- `stale` — status claims alive but the PTY is not → click opens replay, row reads
  **"stale — node restarted"**, and it is never shown as live.

**Where liveness comes from, honestly.** The client cannot know PTY liveness from
the entity alone; `state.status` is exactly the field that lies. Two mechanisms,
and the design needs both:

1. **Server truth (primary).** Draco's startup reconciliation marks orphaned
   sessions `exited` on boot, so after a restart the status column is honest.
2. **Client belt (secondary).** An attach that fails, or closes immediately
   without a stream, demotes that row to `stale` for the session of the page.
   This covers a PTY that died *between* reconciliations.

> **Recommended contract addition (small):** a server-computed
> `state.ptyAlive: boolean` on `work_session`. It would make the predicate a pure
> function of the entity and remove the need for mechanism 2 entirely. Not
> required for Wave 1; worth raising while the modal amendment is being drafted.

---

## 2. Where the terminal lives (R-UI-1)

Option A: the terminal is the **session Z4 full view**. The Z3 panel stack stays
free for the *task* — watch the agent, read the work, side by side.

```
┌──────┬────────────┬────────────────────────────────────────────┬─────────────┐
│ icon │ left rail  │  CENTER · session Z4                       │ Z3 panel    │
│ rail │            │                                            │ (the task)  │
│      │  Home      │ ← All sessions                             │             │
│      │  Tasks     │ ● running  Forge · opus-4.8 · 12m    [⤢][⋯]│  T-101      │
│      │ ▸Sessions  │ ─────────────────────────────────────────  │  Schema     │
│      │  Docs      │                                            │  foundation │
│      │  Team      │      xterm — fills, scrolls internally     │             │
│      │  …         │                                            │  open       │
│      │            │ ─────────────────────────────────────────  │  0/2 done   │
│      │            │ ┌────────────────────────────────────────┐ │             │
│      │            │ │ prompt composer            [⌘⏎ Send]   │ │             │
│      │            │ └────────────────────────────────────────┘ │             │
└──────┴────────────┴────────────────────────────────────────────┴─────────────┘
```

### 2.1 Header — only fields the server actually has

`● status · persona · model · project · elapsed · node` and the actions
`Prompt-focus · Terminate · Copy id · Open transcript`.

Every one of these is real today: `state.{status,agentTool,model,startedAt}`,
`content.{nodeId,projectId,transcriptDoc}`, and the `working_on` edge for the task
chip. **Nothing in the header is invented** — per R-UI-8, no dial without data.

Elapsed ticks client-side from `startedAt`; on `exited|failed` it freezes at
`exitedAt` and reads "ran 12m", not a running clock.

### 2.2 The terminal region

The canvas is the R-UI-2 exemption — everything around it composes normally.

- DOM renderer, no addons, ever (C3). One visible terminal, one socket (C4).
- **Read-only vs drive**: `execution.streams.attach` grants `mode: 'view' | 'drive'`.
  A `view` grant renders the terminal but **swallows keystrokes** and captions
  "view only — you do not have drive access on this session". Silently dropping
  keys with no explanation is the failure mode to avoid.
- On `exited|failed`, still mount and replay: the server keeps the ring, and a
  finished run you cannot read back is the same lost work the surface exists to
  prevent.
- Connection state is shown, not hidden: `live · streaming` / `reconnecting…` /
  `disconnected — retry`.

---

## 3. The list

### 3.1 Rows are Z2 `EntityCard`s (R-UI-2)

Wave 0 used a bespoke row to stay minimal. It should be **replaced**, not
extended: the row becomes the registry's Z2 card for `work_session`, which earns
counters, badges, the drag payload, and the hover Z2 popover for free, and keeps
the composition maxim intact.

```
SESSIONS                                                    [Refresh] [⌘K]
Filter  [ Live ▾ ]  [ Agent ▾ ]  [ Project ▾ ]     Group ( Status | Task | Agent )

LIVE · 2
  ● running    Forge · opus-4.8    → T-101 Schema foundation      12m
  ◐ spawning   Scout · sonnet      → T-104 Entity panel UI         3s
NEEDS YOU · 1
  ▲ idle       Probe · sonnet      → T-102 RLS policies            4m
FINISHED · 14
  ○ exited     Probe · sonnet      → T-102 RLS policies            2h
  ⨯ failed     Forge · opus-4.8    → T-100 Conformance epic        1d
  ⚠ stale      Forge · opus-4.8    → T-103 Facade routes           3d   node restarted
```

**The task chip is not optional.** A session without its task is an orphan; the
row always carries its `working_on` target, and clicking the chip peeks the task
as a Z3 panel without leaving the list.

### 3.2 Grouping

Default **Status** (live first — the only group you act on). Also **Task** (which
work has agents on it) and **Agent** (what is this persona doing). Grouping uses
the existing axis machinery; these are saved collection views, not a bespoke page.

### 3.3 Filtering — and an honest limit

`CollectionQuery.filters` offers `workStatus` (a **task** field), `axes`,
`assigneeIds`, `edge`, `readyToPull`, `deleted`. **There is no filter for
`work_session.state.status`.** So:

- **Wave 1 (no amendment):** fetch the space's sessions and filter/group in the
  client. Honest at tens-to-hundreds of sessions; it degrades at thousands, and
  the paging cursor makes "Live · N" a count of *what was fetched*, not what
  exists. If we ship this, the count must be captioned as such rather than
  presented as authoritative.
- **Preferred:** a small contract addition — either a `state` filter on
  `CollectionQuery`, or the axis machinery extended to custom-kind scalars (which
  `03 §2` already promises for `c:*` and does not yet express).

**Recommendation:** raise this with the modal amendment (§6) as one batch. Two
small filter/event additions are a much easier conversation than two separate ones.

---

## 4. The prompt composer (R-UI-7) — the highest-value piece

Replaces `window.prompt()`. This is the difference between an agent you can watch
and an agent you can steer.

```
┌──────────────────────────────────────────────────────────────┐
│ Also check the migration ordering before you commit.         │
│                                                              │
│ ⏎ newline · ⌘⏎ send                        [ ⌘⏎  Send ]      │
└──────────────────────────────────────────────────────────────┘
   ↑ recalls previous prompts        3 prompts sent this session
```

- **Multi-line.** `Enter` inserts a newline; **`⌘/Ctrl+Enter` and the Send button
  submit.** This inverts the usual chat convention on purpose: prompts to an
  autonomous agent are often multi-line and pasted, and an accidental send is
  expensive and cannot be recalled. Slower to send, impossible to send by accident.
- **History.** `↑` from an empty composer recalls previous prompts, shell-style.
- **Record.** Each sent prompt is a message anchored to the `work_session`
  (verified buildable, §0) and renders in the session's Discussion tab — so the
  exchange is legible after the terminal scrollback is gone.
- **Disabled** whenever `sessionIsAttachable() !== 'attachable'` or the grant is
  `view`, always with the reason stated in place.

### 4.1 Delivery and record can diverge — design for it

Sending is **two operations**: `execution.prompt` (PTY delivery, *not* graph
state) and `messages.post` (the record). They can fail independently, and the two
failures are not equally bad:

| Outcome | What the user must see |
|---|---|
| both succeed | prompt in thread, normal |
| **prompt ✅, record ❌** | prompt in thread marked *"delivered · not recorded"*, retry the record quietly. A gap in the log. |
| **record ✅, prompt ❌** | **the dangerous one.** A prompt sitting in the thread reads as delivered. Must render as *"not delivered — the agent never received this"*, visually distinct, with Retry. |

**Order: deliver first, then record.** A delivered-but-unrecorded prompt is a
gap; a recorded-but-undelivered prompt is a *lie* the user will act on. Order the
calls so the cheap failure is the likely one.

---

## 5. Coordinator → worker tree (R-UI-3, R-UI-6)

Sessions nest by `parentId`. The list renders the tree through the existing
hierarchy axis — indent rails, collapse, child count on the parent row.

```
LIVE · 3
  ● running   Vega · opus-4.8      → T-100 Conformance epic    22m   ▾ 2 workers
  │ ● running   Forge · opus-4.8   → T-101 Schema foundation   12m
  │ ◐ spawning  Scout · sonnet     → T-104 Entity panel UI      3s
```

Until `execution.spawn` propagates `parentId` (Slice 4), every session is a root
and this renders as a flat list — **no empty affordances, no "0 workers" chrome.**
The tree is built for now so nothing is retrofitted later.

### 5.1 Terminate cascades — so the confirm must say so

R-UI-6: terminate kills descendants; complete is intent-only. The destructive
action must state its blast radius, with a count that comes from the tree:

> **Terminate this session?**
> This kills the agent's process **and 2 descendant sessions**. Work already
> reported is kept; anything unsaved in those processes is lost.
> `[Cancel]` `[Terminate 3 sessions]`

"Complete" gets the opposite treatment — it must **not** look like a stop button.
Caption: *"marks the work done; the agent keeps running."*

---

## 6. `session_modals` chrome (R-UI-4) — designed, **not buildable yet**

An agent raising a modal mid-run is *blocked on a human*. That is the single most
urgent state in the whole surface and it currently has no representation at all.

**Presentation:** an inline card **below the terminal, not an overlay.** An
overlay would hide the output that explains the question being asked — the
context the user needs in order to answer it.

```
├─────────────────────────────────────────────────────────────┤
│ ▲ Forge is waiting on you                                   │
│   "Overwrite the existing migration 014?"                   │
│   [ Yes ]  [ No ]  [ Always allow ]                          │
└─────────────────────────────────────────────────────────────┘
```

**It also changes the list.** A session with an open modal is not merely `idle` —
it is *blocked on you*, and it should sort to the top under a **NEEDS YOU** group
with a `▲` glyph, overriding the status glyph. (Old maestro had exactly this
`needsInput` override; it is the right instinct to inherit.)

**Blocking gap.** There is **no contract surface for this whatsoever**: no
`modal` operation in the catalog, no type in `contract.ts`, and no `modal`
variant in the `WorkspaceEvent` union. `03 §4` and `04 §5` describe the side
table and require the compat adapter to carry the `modal` verbs [R29], but the
frozen contract does not express any of it.

**Required amendment (minimum):** a `modals.*` op family (list open modals for a
session; answer one) and an **immediate-class** `WorkspaceEvent` variant so a
raised modal arrives without waiting for a poll tick — a modal that appears 1.5s
late is a modal the user is already annoyed by. Until then §6 is drawn, not built.

---

## 7. Where sessions appear outside this surface

The sessions screen is not the only place a session should be visible, and these
are free once the Z2 card exists:

- **Task Z3/Z4** — sessions working on this task (`working_on`, reverse). Answers
  "is anyone on this?" where the question is actually asked.
- **Team member Z4** — that persona's sessions, live and past. Its work history.
- **Home** — the *live* sessions row belongs in "in flight"; an agent working is
  in-flight work under its owner.

## 8. States and edge cases

| State | Presentation |
|---|---|
| No sessions ever | *"No sessions yet — open a task and choose Spawn agent."* Teaches the entry point |
| No **live** sessions, some past | Don't show an empty LIVE group — collapse to FINISHED |
| Cap reached (`limit_exceeded`, 8 slots) | Spawn refused with *"8 of 8 sessions running. Terminate one to start another."* + a link to the live list. **A 429 that reads as a crash is the failure mode** |
| Node unreachable | Rows keep their last-known state, dimmed, with a banner. Do **not** silently show stale state as live |
| Session vanished (deleted/reaped) | Detail route shows *"this session no longer exists"* with a way back — never a blank |
| Terminal scrollback lost | Say so; offer the transcript doc |

## 9. Suggested build order

1. **Z2 `EntityCard` for `work_session`** → the list becomes a real collection view.
2. **`sessionIsAttachable()`** + the six states + stale honesty (§1) — this is the
   correctness spine; everything else renders off it.
3. **Session Z4** per §2 (header, terminal region, view/drive, connection state).
4. **The prompt composer** (§4) including the two-op divergence handling.
5. **Tree rendering** (§5) — inert until Slice 4, correct when it lands.
6. **Cap + error states** (§8).
7. *(after amendment)* **modal chrome + NEEDS YOU** (§6).

## 10. Open questions for the user

1. **Send key.** I chose `⌘⏎` to send / `⏎` for newline, against chat convention,
   because an accidental prompt to an autonomous agent is expensive. Worth a
   sanity check — it is the one place this design deliberately feels slower.
2. **The modal amendment (§6).** It is the difference between "watch an agent"
   and "unblock an agent". Do we pull it into Wave 1, or ship without it and
   accept that a blocked agent looks merely idle?
3. **Status filtering (§3.3).** Accept client-side filtering with an honest
   caption on the counts, or batch a small `CollectionQuery` addition with the
   modal amendment?
4. **`state.ptyAlive` (§1.1).** Small server addition that would make the
   liveness predicate a pure function instead of a two-mechanism inference.
