/**
 * T10 CHAT SURFACE — the public face of this lane.
 *
 * The host mounts `ChannelScreen` and passes it a page from `seam.feed(...)`
 * plus dispatchers; everything else here is exported because the host may need
 * to type its own wiring. See `HANDOVER.md` for the exact props, the exact
 * mount points, and the gaps this surface renders as refusals.
 */
export { ChannelScreen, type ChannelScreenProps } from './ChannelScreen';
export { Composer, type ComposerProps } from './Composer';
export {
  canSendAgain,
  clockTime,
  deliveryPresentation,
  deliverySummaryLine,
  directionOf,
  groupByOperation,
  viaTitle,
  type ChannelPostInput,
  type ChannelRefusal,
  type DeliveryPresentation,
  type Direction,
  type DirectionTone,
  type FeedGroup,
} from './feed-model';
