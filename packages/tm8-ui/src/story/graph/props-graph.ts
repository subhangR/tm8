import type { ReactNode } from 'react';
import type { StoryGraphView } from '../model';
import type { StoryBlockProps } from '../props';

/**
 * The graph takes the shared block seam as is: `onPick` (primary press — opens
 * details beside the story), `onMenu` (right-click or the "…" button — the
 * action popover), `selectedId` (drawn with the selection ring), `hover`.
 */
export interface StoryGraphProps extends StoryBlockProps {
  /** The view the switcher opens on (the harness passes `?view=`). Default: Everything. */
  initialView?: StoryGraphView;
  /**
   * Full screen: the card fills its parent's height (the parent must give it
   * one), the canvas takes what the header and legend leave and scrolls both
   * ways, and the drawing may grow past its natural size. Absent = inline.
   */
  fill?: boolean;
  /**
   * FLOATING CHROME (task 01a101c5): when present, the card drops its header
   * rows and draws this node (the story's header chip) over the canvas's
   * top-left corner, with the view switch, hops and a Filters popover — the
   * kind chips, the edge chips, the counts and the legend — in one row under
   * it. Absent ⇒ the stacked header, as before.
   */
  lead?: ReactNode;
}
