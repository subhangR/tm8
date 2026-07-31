import type { EntityId, Mention } from '../../../types/contract';

/**
 * A selectable `@Tag` destination.
 *
 * The thread subsystem deliberately does not know what a tm8 work-session
 * entity looks like. The real integration projects those rows into one of the
 * two actions below: reuse a session that already exists, or start one for a
 * teammate when the message is sent.
 */
export interface ChannelTagTarget {
  /** The id stored in react-mentions markup. */
  id: EntityId;
  display: string;
  group: 'Team members' | 'Work sessions';
  meta: string;
  route:
    | { kind: 'existing-session'; sessionId: EntityId }
    | { kind: 'spawn-team-member'; teamMemberId: EntityId };
  /** Team-member tags are also durable message mentions. Sessions are not. */
  mention?: Mention;
}

export interface ChannelTagPlan {
  existingSessionIds: EntityId[];
  spawnTeamMemberIds: EntityId[];
  mentionIds: EntityId[];
}

export const MAX_MESSAGE_ANCHORS = 16;
export const MAX_MESSAGE_MENTIONS = 16;
export const MAX_MESSAGE_ATTACHMENTS = 16;
export const MAX_ANCHOR_ATTACHMENT_PAIRS = 64;

/**
 * The markup shape is the one already owned by `body.ts`:
 * `@[display](entity-id)`. Reading selected ids from the CURRENT markup (rather
 * than remembering `onAdd`) means deleting a tag from the textarea really
 * deletes its routing effect too.
 */
export function tagIdsFromMarkup(
  markup: string,
  candidates: readonly ChannelTagTarget[],
): EntityId[] {
  const known = new Set(candidates.map((target) => target.id));
  const found: EntityId[] = [];
  const seen = new Set<EntityId>();
  const token = /@\[[^\]]*\]\(([^)]+)\)/g;
  let match: RegExpExecArray | null;
  while ((match = token.exec(markup)) !== null) {
    const id = match[1];
    if (!known.has(id) || seen.has(id)) continue;
    seen.add(id);
    found.push(id);
  }
  return found;
}

/**
 * Work-session tokens use the same editor markup as mentions so react-mentions
 * can position and delete them correctly, but a session is not a legal
 * `Mention.kind`. Remove those synthetic mentions before the wire payload and
 * replace teammate rows with the server-resolvable teammate mention.
 */
export function mentionsForTaggedDraft(
  parsedMentions: readonly Mention[],
  selectedTagIds: readonly EntityId[],
  candidates: readonly ChannelTagTarget[],
): Mention[] {
  const selected = new Set(selectedTagIds);
  const tags = new Map(candidates.map((target) => [target.id, target]));
  const mentions: Mention[] = [];
  const seen = new Set<EntityId>();

  for (const mention of parsedMentions) {
    const target = selected.has(mention.entityId) ? tags.get(mention.entityId) : undefined;
    const next = target ? target.mention : mention;
    if (!next || seen.has(next.entityId)) continue;
    seen.add(next.entityId);
    mentions.push(next);
  }
  return mentions;
}

export function buildChannelTagPlan(
  selectedIds: readonly EntityId[],
  candidates: readonly ChannelTagTarget[],
): ChannelTagPlan {
  const byId = new Map(candidates.map((target) => [target.id, target]));
  const existingSessionIds: EntityId[] = [];
  const spawnTeamMemberIds: EntityId[] = [];
  const mentionIds: EntityId[] = [];
  const sessionsSeen = new Set<EntityId>();
  const teammatesSeen = new Set<EntityId>();
  const mentionsSeen = new Set<EntityId>();

  for (const id of selectedIds) {
    const target = byId.get(id);
    if (!target) throw new Error(`@Tag target ${id} is no longer available`);

    if (target.route.kind === 'existing-session') {
      if (!sessionsSeen.has(target.route.sessionId)) {
        sessionsSeen.add(target.route.sessionId);
        existingSessionIds.push(target.route.sessionId);
      }
    } else if (!teammatesSeen.has(target.route.teamMemberId)) {
      teammatesSeen.add(target.route.teamMemberId);
      spawnTeamMemberIds.push(target.route.teamMemberId);
    }

    if (target.mention && !mentionsSeen.has(target.mention.entityId)) {
      mentionsSeen.add(target.mention.entityId);
      mentionIds.push(target.mention.entityId);
    }
  }

  return { existingSessionIds, spawnTeamMemberIds, mentionIds };
}

export interface ChannelTagLimitsInput {
  plan: ChannelTagPlan;
  baseMentionIds?: readonly EntityId[];
  attachmentIds?: readonly EntityId[];
}

/**
 * Validate the server's batch bounds BEFORE spawning. A validation refusal
 * after spawn would strand a newly started session without the message that
 * justified starting it.
 */
export function assertChannelTagLimits({
  plan,
  baseMentionIds = [],
  attachmentIds = [],
}: ChannelTagLimitsInput): void {
  const maximumAnchors = 1 + plan.existingSessionIds.length + plan.spawnTeamMemberIds.length;
  const mentions = new Set([...baseMentionIds, ...plan.mentionIds]);

  if (maximumAnchors > MAX_MESSAGE_ANCHORS) {
    throw new Error(`A channel message can tag at most ${MAX_MESSAGE_ANCHORS - 1} session targets`);
  }
  if (mentions.size > MAX_MESSAGE_MENTIONS) {
    throw new Error(`A message can mention at most ${MAX_MESSAGE_MENTIONS} people or teammates`);
  }
  if (attachmentIds.length > MAX_MESSAGE_ATTACHMENTS) {
    throw new Error(`A message can attach at most ${MAX_MESSAGE_ATTACHMENTS} files`);
  }
  if (maximumAnchors * attachmentIds.length > MAX_ANCHOR_ATTACHMENT_PAIRS) {
    throw new Error(
      `Those tags and attachments create more than ${MAX_ANCHOR_ATTACHMENT_PAIRS} message-file copies`,
    );
  }
}

export interface TaggedChannelMessage {
  channelId: EntityId;
  body: string;
  selectedTagIds: readonly EntityId[];
  candidates: readonly ChannelTagTarget[];
  mentionIds?: readonly EntityId[];
  attachmentIds?: readonly EntityId[];
}

export interface ChannelTagCommandPort {
  spawnTeamMember(teamMemberId: EntityId): Promise<EntityId>;
  post(input: {
    anchorIds: EntityId[];
    body: string;
    mentionIds: EntityId[];
    attachmentIds: EntityId[];
  }): Promise<void>;
}

export interface TaggedChannelMessageResult {
  anchorIds: EntityId[];
  spawnedSessionIds: EntityId[];
}

/**
 * Resolve every selected target, then perform ONE atomic message batch. Existing
 * sessions are reused. A teammate without one is spawned only after all local
 * bounds pass. The channel is always the first anchor, so the original message
 * remains visible where it was authored.
 */
export async function dispatchTaggedChannelMessage(
  message: TaggedChannelMessage,
  port: ChannelTagCommandPort,
): Promise<TaggedChannelMessageResult> {
  const plan = buildChannelTagPlan(message.selectedTagIds, message.candidates);
  assertChannelTagLimits({
    plan,
    baseMentionIds: message.mentionIds,
    attachmentIds: message.attachmentIds,
  });

  const spawnedSessionIds: EntityId[] = [];
  for (const teamMemberId of plan.spawnTeamMemberIds) {
    spawnedSessionIds.push(await port.spawnTeamMember(teamMemberId));
  }

  const anchorIds = [...new Set([
    message.channelId,
    ...plan.existingSessionIds,
    ...spawnedSessionIds,
  ])];
  const mentionIds = [...new Set([...(message.mentionIds ?? []), ...plan.mentionIds])];
  const attachmentIds = [...new Set(message.attachmentIds ?? [])];

  await port.post({ anchorIds, body: message.body, mentionIds, attachmentIds });
  return { anchorIds, spawnedSessionIds };
}
