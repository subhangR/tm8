# 03 — Design Language: "ATELIER" (paper & ink)

The existing token system the design must work inside. Values transcribed from the shipped stylesheet (`packages/ui/src/collab-v2/tokens.css`). Historically important: **maestro (the visual ancestor app) and tm8 share this exact token system** — same warm-paper palette, same type scale, same spacing/radii — so the maestro reference screenshots are on-palette references, not a different brand.

**Character:** editorial paper-and-ink. Warm off-whites, one restrained brass accent, serif display type over a grotesk UI face, mono for micro-labels and code. Desaturated anti-neon status colors. Warm shadows, no glow. Fast mechanical motion, no bounce. A calm instrument, not a dashboard.

**Two standing rules baked into the system:**
- Status is ALWAYS color + word, never color alone.
- Dark theme is the same system inverted into warm graphite — every design must work in both.

---

## 1. Palette — light

| Token | Value | Use |
|---|---|---|
| paper | `#F4F2EC` | app background |
| surface | `#FBFAF6` | panels, rails |
| card | `#FFFFFF` | cards, elevated tiles |
| hover / active | `#F2EFE8` / `#ECE8DF` | interactive fills |
| line / line-2 | `#E7E3D9` / `#D8D3C6` | hairlines, stronger borders |
| ink | `#23201B` | primary text |
| ink-2 / ink-3 / ink-4 | `#5B564C` / `#8E897B` / `#B7B2A4` | body / secondary / disabled text |
| **brand (brass)** | `#B26A2B` (dark variant `#9A581F`; soft fill `rgba(178,106,43,.11)`) | the one accent: active markers, links, code accents |

### Status ramp (desaturated, each with a `-soft` fill)

| Token | Light | Meaning |
|---|---|---|
| run | `#3E8E5A` | working / done / live |
| wait | `#BD8A2A` | stale / waiting |
| block | `#BB4D3D` | blocked / failed |
| info | `#3F6C90` | in review / informational |
| idle | `#A29C8E` | open / idle (warm grey) |

Semantic mapping: working=run · done=run · blocked=block · in_review=info · stale=wait · open/idle=idle.

## 2. Palette — dark (warm graphite)

paper `#15130E` · surface `#1B1810` · card `#221E15` · hover `#262117` · active `#302A1D` · line `#2C2719`/`#3B3524` · ink `#EFE9DB` · ink-2 `#BDB5A2` · ink-3 `#8C8470` · ink-4 `#665E4C` · brand `#E0A45A` (brand-2 `#C98A3E`) · run `#5CB381` · wait `#D9AA49` · block `#DA7D6A` · info `#6F9FC7` · idle `#7A7360`. Shadows go deeper black; everything else is the same system.

Note: the terminal canvas is near-black in BOTH themes (it is a transplanted component with its own dark surface) — the workspace center reads dark even on light paper. This contrast is intentional and established.

## 3. Type

| Family | Stack | Role |
|---|---|---|
| Serif | Newsreader (Georgia fallback) | display + H1 only — the editorial voice |
| UI | Hanken Grotesk (system-ui fallback) | everything interactive, H2 down |
| Mono | JetBrains Mono | eyebrows (uppercase micro-labels), code, IDs, terminal-adjacent chrome |

Scale: display 40 · h1 28 · h2 22 · h3 18 · title 15 · body 14 · sm 13 · label 12 · micro 11 · mono 12.5 (px). Line heights: tight 1.18 · snug 1.35 · body 1.5. Tracking: mega +0.12em (eyebrows) · label +0.06em · tight −0.01em (headings).

Semantic classes already exist: `t-display, t-h1, t-h2, t-h3, t-title, t-body, t-secondary, t-label, t-eyebrow, t-quote, t-mono, t-code` — reuse these roles rather than inventing new text styles.

## 4. Spacing, radii, elevation, motion

- **Spacing:** strict 4px grid — 4, 8, 12, 16, 20, 24, 32, 40, 48, 64.
- **Radii:** xs 5 · sm 7 · md 10 · lg 14 · pill 999 (px).
- **Elevation (warm, never glowing):** sm `0 1px 2px rgba(40,34,24,.05)` · md `0 2px 6px … + 0 8px 24px …` · pop `0 12px 34px rgba(40,34,24,.14)`.
- **Motion:** ease-out `cubic-bezier(.16,1,.3,1)`, standard `cubic-bezier(.4,0,.2,1)`; durations fast 120ms · base 180ms · slow 280ms. No bounce, no spring. Honor `prefers-reduced-motion`.

## 5. Component conventions already established (keep them)

- **Pill** — status token: soft fill + colored word, optional live-pulse dot for streaming.
- **Avatar shape = provenance:** humans round, agents rounded-square. Never rely on shape alone — provenance also appears as text/chip.
- **Eyebrow** — uppercase mono micro-label heading small sections.
- **Chip (Z1)** — kind glyph + name + state tint; hover shows a Z2 card preview; draggable.
- **Card (Z2)** — chip + 2–4 kind-specific summary fields + universal footer (reactions, points, message count, key edge chips, actor avatars).
- **IconBtn** — square icon button, always labeled for screen readers.
- **Hairline discipline:** 1px `line` borders separate regions; no heavy dividers.
- **The `pn-` chrome layer** (from maestro, same tokens): top bar 42px; icon-rail buttons 40×40 with a 3px brass active bar; small mono badges. If a chrome value is needed, it exists in this layer — measure, don't invent.

## 6. What the designer may and may not change

**May:** compose new surfaces from these tokens; introduce new component variants (tile types, banners, sheets) on the existing ramps; extend the status vocabulary with new *combinations* of existing colors + words; design the dark-theme rendering of anything new.

**May not:** introduce new hues outside the brass + status ramp; use color as the only carrier of state; break the 4px grid or the radii set; add glow/neon/bounce; restyle the terminal canvas interior; make agents visually second-class (they are peers with provenance).
