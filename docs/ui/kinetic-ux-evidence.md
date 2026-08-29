# Kinetic UX Evidence — the Laws, applied and proven

**Wave 1 (web), branch `feat/kinetic-system`, 2026-08-29.** This document is the
evidence Tarkesh required: every Law of UX (lawsofux.com) considered against the
build, each claim anchored to a real file/selector/decision on this branch, and
each audit finding it addresses named. The input was a 10-territory, 221-atom
interaction audit (32 high / 64 medium / 125 low; 18 outright-broken controls),
run by ten independent agents against the live app. Laws with no honest
application in this wave say so — a stretched claim would poison the register.

| Law | How this build serves it | Proof (file / selector / decision) | Audit finding addressed |
|---|---|---|---|
| Aesthetic-Usability Effect | Raised surfaces are glass (translucent card + blur), chrome is hairline-dieted, one accent | `shell/palette.css .pal` (color-mix 92% + blur 12px); `graph/graph.css .gv-node`; shell.css chrome diet | Debug prose in Inbox deferred (task 01a04c60-5270) |
| Choice Overload | The palette's 15 permanently-deferred rows collapse behind one summary row | `shell/CommandPalette.tsx` deferred group “N not available yet ▸” | HIGH: 42-row palette wall |
| Chunking | Palette keeps fixed groups (Entities→Views→Actions); rail groups Work/Library/People; Home controls read as three tiers | `a1c-shell.test.tsx` fixed-order pin; `domain/home-rail.ts` spine; brief §tiers | — |
| Cognitive Load | One lens vocabulary everywhere; prompts chip removed from global chrome (Help owns it) | `graph/GraphView.tsx LENS_WORDS`; `shell/SpaceTabBar.tsx` retirement comment | HIGH: banner naming a control that didn’t exist |
| Doherty Threshold | Palette filters as you type; discussion skeletons resolve when the read settles; row capabilities hydrate on strip mount; undo notice appears immediately | `CommandPalette.tsx buildRows(query)`; P5 anchor-feed reconnect fix; `EntityControls.tsx onNeedDetail` effect | HIGH: search box that didn’t search; HIGH: eternal skeletons |
| Fitts’s Law | Door mark grown to ≥28px; 36px bar controls; account menu can no longer clip its dark-toggle off-screen; row titles no longer share pixels with hover actions | P6 `.shell-tabbar__mark` sizing; P2 `.auth-menu__row` border-box fix; `--tt-actions-reserve` padding | HIGH: clipped toggle; HIGH: title-click theft |
| Flow | `/` opens the palette everywhere (guaranteed binding); Esc is consumed by the topmost surface; “load earlier turns” keeps the reader’s place | `keyboard/contract.ts palette.slash`; P5 scroll-anchor pin | HIGH: load-earlier teleport |
| Goal-Gradient Effect | Acceptance progress (bar + n/m) on cards; the empty-graph escape now lands ON nodes instead of a second dead end | `gv-node__bar`; P4: escape also widens the window | HIGH: dead-end escape ladder |
| Hick’s Law | Four status words, three lenses, one accent; deferred choices folded away | `CATEGORY_TABS` (4); `LENSES` (3); palette collapse | MEDIUM: 27-item unchunked group |
| Jakob’s Law | ⌘K/`/` palette; kanban board; checkbox criteria; the Inbox wears a tray glyph, not a share-arrow | P6 glyph swap ◹→▣ beside ↗ Copy link | MEDIUM: two adjacent arrows, unrelated meanings |
| Law of Common Region | Three-surface Home composition (rail/work-pane/session panel); legend and filter docks are bounded cards; switcher popover groups spaces under their server | brief §three-surface; `gv-legend`; P6 header conversion | — |
| Law of Proximity | 4px grid: 12px between control tiers, 8px within; property rows pair eyebrow+value at 29px | tokens `--pn-space-*`; panels tier spacing | — |
| Law of Prägnanz | Chrome diet: borders that duplicated elevation deleted; the switcher’s server line is now a header, not a fake button | W3 shell consolidation; P6 non-interactive header | HIGH: dead server “button” |
| Law of Similarity | Disabled options are now visibly disabled; the dead “new space” row no longer masquerades as its live sibling; duplicate palette labels disambiguated by scope | `.lp__kindopt:disabled` treatment; P6 dimmed+reason row; P3 label suffixes | HIGH ×2, MEDIUM ×1 |
| Law of Uniform Connectedness | Graph edges carry relationship words; the hovered card’s edges step forward as one visual system; ledger entries share a connector guide | `gv-edge__label`; `gv-edge--hot`; timeline guide (wave 3) | — |
| Mental Model | Empty states may no longer contradict the counts on screen (“Nothing in To Do — 3 in Done”); Enter in the palette opens what you typed | P1 honest empty copy from live tabCounts; P3 filtered-Enter | HIGH: “No memories here yet” over 3 memories |
| Miller’s Law | Rail chunks 17 kinds into 3 named groups; cards carry ≤3 facts (status word, one body fact, one meta row) | `HOME_RAIL_GROUP_SPINE`; graph card body-slot contract | — |
| Occam’s Razor | The prompts overlay, its scrim, its keyframes, and the duplicate tab-bar CSS re-open were deleted, not restyled | W5 deletions; W3 consolidation | — |
| Paradox of the Active User | The landing corrects itself (first non-empty tab) instead of expecting users to discover chips; the honesty banner’s instruction IS the control | P1 landing correction (never written to storage); `gv-banner__act` | HIGH ×4 (hidden content on landing) |
| Pareto Principle | The few verbs that matter most are primary: Run/Edit on the panel, Terminate hydrates with the strip on mount | `chrome.tsx` action bar; `EntityControls` hydration | HIGH: dead Terminate on running rows (strip path) |
| Parkinson’s Law | Considered — no natural application in this wave; nothing here manages user time budgets | — | — |
| Peak-End Rule | Destructive verbs end well: “Archived — Undo” (5s, live inverse verb); Terminate arms before it fires | P1 undo trace; P5 arm-confirm | HIGH: silent instant archive/terminate |
| Postel’s Law | Inputs are lenient (case-insensitive substring search), outputs are conservative (no control renders enabled while doing nothing — dead ones were wired, honestly refused, or removed) | P3 matching; P6 conversions; wave-3 register for the remaining five | HIGH: several enabled-inert controls |
| Selective Attention | Motion is reserved for genuine liveness (pulse/march gated on the seam verdict, reduced-motion collapses all of it); brass carries selection only | `gv-edge--live` gating; every new `prefers-reduced-motion` block | — |
| Serial Position Effect | First and last positions carry identity: lens first in the toolbar, Sign out last in the account menu with its consequence stated | `gv-lens` placement comment; account menu order | — |
| Tesler’s Law | Complexity moved into registry data, not user choices: archetypes, `list.lifecycle`, tile anatomies — one panel serves 17 kinds | `EntityDetailPanel` archetype switch; P1 `lifecycle` field | HIGH: strikethrough “Done” files reading as deleted |
| Von Restorff Effect | The blocked word never blends: blocked edges are exempt from hover styling by selector; the armed Terminate is unmistakable | `.gv-edge--hot:not(.gv-edge--blocked)`; P5 armed state | — |
| Working Memory | Instructions carry their own controls (banner button); counts print from one source at tabs and footer; relative times reveal absolute on hover | P4 banner; D41 same-query counts pin; `Timestamp` title | HIGH: banner pointing at a nonexistent control |
| Zeigarnik Effect | Nothing pulses forever: skeletons resolve, “checking permissions” hydrates on strip mount, progress is stated as n/m | P5 skeleton fix; `EntityControls` hydration; acceptance bars | HIGH: eternal loading states |

## Open findings register (deliberate, tracked — not silence)

Deferred to standalone tm8 tasks, in the graph:
- **01a04c60-4552** — row capabilities never hydrate on *collapsed list rows* (the strip path hydrates; the row-hover path remains) — the largest remaining “conditional” mass.
- **01a04c60-4881** — File browser has no menu entry point.
- **01a04c60-4b7f** — Craft Orchestrate approval gate accepts the wrong thread mode and never renders the approval.
- **01a04c60-4db2** — Supersede-memory modal: pristine-form errors + unbounded height.
- **01a04c60-5027** — Settings Custom-kinds dev-stub page.
- **01a04c60-5270** — Inbox destination: debug prose + no active-tab state.

Wave 3 (whole entity system, mapped and chartered) owns the five dead controls found in the panel census: acceptance-criteria editing (contract supports it; no UI exists), points-estimate editing, the Connections “link an entity” no-op button, discussion mention/skill sigils, and the unrendered Pin control — plus the atom-level kit gaps (Chip/ActorRef/Markdown/DiffView focus rings; Chip/IconBtn disabled API).

Remaining audit volume: 64 medium and 125 low findings are catalogued in the session’s audit corpus; mediums ride along as their owning surfaces are touched in waves 2–3.
