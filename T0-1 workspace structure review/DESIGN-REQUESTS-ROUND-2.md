# tm8 UI — Design Round 2 request list (v2, final)

Gap analysis of the delivered suite (T0-1 … T10) against the brief's target surfaces (01-REQUIREMENTS-AND-BRIEF §7), constraint C5 (six universal layouts), the worklist (04-DESIGN-WORKLIST), the live API catalog (81 ops, all mounted), and all 15 entity kinds. **Seven items below complete local tm8 v1.** Graph canvas and the reversal vocabulary are deferred by ruling (listed at the end so the seams stay reserved).

**Standing rules (unchanged from Round 1):** every item in light AND dark · at full width AND the narrowest legal state (320px floors) · with worst-case content (UUID-length titles) · ATELIER tokens only · status = color + word, never color alone · the honesty vocabulary from T1-4/T4 applies (disabled-with-reason, hollow-value caption, overflow notice) · C1 holds everywhere (click any entity → its Z3 panel on the stack) · C8 accessibility. Reuse the primitives already designed (EntityListPanel from T0-3, Z3 chrome from T0-4, state matrix from T4) — these are composition items, not new design languages.

---

## The seven items

### T3-3 · Account menu  *(worklist ID never delivered; auth flows ≠ account)*
The "who am I" surface off the top-bar avatar.
- Dropdown: identity summary (name, avatar, role, node identity line), profile edit entry, theme control (reconcile with the existing ◐ toggle in the tab bar — one home for theme), sign out (with honest copy for loopback v1 where sign-out has limited meaning), link to Node settings (T3-5 exists).
- Profile view/edit: reuse the member Z3/Z4 from T0-4; the missing piece is the menu + edit mode, not the profile panel.
- The acting-as seam (owner acting as a teammate): design the affordance; it may ship disabled-with-reason.

### T5-1 · Home / Dashboard  *(in brief §7, absent from the worklist and the suite; it is the landing view — `spaces.home` and `collections.query` are live)*
- "My Work": my open/pulled tasks, my live sessions with the honesty grouping (NEEDS YOU first), my mentions/assignments.
- Recent space activity stream (activity rows exist in the event vocabulary).
- Quick actions: new task, launch session, open workspace.
- Deliberately a **composition** of existing primitives (EntityListPanel configs + activity rows + the T0-1 shell) — no new primitives.
- First-run empty state that teaches the grammar, in the spirit of the designed empty-center roster.

### T5-2 · The three missing collection layouts: Board · Feed · Gallery  *(C5 mandates six; only List, Tree — and deferred Graph — are actually rendered anywhere. Board appears in the delivered switcher and Tweaks config but is never drawn.)*
- **Board layout**: columns by status/axis, Z2 cards, drag between columns (the move/patch affordance), column overflow honesty, per-kind config example (tasks board).
- **Feed layout**: the chronological-stream form of any collection (`entities.feed` is live: `via` terms, single-cursor paging). Row anatomy, day grouping, via-labels ("via assignment", …), live-append behavior, load-earlier.
- **Gallery layout**: the card-grid form (docs/files-heavy kinds). Z2 card reuse, grid density at the floors, identical selection/click behavior (C1).
- All three: empty/loading states per T4, behavior at the 320px floor.

### T5-3 · Doc authoring  *(T0-4 designs the doc panel as a reader only; doc content is markdown / mermaid / excalidraw)*
- Read ⇄ edit switch inside the doc panel Content tab, honest about permission.
- Markdown editing with a preview stance (side-by-side vs toggle — designer's call).
- Mermaid + excalidraw as embedded block cards with an edit affordance; full-bleed editing may be a Z4 concern.
- Save semantics surfaced honestly: saving / saved / conflict (reuse T4's conflict treatment; saves ride `entities.patch` + version bump).
- Keep it simple: no collaborative cursors, no real-time co-editing in v1.

### T5-5 · Launch flow  *(the execution product's front door — "Launch session ▸" / "Run ▸" / "+ Launch" buttons exist across T0-1/T0-3, but the moment they open is designed nowhere)*
- The launch surface (dialog or sheet — designer's call): pick the teammate/agent (with model + agentTool shown), pick the project(s) — trust-gated per T2-2 (untrusted projects render disabled-with-reason, never hidden), sessions↔projects is M:N with a scratch/no-project option, interaction profile resolution shown (pinned at launch, immutable after — ties to T2-4's "sessions pin their profile forever").
- Three entry contexts, one design: from a task (Run ▸ — task pre-associated), from the sessions list (+ Launch — free), from Home's quick action.
- The moment after: where focus lands (the new session's panel with live terminal — T0-2's spawning state).
- Failure honesty: spawn refused (untrusted project, concurrency cap "8 slots, 3 in use" from T3-5) — designed refusal, not a toast apology.

### T5-6 · Teammate authoring + the generic create pattern  *(agent profiles are designed read-only in T0-4; `+ Invite` on the teammates list opens nothing designed)*
- New-teammate creation: name, avatar (rounded-square, per provenance rule), model, agentTool, owner. Small form — not a wizard.
- Editing the persona afterward: which profile fields are editable in place (identity, capabilities) vs system-owned (memories, liveWork readouts) — use hollow-value captions for empty system fields.
- **The generic create pattern, stated once**: for plain kinds (task, doc, channel, collection, custom kinds), `+ New` creates with a placeholder title and opens the Z3 panel with the title in inline-edit focus. One treatment, every kind; no per-kind create forms unless listed above. (Member invites are already designed in T2-1; project registration in T2-2.)

### T5-7 · Entity Discussion tab body  *(the tab is in every panel's chrome — "four tabs, fixed order, every kind, no exceptions" — and T10's rows link into it as the "canonical anchor", but no canvas renders the thread inside a panel)*
- The T10 thread grammar (message rows, provenance avatars, composer, four-layer send lifecycle, delivery facets) embedded in a Z3 panel body — including at the 320px column floor: row anatomy, composer height, load-earlier, day markers at narrow width.
- Anchor semantics honest: this thread IS the entity's discussion (`anchorId`), the same rows T10's feed references; reply-into-thread from a feed row lands here.
- Empty state ("no discussion yet — say something") in the teach-the-grammar spirit.
- Works identically for every kind (task, doc, session, project…) — one embodiment, no per-kind variants.

---

## Deferred by ruling (design later; seams stay reserved)

- **T3-6 · Graph canvas** — the delivered file stays a placeholder; the ◉ switcher position renders disabled-with-reason.
- **T5-4 · Reversal vocabulary** (undo, version history, handoff-withdraw) — ships without affordances; `commands.undo` / `entities.versions` stay API-only.
- **Leaderboard & awards, saved-views/axes control, search results view** — palette + settings cover v1; these join the graph canvas in a later round.

*(No design needed for: NEEDS YOU, stale, delivery facets, inbox, offline/reconnect — already designed; their server signals are a separate engineering track. Spells/skills ride the generic archetype + the equip affordance already designed in T0-4. Collections render via generic/Home. Channel/space creation ride the generic create pattern / the designed first-run flow.)*
