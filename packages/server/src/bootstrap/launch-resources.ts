import { stat } from 'node:fs/promises';
import { basename, isAbsolute } from 'node:path';
import type { Db, DbClaims } from '../db/types.js';
import type { LoopbackOwner } from '../identity/loopback.js';
import { ensureDefaultTeammates } from './default-teammates.js';

interface SpaceRow { id: string }
interface ProjectRow { id: string; trust: 'trusted' | 'untrusted' }

interface ProjectMutation { project?: { id?: string } }

export interface LaunchBootstrapResult {
  spaces: number;
  projectId: string | null;
  teammatesCreated: number;
  teammatesUpdated: number;
}

/**
 * Idempotently make existing loopback-owner spaces launchable.
 *
 * The durable catalog for this phase is the existing team_members.model +
 * agent_tool pair. No parallel model table is invented: the UI's supported
 * catalog and these seeded rows share LAUNCH_MODEL_CATALOG, while the execution
 * layer still rejects any tool it cannot build truthfully.
 */
export async function ensureLaunchResources(args: {
  db: Db;
  owner: LoopbackOwner;
  projectDir: string;
}): Promise<LaunchBootstrapResult> {
  if (!isAbsolute(args.projectDir)) {
    throw new Error(`launch bootstrap projectDir must be absolute: ${args.projectDir}`);
  }
  const projectStat = await stat(args.projectDir);
  if (!projectStat.isDirectory()) {
    throw new Error(`launch bootstrap projectDir is not a directory: ${args.projectDir}`);
  }

  const claims: DbClaims = {
    identityId: args.owner.identityId,
    nodeAdmin: args.owner.isNodeAdmin,
  };
  const spaces = await args.db.query<SpaceRow>(
    claims,
    `select distinct space_row.id::text id
       from public.spaces space_row
       join public.members member_row on member_row.space_id = space_row.id
      where member_row.identity_id = $1
        and member_row.role in ('owner','admin')
      order by 1`,
    [args.owner.identityId],
  );
  if (spaces.length === 0) {
    return { spaces: 0, projectId: null, teammatesCreated: 0, teammatesUpdated: 0 };
  }

  let project = (await args.db.query<ProjectRow>(
    claims,
    `select id::text id, trust from public.projects where working_dir = $1 limit 1`,
    [args.projectDir],
  ))[0];
  if (!project) {
    const created = await args.db.rpc<ProjectMutation>(claims, 'public.create_project', [
      basename(args.projectDir) || 'Current project',
      args.projectDir,
      null,
      'trusted',
      JSON.stringify({ launchBootstrap: true }),
      `bootstrap:project:${args.projectDir}`,
    ]);
    const projectId = created.project?.id;
    if (!projectId) throw new Error('launch bootstrap create_project returned no id');
    project = { id: projectId, trust: 'trusted' };
  } else if (project.trust !== 'trusted') {
    throw new Error(
      `launch bootstrap will not override untrusted project ${project.id}; trust it explicitly or disable TM8_LAUNCH_BOOTSTRAP`,
    );
  }

  let teammatesCreated = 0;
  let teammatesUpdated = 0;
  for (const space of spaces) {
    await args.db.rpc(claims, 'public.link_project_w2', [
      space.id,
      project.id,
      null,
      `bootstrap:project-link:${space.id}:${project.id}`,
    ]);

    const seeded = await args.db.tx(claims, (q) => ensureDefaultTeammates(q, space.id));
    teammatesCreated += seeded.created;
    teammatesUpdated += seeded.updated;
  }

  return { spaces: spaces.length, projectId: project.id, teammatesCreated, teammatesUpdated };
}
