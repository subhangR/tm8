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
 * SPLIT (t-p0-client-core, 2026-10-29): the per-kind table (`KIND_ART`) moved to
 * `@tm8/client-core/kinds`, where `KIND_CORE` reads it for both apps. It is
 * re-exported here, so the views and surfaces below still sit beside it.
 */

import type { ContentSurface } from '@tm8/client-core/routes';
import { KIND_ART, type KindArt } from '@tm8/client-core/kinds';

export { KIND_ART, type KindArt };

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
   * The envelope, shared with the `message` kind ON PURPOSE: this row opens
   * the browser over every message in the space, so it IS that list (the
   * `channels` rule). It was two overlapping bubbles — the chat mark in all
   * but name, which is how "the messages icon looks like chat" happened.
   */
  messages: KIND_ART.message,
  /** A branch: trunk with a fork, node dots at the tips (Git UI wave). */
  git: [
    'M5.2 5.4a1.6 1.6 0 1 0 0-3.2 1.6 1.6 0 0 0 0 3.2z',
    'M5.2 13.8a1.6 1.6 0 1 0 0-3.2 1.6 1.6 0 0 0 0 3.2z',
    'M11.6 6.6a1.6 1.6 0 1 0 0-3.2 1.6 1.6 0 0 0 0 3.2z',
    'M5.2 5.4v5.2',
    'M11.6 6.6c0 2.6-2.2 2.6-4 3.4',
  ],
  /**
   * A file TREE — the Files EXPLORER view (2026-08-10): a folder line with two
   * files hanging off it. It was an open folder, which beside `project`'s
   * closed folder is the same silhouette at 14px; and it is deliberately NOT
   * `KIND_ART.file` either — the `file` kind row and this browser are two
   * different destinations (owner ruling R9).
   */
  files: ['M3.2 2.8h3.2', 'M4.4 2.8v8.6h3.2', 'M4.4 7.2h3.2', 'M7.6 6h5v2.4h-5z', 'M7.6 10.2h5v2.4h-5z'],
  /**
   * Three columns of descending height — the kanban silhouette (Board tab,
   * 2026-08-16). Deliberately NOT `KIND_ART.task`: the Board is a VIEW over
   * the task collection, and the task kind row sits in the same rail idiom;
   * the columns are the surface itself drawn, not the things on it.
   */
  board: [
    'M2.6 3.4a.8.8 0 0 1 .8-.8h1.2a.8.8 0 0 1 .8.8v9.2a.8.8 0 0 1-.8.8H3.4a.8.8 0 0 1-.8-.8z',
    'M6.6 3.4a.8.8 0 0 1 .8-.8h1.2a.8.8 0 0 1 .8.8v5.2a.8.8 0 0 1-.8.8H7.4a.8.8 0 0 1-.8-.8z',
    'M10.6 3.4a.8.8 0 0 1 .8-.8h1.2a.8.8 0 0 1 .8.8v3.2a.8.8 0 0 1-.8.8h-1.2a.8.8 0 0 1-.8-.8z',
  ],
  /**
   * The Craft studio wears the `craft` kind's layers — the rail row IS the
   * list of crafts. It was a pencil over a node, which beside `drawing`'s
   * pencil read as the same tool.
   */
  craft: KIND_ART.craft,
  /**
   * A question mark, hook and dot (Help, 2026-08-19). Deliberately NOT a
   * circled `?` and NOT a lifebuoy: `KIND_ART.commit` is a bare ring and the
   * artifact mark is a hexagon, so a ringed glyph at 16px would read as one of
   * those with noise inside it. The bare hook is the one silhouette in this
   * table nothing else claims, and it is the mark a reader already knows.
   */
  help: [
    'M5.4 5.8a2.6 2.6 0 1 1 3.5 2.45c-.72.27-1.02.82-1.02 1.53v.72',
    'M7.88 12.5a.78.78 0 1 0 0 1.56.78.78 0 0 0 0-1.56z',
  ],
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

/**
 * THE WORK-SESSION CONTENT SURFACES — Terminal · Transcript · Git · Debug · Graph.
 *
 * A THIRD table rather than more entries in the other two, because these name
 * neither a kind nor a rail view: they are the five panes of one panel. Keeping
 * them apart is what lets `git` and `graph` REUSE a `VIEW_ART` mark by pointing
 * at it — a deliberate shared silhouette, visible as one line here, instead of
 * a second copy of the same path data that drifts the first time one is edited.
 *
 * WHY THE CHIPS BECAME MARKS AT ALL: the five labels were text, and together
 * with a labelled Terminate they made `.pn-panelbar__end` wide enough that the
 * four panel tabs — the flexible side of that row — scrolled "Connections" to a
 * stub and "Activity" off the edge entirely, behind a hidden scrollbar. See
 * `TabStrip` in `panels/detail/chrome.tsx`.
 */
export const SURFACE_ART = {
  /**
   * A PROMPT AND A CARET, with no window around them — deliberately NOT
   * `KIND_ART.work_session`, which is a prompt INSIDE a terminal window.
   *
   * That mark means "a session", and it is already on screen a few pixels away
   * in the panel header's own glyph slot. Reusing it here would put one
   * silhouette on the thing and on one of its five parts — exactly the "ten of
   * them are the same small blob" failure this file exists to prevent. Dropping
   * the chrome and keeping the prompt says "the terminal ITSELF".
   */
  terminal: ['M3.4 4.6 7 8l-3.6 3.4', 'M8.6 11.6h4'],

  /**
   * DIALOGUE LINES — what was said, written down: two lines from one side,
   * two from the other. It was a bubble with lines in it, and a bubble is
   * `chat`'s alone now (`kind-art.test.ts`). Distinct from `debug` (ticked
   * rows) and `logs` (one ragged column) by the alternating indent.
   */
  transcript: ['M2.6 4h6.4', 'M2.6 6.6h4.4', 'M7 9.4h6.4', 'M9 12h4.4'],

  /**
   * A DIFF: a `+` row above a `−` row.
   *
   * Not the branch mark (`git`, below) and not a page: this surface is not
   * about where the lane is or which document is open, it is about what the
   * lines DID. Plus over minus is the one silhouette that says that without a
   * word, and it is the same vocabulary `DiffView` draws inside the panel — so
   * the tab and its contents agree at a glance.
   */
  changes: ['M3 5.4h2.4', 'M4.2 4.2v2.4', 'M7.4 5.4h5.6', 'M3 10.6h2.4', 'M7.4 10.6h5.6'],

  /** The branch mark, shared with the Git VIEW because it is the same idea. */
  git: VIEW_ART.git,

  /**
   * A LOG: three rows, each a leading tick and a line.
   *
   * Not a bug, and that is the honest choice rather than the obvious one. This
   * surface is the session's CLI JOURNAL — the calls the agent made — so a bug
   * mark would promise a debugger it is not. Not `KIND_ART.doc` either: no page
   * outline, because a journal is a stream and not a sheet.
   */
  debug: ['M3.2 4.4h.01', 'M3.2 8h.01', 'M3.2 11.6h.01', 'M6 4.4h6.8', 'M6 8h6.8', 'M6 11.6h4.2'],

  /**
   * Nodes and edges, shared with the Graph VIEW. Both answer "what is connected
   * to what"; this one is simply scoped to one session, and a different mark
   * for the same question would be a distinction the reader has to invent.
   */
  graph: VIEW_ART.graph,

  /**
   * A SHEET WITH AN ARROW INTO IT — what was handed to the session when it
   * launched: the selections, the prompt, the files. The arrow says "went in",
   * which is the whole difference from `transcript` (what came out).
   */
  context: ['M5.4 2.8h6.2a1 1 0 0 1 1 1v8.4a1 1 0 0 1-1 1H5.4', 'M2.4 8h6.4', 'M6.4 5.6 8.8 8l-2.4 2.4'],

  /**
   * A DISPLAY ON A STAND — the container's `screen` surface (§6.2), the RFB /
   * frame view onto a machine's desktop.
   *
   * Deliberately NOT `KIND_ART.container`, which is a RACK: that mark means the
   * machine itself and sits in the panel header a few pixels away. This one
   * means "the picture the machine is painting", which is one of its surfaces —
   * the same thing/part distinction `terminal` draws against
   * `KIND_ART.work_session` at the top of this table.
   */
  screen: ['M2.6 3.6h10.8v6.6H2.6z', 'M6.4 12.6h3.2', 'M8 10.2v2.4'],

  /**
   * THE CONTAINER'S LOG STREAM. Lines of unequal length with no leading ticks
   * — deliberately close to `debug` above without being it, because the two ARE
   * nearly the same idea seen from opposite ends: `debug` is the agent's own
   * journal (its calls, hence the ticks), this is stdout/stderr coming off a
   * machine that knows nothing about agents. Ragged right is what says "a
   * stream someone else is writing".
   */
  logs: ['M3 4.4h9.4', 'M3 7.2h6.6', 'M3 10h8.2', 'M3 12.8h4.8'],
} as const satisfies Record<string, KindArt>;

/**
 * THE WORD FOR EACH SURFACE — the label half of `SURFACE_ART` above.
 *
 * LIFTED HERE FROM `WorkSessionContent` when the container's surfaces joined
 * `ContentSurface` (migration 177). It was a module-private constant while
 * exactly one body drew a surface switcher; now two do, and a second private
 * copy is how the same surface ends up called two things in two panels — the
 * `SURFACE_ART`/`VIEW_ART` sharing note above, one table over.
 *
 * TOTAL over `ContentSurface`, so a surface added to that union without a word
 * for it fails the build here rather than rendering a blank tab.
 */
export const SURFACE_LABEL: Readonly<Record<ContentSurface, string>> = {
  terminal: 'Terminal',
  transcript: 'Transcript',
  changes: 'Changes',
  git: 'Git',
  debug: 'Debug',
  graph: 'Graph',
  context: 'Launch context',
  screen: 'Screen',
  logs: 'Logs',
};
