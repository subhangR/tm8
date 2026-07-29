# 08 — The specs

The governing documents, copied verbatim from the repo. **You do not need to read these to design** — files 01–04 in this package distill what matters. These are here so that when a requirement looks arbitrary, you can find out who decided it and why.

Ordered by authority.

---

### `WORKSPACE-LAYOUT-AND-TERMINOLOGY.md` — **the governing spec**
*Status: v2.11, FINAL GO. This is the law.*

The layout, the routing grammar, the domain vocabulary, and the panel mechanics. It is where the two primitives, the sizing formula, the menu-as-data model, and the keyboard contract come from.

Written as **engineering arithmetic, not visual design** — it will tell you a column can never be narrower than 320px and never what it looks like. That gap is precisely the work in `04-DESIGN-WORKLIST.md`.

Notable: it survived **12 adversarial review rounds**, including a NO-GO at round 6. Where it seems pedantic, it is usually because an earlier, simpler version was tried and broke.

### `WORKSPACE-LAYOUT-REVIEW.md` — the adversarial ledger
*Status: all ledgers closed.*

The 12 rounds of review that produced the spec above — every rejected idea with the reason. **The most useful document in this folder for avoiding dead ends**, because a design that reintroduces a rejected approach will be caught late.

Sample of what's already been tried and killed: overlaying a detail panel on a base terminal layer (doesn't actually hide it); "visible if top-of-stack or pinned" (breaks on duplicates); guaranteeing `⌘K` (browsers reserve it); exactly-once message delivery to a terminal (no such guarantee exists).

### `TM8-CHAT-UI-AND-LAYOUT-DESIGN.md` — the Chat feature
*Status: designed, **deferred to Phase 2**.*

A full design for a chat surface that sits beside the terminal inside a work session. **Not being built now** — by direction, the terminal app ships first. Relevant to you only for one thing: reserving the seam where a `Terminal | Chat` switch will later appear, so Phase 2 doesn't require a re-layout.

### `COLLAB_V2_UI_UX_BRIEF.md` — the original design language
*Status: the founding brief; partly superseded.*

Where the product's core idea comes from: **"the graph is the UI"** — every entity is a component, every edge is a navigation. The seven design principles and the Z1–Z4 zoom contract are still in force and worth reading for intent.

Superseded in one respect: its screen catalog has no sessions or terminal surface at all, which is exactly the gap the audit below found.

### `UI-GAP-AUDIT.md` — what's actually broken
*Status: findings largely still open.*

A 712-line audit of the shipping app. Its verdict: **"The graph half of this UI is real and good. The execution half does not exist as a product."**

Read §2 if you want the honest inventory of what has *never been designed* — auth, onboarding, account, projects, files, custom-kind authoring, node settings. Those are Tier 3 in the worklist.

### `PIXEL-TRANSPLANT-SPEC.md` — the cautionary tale
*Status: historical, but its lesson is binding.*

Why the first rebuild was rejected and what was learned. Short, and worth reading in full. The core finding — that maestro and tm8 share one design system, so the job was a port rather than a redesign — is why `06-REFERENCE-SCREENSHOTS/` is trustworthy as an ancestor.

Its acceptance rule still governs UI work: **a screenshot diffed against a reference, or it isn't done.**

### `TM8-UI-SPEC-FINAL.md` — the engineering counterpart to this package
*Status: independent architecture review + buildable spec.*

The engineer-facing sibling of the package you're reading. Same source material, opposite audience: component tree, state ownership, the facade seam, build order, risk register.

Useful to you for **§4.15 (open items)** and **§5 (what must be visually designed)** — those are the two places where the engineering spec explicitly hands a decision to design.

---

## One thing to know about all of these

Everything in this folder describes a system that is **specified but not built**. The code in `07-CURRENT-CODE/` is the *old* design. The specs here are the *new* one. Nothing has been implemented against them yet — which is why design input now is cheap, and later is not.
