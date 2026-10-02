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
}
