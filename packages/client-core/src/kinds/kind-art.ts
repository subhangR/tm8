/**
 * KIND ARTWORK — the drawn mark for every kind, as registry DATA.
 *
 * THE DEFECT THIS FIXES, in the user's words: "in the connections tab, a lot
 * of times I see the linked things, but I don't understand which are what."
 * They were right, and the cause was measurable rather than a matter of taste.
 * The shipped marks were monochrome geometry — ◻ ▣ ▦ ◈ ❖ ◇ ◉ ◍ ◆ ⬢ ✧ ✦ ⌬ —
 * and THIRTEEN OF TWENTY were a small quadrilateral-or-lozenge outline. At the
 * 13–16px they are drawn at they are not merely similar, they are the same
 * blob, so the mark carried no information and the reader had nothing but the
 * title to go on. The registry's own header always called them placeholders:
 * "Chip glyphs are text placeholders … replacing them with the canvas-extracted
 * set at reference capture is a DATA edit here and touches no component."
 * This is that edit, and it touches no component.
 *
 * WHY DRAWN PATHS AND NOT BETTER CHARACTERS. Two reasons, both already learned
 * in this repo. (1) There is no set of twenty text characters that stays
 * distinct at 13px in a monochrome UI — the Unicode geometric block IS the
 * near-duplicate set, which is how we got here. (2) MaestroTaskTile L215:
 * "typographic arrows sit on their own font's baseline", so glyphs land at
 * different optical heights from each other and from their neighbours, and
 * they tofu differently per platform (the `voice_channel` row says so in as
 * many words: "a speaker glyph from the pictograph block tofus in the system
 * font"). A path in a square viewBox centres exactly, everywhere.
 *
 * THE VOCABULARY IS SEMANTIC, NOT DECORATIVE. Every mark is the thing it
 * names, drawn the way the wider world draws it, because an icon a reader has
 * to LEARN is a worse ◇: task = a checked box, doc = a page, channel = a hash,
 * message = an envelope, chat = two bubbles, member = a person, teammate = a
 * bot, PR = a branch, commit = a node on a line, file = a paperclip, project =
 * a folder, worktree = a second copy. Three rules hold the set together: no
 * two marks share a silhouette (guarded — `registry.test.ts` and
 * `kind-art.test.ts` fail on duplicate artwork), kinds that live near each
 * other in the UI are drawn as far apart as the grid allows (`doc` a page with
 * a fold, `form` an option list, `skill` a mortarboard, `story` an open book),
 * and every mark is drawn HERE ONCE — a surface that needs one reads it from
 * these tables rather than keeping a private copy of the path.
 *
 * THE GRID: 16×16, artwork inset to ~2.4–13.6, stroked at 1.4 in
 * `currentColor` with round caps and joins. Nothing is filled — a filled mark
 * would read as "selected" beside the stroked ones, and tone is already how
 * this UI says state (`chip.tintBy`).
 *
 * Kind literals are legal here: `src/domain/` is one of the two directories
 * §15.2 permits them in, and this is the file that defines them.
 *
 * SPLIT (t-p0-client-core, 2026-10-29): this is the per-kind half (`KIND_ART`),
 * shared with the phone app and read by `KIND_CORE` as each kind's `iconArt`.
 * The rail views and session surfaces (`VIEW_ART`, `SURFACE_ART`) stay in
 * tm8-ui's `domain/kind-art.ts`, which re-exports this table.
 */

/** SVG path `d` strings on the 16×16 grid. Stroked, never filled. */
export type KindArt = readonly string[];

export const KIND_ART = {
  /** A checked box — the universal "piece of work". */
  task: [
    'M3.4 5.6a2.2 2.2 0 0 1 2.2-2.2h4.8a2.2 2.2 0 0 1 2.2 2.2v4.8a2.2 2.2 0 0 1-2.2 2.2H5.6a2.2 2.2 0 0 1-2.2-2.2z',
    'M6 8.1 7.4 9.5 10.1 6.6',
  ],

  /** A terminal window with a prompt — a session IS a running terminal here. */
  work_session: [
    'M2.4 5.2a2 2 0 0 1 2-2h7.2a2 2 0 0 1 2 2v5.6a2 2 0 0 1-2 2H4.4a2 2 0 0 1-2-2z',
    'M5.2 7.4 6.9 9 5.2 10.6',
    'M8.4 10.6h2.6',
  ],

  /** A page with a folded corner and text. Written prose, one sheet. */
  doc: [
    'M9 2.6H5.2a1.4 1.4 0 0 0-1.4 1.4v8a1.4 1.4 0 0 0 1.4 1.4h5.6a1.4 1.4 0 0 0 1.4-1.4V5.6z',
    'M9 2.6v3h3.2',
    'M6 9h4',
    'M6 11.2h2.6',
  ],

  /** The hash. The one inherited mark that was already right. */
  channel: ['M6.4 3 5.2 13', 'M11 3 9.8 13', 'M3.6 6.4h9.2', 'M3.1 9.6h9.2'],

  /** A microphone — a voice room is a place you SPEAK, not a place with audio. */
  voice_channel: [
    'M8 2.6a1.9 1.9 0 0 1 1.9 1.9v3.2a1.9 1.9 0 0 1-3.8 0V4.5A1.9 1.9 0 0 1 8 2.6z',
    'M4.6 7.4a3.4 3.4 0 0 0 6.8 0',
    'M8 10.8v2.6',
    'M6 13.4h4',
  ],

  /**
   * An envelope. It WAS a single speech bubble, and beside `chat`'s two
   * bubbles the pair read as one idea drawn twice — "the messages icon looks
   * like chat" (Subhang, 2026-10-18). A message is one thing sent to an
   * anchor; the envelope is the one silhouette in the set with no bubble in it,
   * so chat keeps sole ownership of the bubble.
   */
  message: [
    'M3.8 3.6h8.4a1.4 1.4 0 0 1 1.4 1.4v6a1.4 1.4 0 0 1-1.4 1.4H3.8a1.4 1.4 0 0 1-1.4-1.4V5a1.4 1.4 0 0 1 1.4-1.4z',
    'M2.8 4.6 8 8.4l5.2-3.8',
  ],

  /** A person. */
  member: ['M8 8.3a2.6 2.6 0 1 0 0-5.2 2.6 2.6 0 0 0 0 5.2z', 'M3.3 13.6a4.7 4.7 0 0 1 9.4 0'],

  /**
   * A bot's head, deliberately the same SIZE and position as `member`'s head:
   * these two kinds answer one question — who is this — and the difference
   * between a human and an agent is the whole answer, so it is drawn as a
   * silhouette difference (round head + shoulders vs. square head + antenna)
   * rather than as an ornament.
   */
  team_member: [
    'M8 2.6v1.8',
    'M4.4 4.4h7.2a1.6 1.6 0 0 1 1.6 1.6v5a1.6 1.6 0 0 1-1.6 1.6H4.4a1.6 1.6 0 0 1-1.6-1.6V6a1.6 1.6 0 0 1 1.6-1.6z',
    'M6.2 7.8v1.2',
    'M9.8 7.8v1.2',
  ],

  /** A branch merging back — how every git host draws a pull request. */
  pull_request: [
    'M4.9 5.6a1.7 1.7 0 1 0 0-3.4 1.7 1.7 0 0 0 0 3.4z',
    'M11.1 5.6a1.7 1.7 0 1 0 0-3.4 1.7 1.7 0 0 0 0 3.4z',
    'M4.9 13.8a1.7 1.7 0 1 0 0-3.4 1.7 1.7 0 0 0 0 3.4z',
    'M4.9 5.6v4.8',
    'M11.1 5.6v1.4a2.6 2.6 0 0 1-2.6 2.6H4.9',
  ],

  /**
   * A node on the line — a commit is one point in a history. The node is
   * drawn LARGE (r 2.7 of a 16 grid) on purpose: at 13px a small circle on a
   * hairline collapses into a vertical stroke, which is no mark at all.
   */
  commit: ['M8 2.2v3', 'M8 10.8v3', 'M8 10.7a2.7 2.7 0 1 0 0-5.4 2.7 2.7 0 0 0 0 5.4z'],

  /**
   * A paperclip. `file` and `doc` are the pair most often confused (both were
   * squares), so they are drawn from different worlds entirely: a doc is a
   * page you wrote, a file is a thing you ATTACHED.
   */
  file: [
    'M11.8 7.9 7.4 12.3a2.7 2.7 0 0 1-3.8-3.8l5.3-5.3a1.8 1.8 0 0 1 2.5 2.5l-5.3 5.3a.9.9 0 0 1-1.3-1.3l4.7-4.7',
  ],

  /** A wand and a spark — a spell is cast. */
  spell: ['M3.2 12.8 9.6 6.4', 'M11.8 2.4l.85 2.05 2.05.85-2.05.85-.85 2.05-.85-2.05L8.9 5.3l2.05-.85z', 'M5.6 3.4v1.7', 'M4.75 4.25h1.7'],

  /**
   * A mortarboard — a skill is something LEARNED and then equipped. It was a
   * closed book, and beside `story`'s open book the two were the same
   * silhouette at 14px (2026-10-18). No book here at all, so the pair cannot
   * converge again; `spell` stays a wand, the act rather than the know-how.
   */
  skill: [
    'M8 3 14 6 8 9 2 6z',
    'M4.6 7.3v3.1c0 .9 1.5 1.9 3.4 1.9s3.4-1 3.4-1.9V7.3',
    'M14 6v3.6',
  ],

  /** Four tiles — a set of things gathered into one. */
  collection: ['M3 3h4.2v4.2H3z', 'M8.8 3H13v4.2H8.8z', 'M3 8.8h4.2V13H3z', 'M8.8 8.8H13V13H8.8z'],

  /** A folder — a project is a place on disk that holds the work. */
  project: [
    'M2.6 5.2a1.4 1.4 0 0 1 1.4-1.4h2.1l1.5 1.8h4.4a1.4 1.4 0 0 1 1.4 1.4v4.6a1.4 1.4 0 0 1-1.4 1.4H4a1.4 1.4 0 0 1-1.4-1.4z',
  ],

  /** Sliders — a profile is the dials a session is launched with. */
  interaction_profile: [
    'M2.8 5.4h10.4',
    'M2.8 10.6h10.4',
    'M6.2 7a1.6 1.6 0 1 0 0-3.2 1.6 1.6 0 0 0 0 3.2z',
    'M10 12.2a1.6 1.6 0 1 0 0-3.2 1.6 1.6 0 0 0 0 3.2z',
  ],

  /** A bookmark — a memory is a claim deliberately kept. */
  // A closed circular arrow — the shape every scheduler in the world uses.
  loop: ['M8 3.2a4.8 4.8 0 1 0 4.53 3.2M12.8 3.2v3.2h-3.2'],
  memory: ['M4.4 3.4a1.4 1.4 0 0 1 1.4-1.4h4.4a1.4 1.4 0 0 1 1.4 1.4v10.2L8 11.2l-3.6 2.4z'],

  /**
   * A flowchart: two boxes joined by an elbow — one blueprint, vertices AND
   * the flow between them (Craft P1). It was three ringed nodes, which is
   * `pull_request` mirrored; boxes are what keep it off every circle-and-line
   * mark in the set (`pull_request`, `commit`, `VIEW_ART.graph`, `git`).
   */
  graph: ['M2.4 2.6h5v4h-5z', 'M8.6 9.4h5v4h-5z', 'M4.9 6.6v3.8a1 1 0 0 0 1 1h2.7'],

  /**
   * THE chat mark: a bubble with a tail, and a second one answering behind it.
   *
   * ONE mark for chat everywhere — the kind, the rail and phone Chats rows,
   * the ActionStrip Chat button and the "Chat" verb all draw THIS array, and
   * `kind-art.test.ts` fails if a bubble is drawn anywhere else. A chat is a
   * CONVERSATION — two speakers, durable — which the two bubbles say; nothing
   * else in the set is bubble-shaped (`message` is an envelope).
   */
  chat: [
    'M2.4 3.8a1.4 1.4 0 0 1 1.4-1.4h5.6a1.4 1.4 0 0 1 1.4 1.4v3.6a1.4 1.4 0 0 1-1.4 1.4H5.4L2.4 11.2z',
    'M10.8 5.6h1.4a1.4 1.4 0 0 1 1.4 1.4v6.6l-2.4-2H7a1.4 1.4 0 0 1-1.4-1.4v-.6',
  ],

  /**
   * A pencil, and the stroke it left.
   *
   * The stroke is the half that carries the meaning. A pencil alone is an
   * EDIT mark — it is what every "rename this" affordance in the app already
   * uses — so a pencil by itself would read as "edit", not "a drawing". The
   * loose line underneath is what makes it a hand-drawn thing rather than an
   * action, and it is deliberately not straight: `graph` owns straight lines
   * between nodes, and the two marks must not converge at 16px.
   */
  drawing: [
    'M11.4 2.7 13.3 4.6 6.9 11 4.1 11.9 5 9.1z',
    'M10.1 4 12 5.9',
    'M2.6 14c1.6-1.5 3.1.6 4.7-.7',
  ],

  /**
   * An option list: two empty checkboxes, each with its answer line — a form
   * is something you FILL IN. It was a clipboard with a list, which at 14px is
   * a page with lines, i.e. `doc` (2026-10-18). No page outline now, so doc
   * owns the sheet; the boxes are small and EMPTY, so it is not `task`'s one
   * large checked box, and there is no frame, so it is not `container`.
   */
  form: [
    'M3.2 2.8h2.6a.6.6 0 0 1 .6.6V6a.6.6 0 0 1-.6.6H3.2a.6.6 0 0 1-.6-.6V3.4a.6.6 0 0 1 .6-.6z',
    'M8.4 4.7h5',
    'M3.2 9.4h2.6a.6.6 0 0 1 .6.6v2.6a.6.6 0 0 1-.6.6H3.2a.6.6 0 0 1-.6-.6V10a.6.6 0 0 1 .6-.6z',
    'M8.4 11.3h5',
  ],

  /**
   * A key (`key-round`, 999/W10a): a round bow and a toothed shaft. A space
   * credential is what a session is let in with.
   */
  /** A plug: a connector links an external tool service. */
  tool: ['M9.5 2.5a3 3 0 0 0-3.7 3.7L2.7 9.3a1.6 1.6 0 0 0 2.3 2.3l3.1-3.1a3 3 0 0 0 3.7-3.7L10 6.6 8.4 5z'],
  mcp_server: ['M5.5 2.5v3M10.5 2.5v3', 'M4 5.5h8v2a4 4 0 0 1-8 0z', 'M8 11.5v2'],

  credential: [
    'M5.6 4a2.8 2.8 0 1 0 0 5.6 2.8 2.8 0 1 0 0-5.6z',
    'M8.2 7.8l5 5',
    'M11 10.6l1.4-1.4M12.4 12l1.2-1.2',
  ],

  /** A sealed package — an artifact is a published bundle, bytes and all. */
  artifact: ['M8 2.4 13.4 5.3v5.4L8 13.6 2.6 10.7V5.3z', 'M2.6 5.3 8 8.2l5.4-2.9', 'M8 8.2v5.4'],

  /** A second sheet behind the first — a worktree is another copy of the tree. */
  worktree: [
    'M6.2 5.8h5.6a1.4 1.4 0 0 1 1.4 1.4v5.6a1.4 1.4 0 0 1-1.4 1.4H6.2a1.4 1.4 0 0 1-1.4-1.4V7.2a1.4 1.4 0 0 1 1.4-1.4z',
    'M10.4 5.8V4.2a1.4 1.4 0 0 0-1.4-1.4H4.2a1.4 1.4 0 0 0-1.4 1.4V9a1.4 1.4 0 0 0 1.4 1.4h.6',
  ],

  /**
   * A RACK — two stacked bays with a status lamp in each. A container is a
   * machine, and this is how the world draws one.
   *
   * DELIBERATELY NOT A PLAIN BOX, and not the `▣` the design named in §13.1:
   * that glyph is already `file`'s, and the whole point of this set is that no
   * two kinds share a silhouette (`registry.test.ts` fails on duplicate
   * artwork). The lamps are what make it a MACHINE at 13px rather than another
   * quadrilateral — the exact failure mode this module's header describes,
   * where thirteen of twenty marks collapsed into one lozenge.
   *
   * Read against its nearest neighbours: `worktree` is two offset sheets,
   * `file` a paperclip, `artifact` a sealed package, `task` a checked box.
   * None of them is a divided box with dots.
   */
  container: [
    'M3.8 2.8h8.4a1.4 1.4 0 0 1 1.4 1.4v7.6a1.4 1.4 0 0 1-1.4 1.4H3.8a1.4 1.4 0 0 1-1.4-1.4V4.2a1.4 1.4 0 0 1 1.4-1.4z',
    'M2.4 8h11.2',
    'M5.4 6.1a0.7 0.7 0 1 0 0-1.4 0.7 0.7 0 0 0 0 1.4z',
    'M5.4 11.3a0.7 0.7 0 1 0 0-1.4 0.7 0.7 0 0 0 0 1.4z',
  ],

  /**
   * Two overlapping rings — two spaces, joined (250). It was a chain, and the
   * chain is what the Links (connections) button draws, so an entity and a
   * panel section wore one mark. Not two-way arrows either: ⇄ is the Transfer
   * verb's glyph, and moving an entity between spaces is not linking them.
   */
  space_link: [
    'M6 4.2a3.8 3.8 0 1 0 0 7.6 3.8 3.8 0 0 0 0-7.6z',
    'M10 4.2a3.8 3.8 0 1 0 0 7.6 3.8 3.8 0 0 0 0-7.6z',
  ],

  /**
   * A globe — a `server` is another tm8 node (250, used from W8). Not a rack:
   * that silhouette is `container`'s.
   */
  server: [
    'M8 2.6a5.4 5.4 0 1 0 0 10.8 5.4 5.4 0 0 0 0-10.8z',
    'M2.6 8h10.8',
    'M8 2.6c1.6 1.5 2.2 3.4 2.2 5.4s-.6 3.9-2.2 5.4c-1.6-1.5-2.2-3.4-2.2-5.4s.6-3.9 2.2-5.4z',
  ],

  /**
   * A painter's palette — a `style` is a theme for the whole UI (284). The
   * thumb hole and three paint wells are what keep it from reading as a
   * generic blob or as `drawing`'s pencil at 16px.
   */
  style: [
    'M8 2.6c-3 0-5.4 2.2-5.4 5 0 2.8 2.4 5.8 5.4 5.8.9 0 1.4-.6 1.4-1.3 0-.9-.7-1.2-.7-2 0-.7.6-1.2 1.4-1.2h1.5c1.8 0 2.8-1.1 2.8-2.6 0-2-2.2-3.7-4.9-3.7z',
    'M5.2 7.4a0.8 0.8 0 1 0 0-1.6 0.8 0.8 0 0 0 0 1.6z',
    'M7.6 5.4a0.8 0.8 0 1 0 0-1.6 0.8 0.8 0 0 0 0 1.6z',
    'M10.4 6a0.8 0.8 0 1 0 0-1.6 0.8 0.8 0 0 0 0 1.6z',
  ],

  /**
   * The custom-kind fallback. A plain diamond ON PURPOSE: it is the one mark
   * that must say "this kind has no artwork of its own", so it stays the
   * neutral shape the old set used for exactly that job.
   */
  custom: ['M8 2.6 13.4 8 8 13.4 2.6 8z'],

  /**
   * An open book (283, the story page artifact 01a0fc3e rev 4's `ART.story`).
   * The two facing pages with a line on each are what separate it from
   * `skill`'s bound, closed book: a story is read across, page to page.
   */
  story: [
    'M8 4.2C6.9 3.3 5.5 2.9 3 2.9v8.6c2.5 0 3.9.4 5 1.3',
    'M8 4.2c1.1-.9 2.5-1.3 5-1.3v8.6c-2.5 0-3.9.4-5 1.3',
    'M8 4.2v8.6',
    'M5 6.2h1.4',
    'M9.6 6.2H11',
  ],

  /**
   * Layers — a craft is an ordered stack of pages. It was two sheets, one
   * behind the other, which is `worktree`'s silhouette (2026-10-18). Shared
   * with the Craft rail VIEW on purpose, the way `channels` shares `channel`.
   */
  craft: ['M8 2.6 13.4 5.4 8 8.2 2.6 5.4z', 'M2.6 8 8 10.8 13.4 8', 'M2.6 10.6 8 13.4l5.4-2.8'],
} as const satisfies Record<string, KindArt>;
