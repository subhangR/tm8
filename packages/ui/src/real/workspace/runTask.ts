/**
 * RUN A TASK — resolve the defaults and spawn, with no dialog in the way.
 *
 * WHY THIS REPLACED THE DIALOG. Pressing Run used to raise `tm8:spawn-request`,
 * which opened `SpawnDialog` and asked the user to pick a project and a persona
 * before anything happened. maestro does not do that, and checking rather than
 * assuming is what settled it: maestro's Run calls
 *
 *     onExecute(selectedExecuteMemberId || undefined, …)
 *
 * (`ExecutionBar.tsx`) — the member is OPTIONAL and falls back to a default,
 * the project comes from ambient context, and the only modal on that bar is a
 * separate ⚙ config button the user has to go looking for. So Run spawns. That
 * is the behaviour being transplanted.
 *
 * WHAT MAKES THE DEFAULTS SAFE, rather than merely convenient: the server, not
 * this function, is the authority on whether a spawn is allowed. `execution.spawn`
 * refuses an untrusted project outright, so resolving to a trusted project here
 * is a convenience on top of a guarantee — not a substitute for one. If the
 * resolution is wrong, the spawn fails loudly at the server instead of running
 * an agent somewhere the operator never sanctioned.
 *
 * AND IT NEVER FAILS SILENTLY. Every unresolvable case throws with the specific
 * missing thing named, so the caller can surface it. A Run button that does
 * nothing is the worst outcome available here: the user cannot tell it from a
 * slow spawn, and there is nothing on screen to read.
 */
import type { EntityId } from '../../collab-v2/types/contract';
import type { RealFacade, Tm8Project } from '../RealFacade';
import { SESSION_SPAWNED_EVENT, type SessionSpawnedDetail } from '../tm8Kinds';

/**
 * Pick the project to spawn into.
 *
 * Trusted only — `execution.spawn` rejects untrusted projects, so offering one
 * would guarantee a failed spawn. Where several are trusted the first is taken
 * deterministically (the server returns a stable order) rather than prompting:
 * maestro does not prompt here, and an operator who has trusted several
 * projects has already said yes to each of them.
 */
export function resolveProject(projects: readonly Tm8Project[]): Tm8Project {
  const trusted = projects.filter((p) => p.trust === 'trusted');
  if (trusted.length === 0) {
    throw new Error(
      projects.length === 0
        ? 'no projects are registered on this node — create one before running a task'
        : 'no TRUSTED project is registered — execution.spawn refuses untrusted projects',
    );
  }
  return trusted[0]!;
}

export interface RunTaskResult {
  sessionId: EntityId;
  projectId: string;
  teamMemberId: EntityId;
}

/**
 * Spawn an agent on `taskId` immediately.
 *
 * Resolution and spawn are one call so no surface can half-do it: either a
 * session exists and the workspace has been told about it, or this throws with
 * the reason. There is no intermediate state for a caller to mishandle.
 */
export async function runTask(
  facade: RealFacade,
  taskId: EntityId,
  spaceId: string,
): Promise<RunTaskResult> {
  // Both reads are needed before the spawn and neither depends on the other.
  const [projects, members] = await Promise.all([
    facade.listProjects(),
    facade.queryCollection({ spaceId, kinds: ['team_member'], limit: 50 }),
  ]);

  const project = resolveProject(projects);

  const teamMember = members.page.items[0];
  if (!teamMember) {
    throw new Error('no team member (persona) exists in this space — create one before running a task');
  }

  const result = await facade.spawnSession({
    spaceId,
    projectId: project.id,
    teamMemberId: teamMember.id,
    taskIds: [taskId],
  });

  const sessionId = result.entity?.id;
  if (!sessionId) throw new Error('spawn returned no session entity');

  // The same handoff the dialog used, so the centre pane attaches the new
  // terminal exactly as before. Raised here rather than left to the caller
  // because a spawned session nothing points at is the lost-agent bug the
  // sessions surface was built to fix.
  const detail: SessionSpawnedDetail = { sessionId, taskId };
  window.dispatchEvent(new CustomEvent(SESSION_SPAWNED_EVENT, { detail }));

  return { sessionId, projectId: project.id, teamMemberId: teamMember.id };
}
