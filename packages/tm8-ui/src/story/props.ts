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

export interface StoryBlockProps {
  view: StoryView;
  actions: StoryActions;
  live?: StoryLive | null;
  hover?: StoryRootHover | null;
  /** Absent = only the agent teammates already on the story can run a launch. */
  runners?: readonly StoryRunner[] | null;
}

/** A node the user clicked, in the graph or a card — opens the node popover. */
export interface StoryNodePick {
  entityId: string;
  /** Viewport rect of the clicked element; the popover anchors to it. */
  anchor: { x: number; y: number; width: number; height: number };
}
