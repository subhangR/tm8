import {
  ComposerInteractionPolicySchema,
  FeedPolicySchema,
  type ComposerInteractionPolicy,
  type FeedPolicy,
  type WorkSessionInteractionProfileProjection,
} from '@tm8/contract';

import { STATIC_CHAT_TEMPLATE_REGISTRY } from './w2-profile-resolver.js';

export interface InteractionProfilePinProjectionInput {
  readonly pinRevision: number;
  readonly templateKey: string;
  readonly templateVersion: number;
  readonly snapshot: Record<string, unknown>;
}

const CORE_FEED_POLICY: FeedPolicy = Object.freeze({
  scope: 'session_chat_v1',
  pageSize: 50,
  bodyExcerptBytes: 1024,
});

const CORE_COMPOSER_POLICY: ComposerInteractionPolicy = Object.freeze({
  schemaRef: 'tm8.composer.v1',
  supportsReply: true,
  supportsAttachments: true,
  allowedAttachmentKinds: Object.freeze(['file']) as unknown as string[],
  operationBindings: Object.freeze([
    'messages.post',
    'files.uploadInit',
    'files.uploadComplete',
    'files.uploadAbort',
    'messages.attachments.add',
    'messages.attachments.remove',
  ]) as unknown as ComposerInteractionPolicy['operationBindings'],
});

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/**
 * The only pin-to-browser projector. It selects a closed set of safe fields
 * and never forwards the snapshot object, so prompt/tool/credential policy
 * cannot cross the dual-audience boundary by accident.
 */
export function projectInteractionProfileForBrowser(
  input: InteractionProfilePinProjectionInput,
): WorkSessionInteractionProfileProjection {
  const template = STATIC_CHAT_TEMPLATE_REGISTRY.find(
    (entry) => entry.key === input.templateKey && entry.version === input.templateVersion,
  );
  const browser = record(input.snapshot.browserProjection);

  const feed = FeedPolicySchema.safeParse(
    browser?.feedPolicy ?? input.snapshot.feedPolicy ?? CORE_FEED_POLICY,
  );
  const composer = ComposerInteractionPolicySchema.safeParse(
    browser?.composerPolicy ?? input.snapshot.composerPolicy ?? CORE_COMPOSER_POLICY,
  );
  const feedPolicy = feed.success ? feed.data : CORE_FEED_POLICY;
  const composerPolicy = composer.success ? composer.data : CORE_COMPOSER_POLICY;
  const requestedInitial = browser?.initialContentSurface;
  const chatEnabled = feedPolicy.scope === 'session_chat_v1'
    && composerPolicy.operationBindings.includes('messages.post');

  return {
    pinRevision: input.pinRevision,
    templateKey: input.templateKey,
    templateVersion: input.templateVersion,
    compatibility: template ? 'supported' : 'unknown_template',
    chatEnabled,
    initialContentSurface: !template
      ? 'terminal'
      : requestedInitial === 'terminal' || requestedInitial === 'chat'
        ? requestedInitial
        : template.initialContentSurface,
    feedPolicy,
    composerPolicy,
  };
}
