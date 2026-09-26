import { stat } from 'node:fs/promises';
import { basename, isAbsolute } from 'node:path';
import type { Db, DbClaims } from '../db/types.js';
import type { LoopbackOwner } from '../identity/loopback.js';
import { ensureDefaultTeammates } from './default-teammates.js';
import { launchFolderSpace } from '../projects/owning-space.js';

interface SpaceRow { id: string; created_by_owner: boolean; created_at: Date | string }
interface ProjectRow { id: string; trust: 'trusted' | 'untrusted' }

interface ProjectMutation { project?: { id?: string } }

export interface LaunchBootstrapResult {
  spaces: number;
  projectId: string | null;
  teammatesCreated: number;
  teammatesUpdated: number;
  /** Per-model teammates soft-deleted by the one-time sweep (default-teammates.ts). */
  teammatesRetired: number;
}

/**
 * Idempotently make existing loopback-owner spaces launchable: link the launch
 * project and seed the default roster (default-teammates.ts) into every space
 * the owner runs.
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
    `select distinct space_row.id::text id,
            space_row.created_by_identity is not distinct from $1 created_by_owner,
            space_row.created_at
       from public.spaces space_row
       join public.members member_row on member_row.space_id = space_row.id
      where member_row.identity_id = $1
        and member_row.role in ('owner','admin')
      order by 1`,
    [args.owner.identityId],
  );
  if (spaces.length === 0) {
    return { spaces: 0, projectId: null, teammatesCreated: 0, teammatesUpdated: 0, teammatesRetired: 0 };
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

  // W11 (234): a folder is granted to ONE space. On a fresh node that is the
  // owner's personal/first space (the K13 tie-break: no activity yet); when the
  // folder is already granted — by an earlier boot or a gate admin — the grant
  // is left exactly where it is.
  const granted = await args.db.query<{ space_id: string }>(
    claims,
    'select space_id::text space_id from public.space_projects where project_id = $1',
    [project.id],
  );
  if (granted.length === 0) {
    const target = launchFolderSpace(spaces.map((space) => ({
      spaceId: space.id,
      createdByOwner: space.created_by_owner === true,
      createdAt: space.created_at instanceof Date ? space.created_at.toISOString() : String(space.created_at),
    })));
    if (target) {
      await args.db.rpc(claims, 'public.grant_folder', [
        target,
        project.id,
        `bootstrap:folder-grant:${project.id}`,
      ]);
    }
  }

  let teammatesCreated = 0;
  let teammatesUpdated = 0;
  let teammatesRetired = 0;
  for (const space of spaces) {
    const seeded = await args.db.tx(claims, (q) => ensureDefaultTeammates(q, space.id));
    teammatesCreated += seeded.created;
    teammatesUpdated += seeded.updated;
    teammatesRetired += seeded.retired;
  }

  return { spaces: spaces.length, projectId: project.id, teammatesCreated, teammatesUpdated, teammatesRetired };
}
