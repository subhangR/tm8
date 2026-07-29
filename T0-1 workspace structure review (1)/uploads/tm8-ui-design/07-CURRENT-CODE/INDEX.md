# 07 — Current code (what exists today, and what survives the redesign)

This is the **real source** of the UI we ship today, copied out of `packages/ui/src`. Tests were stripped; everything else is verbatim.

Read this folder to answer one question: *what already exists, so the design doesn't ask for it to be rebuilt.*

**Verdict key** — `REUSE` keep as-is · `ADAPT` keep the component, change its container/props · `HARVEST` keep the logic, throw away the markup · `REPLACE` rewrite.

---

## `entity-components/` (11 files) — **the most important folder here**

The Z1–Z4 "entity component contract." Every entity in the product renders through these four zoom levels, and the redesign keeps the contract intact.

| Zoom | Component | What it is |
|---|---|---|
| Z1 | `EntityChip` | Inline reference — kind icon + name + state tint. Hover → Z2 popover, click → Z3, drag → link/place. |
| Z2 | `EntityCard` | Tile — chip + 2–4 kind-specific fields + footer (reactions, points, message count, edge chips, avatars). |
| Z3 | `EntityPanel` | The workhorse column. Header · action bar · four tabs (Content / Discussion / Connections / Activity) · footer. |
| Z4 | `EntityFullView` | Promoted to full screen for layouts that need room. |

**Verdict: ADAPT.** The four-tab anatomy and the zoom contract are exactly what the new spec's `EntityDetailPanel` requires. What changes is the container (it becomes one of the two universal primitives) and per-kind Content renderers. `EntityPanel` is the closest thing we have to the new primitive — **design against this, not from scratch.**

> Known defect to design around: Z4 is currently *never* kind-specific — five shared layouts, eight kinds fall through to `generic`. The redesign expects kind-specific Content.

## `collection-layouts/` (22 files)

The six universal layouts — **List · Board · Tree · Feed · Gallery · Graph** — plus the query/grouping/sorting scaffolding in `layouts/` and `graph/`.

**Verdict: REUSE (five of six).** The spec keeps all six universal and registry-driven. Caveat: **Graph is a placeholder** — the canvas component was built but is registered nowhere and renders a literal blurb. The brief calls Graph "the showcase view," so it is a genuine design item, not a port.

## `kit-primitives/` (10 files)

Buttons, inputs, menus, popovers, toasts — the base component layer everything else composes from.

**Verdict: REUSE.** Becomes a shared package so both the old and new app import one copy. **Design should extend this, not replace it** — a new button style here reprices every screen.

## `shell/` (13 files)

The app frame: `ShellLayout`, `PanelStack`, `LeftRail`, `IconRail`, `router.ts`, `keyboard.ts`, `placeholders.tsx`.

**Verdict: mixed, and the most-replaced folder.**
- `IconRail` — REUSE (56px, spaces + home + inbox)
- `PanelStack` — ADAPT (already does stack + pins + `MAX_PINNED=3`; the new sizing law and pinned-column geometry are new)
- `LeftRail` — **REPLACE.** Today its nav is a hardcoded array; the spec makes it render from a `MenuConfig` data structure the user can edit. This is a design item (a menu editor), not just a port.
- `router.ts` / `keyboard.ts` — REPLACE. New route grammar and a re-frozen, browser-proof keyboard map.

## `kind-registry/` (4 files)

`KindRegistry.tsx` — the runtime table mapping each entity kind to its icon, tint, fields, and renderers. **This is the spine of the whole product**: the new design pushes *more* into it (route strategy, layout defaults, panel anatomy) so that layout becomes a function of configuration rather than hardcoded screens.

**Verdict: ADAPT and extend.** Nothing visual, but read it to understand why the UI has no bespoke screens.

## `thread-subsystem/` (12 files)

Messages, composer, reactions — the discussion surface used in channels and the Discussion tab.

**Verdict: HARVEST.** It is the closest existing thing to the future Chat surface. **Chat is Phase 2**, so this is context, not a current design target.

## `workspace-pn/` (26 files) — **the current shipping workspace**

`TaskPanel`, `CenterPane`, `ResourcePanel`, `IconRail`, `ProjectTabBar`, `Composer`, `tabs/*`, and six stylesheets under `styles/`.

This is maestro's four-pane workspace transplanted verbatim — real maestro components and real CSS, rewired to tm8 data. **The `styles/` folder is the highest-value thing in this package for a designer**: it is the actual `pn-*` component layer with real measured values.

**Verdict: HARVEST (logic) / REFERENCE (visuals).** The new spec replaces these three bespoke panels with two *generic* primitives — so the components don't survive as components, but their behavior is the survival list the design must preserve: task current/completed sections, hierarchy expansion, inline status/edit/complete, Run/Coordinate, session lifecycle tabs, live count, quick launch, per-kind filters.

> Terminal note: `CenterPane` hosts the terminal, which is a **verbatim maestro transplant and not a design target**. Only the thin chrome strip above it and the panel around it are designable.

---

## Not copied here (deliberately)

- `real/terminal/*` and `SessionTerminal.tsx` — the PTY transport. Black box; not designable.
- `mock/` — the seeded fake world used by tests.
- `screens/` — the nine current screens. The redesign **collapses** these into collection views + entity panels, so they are the thing being replaced, not reused.
