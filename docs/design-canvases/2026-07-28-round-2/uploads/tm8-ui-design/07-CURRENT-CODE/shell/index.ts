/**
 * Shell barrel (Layer 3). Atlas mounts `ShellLayout`; W2/W3 plug into
 * `ViewRegistry` (center views) and `PanelSlot` (panel bodies).
 */
import './shell.css';

export { ShellLayout, type ShellLayoutProps } from './ShellLayout';
export { IconRail, type IconRailProps } from './IconRail';
export { LeftRail, RAIL_SECTIONS, type LeftRailProps } from './LeftRail';
export { CenterHost, type CenterHostProps } from './CenterHost';
export { PanelStack, MAX_SPLITS, MAX_SPLIT_COLUMNS, type PanelStackProps } from './PanelStack';
export { PlaceholderView, PlaceholderPanelBody, PLACEHOLDER_VIEWS } from './placeholders';
export { Icon, type IconName } from './icons';

export {
  startRouter, buildHash, isRoutableHash, createBrowserTarget, createMemoryTarget,
  type RouterTarget, type MemoryTarget, type RouterOptions,
} from './router';

export {
  createKeyboardMap, installKeyboard, useKeyboardMap, createListKeyNav, isTypingTarget,
  DEFAULT_VIEW_JUMPS, CHORD_TIMEOUT_MS,
  type KeyboardMap, type KeyboardOptions, type KeyEventLike, type KeyAction, type ListKeyNavOptions,
} from './keyboard';

export {
  useSpaces, useSpaceNavigation, useSectionCounts, useUnreadInbox, useAsyncValue,
  SECTION_QUERIES, type AsyncValue,
} from './useShellData';

export type {
  ShellViewProps, ViewComponent, ViewRegistry, PanelSlot, PanelSlotProps, RailSection,
} from './types';
