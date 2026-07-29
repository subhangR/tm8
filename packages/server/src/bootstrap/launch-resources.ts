import { stat } from 'node:fs/promises';
import { basename, isAbsolute } from 'node:path';
import { LAUNCH_MODEL_CATALOG } from '@tm8/contract';
import type { Db, DbClaims } from '../db/types.js';
import type { LoopbackOwner } from '../identity/loopback.js';

interface SpaceRow { id: string }
interface ProjectRow { id: string; trust: 'trusted' | 'untrusted' }
interface TeammateRow {
  id: string;
  version: number;
  name: string;
  model: string | null;
  agent_tool: string | null;
}

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

    const rows = await args.db.query<TeammateRow>(
      claims,
      `select entity_row.id::text id, entity_row.version, teammate.name,
              teammate.model, teammate.agent_tool
         from public.entities entity_row
         join public.team_members teammate on teammate.entity_id = entity_row.id
        where entity_row.space_id = $1 and entity_row.deleted_at is null`,
      [space.id],
    );
    const byName = new Map(rows.map((row) => [row.name, row]));

    // Repair the historical smoke seed so the current UI stops presenting an
    // unknown tool with an empty model picker after restart.
    const smoke = byName.get('Smoke Agent');
    if (smoke && (smoke.model === null || smoke.agent_tool === null)) {
      await updateTeammate(args.db, claims, smoke, 'claude-sonnet-5', 'claude-code', space.id);
      teammatesUpdated += 1;
    }

    for (const entry of LAUNCH_MODEL_CATALOG) {
      const existing = byName.get(entry.seedName);
      if (!existing) {
        await args.db.rpc(claims, 'public.create_team_member', [
          space.id,
          entry.seedName,
          null,
          'Launch persona',
          `${entry.label} via ${entry.agentTool}`,
          entry.model,
          entry.agentTool,
          'worker',
          null,
          JSON.stringify({}),
          JSON.stringify({}),
          null,
          null,
          null,
          `bootstrap:teammate:${space.id}:${entry.model}`,
        ]);
        teammatesCreated += 1;
      } else if (existing.model !== entry.model || existing.agent_tool !== entry.agentTool) {
        await updateTeammate(args.db, claims, existing, entry.model, entry.agentTool, space.id);
        teammatesUpdated += 1;
      }
    }
  }

  return { spaces: spaces.length, projectId: project.id, teammatesCreated, teammatesUpdated };
}

async function updateTeammate(
  db: Db,
  claims: DbClaims,
  teammate: TeammateRow,
  model: string,
  agentTool: string,
  spaceId: string,
): Promise<void> {
  await db.rpc(claims, 'public.update_team_member', [
    teammate.id,
    teammate.version,
    null,
    null,
    null,
    null,
    model,
    agentTool,
    null,
    null,
    null,
    null,
    null,
    null,
    `bootstrap:teammate-update:${spaceId}:${teammate.id}:v${teammate.version}:${model}`,
  ]);
}
