# Chat waiting marks — what a browser proved, and how

The figure-8 replaces two waits in Chat Home: the send button's spinner while a
turn runs, and the transcript's dots while a turn is pending or a conversation
is being read. Every number below came out of a real Chrome; `vitest` cannot
see any of them, because jsdom loads no stylesheets and rasterizes nothing.

Harness: `packages/tm8-ui/chat-dev.html` (gate-free, fixture port, drives itself
into the streaming state by typing and clicking, not by faking a phase).
Driver: raw CDP over Node's global `WebSocket`, zero dependencies —

```
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new \
  --remote-debugging-port=9223 --user-data-dir=<scratch> --no-first-run --disable-gpu about:blank
npx vite --port 5233 --strictPort      # then GET /json, pick type==='page', open the ws
```

A/B against the pre-change base by `git show 73ded18f:<path> > <path>`, letting vite
HMR pick it up, re-running, then restoring from a copy taken first.

**Re-run after rebasing onto the wordmark commit `fe520f2a`**, which changed
`RibbonMark` itself by adding `layout` and `animated` — evidence taken before it
would have been evidence about a different component. Every geometry number
below came back byte-identical and the captures here were retaken on the rebased
tree, so they show the state actually being committed.

`fe520f2a` then reached `main` as merge `d76b0c90`, whose tree is byte-identical
to it repo-wide (`git diff fe520f2a origin/main` is empty), so this branch's
final rebase onto `main` did not move the component again and these numbers
still describe it.

The chat mounts take `layout="mark"` (the default), so the wordmark's tighter
360x520 box and shallower 8° tilt do not reach them; and they take `animated`'s
default of `true`, which is right because both are transient waits — the
`animated={false}` case is for a mark that sits on screen indefinitely, like the
brand line.

---

## 1. The composer keeps its footprint

`.tch-send--working`'s own comment promises "same footprint". It holds, so
nothing in the composer moves at the moment a turn starts.

| | before (73ded18f) | after |
|---|---|---|
| send button `offsetHeight` | 28 | **28** |
| `.ri-card__foot` height | 56.11 | **56.11** |
| `.tch-composer-wrap` height | 121.91 | **121.91** |
| send button width | 68.16 | 64.16 |

The 4px of width is the old spinner's border coming off: `.tch-spin` was a 10px
box plus a 2px border on each side, and this package has no `border-box` reset,
so it occupied 14px. The mark's slot is 10px and the ribbon overflows it
visibly. Height — the dimension the promise is about — does not move.

The transcript's wait row does grow, 33.59 → 37.39, because an 18px mark is
taller than a 4px dot. It is a transient row at the end of a scroll container,
so nothing above it moves.

## 2. It is not clipped

The mark paints outside its own box on purpose, which is one `overflow: hidden`
ancestor away from being silently sliced — and a sliced mark has the same DOM,
the same polygon count and the same passing test as a whole one.

Measured the painted extent of the polygons against every clipping ancestor
(`.tch-transcript` auto, `.tch-root` hidden, `body` hidden). Worst cut on either
mark, on all four sides: **0px**. Nearest approach is 17px.

## 3. The ink — the one thing that was wrong, and how it was caught

The send button is FILLED with brand, so the mark's default ink would be its own
background. The obvious fix is the button's foreground, `--pn-card`. That is a
trap, and only counting fills found it.

`shade()` posterizes AROUND the base ink — down toward black for the unlit half
of the band, up toward white for the lit half. `--pn-card` is `#FFFFFF` in the
light theme. There is nowhere above white, so that entire half of the ramp
flattens into one wall, and the band stops reading as a surface.

### Measured across the loop, not at one frame

The first version of this section quoted single-frame counts, and they drifted
between runs. That was a methodology error, not noise to be averaged away:
`shade` rides the flow and rotation terms, so **every frame has a different fill
count** and one reading is a draw from a distribution rather than a property of
the ink. Corrected by sweeping the whole 2s loop — 9 samples at 250ms, on the
real mount, with the ink forced by injecting the CSS override *before* the mark
mounts (the component reads its token once, on mount).

Distinct fills, send mark (44 quads) and wait mark (60):

| light | samples across the loop | min–max |
|---|---|---|
| `--pn-paper` (ships) | 26 31 33 27 27 29 30 26 26 | **26–33** |
| `--pn-card` (the trap) | 11 13 13 13 11 10 19 12 11 | **10–19** |
| `--pn-brand` (wait mark, 60 quads) | 54 53 53 48 52 53 50 53 56 | 48–56 |

| dark | samples across the loop | min–max |
|---|---|---|
| `--pn-paper` (ships) | 41 39 36 38 41 41 35 39 41 | **35–41** |
| `--pn-card` | 43 38 38 37 39 43 35 38 42 | **35–43** |
| `--pn-brand` (wait mark, 60 quads) | 55 53 55 45 50 51 52 49 50 | 45–55 |

**Roughly 2× in light.** Per-phase paper:card ratio ran 2.36 2.38 2.54 2.08 2.45
2.90 1.58 2.17 2.36 — so the ratio is itself phase-dependent and should not be
quoted as one figure either. "About double, at every phase" is the honest claim;
the earlier "two-to-three-fold" overstated the floor.

**The difference is LIGHT-THEME-ONLY, which the earlier table got wrong.** In
dark, `--pn-card` is `#221E15` and `--pn-paper` is `#1D1912` — both near-black,
both with the same headroom, and they measure the same (ratio 0.95–1.05). An
earlier draft of this doc reported dark card at 18 against paper at 41; that 18
came from a *synthetic* sweep over invented `k` values and was printed in the
same table as live readings, which is the error that made it look like a
finding. Live, there is no dark-theme difference at all.

That does not change the decision. One token has to serve both grounds, and in
the ground where they differ, card is the broken one.

### Contrast

Mean-colour contrast against the button ground: **4.56 : 1** light, **2.34 : 1**
dark. Derived rather than directly sampled — computed in-page from the
live-resolved ink and the live-resolved ground, over the shading ramp, not read
off rendered pixels. Good enough to choose between inks, which is what it was
for; not a substitute for a pixel-level audit.

**Do not simplify `--pn-ribbon-ink` back to `--pn-card`.** It looks more correct
— it is literally the button's text colour — and in the light theme it is
measurably worse.

### Why the two themes behave differently — the mechanism

The empirical result above ("card is broken in light, identical in dark") has a
cause, and it predicts rather than merely reports. `shade` walks **0.78 of the
way toward black** for the unlit half and **0.58 of the way toward white** for
the lit half. Those are different distances, so where the base ink sits decides
whether *both halves of the ramp still vary*.

Sampled densely (401 values of `k`), counting distinct colours produced by each
half:

| base ink | unlit half | lit half | total | luminance span |
|---|---|---|---|---|
| `--pn-card` light `#FFFFFF` | 199 | **1** | 200 | 199 |
| `--pn-paper` light `#F4F2EC` | 200 | 25 | 225 | 196 |
| `--pn-card` dark `#221E15` | 60 | 192 | 252 | 154 |
| `--pn-paper` dark `#1D1912` | 51 | 193 | 244 | 153 |
| `--pn-brand` (the wait mark) | 169 | 166 | **335** | 171 |

**The lit half of a white-inked mark has exactly one colour.** Not "compressed"
— one. That is the defect, stated exactly.

Note what this is *not*: it is not total range. White has the WIDEST luminance
span of any ink here (199), and is still the worst, because the whole span lives
in one half. What matters is that both halves vary, which is why the balanced
ink — brass, at 169/166 — produces the most fills of all and why the wait mark
looks richest. "Pick a mid-tone" was the right instinct; this is why.

It also explains the two regimes. In light, both candidates sit against the
white ceiling, so the 11 points between them is nearly the entire difference and
dominates. In dark, both sit near black with the whole upward range available, so
11 points buys nothing. Same mechanism, opposite regimes — and it accounts for
the otherwise odd fact that `--pn-card` alone measures ~3× more fills in dark
than in light (live: 10–19 vs 35–43) off nothing but its ground.

### "Exactly one" is a theorem, not a measurement

The lit branch is `c + (255 - c) * f`. At `c = 255` that is `255` for every `f`,
in all three channels, identically. So a white-inked mark's lit half is a single
colour **by construction** — it does not depend on sample density, on the loop,
or on how anyone measures it. Black is the mirror, via the unlit branch.

That matters for the warning's durability: someone who re-measures and gets a
different number has not refuted anything, because this half of the claim is
arithmetic rather than data.

### Two independent failure modes — and why "avoid rails" and "pick a mid-tone" are both wrong

Reviewing this produced a tempting generalisation — *white fails because its
channels are railed, so avoid railed channels* — which its own test refuted.
Recorded here so nobody re-derives it:

| ink | railed channels | channels in lockstep | unlit / lit | total |
|---|---|---|---|---|
| `#FF0000` pure red | 3 | no | 199 / 148 | **347** |
| `#B26A2B` brand | 0 | no | 169 / 166 | 335 |
| `#1D1912` paper dark | 0 | no | 51 / 193 | 244 |
| `#F4F2EC` paper light | 0 | no | 200 / 25 | 225 |
| `#808080` mid grey | 0 | **yes** | 100 / 74 | **174** |
| `#000000` black | 3 | yes | 1 / 148 | 148 |
| `#FFFFFF` white | 3 | yes | 199 / **1** | 200 |

Pure red has three railed channels and scores *higher* than brass. Mid grey has
none and scores *lower*. So rails are not the predictor. There are two separate
ways to lose:

1. **Rail collapse** — channels pinned at a rail freeze in one direction. Fatal
   only when they *all* rail the *same* way: white (all top → dead lit half),
   black (all bottom → dead unlit half). Red rails three channels and survives,
   because R falls while G and B are pinned, then G and B rise while R is
   pinned.
2. **Lockstep** — an achromatic ink moves all three channels in unison, so the
   colour count collapses to one channel's travel. Grey is a textbook mid-tone
   and still scores below every chromatic ink here.

Brass avoids both. Neither "avoid saturated channels" nor "pick a mid-tone" is
the rule on its own — grey is a mid-tone and it is worse than brass. **Both
halves must stay live** remains the statement, and it does not simplify further.

### What this metric does and does not measure

Distinct-fill count measures **articulation, not quality**. Pure red scores the
highest of anything tried here and would look terrible on this button. The
metric is sound for the job it did — detecting a *collapsed* band, where half
the ramp is provably one colour — and it must not be read as a ranking among
inks that all pass. Brass topping the list is a happy confirmation of the design
choice, not the reason it is right.

### Reconciling two independent measurements

Review replicated the geometry and shading standalone (same constants, no DOM)
and swept the loop the same way. The two agree closely on absolute counts, which
is the useful part — a live read through `getComputedStyle` and a from-scratch
replication landing in the same place means neither is measuring an artefact:

| | replication | live (this doc) |
|---|---|---|
| card, light | 12–18 | 10–19 |
| paper, light | 26–32 | 26–33 |
| brand, wait mark | 49–53 | 48–56 |
| per-phase ratio | 1.78–2.25 | 1.58–2.90 |

They diverge on the **ratio spread**, and the live one is wider. Both are 9
samples of a continuous loop at different phases, so neither range is the true
envelope — which is the argument for quoting "about double" and a method rather
than any min–max at all. The replication could not see the dark-theme result
above, because it did not resolve tokens per theme.

### The dark-theme contrast is below 3:1, deliberately

2.34:1 on the dark ground is under the 3:1 that WCAG 1.4.11 asks of graphical
objects. This is a considered exemption, not a miss:

- The mark is **decorative and `aria-hidden`**. The button's meaning is carried
  by the word beside it (`Stop` / `Working`) and by its `aria-label`; 1.4.11
  applies to graphics *required to understand the content*, and nothing here is.
  Removing the mark entirely would lose no information.
- Every alternative is worse on this specific ground. The button is filled with
  `--pn-brand-2`, so brand ink is invisible against it, and pushing the ink
  further from the ground to buy contrast walks straight back into the flat-ramp
  problem above — the inks that score best on contrast are exactly the ones with
  no headroom left to shade into.
- The mark DOES read flatter on the dark button than the brass wait mark does on
  paper. Note the ink there is `#1D1912`, near-black — dark theme puts a dark
  mark on a light brass button, the inverse of the light theme's arrangement,
  and matches what the word `Stop` does beside it. The flatness is inherent to
  a filled-brand ground, not a defect in the port, and it is the price of the
  mark reading as one object with its label.

If a future change makes this mark meaning-bearing — carrying state the words do
not — this exemption stops applying and the ink has to be revisited.

## 4. Cost — the worry the boot lane handed down, answered

Boot mounts one mark for under a second. A chat turn mounts two, for minutes.
240 frames sampled with both mounted and turning:

| | before | after |
|---|---|---|
| median frame | 8.3ms | **8.3ms** |
| p95 | 9.3ms | 9.2ms |
| worst | 9.4ms | 9.3ms |
| fps | 120.5 | **120.5** |

Unmeasurable at this scale — the marks are not what this page spends its frame
on. The segment budgets (60 in the transcript, 44 in the button, against 150 at
boot) are therefore not a performance rescue; they are there because 150 quads
across an 11px mark is a third of a pixel each, under the sampling grid, so the
extra quads can only be paid for and never seen.

The mark is genuinely turning, not a dead still: **6 distinct frames over 6
samples** on both.

## 5. Reduced motion

`RibbonMark` checks the query in JS and never subscribes to the frame clock, so
the mark holds its rest pose rather than freezing mid-loop. Confirmed under
emulated `prefers-reduced-motion: reduce`: **1 distinct frame over 6 samples**,
with `pnPulse` as the activity signal — the same treatment boot uses.

## 6. A defect found on the way, and fixed

`.tch-thinking` was two things: the wait row, and the collapsible **Thinking**
disclosure inside a turn (`TurnParts.tsx`). The wait row's rule put
`display: flex; align-items: center` on the shared name, which the `<details>`
inherited. Closed it looked fine, which is why it shipped. Open, its summary and
its body sat SIDE BY SIDE, with the body squeezed to 318px of an 807px column.

| | before | after |
|---|---|---|
| `<details>` display | `flex` | `block` |
| body origin | x 474.3, y 500.8 (beside) | x 404.6, y 506 (below) |
| body width | 317.9 | 807.4 |

`chat-ribbon-before-thinking-details.png` / `chat-ribbon-after-thinking-details.png`.
The wait row is now `.tch-wait` and `.tch-thinking` belongs to the disclosure
alone, which is what the rules at the top of that file were always written for.

## 7. Observed, NOT caused, NOT fixed

At mid widths the composer's foot overlaps its own labels — `Enter to send ·
Shift+Enter for a new line` collides with `pinned for this thread` and the
attach refusal beside them. It reproduces in BOTH the idle and working states,
in elements this change never touched, and `.ri-card__foot` measures 56.11px
high on both sides of it, so it is neither caused nor worsened here.
Independently reproduced at 1200px by review.

Raised as its own task rather than folded into this PR: **"Chat Home composer
footer overlaps its own labels at mid widths"**, `01a00f89-8126-7049-8d38-93ae63b5d24b`.
Note there is nothing to diff against — `chat-dev.html` is new, so the harness
that revealed it does not exist on main. The defect predates the harness.

## Captures

All at dpr 2, 1280×900, both grounds.

- `chat-ribbon-after-light-sendbutton.png`, `chat-ribbon-after-dark-sendbutton.png`
- `chat-ribbon-after-light-waitrow.png`, `chat-ribbon-after-dark-waitrow.png`
- `chat-ribbon-after-light-full.png` — both marks in context
- `chat-ribbon-before-thinking-details.png`, `chat-ribbon-after-thinking-details.png`
