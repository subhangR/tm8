import type { StoryBlockProps, StoryNodePick } from '../props';

export interface StoryGraphProps extends StoryBlockProps {
  /** Click on any node (story, child story, root, child, trail item, teammate, capsule). */
  onPick?: (pick: StoryNodePick) => void;
}
