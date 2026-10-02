/* STUB — owned by the playground worker; replace wholesale. Props are the agreed seam.
 * Renders the floating plus, binds Cmd-K / Ctrl-K to the "Add anything" sheet,
 * and renders the node popover for `pick` (null = closed). */
import type { StoryBlockProps, StoryNodePick } from '../props';

export interface StoryPlaygroundProps extends StoryBlockProps {
  pick: StoryNodePick | null;
  onClosePick: () => void;
}

export function StoryPlayground(_props: StoryPlaygroundProps) {
  return null;
}
