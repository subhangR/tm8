export { TagSuggestion } from './TagSuggestion';
export {
  ChannelTaggingProvider,
  useChannelTagging,
  type ChannelTaggingController,
} from './context';
export {
  MAX_ANCHOR_ATTACHMENT_PAIRS,
  MAX_MESSAGE_ANCHORS,
  MAX_MESSAGE_ATTACHMENTS,
  MAX_MESSAGE_MENTIONS,
  assertChannelTagLimits,
  buildChannelTagPlan,
  dispatchTaggedChannelMessage,
  mentionsForTaggedDraft,
  tagIdsFromMarkup,
  type ChannelTagCommandPort,
  type ChannelTagPlan,
  type ChannelTagTarget,
  type TaggedChannelMessage,
  type TaggedChannelMessageResult,
} from './model';
