# Board — Project Timeline view

Worktree: `/home/tm8/prod-workspace/wt-calm-int`. Everything below lands under
`packages/tm8_ui_2.0/src/board-v2/`. Nothing committed, nothing built, nothing
deployed, no service restarted.

Owner request this answers (2026-08-31, verbatim): *"When you click on board
there must be nice dashboard and workflow columns I don't see much use case,
also create project timeline board it should be multicolor some tasks might not
have a start and end date make it one week by default so it doesn't become
issue when create project timeline board also in the board you can give overall
timeline for each task a nice view thus can be filtered by live sessions live
chat live tasks this for improving board".*

---

## 1. What was built

| File | State | What it is |
| --- | --- | --- |
| `board-model.ts` | modified (+~570 lines) | every new pure function, next to `planFor` |
| `board-model.test.ts` | modified (+~330 lines) | the model's tests |
| `BoardTimeline.tsx` | new | the timeline surface — grid coordinates and text, no date maths |
| `BoardSummaryStrip.tsx` | new | the dashboard strip |
| `board-timeline.css` | new | the stylesheet for both |
| `board-timeline-style.test.ts` | new | the stylesheet asserted as source |
| `BoardV2Screen.tsx` | modified | view switch, live axis, strip mount, timeline mount |
| `board-v2-screen.test.tsx` | modified (+~180 lines) | the mounted structure |
| `index.ts` | modified | re-exports |

**A view switch on the board's own header.** Two segment buttons
(`b2-view-columns`, `b2-view-timeline`) in the existing `.b2__pivots` group.
`Columns` is the default and is what the board has always been. It is `useState`
on the screen, **not a route** — switching keeps the kind, the filters, the
search, the roving focus and the open detail panel, which is the same reason a
card opens the panel here instead of navigating away.

**The timeline.** One row per entity, one bar per row, over a dated axis of
whole days. Monday-aligned, weekends marked (not removed — dropping them would
make a stated 7-day bar five cells long), today drawn as a rule down every row
rather than a tick on the header. The axis window covers every span plus today,
floors at three weeks and caps at 26 weeks; when the cap would push *today* off
the end (one ancient row dragging the start back six months) the window
**slides** instead, and the rows that fall off the left edge are counted and
stated, never silently clipped.

**Grouping, and why.** One group per **board column**, in the board's own order
(`timelineGroups`). The alternative — one flat date-sorted list — is a 200-row
wall where finding "what is blocked" means reading every label. Reusing the
columns means the two views group identically, so switching re-shapes one answer
instead of asking a new question; it also makes workflow columns work for free
(in workflow mode the groups *are* the states), and it keeps the "No status yet"
column honestly separate rather than folded into a category it is not in. Within
a group: earliest start, then earliest end, then title — so bars stair-step, the
shape an eye can follow — and rows with **no** stated dates sort **last**,
because they are the least informative rows in the group and the only ones whose
position on the axis is a default rather than a fact.

**Multicolour that means something.** `TIMELINE_TONES` in `board-model.ts` maps
the closed four categories onto four distinct status ramps — `to_do → --pn-wait`,
`in_progress → --pn-run`, `done → --pn-info`, `cancelled → --pn-block`, edge and
`-soft` fill from the same ramp. It is deliberately **not** `CategorySpec.tone`:
that map gives To Do and Cancelled the same `idle` and In Progress and Done the
same `run`, which is right for a pill sitting beside a word and useless in a wall
of bars, where colour that repeats carries no information. A test asserts the
four are distinct *and* that the pill map is not, so a future "reuse
CATEGORY_SPECS.tone" tidy-up fails rather than quietly halving the palette. A
category the server did not send gets **no status colour at all** (`none` →
`--pn-ink-4`): absent is not "to do". No raw hex anywhere; `styles/tokens.css`
untouched.

Colour never stands alone — every bar carries its category **word** in text.

**The dashboard strip** (`BoardSummaryStrip`): total shown, a count per column
with its tone dot, the live count, and the dates confession (`N with no dates`,
`N half-dated`).

---

## 2. How "live" is derived, and where that definition came from

**The definition is Home's, imported rather than restated.**
`home/home-model.ts` `composeMyWork` computes `liveCount` as
`row.dot === 'pulse' || row.dot === 'solid'`, where `dot` is built by
`homeRowOf` from the **seam's liveness verdict** run through the kind's registry
`liveTreatment` — never from a record field. `board-model.ts` imports
`homeRowOf` and exposes that predicate once, as `isLiveDot(dot)`. If Home's
definition moves, the board moves with it. A board that disagrees with Home
about what is running would be worse than a board with no live filter.

Nothing reads `state.status`. `state.status` is what the record *claims*; the
verdict is what the node can *see*. They disagree routinely — that disagreement
is the entire reason `stale` exists — and only the second may be called live.
`stale`, `not-running` and `unknown` are all **not live**, and there is a test
for each.

**Two signals, each gated on registry capability — no kind literal:**

| signal | offered when | predicate |
| --- | --- | --- |
| `verdict` | `kind.list.liveTreatment` exists | `isLiveDot(homeRowOf(row, {liveness: livenessOf(row.id), streaming: activity[row.id]}).dot)` |
| `worked-on` | `kind.list.tile.badges` names `workingActors` | some `badges.workingActors[].actor.via.sessionId` is live *by the same predicate* |

`verdict` is the session board's chip ("Live sessions"). `worked-on` is the task
board's ("Live work" — the owner's *live tasks*). Chip labels come from
`kind.labelPlural`, not from a name in this file. A kind with neither (a doc)
gets **no live axis drawn at all**, because a chip that could only ever narrow to
zero is a control that lies about having found nothing.

`worked-on` is deliberately **not** `workingActors.length > 0`. The edge is a
claim by the row; the verdict is what the node can see. `ActorSummary.via`
(contract: *"the run it acted through"*) names the session, and the chip asks
*that* id the same question — so a task whose session died is not live. A test
pins exactly that: same edge, verdict `stale` ⇒ not live.

`liveKinds()` (registry) supplies which kind a bare `via.sessionId` belongs to,
and **every** live-shaped kind is asked, so a second kind gaining a
`liveTreatment` is answered with no edit. That is the same call `composeMyWork`
already makes for its live-count label.

**The narrowing is client-side and page-scoped**, the sibling of `matching()`.
There is no `filters.live` on `CollectionQuery` and no server-side collection
predicate consults the node's live PTY set, so `buildFilters` never puts `live`
on the wire — asserted directly:

```
buildFilters({…, live: ['verdict','worked-on']}) === undefined
```

`anyFilterActive` *does* count it, so the "Clear filters" escape hatch appears.

**"Live chat" was not built as a third signal, on purpose.** See §5.

---

## 3. How an inferred range is distinguished from a real one

### In the model

`spanOf(state, today, spanDays = 7)` returns `TaskSpan`, and **the range and its
provenance are one value**:

```ts
interface TaskSpan {
  startDay: DayKey; endDay: DayKey;
  stated: 'both' | 'start' | 'end' | 'none';  // which endpoints the RECORD carried
  inferred: boolean;                          // at least one endpoint was DRAWN
  contradictory: boolean;                     // end named before start
  note: string | null;                        // the sentence; null only when clean
}
```

There is no overload returning a bare range. A caller cannot take the dates and
lose the reason they exist — the only way to draw a bar is to hold it. That is
the whole design: a guess rendered identically to a fact is the one failure this
view could ship that nobody would ever notice.

| case | result |
| --- | --- |
| both dates | verbatim; `stated: 'both'`, `inferred: false`, `note: null` |
| start only | + 6 days forward; `stated: 'start'`, `inferred: true`, *"No end date set; showing a default 7-day week from the start date (…)"* |
| end only | − 6 days back onto the due date; `stated: 'end'`, `inferred: true`, *"No start date set…"* |
| neither | today .. today+6; `stated: 'none'`, `inferred: true`, *"No dates set; showing a default 7-day week from today."* |
| end **before** start | spans **both stated dates** (`start=end`, `end=start`); `stated: 'both'`, `inferred: **false**`, `contradictory: true`, note names both dates |

That last row is the judgement call worth flagging: both endpoints came off the
record, so it is not a guess — but the record disagrees with itself, and that is
its own fact with its own field and its own colour. Nothing is silently
reordered into looking correct.

All five cases are tested, plus: a missing `state` entirely, a custom
`spanDays`, and a blanket case asserting *every* inferred span carries a note
and *no* clean span does.

**The timezone.** A task's dates are date-only wire strings with no zone.
`new Date('2026-07-30')` is midnight UTC, which is the **29th** locally anywhere
west of Greenwich — that one line would shift every bar by a column for half the
planet, silently, forever. So a date-only string is taken **verbatim** and never
becomes a `Date`; an instant is projected with `toISOString()` (UTC); day
arithmetic is `Date.UTC` plus whole days, which no DST transition can perturb.
`todayKey()` is UTC for the same reason — one clock for the axis and the bars —
and every function takes `today` as an **argument**, so a later ruling that the
marker should follow the viewer's zone is one call site, not a sweep. Boundary
cases pinned, and they hold whatever `TZ` the runner has:

- `dayKeyOf('2026-03-01T00:30:00Z') === '2026-03-01'` (local Feb 28 in UTC−5)
- `dayKeyOf('2026-03-01T23:30:00Z') === '2026-03-01'` (local Mar 2 in UTC+9)
- `addDays('2026-03-08', 1) === '2026-03-09'` (US spring-forward)
- `addDays('2026-10-25', 1) === '2026-10-26'` (EU fall-back)
- `addDays('2028-02-28', 1) === '2028-02-29'`

### In the pixels

Four separate signals, because any one alone is one somebody misses:

1. **dashed outline** — the universal "provisional" edge;
2. **hatched fill with the solid tint dropped** (`repeating-linear-gradient`,
   `background-color: transparent`), so the bar reads as texture, not as a block
   of status colour;
3. **reduced opacity** (`0.72`), so in a wall of bars your eye lands on the
   stated ones first;
4. **words** — the bar itself carries `default week` / `part-guessed` beside its
   status word, and `title` + `aria-label` carry `span.note` verbatim, so the
   distinction survives for a reader who can see none of 1–3.

A contradictory record additionally wears the `--pn-block` dotted edge whatever
its category is. A bar clipped by the window edge is **torn** (square-cut, no
border on that side) rather than rounded, because a rounded end would claim it
stops there.

The DOM carries `data-inferred`, `data-stated`, `data-contradictory`,
`data-clipped-start/end`, `data-tone` — which is what the stylesheet keys on and
what the mounted tests read.

---

## 4. Test results actually observed

Command, as instructed (with `TM8_AGENT_TOKEN` scrubbed from the environment —
a stale one causes phantom 124s here):

```
cd packages/tm8_ui_2.0 && npx vitest run --maxWorkers=1 src/board-v2/
```

```
 Test Files  4 passed (4)
      Tests  111 passed (111)
   Duration  27.55s
```

Files: `board-model.test.ts`, `board-style.test.ts`, `board-timeline-style.test.ts`,
`board-v2-screen.test.tsx`. No failure at any duration, so no starvation timeout
to disambiguate. Before this work the same path was 3 files / 81 tests, all
passing; the 30 added are mine, and the 81 pre-existing ones still pass.

```
npx tsc -p tsconfig.json --noEmit     →  exit 0, no output
```

I also ran the four **package-root** guards, because they scan all of `src/` and
my new files fall inside their jurisdiction — a green board-v2 run would not have
covered them:

```
npx vitest run --maxWorkers=1 src/hex-ban.test.ts src/type-scale-ban.test.ts \
  src/fullwidth-plus-ban.test.ts src/no-op-handler-ban.test.ts
 Test Files  4 passed (4)      Tests  11 passed (11)      Duration  1.89s
```

I did **not** run the full suite (4 cores, other agents on the box).

### What the green run does and does not prove

`vitest` here runs with `css: false`. **No test in this package can see a
stylesheet**, so nothing above is evidence that a bar *looks* dashed, that the
hatch renders, or that the axis scrolls. What is actually proven:

- the **model** — dates, spans, axis, geometry, tones, grouping, live, summary —
  as plain data, which is where the value is;
- the **DOM structure** the stylesheet keys on: `data-inferred`, `data-stated`,
  `data-tone`, the tooltip/`aria-label` sentence, one today marker, groups in the
  board's order, the view switch defaulting to Columns and surviving a search;
- the **stylesheet as source text** (`board-timeline-style.test.ts`) — every rule
  `.cv2-root`-prefixed, no hex, four distinct ramps, the three inferred-bar
  declarations present, `overflow-x: auto` on the scroller, `grid-auto-rows`
  pinned, no unfloored `minmax(0`.

**I did not run a browser.** There is no pixel verification in this deliverable.
The visual claim is unverified and should be treated as such.

One real defect was caught by reasoning rather than by a test, and then pinned:
`grid-row: 1 / -1` on the today rule resolves `-1` against the **explicit** grid,
which declares no rows here (all body rows are implicit `grid-auto-rows`), so it
would have collapsed to `1 / 1` and covered the axis header alone. The last row
line is now counted in JS, and a mounted test asserts the rule's `grid-row` does
not contain `-1` and reaches past every row.

---

## 5. What I deliberately did not do

**No third "live chat" signal.** The owner named three; I built two, and this is
the decision I most want reviewed. In tm8 a chat **is** a `work_session`
(chat-as-work_session), so live chats are already exactly the `verdict` chip on
the session board — one derivation, not two. The only channel-side candidate is
`state.workingAgentCount > 0`, a **stored count** with no verdict behind it: no
liveness snapshot is consulted, nothing distinguishes it from a `stale` claim,
and labelling it "live" would be precisely the second definition of live I was
told not to invent. `EntityState`'s `channel` arm carries no session link, so
there is no verdict-rooted alternative available today. If the owner wants a
channel-scoped chip, the honest route is a server-side change that projects the
live sessions in a channel onto its summary — not a client-side reinterpretation
of a counter.

**No drag-to-reschedule.** Dragging a bar to change a task's dates needs a
version-guarded content patch, a conflict surface and a refusal path; the board's
existing drag is a *state* command through a different door. Shipping a bar you
can grab and that silently does nothing would be worse than a bar you cannot.

**No zoom levels** (week / month / quarter). One granularity — days — with a
bounded, sliding window and a stated overflow count.

**No dependency arrows** between bars, despite `badges.blocked.waitingOn` being
right there. Edge routing across a scrolling grid is its own piece of work and
half-done arrows misstate dependencies.

**No new server read.** The timeline is a re-shaping of the rows the board
already read per column. It adds zero queries, and its counts are therefore
page-scoped and hedge with `+` exactly as the column headers do.

**No change to what the Columns view draws.** The columns, the drag, the drop
seam, the refusals and the panel are untouched; they gained a header switch, a
strip above them and one extra filter axis.

**Did not touch `styles/tokens.css`** (byte-identical tracked twin) and did not
edit `board.css` — its one modified line in this worktree is another lane's
uncommitted `--ease-standard` → `--pn-ease-standard` fix, left alone.

**Did not read `/home/tm8/prod-workspace/wt-cx-board`.** It was offered as
optional reading; this work stands on its own and nothing was merged from it.

**Did not commit, build, deploy, or restart anything.**

### Known limits worth naming

- The live narrowing is client-side, so it filters the **page** the board read,
  not the space. With another page outstanding, "1 live" means "1 live among the
  rows on screen" — which is why every strip figure hedges with `+` in that case.
- `todayKey()` is UTC. For a reader in UTC+13 near midnight the today marker can
  sit one column from their local today. This is a deliberate trade (one clock
  for axis and bars beats two clocks that disagree), it is stated in the model's
  docblock, and it is one call site to change.
- The axis caps at 182 days. Rows reaching past it are counted and stated above
  the scroller, and their bars are drawn torn — but their true extent is only
  visible by opening the entity.
