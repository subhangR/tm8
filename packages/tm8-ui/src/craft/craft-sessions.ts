/**
 * THE CRAFT'S SESSIONS — the work sessions spawned on a craft, for its side
 * panel (`CraftSidePanel`).
 *
 * A launch on any entity derives the session's task from it (064,
 * `derive_task_for_entity`: a `derived_from` edge task → craft) and the
 * session works on that task (`working_on` session → task). So the sessions
 * of a craft are two incoming-edge reads: the craft's derived tasks, then each
 * task's working sessions. The `working_on` edge's creation is the spawn, so
 * its `createdAt` is the session's start. A session may also be ABOUT the
 * craft directly (`about` session → craft): "+ New session" writes that edge,
 * because it is what lets the session's agent command the viewer's craft
 * workspace (spec §4), so those are read too.
 *
 * A new session is the ordinary `execution.spawn` with the craft as its
 * subject (`taskIds: [craft]`) and the craft's default teammate.
 */
import type { EntityId, EntityKind, EntitySummary, ExecutionSpawnInput } from '@tm8/contract';
import type { Seam } from '../data/seam';
import { defaultChatTeammateId } from '../chat-home/default-teammate';
import { buildSpawnInput, defaultConfigFor, newLaunchMutationId, type LaunchProject, type LaunchTeammate } from '../domain/launch';

export interface CraftSessionRow {
  id: EntityId;
  title: string;
  /** The recorded status off the summary, when it carries one. */
  status: string | null;
  /** When the session started (its `working_on` edge), else its last activity. */
  at: string;
}

const SESSION_KIND = 'work_session' as EntityKind;
const PAGE = 100;

function statusOf(summary: EntitySummary): string | null {
  const status = (summary.state as { status?: unknown } | undefined)?.status;
  return typeof status === 'string' ? status : null;
}

/** The sessions working on tasks derived from `craftId`, newest first. */
export async function listCraftSessions(seam: Pick<Seam, 'connections'>, craftId: EntityId): Promise<CraftSessionRow[]> {
  const [derived, about] = await Promise.all([
    seam.connections(craftId, { types: ['derived_from'], direction: 'incoming', limit: PAGE }),
    seam.connections(craftId, { types: ['about'], direction: 'incoming', limit: PAGE }).catch(() => null),
  ]);
  const taskIds = [...new Set(derived.items.filter((edge) => edge.source.kind === 'task').map((edge) => edge.source.id))];
  const pages = await Promise.all(
    taskIds.map((id) =>
      seam.connections(id, { types: ['working_on'], direction: 'incoming', limit: PAGE }).catch(() => null),
    ),
  );
  const rows = new Map<EntityId, CraftSessionRow>();
  for (const page of [about, ...pages]) {
    for (const edge of page?.items ?? []) {
      const session = edge.source;
      if (session.kind !== SESSION_KIND || session.deletedAt) continue;
      const at = edge.createdAt || session.createdAt;
      const was = rows.get(session.id);
      if (was && was.at >= at) continue;
      rows.set(session.id, { id: session.id, title: session.title, status: statusOf(session), at });
    }
  }
  return [...rows.values()].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}

/**
 * The teammate a new craft session runs as: the same rule a new craft chat
 * starts with (`defaultChatTeammateId`, pinned to craft), so the two "+ New"
 * buttons beside each other never disagree about who answers.
 */
export function defaultCraftTeammate(teammates: readonly LaunchTeammate[]): LaunchTeammate | null {
  const id = defaultChatTeammateId(
    teammates.map((teammate) => ({ id: teammate.id as EntityId, label: teammate.name })),
    { pinnedMode: 'craft' },
  );
  return teammates.find((teammate) => teammate.id === id) ?? null;
}

/**
 * The spawn input for "+ New session" on a craft: the default teammate's own
 * tool and model, in the default trusted project (else scratch), working on the
 * craft. Null when the space has no teammate to run it as.
 */
export function craftSpawnInput(args: {
  spaceId: string;
  craftId: EntityId;
  title: string;
  teammates: readonly LaunchTeammate[];
  projects: readonly LaunchProject[];
}): ExecutionSpawnInput | null {
  const teammate = defaultCraftTeammate(args.teammates);
  if (!teammate) return null;
  /* The launch sheet's default target when it names one, else the first
     trusted project, else scratch. */
  const preferred = args.projects.find((candidate) => candidate.selectedByDefault);
  const project = preferred
    ? preferred.scratch || !preferred.trusted ? undefined : preferred
    : args.projects.find((candidate) => candidate.trusted && !candidate.scratch);
  const config = defaultConfigFor(
    { id: teammate.id as EntityId, agentTool: teammate.agentTool || null, model: teammate.model || null },
    (project?.id ?? null) as Parameters<typeof defaultConfigFor>[1],
  );
  return buildSpawnInput({
    clientMutationId: newLaunchMutationId(),
    spaceId: args.spaceId,
    config,
    // Any kind: the server derives the task anchor (064).
    taskIds: [args.craftId],
    ...(args.title ? { title: args.title } : {}),
  });
}

/**
 * Record the session as ABOUT the craft (spec §4 auth: a session tied to
 * craft C may command its starter's workspace for C). Best-effort: the spawn
 * already happened, so a refusal is reported, never thrown.
 */
export async function markSessionAboutCraft(
  seam: Pick<Seam, 'commands'>,
  sessionId: EntityId,
  craftId: EntityId,
): Promise<boolean> {
  try {
    await seam.commands.createEdge({ clientMutationId: newLaunchMutationId(), srcId: sessionId, dstId: craftId, type: 'about' });
    return true;
  } catch {
    return false;
  }
}
