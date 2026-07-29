# 02 — Layout Spec

The geometry, with the numbers spelled out. Every shrinkable region states a floor — this app has been broken three separate times by flex/grid tracks with zero minimums, so floors are law, not preference.

---

## 1. Shell regions

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ SPACE TAB BAR                                                    height 42px │
├──────────┬───────────────────────────────────────────────────────────────────┤
│          │                                                                   │
│  MENU    │                     VIEW HOST                                     │
│  RAIL    │            (the current view renders here)                        │
│          │                                                                   │
│ 220px    │                                                                   │
│ or 48px  │                                                                   │
│          │                                                                   │
└──────────┴───────────────────────────────────────────────────────────────────┘
```

| Region | Width | Notes |
|---|---|---|
| Server rail | **0 in Phase 1** (recommended; a 48px rail is the Phase-2 slot) | One implicit local server ⇒ no rail. |
| Space tab bar | full width, ~42px tall | Space switcher; the product mark lives here. |
| Menu rail | **discrete two-state: 220px expanded ⇄ 48px collapsed** (never continuously shrinkable) | Collapsed state shows icons only — every menu ref (view AND kind) needs an icon. Toggle: ⌘\ and a visible control. |
| View host | remaining width | |

## 2. The Workspace view (the core)

```
┌───────────────┬──────────────────────────────────────────────┬───────────────┐
│               │ ● forge — 3 live                    (roster) │               │
│  EntityList   ├──────────────────────────────────────────────┤  EntityList   │
│  Panel        │ ┌─ pinned 1 ──┐ ┌─ pinned 2 ──┐ ┌─ stack ──┐ │  Panel        │
│  (left)       │ │ Entity      │ │ Entity      │ │ Entity   │ │  (right)      │
│               │ │ Detail      │ │ Detail      │ │ Detail   │ │               │
│  default:     │ │ Panel       │ │ Panel       │ │ Panel    │ │  default:     │
│  Tasks        │ │             │ │             │ │ (top of  │ │  Sessions     │
│               │ │             │ │             │ │  stack)  │ │               │
│               │ └─────────────┘ └─────────────┘ └──────────┘ │               │
└───────────────┴──────────────────────────────────────────────┴───────────────┘
```

Grid: `left  minmax(200px, 280px default)  ·  8px gap  ·  center minmax(C_min, 1fr)  ·  8px gap  ·  right minmax(220px, 319px default)`. Side panels are user-resizable down to their floors; resize handles live in the 8px gaps.

### 2.1 Center columns

- Visible center columns = pinned panels (left→right in pin order) + the top of the panel stack (rightmost column).
- Max **3 pinned**; each column `flex: 1 1 0`, **minimum 320px**; 8px between columns.
- **Esc** closes the stacked (rightmost) panel only, never a pin. Pins are dismissed explicitly.
- **C_min** — the minimum center width, where `V` = number of visible columns:

  `C_min = max(320, V·320 + (V−1)·8)`

  | V | meaning | C_min |
  |---|---|---|
  | 0 | empty center | 320px (floor keeps the empty state usable) |
  | 1 | stack only, or 1 pin | 320px |
  | 2 | 1 pin + stack | 648px |
  | 3 | 2 pins + stack | 976px |
  | 4 | 3 pins + stack | 1304px |

- Pinning is **refused** (disabled-with-reason on the pin control) when the center is too narrow for the resulting V or 3 pins already exist.
- When the window shrinks below the current C_min, the **oldest pin automatically demotes** onto the stack (repeatedly until it fits). Widening never auto-restores — the user re-pins.

### 2.2 Empty center

```
│ ● no focused session — 3 live                                │
│                                                              │
│        LIVE SESSIONS                                         │
│        ●  forge   running · task T-101 · claude              │
│        ●  scout   NEEDS YOU · task T-114                     │
│        ○  echo    exited 12m ago                             │
│                                                              │
│        Click any task or session to open it here.            │
│        Esc closes · p pins · / opens the palette             │
```

The empty state doubles as the live-session roster and teaches the grammar.

### 2.3 The live-session bar

Fixed top row of the center, always present in the workspace view: `● {focused session name} — N live`. The dot pulses when the focused session is streaming. Clicking the name raises that session; clicking "N live" opens the roster. Height: one compact row (~28–32px); designer's call within that.

## 3. The Entity Detail Panel (Z3) — anatomy

Fixed anatomy for every kind; per-kind variation happens inside Content and via which affordances are enabled.

```
┌────────────────────────────────────────────────┐
│ ‹breadcrumb›  ◈ Title (inline-editable)        │  header: kind glyph, status pill,
│                     [status ▾]   ⋯  📌  ⤢  ✕  │  overflow, pin, promote, close
├────────────────────────────────────────────────┤
│ 👍 👎 ⭐ · +points · Link · Add child · Pull    │  action bar (+ kind primaries,
│                                    · Run ▸     │  e.g. task: Run / Coordinate)
├────────────────────────────────────────────────┤
│  Content │ Discussion │ Connections │ Activity │  four tabs, fixed order
├────────────────────────────────────────────────┤
│                                                │
│              (active tab body)                 │
│                                                │
├────────────────────────────────────────────────┤
│ 👁 2 viewing · by @ada · v3 · active 2m ago    │  footer
└────────────────────────────────────────────────┘
```

### 3.1 work_session Content (the terminal panel)

```
├────────────────────────────────────────────────┤
│ (content toolbar — Phase 1 nearly empty;       │  ← reserved seam for the Phase-2
│  Phase 2 adds [ Terminal | Chat ] here)        │    surface switch; no relayout later
├────────────────────────────────────────────────┤
│ ◈ forge · claude · ● running   [exit ⌃`]       │  ← TERMINAL CHROME STRIP — design this;
├────────────────────────────────────────────────┤    becomes pixel-frozen once approved
│ ██████████████████████████████████████████████ │
│ ██  xterm canvas — VERBATIM TRANSPLANT      ██ │  ← black box; dark full-bleed;
│ ██  (do not design inside)                  ██ │    min-height 160px; scrolls internally
│ ██████████████████████████████████████████████ │
```

Exited state replaces the canvas with a read-only fallback: status + transcript link.

## 4. Non-workspace views: the right-edge panel stack

On Entity Views (`k/…`), channels, Home, etc., the same detail panels open as a **peek stack from the right edge** (~440px wide) over the view; pinning docks a panel as a persistent split column (min 320px). Same anatomy, same max-3-pins, same Esc behavior. The workspace view is the only place panels are the *center* rather than an overlay.

```
┌──────┬───────────────────────────────────────────────┬───────────────┐
│ MENU │  CollectionView                               │ ┌───────────┐ │
│      │  [List|Board|Tree|Feed|Gallery|Graph] [Group] │ │ Entity    │ │
│      │  ┌────┐ ┌────┐ ┌────┐ ┌────┐                  │ │ Detail    │ │
│      │  │card│ │card│ │card│ │card│  …                │ │ (peek,    │ │
│      │  └────┘ └────┘ └────┘ └────┘                  │ │  ~440px)  │ │
└──────┴───────────────────────────────────────────────┴─┴───────────┴─┘
```

## 5. Responsive states

Breakpoints are *derived* from the track floors (final numbers are measured in-browser at build time; the arithmetic below shows the shape). With menu expanded (220) and V=1: full 3-panel needs ≈ `220 + 200 + 8 + 320 + 8 + 220 ≈ 976px` + borders/scrollbars. Shrink order: **menu collapses (220→48) → side panels shrink to floors → pins auto-demote → center bottoms at 320 → panels stack**.

### 5.1 Right-stacked (below the full 3-panel minimum)

```
┌──────┬──────────────┬──────────────────────────────────┐
│ MENU │  left panel  │  center (bar + columns)          │
│ (48) │              │                                  │
│      │              ├──────────────────────────────────┤
│      │              │  right panel (stacked below,     │
│      │              │  collapsible row)                │
└──────┴──────────────┴──────────────────────────────────┘
```

### 5.2 Both-stacked

```
┌──────┬─────────────────────────────────────────────────┐
│ MENU │  center (bar + single column)                   │
│ (48) │                                                 │
│      ├─────────────────────────────────────────────────┤
│      │  left panel row (collapsible)                   │
│      ├─────────────────────────────────────────────────┤
│      │  right panel row (collapsible)                  │
└──────┴─────────────────────────────────────────────────┘
```

### 5.3 Full-width sheets (narrowest; below ≈ 48 + 320 + chrome)

Side panels and detail panels become full-width sheets sliding over a single-column center; one sheet at a time; Esc/back dismisses.

```
┌─────────────────────────────┐
│ ☰  ● forge — 3 live         │
├─────────────────────────────┤
│                             │
│   center column (full)      │
│                             │
│  ┌───────────────────────┐  │
│  │  sheet: Entity Detail │  │
│  │  (full width, slides  │  │
│  │   up over center)     │  │
│  └───────────────────────┘  │
└─────────────────────────────┘
```

**The stacked and sheet modes have equations but no design anywhere — they are Tier 1 design work** (see worklist).

## 6. Floors, restated as law

Every shrinkable track has a stated minimum: menu 48, left 200, center 320 (or C_min), right 220, any panel column 320, terminal host height 160. `minmax(0, …)` and unfloored `overflow:hidden` flex items are forbidden — they are the specific bug that crushed titles to 0px three times in this app's history. Worst-case content (UUID-length titles) must survive every state.
