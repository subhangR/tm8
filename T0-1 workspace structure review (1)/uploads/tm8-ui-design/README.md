# tm8 UI — Design Handoff Package

**Purpose:** Everything Claude Design needs to design the tm8 user interface: the requirements, the layout geometry, the design system, the current UI code worth reusing, the specs, visual references, and openable HTML. Self-contained — a designer who has never seen the tm8 repo can work from this folder alone.

**This package does not contain the new design.** Files 01–04 are *requirements* — the design itself (visuals, mockups, component styling) is the designer's job; every wireframe in them is a structural constraint, not a look. Folders 05–09 are *existing material* copied or rendered out of the codebase so the requirements can be checked against reality and edited directly.

**Date:** 2026-07-27. Prepared from the tm8 repo's governing design corpus (`WORKSPACE-LAYOUT-AND-TERMINOLOGY.md` v2.11 — a spec that passed 12 adversarial review rounds — plus the Chat design doc and the current codebase). The engineering counterpart is `docs/plans/TM8-UI-SPEC-FINAL.md` in the repo (also copied here in `08-SPECS/`); that document is for engineers, files 01–04 here are for the designer.

## Read in this order

| # | Item | What it is |
|---|---|---|
| 1 | `01-REQUIREMENTS-AND-BRIEF.md` | The product, the mental model, the hard constraints, and what the final UI must contain. **Start here.** |
| 2 | `02-LAYOUT-SPEC.md` | The geometry: every screen region, exact track widths and floors, the center sizing formula with worked numbers (C_min for V=0..4), ASCII wireframes for every layout state including the responsive right-stacked / both-stacked / full-width-sheet modes. |
| 3 | `03-DESIGN-LANGUAGE.md` | The "ATELIER" design system in plain English: palette (light + dark), type scale, spacing, radii, elevation, motion, component conventions, and what may/may not change. |
| 4 | `04-DESIGN-WORKLIST.md` | The actual to-design list, ranked Tier 0 (blocks the shell) → Tier 4 (cross-cutting states) → Phase 2, each item with requirements. |
| 5 | `05-DESIGN-SYSTEM/tokens.css` | The real token stylesheet the values in 03 were transcribed from — ground truth for every color/size. |
| 6 | `06-REFERENCE-SCREENSHOTS/` | Real screenshots: maestro (the visual ancestor — same token system) at 1600×1000@2x, crop by crop, plus tm8-vs-maestro side-by-side sets. See `CAPTIONS.md` inside. |
| 7 | `07-CURRENT-CODE/` | The actual component source we intend to keep, organized by subsystem (entity Z1–Z4, collection layouts, kit primitives, shell, thread, kind registry, workspace `pn-*` components + CSS). See `INDEX.md` inside for per-file "what this is / reuse-adapt-harvest" verdicts. |
| 8 | `08-SPECS/` | The design corpus documents (the governing v2.11 layout spec, the Chat design, the 12-round review ledger, the UX brief, the gap audit, the pixel-transplant spec, and the final engineering spec). See `INDEX.md` inside for what each governs and its status. |
| 9 | `09-HTML/` | Openable HTML: a **generated static rendering of the current tm8 workspace** (`tm8-workspace-static.html` — real repo CSS inlined, representative data; open it in a browser and edit it), a **found maestro static mockup** (`maestro-app-ui.html`), and the repo's Vite `index.html` labeled honestly as a mount point, not a mockup. Its README says exactly what each is and is not. |

## Three rules that govern everything (do not design around them)

1. **The terminal is a verbatim transplant, not a design target.** The terminal canvas — streaming, rendering, behavior — is taken exactly from the maestro app (the working reference standard) and is a black box to design. What IS designable: the thin chrome strip above it and the panel around it. See 01 §4 and worklist item T0-2.
2. **Chat is a Phase-2 feature.** The work-session panel ships terminal-only first. Design must reserve the seam (a toolbar row where a Terminal|Chat switch will later appear) but the Chat surface itself is deferred and sequenced last.
3. **One rule, zero exceptions:** clicking any entity anywhere opens that entity's detail panel. There is no special-cased screen; the whole UI is two primitives (an entity list panel and an entity detail panel) composed by a small set of views.

## How the pieces relate

- 01–04 are the **requirements** — what to design and within what constraints.
- 05–06 are the **visual ground truth** — the tokens and what the ancestor actually looks like.
- 07 and 09 are the **material** — real code and openable HTML to design against and edit.
- 08 is the **law** — if a requirement here seems to conflict with a spec in 08, the spec wins (v2.11 for layout, the Chat doc for Chat), except where `TM8-UI-SPEC-FINAL.md` §0 records a newer user directive (terminal transplant, Chat deferral, expanded design scope).
