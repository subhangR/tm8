/**
 * `projects.*` — the linked-resource family (AM-2 §1, T-D17).
 *
 * A project is deliberately NOT an entity: no hierarchy, no edges, no
 * messages, no reactions. It is a repo/workingDir reference owned by the node
 * and linked to spaces many-to-many, which is why it has its own table, its
 * own DTO and its own operation family rather than a `kind`.
 *
 * This family exists on the G1A critical path for one reason: `execution.spawn`
 * takes a typed `projectId` and derives the session's cwd from
 * `project.working_dir` — never from anything a client sent (S11). No project,
 * no spawn.
 */
import {
  CollabError,
  type ProjectCreateInput,
  type ProjectLinkInput,
  type ProjectResource,
  type ProjectUpdateInput,
} from '@tm8/contract';
import type { OperationHandler } from '../../http/types.js';
import type { FacadeDeps } from '../deps.js';
import { claimsFor, commandEnvelope, requireUuidParam } from '../context.js';

interface ProjectRow {
  id: string;
  name: string;
  repo_url: string | null;
  working_dir: string;
  trust: string;
  defaults: Record<string, unknown>;
  created_at: Date | string;
  updated_at: Date | string;
}

function iso(v: Date | string): string {
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

function toProject(row: ProjectRow): ProjectResource {
  return {
    id: row.id,
    name: row.name,
    repoUrl: row.repo_url,
    workingDir: row.working_dir,
    trust: row.trust as ProjectResource['trust'],
    defaults: (row.defaults ?? {}) as ProjectResource['defaults'],
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

const PROJECT_SELECT = `
  select id, name, repo_url, working_dir, trust, defaults, created_at, updated_at
    from public.projects`;

export function projectsList(deps: FacadeDeps): OperationHandler {
  return async (ctx) => {
    const owner = await deps.owner();
    // `projects_select` (008:177) already scopes this to node admins and to
    // members of a linked space. An optional `?spaceId=` narrows it further to
    // "projects this space can spawn into", which is what the spawn UI needs.
    const spaceId = ctx.query.get('spaceId');
    const rows = spaceId
      ? await deps.db.query<ProjectRow>(
          claimsFor(owner, ctx),
          `${PROJECT_SELECT}
            where id in (select project_id from public.space_projects where space_id = $1)
            order by name asc, id asc`,
          [spaceId],
        )
      : await deps.db.query<ProjectRow>(claimsFor(owner, ctx), `${PROJECT_SELECT} order by name asc, id asc`);
    return rows.map(toProject);
  };
}

export function projectsGet(deps: FacadeDeps): OperationHandler {
  return async (ctx) => {
    const owner = await deps.owner();
    const projectId = requireUuidParam(ctx, 'projectId');
    const rows = await deps.db.query<ProjectRow>(
      claimsFor(owner, ctx),
      `${PROJECT_SELECT} where id = $1`,
      [projectId],
    );
    const row = rows[0];
    if (!row) throw new CollabError('not_found', `no such project: ${projectId}`);
    return toProject(row);
  };
}

export function projectsCreate(deps: FacadeDeps): OperationHandler {
  return async (ctx) => {
    const owner = await deps.owner();
    const envelope = commandEnvelope(ctx);
    const input = ctx.body as ProjectCreateInput;

    return deps.db.tx(claimsFor(owner, ctx, envelope), async (q) => {
      const raw = await q.rpc<{ project: ProjectRow }>('create_project', [
        input.name,
        input.workingDir,
        input.repoUrl ?? null,
        // Trust is an explicit grant, never a default (S12). The RPC defaults
        // to 'untrusted' and so does this.
        input.trust ?? 'untrusted',
        JSON.stringify(input.defaults ?? {}),
        envelope.clientMutationId ?? null,
      ]);
      // A BARE ProjectResource, not `{project: ...}`. A project is a resource,
      // not an entity, so there is no CommandResult to wrap it in — and
      // conformance validates ProjectResourceSchema against `data` directly
      // (projects.test.ts:27). This is the one place my earlier
      // "commands wrap, reads do not" summary was wrong.
      return { kind: 'json' as const, status: 201, data: toProject(raw.project) };
    });
  };
}

export function projectsUpdate(deps: FacadeDeps): OperationHandler {
  return async (ctx) => {
    const owner = await deps.owner();
    const envelope = commandEnvelope(ctx);
    const projectId = requireUuidParam(ctx, 'projectId');
    const input = ctx.body as ProjectUpdateInput;

    const raw = await deps.db.rpc<{ project: ProjectRow }>(
      claimsFor(owner, ctx, envelope),
      'update_project',
      [
        projectId,
        input.name ?? null,
        input.workingDir ?? null,
        input.repoUrl ?? null,
        // Trust is patched only when named: `coalesce` in the RPC means an
        // absent field keeps its value, so null is "leave it", not "reset it".
        input.trust ?? null,
        input.defaults === undefined ? null : JSON.stringify(input.defaults),
        envelope.clientMutationId ?? null,
      ],
    );
    // Bare, like create and get — a project is a resource, not an entity.
    return toProject(raw.project);
  };
}

export function projectsLink(deps: FacadeDeps): OperationHandler {
  return async (ctx) => {
    const owner = await deps.owner();
    const envelope = commandEnvelope(ctx);
    const spaceId = requireUuidParam(ctx, 'spaceId');
    const input = ctx.body as ProjectLinkInput;

    const raw = await deps.db.rpc<{ spaceId: string; projectId: string }>(
      claimsFor(owner, ctx, envelope),
      'link_project',
      [spaceId, input.projectId, envelope.actorId ?? null, envelope.clientMutationId ?? null],
    );
    return { spaceId: raw.spaceId, projectId: raw.projectId, patches: [] };
  };
}
