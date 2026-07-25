/**
 * Channel Hub screen barrel (L5).
 *
 * `channelViews` is the ViewRegistry fragment Atlas merges into ShellLayout's
 * `views` prop — the `channel` route receives its channel via
 * `ShellViewProps.entityId`.
 *
 * `channelHubSlot()` is the same hub body as `EntityFullViewSlots['hub']`, so
 * promoting a channel panel to the Z4 route renders one implementation, not two.
 */
import './channel.css';

import type { ViewRegistry } from '../../shell';
import { ChannelHub } from './ChannelHub';

export { ChannelHub } from './ChannelHub';
export { ChannelHubBody, type ChannelHubBodyProps } from './ChannelHubBody';
export { ChannelHeader, type ChannelHeaderProps } from './ChannelHeader';
export { ChannelShelf, type ChannelShelfProps } from './ChannelShelf';
export {
  ChannelTabStrip, ChannelTabPane, FEED_TAB_KEY,
  type ChannelTabStripProps, type ChannelTabPaneProps,
} from './ChannelTabs';
export { channelHubSlot } from './hubSlot';
export { useChannelDetail, useChannelTabs } from './useChannelData';
export {
  channelTopic, channelShelf, channelUnread, channelWorkingCount,
} from './projection';

/** ViewRegistry fragment: the `channel` center view. */
export const channelViews: ViewRegistry = { channel: ChannelHub };
