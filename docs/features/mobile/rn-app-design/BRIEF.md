# TM8 Mobile — lane brief

You are drawing one section of **one** design document: *TM8 Mobile — native app design*, the
design + low-level design of a new React Native (Expo) app for tm8. Eight lanes draw in parallel
and the coordinator stitches the sections into a single HTML artifact. Your section must drop in
without touching anything shared. Read this file whole before you write a line.

Repo path of the document source: `docs/features/mobile/rn-app-design/` (your worktree is cut from
the coordinator's branch, so everything below is already there).

## 1. What tm8 is (one paragraph)

tm8 is a shared work graph for humans and AI agents. Everything is an entity with an id, a kind, a
version, a parent and typed edges: tasks, chats, docs, sessions (running agents), PRs, files…
33 kinds. A **server** (a tm8 node) hosts **spaces**; a space holds the graph and its members
(humans) and team members (agent teammates with a persona and model). Agents run as **work
sessions**: terminals that read and write the graph via the `tm8` CLI. People talk to agents in
**chats** (streamed turns: text, thinking, tool calls, a *receipt* of what the turn did to the
graph) and post **messages** on any entity. **Inbox** holds what needs you. Every entity has an
address (`#/s/<space>/e/<id>` on the web) and a link to it opens the thing. The web app already has
a phone layout (a one-surface shell with a drawer, in `packages/tm8-ui/src/mobile/`), honest but
browser-bound. This document designs the native app that replaces it. Read
`sections/00-overview.html` first: it holds the principles, the tab model, the route tree and
the kind ownership table.

## 2. The deliverable

One file: `sections/NN-<lane>.html` (the exact filename is in your task). It is **a fragment**,
not a page: exactly one `<section class="doc-section" id="s-<lane>" data-title="…"
data-lane="…">…</section>`, starting with `<header><div class="lane-eyebrow">…</div><h2>…</h2>
<p class="lede">…</p></header>`. CSS of your own goes in a `<style>` at the top of the section and
**every selector must start with `#s-<lane>`** (keyframes named `s-<lane>-…`). No `<script>`,
no `<link>`, no `<iframe>`, no `<img src="http…">`, no web fonts, nothing fetched from a network.
Interactivity comes from the shared `doc.js` hooks only (`.tabs` with `[data-tab]`/`[data-panel]`).

Build and check your work:

```
cd docs/features/mobile/rn-app-design
node check.mjs sections/NN-<lane>.html      # must print 0 errors; fix warnings unless you can justify them
node build.mjs                              # → dist/index.html (whole document)
node shot.mjs dist/index.html --section s-<lane>            # → shots/s-<lane>.png   (look at it!)
node shot.mjs dist/index.html --section s-<lane> --phones   # → shots/s-<lane>/NN.png, one per phone, 1:1
```

`shot.mjs` uses the repo's Playwright (installed at the repo root; chromium is in
`~/.cache/ms-playwright`). **Look at your screenshots** with your image viewer before you call
anything done: clipped text, overlapping chrome, an empty phone, a light phone that should be
dark — these are what the coordinator will send back.

Hand-off: commit your section (and nothing else under `rn-app-design/` — not `dist/`, not
`shots/`) on your lane branch, then post one message on your task with: the commit sha, the
file path, the phone count, and anything you decided that another lane must know. Then tick your
criteria, complete the task, and `tm8 session complete`.

## 3. The kit — compose, do not re-invent

`shared/tokens.css` (vocabulary), `shared/phone.css` (the phone and every component),
`shared/doc.css` (the document around the phones), `shared/icons.svg` (111 glyphs). Open them; they
are short and commented. The rules:

- **Tokens only.** Colors are `var(--paper|--surface|--card|--hover|--active|--line|--line-2|
  --ink|--ink-2|--ink-3|--ink-4|--brand|--brand-soft|--run|--wait|--block|--info|--idle|--merged)`
  and their `-soft` fills. Type is `var(--fs-*)`/`var(--lh-*)`. Spacing `var(--s1..--s12)`,
  radii `var(--r-*)`. A hex color in your CSS is a defect unless it is a sample image/avatar tint.
- **Status is color + word.** `<span class="pill working">working</span>` — never a bare dot.
  One mapping by meaning (lane 01 ruling): `working|live|run` (green: moving now) ·
  `waiting|stale|pending|wait` (amber: waiting on someone) · `blocked|failed|error|block` (red:
  stopped by a problem) · `review|in_review|info` (blue: with a reviewer or in flight) ·
  `open|to_do|idle|exited` (grey: not started, or ended without landing) · `done|merged` (purple:
  landed) · `brand`. Priority and marks are dot-less (`nodot`); priority is never brand gold.
- **Avatar shape is provenance.** Humans `<span class="avatar c1">S</span>` (round); agents
  `<span class="avatar agent c3"><svg class="ic"><use href="#i-bot"/></svg></span>`
  (rounded-square). Sizes `xs sm (default) lg xl`; `<i class="live"></i>` inside for a live dot.
- **Icons**: `<svg class="ic"><use href="#i-task"/></svg>`. Kind glyphs: `i-task i-loop i-project
  i-collection i-story i-craft i-chat i-message i-channel i-voice i-form i-doc i-file i-drawing
  i-style i-graph i-memory i-skill i-spell i-pr i-commit i-worktree i-tool i-mcp i-session
  i-credential i-container i-artifact i-space-link i-server i-member i-team-member i-profile
  i-space`. UI glyphs: `i-chevron-left/right/down/up i-arrow-left/up/right i-menu i-more
  i-more-v i-close i-check i-plus i-minus i-search i-filter i-sort i-settings i-bell i-bell-off
  i-inbox i-chats i-work i-browse i-home i-send i-mic i-attach i-camera i-image i-share
  i-share-android i-copy i-link i-external i-pin i-star i-clock i-calendar i-refresh i-play
  i-pause i-stop i-warning i-info i-error i-success i-help i-lock i-key i-qr i-wifi i-wifi-off
  i-globe i-moon i-sun i-eye i-trash i-edit i-reply i-thread i-at i-slash i-hash i-keyboard
  i-expand i-collapse i-grip i-sparkle i-phone i-zap i-dollar i-gauge i-users i-user i-bot
  i-terminal`. Need one that is missing? Draw it inline as a `<svg class="ic" viewBox="0 0 24 24">
  <path d="…"/></svg>` in your section; tell the coordinator in your hand-off so it can be promoted.
- **Entity chips** `<span class="chip"><svg class="ic"><use href="#i-doc"/></svg>The Back
  Contract</span>` (+ `run|wait|block|info|brand` tint). Chips are tappable everywhere and push the
  entity's page.

### 3.1 A phone

```html
<div class="shot">                                   <!-- inside a <div class="screen-strip"> -->
  <figure class="phone" data-os="ios" data-theme="light">        <!-- data-os="android" data-size="360" for Android -->
    <div class="ph-status"><span class="time"></span><span class="sys"><i class="sig"></i><i class="wifi"></i><i class="bat"></i></span></div>
    <div class="ph-screen">
      <header class="topbar hairline">
        <div class="lead"><span class="back"><svg class="ic"><use href="#i-chevron-left"/></svg><span>Work</span></span></div>
        <div class="title">Task<span class="sub">Atelier · tm8.sh</span></div>
        <div class="trail"><span class="iconbtn"><svg class="ic"><use href="#i-share"/></svg></span></div>
      </header>
      <main class="content"> … rows, cards, prose … </main>
      <nav class="tabbar"> … only on tab roots … </nav>      <!-- or <div class="composer"> on a chat -->
    </div>
    <div class="ph-home"></div>
  </figure>
  <div class="cap"><b>Title of the screen</b>One or two sentences: what it is for and the one thing to notice. <span class="route">/[server]/[space]/e/[id]</span></div>
</div>
```

Top bars: `.topbar` (44pt, centered title on iOS; 56dp left title on Android — automatic from
`data-os`), `.topbar.large` adds `<div class="big">Title</div>` for the iOS large title (give the
small `.title` the class `hidden`). `.topbar.hairline` draws the bottom line (use it on pushed
screens, not on tab roots with a large title).

Overlays are drawn **inside `.ph-screen`**: `<div class="scrim"></div><div class="sheet half">
<div class="handle"></div><div class="sheet-h"><span class="h">Title</span>…</div><div class="sheet-b">
…</div></div>`; also `.dialog`, `.menu` (absolute, position it), `.toast`, `.banner` (inline, top
of content), `.notice` (a system push notification). A keyboard is `<div class="keyboard">` as a
sibling after `.composer`.

Numbered callouts: wrap the figure in `<div class="phone-wrap">` and add `<span class="an"
data-n="1" style="left:14px;top:62px"></span>` siblings after the `<figure>`; explain them in the
caption with ①②③ or in an `.anatomy` legend (`<div class="anatomy"><div class="phone-wrap">…</div>
<ol class="legend"><li><b>Back</b> names where you came from</li>…</ol></div>`).

Flows: `<div class="flow"><div class="shot"><div class="phone-wrap">…phone…</div><div class="cap">
step</div></div><span class="arrow"></span>…</div>` draws phones at 60% with arrows between.

### 3.2 Document pieces

`<h3>` for each screen group (TOC picks them up), `<p>`, `<div class="why">` (the reasoning under
a group, 2–4 sentences), `<table class="spec">` (specs: component · size · behaviour; use
`<td class="code">` for names), `<table class="route-table">` (routes your lane owns: route ·
screen · params/notes), `<div class="callout ruling|why|warn|open">` (`<b>Label</b>` first),
`.grid-2/.grid-3/.grid-4` of `.tile`s, `.diagram` with `.box` and `.arr`, `.tree-list` (a
monospace tree), `.tabs` (switchable panels), `.swatches`, `.type-sample`.

## 4. What every lane section must contain

1. `<header>` with eyebrow `NN · Lane name`, an `<h2>`, a two-to-four-sentence `lede` saying what
   the section covers and what is new versus the web phone shell.
2. **Every screen you own, drawn**, grouped by `<h3>`, each phone with a caption and its route.
   Primary screens appear in **both themes** and the ones whose chrome differs appear on **both
   OSes** (at least one Android phone per group). Draw the **states**: loading (skeletons), empty
   (an `.empty` with a verb), error / offline (`.banner` or `.refusal`), permission or
   sign-in-required where relevant, and the **keyboard-up** composition for anything with an
   input.
3. **Anatomy** of your most important screen (numbered callouts + legend).
4. A `route-table` of your routes (path · screen · params, deep-link mapping where relevant).
5. A `spec` table of components you introduce (name · size in pt/dp · behaviour · platform
   differences) and a `spec` table of **gestures & interactions** (tap, long-press, swipe,
   pull-to-refresh, drag, shake…) with the haptic for each (iOS: `selection`, `impactLight`,
   `notificationSuccess`…; Android: `CLOCK_TICK`, `CONFIRM`…).
6. **Why** blocks: the reasoning, in tm8's terms, for each non-obvious choice. Cite the web rulings
   you keep or overturn (CONTRACT.md §4/§5 rulings, the Back Contract, "one surface at a time").
7. **Honesty**: never draw a number the node would not return (counts absent ≠ zero; cost absent
   ≠ $0). Disabled-with-reason for anything the server may refuse. Nothing in a mockup promises a
   capability the server does not have today unless the caption says it is proposed.
8. A closing `callout open` listing open questions for the owner, if any.

Breadth target: **8–20 phones** per lane (the chat lane more), 40–120 KB of HTML. Real content
only — the sample world below — no lorem ipsum, no "Item 1".

## 5. The sample world (shared by every lane — use these names)

- **Servers**: `tm8.sh` (https://tm8.sh, signed in as **subhang**, 2 spaces: **Atelier** (mark A,
  the active one), **Playground**) · `acme-node` (https://tm8.acme.dev, spaces **Platform**,
  **Mobile**, reachability sometimes offline) · `local` (http://127.0.0.1:4611, this machine).
- **Members** (humans, round): Subhang (owner), Priya, Marco, Lena.
- **Teammates** (agents, rounded-square): Worker (Opus 5.5), Reviewer, Coordinator, Dreamer,
  Graph Architect, Dispatcher, TM8 Helper, Opus 5.5 1M Teammate, Fable 5.1 1M Teammate.
- **Tasks**: "TM8 Mobile app" (working · medium · Worker + Coordinator · 2 live sessions) ·
  "Bridge as an entity" (working) · "Readiness per used provider" (in review · PR #955) ·
  "PTY recheck fails closed" (done · PR #1012) · "Repoint family: 1-arg resume gate" (blocked,
  waiting on Marco) · "Patch vulnerable dependencies" (done · PR #1113) · "Desktop-shell reflow
  overflow (tablet-768)" (open) · "Quiet list tiles + one-row header" (in review, 4 of 5
  criteria) · "Craft L4.5 top bar QA" (done).
- **Sessions**: "TM8 Mobile app" (Coordinator · claude-fable-5-1 · live · 42 min · worktree
  `tm8/01a182a9…`) · "Bridge as an entity" (Coordinator · live) · "Security lane A" (Worker ·
  waiting on a permission: push to origin) · "Facade audit" (swarm01 · exited · done) ·
  "Nightly graph refresh" (loop run · exited).
- **Chats**: "Design the mobile tab bar" (Worker, live) · "Why does the PTY recheck fail closed?"
  (TM8 Helper) · "Release notes for #955" (Reviewer, waiting: asked a form) · "Plan the
  credentials security lane" (Coordinator) · "Explain the Back Contract to me" (TM8 Helper, about
  doc "The Back Contract").
- **Docs**: "The Back Contract" · "One surface at a time" · "Mobile shell contract" · "Operator
  guide". **Stories**: "Story kind improvements" (7/12 done) · "Credentials security lane" (done).
- **PRs**: #955 "R1/S7b: readiness per used provider" (merged) · #1012 "fix(credentials): PTY
  recheck fails closed" (merged) · #1113 "fix(deps): patch vulnerable dependencies" (checks
  running) · #1208 "fix(mcp): expose spaceLinks.list" (review requested). Repo
  `github.com/subhangR/tm8`.
- **Channels**: #general · #mobile · #releases. **Voice**: "Standup". **Forms**: "Which tab bar?
  (3 options)". **Projects**: tm8 · tm8-hub. **Artifacts**: "Left navigator prototype" (r1) ·
  "TM8 Dark Tech marketing preview" (r5). **Tools**: graphify-refresh · doctor. **MCP**: github ·
  linear. **Containers**: utho-prod-7777 · dev-box. **Credentials**: "Anthropic — space default" ·
  "OpenAI — subhang". **Memories**: "Prefer bun over npm in this repo". **Skills**: github ·
  code-review. **Spells**: "Daily standup summary". **Loops**: "Nightly graph refresh" (daily
  02:00). **Styles**: Neutral (default) · Atelier. **Space links**: Playground ↔ Platform
  (acme-node). **Graphs**: "Session graph: mobile app". **Drawings**: "Tab bar sketch".
  **Interaction profiles**: core-default. **Collections**: "Mobile design inputs". **Crafts**:
  "Mobile craft". **Worktrees**: lanes `tm8/01a182a9…`.
- Ids look like `01a182a2-238b-7a87-a4ad-014347c45008`; show the first 8 chars (`01a182a2`) in
  mono when an id is useful. Times: today is 2026-10-28, 13:40.

## 6. Native conventions (both platforms, in one design)

- iOS: large titles on tab roots, centered titles on pushed screens, `‹ Back` names the previous
  screen, bottom tab bar 49pt + 34pt home inset, sheets with detents (medium/large) and a grabber,
  context menus on long-press, swipe-to-go-back from the left edge, SF Symbols-like glyphs.
- Android: Material 3. Top app bar 56dp, left title, `←`; navigation bar 80dp with an active pill;
  FAB for the primary create; bottom sheets with 28dp corners; predictive back; snackbars.
- Both: 4 tabs — Chats · Work · Inbox · Browse; space button top-left on tab roots; search
  top-right; every entity opens as a push; Messages + Linked at the bottom of every entity page;
  pull-to-refresh on every list; offline banner at the top of content; haptics on state changes.
- Back contract (kept from the web, re-expressed natively): each tab has its own stack; opening an
  entity pushes; stack cap 12; a cold link opens as `[kind's tab root, entity]` so Back lands on
  the list; sheets are dismissed by Android back before the screen pops; re-tapping the active tab
  pops to root; long-pressing it shows the stack. Nothing ever jumps several levels.
- **Hierarchy is visible in every list (owner ruling, 2026-10-28).** Every entity may have a parent
  of its own kind (subtasks, sessions launched under a root session, sub-docs, child stories). A kind
  list renders as a TREE whenever any row has children: expanded to depth 2 by default, a disclosure
  chevron on rows with children, 20pt indent per depth with a hairline guide, and a count summary on a
  collapsed parent ("3 children · 2 live"). Tree is the default layout for Sessions, Tasks, Docs and
  Stories; collapse state is remembered per list. Entity pages show the parent chain and a Children
  tree. Inbox rows stay flat but name the parent in the subtitle. The kit draws the guide:
  `.tree .row.open` (an expanded parent), `.kid` / `.kid.last` (its children), `.thru` (a grandparent's
  line through a depth-2 row), `.more` (the "▸ N more · summary" row).
- **No Board in mobile v1 (owner ruling, 2026-10-28).** The Work tab is Tasks · Sessions · Stories;
  kind lists switch tree · list · timeline; the web's board address opens Work › Tasks.
- Honest refusals keep their words: "This server could not be reached", "Nobody could count this
  yet", "The node refused: <reason>".

## 7. Quality bar — what gets sent back

- A phone with clipped or overlapping text; a `.content` taller than the frame (it is `overflow:
  hidden` — compose to fit, or draw a second phone for the lower half).
- A screen with no caption, no route, or a route that is not in the overview's tree (propose a
  new route explicitly in your route-table instead).
- A status without a word; an agent with a round avatar; a hex color; a web font; a script.
- Lorem ipsum, "Item 1", placeholder names, a count the node could not produce.
- A lane that draws another lane's screens (link to them by name instead) or edits shared files.
- No dark phone, no Android phone, no states, no gestures table, no anatomy.
