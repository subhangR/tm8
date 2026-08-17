# Unified Home — Collab + Work become one tab

**Status:** LLD for ruling · task `01a00932-e001-7564-b0fa-f43c1dbf8f52` · 2026-08-16
**Baseline:** main `3a549223` (menu revision 16, PRs #269/#271/#272/#276 landed, #277 open)

## 1. What this is

Today the space has seven tabs — Collab | Work | Board | Graph | Channels | Files |
Settings — and two parallel worlds behind them. Collab is the chat surface
(`chat-home/`), whose left column just gained its own Chats | Tasks | Sessions
tabs (task `01a006f8`). Work is the panel system (`views/WorkspaceView.tsx`):
two `EntityListPanel` docks, a `PanelStack` center, detail panels with content
surfaces. The Collab column's Tasks/Sessions tabs already mount the workspace's
own `EntityListPanel` (`HomeView.tsx:304-341`) — the two worlds are half-merged
in the code and fully split in the chrome.

This design merges them into one **Home** tab:

```
Home | (Collab) | Board | Graph | Files | Settings

[Icon rail          ][ Entity list        ][ Center panel       ][ Right panel ]
[ all entity kinds  ][ [Chats +][Kind +▾] ][ chat conversation  ][ (optional)  ]
[ default collapsed ][ relational tiles   ][  — or —            ][ related     ]
[                   ][ of the root kind   ][ entity detail tree ][ entity      ]
```

Collab returns later as a brand-new surface for agents, members, channels and
messages — it is **out of scope here** (R2, R3). Until it ships, those kinds are
reachable like every other kind: through Home's switcher and rail.

## 2. Rulings (reporter, 2026-08-16, on the task thread)

- **R1 — Two center modes.** Selecting a chat swaps the center to the full
  conversation surface (composer, entity graph, turn stream). Selecting an
  entity gives the center to the detail-panel system. Chat is a first-class
  root type, not an entity detail panel.
- **R2 — Collab ships later.** The redesigned Collab (agents, members,
  channels, messages, voice) is a separate future feature. Channels' current
  tab dissolves; nothing chat-adjacent blocks on it.
- **R3 — Everything goes into Home now.** No curated subset: the switcher and
  rail carry all collection kinds, registry-driven.
- **R4 — The rail is entities only.** No view rows (no Code/git row, no
  board/graph rows). The rail's grouping is purely visual classification over
  the same kind list the switcher shows. Rail and switcher share one state and
  one route.
- **R5 — Split-button create.** `+` creates an entity of the currently
  selected kind. The caret opens the kind list; picking a kind *switches* the
  root list, it never creates. `[Chats +]` creates a new chat.
- **R6 — Center vs right.** List click roots the center. Inside the center,
  clicks within the root's own tree navigate in place. A related entity of a
  different kind opens in the right panel. A related entity of the same kind
  that is *not* in the root's tree also opens right. An explicit
  "open here" (promote) on the right panel re-roots the center **and moves the
  left list's selection**.
- **R7 — Breadcrumbs on both panels.** Center and right each carry a
  breadcrumb trail of the hops that led there.
- **R8 — Reuse the panel system.** The entity center is the existing
  `EntityDetailPanel` machinery (post-#276), including work_session content
  surfaces (terminal | chat | git | debug | graph), the doc editor, files.
  Nothing lighter is built.
- **R9 — Board and Graph tabs stay** as full-bleed doors, alongside the list
  panel's own board/graph view modes. Two doors, different questions.
- **R10 — Default state.** A viewer with no remembered place lands on Chats
  with the composer center. Last place is remembered per space thereafter.
- **R11 — LLD first.** This document, then PR-sized lanes.

## 3. The central reconciliation: one selection model

Today there are **two selection models**:

| | owner | persisted | in URL |
|---|---|---|---|
| Home region B (`center`, `tab`) | `stores/homeRegionStore.ts` | tab → localStorage | no |
| Workspace panels (`stack/pinned/tabs/contentSurface`) | route (`routes/types.ts:88`) via `NavPort` | last-place | yes |

**D1 (proposed): the route wins; `homeRegionStore` retires.** Home's root
selection, center subject, right panel and both breadcrumb trails become route
state. Region B stops being a parallel world; a Home deep link reproduces the
whole arrangement, and back/forward work. `homeRegionStore` is deleted once
lane 4 lands (its per-space tab memory folds into last-place).

### 3.1 Route shape

`NavView` gains one member (the existing `{ view: 'home' }` member is re-pointed
at this screen; `workspace`, `kind`, `channels`, `messages`, `git` keep their
routes as legacy doors — see §7):

```
#/s/{space}/home                       → default root (R10: chats)
#/s/{space}/home/k/{kindSlug}          → root = kind list
#/s/{space}/home/chat/{threadId}       → root = chats, conversation center
```

Panel params, reusing the existing codec vocabulary (`p`, `pin`, `t`,
`contentSurface` stay as they are):

- `p` — the **center trail**, bottom→top. Top renders in the center; the rest
  *are* the center breadcrumb (R7). This is today's stack, reinterpreted: no
  codec change, only presentation.
- `r` — the **right trail**, same encoding, new param. Top renders in the right
  panel; the rest are its breadcrumb. Absent → no right panel.

**D2 (proposed): breadcrumb = trail = stack.** No separate history structure.
Clicking a crumb truncates the trail to it. A right-panel hop pushes onto `r`
(replace-render, single visible slot — the trail gives depth without a third
column). Promote (R6) moves the top of `r` onto `p` as the new root (clearing
both trails), sets the list selection, and — when the promoted entity's kind
differs from the current root kind — switches the root list to that kind.

### 3.2 Center modes (R1)

```
root = chat/{threadId}  → conversation center (chat-home's .tch-conversation
                          + composer + ChatEntityGraph), fed by ChatHomePort
root = k/{slug}, p set  → entity center: EntityDetailPanel via the existing
                          renderPanel seam (WorkspaceView.tsx:384-503 moves to
                          a shared module), contentSurface per panel id
root = k/{slug}, p empty→ EmptyCenter (live roster), as Work behaves today
```

The conversation pane keeps chat-home's hidden-not-unmounted behavior when an
entity takes the center (today's D8 in `home-tabs.test.tsx`) so a running
stream is never torn down by browsing.

## 4. The pieces

### 4.1 Tab row and menu (revision 17)

Groups become: **Home | Board | Graph | Files | Settings** (Collab's group
returns when the new Collab ships, R2). Work and Channels groups retire.

**D3 (proposed): Home is railless in MenuConfig terms.** The menu group is
`{ id: 'home', label: 'Home', items: [{ type: 'view', ref: 'home' }] }` — one
childless view item, so `isRaillessGroup` answers true and the shell mounts the
screen full-bleed. The icon rail is **part of the Home screen, not the menu
rail**, because:

- The rail must show *all* collection kinds (R3) including custom kinds; the
  frozen MenuConfig caps items at 12 and caret children at 8 — it cannot carry
  the list, and the server seeder would have to chase the registry.
- §15.2 bans kind literals outside `domain/`; a registry-derived rail
  (`collectionKinds()`) is the only compliant source anyway, and it makes
  "rail ≡ switcher" (R4) true by construction: both render the same array and
  write the same route.

The rail *component* is reused chrome: same collapsed-by-default anatomy as
#269 (icon + word beneath, 72px), same expand affordance, with group headers
(visual classification only — e.g. Work / Library / Tracking / People) drawn
from a presentation table in `home/`, not from MenuConfig.

The retired rows stay reachable: every ref keeps its route and its palette
entry (the revision-5 precedent — "a rail edit, not a feature removal").

### 4.2 Entity list panel

Header: `[Chats +] [ {KindIcon} {Kind} + ▾ ]`.

- **Chats** is a fixed special root (not a registry kind — messages are
  `strategy: 'anchored'`). Its list is chat-home's thread groups; its `+`
  starts a thread (today's ＋New chat).
- The kind cell is R5's split button: label shows the current root kind; `+`
  opens that kind's create flow (`EntityCreateControl`, as Work's docks wire it
  today); `▾` opens the registry-driven kind list (identical content to the
  rail). `EntityListPanel` already has `KindSelector` + `createSlot` — the
  header regroups them, no new list machinery.
- The body is the existing `EntityListPanel` with #272's relational tiles for
  every kind — traversal in the list (chips expand linked entities inline as
  real tiles) is already shipped and is untouched by this design.
- View modes (List/Tree/Board/Graph) stay per kind (R9 keeps the top-level
  Board/Graph tabs too).

**D4 (proposed): one dock, not two.** Work's twin docks collapse into the
single list panel; the right column becomes the R6 right panel. The two-dock
arrangement was Work's way of seeing two kinds at once; in Home the second
kind arrives through relations (right panel) or a root switch.

### 4.3 Center and right panels (R6, R7, R8)

- `renderPanel` (detail hosting incl. content surfaces, archetype-based chat
  surface pick) extracts from `WorkspaceView` into a shared module both Home
  and any remaining callers use (R8: reuse, don't rebuild).
- In-place tree navigation: within the center, hierarchy clicks (sub-entities
  of the root's own tree) push onto `p` — the crumb grows, center re-renders.
- Relation clicks (cross-kind, or same-kind outside the tree) push onto `r`.
  "Outside the tree" is decided by the same ancestor-path test #272 uses for
  cycle suppression (`list/related.ts` path threading) — one definition of
  "the tree" everywhere.
- The right panel is a slimmer instance of the same detail panel (it already
  renders at right-column width today) with two extra affordances: **open
  here** (promote, R6) and close (clears `r`).
- Breadcrumb chrome: one `PanelCrumbs` strip per panel, rendered from the
  trail; crumb click truncates. Kind icon + title per crumb, middle-ellipsis
  beyond 4.

### 4.4 Defaults and last place (R10)

`HOME_TARGET` re-points at `{ view: 'home' }`. With no remembered place the
root is Chats and the center is the composer (start-a-chat), exactly today's
Collab landing. `last-place.ts` keeps storing the menu target; the Home root
kind and trails ride in the stored target's route, so "remembered thereafter"
falls out of the existing mechanism once the route owns the state (D1).

## 5. What retires, what survives

| Today | After |
|---|---|
| Collab tab (chat-home + 3-tab column) | Home root "Chats"; column tabs retired (the switcher generalizes them) |
| Work tab (twin docks + PanelStack) | Home entity roots; PanelStack machinery reused in the center |
| Channels tab (channel list · Messages · voice rooms) | `channel` kind in Home; Messages view + voice rooms: route-reachable, palette-reachable; their chrome seat returns with Collab (§8) |
| Code row (git topology view) | No rail row (R4); route + palette reachable (§8) |
| `homeRegionStore` | deleted (D1) |
| Board / Graph / Files / Settings tabs | unchanged (R9) |

Nothing loses its route. Old targets (`workspace`, `kind`, `channels`,
`messages`, `git`, `channel`, `entity`) keep parsing; `redirects.ts` maps
`workspace`/`kind` targets onto the equivalent Home route so stale links and
stored last-places land correctly.

## 6. Lanes (PR-sized, in order)

1. **Route + codec.** `home` NavView member re-pointed, `/home/k/{slug}` +
   `/home/chat/{id}` segments, `r` param, normalize/redirect rules, codec
   tests. No visible change.
2. **Menu revision 17.** Home group replaces Collab/Work/Channels groups;
   `home` joins `RAILLESS_VIEW_REFS`; upgrade guard for stored revision-16
   configs; seeder parity test.
3. **HomeScreen shell.** New `home-unified/` screen: registry icon rail
   (reusing #269 anatomy) + `EntityListPanel` with the new header (split
   button, Chats root) + EmptyCenter. Mounted from GateApp for `view: 'home'`.
   Work tab still exists in parallel during this lane.
4. **Center + right.** `renderPanel` extraction, center trail rendering with
   crumbs, right panel with crumbs + promote, R6 click rules wired through
   #272's path test. Chat center mode via `ChatHomeSurface`; delete
   `homeRegionStore`; retire the column tabs.
5. **Retirement.** Remove Work/Channels/Collab groups' screens' tab seats,
   redirects for stored last-places, delete dead chrome, docs sweep.

Lanes 1–2 are mechanical and reviewable in isolation; 3 and 4 carry the UX and
each stands alone behind the still-present Work tab until 5 flips the chrome.

## 7. Testing posture

- Route/codec: round-trip + redirect tables (lane 1, pure).
- Menu: revision-17 parity with the DB seeder (`menu-seeder-parity.pg.test.ts`
  pattern) and fail-closed upgrade from stored 16.
- R6 rules: a click-destination decision table test (in-tree → center push,
  cross-kind → right push, same-kind-out-of-tree → right push, promote →
  re-root + list selection) against the shared path test — the rules live in
  one pure module so the table is exhaustive.
- jsdom cannot see layout (established repeatedly — #256, #266): rail geometry
  and crumb overflow get playwright captures via the existing
  `e2e/menu-rail-harness` pattern.

## 8. Open items (deliberately deferred)

- **Messages view and voice rooms** need interim seats after the Channels tab
  retires (both keep routes; neither has Home chrome until Collab ships). If a
  voice room is live, its today's-behavior injection point disappears with the
  Channels group — proposal: a small live-voice strip in Home's rail footer,
  or defer entirely to Collab. **Needs a ruling only when lane 5 lands.**
- **Git topology view (Code)** — route + palette only, per R4. If that proves
  too buried, it can become a content surface on `project`/`worktree` detail.
- **Mobile** (`src/mobile/`) is untouched by this design; the R6 rules assume
  three columns and will need a phone-shaped answer separately.
- **Custom kinds** in the rail: included by R3; icon fallback comes from the
  registry's `c:*` art.
