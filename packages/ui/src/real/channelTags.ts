import type {
  CollectionQuery,
  EntityDetail,
  EntityId,
  EntitySummary,
} from '../collab-v2/types/contract';
import type { CollabFacade } from '../collab-v2/facade/CollabFacade';
import type {
  ChannelTagCommandPort,
  ChannelTaggingController,
  ChannelTagTarget,
} from '../collab-v2/subsystems/thread/tags';
import { dispatchTaggedChannelMessage } from '../collab-v2/subsystems/thread/tags';
import type { ExecutionControl, Tm8Project } from './RealFacade';
import { isLive, sessionState } from './workspace/useSessions';
import { TEAM_MEMBER_KINDS, WORK_SESSION_KINDS } from './workspace/queries';

type TagReadFacade = Pick<CollabFacade, 'queryCollection' | 'getEntity'>;

const TAG_QUERY_LIMIT = 100;
const DETAIL_CONCURRENCY = 6;

function targetOfType(detail: EntityDetail, type: string): EntitySummary | null {
  const group = detail.connections?.outgoing?.find((candidate) => candidate.type === type);
  return group?.edges?.[0]?.target ?? null;
}

async function mapConcurrent<T, R>(
  values: readonly T[],
  worker: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let cursor = 0;
  const pump = async (): Promise<void> => {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(values[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(DETAIL_CONCURRENCY, values.length) }, pump));
  return results;
}

/**
 * Load both halves of the Channel @Tag menu from the active Space.
 *
 * Only live sessions need an entity-detail read: their `relates_to` edge tells
 * us which teammate already has a usable target. Finished sessions stay
 * selectable by their own explicit session row, but never suppress a teammate
 * spawn. One failed enrichment degrades that teammate to "start a session";
 * it does not make the rest of the menu disappear.
 */
export async function loadChannelTagTargets(
  facade: TagReadFacade,
  spaceId: string,
): Promise<ChannelTagTarget[]> {
  const teammateQuery: CollectionQuery = {
    spaceId,
    kinds: TEAM_MEMBER_KINDS,
    limit: TAG_QUERY_LIMIT,
    sort: 'activityAt_desc',
  };
  const sessionQuery: CollectionQuery = {
    spaceId,
    kinds: WORK_SESSION_KINDS,
    limit: TAG_QUERY_LIMIT,
    sort: 'activityAt_desc',
  };
  const [teammatePage, sessionPage] = await Promise.all([
    facade.queryCollection(teammateQuery),
    facade.queryCollection(sessionQuery),
  ]);

  const teammates = teammatePage.page.items.filter((row) => row.deletedAt === null);
  const sessions = sessionPage.page.items.filter((row) => row.deletedAt === null);
  const liveSessions = sessions.filter(isLive);
  const details = await mapConcurrent(liveSessions, async (session) => {
    try {
      return await facade.getEntity(session.id);
    } catch {
      return null;
    }
  });

  // Session queries are newest-first. First assignment therefore chooses the
  // teammate's most recently active live session without a second sort.
  const liveByTeammate = new Map<EntityId, EntitySummary>();
  const teammateBySession = new Map<EntityId, EntitySummary>();
  details.forEach((detail, index) => {
    if (!detail) return;
    const teammate = targetOfType(detail, 'relates_to');
    if (!teammate) return;
    const session = liveSessions[index]!;
    teammateBySession.set(session.id, teammate);
    if (!liveByTeammate.has(teammate.id)) liveByTeammate.set(teammate.id, session);
  });

  const teammateTargets: ChannelTagTarget[] = teammates.map((teammate) => {
    const existing = liveByTeammate.get(teammate.id);
    return {
      id: teammate.id,
      display: teammate.title || teammate.id,
      group: 'Team members',
      meta: existing ? `message ${existing.title || 'running session'}` : 'starts a session when sent',
      route: existing
        ? { kind: 'existing-session', sessionId: existing.id }
        : { kind: 'spawn-team-member', teamMemberId: teammate.id },
      mention: {
        entityId: teammate.id,
        kind: 'team_member',
        display: teammate.title || teammate.id,
      },
    };
  });

  const sessionTargets: ChannelTagTarget[] = sessions.map((session) => {
    const state = sessionState(session);
    const teammate = teammateBySession.get(session.id);
    const status = state.status || 'status unknown';
    return {
      id: session.id,
      display: session.title || session.id,
      group: 'Work sessions',
      meta: teammate ? `${status} · ${teammate.title}` : status,
      route: { kind: 'existing-session', sessionId: session.id },
    };
  });

  return [...teammateTargets, ...sessionTargets];
}

export interface ChannelTagExecutionFacade extends ExecutionControl {
  queryCollection: CollabFacade['queryCollection'];
}

export interface ChannelMessageBatchWriter {
  postBatch(input: {
    anchorIds: EntityId[];
    body: string;
    mentionIds: EntityId[];
    attachmentIds: EntityId[];
  }): Promise<void>;
}

function trusted(projects: readonly Tm8Project[]): Tm8Project | null {
  return projects.find((project) => project.trust === 'trusted') ?? null;
}

/**
 * The command half is injected separately from the picker. This keeps the
 * attachment worker's `RealFacade.postMessage` migration out of this module:
 * once their batch writer is ready, this adapter only needs its one postBatch
 * function and never reaches into attachment/entity-reference implementation.
 */
export function createChannelTagCommandPort(
  facade: ChannelTagExecutionFacade,
  spaceId: string,
  writer: ChannelMessageBatchWriter,
): ChannelTagCommandPort {
  let projectPromise: Promise<Tm8Project> | null = null;

  const spawnProject = (): Promise<Tm8Project> => {
    if (projectPromise) return projectPromise;
    projectPromise = (async () => {
      const linked = trusted(await facade.listProjects(spaceId));
      if (linked) return linked;

      const available = trusted(await facade.listProjects());
      if (!available) {
        throw new Error('No trusted project is available to start a tagged teammate session');
      }
      await facade.linkProject(spaceId, available.id);
      return available;
    })();
    return projectPromise;
  };

  return {
    async spawnTeamMember(teamMemberId) {
      const project = await spawnProject();
      const result = await facade.spawnSession({
        spaceId,
        projectId: project.id,
        teamMemberId,
        taskIds: [],
        mode: 'worker',
        clientMutationId: mutationId('channel-tag-spawn'),
      });
      const sessionId = result.entity?.id
        ?? result.patches.find((patch) => String(patch.kind) === 'work_session')?.id;
      if (!sessionId) throw new Error('Tagged teammate spawn returned no work session');
      return sessionId;
    },
    post: (input) => writer.postBatch(input),
  };
}

/**
 * Production controller injected above the backend-agnostic thread tree.
 * Targets are re-read at send time so a teammate whose session started after
 * the menu opened is messaged in that session instead of being spawned twice.
 */
export function createRealChannelTaggingController(
  facade: ChannelTagExecutionFacade & TagReadFacade,
  writer: ChannelMessageBatchWriter,
): ChannelTaggingController {
  return {
    loadTargets: (spaceId) => loadChannelTagTargets(facade, spaceId),
    async send(input) {
      const candidates = await loadChannelTagTargets(facade, input.spaceId);
      return dispatchTaggedChannelMessage({
        channelId: input.channelId,
        body: input.body,
        selectedTagIds: input.selectedTagIds,
        candidates,
        mentionIds: input.mentionIds,
        attachmentIds: input.attachmentIds,
      }, createChannelTagCommandPort(facade, input.spaceId, writer));
    },
  };
}

let mutationSequence = 0;

function mutationId(prefix: string): string {
  mutationSequence += 1;
  return `${prefix}:${Date.now().toString(36)}:${mutationSequence.toString(36)}`;
}
