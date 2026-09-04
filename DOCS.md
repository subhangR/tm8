# Documents in tm8 — what I found, what I changed, and what is not a CSS problem

Owner, 2026-08-31: *"docs — every document can be more structured, colourful,
readable, iconish, diagramish, but it's not now; it's not natural human written
plain language."*

That is two complaints and they have two different answers.

**A · RENDERING.** Real, and worse than reported: documents were being *scrolled
out of view sideways* by a tooltip nobody can see. Fixed, measured, below.

**B · THE PROSE.** Partly real, and **not a CSS problem**. The bodies of these
documents are mostly good human prose. The machine register is concentrated in
**titles**, in **identifier-dense passages**, and in one habit — writing the
audit trail as if it were the document. No stylesheet fixes that. §6 is the
written standard instead.

---

## 0. Verification jurisdiction — read this before believing any number below

Three different things were measured and they are not interchangeable.

| Evidence | What it can prove | What it cannot |
|---|---|---|
| **The deployed bundle** at `https://tm8.sh`, Firefox 1512×950 | what a reader sees *today* | anything about my working tree |
| **The working tree** on `vite` dev + `/reader-dev.html`, Firefox | that my change renders | that it is deployed |
| **`vitest`** (`css: false`) | DOM, structure, dispatch | **nothing visual at all** |

Every "before" here is the deployed bundle. Every "after" is the working tree.
They are different bundles on different scaffolds, so the one number that
matters — the phantom scrollbar — was additionally re-measured as a **controlled
A/B inside one page**: measure, disable exactly one new CSS rule via CSSOM,
re-measure. Nothing else can be credited for that result.

Nothing here claims a visual outcome from a green test run.

---

## 1. What I found reading the real documents

I read all 40 `kind:doc` records in the live space (`tm8 entity query --kind doc
--limit 40`, then `entity context <id> --sections summary --total-bytes 32768`).

**What documents are actually made of** — this decided where the work went:

| Shape | Documents using it (of 40) |
|---|---|
| tables | **27** (one carries 95 lines of table markup; others 44, 35, 34) |
| code fences | 18 |
| `---` section breaks | 25 (one uses nine) |
| blockquotes used as **status banners** | several |
| **mermaid diagrams** | **1** |
| **GFM callouts** (`> [!NOTE]`) | **0** |

*Caveat on that table:* `entity context` caps a section at 8 KiB, so for the
longest documents these are counts over the **first ~8,000 characters** of the
body, not the whole of it. Every figure is therefore a floor. It does not move
the two conclusions that matter — 27 documents reach a table inside 8 KB, and
the mermaid and callout counts are 1 and 0 across every byte I could read.

Tables are the dominant structure by a wide margin, and they were rendered as a
full 1px grid — every cell boxed on four sides. That is the treatment that makes
a 95-row table read as a fence rather than as data.

Zero callouts is **evidence of a missing feature, not an unwanted one**: nobody
writes syntax that renders as nothing. Proof is in the corpus — `DESIGN 1 —
Harness registry` opens with a blockquote *doing a callout's job*:

> **STATUS BANNER — added 22 Aug 2026 during the build of this task.**
> **Every count in §1 is stale.** They were read at `8e6e1527`, **573 commits
> behind main**. … nothing below should be trusted as a current measurement —
> only as a shape.

Twelve lines of it, rendered as grey **italic** text behind a 2px hairline —
visually identical to someone being quoted, in the least legible setting in the
sheet. The author had no other vocabulary.

**And the prose is often genuinely good.** From `The Capability Model`
(Subhang):

> A **named, closed, core-implemented contract**. Each capability is defined in
> exactly one place … **Closed like categories.** Users never define a
> capability; they declare which ones their kind has. This is the whole trick —
> it is what keeps the model inside T-L4/T-D11. The moment the vocabulary opens,
> a capability is a user-defined behaviour hook and the law is amended.

That is a person explaining something to another person. It was being rendered
at chat-bubble size with no measure. **Complaint A is largely about the styling
of good prose.**

---

## 2. THE DEFECT THAT OUTRANKED EVERYTHING — prose scrolled out of view

### What was reported
The body carried a horizontal scrollbar spanning its whole width and the prose
was cut mid-sentence at the right edge — *"Nothing in the server,"*.

### What I measured, on the deployed bundle
Doc `01a04ee0` ("Frontend verification — what changed on 2026-08-29"), the doc in
the report:

```
.pn-body   clientWidth 558   scrollWidth 726   →  168px of horizontal scroll
the only box past the right edge:
  span.hon-tip   +168px   position:absolute · visibility:hidden · opacity:0
```

Then the decisive test — `scrollLeft = 9999`:

> the body moved the full 168px and slid the **entire reading column** left,
> cutting every line at both edges. The screenshot is identical to the owner's:
> *"…es is under `packages/tm8_ui_2.0`. Nothing in the server,"*.

The same 168px reproduced on a second document (`01a027ab`) and at a second pane
width. It is the **facts line**, not a document — every doc in the space has it.

### Correcting the hypothesis I was given
The coordinator's hypothesis was a wide `<pre>` setting its column's min-content
width. **Measured, that is not what happened, and it is worth saying why.**

* `.md-fence__pre` already has `overflow-x: auto` and is a proper scroll
  container — `scrollWidth 434 / clientWidth 434` in the harness, no leak.
* `.md-tablewrap` likewise.
* The prose **wrapped correctly at rest**: first paragraph `scrollWidth ===
  clientWidth === 454` at a 454px column. No element was clipping its own text.
* One earlier reading looked like the trap — paragraphs measuring 588px inside a
  534px root — and it was **a measurement artifact**: the app runs at `zoom: 1.1`,
  so `getBoundingClientRect()` returns post-zoom pixels while `clientWidth`
  returns layout pixels. 534 × 1.1 = 587.4. There was no overflow there at all.

The victim was indeed the sibling. The culprit was a **hidden tooltip**:
`.hon-tip` is `left: 0; width: max-content; max-width: 260px` — correct for a
control on the left of its row — and the reader's `history ▸` control is the
**last** item of a row with a `flex: 1` spacer before it. 260px of tooltip starts
at the right edge and lands outside the scroller. It is `visibility: hidden`, so
it contributes scrollable overflow while being impossible to see.

### The fix
`src/panels/bodies/reader-body.css` — anchor that tooltip by its right edge:

```css
.cv2-root .rd-facts .hon-tip:not(.mobile-frame *) { left: auto; right: 0; }
```

Same box, same readability, inside the column, contributing nothing to the
scroll region. `:not(.mobile-frame *)` because the mobile spelling of this
tooltip is `position: fixed` to the frame and must keep its own geometry —
restating it here is what `honesty.css`'s own docblock warns against.

### Before / after, as a controlled A/B on one page
Working tree, `/reader-dev.html`, Firefox, real-document fixture:

| | horizontal overflow of the doc body | box past the right edge |
|---|---|---|
| rule active | **0px** | none |
| that one rule reverted to `left: 0` | **191px** | `span.hon-tip`, +210px, `position:absolute`, `visibility:hidden` |

Same bundle, same page, one rule toggled. The deployed-bundle figure was 168px
at a wider pane; the mechanism is identical.

### Second entrance to the same defect class, closed
A long unbreakable token — a path, a sha, a 60-character identifier, all of which
these documents are full of — can push a reading column past its box on its own.
`kit/markdown.css` `.md-root` now sets `overflow-wrap: break-word`, and
`.md-code` sets `overflow-wrap: anywhere`. `break-word` rather than `anywhere` on
the root deliberately: `anywhere` also lets the browser count the break
opportunity when computing min-content, which is how a reading surface ends up
one character wide.

### What this says about the gate
**The render gate is green on this defect and always was.** I added the real doc
as a route and ran it against the deployed bundle:

```
render-gate: 20 route/theme pairs rendered, 0 violation(s)
  ✓ entity/doc-full [light]     ✓ entity/doc-full [dark]
```

Clean — on a document whose prose is being scrolled out of view. The gate has no
rule for horizontal overflow in a scrolling body. **A green gate proved nothing
here.** See §7 for the rule I did not add and why.

---

## 3. THE OUTLINE — decoration that turned out to be a real control

**Reported:** flat grey monospace lines, no hierarchy, no link affordance, no
indication they are navigation; and *"check whether those entries are even
clickable — if the outline does not jump, it is decoration pretending to be a
control"*.

**Answer to that question first, because it changes the diagnosis: they jump.**
Driven in Firefox against the working tree:

```json
{ "label": "A fourth level, which used to look identical to the third",
  "before": 0, "after": 1320, "moved": true,
  "focusTag": "H4", "focusSlug": "a-fourth-level-which-used-to-look-identical-to-the-third" }
```

Real `<button>`s, the body scrolls, and focus lands on the matching heading. The
control was wired. **Only its appearance was lying.** Nothing was ripped out.

**Changed** (`reader-body.css`, `ReaderBody.tsx`):

| | before | after |
|---|---|---|
| face | `--pn-mono` 10px | `--pn-prose` `--pn-fs-sm` (13px) |
| hierarchy | indent only (12px steps, capped at 3) | indent **+ weight + ink**: depth 0 = 600/`--pn-ink`, depth 1 = 500/`--pn-ink-2`, depth 2–3 = 400/`--pn-ink-3` |
| region label | `aria-label` only — audible, invisible | a `CONTENTS` eyebrow, `aria-hidden` so it is not announced twice |

Mono is this package's face for things that were **typed** — a sha, a path, a
command. These entries are the document's own **sentences**, lifted out of it.
`--pn-prose` and `--pn-ui` resolve to the same stack in `tokens.css` today, so
the visible change is mono → proportional, not a second typeface arriving; the
token name states what the words *are*.

The quiet register moves from **face** to **weight**, so the reading column is
still the loudest thing in the body — the reader archetype's standing rule,
unchanged.

One cascade detail worth naming: the depth rules need `[data-depth]` to select
on, which lifts them to (0,4,0) and would have beaten the (0,3,0) hover. A hover
that loses to a resting colour is a hover that does not exist. The hover is now
qualified by the item to match.

---

## 4. Mermaid — already rendered. Verified, then left alone.

`kit/Markdown.tsx` already routes a ```` ```mermaid ```` fence to `kit/Mermaid`.
I did not take that on trust. Measured on the **deployed bundle**, doc
`01a027ab` — the one document in the whole space that contains a diagram:

```json
{ "class": "md-mermaid", "phase": "ok", "svg": true, "w": 588, "h": 333, "nodes": 36 }
```

A real 588×333 SVG with 36 groups, drawn, in the token palette, re-rendering on
theme change. Re-confirmed in the working tree in both themes. **"Diagramish" was
already built.** The gap is not the renderer — it is that **one document in forty
uses it** (§6).

One stale claim corrected: `DocPreview.tsx`'s docblock still said *"no diagram
renderer ships in this build"*. It was true when written and is not now. Replaced
with the measurement, not deleted.

---

## 5. The rest of the rendering work

All of this is complaint **A**. Every colour is a token; there is no raw hex; no
kind literal; every rule is `.cv2-root`-prefixed.

### Typography for reading — `kit/markdown.css`, new `.md-doc` stance
`.md-root` is worn by three different things — a chat bubble, a task description,
a document — and only one is read for minutes at a time. `.md-doc` is the stance
for that one, applied by **both** `ReaderBody` and `DocPreview` so a preview
cannot silently differ from the surface it previews:

* `--pn-fs-read` / `--pn-lh-read` — 14px/1.5 → **15px/1.62**, the same reading
  setting the chat transcript uses.
* `--pn-measure` (68ch) as a cap on flow children. **Set on the children, not
  the root**, because tables, fences and diagrams must break out: they are
  scanned, not read at a measure, and cutting a 5-column table to a text column
  makes it scroll for no reason. The cap is in *characters*, so 68 characters is
  the same reading span at every heading size — a px cap would have had to pick
  a size to be right for.
* `.rd-md` — the reader's reading-column class — **had no declaration anywhere
  in the package**. It was passed by `ReaderBody` and matched nothing. Named now.

### Structure that is visible
* **Six heading levels, six appearances.** `h4`, `h5`, `h6` shared one
  declaration (`--pn-fs-title` at 600), so a document nesting three levels drew
  three *identical* headings. Real documents here nest that far. `h6` becomes an
  eyebrow — at the bottom of the scale, size and weight have run out of room to
  say "smaller again", and caps + tracking is `t-eyebrow`'s existing grammar.
* **Rhythm**: more air above a heading than below it (`h1` 2em, `h2` 1.9em), so
  the eye groups a heading with what follows rather than with what it just
  finished. `---` goes to 2.2em — it is a section break that outranks a heading,
  and 25 documents use it.
* **Lists**: `li::marker` quieted to `--pn-ink-4` (a bullet in body ink competes
  with the first word of every line), and `li > p` de-double-spaced for the long
  design-doc bullets this space is full of.

### Callouts — the one genuinely new capability
GitHub's `> [!NOTE|TIP|IMPORTANT|WARNING|CAUTION]`, implemented as a **remark
plugin** (`remarkCallouts`) plus a `blockquote` override in `kit/Markdown.tsx`.
`remark-gfm` does not implement alerts — they are a GitHub extension on top of
GFM — and no new dependency was added.

A remark plugin rather than a component sniffing its own children, because at
mdast the marker is one text node we can **delete**; after render it is a string
spliced through React children that cannot be edited without re-implementing the
parser. The marker is removed, not hidden — leaving `[!NOTE]` beside the word
"Note" is the placeholder problem in miniature.

GitHub's spelling rather than an invented one, so a tm8 document does not read as
broken anywhere else.

**Colour carries meaning, and cannot be chosen.** Each tone is bound to the token
this package already spends on that state everywhere else:

| marker | tone token | says |
|---|---|---|
| `[!NOTE]` | `--pn-info` | context, take or leave |
| `[!TIP]` | `--pn-run` | this helps |
| `[!IMPORTANT]` | `--pn-brand` | the part to keep |
| `[!WARNING]` | `--pn-wait` | same amber as a waiting session |
| `[!CAUTION]` | `--pn-block` | same red as a blocked session |

Five tones, no sixth, no author-chosen colour — colour that can be picked is
decoration. The **title** carries the tone; the **body** stays in reading ink,
because a whole paragraph in signal colour is a paragraph nobody finishes.

**Icons only where they carry a fact.** Each callout gets one mark, drawn as
geometry on `VectorIcon`'s 16×16 grid — an *i* in a circle, a lamp, a bookmark, a
triangle, an octagon. Not emoji, not a text character: `VectorIcon`'s own
argument is that a pictographic character lands on its own font's baseline and
resolves to a blob at 14px. The mark carries exactly one fact — *which of the
five kinds this is* — said a second time for a reader who cannot separate the
hues. And it never appears alone: the word is always there too.

An **ordinary quotation stays an ordinary quotation** — the transform only
touches a blockquote whose first line is a known marker, and there is a test for
each of "unknown marker left verbatim", "marker mid-quote is prose", and "a plain
quote is untouched".

### Blockquotes are no longer italic
Taken against the corpus, not against taste. Italic is right for the one or two
lines a quotation usually runs to; in this space a blockquote is routinely a
twelve-line status banner, and twelve italic lines in a sans face is the least
readable thing the reader draws. It stays distinct without italics: an inset
ground, a `--pn-line-2` rule, its own colour.

### Tables — the most-used structure, and the biggest visual change
Vertical rules removed; horizontal rules kept (the row is the unit a reader
tracks along); the **wrapper** takes the border, so the table has one outline
instead of one per cell; **zebra** on even rows does the work the vertical rules
were failing at; the header row becomes an **eyebrow** (`--pn-fs-micro`, caps,
`--pn-track-mega`) so it is distinguishable from data even when the data is also
short and also bold; padding 5/9 → 7/10.

### One real bug this caught, which no test could have
A callout **is** a `<blockquote>`. `.cv2-root .md-root blockquote` (0,2,1)
outranked `.cv2-root .md-callout` (0,2,0) and painted every tone's rule and
ground back to the quote's. Measured in Firefox before the fix: a `[!WARNING]`
callout's **title** was correctly `--pn-wait` — it reads the tone through an
inherited custom property, which no specificity contest can reach — while its
**border** was `--pn-line-2` and its **ground** `--pn-hover`. The half-applied
result is the giveaway. Fixed by excluding the class (`blockquote:not(.md-callout)`)
rather than out-specifying it, so the two treatments can never contest again.

This is precisely the class of defect a `css: false` suite cannot see, and it
was found by measuring computed style in a browser.

### The harness was lying by omission
`src/reader-dev.tsx` imported `panels.css` but not `honesty.css` (the real app
gets it from `panels/index.ts`), so `.hon-tip` mounted `position: static` there
and wrapped harmlessly in-flow. **The harness was structurally incapable of
reproducing the bug.** Fixed, plus a second fixture built from passages quoted
verbatim from the real records (`01a04ee0`, `01a027b5`) so the scaffold contains
a table, a fence, a banner, callouts and a diagram — which the filler-bodied
outline fixture contains none of.

---

## 6. Complaint B — the part that is NOT a rendering problem

Read honestly, the bodies are mostly fine. Two habits are not, and no stylesheet
touches either.

### 6.1 Titles
At least **13 of 40** document titles lead with an internal serial or a raw
identifier (counted by `\b[0-9a-f]{8}\b | DESIGN \d | PROBE [A-Z] | Lane [A-Z] |
§ | DEF-\d | Untitled | Wave \d`):

```
Untitled doc
PROBE C empty doc
DESIGN 2 — Contract widening (Phase 1)
DESIGN 6 — Harness capability tiering (A/B/C) · inventory VERIFIED 22 Aug
DESIGN 6 RESULT — harness tiering, executed against AO d4ae9b3
Frontend verification — what changed on 2026-08-29 (41c824b4 → 6423d07d)
IMPACT ADDENDUM (third pass) — READ WITH the gap doc; supersedes it where they conflict
```

The doc list is the first thing anyone sees, and it is a wall of these. Compare
what the same space also contains: `The Capability Model`, `Traits, Mixins,
Templates`, `Binding Surfaces — Edges, Verbs, Screens`, `Higher-Order Concepts —
Admissions and Refusals`. Those are titles. The others are filenames.

### 6.2 The audit trail written as if it were the document
From `Lane A (chat on mobile) — Lessons`, verbatim:

> Verdicts: item 7 (DEF-065) PASS at 390 and 430 on the isolating pair
> `4a1691a7 → 1cc8f85d`; five ledger rows (DEF-025/026/027/028/039) PASS on
> `21b633c4 → dda1cb18`. `verified` unwritten on every row.

Forty words, eleven identifiers, no subject a reader can hold. This is exactly
*"not natural human written plain language"*. And the same author, four
paragraphs later, writes this:

> `.mobile-frame` is `display: grid; grid-template-rows: auto 1fr auto` and the
> tab bar is an **in-flow auto row** — when it grows to 83px the `1fr` content
> row shrinks by exactly 34, and the composer rides up with it. Clearance is
> invariant. I had named that exact premise as unchecked in the message and sent
> it anyway; one grep for `grid-template-rows` refuted it.

Same identifiers, same density — and it is a person telling you what happened.
The difference is not vocabulary. It is that the second one has **verbs and a
claim**, and the first is a table that forgot to be a table.

### 6.3 The standard
Six rules. They are what separates the two passages above.

1. **A title is a sentence about the content, not its filename.** No serial, no
   sha, no `§`, no `DESIGN n` — those go in the body. *"Harness capability
   tiering"*, not *"DESIGN 6 — … · inventory VERIFIED 22 Aug"*. If the serial is
   how people refer to it, put it after the words, not before them.
2. **Lead with the claim, then the evidence.** *"The safe-area alarm was wrong;
   clearance is invariant because the tab bar is an in-flow grid row"* — then the
   shas. Never a list of identifiers with the finding implied.
3. **Every identifier earns its place by being reachable.** A sha a reader cannot
   check is noise. If it matters, say what it is: *"`41c824b4`, main immediately
   before the train"*.
4. **If it is a list of facts with a shape, make it a table.** 27 of 40 documents
   already do this and it is the single strongest thing in this corpus. A
   paragraph of semicolon-separated verdicts is a table someone didn't write.
5. **If it is a warning, make it a callout** — `> [!WARNING]`, `> [!CAUTION]`,
   `> [!NOTE]`. As of this change they render with the tone the rest of the app
   uses for that state. A blockquote means *someone said this*, and every banner
   currently written as one is mislabelled.
6. **If it is a flow, a sequence or a dependency, draw it** — ```` ```mermaid ````
   renders, and has since before this pass. One document in forty uses it. The
   design docs in this space are full of prose describing graphs.

Rules 4–6 are the honest overlap between the two complaints: the *renderer* now
rewards structure that the *writing* has to supply.

---

## 7. What I did not do, and why

* **No horizontal-overflow rule added to the render gate.** It belongs there —
  it is the exact class of defect the gate exists for, and a green gate on a
  broken document is the failure mode its own docblock warns about. But
  `.hon-tip` is `honesty.css`'s, used across task detail, list rows and auth, and
  a rule that fires everywhere at once would land as a blocking failure in three
  other lanes' routes. **Recommended, with the mechanism written up in
  `reader-body.css`, for whoever owns `honesty.css`:** the general fix is to make
  `.hon-tip` flip its anchor near the right edge of its scroller, once, rather
  than per surface.
* **No change outside my territory.** `panels/honesty/*`, `home-page`, `views`,
  `board-v2`, `kit/*` other than `Markdown.tsx` / `markdown.css` — read only. The
  two `panels/bodies/*` files I did touch are the doc reader itself, named in the
  brief.
* **No new dependency.** Callouts are ~60 lines of remark transform, not
  `remark-github-blockquote-alert`.
* **`styles/tokens.css` untouched.**

---

## 8. Test results actually observed

```
npx tsc -p tsconfig.json --noEmit                          → exit 0, no output

npx vitest run --maxWorkers=1 \
  src/kit src/doc-edit src/panels/bodies src/transcript \
  src/token-reference-ban.test.ts src/hex-ban.test.ts src/type-scale-ban.test.ts

  Test Files  39 passed (39)
  Tests      657 passed (657)
  Duration   92.63s
```

The three guards passed: no raw hex, type through the scale, and **every bare
`var(--x)` I added resolves** — including `--md-tone` / `--md-tone-soft`, which
are assigned in `markdown.css` and therefore defined by that guard's own rule.

Tests added — all **structural**, since nothing here can see a stylesheet:

* `kit/markdown.test.tsx` — 11 new: each of the five markers → the right tone and
  word; the marker text is removed; the mark is an `<svg>` and not a character;
  an ordinary quote is untouched; an unknown marker is left verbatim; a marker
  mid-quote is prose; an empty callout does not crash.
* `panels/bodies/ReaderBody.test.tsx` — 2 new: the outline names itself on screen
  and is `aria-hidden` so it is not announced twice; the reader requests the
  `md-doc` stance (pinning that reader and preview cannot drift apart).

No test was deleted or weakened.

**The full suite was not run** — several agents share this 4-core box and a full
run starves and invents named failures in files nobody touched.

### Browser verification (the only checks that saw a pixel)

| Check | Where | Result |
|---|---|---|
| phantom scrollbar, A/B on one page | working tree | **0px** with the rule, **191px** without |
| doc body overflow | working tree | `overflowPx: 0`, no box past the right edge |
| reading setting | working tree | `15px / 24.3px (1.62)`, `overflow-wrap: break-word` |
| paragraph clipping | working tree | `p.scrollWidth − p.clientWidth = 0` |
| h4 / h5 / h6 | working tree | `15px/700`, `14px/700`, `12px/700 uppercase` — three distinct |
| blockquote | working tree | `font-style: normal` |
| callout tone | working tree | `[!WARNING]` → border `rgb(140,101,28)` = `--pn-wait`, ground `rgba(140,101,28,0.1)` = `--pn-wait-soft`, title matching, `<svg>` present |
| table header / zebra | working tree | `11px uppercase` on `--pn-surface`; rows alternate `transparent` / `--pn-hover` |
| mermaid | working tree **and deployed** | `phase: "ok"`, real SVG, both themes |
| outline jump | working tree | scrollTop 0 → 1320, focus on the matching `H4` |
| render gate | **deployed** | `20 route/theme pairs, 0 violations` — including the new `entity/doc-full` route |

Both themes were captured side by side for every screenshot; nothing here is
light-only.

---

## 9. Files changed

| File | Complaint | What |
|---|---|---|
| `src/kit/Markdown.tsx` | A | `remarkCallouts` transform, `blockquote` override, five tone marks on `VectorIcon` |
| `src/kit/markdown.css` | A | `.md-doc` reading stance + measure; six distinct heading levels; callouts; tables rebuilt; blockquote de-italicised; `overflow-wrap`; list markers; `hr` |
| `src/kit/markdown.test.tsx` | A | 11 callout tests |
| `src/panels/bodies/reader-body.css` | A | **the phantom-scrollbar fix**; outline face/hierarchy/eyebrow; `.rd-md` defined |
| `src/panels/bodies/ReaderBody.tsx` | A | `CONTENTS` eyebrow; requests the `md-doc` stance |
| `src/panels/bodies/ReaderBody.test.tsx` | A | 2 tests |
| `src/doc-edit/DocPreview.tsx` | A | same `md-doc` stance as the reader; stale "no diagram renderer" claim corrected |
| `src/reader-dev.tsx` | — | harness made faithful (`honesty.css`) + a real-document fixture |
| `scripts/render-gate.mjs` | — | `entity/doc-full` route — an empty doc audits nothing |

Nothing was committed, built, deployed or restarted.
