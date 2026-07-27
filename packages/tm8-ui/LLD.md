# tm8-ui — Low-Level Design (Phase 0)

**Status:** DRAFT v1 — awaiting Fable-5 adversarial review (gates Phase 2 per charter R5).
**Author:** LLD Author worker (fe-coordinator track), 2026-07-28.
**Authority chain (highest first):** user rulings R1–R12 (`docs/plans/tm8-ui-orchestration/CHARTER.md`) → this package's `DECISIONS.md` (D1–D4) → WLT v2.11 (`08-SPECS/WORKSPACE-LAYOUT-AND-TERMINOLOGY.md`, THE governing spec) → `08-SPECS/TM8-UI-SPEC-FINAL.md` (engineering spec; where it conflicts with a ruling, the ruling wins) → `01-REQUIREMENTS-AND-BRIEF.md` (C1–C9) / `02-LAYOUT-SPEC.md` / `03-DESIGN-LANGUAGE.md` (ATELIER) → the 18 canvases in `T0-1 workspace structure review (1)/` (pixel ground truth; D4 names T5-2, T5-5/T5-6, T5-3 as canonical composition references when canvases disagree).
**Scope:** interaction logic only, no domain logic (FE brief). Everything renders against a typed Facade seam with fixture data, to THE GATE (the complete interactive T0-1 master screen, light+dark), then fans out. `src/data/**` is bridge-coordinator territory; §10 is a seam *proposal*, marked DRAFT pending bridge consensus.

Spec-name adaptation, applied throughout: TM8-UI-SPEC-FINAL §4.0 proposes `packages/ui-next` plus shared packages (`@tm8/kit`, `@tm8/ui-data`, `@tm8/terminal-core`). Charter R1 supersedes the topology: **everything lands inside `packages/tm8-ui`** as internal modules (`src/kit`, `src/data`, `src/terminal`, …). The *content* of those spec sections (ListConfig §4.5.2, component tree §4.1, state table §4.3, harvest/condemn lists, rulings C-1…C-8) is adopted; only the package boundaries move.

---

## 0. Ten laws this design is built around

Each law traces to a binding source; the adversarial reviewer should attack any section that violates one.

| # | Law | Source |
|---|---|---|
| L1 | Click an entity anywhere → its detail panel opens on the stack. No base layer, no special screens. | C1, RULING D |
| L2 | Per-kind divergence lives in registry DATA. A per-kind behavior with no registry field is a **spec defect**, never an inline `if (kind === …)`. | C4, FE brief, SPEC-FINAL C-5 |
| L3 | Two primitives carry every list and every detail. Six collection layouts behind one switcher. | C4, C5 |
| L4 | Every shrinkable track has a floor: menu 48, left 200, center `C_min`, right 220, panel column 320, terminal host height 160. `minmax(0,…)` and unfloored `overflow:hidden` flex are forbidden. | 02-LAYOUT-SPEC §6 |
| L5 | The terminal transport/byte stack is a verbatim transplant and a black box. Layout/mounting may adapt; byte handling may not. | R9, RULING A/D |
| L6 | Unavailable ≠ invisible: deferred features and unavailable ops render **disabled-with-reason**. A ghost/affordance may never advertise an action the facade cannot perform. | R7, F6/X4 lesson, SPEC-FINAL §4.12 |
| L7 | Honesty states never collapse: liveness never lies (stale ≠ live), delivery renders as two facets (delivery × record), never one badge. | 01-REQ §2.7/§8, WLT §5.7 |
| L8 | Everything navigational is a URL; share/reload lands looking right. One codec, built fresh; `buildHash` is condemned. | WLT §2.2, SPEC-FINAL C-7 |
| L9 | The keyboard map is a specified contract (C6), not an adaptation slot; a focused terminal owns the keyboard except physical `Ctrl+backtick`. | RULING G, WLT §5.8 |
| L10 | Status is always color + word; light and dark themes from day one; agents are peers with provenance (round vs rounded-square avatars). | C8, C9, ATELIER |

---

## 1. Module topology inside `packages/tm8-ui`

```
packages/tm8-ui/
  LLD.md  DECISIONS.md
  src/
    kit/            tokens.css (verbatim copy) + primitives extracted from the canvases
    theme/          ThemeProvider, data-theme stamping, persistence
    domain/         THE KIND REGISTRY (the spine): registry rows, ListConfig,
                    PanelConfig, body archetypes, ActionRef registry, slugs
    routes/         fresh codec + normalizer + redirects + harvested transport
    stores/         navStore (URL-mirrored panel engine), uiStore, sidePanelStore
    keyboard/       the C6 contract: one controller, layered scopes, chord machine
    shell/          App, SpaceTabBar, MenuRail, ViewHost, CommandPalette,
                    NoticeHost, ErrorBoundary, TerminalParkingContainer
    panels/         EntityListPanel, EntityDetailPanel, the six archetype bodies,
                    generic content blocks
    collections/    CollectionView + layout implementations + switcher
    views/          HomeView FeedView InboxView WorkspaceView ChannelsView
                    ChannelView EntityView EntityFullView SettingsView (+T2/T3
                    surfaces at fan-out)
    terminal/       transplant/ (VERBATIM black box) + TerminalPool + chrome strip
    fixtures/       FixtureFacade + dataset (contract-shaped, §10.6)
    data/           BRIDGE-COORDINATOR OWNED. Contains the agreed seam types file
                    (seam.ts) and the WS-first implementation. FE code imports
                    ONLY the seam surface from here, never internals.
  test/             unit/property/registry-exhaustiveness suites (vitest)
```

Environment facts (charter): vite dev server on **port 4612**, React 18 + TS + zustand, `tsc -b` + vitest, bun/vite allowed for UI packages, never parallel vite builds.

### 1.1 Import DAG (enforced, not aspirational)

```
kit ← theme ← domain ← {routes, stores, keyboard} ← {panels, collections} ← views ← shell
terminal/transplant ← terminal/pool ← panels/bodies/terminal (via pool API only)
data/seam (types) ← stores, panels, collections, views   (nothing else from data/)
fixtures → data/seam (implements it)
```

Rules, each backed by a lint/dep-cruiser test (§15):

- **No component imports `src/data/` internals** — only the seam surface (`data/seam`). A seam leak is a build failure, not a review comment.
- **No module outside `src/domain/` mentions a concrete kind.** The string literals `'task'`, `'work_session'`, etc. and any `kind ===` comparison are permitted only in `domain/` (registry data) and `fixtures/` (dataset). Everything else consumes registry rows. One narrow, named exception: the route codec handles the `channel`/`message` route *strategies* (`special`/`anchored`) — it branches on **strategy**, which is a registry field, never on kind.
- **No module outside `terminal/transplant/` touches xterm, sockets, or bytes.** The rest of the app sees only the TerminalPool lease API (§9.2).
- `kit/` is app-agnostic: no imports from domain/stores/data.

---

## 2. The kind registry — the spine (`src/domain/`)

One module drives routes, origin validation, palette entries, menu-ref validation, both primitives, and Z4 layouts. An exhaustiveness test asserts a row for every member of `CoreEntityKindSchema` (15 kinds: `channel task message member team_member doc file spell skill pull_request commit work_session collection project interaction_profile`) — the WLT §2.1 totality law.

### 2.1 Row shape

Adopted from SPEC-FINAL §4.5.1, adapted to this package (the inherited `KindEntry`/Z1–Z4 member is rebuilt fresh here — the old registry's *shape* is kept, its markup is not harvested):

```ts
interface KindConfig {
  kind: CoreEntityKind | 'c:*';            // 'c:*' = the single custom-kind fallback row
  label: string; labelPlural: string;
  icon: IconRef;                            // needed by menu-collapsed 48px state (02-LAYOUT §1)
  slug: string | null;                      // WLT §2.1; null for message (anchored)
  strategy: 'collection' | 'special' | 'anchored';
  routeBuilder?: (id: EntityId) => Hash;    // strategy='special' (channel)
  defaultMode: CollectionMode;              // of the six layouts
  hiddenModes: CollectionMode[];            // hidden by config, never hard-coded away
  chip: ChipSpec;                           // Z1: glyph + state tint mapping
  card: CardSpec;                           // Z2: 2–4 summary fields from EntityState
  list: ListConfig;                         // §2.2 — EntityListPanel behavior as data
  panel: PanelConfig;                       // §2.3 — EntityDetailPanel behavior as data
  palette?: { createLabel?: string; primaryAction?: ActionRef };
}
```

Slugs and reserved words follow WLT §2.1 exactly: `tasks sessions docs teammates pulls members spells skills collections files commits projects interaction-profiles`; reserved `home feed inbox workspace settings channel e k`; `c:{name}` → `c-{name}` collision-checked; `channel` = special (`channel/{id}`), `message` = anchored (canonical route = containing channel + `?msg=`; parent missing → `e/{messageId}` with tombstone banner and NO companion).

### 2.2 `ListConfig` — EntityListPanel behavior as data

Adopted verbatim from SPEC-FINAL §4.5.2 (the C-5 fix). The WLT §3 survival list maps 1:1 onto these fields and is the acceptance matrix — every surviving behavior names its field; a behavior with no field is a spec defect.

```ts
interface ListConfig {
  sections?: { id; label; filter: QueryFilter; collapsedByDefault?: boolean }[]; // task: current/completed
  lifecycleTabs?: { id; label; filter: QueryFilter }[];      // work_session: live/exited/…
  tree?: { by: 'hierarchy'; guideLines: boolean };           // task subtree; session coordinator→worker
  tile: { badges: TileBadgeSpec[]; pulse?: (s: EntitySummary) => boolean };
  liveCount?: { filter: QueryFilter; label: (n: number) => string };  // '● N live'
  quickCreate: boolean;
  quickLaunch?: ActionRef;                                   // sessions quick launch
  primaryActions?: ActionRef[];                              // task: Run / Coordinate
  filters: FilterSpec[];
  sort: SortSpec[];
  needsAttentionGroup?: (s: EntitySummary, live: LivenessView | null) => boolean; // 'NEEDS YOU' (dormant, R8)
  liveness?: (s: EntitySummary, live: LivenessView | null) => Liveness;  // ONE predicate (R-UI-5)
}
```

`QueryFilter`/`FilterSpec`/`SortSpec` are thin typed wrappers over the contract's `CollectionFilters`/`sort` unions — configs express filters in contract vocabulary so the facade can execute them without translation.

### 2.3 `PanelConfig` + the six body archetypes

The EntityDetailPanel's fixed anatomy (§4) never varies. What varies per kind is **data**:

```ts
type BodyArchetype = 'subtree' | 'reader' | 'hub' | 'profile' | 'generic' | 'terminal';

interface PanelConfig {
  archetype: BodyArchetype;                 // Content-tab body at Z3; same archetype scales to Z4
  blocks?: ContentBlockRef[];               // generic archetype: ordered blocks (§2.4)
  primaries?: ActionRef[];                  // action-bar kind primaries (task: run, coordinate)
  statusPill?: StatusPillSpec;              // which EntityState field feeds the header pill + color word
  capabilityReasons?: Partial<Record<keyof EntityCapabilities, string>>;
                                            // reason strings for capabilities the server turns OFF (L6);
                                            // server truth (EntityDetail.capabilities) decides ON/OFF,
                                            // the config only supplies the honest wording
  contentSurfaces?: readonly ['terminal'] | readonly ['terminal', 'chat'];
                                            // work_session only; Phase 1 ships ['terminal'] (no switch
                                            // rendered), the field IS the RULING-K seam
  z4?: { immersive?: boolean };             // session Z4 = full-height terminal host
}
```

**Archetype assignment (total over the kind set):**

| Archetype | Kinds | Z3 Content body | Z4 scaling | Canvas |
|---|---|---|---|---|
| `subtree` | task | description + acceptance criteria + children board/tree | subtree board | T0-4, T5-2 |
| `reader` | doc | rendered body (markdown/mermaid/excalidraw by `state.format` — a *format* switch inside one archetype, not a kind switch) | reader with chapter tree | T0-4, T5-3 |
| `hub` | channel | thread + pinned shelf + auto-tabs | channel hub | T0-4, T10 |
| `profile` | member, team_member | identity header + equipped/work collections | profile | T0-4 |
| `terminal` | work_session | ASSOCIATED PROJECTS + SHARED CONTEXT sections (project chips incl. immutable launch provenance; handoff pills: delivered ✓ / recorded / `delivery unknown ⚠` — the two-facet law) → optional `⚠ needs you` banner (dormant, R8) → toolbar seam → chrome strip → xterm host / exited fallback (§9) | full-height terminal | T0-1 session panel, T0-2/T0-5 |
| `generic` | message, file, spell, skill, pull_request, commit, collection, project, interaction_profile, **every `c:*`** | ordered content blocks (§2.4) | standard | T0-4 |

Custom kinds land on `generic` **for free**: registry lookup miss → the `'c:*'` fallback row (default ListConfig, generic PanelConfig, `c-{name}` slug). No custom kind ever needs code.

### 2.4 Generic-archetype content blocks

The generic body is a renderer over an ordered list of **content blocks** — the mechanism that lets nine kinds share one archetype without per-kind components:

```
'fields'        typed key/value rows from EntityContent/EntityState (c:* fields record)
'link-summary'  external ref row (pull_request: repo #number state; commit: sha + message)
'file-preview'  mime-gated preview + download affordance (file)          [T3 Files canvas]
'items'         EntitySummary chip list (collection.items, member.work…)
'lifecycle'     status + version row (interaction_profile: template key/version/hash,
                lifecycle capabilities rendered OFF with reasons per WLT §7.6)
'notice'        static honest-empty explanation (why a section is empty)
```

A new per-kind display need = a new block or a new block parameter in that kind's `blocks` list — data, not branches. Blocks receive `(detail: EntityDetail, block: ContentBlockRef)` and must render worst-case content (UUID titles, 32KB bodies) within floors.

### 2.5 ActionRef registry

Primaries, palette actions, list quick-actions, and ⌘Enter all resolve through one action registry: `ActionRef → { id, label, icon, availability: (ctx) => Available | DisabledWithReason, run(ctx) }`. Availability composes op-availability from the facade (§10.3) with entity capability flags. Actions are the single place a "verb" exists — the same `run` action serves the task tile button, the panel action bar, ⌘Enter, and the palette row (no duplicated verb wiring).

---

## 3. The two universal primitives (`src/panels/`)

### 3.1 EntityListPanel

Anatomy top→bottom (T0-3 canvas is the visual ground truth):
**kind selector** (registry rows with `strategy='collection'` only) → **header row** (Create if `quickCreate`, `quickLaunch`, `liveCount`) → **filter row** (`filters` chips + sort) → **body** (sections | lifecycleTabs | flat; tiles per `tile`; tree per `tree`; virtualized above ~200 rows via the kit `VirtualList`).

- Data: one facade collection subscription per (kind, filter) query key (§10).
- Session rules bound by config, not code: `liveness` implements R-UI-5 (one predicate → click target AND live affordance; `status=running` with no live PTY renders **“stale — node restarted”**, visually distinct, never live). `needsAttentionGroup` sorts NEEDS-YOU sessions above idle (designed-but-dormant per R8 — the group renders whenever the predicate fires; no server detection in this program). Terminate cascades with blast-radius confirm; complete is intent-only (both are ActionRefs).
- Unavailable affordances render disabled-with-reason via the capability seam (L6) — never dropped, never faked.

### 3.2 EntityDetailPanel (Z3)

Fixed anatomy for every kind (02-LAYOUT §3; D3: **four tabs always** — Content / Discussion / Connections / Activity, fixed order, no exceptions; the T5-7 three-tab mocks are abbreviation):

header (breadcrumb · kind glyph · inline-editable title · status pill · overflow ⋯ · pin 📌 · promote ⤢ · close ✕) → action bar (react/points · Link · Add child · Pull · registry primaries) → the four tabs → footer (presence 👁 · by-actor · v{n} · active-ago).

- Content renderer = `registry(kind).panel.archetype` → archetype body. **No kind branches outside the registry** (L2).
- Discussion = the inherited thread over `messages.list` for this entity; Connections = grouped `EdgeGroup` rail + edge composer; Activity = `entities.activity` rows. All three are kind-agnostic by construction.
- Capability gating: `EntityDetail.capabilities` decides; `capabilityReasons` words the OFF states.
- Pin control shows refusal reasons (§5.3) rather than disabling silently.
- Header/action-bar/tab-strip/footer are shared component instances — the peek stack, workspace columns, and Z4 render the *same* `EntityDetailPanel` with a `host` prop (`'stack' | 'pinned' | 'peek' | 'z4'`) affecting only width/chrome, never anatomy.

### 3.3 CollectionView — six layouts, one switcher

`[List | Board | Tree | Feed | Gallery | Graph]` + group control. List/Tree/Board/Feed/Gallery implemented (T0-3, T5-2 canvases; D4 makes T5-2 canonical for Board/Feed/Gallery). **Graph renders as a disabled-with-reason switcher position** (“Graph view isn’t available yet”) per R7 — visible, never hidden, never built.
- Board requires its **axis picker** (“axis: status ▾”) — in scope per D2; it drives `CollectionQuery.groupBy` (`workStatus | assignee | axis:{name}`). What stays deferred is saved-views/axes *persistence management* (R7).
- Kind defaults/hides come from `defaultMode`/`hiddenModes`; the switcher is one control everywhere (C5).
- Clicking any card → stack push (L1); expand promotes to Z4 with `origin` preserved.

---

## 4. Shell composition (`src/shell/`)

```
<App>                                boot: identity, space list, theme, install registry
 └─ <SpaceTabBar>                    42px; space switcher + product mark; NO ◐ theme toggle (D1)
 └─ <SpaceShell spaceId>
     ├─ <MenuRail>                   §4.1; M ∈ {48, 220} discrete, ⌘\ + visible control
     ├─ <ViewHost>                   route → view via the view registry; ErrorBoundary per view
     │   ├─ HomeView | FeedView | InboxView
     │   ├─ WorkspaceView            §5
     │   ├─ EntityView (k/{slug})    CollectionView + right-edge peek stack
     │   ├─ ChannelsView | ChannelView
     │   ├─ EntityFullView (e/{id})  Z4; work_session Z4 hosts the terminal (single-host law)
     │   └─ SettingsView (/projects | /menu)
     ├─ <PanelStack>                 non-workspace right-edge peek stack + pinned splits (§5.5)
     ├─ <CommandPalette>             ⌘K / '/'
     ├─ <TerminalParkingContainer>   hidden, retained, app-lifetime (§9)
     └─ <NoticeHost>                 R4-7 overflow notices, toasts, disabled-reason surfacing
```

### 4.1 MenuRail — data-driven, three row types

Renders the space's `MenuConfig` (RULING H; frozen DTO in `contract/schemas.ts`). Exactly three row grammars, all decided by data shape:

1. **Group header** — label-only, never clickable (`MenuGroup.label`).
2. **Plain row** — `MenuItem` without children: view ref or kind ref; click navigates via the view registry / kind route strategy.
3. **Caret view row** — view item WITH `children` (≤8, depth exactly ≤1): row click opens the view, caret expands `MenuLeaf` children (each a pre-filtered Entity View). The shipped default encodes Workspace exactly this way.

Collapsed 48px state renders icons only — every view AND kind ref has an `icon` (registry-required field). Toggle: ⌘\ + a visible control. Fail-closed: missing row, malformed-of-understood-version, unsupported-future-version, or **op-unavailable** all render the versioned shipped default constant (mirroring the WLT §2 diagram; dossier value supersedes); `settings` is always present. Menu edit surface: §4.4 settings. Shortcuts bind to registry/view refs, never menu positions.

### 4.2 CommandPalette

`/` everywhere (plain key, dead in text entry), ⌘K where receivable. Scope: any addressable entity (fuzzy over summaries via facade search) + any implemented view. Deferred features (Leaderboard, Activity, saved views, Graph) appear only as **disabled “not available yet” discovery rows** (R7) — same DisabledWithReason vocabulary as everything else. Palette actions come from the ActionRef registry.

### 4.3 NoticeHost

One component owns the R4-7 overflow notice (“some tab/surface/pin/panel/filter state wasn't carried in this link” — class-naming, no raw IDs), toast-level command failures, and the demotion notices. One vocabulary, one queue, aria-live polite.

### 4.4 SettingsView (Phase-3 fan-out; seams fixed now)

Space settings (profile, members/roles, invites, task axes), **Linked Projects**, **Menu editor** (sends `MenuConfigPayload` + `expectedRevision`; `menu_revision_conflict` → reload-and-retry; `menu_upgrade_required` → explicit “edited by a newer version” state), node-admin Project Registry. Routes exist in the codec from day one (`settings[/projects|/menu]`).

---

## 5. Workspace view & the panel engine

### 5.1 Geometry (L4)

Grid: `minmax(200px, var(--ws-left)) · 8px gap · minmax(C_min, 1fr) · 8px gap · minmax(220px, var(--ws-right))`. Side panels user-resizable to floors; resize handles live inside the 8px gaps (WLT gap law wins over the old 6px resizer track). Defaults: left 280 / right 319; side panel contents are EntityListPanels (default left=tasks, right=sessions; per-viewer persisted, `sidePanelStore`).

**`C_min = max(320, V·320 + max(0,V−1)·8)`** where `V = pinned.length + (stack.length > 0 ? 1 : 0)`:

| V | 0 | 1 | 2 | 3 | 4 |
|---|---|---|---|---|---|
| C_min | 320 | 320 | 648 | 976 | 1304 |

Shrink order (02-LAYOUT §5): menu collapses → side panels to floors → pins demote (loop) → center bottoms at 320 → panels stack (right-stacked → both-stacked → full-width sheets; T1-3 canvas). Breakpoint constants are **derived at reference capture by measurement**, never asserted.

### 5.2 The nav store state machine

`src/stores/navStore.ts` — fresh code, inherited *semantics* (the old nav store's machine over `{stack, pinned, tabs}` is the behavioral oracle; its code is not copied because the codec and `contentSurface` are new). State: `{ spaceId, view, stack: EntityId[], pinned: EntityId[], tabs: Record<EntityId, Tab>, contentSurface: Record<EntityId, 'terminal'|'chat'>, session?: EntityId }`, mirrored bidirectionally to the URL (§6).

- Push dedupes; opening an already-hosted session raises/focuses (single-host law, WLT §5.2c).
- Pin moves stack→pinned; unpin explicit; **promote to Z4 removes the id from BOTH sets** (fixes the inherited `promotePanel` gap SPEC-FINAL §2.3 flags).
- Hydration dedup: id in both `p` and `pin` keeps **pin** (precedence pin > stack), before first render.
- Esc pops stack top only, never pins, only when no higher keyboard layer holds focus (L9).
- Empty center (`stack ∪ pinned = ∅`): live-session roster + grammar hint (02-LAYOUT §2.2); `?session=` auto-opens only when `p` and `pin` are absent.

### 5.3 Admission, refusal, demotion

- **Admission:** pin allowed iff measured `centerWidth ≥ C_min(V′)` for post-admission V′ AND `pinned.length < 3` AND the pool lease constraint (§9.2: never more simultaneous leases than `k−1`). Refusal renders on the pin control as disabled-with-reason (“center too narrow — unpin or widen” / “3 pins max”), never a silent no-op.
- **Normalization loop:** on width/state change, `while (centerWidth < C_min(V) OR pinned.length > 3)` demote the **oldest** pin onto the stack top. Demoting onto an empty stack keeps V constant — the loop, not one step, converges; bounded by `pinned.length ≤ 3` iterations.
- **Exit rule (SPEC-FINAL C-3/§4.7.4):** if pins are exhausted and `centerWidth < 320` still, normalization STOPS — stack-top renders at the grid floor and the §5.1 breakpoint machinery is the responsible mechanism. Normalization never empties the stack.
- One debounced canonical `replaceState` per settle. Widening never auto-restores demoted pins.

### 5.4 LiveSessionBar

Fixed top row (~28–32px): `● {focused session} — N live`; N = ALL live work_sessions in the space; dot pulses while the focused session streams. Click name = open/raise; click count = roster popover (also the drop target row per §8). Reload/reconnect reachability of every live session is gate acceptance.

### 5.5 Non-workspace peek stack

On `k/…`, channels, Home, Inbox: the same nav store drives a **right-edge peek stack** (~440px overlay) over the view; pinning docks a persistent split column (min 320); same max-3-pins, same Esc, same anatomy (02-LAYOUT §4). Same `EntityDetailPanel` with `host='peek'`. The workspace view is the only place panels are the center rather than an overlay.

### 5.6 Z4 — EntityFullView

Route `e/{id}` (or promote ⤢). Full-view layout scales the same archetype (§2.3 table). `work_session` Z4 hosts the terminal via the same single pool lease (Z4 is a first-class host). Breadcrumb-up/children-down and Connections stay visible (mental model #2).

---

## 6. Route grammar & codec (`src/routes/`) — FRESH

Grammar verbatim (WLT §2.2):

```
#/s/{spaceId}/home | feed | inbox
#/s/{spaceId}/workspace          ?session= & p= & pin= & t= & contentSurface=
#/s/{spaceId}/k/{slug}           ?mode= & q= & p= & pin= & t= & contentSurface=
#/s/{spaceId}/e/{entityId}       ?origin= & p= & pin= & t= & contentSurface=
#/s/{spaceId}/channels
#/s/{spaceId}/channel/{channelId}   [?msg={messageId}]
#/s/{spaceId}/settings[/projects|/menu]
```

- **Encodings** (SPEC-FINAL §4.2.2): `p` = dot-joined stack ids bottom→top; `pin` = dot-joined pin order; `t` = comma-joined `{id}:{content|discussion|connections|activity}` pairs (omitted ⇒ `content`); `contentSurface` = comma-joined `{id}:{terminal|chat}` pairs, meaningful only for work_session panels, **never expanding the `t` vocabulary**; `session` = one id, auto-open per §5.2; `origin = {slug}[.{mode}]` registry-validated; RFC 3986 percent-encoding.
- **`q` codec v1** (SPEC-FINAL §4.2.4): `base64url(JSON)` of `{ v:1, filters?, sortBy?, groupBy? }` — strict subset of `CollectionQuery` (no kinds/limit/cursor). Unknown `v` ⇒ atomic discard. Dossier may supersede behind the version byte.
- **Cap & drop:** total hash ≤ 2048 chars. Overflow drops whole params atomically in order **(1)** `t` tier (`t` AND `contentSurface` together) → **(2)** `pin` → **(3)** `p` → **(4)** `q` (to canonical default). Never over-cap, never mid-token; navigation always succeeds; any drop emits ONE generalized NoticeHost notice. Unparseable param → atomic discard, canonical default.
- **History discipline:** `pushState` = user navigation + explicit pin/unpin. Debounced idempotent `replaceState` = responsive normalization (demotions, dedup, drops) and surface toggles. Exactly one `replaceState` per normalization settle.
- **Redirects** (complete table, SPEC-FINAL §4.2.5): `tasks→k/tasks`, `sessions→k/sessions`, `sessions/{id}→e/{id}?origin=sessions`, `docs→k/docs`, `team→k/teammates`, `tracking→k/pulls`, `graph|leaderboard→home` + one deferred-feature notice; `home inbox settings e/ channel/ workspace` unchanged; bare forms resolve against last-active space, else the space picker.
- **Canonical reload:** `e/{id}` without origin → companion from the registry strategy; with origin → that view+mode.

**Provenance:** codec, normalizer, redirects = fresh pure modules (`parse/build/normalize` with property tests: round-trip, cap interaction, drop order, `normalize∘normalize = normalize`). Harvested: only the router *transport* pattern (browser/memory hash targets — the old `createBrowserTarget`/`createMemoryTarget`). **Condemned and never imported: the old `buildHash`** (channel-route asymmetry, SPEC-FINAL C-7).

---

## 7. Keyboard contract (`src/keyboard/`) — C6 exactly

One `KeyboardController` installed at the app root implements the 6-layer priority chain (WLT §5.8); each layer **consumes** what it handles (preventDefault + stopPropagation); nothing depends on listener order:

1. Browser/OS (never intercepted; frozen exclusion list — no binding may use `Mod+W/T/N/L`, `Ctrl+Tab`, `F11`, …).
2. Topmost modal/dropdown/palette — Esc closes only that surface.
3. **Focused terminal while `contentSurface=terminal`** — owns everything except the blur chord. A hidden pool lease grants no keyboard authority.
4. Text-entry controls — all plain-key bindings DEAD; `Mod`-chords live where receivable; Esc blurs (consumed).
5. Focused list/panel bindings.
6. Global chrome bindings.

Bindings (browser-proof core = plain keys + `g`-chords; `Mod` chords are conveniences gated on per-platform receive tests, never advertised where browser-owned):

| Scope | Keys |
|---|---|
| Global | palette `/` (guaranteed) + ⌘K where receivable · `g h` Home · `g t` Tasks · `g s` Sessions · `g d` Docs · `g m` Teammates · `g p` Projects · `g c` Channels · `g i` Inbox · `g ,` Settings · ⌘\ menu rail |
| Lists | `j/k` or ↑/↓ · Enter opens (stack push) · ⌘Enter = registry primary action · `c` create in kind |
| Panels | Esc pops stack top · `p` pin/unpin focused panel · Tab order header → actions → tabs → body |
| Terminal | owns the keyboard; exit = **physical `Ctrl+Backquote`** (`event.code==='Backquote' && ctrlKey`), intercepted inside xterm's `attachCustomKeyEventHandler` — **zero bytes reach the PTY**; focus lands on the owning panel's Content tab header (lease-supplied, stable across reparent/park); a visible “exit terminal ⌃`” chip in the chrome strip + `aria-describedby` on the host is mandatory |

Chord machine: `g` opens a chord window (visible hint); any non-mapped second key cancels. Scopes register declaratively (`useKeyScope(layer, bindings)`); every table row is a unit test; terminal ownership + escape additionally browser-tested (type `j` into focused terminal → PTY, list selection unmoved). Shortcuts bind to registry/view refs, never menu positions.

---

## 8. Drag & drop (interaction surface only)

Inherited 7-row drop grammar + **row 8: entity → live work_session = share-into-session** (RULING F). The saga is server-side; UI obligations only:

- Drop targets: session panel Content region + toolbar, live-session bar, roster rows, live session tiles.
- Issue `handoffs.send` with client-generated `handoffId` (= `clientMutationId`). Render `deliveryStatus × recordStatus` as **two facets, never one badge** (L7); `unknown` never styled as success; re-attempt = a NEW share with a NEW `handoffId`; withdrawal decorates the correlated message/edge by badge (never rewrites the row); `sourceMissing` rendered explicitly.
- Row 8 promises **no undo** — drop ghost/confirm copy states irreversibility.
- **Standing law (L6):** while `handoffs.*` is unavailable at the facade, every drop target renders disabled-with-reason; a ghost may never advertise an action the facade cannot perform.
- Phase-1 fixtures exercise the full facet matrix (§10.6) so the visuals exist before the real saga is wired.

---

## 9. Terminal integration (`src/terminal/`) — R9 black box

### 9.1 Verbatim vs adapted

**Verbatim transplant (never edited, byte-handling frozen):** `transplant/` = ptyTransport, visibilityDriver, writeScheduler, runtime, terminalSize, terminal settings store, clipboard helpers — plus the already-vendored `@maestro/pty-protocol` package with its golden-frames anti-drift test. Two seams cut at transplant time only: capability injection for the paste/upload path (config, not an import of old-app capabilities) and the settings-persistence key (kept shared so both apps see the same user settings).
**Adapted (allowed by R9):** mounting and layout — the TerminalPool below.
**Not in this package's scope:** PTY WS server, heartbeat/drift audit (server-owner lane).

### 9.2 TerminalPool (WLT §5.2a; SPEC-FINAL §4.8)

One app-lifetime pool owning session-keyed `TerminalInstance`s (xterm + transport registration + observers + decoder state) and the hidden retained parking container.

```ts
interface TerminalPool {
  acquireHost(sessionId: string, hostEl: HTMLElement, opts: { focusTarget: HTMLElement }): Lease;
  releaseHost(lease: Lease): void;      // idempotent; stale lease no-op (StrictMode-safe)
  markWarm(sessionId: string): void;    // ?session= hydration, panel open, roster switch
  setActive(sessionId: string | null): void;
  onActiveChange(cb: (id: string | null) => void): Unsubscribe;
  setCapacity(k: number): void;         // clamped ≥ MAX_PINNED + 2 = 5
}
```

- Acquire = reparent the instance's existing DOM node into the host (`appendChild`, the maestro TeamView mechanism: move `term.element`, double-rAF refit; restore-then-refit on release). Portals are NOT the mechanism.
- Leased instances eviction-ineligible; eviction = LRU among **parked** only; `k ≥ 5` (the shipped `k=4` is knowingly superseded — SPEC-FINAL C-2; nobody harvests the 4); occupant swap = acquire-new-then-release-old atomic handoff (transient `k+1`); eviction = full teardown; return = fresh instance + offset-0 full replay. Flush-before-suspend ordering is preserved by construction: `releaseHost` parks; only the driver flushes/suspends — release never touches the transport.
- Visibility = rendered host lease (stack top | pinned column | Z4) AND outer tab = Content AND `contentSurface=terminal`; other states `visibility:hidden` + `aria-hidden`/`inert` + flush-before-suspend. Exactly one `activeSessionId` (blink/keyboard/fit authority) with deterministic succession.
- Warm-socket dial (`WARM_LRU_SIZE=3`) stays separate from `k` — the two-dials law.

### 9.3 Chrome strip + exited state (the one pixel-governed region)

`chrome auto · host flex:1 1 auto; min-height:160px; min-width:0; overflow:hidden` (xterm scrolls internally). Chrome strip per T0-2: session identity (persona, provider), live/exited status pill, **exit chip “⌃`”**. Crop invariants freeze once approved (RULING A). Exited state replaces the canvas with read-only status + transcript link. A Content toolbar row sits above the strip — nearly empty in Phase 1; it is the reserved RULING-K seam so `[ Terminal | Chat ]` lands later without relayout. **Phase-1/GATE scope:** the session panel renders the T0-2 chrome in its designed exited/static state on fixtures; no real PTY until integration; the pool API is built and exercised with a stub instance so integration is a transport swap, not a rework.

---

## 10. The Facade seam — **DRAFT pending bridge consensus** (charter: `src/data/**` is bridge-owned; this section is the FE proposal to negotiate)

### 10.1 Shape of the seam

One agreed types file `src/data/seam.ts` (co-owned by ruling; bridge implements, FE consumes). Two levels:

1. **`Tm8Facade`** — imperative, promise-returning, contract-shaped (every DTO is imported from `@tm8/contract`; the seam invents no shapes).
2. **`FacadeHooks`** — the React consumption surface components actually use. The hook *signatures* live in the seam; the real implementation (WS-first cache, resume-by-seq, `events.poll` fallback per R2) is bridge machinery. FE ships a `FixtureFacade` + the trivial fixture hook binding (§10.6) so the gate never waits on the data layer.

```ts
interface Tm8Facade {
  // identity & spaces
  getIdentity(): Promise<IdentityView>;
  listSpaces(): Promise<SpaceSummary[]>;
  getSpaceSettings(spaceId): Promise<SpaceSettingsView>;   // carries MenuConfig + revision
  getHome(spaceId): Promise<HomeSnapshot>;
  getNavigation(spaceId): Promise<SpaceNavigation>;        // channel tree
  // entities
  getEntity(id): Promise<EntityDetail>;
  queryCollection(q: CollectionQuery): Promise<CollectionResult>;
  getChildren(id, q?): Promise<Page<EntitySummary>>;
  getConnections(id, q?: EntityConnectionsQuery): Promise<Page<EdgeView>>;
  getActivity(id, q?): Promise<Page<ActivityItem>>;
  search(q): Promise<PaletteSearchResult>;                 // palette entity jump
  // messages / discussion
  listMessages(anchorId, q?): Promise<Page<MessageView>>;
  postMessage(input: PostMessageInput): Promise<MessageBatchResult>;
  // inbox & read state
  listInbox(q?): Promise<Page<NotificationItem>>;
  markRead(ids): Promise<void>;
  // sessions & execution
  getLiveness(sessionIds: EntityId[]): Promise<LivenessView[]>;  // R3(b) server delta; see 10.5
  spawn(input: ExecutionSpawnInput): Promise<SpawnResult>;
  terminate(input: ExecutionTerminateInput): Promise<void>;
  // handoffs (row 8)
  sendHandoff(sessionId, input: SendHandoffInput): Promise<HandoffView>;
  listHandoffs(sessionId, q?: HandoffListQuery): Promise<Page<HandoffView>>;
  withdrawHandoff(handoffId, input: WithdrawHandoffInput): Promise<HandoffView>;
  // commands (uniform entity ops)
  createEntity / patchEntity / deleteEntity / moveEntity / react / addPoints /
  complete / work / pull / createEdge / patchEdge / deleteEdge / applyPlacement / undo;
  // menu
  updateMenu(spaceId, payload: MenuConfigPayload, expectedRevision): Promise<MenuConfig>;
  // presence (R8: designed-but-dormant — fixture-fed)
  getPresence(entityId): Promise<PresenceSnapshot>;
  // live updates (bridge: WS-first, resume-by-seq; fixture: local emitter)
  subscribe(spaceId, onEvent: (e: WorkspaceEvent) => void): Unsubscribe;
  // honesty
  availability(op: OperationName): Available | { unavailable: true; reason: string };
}
```

`FacadeHooks` (signatures negotiated with the same DTOs): `useEntity(id)`, `useCollection(query)`, `useMessages(anchorId)`, `useMenu(spaceId)`, `useHome(spaceId)`, `useInbox()`, `useHandoffs(sessionId)`, `useLiveness(ids)`, `usePresence(id)`, `useAvailability(op)` — each returning `{ data, state: 'loading'|'live'|'stale'|'error', error? }` so components can render honest staleness.

### 10.2 Conventions

- Every command carries a `clientMutationId` generated at the seam boundary; optimistic/reconciliation policy is **bridge-owned** (client cache reconciled by `clientMutationId` against `WorkspaceEvent`s); FE renders pending state only where DTOs carry it (`MessageView.pending`) or where the hook exposes `state`.
- Reads are typed-empty on unavailability, never fabricated; writes reject with typed errors (`limit_exceeded`/`invariant_violation` + `details.reason`) which ActionRefs translate to disabled-with-reason or NoticeHost messages.
- The UI never assumes the WS path is complete: the subscription surface is identical whether backed by WS, polling, or fixtures.

### 10.3 Availability — the honesty backbone

`availability(op)` powers L6 everywhere: palette discovery rows, drop targets, menu fallback, pin/action disabling. It is data from the bridge (server 501s, unmounted ops, Phase-2 gates), and its `reason` strings are user-facing copy.

### 10.4 Open questions for bridge consensus

1. Hook-layer ownership & the interim fixture hook binding (delete-at-integration marker).
2. `LivenessView` shape for the R3(b) session-liveness read — proposal: `{ sessionId, alive: boolean, lastSeenAt: IsoTimestamp | null }`; NEEDS-YOU stays UI-dormant (R8) with the predicate reading fixture-only data until a real carrier exists (logged; no contract invention).
3. Whether `subscribe` exposes raw `WorkspaceEvent`s (proposal above) or a digested invalidation stream — FE only needs invalidation + payloads for optimistic reconcile.
4. Error-shape surface: raw contract error codes vs a seam-level discriminated union.

### 10.5 Contract deltas this seam does NOT assume

R4: additive-only, server deltas minimal (R3). The seam consumes only cataloged ops + the two ruled deltas (mapper passthrough, liveness read). Anything else found missing during build → escalate to fe-coordinator → master; never invent.

### 10.6 Fixtures (`src/fixtures/`) — FE-owned

`FixtureFacade implements Tm8Facade` over an in-memory dataset; a seeded local emitter drives `subscribe` (scripted live-ness: a streaming session pulses, counters tick) so THE GATE demonstrates live behavior without a server.

**Dataset matrix (every row zod-validated against contract schemas in CI — fixtures cannot drift from the contract):**

| Axis | Coverage |
|---|---|
| Kinds | ≥1 of all 15 core kinds + one `c:incident` custom kind (proves the generic archetype lands free) |
| Content extremes | UUID-length titles everywhere floors are claimed; 32KB doc body; empty-everything entities |
| Hierarchy | task subtree ≥3 deep; session coordinator→worker tree with guide lines; channel tree for nav |
| Volume | ≥250 tasks (virtualization), 3 pinned-capable sessions + 5 live (pool/eviction demos) |
| Session honesty | running+streaming · running+idle · **stale (status=running, liveness dead → “stale — node restarted”)** · NEEDS YOU (dormant predicate) · exited (chrome fallback state) · spawning · failed |
| Handoffs | full legal `deliveryStatus × recordStatus` matrix incl. `unknown`, `refused`, `failed`, `withdrawn`, `sourceMissing: true` |
| Messages | thread w/ replies, `pending`, edited, deleted (tombstone), mentions, attachments; message whose parent channel is deleted (anchored-route tombstone banner) |
| Delivery facets | `DeliverySummary` rows across the `MessageDeliveryStatus` set (Phase-2 chat readiness; rendered nowhere in Phase 1) |
| Menu | shipped default + a custom config + a future-schemaVersion payload (fail-closed render) + revision-conflict script |
| Availability | script toggling `handoffs.*`/`spaces.menu.*` unavailable → every disabled-with-reason path demonstrable |
| Inbox/home/presence | mentions/assignment/reply/delivery-failure notifications, read state; HomeSnapshot with all three collections; viewers+typing |

---

## 11. State ownership (adapted from SPEC-FINAL §4.3)

| State | Owner | Persistence |
|---|---|---|
| space, view, slug+mode, origin, stack, pinned, per-panel tab, per-panel contentSurface, `q`, `session`, `msg` | **URL** (navStore mirrors) | shareable/reloadable |
| `activeSessionId`, focus, palette open, selection, drag state, chord state | uiStore | none — never URL |
| Terminal instances, offsets, decoder state, leases, parked set | TerminalPool | app lifetime |
| Terminal font/theme/cursor settings | transplanted settings store | localStorage (key shared with old app) |
| Side-panel kind selection (workspace) | sidePanelStore | localStorage per (viewer, space) |
| Theme choice | theme store | localStorage; `prefers-color-scheme` default |
| Menu config, read state, delivery, handoffs, presence, counters | **server** (via seam) | per contract |
| Entity/collection cache + optimistic journal | **bridge** (`src/data`) | reconciled by `clientMutationId` |
| Viewer per-session surface preference (Phase 2) | client | reserved localStorage key (member, workSession) |

---

## 12. Theme strategy

- `src/kit/tokens.css` is a **verbatim copy** of the design package's `05-DESIGN-SYSTEM/tokens.css` with a byte-equality CI test (keep `.cv2-root` scope + `[data-theme]` hooks; renaming breaks byte-equality for zero benefit).
- `ThemeProvider` stamps `data-theme="light|dark"` at the root; both themes are acceptance criteria for every screen from day one (gate screenshots ship in both).
- Theme control homes (D1): the account menu (T3-3) + a palette action. **No tab-bar ◐ toggle**, even though the T0-1 canvas still renders one — the amendment supersedes the pixels.
- ATELIER discipline: no new hues; status = color + word; warm shadows; motion tokens honor `prefers-reduced-motion`; the terminal canvas stays near-black in both themes (established contrast).

---

## 13. Accessibility (C8 — release criteria, not polish)

- **State**: text + color always (Pill = word inside the colored token; liveness/facets carry words).
- **Keyboard**: 100% operability via §7; roving tabindex in lists mirroring `j/k`; visible focus rings (`:focus-visible`); panel tab order header → actions → tabs → body.
- **Screen readers**: kit `IconBtn` makes `aria-label` a required prop (type error without it); four tabs are a real `tablist`; panels are labeled `region`s; NoticeHost is `aria-live=polite`; terminal host carries `aria-describedby` → the exit chip; parked container `aria-hidden` + `inert`.
- **Zoom/reflow**: floors (L4) + internal scroll containers make 200% zoom a layout state, not a break; breakpoint states (T1-3) are the same mechanism.
- **Motion**: reduced-motion kills pulse animations (live dot falls back to static + “streaming” word — status never conveyed by motion alone).
- Acceptance per screen: keyboard-only walkthrough + SR label audit + 200% zoom screenshot, alongside the visual diff.

---

## 14. Reuse map (module × provenance)

Sources: **(a)** extracted from a canvas · **(b)** harvested from `packages/ui` (SPEC-FINAL harvest list; condemn list binding) · **(c)** terminal-verbatim (R9) · **(d)** fresh.

Paths below are **verified against the tree this session** (2026-07-28), not copied from SPEC-FINAL — several of its citations had drifted. Orientation: `packages/ui/src/collab-v2/**` is the mock-era shell (nav store, kit, registry, thread subsystem); `packages/ui/src/real/**` is the maestro transplant (terminal stack, workspace data hooks, RealFacade). The old app keeps changing (it is the live oracle), so every harvest names its exact source path and is re-verified at harvest time.

| Module | Source | Detail |
|---|---|---|
| `kit/tokens.css` | (a) design package 05 | verbatim, byte-equality test (charter names `05-DESIGN-SYSTEM/tokens.css` ground truth; same lineage as the shipped `collab-v2/tokens.css`) |
| `kit/` Pill, Eyebrow, Chip, Card, IconBtn, Kbd, Avatar(provenance shape), Tile, Sheet, Popover, hairline discipline | (a) T0-1 + T0-3/T0-4 | markup/CSS extracted from canvases; ATELIER §5 conventions; the old `collab-v2/kit/` (Pill, Eyebrow, IconBtn, Kbd, Avatar, Popover, listKeyNav) is the naming/behavior reference, canvases win on pixels |
| `kit/VirtualList` | (b) | `collab-v2/subsystems/thread/VirtualList.tsx` (187 LOC generic `VirtualList<T>` engine; logic-only harvest) |
| `domain/` registry + ListConfig + PanelConfig data | (d) | shapes from SPEC-FINAL §4.5; content authored fresh from WLT §2.1/§3; old `collab-v2/registry/KindRegistry.tsx` (11-kind KindEntry data) is reference only, superseded by the 15-kind contract set |
| `routes/` codec, normalizer, redirects | (d) | **fresh** per L8 |
| `routes/transport` | (b) | `collab-v2/shell/router.ts` — ONLY `createBrowserTarget`/`createMemoryTarget`/`startRouter`; `buildHash` in the same file is condemned |
| `stores/navStore` | (d), semantics (b) | fresh code; `collab-v2/stores/nav.ts` (228 LOC, MAX_PINNED=3, p/pin/t codec) is the behavioral oracle |
| `keyboard/` | (d) | contract from WLT §5.8 |
| `shell/SpaceTabBar` | (a) T0-1 | minus the ◐ toggle (D1) |
| `shell/MenuRail` | (a) T1-1 | renderer is fresh (menu-as-data); old menu chrome superseded (RULING H) |
| `shell/CommandPalette` | (a) T1-2 | disabled discovery rows per R7 |
| `shell/NoticeHost` | (a) T1-4 honesty vocabulary | fresh component |
| `panels/EntityListPanel` | (a) T0-3 + (b) logic | harvested *logic* from `real/workspace/useTasks.ts` (tree building), `real/workspace/useSessions.ts` (liveness predicate), `real/workspace/queries.ts`, TaskPanel/ResourcePanel section+filter semantics — re-homed into ListConfig fields; **markup NOT harvested** |
| `panels/EntityDetailPanel` | (a) T0-4 | anatomy per 02-LAYOUT §3; `collab-v2/entity/EntityPanel.tsx` (427 LOC, four fixed tabs) is the behavioral oracle, markup fresh from canvas |
| `panels/bodies/{subtree,reader,hub,profile,generic}` | (a) T0-4, T5-2, T5-3, T5-7, T10 | archetype bodies extracted from their canvases |
| `panels/bodies/terminal` chrome strip + exited state | (a) T0-2 | the pixel-governed region (crop invariants at approval) |
| `collections/` six layouts + switcher + board axis picker | (a) T0-3, T5-2 (canonical per D4) | Graph = disabled-with-reason stub (R7) |
| `views/HomeView` | (a) T5-1 | over frozen `HomeSnapshot` |
| `views/Inbox/Files/Node` | (a) T3 | fan-out phase |
| `views/Settings*` | (a) T2 | fan-out phase |
| account menu | (a) T3-3 | theme home |
| `terminal/transplant/*` + `@maestro/pty-protocol` | **(c)** | verbatim from `real/terminal/{ptyTransport,visibilityDriver,writeScheduler,runtime,terminalSize,useTerminalSettingsStore}.ts` + `packages/pty-protocol` (exists, golden-frames test present: `test/goldenFrames.test.ts` + `golden-frames.json`); `real/SessionTerminal.tsx` (512 LOC) is **split**, not extracted — its transport/fit/teardown logic feeds the pool's `TerminalInstance`, its React shell dies with the old app |
| `terminal/pool` | (d) implementing WLT §5.2a | mounting adaptation allowed by R9; maestro TeamView reparent conventions |
| spawn/Run flow | (b) | `real/workspace/runTask.ts` (direct-spawn), consumed via an ActionRef |
| `fixtures/` | (d) | contract-shaped, §10.6 |
| `data/` | bridge-owned | not this LLD's to design; seam per §10 (`real/RealFacade.ts` 539 LOC, `real/capabilities.ts`, `real/workspace/usePolledCollection.ts` are the bridge's harvest candidates — listed for orientation only) |

**Condemned — never harvested, imported, or “adapted from” (SPEC-FINAL C-7/§3.4; binding):** `collab-v2/shell/router.ts:buildHash` (channel-route asymmetry); `real/workspace/TaskPanel.tsx` / `ResourcePanel.tsx` markup; `real/workspace/CenterPane.tsx` mounted-LRU (its `MOUNTED_TERMINAL_LRU_SIZE = 4` dial included — the pool floor is 5); the stale `tm8Kinds` session-panel copy; hard-coded menu chrome; the retired whole-window pixel oracle. A CI grep-test keeps these imports impossible (§15).

---

## 15. Test & acceptance strategy

Culture (charter): *a screenshot diffed against a reference, or it isn't done* — type-checks and jsdom prove nothing about layout.

1. **Registry exhaustiveness**: a row per `CoreEntityKindSchema` member; every WLT §3 survival behavior ↔ ListConfig field matrix; every archetype assigned; every menu-eligible kind has an icon.
2. **No-branching law**: CI grep — `kind ===`/kind string literals outside `domain//fixtures/` fail the build. Same mechanism forbids condemned imports and `minmax(0,`.
3. **Codec property tests**: round-trip, 2048 cap, ordered atomic drops, unknown-`q`-version discard, redirect table, `normalize` idempotence.
4. **Panel-engine unit tests**: C_min table, admission refusal reasons, demotion loop convergence (incl. empty-stack V-constant step and the sub-320 stop state), Esc/pin/promote-removes-from-both, hydration dedup pin>stack.
5. **Keyboard**: one unit test per binding row; chord window; text-entry deadness; browser tests for terminal ownership + blur chord (zero PTY bytes, exact focus landing).
6. **Fixture validation**: every fixture parses through the contract Zod schemas (drift = red).
7. **Pool tests** (WLT §5.2a/c list, verbatim): identity across tab flips, StrictMode double-mount, eviction-while-parked, 4-visible+open-5th, runtime `k` lowering, activation succession — run against the stub instance in Phase 1, re-run at integration.
8. **Browser/layout acceptance**: real-browser measurement at each breakpoint with worst-case content; THE GATE = complete T0-1 screen interactive on fixtures, light+dark, screenshot side-by-side with the canvas + enumerated diff (R5).
9. **A11y acceptance** per §13.

---

## 16. Process

- **Decisions ledger (R11):** every ambiguity call goes to `DECISIONS.md` — append-only, numbered, dated, source + rationale; user reviews at THE GATE. Already binding: D1 (no tab-bar theme toggle), D2 (board axis picker in scope), D3 (four tabs always), D4 (canonical canvases). Calls this LLD knowingly leaves to build time (each will be a D-entry when made): `g`-chord window duration; virtualization threshold value; side-panel default widths within spec ranges; exact disabled-reason copy strings.
- **Round-2 verdicts** are folded (D1–D4). Any further review flags land as ledger entries.
- **Phasing** (FE brief): Phase 1 (A0) = tokens+kit+fixtures+scaffold, parallel to this LLD's review. Phase 2 (A1) = primitives + shell → THE GATE, then STOP for user review. Phase 3 (A2) = per-screen fan-out. This LLD covers the architecture for all three; fan-out screens reuse the spine without new mechanisms.
- **Known open items inherited from SPEC-FINAL §4.15** and tracked, not resolved here: O-2 servers-rail hidden (recommended S=0), O-4 reference capture at shell-skeleton milestone, O-5 virtualization threshold confirmation.

*End. Reviewer: attack §2 (branching), §6 (condemned code), §10 (seam leaks), §5/§12–13 (floors, honesty, a11y) first — those are the failure classes that killed the last three attempts.*
