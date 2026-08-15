# The Back Contract

**Status:** adopted 2026-08-15. Supersedes the proposal in `MOBILE-DESIGN-BRIEF.md` §6
("back pops the stack") — see §3, which reaches the same observable behaviour by a
different mechanism, and says why the mechanism is the part that matters.

**Applies to:** both shells. This is not a mobile rule that desktop happens to
tolerate; it is one rule, and the phone is simply where it becomes visible.

**Enforced by:** `packages/tm8-ui/src/stores/backContract.ts`,
`stores/back-contract.test.ts` (the decision, without a DOM),
`views/mobile-back.test.tsx` (the four acceptance walks),
`mobile/no-router-fork.test.ts` (the law this contract must not break).

---

## 1. The rule

> **Back always walks the browser history. The screen stack follows it.**

Back is never intercepted. Nothing in this codebase listens for `popstate` or for
an Android back gesture, and nothing should. A phone's back gesture *is* browser
back, and browser back already produces the correct screen — once the screen
stack is **derived from** the address rather than merely **seeded by** it.

There is one history, one codec, one `navStore`, two renderings. That was already
the law. This contract is what makes it true of the back button.

---

## 2. The conflict this settles

The app has two things that look like navigation history:

| | `navStore` + codec + transport | `screenStackStore` |
|---|---|---|
| **What it is** | the browser history — one, shared | per-*screen* drill-down stack, many at once |
| **Keyed by** | nothing; there is one | screen instance (`kind:task`, `channel:{id}`) |
| **Persisted** | in the address bar | **no** — in-memory, a reload starts clean |
| **Why it exists** | links are addressable | leaving a screen and returning shows what you were looking at |

On a **desktop** these never have to agree. The panel column is visible, and Esc
or the panel chrome pops the screen stack while the browser's back button walks
the address. Two gestures, two meanings, no ambiguity.

On a **phone** there is one surface and one back gesture. It must mean exactly
one thing.

### 2.1 What was actually broken

The URL→stack direction was **one-way**. `GateApp`'s seed effect opens the entity
an address names and had no branch for an address that names none. So:

1. You are on `#/s/{S}/e/{A}?origin=tasks`; the stack holds `[A]`.
2. You press back. The address becomes `#/s/{S}/k/tasks`.
3. The stack **still holds `[A]`**, because nothing told it otherwise.
4. The screen→URL sync, in the same pass, sees an open entity and pushes
   `e/{A}` — *straight back*.

You returned to the entity you had just left, having spent a history entry to do
it. Pressing back again repeated it. **There was no exit**, and it was reachable
on the exact entry path a shared link creates.

`router-mount.test.tsx`'s back/forward case walks `workspace ↔ k/tasks` with no
entity involved, which is why it was green over this the whole time.

---

## 3. Why the address leads, and not the stack

The brief's §6 proposes that back *pops the screen stack*. **Observationally that
is what happens** — but the mechanism has to be the other way round, and the
difference is not academic.

Every screen-stack transition **already writes a browser history entry**.
`GateApp`'s screen→URL sync turns a drill-in into a pushed `e/{id}?origin={slug}`
and a step up into `k/{slug}`. So the screen stack is not a second history — it is
a **projection** of the one history, and its depth is recoverable from the entries
a walk passes through:

```
history:   #/s/S/k/tasks     #/s/S/e/A?origin=tasks     #/s/S/e/B?origin=tasks
stack:     []                [A]                        [A, B]
             ←── back ───────── back ────────────────────┘
             ──── forward ───────── forward ─────────────→
```

Walking that history backwards therefore *pops the stack*, one rung per press,
with nothing intercepting the gesture. Walking it forwards rebuilds the stack
exactly. Both directions fall out of `screenStackStore.open`'s existing
truncate-on-revisit semantics — opening `A` over `[A, B]` yields `[A]` — so
nothing new had to be invented to make the walk lossless.

**The alternative fails on the second direction.** If back popped the stack and
then wrote the URL to match, the stack would *lead* on back and *follow* on
forward. The first time a viewer pressed forward, or pasted a link over a live
stack, the two would disagree about depth — and that disagreement is precisely
"two history models cannot agree about what BACK means", arrived at from the
inside rather than by forking the router. `no-router-fork.test.ts` would still
have been green.

### 3.1 The seam

`reconcileScreenStacks` is called from `attachRouter`'s **inbound** path, which
fires for back, forward, a pasted hash and a reload — and *not* for a store-led
navigation, which the loop's existing `applying` / `lastWritten` guards already
filter out. That filter is the whole contract in two lines:

| The viewer moved… | …and then |
|---|---|
| the **stack** (tapped a row, pressed Esc) | the stack leads, the URL follows |
| the **address** (back, forward, paste, reload) | the address leads, the stack follows |

Both directions run through the same fixed point, so they settle in one pass
instead of pushing history at each other.

It lives in the **router loop**, not in either shell. That is the only place two
shells can share an answer, and it is why the mobile shell needs no back code at
all — no file was added under `src/mobile/`, and `no-router-fork.test.ts` is
untouched and unthreatened.

---

## 4. The four questions, answered together

### Q1 — Does hardware back pop the screen stack first, or walk browser history first?

**Neither; the question contains the bug.** There is one history and back always
walks it. The stack follows. Nothing pops first because nothing intercepts back.

### Q2 — How does R15 (cold depth-1 entry steps UP via REPLACE) compose with a per-screen stack several deep?

**It never meets one.** An address carries **at most one** entity — the grammar
has exactly one `e/{id}` slot — so a cold arrival cannot produce a stack deeper
than 1. A stack several deep is a stack that was *drilled*, and drilling is
exactly what a cold arrival has not done yet.

So R15's one-shot concession applies to a depth-1 stack **by construction**, and
there is no composition rule to write. R15 stays exactly as `GateApp` already
implements it; this contract adds nothing to it and removes nothing from it.

### Q3 — Does closing the last item on a screen stack exit the screen, or the app?

**The screen — to its root, never the app.** `#/s/{S}/e/{A}?origin=tasks` becomes
`#/s/{S}/k/tasks`, which is a screen. This is guaranteed rather than hoped for:
`intentOfRoute` returns `clear` for a bare kind route, which is the branch whose
absence caused §2.1.

The app is left only by pressing back at history entry zero, which is the
browser's business and deliberately not ours.

### Q4 — Can back ever leave the Space, or leave the app entirely, from a link arrival?

**Leave the app: yes, exactly once, and that is correct.** A pasted link *is* the
whole history. There is no in-app place back could go, and manufacturing one
would invent a journey the viewer never took. So back returns them to whatever
they were reading when they tapped the link — where they actually came from.

R15 is what makes this clean: the in-app step *up* from a cold arrival replaces
rather than pushes, so the screen root sits at entry zero rather than on top of a
fabricated history. What must never happen is the alternative — back returning to
the entity. That is the two-item trap, and `mobile-back.test.tsx` asserts against
it directly.

**Leave the Space: no.** `setSpace` writes with `replace`, deliberately, so a
space boundary the viewer did not walk is never in the back stack.

---

## 5. Rotate and resume

Neither changes the rule, because **the address is the state and the stack is
derived from it**.

- **Rotate** is a resize. It re-runs the shell fork and nothing else — the stores
  are module-level and the address is untouched. Back means the same thing in
  landscape as in portrait.
- **Resume** after the OS discarded the tab is a *reload*. The screen stack is
  gone, as designed — it is deliberately not persisted. The address rebuilds the
  same screen at depth 1, and the next back does what Q4 says. Nothing is
  restored out of storage, and nothing needs to be.

---

## 6. Cross-device acceptance

Same rule, both shells. The desktop column differs; the meaning of back does not.

| Walk | Address after | Stack after | Back leaves app? |
|---|---|---|---|
| Cold arrival `e/{A}?origin=tasks` | unchanged, 1 entry | `[A]` | **yes** — nothing behind it |
| …then step UP (Esc / `‹`) | `k/tasks`, still 1 entry (R15 replace) | `[]` | **yes** |
| …then drill to `B`, then back | `e/{A}`, 2 entries | `[A]` | no |
| `k/tasks` → drill `A` → drill `B` | `e/{B}`, 3 entries | `[A, B]` | no |
| …back | `e/{A}` | `[A]` | no |
| …back again | `k/tasks` | `[]` | no |
| …forward twice | `e/{B}` | `[A, B]` | no |
| Back at a screen root reached by walking | previous screen | untouched | no |
| Rotate, at any point above | unchanged | unchanged | unchanged |
| Resume after tab discard | the address it was on | rebuilt to depth ≤ 1 | per Q4 |

An address is a statement about **one** screen. Landing on Channels says nothing
about what the Tasks screen has open, so the Tasks stack survives untouched and
returning to it still restores what you were looking at — which is
`screenStackStore`'s original reason to exist, preserved intact.

---

## 7. What this contract does not do

- It does not persist `screenStackStore`. A reload still starts clean.
- It does not add a router, a history model, or a `popstate` listener to either
  shell.
- It does not change R15, the codec, the URL grammar, or `GateApp`.
- It does not clear a stack on an **unresolvable** route. `landingOfRoute`
  refuses a slug naming no registered kind, and a bare `e/{id}` with no `origin`;
  the shell surfaces those as a refusal, and a refusal must not *also* destroy
  the state the viewer had. Wiping a stack on the way to an error card would turn
  one bad link into lost context.
