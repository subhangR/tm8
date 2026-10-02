/**
 * The one prop shape every story block takes. Blocks own their own local UI
 * state (view switcher, scope, open sheet) and render ONLY from `view`; they
 * change the world ONLY through `actions` (absent member = the affordance is
 * not drawn). `live` is the event feed's state from `data/useStoryLive`;
 * absent = a static read (fixture, snapshot) and the live affordances hide.
 */
import type { StoryActions } from './actions';
import type { StoryView } from './model';

export interface StoryLive {
  status: 'live' | 'paused' | 'reconnecting';
  paused: boolean;
  setPaused: (paused: boolean) => void;
  /** Events held while paused. */
  queued: number;
  updatesLastMinute: number;
  /** Ids to flash (node, root row, stat), cleared by the hook after ~1.2 s. */
  landed: ReadonlySet<string>;
}

/**
 * The root the user is pointing at, shared by the graph and the Roots card so
 * hovering a root in either lights that root's trail in both (artifact rev 4).
 * Absent = the block keeps hover to itself.
 */
export interface StoryRootHover {
  rootId: string | null;
  setRootId: (rootId: string | null) => void;
}

/**
 * An agent teammate in the SPACE that can run a session: the host's launch
 * roster (`data.launch.teammates`, recency-ordered, the launch dialog's own
 * list and default). The playground's "as" picker offers these, so a story
 * with nobody on it yet can still get its first session.
 */
export interface StoryRunner {
  id: string;
  name: string;
  mode?: string | null;
}

/** How far from a root the page shows: 1..3 hops (depth). The server always follows 3. */
export type StoryHops = 1 | 2 | 3;

/**
 * The page's graph filter, shared so the graph and the Roots card agree.
 * Held by StoryPage and persisted in the URL (?hops=2&kinds=task,doc).
 * VIEW ONLY: headline progress and stats stay the server's story figures.
 */
export interface StoryGraphFilter {
  hops: StoryHops;
  setHops: (hops: StoryHops) => void;
  /** Kinds shown in the Everything view; null = every kind present. */
  kinds: ReadonlySet<string> | null;
  setKinds: (kinds: ReadonlySet<string> | null) => void;
}

export interface StoryBlockProps {
  view: StoryView;
  actions: StoryActions;
  live?: StoryLive | null;
  hover?: StoryRootHover | null;
  /** Absent = only the agent teammates already on the story can run a launch. */
  runners?: readonly StoryRunner[] | null;
  /**
   * The entity whose detail panel is open beside the story (Subhang,
   * 2026-10-02: pressing any entity opens its details on the right). Blocks
   * draw it highlighted. Null/absent = nothing selected.
   */
  selectedId?: string | null;
  /**
   * PRIMARY press on any entity: the shell opens its detail panel beside the
   * story and marks it selected. Every clickable entity (graph node or capsule,
   * root row, child, trail chip, child story, teammate, session, activity row,
   * feed row -> its anchor) calls this.
   */
  onPick?: (pick: StoryNodePick) => void;
  /**
   * SECONDARY affordance (a small "…" on hover, or right-click): opens the
   * action popover (message, new task under, spawn here, dispatch here, mark
   * done) anchored to the element. Absent = no "…" drawn.
   */
  onMenu?: (pick: StoryNodePick) => void;
  /** Absent = full depth, every kind (and no controls drawn). */
  filter?: StoryGraphFilter | null;
}

/** A node the user clicked, in the graph or a card — opens the node popover. */
export interface StoryNodePick {
  entityId: string;
  /** Viewport rect of the clicked element; the popover anchors to it. */
  anchor: { x: number; y: number; width: number; height: number };
}
