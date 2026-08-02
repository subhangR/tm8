import type {
  CollectionQuery,
  CollectionResult,
  EntityDetail,
  EntityId,
  EntitySummary,
  SpaceId,
} from '@tm8/contract';

/**
 * One option in the composer's `@` picker or workspace-attach picker. Plain
 * members are durable mentions. Channel-only targets additionally carry a
 * route which the Channel host resolves at send time, when liveness is
 * freshest. Graph entities (tasks, docs) carry `attach: 'anchor'` — selecting
 * one CROSS-POSTS the message onto that entity's own feed via the batch
 * write's `anchorIds`, which is the only server-supported way a non-file,
 * non-person entity rides a message today (`attachmentIds` is validated to
 * kind='file' and mentions to member/team_member in the DB).
 */
export interface ComposerMentionOption {
  id: EntityId;
  kind: 'member' | 'team_member' | 'work_session' | 'task' | 'doc';
  display: string;
  group?: 'People' | 'Team members' | 'Work sessions' | 'Tasks' | 'Docs';
  meta?: string;
  route?:
    | { kind: 'existing-session'; sessionId: EntityId }
    | { kind: 'spawn-team-member'; teamMemberId: EntityId };
  /** Selecting this option adds the entity as a message ANCHOR (cross-post). */
  attach?: 'anchor';
}

export type ChannelTagTarget = ComposerMentionOption & { route: NonNullable<ComposerMentionOption['route']> };

interface ChannelTagReadPort {
  query(input: CollectionQuery): Promise<CollectionResult>;
  entity(id: EntityId): Promise<EntityDetail>;
}

export const MAX_MESSAGE_ANCHORS = 16;
export const MAX_MESSAGE_MENTIONS = 16;
export const MAX_MESSAGE_ATTACHMENTS = 16;
export const MAX_ANCHOR_ATTACHMENT_PAIRS = 64;

function teamMemberIdOf(detail: EntityDetail): EntityId | null {
  for (const group of detail.connections.outgoing) {
    for (const edge of group.edges) {
      if (edge.type === 'relates_to' && edge.target.state.kind === 'team_member') {
        return edge.target.id;
      }
    }
  }
  return null;
}

/**
 * Load human mentions, teammate actions, and addressable work sessions. Only
 * the authoritative liveness snapshot decides whether a teammate reuses a
 * session; activity timestamps are never treated as proof that a PTY is live.
 */
export async function loadChannelTagOptions({
  port,
  spaceId,
  liveSessionIds,
}: {
  port: ChannelTagReadPort;
  spaceId: SpaceId;
  liveSessionIds: readonly EntityId[];
}): Promise<ComposerMentionOption[]> {
  const [people, sessions] = await Promise.all([
    port.query({
      spaceId,
      kinds: ['member', 'team_member'],
      sort: 'activityAt_desc',
      limit: 100,
    }),
    port.query({
      spaceId,
      kinds: ['work_session'],
      sort: 'activityAt_desc',
      limit: 100,
    }),
  ]);

  const liveIds = new Set(liveSessionIds);
  const liveSessions = sessions.page.items.filter((session) => liveIds.has(session.id));
  const liveDetails = await Promise.all(liveSessions.map(async (session) => {
    try {
      return { session, detail: await port.entity(session.id) };
    } catch {
      // An unreadable session is not safe to infer as a teammate's reusable
      // target. It remains selectable by its own canonical session id below.
      return { session, detail: null };
    }
  }));
  const liveSessionByTeamMember = new Map<EntityId, EntitySummary>();
  for (const { session, detail } of liveDetails) {
    if (!detail) continue;
    const teamMemberId = teamMemberIdOf(detail);
    if (teamMemberId && !liveSessionByTeamMember.has(teamMemberId)) {
      liveSessionByTeamMember.set(teamMemberId, session);
    }
  }

  const memberOptions = people.page.items.flatMap<ComposerMentionOption>((entity) => {
    if (entity.state.kind === 'member') {
      return [{
        id: entity.id,
        kind: 'member',
        display: entity.title,
        group: 'People',
        meta: 'Mention in this message',
      }];
    }
    if (entity.state.kind !== 'team_member') return [];

    const liveSession = liveSessionByTeamMember.get(entity.id);
    return [{
      id: entity.id,
      kind: 'team_member',
      display: entity.title,
      group: 'Team members',
      meta: liveSession
        ? `Message live session · ${liveSession.title}`
        : 'Start a work session when sent',
      route: liveSession
        ? { kind: 'existing-session', sessionId: liveSession.id }
        : { kind: 'spawn-team-member', teamMemberId: entity.id },
    }];
  });

  const sessionOptions = sessions.page.items.flatMap<ComposerMentionOption>((session) => {
    if (session.state.kind !== 'work_session') return [];
    const live = liveIds.has(session.id);
    return [{
      id: session.id,
      kind: 'work_session',
      display: session.title,
      group: 'Work sessions',
      meta: live ? 'Live · message this session' : `${session.state.status} · stores without waking`,
      route: { kind: 'existing-session', sessionId: session.id },
    }];
  });

  return [...memberOptions, ...sessionOptions];
}

/**
 * Load the workspace entities the attach picker offers: tasks and docs (as
 * anchor attachments — the message also lands on their Discussion), plus the
 * people from the already-loaded mention options as mention-only references
 * (routes stripped: ATTACHING a teammate references them; it never spawns or
 * messages a session — that stays the `@` picker's contract).
 */
export async function loadChannelAttachOptions({
  port,
  spaceId,
  mentionOptions,
}: {
  port: Pick<ChannelTagReadPort, 'query'>;
  spaceId: SpaceId;
  mentionOptions: readonly ComposerMentionOption[];
}): Promise<ComposerMentionOption[]> {
  const entities = await port.query({
    spaceId,
    kinds: ['task', 'doc'],
    sort: 'activityAt_desc',
    limit: 100,
  });

  const entityOptions = entities.page.items.flatMap<ComposerMentionOption>((entity) => {
    if (entity.state.kind !== 'task' && entity.state.kind !== 'doc') return [];
    return [{
      id: entity.id,
      kind: entity.state.kind,
      display: entity.title,
      group: entity.state.kind === 'task' ? 'Tasks' : 'Docs',
      meta: 'Attach — this message also posts to its Discussion',
      attach: 'anchor',
    }];
  });

  const peopleOptions = mentionOptions.flatMap<ComposerMentionOption>((option) =>
    option.kind === 'member' || option.kind === 'team_member'
      ? [{
          id: option.id,
          kind: option.kind,
          display: option.display,
          group: option.kind === 'member' ? 'People' : 'Team members',
          meta: 'Reference in this message',
        }]
      : []);

  return [...entityOptions, ...peopleOptions];
}

export interface ChannelTagPlan {
  existingSessionIds: EntityId[];
  spawnTeamMemberIds: EntityId[];
  mentionIds: EntityId[];
}

export function buildChannelTagPlan(
  selectedIds: readonly EntityId[],
  candidates: readonly ComposerMentionOption[],
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
    if (!target?.route) throw new Error(`@Tag target ${id} is no longer available`);

    if (target.route.kind === 'existing-session') {
      if (!sessionsSeen.has(target.route.sessionId)) {
        sessionsSeen.add(target.route.sessionId);
        existingSessionIds.push(target.route.sessionId);
      }
    } else if (!teammatesSeen.has(target.route.teamMemberId)) {
      teammatesSeen.add(target.route.teamMemberId);
      spawnTeamMemberIds.push(target.route.teamMemberId);
    }

    if (target.kind === 'team_member' && !mentionsSeen.has(target.id)) {
      mentionsSeen.add(target.id);
      mentionIds.push(target.id);
    }
  }

  return { existingSessionIds, spawnTeamMemberIds, mentionIds };
}

export function assertChannelTagLimits({
  plan,
  mentionIds = [],
  attachmentIds = [],
  extraAnchorCount = 0,
}: {
  plan: ChannelTagPlan;
  mentionIds?: readonly EntityId[];
  attachmentIds?: readonly EntityId[];
  /** Workspace entities attached as anchors, beyond the channel itself. */
  extraAnchorCount?: number;
}): void {
  const anchors = 1 + extraAnchorCount + plan.existingSessionIds.length + plan.spawnTeamMemberIds.length;
  if (anchors > MAX_MESSAGE_ANCHORS) {
    throw new Error(`A channel message can carry at most ${MAX_MESSAGE_ANCHORS - 1} tags and attached entities together`);
  }
  if (new Set([...mentionIds, ...plan.mentionIds]).size > MAX_MESSAGE_MENTIONS) {
    throw new Error(`A message can mention at most ${MAX_MESSAGE_MENTIONS} people or teammates`);
  }
  if (attachmentIds.length > MAX_MESSAGE_ATTACHMENTS) {
    throw new Error(`A message can attach at most ${MAX_MESSAGE_ATTACHMENTS} files`);
  }
  if (anchors * attachmentIds.length > MAX_ANCHOR_ATTACHMENT_PAIRS) {
    throw new Error(`Those tags and attachments create more than ${MAX_ANCHOR_ATTACHMENT_PAIRS} message-file copies`);
  }
}

export async function dispatchTaggedChannelMessage({
  channelId,
  body,
  parentMessageId,
  selectedTagIds,
  candidates,
  mentionIds = [],
  attachmentIds = [],
  extraAnchorIds = [],
  spawnTeamMember,
  post,
}: {
  channelId: EntityId;
  body: string;
  parentMessageId: EntityId | null;
  selectedTagIds: readonly EntityId[];
  candidates: readonly ComposerMentionOption[];
  mentionIds?: readonly EntityId[];
  attachmentIds?: readonly EntityId[];
  /** Attached workspace entities — extra message anchors beyond the channel. */
  extraAnchorIds?: readonly EntityId[];
  spawnTeamMember: (teamMemberId: EntityId) => Promise<EntityId>;
  post: (input: {
    anchorIds: EntityId[];
    conversationAnchorId: EntityId;
    body: string;
    parentMessageId: EntityId | null;
    mentionIds: EntityId[];
    attachmentIds: EntityId[];
  }) => Promise<void>;
}): Promise<{ anchorIds: EntityId[]; spawnedSessionIds: EntityId[] }> {
  if (parentMessageId) {
    throw new Error('Team and session @Tags are available only on top-level channel messages');
  }

  const plan = buildChannelTagPlan(selectedTagIds, candidates);
  const extras = [...new Set(extraAnchorIds)].filter((id) => id !== channelId);
  assertChannelTagLimits({ plan, mentionIds, attachmentIds, extraAnchorCount: extras.length });

  const spawnedSessionIds: EntityId[] = [];
  for (const teamMemberId of plan.spawnTeamMemberIds) {
    spawnedSessionIds.push(await spawnTeamMember(teamMemberId));
  }

  const anchorIds = [...new Set([
    channelId,
    ...extras,
    ...plan.existingSessionIds,
    ...spawnedSessionIds,
  ])];
  await post({
    anchorIds,
    conversationAnchorId: channelId,
    body,
    parentMessageId,
    mentionIds: [...new Set([...mentionIds, ...plan.mentionIds])],
    attachmentIds: [...new Set(attachmentIds)],
  });
  return { anchorIds, spawnedSessionIds };
}
