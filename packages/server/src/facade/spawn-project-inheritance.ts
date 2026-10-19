/**
 * A WORKER LAUNCHED FROM A PROJECT CHAT OR SESSION WORKS IN THAT PROJECT.
 *
 * `execution.spawn` without a `projectId` is a projectless scratch session.
 * That is right for a person, who picks a project in the launcher, and wrong
 * for an agent: a chat started in a project that spawned a worker naming
 * nothing got a worker in a fresh scratch directory, so the work the chat
 * delegated happened somewhere other than the folder it was about.
 *
 * So an AGENT caller (a chat runtime, or a worker session) that names no
 * project inherits its spawn parent's: the chat's `project_id` when the chat
 * runs in a project, the session's `project_id` otherwise. Anything explicit
 * still wins — a `projectId` (including `null`, which asks for scratch) or a
 * `workdir` of `{ mode: 'scratch' }`. A person's spawn is never rewritten.
 *
 * The read runs under the CALLER's claims: a parent the caller cannot see
 * contributes nothing, and the spawn's own project gate (link + trust) still
 * judges the inherited project exactly as it would a named one.
 */
import type { ExecutionSpawnInput, ProjectId } from '@tm8/contract';

import type { Db, DbClaims } from '../db/types.js';

export interface SpawnProjectInheritance {
  input: Pick<ExecutionSpawnInput, 'projectId' | 'workdir'>;
  /** A chat runtime or a worker session — never a person. */
  agentCaller: boolean;
  /** The resolved spawn parent: the caller's own chat or session. */
  parentId: string | null;
}

export function inheritsSpawnProject(args: SpawnProjectInheritance): boolean {
  return args.agentCaller
    && args.parentId !== null
    && args.input.projectId === undefined
    && args.input.workdir?.mode !== 'scratch';
}

export async function inheritedSpawnProjectId(
  db: Db,
  claims: DbClaims,
  args: SpawnProjectInheritance,
): Promise<ProjectId | null> {
  if (!inheritsSpawnProject(args)) return null;
  const rows = await db.query<{ project_id: string | null }>(
    claims,
    `select project_id::text from public.chats
      where entity_id = $1 and workdir_mode = 'project' and project_id is not null
     union all
     select project_id::text from public.work_sessions
      where entity_id = $1 and project_id is not null
     limit 1`,
    [args.parentId],
  );
  return (rows[0]?.project_id ?? null) as ProjectId | null;
}
