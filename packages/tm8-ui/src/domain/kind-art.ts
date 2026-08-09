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
 * message = a bubble, member = a person, teammate = a bot, PR = a branch,
 * commit = a node on a line, file = a paperclip, project = a folder, worktree
 * = a second copy. Two rules hold the set together: no two kinds share a
 * silhouette (guarded — `registry.test.ts` fails on duplicate artwork), and
 * kinds that live near each other in the UI are drawn as far apart as the
 * grid allows (`doc` a page with a fold, `skill` a bound book, `file` a clip).
 *
 * THE GRID: 16×16, artwork inset to ~2.4–13.6, stroked at 1.4 in
 * `currentColor` with round caps and joins. Nothing is filled — a filled mark
 * would read as "selected" beside the stroked ones, and tone is already how
 * this UI says state (`chip.tintBy`).
 *
 * Kind literals are legal here: `src/domain/` is one of the two directories
 * §15.2 permits them in, and this is the file that defines them.
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
   * A speech bubble, NOT the inherited envelope. A tm8 message is a line in a
   * conversation; an envelope promises mail, which is a different product.
   */
  message: ['M13.2 9.6a1.9 1.9 0 0 1-1.9 1.9H6.5L3.4 13.8V5.1a1.9 1.9 0 0 1 1.9-1.9h6a1.9 1.9 0 0 1 1.9 1.9z'],

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
   * A bound book — a skill is standing knowledge you equip, not an act you
   * perform. Spell and skill sit side by side in the rail and were ✧ and ✦,
   * which is the single worst pair in the inherited set.
   */
  skill: [
    'M8 4.4c-1.3-1-2.8-1.5-4.8-1.5v8.4c2 0 3.5.5 4.8 1.5',
    'M8 4.4c1.3-1 2.8-1.5 4.8-1.5v8.4c-2 0-3.5.5-4.8 1.5',
    'M8 4.4v8.4',
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

  /** A sealed package — an artifact is a published bundle, bytes and all. */
  artifact: ['M8 2.4 13.4 5.3v5.4L8 13.6 2.6 10.7V5.3z', 'M2.6 5.3 8 8.2l5.4-2.9', 'M8 8.2v5.4'],

  /** A second sheet behind the first — a worktree is another copy of the tree. */
  worktree: [
    'M6.2 5.8h5.6a1.4 1.4 0 0 1 1.4 1.4v5.6a1.4 1.4 0 0 1-1.4 1.4H6.2a1.4 1.4 0 0 1-1.4-1.4V7.2a1.4 1.4 0 0 1 1.4-1.4z',
    'M10.4 5.8V4.2a1.4 1.4 0 0 0-1.4-1.4H4.2a1.4 1.4 0 0 0-1.4 1.4V9a1.4 1.4 0 0 0 1.4 1.4h.6',
  ],

  /**
   * The custom-kind fallback. A plain diamond ON PURPOSE: it is the one mark
   * that must say "this kind has no artwork of its own", so it stays the
   * neutral shape the old set used for exactly that job.
   */
  custom: ['M8 2.6 13.4 8 8 13.4 2.6 8z'],
} as const satisfies Record<string, KindArt>;

/**
 * VIEW ARTWORK — the rail's non-entity rows (Dashboard, Feed, …).
 *
 * Here for the same reason the kinds are: the rail draws views and kinds in
 * one column, so a drawn kind mark beside a text view glyph would be two
 * idioms in one list. Two of the inherited view glyphs also COLLIDED with kind
 * glyphs outright — `graph: ◉` was the commit mark and `channels: #` the
 * channel mark — which is the same defect one level up.
 */
export const VIEW_ART = {
  /** A house. */
  dashboard: ['M2.8 7.2 8 2.8l5.2 4.4v5.4a1.2 1.2 0 0 1-1.2 1.2H4a1.2 1.2 0 0 1-1.2-1.2z', 'M6.4 13.4V9.2h3.2v4.2'],
  /** Broadcast arcs — a feed is a stream arriving. */
  feed: ['M4 12.5v.01', 'M3.9 8.6a3.9 3.9 0 0 1 3.9 3.9', 'M3.9 4.9a7.6 7.6 0 0 1 7.6 7.6'],
  /** A tray. */
  inbox: [
    'M2.4 9.4h3.4l.9 1.7h2.6l.9-1.7h3.4',
    'M4.5 3.4h7l2.1 6v2.6a1.4 1.4 0 0 1-1.4 1.4H3.8a1.4 1.4 0 0 1-1.4-1.4V9.4z',
  ],
  /** A panelled frame — the workspace is the two-pane surface. */
  workspace: [
    'M2.6 4a1.4 1.4 0 0 1 1.4-1.4h8a1.4 1.4 0 0 1 1.4 1.4v8a1.4 1.4 0 0 1-1.4 1.4H4a1.4 1.4 0 0 1-1.4-1.4z',
    'M6.6 2.6v10.8',
  ],
  /** Nodes and edges. */
  graph: [
    'M8 5.7a1.6 1.6 0 1 0 0-3.2 1.6 1.6 0 0 0 0 3.2z',
    'M4.2 13.4a1.6 1.6 0 1 0 0-3.2 1.6 1.6 0 0 0 0 3.2z',
    'M11.8 13.4a1.6 1.6 0 1 0 0-3.2 1.6 1.6 0 0 0 0 3.2z',
    'M7 5.6 5.2 10.2',
    'M9 5.6l1.8 4.6',
  ],
  /** The hash, shared with the `channel` kind ON PURPOSE — it is that list. */
  channels: KIND_ART.channel,
  /**
   * A gear, drawn as a real toothed outline rather than as radial ticks
   * around a circle. The tick version is the shape a sun/brightness control
   * uses, and this app HAS a theme toggle — "settings" and "brightness" are
   * two different promises and must not share a silhouette.
   */
  settings: [
    'M6.93 2.15L9.07 2.15L8.67 3.55L10.67 4.38L11.38 3.11L12.89 4.62L11.62 5.33L12.45 7.33L13.85 6.93L13.85 9.07L12.45 8.67L11.62 10.67L12.89 11.38L11.38 12.89L10.67 11.62L8.67 12.45L9.07 13.85L6.93 13.85L7.33 12.45L5.33 11.62L4.62 12.89L3.11 11.38L4.38 10.67L3.55 8.67L2.15 9.07L2.15 6.93L3.55 7.33L4.38 5.33L3.11 4.62L4.62 3.11L5.33 4.38L7.33 3.55z',
    'M8 10.1a2.1 2.1 0 1 0 0-4.2 2.1 2.1 0 0 0 0 4.2z',
  ],
} as const satisfies Record<string, KindArt>;
