import { scanSpaceSkills } from '../../../skills/service.js';
import {
  CollabError,
  isCollabError,
  type ActorSummary,
  type CorrectProjectAssociationInput,
  type EdgeCorrectionResult,
  type EdgeView,
  type EntityCounters,
  type EntitySummary,
  type CommitSessionAttribution,
  type ProjectBranchTopology,
  type ProjectCreateInput,
  type ProjectFileBlame,
  type ProjectFileHistory,
  type ProjectRevisionDiff,
  type GateFolder,
  type GateFolderCreateInput,
  type GateFolderCreateResult,
  type ProjectResource,
  type SpaceProject,
  type ProjectLinkInput,
  type SpaceProjectCreateInput,
  type ProjectUpdateInput,
} from '@tm8/contract';

import { UNCOMMITTED_OID, readBranchTopology, readFileBlame, readFileHistory, readFileRevisionDiff } from '@tm8/execution';

import type { Querier } from '../../../db/types.js';
import type { RequestContext } from '../../../http/types.js';
import {
  MAX_LIMIT,
  claimsFor,
  commandEnvelope,
  limitOf,
  optionalUuid,
  requireUuidParam,
} from '../../context.js';
import type { FacadeDeps } from '../../deps.js';
import { actorOf, iso, isoOrNull, loadActors } from '../../entity-read.js';
import {
  canonicalDirectory,
  canonicalRoots,
  ensureProjectWorkingDirectory,
  listProjectDirectories,
  requireAllowed,
} from './project-directories.js';
import type { DbClaims } from '../../../db/types.js';
import { projectForgeFacts } from '../../../tracking/pr-projection.js';

/** `?staleAfterDays=` — absent means "use the module's own default". */
function positiveInt(raw: string | null, field: string): number | undefined {
  if (raw === null || raw === '') return undefined;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value <= 0) {
    throw new CollabError('invalid_input', `${field} must be a positive integer, got ${raw}`);
  }
  return value;
}

export interface ProjectRow {
  id: string;
  name: string;
  repo_url: string | null;
  working_dir: string;
  trust: string;
  defaults: Record<string, unknown> | null;
  link_frozen: boolean;
  active_link_count: number;
  created_at: Date | string;
  updated_at: Date | string;
}

interface ProjectMutationResult {
  project: ProjectRow;
}

interface LinkMutationResult {
  spaceId: string;
  projectId: string;
}

/**
 * One row of `public.resolve_project_ref` (234): entity -> grant -> path.
 * `working_dir` is for the SERVER (git, spawn, files) and reaches a client
 * only when the caller is a gate admin.
 */
export interface ResolvedProjectRow {
  folder_id: string;
  project_entity_id: string | null;
  space_id: string | null;
  name: string;
  working_dir: string;
  trust: string;
  repo_url: string | null;
  defaults: Record<string, unknown> | null;
}

interface SpaceProjectRow {
  project_id: string;
  folder_id: string;
  name: string;
  repo_url: string | null;
  trust: string;
  defaults: Record<string, unknown> | null;
  materialized_version: number;
  created_at: Date | string;
  updated_at: Date | string;
}

interface GateFolderRow {
  folder_id: string;
  name: string;
  working_dir: string;
  repo_url: string | null;
  trust: string;
  defaults: Record<string, unknown> | null;
  created_at: Date | string;
  updated_at: Date | string;
  grants: Array<{
    spaceId: string; spaceName: string; projectId: string | null;
    grantedBy: string | null; grantedAt: string;
  }> | null;
}

/**
 * The caller's project by id — the space's project ENTITY id, or (until the
 * clients move) the folder id — or null. Membership (pinned, 227) decides:
 * another space's project answers exactly like one that does not exist.
 */
export async function resolveProjectRef(
  q: Pick<Querier, 'query'>,
  ref: string,
  spaceId: string | null = null,
): Promise<ResolvedProjectRow | null> {
  const rows = await q.query<ResolvedProjectRow>(
    'select * from public.resolve_project_ref($1::uuid, $2::uuid)',
    [ref, spaceId],
  );
  return rows[0] ?? null;
}

/** A gate (node) admin on a session not pinned to one space: the only caller that sees paths. */
export function isGateAdmin(claims: DbClaims): boolean {
  return claims.nodeAdmin === true && !claims.sessionSpaceId;
}

function toSpaceProject(spaceId: string, row: SpaceProjectRow): SpaceProject {
  return {
    id: row.project_id,
    spaceId,
    folderId: row.folder_id,
    name: row.name,
    repoUrl: row.repo_url,
    trust: row.trust as SpaceProject['trust'],
    defaults: (row.defaults ?? {}) as SpaceProject['defaults'],
    materializedVersion: Number(row.materialized_version),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function toGateFolder(row: GateFolderRow): GateFolder {
  return {
    id: row.folder_id,
    name: row.name,
    workingDir: row.working_dir,
    repoUrl: row.repo_url,
    trust: row.trust as GateFolder['trust'],
    defaults: (row.defaults ?? {}) as GateFolder['defaults'],
    grants: (row.grants ?? []).map((grant) => ({
      ...grant,
      grantedAt: iso(grant.grantedAt),
    })),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

interface CorrectionMutationResult {
  artifactId: string;
  projectId: string;
  outcome: EdgeCorrectionResult['outcome'];
  edgeId: string | null;
}

interface CorrectionEdgeRow {
  id: string;
  type: string;
  props: Record<string, unknown> | null;
  created_by: string;
  created_at: Date | string;
  updated_at: Date | string;
  artifact_id: string;
  artifact_space_id: string;
  artifact_kind: 'pull_request' | 'commit';
  artifact_parent_id: string | null;
  artifact_position: number | null;
  artifact_visibility: 'space' | 'restricted';
  artifact_version: number;
  artifact_activity_at: Date | string;
  artifact_created_at: Date | string;
  artifact_updated_at: Date | string;
  artifact_deleted_at: Date | string | null;
  artifact_created_by: string;
  artifact_likes: number | string;
  artifact_dislikes: number | string;
  artifact_stars: number | string;
  artifact_points: number | string;
  artifact_messages: number | string;
  artifact_viewer_reaction: 'like' | 'dislike' | 'star' | null;
  pr_title: string | null;
  pr_repo: string | null;
  pr_number: number | null;
  pr_state: string | null;
  pr_ci_status: string | null;
  pr_mergeable_state: string | null;
  pr_head_ref: string | null;
  pr_url: string | null;
  pr_fetched_at: Date | string | null;
  commit_repo: string | null;
  commit_sha: string | null;
  commit_message: string | null;
  commit_committed_at: Date | string | null;
  project_entity_id: string;
  project_space_id: string;
  project_parent_id: string | null;
  project_position: number | null;
  project_visibility: 'space' | 'restricted';
  project_version: number;
  project_activity_at: Date | string;
  project_created_at: Date | string;
  project_updated_at: Date | string;
  project_deleted_at: Date | string | null;
  project_created_by: string;
  project_likes: number | string;
  project_dislikes: number | string;
  project_stars: number | string;
  project_points: number | string;
  project_messages: number | string;
  project_viewer_reaction: 'like' | 'dislike' | 'star' | null;
  project_id: string;
  project_name: string;
  materialized_version: number;
}

const PROJECT_SELECT = `
  select id, name, repo_url, working_dir, trust, defaults,
         link_frozen, active_link_count, created_at, updated_at
    from public.projects`;

export function toProjectResource(row: ProjectRow): ProjectResource {
  return {
    id: row.id,
    name: row.name,
    repoUrl: row.repo_url,
    workingDir: row.working_dir,
    trust: row.trust as ProjectResource['trust'],
    defaults: (row.defaults ?? {}) as ProjectResource['defaults'],
    linkFrozen: row.link_frozen,
    activeLinkCount: Number(row.active_link_count),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function normalizeFrozenProjectReason(error: unknown): never {
  if (isCollabError(error)) {
    const details = error.details as Record<string, unknown> | undefined;
    const reason = typeof details?.detail === 'string' ? details.detail : undefined;
    if (reason && ['project_not_linked', 'project_over_cap', 'project_association_cap', 'folder_granted_elsewhere'].includes(reason)) {
      const { detail: _detail, ...rest } = details ?? {};
      throw new CollabError(error.code, error.message, {
        details: { ...rest, reason },
        current: error.current,
      });
    }
  }
  throw error;
}

function counters(row: CorrectionEdgeRow, prefix: 'artifact' | 'project'): EntityCounters {
  return {
    likes: Number(row[`${prefix}_likes`]),
    dislikes: Number(row[`${prefix}_dislikes`]),
    stars: Number(row[`${prefix}_stars`]),
    points: Number(row[`${prefix}_points`]),
    messages: Number(row[`${prefix}_messages`]),
    viewerReaction: row[`${prefix}_viewer_reaction`],
  };
}

function commonSummary(
  row: CorrectionEdgeRow,
  prefix: 'artifact' | 'project',
  createdBy: ActorSummary,
): Omit<EntitySummary, 'kind' | 'title' | 'state'> {
  return {
    id: row[`${prefix}_id` as 'artifact_id' | 'project_id'],
    spaceId: row[`${prefix}_space_id`],
    parentId: row[`${prefix}_parent_id`],
    position: Number(row[`${prefix}_position`] ?? 0),
    visibility: row[`${prefix}_visibility`],
    version: Number(row[`${prefix}_version`]),
    activityAt: iso(row[`${prefix}_activity_at`]),
    createdAt: iso(row[`${prefix}_created_at`]),
    updatedAt: iso(row[`${prefix}_updated_at`]),
    deletedAt: isoOrNull(row[`${prefix}_deleted_at`]),
    createdBy,
    counters: counters(row, prefix),
    badges: row[`${prefix}_visibility`] === 'restricted' ? { restricted: true } : {},
  };
}

function artifactSummary(row: CorrectionEdgeRow, createdBy: ActorSummary): EntitySummary {
  const common = commonSummary(row, 'artifact', createdBy);
  if (row.artifact_kind === 'pull_request') {
    return {
      ...common,
      kind: 'pull_request',
      title: row.pr_title ?? 'Pull request',
      state: {
        kind: 'pull_request',
        repository: row.pr_repo ?? '',
        number: Number(row.pr_number ?? 0),
        state: row.pr_state ?? 'open',
        ...(row.pr_url ? { url: row.pr_url } : {}),
        fetchedAt: isoOrNull(row.pr_fetched_at),
        stale: row.pr_fetched_at === null,
        ...projectForgeFacts(row.pr_ci_status, row.pr_mergeable_state, row.pr_head_ref),
      },
    };
  }
  return {
    ...common,
    kind: 'commit',
    title: row.commit_message?.split('\n', 1)[0] || row.commit_sha || 'Commit',
    state: {
      kind: 'commit',
      repository: row.commit_repo ?? '',
      sha: row.commit_sha ?? '',
      message: row.commit_message ?? '',
      committedAt: isoOrNull(row.commit_committed_at),
    },
  };
}

function projectSummary(row: CorrectionEdgeRow, createdBy: ActorSummary): EntitySummary {
  return {
    ...commonSummary(row, 'project', createdBy),
    id: row.project_entity_id,
    kind: 'project',
    title: row.project_name,
    state: {
      kind: 'project',
      projectId: row.project_id,
      materializedVersion: Number(row.materialized_version),
    },
  };
}

async function loadCorrectionEdge(
  q: Querier,
  edgeId: string,
): Promise<EdgeView> {
  const rows = await q.query<CorrectionEdgeRow>(
    `select edge.id, edge.type, edge.props, edge.created_by, edge.created_at, edge.updated_at,
            artifact.id artifact_id, artifact.space_id artifact_space_id,
            artifact.kind artifact_kind, artifact.parent_id artifact_parent_id,
            artifact.position artifact_position, artifact.visibility artifact_visibility,
            artifact.version artifact_version, artifact.activity_at artifact_activity_at,
            artifact.created_at artifact_created_at, artifact.updated_at artifact_updated_at,
            artifact.deleted_at artifact_deleted_at, artifact.created_by artifact_created_by,
            coalesce(artifact_counter.likes, 0) artifact_likes,
            coalesce(artifact_counter.dislikes, 0) artifact_dislikes,
            coalesce(artifact_counter.stars, 0) artifact_stars,
            coalesce(artifact_counter.points, 0) artifact_points,
            coalesce(artifact_counter.messages, 0) artifact_messages,
            case artifact_reaction.type when 'likes' then 'like'
                 when 'dislikes' then 'dislike' when 'stars' then 'star' end artifact_viewer_reaction,
            pr.title pr_title, pr.repo pr_repo, pr.number pr_number, pr.state pr_state,
            pr.url pr_url, pr.fetched_at pr_fetched_at,
            pr.ci_status pr_ci_status, pr.mergeable_state pr_mergeable_state,
            pr.head_ref pr_head_ref,
            commit_row.repo commit_repo, commit_row.sha commit_sha,
            commit_row.message commit_message, commit_row.committed_at commit_committed_at,
            projection.id project_entity_id, projection.space_id project_space_id,
            projection.parent_id project_parent_id, projection.position project_position,
            projection.visibility project_visibility, projection.version project_version,
            projection.activity_at project_activity_at, projection.created_at project_created_at,
            projection.updated_at project_updated_at, projection.deleted_at project_deleted_at,
            projection.created_by project_created_by,
            coalesce(project_counter.likes, 0) project_likes,
            coalesce(project_counter.dislikes, 0) project_dislikes,
            coalesce(project_counter.stars, 0) project_stars,
            coalesce(project_counter.points, 0) project_points,
            coalesce(project_counter.messages, 0) project_messages,
            case project_reaction.type when 'likes' then 'like'
                 when 'dislikes' then 'dislike' when 'stars' then 'star' end project_viewer_reaction,
            detail.project_id, detail.name project_name,
            detail.materialized_version
       from public.edges edge
       join public.entities artifact on artifact.id = edge.src_id and artifact.deleted_at is null
       join public.entities projection on projection.id = edge.dst_id and projection.deleted_at is null
       join public.project_projection_details detail on detail.entity_id = projection.id
       left join public.pull_requests pr on pr.entity_id = artifact.id
       left join public.commits commit_row on commit_row.entity_id = artifact.id
       left join public.entity_counters artifact_counter on artifact_counter.entity_id = artifact.id
       left join public.entity_counters project_counter on project_counter.entity_id = projection.id
       left join public.edges artifact_reaction
         on artifact_reaction.dst_id = artifact.id and artifact_reaction.type in ('likes','dislikes','stars')
        and exists (select 1 from public.members viewer
                     where viewer.entity_id = artifact_reaction.src_id
                       and viewer.identity_id = internal.identity_id())
       left join public.edges project_reaction
         on project_reaction.dst_id = projection.id and project_reaction.type in ('likes','dislikes','stars')
        and exists (select 1 from public.members viewer
                     where viewer.entity_id = project_reaction.src_id
                       and viewer.identity_id = internal.identity_id())
      where edge.id = $1 and edge.type = 'in_project'`,
    [edgeId],
  );
  const row = rows[0];
  if (!row) throw new CollabError('not_found', `no such edge: ${edgeId}`);
  const actors = await loadActors(q, [row.created_by, row.artifact_created_by, row.project_created_by]);
  return {
    id: row.id,
    type: row.type,
    source: artifactSummary(row, actorOf(actors, row.artifact_created_by)),
    target: projectSummary(row, actorOf(actors, row.project_created_by)),
    props: row.props ?? {},
    createdBy: actorOf(actors, row.created_by),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function updatePatch(input: ProjectUpdateInput): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.workingDir !== undefined) patch.workingDir = input.workingDir;
  if (input.repoUrl !== undefined) patch.repoUrl = input.repoUrl;
  if (input.trust !== undefined) patch.trust = input.trust;
  if (input.defaults !== undefined) patch.defaults = input.defaults;
  return patch;
}

export class W2ProjectsAssociationsService {
  constructor(private readonly deps: FacadeDeps) {}

  readonly listProjectDirectories = async (ctx: RequestContext) => {
    const owner = await this.deps.owner();
    const claims = claimsFor(owner, ctx);
    // NODE-ADMIN ONLY, and it is the create rule that decides this rather than
    // a fresh judgement about listings: `createProject` below refuses every
    // non-admin on BOTH branches, so a non-admin who browses can never act on
    // what they find. Browsing was the odd one out — the one filesystem verb
    // open to any authenticated user — and that was survivable only while a
    // node had a single account.
    //
    // It stopped being survivable once space roles became writable and
    // invite-bound signup made ordinary members routine and numerous: the
    // default browse scope is the OS filesystem root (see
    // `project-directories.ts`), and `project-files.ts` shares the same
    // `canonicalRoots`/`requireAllowed`, so the scope governs reading file
    // CONTENTS too. The secret filter there is a denylist, and a denylist over
    // one home directory is a different proposition from a denylist over the
    // whole filesystem: it fails open on whatever nobody thought to list.
    //
    // What remains for non-admins is unchanged and is the honest surface for
    // them: the files of a project an admin already linked, read through
    // `projects.files.list` and scoped to that project's working directory.
    if (claims.nodeAdmin !== true) {
      throw new CollabError('forbidden', 'node-admin access is required to browse node directories');
    }
    return listProjectDirectories(ctx.query.get('path') ?? undefined);
  };

  /**
   * `projects.list`. W11 (234): the node-wide folder list is the gate's
   * (`gate.folders.list` is its successor); with `?spaceId=` it is the
   * member's view of that space's projects, kept in the legacy
   * `ProjectResource` shape (id = the folder id every client still keys on,
   * plus `projectEntityId`) until the clients move to `spaces.projects.list`.
   * A path is present only for a gate admin.
   */
  readonly listProjects = async (ctx: RequestContext): Promise<ProjectResource[]> => {
    const owner = await this.deps.owner();
    const claims = claimsFor(owner, ctx);
    const spaceId = optionalUuid(ctx.query.get('spaceId'), 'spaceId');
    if (!spaceId) {
      if (!isGateAdmin(claims)) {
        throw new CollabError('forbidden', 'gate-admin access is required to list the folders on this server');
      }
      const rows = await this.deps.db.query<ProjectRow>(claims, `${PROJECT_SELECT} order by name asc, id asc`);
      return rows.map(toProjectResource);
    }
    const rows = await this.deps.db.query<SpaceProjectRow>(
      claims,
      'select * from public.space_projects_for_caller($1::uuid)',
      [spaceId],
    );
    const paths = await this.gatePaths(claims, rows.map((row) => row.folder_id));
    return rows.map((row) => ({
      id: row.folder_id,
      name: row.name,
      repoUrl: row.repo_url,
      ...(paths.has(row.folder_id) ? { workingDir: paths.get(row.folder_id)! } : {}),
      projectEntityId: row.project_id,
      spaceId,
      trust: row.trust as ProjectResource['trust'],
      defaults: (row.defaults ?? {}) as ProjectResource['defaults'],
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
    }));
  };

  /** Folder paths for a gate admin (RLS: `projects_select` is gate-only since 234); empty for anyone else. */
  private async gatePaths(claims: DbClaims, folderIds: readonly string[]): Promise<Map<string, string>> {
    if (!isGateAdmin(claims) || folderIds.length === 0) return new Map();
    const rows = await this.deps.db.query<{ id: string; working_dir: string }>(
      claims,
      'select id, working_dir from public.projects where id = any($1::uuid[])',
      [folderIds],
    );
    return new Map(rows.map((row) => [row.id, row.working_dir]));
  }

  /**
   * The project a request names (`:projectId` = the space's project entity id
   * or the folder id), resolved under the caller's claims. The path it carries
   * is for the server; `not_found` covers "another space's".
   */
  private async resolvedFor(ctx: RequestContext): Promise<{ row: ResolvedProjectRow; claims: DbClaims; projectId: string }> {
    const owner = await this.deps.owner();
    const claims = claimsFor(owner, ctx);
    const projectId = requireUuidParam(ctx, 'projectId');
    const row = await this.deps.db.tx(claims, (q) => resolveProjectRef(q, projectId));
    if (!row) throw new CollabError('not_found', `no such project: ${projectId}`);
    return { row, claims, projectId };
  }

  readonly getProject = async (ctx: RequestContext): Promise<ProjectResource> => {
    const { row, claims } = await this.resolvedFor(ctx);
    if (isGateAdmin(claims)) {
      const full = (await this.deps.db.query<ProjectRow>(claims, `${PROJECT_SELECT} where id = $1`, [row.folder_id]))[0];
      if (full) {
        return {
          ...toProjectResource(full),
          ...(row.project_entity_id ? { name: row.name, projectEntityId: row.project_entity_id, spaceId: row.space_id } : {}),
        };
      }
    }
    const stamps = row.project_entity_id
      ? (await this.deps.db.query<{ created_at: Date | string; updated_at: Date | string }>(
          claims,
          'select created_at, updated_at from public.entities where id = $1',
          [row.project_entity_id],
        ))[0]
      : undefined;
    const epoch = new Date(0).toISOString();
    return {
      id: row.folder_id,
      name: row.name,
      repoUrl: row.repo_url,
      projectEntityId: row.project_entity_id,
      spaceId: row.space_id,
      trust: row.trust as ProjectResource['trust'],
      defaults: (row.defaults ?? {}) as ProjectResource['defaults'],
      createdAt: stamps ? iso(stamps.created_at) : epoch,
      updatedAt: stamps ? iso(stamps.updated_at) : epoch,
    };
  };

  /**
   * Branch topology for the project's working directory.
   *
   * THE PATH COMES FROM THE GRANT, NEVER FROM THE REQUEST. This read runs git
   * in a directory on the node, so a caller-supplied `workingDir` would be an
   * arbitrary-directory read wearing a project id. Authorization is exactly
   * `projects.get`'s (`resolve_project_ref`): if you cannot read the project,
   * you cannot learn anything about its checkout — and a member never learns
   * where the checkout is.
   */
  readonly listBranches = async (ctx: RequestContext): Promise<ProjectBranchTopology> => {
    const { row, claims, projectId } = await this.resolvedFor(ctx);
    const showPath = isGateAdmin(claims);
    try {
      const topology = await readBranchTopology(row.working_dir, {
        staleAfterDays: positiveInt(ctx.query.get('staleAfterDays'), 'staleAfterDays'),
        maxBranches: limitOf(ctx.query.get('limit'), MAX_LIMIT),
      });
      return { projectId, ...(showPath ? { workingDir: row.working_dir } : {}), ...topology };
    } catch (error) {
      // A working directory that is not a repository is a CONFIGURATION fact
      // about the project, not a server fault. Saying `internal` here would
      // send the user looking for a bug in tm8 instead of at their own path.
      const reason = (error as { reason?: string }).reason;
      if (reason === 'not_a_git_repository' || reason === 'no_default_branch') {
        throw new CollabError(
          'invalid_input',
          showPath
            ? `project ${projectId} working directory ${row.working_dir}: ${reason}`
            : `project ${projectId} folder: ${reason}`,
        );
      }
      throw error;
    }
  };

  /** `?path=` — the one pathspec both file reads take. Shape-checked here; the execution module re-refuses. */
  private static pathParam(ctx: RequestContext): string {
    const path = ctx.query.get('path');
    if (path === null || path === '') {
      throw new CollabError('invalid_input', 'path query parameter is required');
    }
    return path;
  }

  /**
   * The `invalid_input`-class facts about the CALLER's project or path keep
   * their contract code; anything else stays what it was. Same reasoning as
   * listBranches: `internal` for a non-repo sends users hunting a tm8 bug.
   */
  private static liftFileReadError(error: unknown, projectId: string, workingDir: string | null): never {
    const maybe = error as { code?: string; reason?: string };
    if (maybe.code === 'invalid_input') {
      throw new CollabError(
        'invalid_input',
        workingDir === null
          ? `project ${projectId} folder: ${maybe.reason ?? 'invalid_input'}`
          : `project ${projectId} working directory ${workingDir}: ${maybe.reason ?? 'invalid_input'}`,
        { details: { reason: maybe.reason ?? 'invalid_input' } },
      );
    }
    throw error;
  }

  /**
   * The attribution join — commit sha → `commits` row → `created_in` edge →
   * work_session (→ its teammate over the newest `relates_to` edge). Read
   * under the caller's claims so RLS decides what provenance is visible.
   *
   * ABSENT FACTS ARE ABSENT CLAIMS: a sha with no row here gets NO entry in
   * the map, and callers render null — never a name-match or timestamp guess.
   */
  private async attributionFor(
    ctx: RequestContext,
    shas: readonly string[],
  ): Promise<Map<string, CommitSessionAttribution>> {
    const attribution = new Map<string, CommitSessionAttribution>();
    const unique = [...new Set(shas.map((s) => s.toLowerCase()))];
    if (unique.length === 0) return attribution;
    const owner = await this.deps.owner();
    interface JoinRow {
      sha: string;
      commit_entity_id: string;
      session_id: string;
      session_title: string;
      agent_tool: string | null;
      team_member_id: string | null;
      team_member_name: string | null;
    }
    const rows = await this.deps.db.query<JoinRow>(
      claimsFor(owner, ctx),
      `select c.sha, c.entity_id as commit_entity_id,
              ws.entity_id as session_id, ws.title as session_title, ws.agent_tool,
              tm.entity_id as team_member_id, tm.name as team_member_name
         from public.commits c
         join public.edges e on e.src_id = c.entity_id and e.type = 'created_in'
         join public.work_sessions ws on ws.entity_id = e.dst_id
         left join lateral (
           select t.entity_id, t.name
             from public.edges ed
             join public.team_members t on t.entity_id = ed.dst_id
            where ed.src_id = ws.entity_id and ed.type = 'relates_to'
            order by ed.created_at desc
            limit 1
         ) tm on true
        where c.sha = any($1)
        order by e.created_at asc`,
      [unique],
    );
    for (const row of rows) {
      // One `created_in` per commit ENTITY; if the same sha is mirrored in
      // two visible spaces, first (oldest) recorded provenance wins here.
      if (attribution.has(row.sha)) continue;
      attribution.set(row.sha, {
        commitEntityId: row.commit_entity_id,
        sessionId: row.session_id,
        sessionTitle: row.session_title,
        agentTool: row.agent_tool,
        teamMemberId: row.team_member_id,
        teamMemberName: row.team_member_name,
      });
    }
    return attribution;
  }

  /** `projects.file.history` — revisions of one path, each with its provenance join. */
  readonly fileHistory = async (ctx: RequestContext): Promise<ProjectFileHistory> => {
    const { row, claims, projectId } = await this.resolvedFor(ctx);
    const shownDir = isGateAdmin(claims) ? row.working_dir : null;
    const path = W2ProjectsAssociationsService.pathParam(ctx);
    let history;
    try {
      history = await readFileHistory(row.working_dir, path, {
        ...(positiveInt(ctx.query.get('maxRevisions'), 'maxRevisions') === undefined
          ? {}
          : { maxRevisions: positiveInt(ctx.query.get('maxRevisions'), 'maxRevisions') as number }),
      });
    } catch (error) {
      W2ProjectsAssociationsService.liftFileReadError(error, projectId, shownDir);
    }
    const attribution = await this.attributionFor(ctx, history.revisions.map((r) => r.oid));

    // `?diffOid=` — the patch ONE selected revision applied to the path, so
    // the history browser can render a diff without a third operation. Asked
    // with the path AT that revision (rename-follow), read from the window.
    const diffOid = ctx.query.get('diffOid');
    let diff: ProjectRevisionDiff | null = null;
    if (diffOid !== null && diffOid !== '') {
      const revision = history.revisions.find((r) => r.oid === diffOid.toLowerCase());
      try {
        diff = await readFileRevisionDiff(row.working_dir, revision?.path ?? path, diffOid.toLowerCase());
      } catch (error) {
        W2ProjectsAssociationsService.liftFileReadError(error, projectId, shownDir);
      }
    }

    return {
      projectId,
      ...(shownDir === null ? {} : { workingDir: shownDir }),
      path,
      revisions: history.revisions.map((r) => ({
        ...r,
        session: attribution.get(r.oid.toLowerCase()) ?? null,
      })),
      truncated: history.truncated,
      diff,
    };
  };

  /** `projects.file.blame` — working-tree blame with the session-attribution overlay. */
  readonly fileBlame = async (ctx: RequestContext): Promise<ProjectFileBlame> => {
    const { row, claims, projectId } = await this.resolvedFor(ctx);
    const shownDir = isGateAdmin(claims) ? row.working_dir : null;
    const path = W2ProjectsAssociationsService.pathParam(ctx);
    let blame;
    try {
      blame = await readFileBlame(row.working_dir, path, {
        ...(positiveInt(ctx.query.get('maxLines'), 'maxLines') === undefined
          ? {}
          : { maxLines: positiveInt(ctx.query.get('maxLines'), 'maxLines') as number }),
      });
    } catch (error) {
      W2ProjectsAssociationsService.liftFileReadError(error, projectId, shownDir);
    }
    // Uncommitted lines are not commits — never joined, never attributed.
    const attribution = await this.attributionFor(
      ctx,
      blame.hunks.filter((h) => h.oid !== UNCOMMITTED_OID).map((h) => h.oid),
    );
    return {
      projectId,
      ...(shownDir === null ? {} : { workingDir: shownDir }),
      path,
      hunks: blame.hunks.map((h) => ({
        ...h,
        uncommitted: h.oid === UNCOMMITTED_OID,
        session: h.oid === UNCOMMITTED_OID ? null : (attribution.get(h.oid.toLowerCase()) ?? null),
      })),
      blamedLines: blame.blamedLines,
      totalLines: blame.totalLines,
      truncated: blame.truncated,
    };
  };

  readonly createProject = async (ctx: RequestContext): Promise<ProjectResource> => {
    const owner = await this.deps.owner();
    const input = ctx.body as ProjectCreateInput;
    const envelope = commandEnvelope(ctx);
    const claims = claimsFor(owner, ctx, envelope);
    // `create_project` is node-admin-only in the DB (007's require_node_admin),
    // for BOTH branches — not just the mkdir one. Refusing here keeps the
    // refusal truthful and early instead of surfacing the raw plpgsql
    // 'node admin required' after the directory branch has already run.
    if (claims.nodeAdmin !== true) {
      throw new CollabError(
        'forbidden',
        input.ensureWorkingDir
          ? 'node-admin access is required to create a project directory'
          : 'node-admin access is required to create a project',
      );
    }
    const workingDir = input.ensureWorkingDir
      ? await ensureProjectWorkingDirectory(input.workingDir)
      : input.workingDir;
    const raw = await this.deps.db.rpc<ProjectMutationResult>(
      claims,
      'create_project',
      [
        input.name,
        workingDir,
        input.repoUrl ?? null,
        input.trust ?? 'untrusted',
        JSON.stringify(input.defaults ?? {}),
        envelope.clientMutationId ?? null,
      ],
    );
    const linked = await this.deps.db.query<{ space_id: string }>(claims,
      'select space_id from public.space_projects where project_id = $1', [raw.project.id]);
    for (const link of linked) {
      await scanSpaceSkills(this.deps.db, claims, link.space_id, { root: raw.project.id });
    }
    return toProjectResource(raw.project);
  };

  readonly updateProject = async (ctx: RequestContext): Promise<ProjectResource> => {
    const owner = await this.deps.owner();
    const projectId = requireUuidParam(ctx, 'projectId');
    const input = ctx.body as ProjectUpdateInput;
    const envelope = commandEnvelope(ctx);
    try {
      const raw = await this.deps.db.rpc<ProjectMutationResult>(
        claimsFor(owner, ctx, envelope),
        'update_project_w2',
        [projectId, JSON.stringify(updatePatch(input)), envelope.clientMutationId ?? null],
      );
      return toProjectResource(raw.project);
    } catch (error) {
      normalizeFrozenProjectReason(error);
    }
  };

  /**
   * `spaces.projects.list` — the space's projects, for any member of it.
   * Never a path (W11): the folder behind each is the gate's.
   */
  readonly listSpaceProjects = async (ctx: RequestContext): Promise<SpaceProject[]> => {
    const owner = await this.deps.owner();
    const spaceId = requireUuidParam(ctx, 'spaceId');
    const rows = await this.deps.db.query<SpaceProjectRow>(
      claimsFor(owner, ctx),
      'select * from public.space_projects_for_caller($1::uuid)',
      [spaceId],
    );
    return rows.map((row) => toSpaceProject(spaceId, row));
  };

  /**
   * `spaces.projects.create` — a space admin names the space's project on a
   * folder granted to that space. A folder granted to another space is refused
   * with "this folder belongs to another space" (T30); a gate admin may grant
   * an ungranted folder in the same step.
   */
  readonly createSpaceProject = async (ctx: RequestContext): Promise<SpaceProject> => {
    const owner = await this.deps.owner();
    const spaceId = requireUuidParam(ctx, 'spaceId');
    const input = ctx.body as SpaceProjectCreateInput;
    const envelope = commandEnvelope(ctx);
    const claims = claimsFor(owner, ctx, envelope);
    const raw = await this.deps.db.rpc<{ spaceId: string; folderId: string; projectId: string }>(
      claims,
      'create_space_project',
      [spaceId, input.folderId, input.name ?? null, envelope.clientMutationId ?? null],
    );
    await scanSpaceSkills(this.deps.db, claims, raw.spaceId, { root: raw.folderId });
    const rows = await this.deps.db.query<SpaceProjectRow>(
      claims,
      'select * from public.space_projects_for_caller($1::uuid) where project_id = $2',
      [raw.spaceId, raw.projectId],
    );
    const row = rows[0];
    if (!row) throw new CollabError('not_found', `no such project: ${raw.projectId}`);
    return toSpaceProject(raw.spaceId, row);
  };

  /** `gate.folders.list` — every folder on this server with its grant(s). Gate admins only (T32). */
  readonly listGateFolders = async (ctx: RequestContext): Promise<GateFolder[]> => {
    const owner = await this.deps.owner();
    const claims = claimsFor(owner, ctx);
    if (!isGateAdmin(claims)) {
      throw new CollabError('forbidden', 'gate-admin access is required to list the folders on this server');
    }
    const rows = await this.deps.db.query<GateFolderRow>(claims, 'select * from public.gate_folders_list()');
    return rows.map(toGateFolder);
  };

  /**
   * `gate.folders.create` — register a folder inside TM8_PROJECT_ROOTS
   * (reusing the row when the canonical path is already registered) and,
   * with `spaceId`, grant it to that one space. Gate admins only.
   */
  readonly createGateFolder = async (ctx: RequestContext): Promise<GateFolderCreateResult> => {
    const owner = await this.deps.owner();
    const input = ctx.body as GateFolderCreateInput;
    const envelope = commandEnvelope(ctx);
    const claims = claimsFor(owner, ctx, envelope);
    if (!isGateAdmin(claims)) {
      throw new CollabError('forbidden', 'gate-admin access is required to register a folder');
    }
    let workingDir: string;
    if (input.ensureWorkingDir) {
      workingDir = await ensureProjectWorkingDirectory(input.workingDir);
    } else {
      workingDir = await canonicalDirectory(input.workingDir);
      requireAllowed(workingDir, await canonicalRoots());
    }
    const raw = await this.deps.db.rpc<{ folderId: string; created: boolean; spaceId: string | null }>(
      claims,
      'register_folder',
      [
        input.name,
        workingDir,
        input.repoUrl ?? null,
        input.trust ?? 'untrusted',
        JSON.stringify(input.defaults ?? {}),
        input.spaceId ?? null,
        envelope.clientMutationId ?? null,
      ],
    );
    if (raw.spaceId) await scanSpaceSkills(this.deps.db, claims, raw.spaceId, { root: raw.folderId });
    const rows = await this.deps.db.query<GateFolderRow>(
      claims,
      'select * from public.gate_folders_list() where folder_id = $1',
      [raw.folderId],
    );
    const row = rows[0];
    if (!row) throw new CollabError('not_found', `no such folder: ${raw.folderId}`);
    return { folder: toGateFolder(row), created: raw.created };
  };

  /**
   * `projects.link` — link a folder into a space. It stays (decision 29): the
   * database decides whether a folder already granted to another space may be
   * linked again, from the node policy the server wrote at boot. Only a
   * loopback-only `single` node allows it; everywhere else it is refused with
   * "this folder belongs to another space" (T30).
   */
  readonly linkProject = async (ctx: RequestContext): Promise<LinkMutationResult & { patches: [] }> => {
    const owner = await this.deps.owner();
    const spaceId = requireUuidParam(ctx, 'spaceId');
    const input = ctx.body as ProjectLinkInput;
    const envelope = commandEnvelope(ctx);
    try {
      const raw = await this.deps.db.rpc<LinkMutationResult>(
        claimsFor(owner, ctx, envelope),
        'link_project_w2',
        [spaceId, input.projectId, envelope.actorId ?? null, envelope.clientMutationId ?? null],
      );
      await scanSpaceSkills(this.deps.db, claimsFor(owner, ctx, envelope), raw.spaceId, { root: raw.projectId });
      return { spaceId: raw.spaceId, projectId: raw.projectId, patches: [] };
    } catch (error) {
      normalizeFrozenProjectReason(error);
    }
  };

  readonly unlinkProject = async (ctx: RequestContext): Promise<LinkMutationResult & { patches: [] }> => {
    const owner = await this.deps.owner();
    const spaceId = requireUuidParam(ctx, 'spaceId');
    const projectId = requireUuidParam(ctx, 'projectId');
    const envelope = commandEnvelope(ctx);
    try {
      const raw = await this.deps.db.rpc<LinkMutationResult>(
        claimsFor(owner, ctx, envelope),
        'unlink_project_w2',
        [spaceId, projectId, envelope.clientMutationId ?? null],
      );
      return { spaceId: raw.spaceId, projectId: raw.projectId, patches: [] };
    } catch (error) {
      normalizeFrozenProjectReason(error);
    }
  };

  readonly correctProjectAssociation = async (ctx: RequestContext): Promise<EdgeCorrectionResult> => {
    const owner = await this.deps.owner();
    const artifactId = requireUuidParam(ctx, 'artifactId');
    const input = ctx.body as CorrectProjectAssociationInput;
    const envelope = commandEnvelope(ctx);
    try {
      return await this.deps.db.tx(claimsFor(owner, ctx, envelope), async (q) => {
        const raw = await q.rpc<CorrectionMutationResult>('correct_project_association', [
          artifactId,
          input.projectId,
          input.expectedArtifactVersion,
          input.clientMutationId,
        ]);
        return {
          artifactId: raw.artifactId,
          projectId: raw.projectId,
          outcome: raw.outcome,
          edge: raw.edgeId ? await loadCorrectionEdge(q, raw.edgeId) : null,
        };
      });
    } catch (error) {
      normalizeFrozenProjectReason(error);
    }
  };
}
