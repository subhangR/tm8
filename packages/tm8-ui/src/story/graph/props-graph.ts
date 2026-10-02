import type { StoryGraphView } from '../model';
import type { StoryBlockProps, StoryNodePick } from '../props';

export interface StoryGraphProps extends StoryBlockProps {
  /** Click on any node (story, child story, root, child, trail item, teammate, capsule). Absent = nodes are not clickable. */
  onPick?: (pick: StoryNodePick) => void;
  /** The view the switcher opens on (the harness passes `?view=`). Default: Everything. */
  initialView?: StoryGraphView;
}
