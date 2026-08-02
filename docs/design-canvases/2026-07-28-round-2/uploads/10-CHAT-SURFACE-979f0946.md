# 10 — The Chat Surface

**Phase 2 feature. Design it now, build it after the terminal app works.**

Phase 1 ships work sessions as terminal-only. But the *seam* Chat slots into is built in Phase 1, and a seam designed without knowing what fills it will be wrong. So Chat is designed now and implemented later.

Source: `08-SPECS/TM8-CHAT-UI-AND-LAYOUT-DESIGN.md` (canonical, design-only, 2026-07-26). Where this file and that one disagree, that one wins.

---

## 1. What Chat is — and three traps to avoid

The one-sentence product decision:

> Terminal and Chat are two **peer surfaces** inside a work session's Content region. Terminal remains the complete native interactive PTY. Chat is an optional graph-backed surface populated **only** by explicit tm8 messages and activity. A switch shows one surface at a time; **there is no split view.**

Your instinct will be "design a chat app." That instinct is wrong in three specific ways, and each one removes a solution you'd normally reach for.

**Trap 1 — Chat is not a transcript of the terminal.** They are separate stores, not two views of one thing.

> "Terminal output is not a less structured version of Chat. Chat is not a cleaned transcript of Terminal."

If an agent answers only inside Claude or Codex, **that answer appears in Terminal and never in Chat.** A message exists in Chat only when someone — human or agent — explicitly runs `tm8 message send`. No log parsing, no inferred turns, no "assistant-looking text" promoted to a bubble. Capture mode is fixed to `explicit-only`.

Design consequence: the empty state is common and **not an error**. It must explain that provider output lives in Terminal, and offer to switch there — without ever offering to import it.

**Trap 2 — Chat is not the only place messages live.** One store, three projections:

| Surface | Contains | Used for |
|---|---|---|
| **Chat** | Scope `session_chat_v1` — session records, messages authored from the session, their replies, session-caused activity | Following the session's conversation across anchors |
| **Discussion** *(outer tab)* | Messages anchored directly to this work-session entity | Discussing the session entity itself |
| **Activity** *(outer tab)* | Activity directly about this entity | Its mutation history |

The same message can appear in Chat *and* Discussion. That's a projection overlap, not duplication — so the design must never imply a message was copied or that one view is the "real" one.

**Trap 3 — a delivered message is not a read message.** Delivery means bytes reached the terminal transport. Nothing more.

> `delivered` → "tooltip explains this means governed PTY write completed, **not that the model read or obeyed it**."

---

## 2. Where it lives

Chat is a mode *inside* the Content tab of a work-session detail panel. It does not get its own screen, route, or nav entry.

```text
┌──────────────────────────────────────────────────────────────────────┐
│ Work-session entity header                         actions / status │
├──────────────────────────────────────────────────────────────────────┤
│ Content | Discussion | Connections | Activity      ← outer tabs      │
├──────────────────────────────────────────────────────────────────────┤
│ Content toolbar:                         [ Terminal | Chat ]  ← the  │
│                                                          seam        │
├──────────────────────────────────────────────────────────────────────┤
│                    active peer surface                               │
└──────────────────────────────────────────────────────────────────────┘
```

**This toolbar row is the Phase-1 deliverable.** In Phase 1 it exists with Terminal only — reserve the space so Phase 2 doesn't force a re-layout.

Rules that constrain the switch:

- **Terminal can never be removed, disabled, renamed, or reordered behind a privileged action.** No configuration may hide it.
- Chat appears only when the session's pinned Interaction Profile resolves to a supported browser projection. A session without one is **"an unflavored session, not a degraded Chat session"** — show Terminal only, with *no error copy*.
- If a profile declares Chat but its template can't be resolved, **Chat stays visible with an error indicator** so the failure isn't hidden. Terminal is selected.
- Each pinned session panel remembers its own surface independently. Switching one does not switch the others.
- Switching must never restart the process, detach transport, lose output, clear the draft, or reset scroll.

**Inactive-surface indicators** — deliberately weak, and you must not strengthen them:
- Terminal may show a **neutral activity dot** when new bytes arrive. It may never say "message," "reply," or "agent answered."
- Chat shows only client-local **"new since opened."** **No durable unread badge exists in Phase 1.** Don't design one.

---

## 3. Anatomy

```text
┌──────────────────────────────────────────────────────────────────────┐
│ [ Terminal | Chat ]             teammate · provider · session state │
├──────────────────────────────────────────────────────────────────────┤
│ context / connectivity / profile notice, only when needed           │
├──────────────────────────────────────────────────────────────────────┤
│ Load earlier                                                        │
│                                                                      │
│  message bubble                       provenance · delivery badge    │
│  artifact card                        canonical anchor              │
│  compact activity group               expand                       │
│  reply bubble                          parent context               │
│                                                                      │
│ new-items marker                                                     │
├──────────────────────────────────────────────────────────────────────┤
│ reply context / attachments                                          │
│ Message the session…                                                 │
│ composer actions                                      Send           │
└──────────────────────────────────────────────────────────────────────┘
```

The Chat header **must not duplicate the outer entity header**. It carries only fast-changing context useful while composing: teammate, provider, live/exited state, delivery availability.

**Scroll:** first page loads newest-first then renders chronologically. Older pages prepend *above* while preserving the scroll anchor. New items append at the bottom and follow the viewer only if they're already near it — otherwise a "New items" control appears **without moving the viewport**. Rows are virtualized, but a focused row must never disappear while it holds keyboard or screen-reader focus.

---

## 4. Seven item types to design

| # | Item | What it is |
|---|---|---|
| 1 | **Message bubble** | The conversational backbone. Author, provenance, time, edited/redacted state, reply context, attachments, canonical anchor, delivery badge. Content stays selectable and copyable. |
| 2 | **Artifact card** | A created or materially changed artifact — *not* fake chat prose. Kind, icon, title, safe summary, creating actor, producing session, canonical anchor, timestamp, authorized actions. Opening it pushes the canonical entity panel; **Chat never embeds a parallel editor.** |
| 3 | **State-change row** | Compact timeline row for lifecycle transitions. Before/after come from a *typed* summary — copy may never be synthesised by parsing arbitrary property bags. |
| 4 | **Collapsed mutation group** | Low-value rows (relationship edits, counter changes) collapsed when they share a logical-operation key. Says what changed and how many records, with an accessible expand. **Grouping may never be based on timestamps alone.** |
| 5 | **Reply bubble** | Compact parent preview + canonical anchor. **One level of indent, maximum** — "it should not render an unbounded tree in a narrow panel." Membership is transitive even though rendering is bounded. |
| 6 | **Tombstone** | Redacted messages stay in place with author/time as permitted, retaining reply position, so structure doesn't change retroactively. |
| 7 | **Generic unknown-variant card** | Timestamp, actor, open-details. Required because a pinned template can be older than the feed. **Never silently dropped.** |

---

## 5. The hardest constraint: direction without colour or placement

> "Direction is explained with **text and provenance**, not color or left/right placement alone."

This removes the universal chat-design solution — my messages right and blue, theirs left and grey. You need a system that reads correctly in monochrome and at a single alignment.

The spec supplies the vocabulary:

- **To this session** — anchored/delivered to the session
- **From this session** — carries trusted `authored_from` provenance
- **Reply in _Task name_** — the canonical anchor is a different entity
- **Also related through…** — the item qualifies via multiple terms

That last one matters: an item can be in Chat for more than one reason, the server returns the complete ordered set, and **the UI never re-derives why an item is present.** So the design needs a place to show "this is here because…" without turning every row into a metadata dump.

Colour and alignment may still be used — they just can't be load-bearing alone.

---

## 6. Delivery — eight states, and `unknown` is the dangerous one

Delivery is a **facet on the stored message**, never its own row and never a determinant of whether the message appears.

| Server state | User-facing label | Required treatment |
|---|---|---|
| `pending` | Stored · waiting to send | Neutral; durable but not delivered |
| `dispatching` | Sending to session | Progress, without claiming receipt |
| `delivered` | Delivered to session transport | Success; tooltip clarifies transport ≠ read |
| `failed_retryable` | Delivery failed · can send again | Error; bubble remains; **no automatic retry** |
| `failed_permanent` | Delivery failed | Error + details where authorized |
| `unknown` | Delivery unknown | Warning — **never styled as success** |
| `expired` | Delivery expired | Muted terminal state; message remains |
| `cancelled` | Delivery cancelled | Muted terminal state; message remains |

Multi-target messages show a summary plus an expandable per-target list — content is shared, delivery is per-target.

**Never infer delivery** from a bubble existing, a CLI exit code, terminal output, session liveness, or a notification firing.

**There is no Retry.** The only affordance is **Send again**, which creates a deliberate new message with a new identity and explains that the original stored message remains. A delivery-only retry would require a contract that doesn't exist — and no background loop may retry a delivery where bytes may already have been written.

---

## 7. Four send layers, visually distinct

A designer will naturally collapse these into "sending / sent." The spec forbids it — they fail independently.

| Layer | Meaning | Treatment |
|---|---|---|
| **Draft** | Local unsent text/files | Editable composer state |
| **Mutation pending** | Client doesn't know whether storage committed | Optimistic row marked "Saving…", reconciled by idempotency key |
| **Stored** | The graph message durably exists | Normal row — delivery may still be pending |
| **Delivered or not** | Live delivery outcome | The badge from §6 |

**A failed live delivery never turns a stored bubble back into a failed draft.** Once stored, it stays stored.

Error copy must distinguish three different operator situations: **Chat configuration failed** · **message was not stored** · **stored message was not delivered.**

---

## 8. Composer

Two modes only — **New message to session** and **Reply**. Structured questions, answer forms, and expirations are explicitly out of scope.

- Plain or supported rich text, permitted mentions, file attachments as canonical file entities, and a **visible Send button**.
- Dropping a *file* on the composer attaches it. Dropping a *graph entity* on the panel starts the **handoff** flow and must not be silently converted into an attachment.
- Drafts are viewer-local, keyed by member + session, and survive surface switches, tab changes, pinning, and transient reconnects. A draft is not a graph entity.
- **Enter sends, Shift+Enter newlines**, Send stays operable. A profile may choose newline-first, but whichever is active **must be announced in the input help text**.
- After send, focus stays in the composer. Cancelling a reply returns focus there and must not lose unrelated draft text.
- **On an exited session:** Chat stays readable, and the composer may stay enabled — with a clear notice that the message will be *stored but cannot be delivered* to the dead PTY. The UI never implies Send will wake anything.

---

## 9. The state inventory — this is the real design work

Every one of these needs a designed state. This table is the Chat worklist.

| Condition | Behavior |
|---|---|
| Profile still resolving | Terminal opens; Chat shows bounded loading **without blocking Terminal** |
| No Chat-capable profile | Terminal only, **no error copy** |
| Template unsupported/missing | Terminal selected; Chat shows warning badge + core fallback or explicit unavailable panel |
| Initial feed loading | Stable message/card skeletons; composer waits on permissions, not on history |
| Empty feed | "No explicit tm8 messages or activity yet." Explain provider output is in Terminal; offer Switch to Terminal |
| Loading older page | Inline progress above the list, scroll anchor preserved |
| Sparse authorized page | Render what returned; continue only via `nextCursor`; **never invent a total** |
| Invalid/expired cursor | Refresh from newest, preserve draft, announce that history refreshed |
| Offline / reconnecting | Keep cached items + draft; reconnect banner; disable Send |
| Viewer loses Chat permission | Non-leaking permission state; Terminal evaluated separately |
| Session deleted | Tombstone state; must not leak the former title from cache |
| Message redacted | Tombstone bubble, reply position retained |
| Unknown activity variant | Generic card; never dropped |
| Validation fails | Preserve draft + attachments; describe rejected fields |
| Mutation outcome unknown | "Checking whether message was saved"; reconcile before another send |
| Stored, delivery pending | Durable bubble + pending badge |
| Delivery failed/unknown | Keep bubble; exact state; safe action |
| Upload fails before send | Keep draft; per-file retry/remove; never submit a broken reference |
| Session exits | Readable; composer explains stored-only |

**The governing rule across all of them: a Chat failure must never block or mask Terminal.**

---

## 10. Accessibility

- The switch is an accessible **tab list labelled "Work session surface"**, two tabs only when Chat is available or visibly failed. Arrow/Home/End move between them; state is exposed without colour alone. A disabled Chat tab stays discoverable with a textual reason.
- **Terminal focus law:** a focused terminal receives all keystrokes except **Ctrl+Backquote**, which parks focus onto the panel's outer Content tab header. A visible "Exit terminal (Ctrl+`)" hint is associated via `aria-describedby`. Global nav, Chat shortcuts, and switch arrows never steal keys from a focused terminal.
- The feed is a labelled chronological list of articles — **not** ARIA chat semantics the virtualization layer can't honour.
- Author, direction, provenance, delivery, redaction, and state must all be available **as text**, not only as position, icon, or colour.
- Send state and delivery state are **not announced as the same event**.
- Reduced motion, high contrast, 200% zoom, and keyboard-only operation are release requirements.

## 11. Responsive

Chat fills the same Content bounds as Terminal — feed flexes, composer pinned at bottom, **no second vertical scrollbar inside the panel shell**. At narrow widths: metadata wraps beneath the author line, actions collapse into overflow, attachment cards go single-column. Terminal/Chat labels stay textual unless an accessible compact label remains visible.

---

## 12. Forbidden

**Vocabulary.** Terminal may never be called a *Runtime*, a *log view*, a *fallback*, or *a surface replaced by Chat*. Delivery failure is never *"Retry sending."*

**Features (Phase-1 non-goals).** Provider JSON/event capture · hooks converting assistant output into messages · parsing terminal logs into bubbles · a question/interaction entity · dynamic or agent-generated templates · **simultaneous split view** · a second message store or session-specific inbox · auto-resend on non-zero exit code · client-side merging of message and activity history.

---

## 13. What Phase 1 must reserve

Chat is deferred, but three things get designed and built now so Phase 2 needs no re-layout:

1. **The Content toolbar row** — present with Terminal only, sized for a two-tab switch.
2. **The `contentSurface` route slot** — `terminal | chat`, per-panel, round-tripping with stack and pin state, toggling via `replaceState` so Back doesn't walk every toggle.
3. **The feed-scope model** — Chat reads `entities.feed` with scope `session_chat_v1`; the operation and its handler already exist in the codebase (currently unmounted in production).

Everything else in this document is Phase 2.
