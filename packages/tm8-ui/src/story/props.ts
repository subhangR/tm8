/**
 * The one prop shape every story block takes. Blocks own their own local UI
 * state (view switcher, scope, paused, open sheet) and render ONLY from
 * `view`; they change the world ONLY through `actions` (absent member = the
 * affordance is not drawn).
 */
import type { StoryActions } from './actions';
import type { StoryView } from './model';

export interface StoryBlockProps {
  view: StoryView;
  actions: StoryActions;
}

/** A node the user clicked, in the graph or a card — opens the node popover. */
export interface StoryNodePick {
  entityId: string;
  /** Viewport rect of the clicked element; the popover anchors to it. */
  anchor: { x: number; y: number; width: number; height: number };
}
