import {
  CollabError,
  type FileBrowseView,
  type FileReadView,
  type ProjectTrustLevel,
} from '@tm8/contract';

import type { RequestContext } from '../../../http/types.js';
import {
  browseDirectory,
  normalizeRelPath,
  readFileContent,
  resolveRoot,
} from '../../../files/project-files.js';
import { claimsFor, requireUuidParam } from '../../context.js';
import type { FacadeDeps } from '../../deps.js';

/**
 * The Files browser's read surface (FILES-DESIGN §5.1).
 *
 * A browsable root is a project LINKED TO THE SPACE and nothing else (§3), so
 * this service adds no authorization surface: the visibility predicate below is
 * the same one `execution.spawn` already uses
 * (`facade/execution-handlers.ts:175-186`), including its deliberate collapse of
 * not-linked and not-found so the answer cannot leak the existence of projects
 * belonging to spaces the caller is not a member of.
 *
 * §3.1: a member who can see a project can already spawn a shell into it, so
 * read-only browsing grants no capability they do not already hold. That is why
 * this is safe to expose — not a reason to be careless, which is what §4 is for.
 */

interface LinkedProjectRow {
  id: string;
  name: string;
  working_dir: string;
  trust: string;
}

export class W2ProjectFilesService {
  constructor(private readonly deps: FacadeDeps) {}

  /**
   * Resolve a project the caller may browse, or refuse indistinguishably.
   *
   * The `join public.space_projects` is the whole authorization story: RLS keeps
   * the caller out of spaces they do not belong to, and the link table keeps
   * them out of projects that space has not adopted.
   */
  private async requireLinkedProject(
    ctx: RequestContext,
  ): Promise<{ row: LinkedProjectRow; rootReal: string }> {
    const owner = await this.deps.owner();
    const spaceId = requireUuidParam(ctx, 'spaceId');
    const projectId = requireUuidParam(ctx, 'projectId');
    const rows = await this.deps.db.query<LinkedProjectRow>(
      claimsFor(owner, ctx),
      `select p.id, p.name, p.working_dir, p.trust
         from public.projects p
         join public.space_projects sp
           on sp.project_id = p.id and sp.space_id = $2
        where p.id = $1`,
      [projectId, spaceId],
    );
    const row = rows[0];
    if (!row) {
      // Not-linked and not-found are ONE answer on purpose. Distinguishing them
      // would leak the existence of projects outside this space.
      throw new CollabError('not_found', `project ${projectId} is not linked to this space`);
    }
    return { row, rootReal: await resolveRoot(row.working_dir) };
  }

  private static rootOf(row: LinkedProjectRow) {
    return {
      projectId: row.id,
      name: row.name,
      trust: (row.trust === 'trusted' ? 'trusted' : 'untrusted') as ProjectTrustLevel,
    };
  }

  /** GET /v2/spaces/:spaceId/projects/:projectId/files?path= */
  readonly browse = async (ctx: RequestContext): Promise<FileBrowseView> => {
    const { row, rootReal } = await this.requireLinkedProject(ctx);
    const relPath = normalizeRelPath(ctx.query.get('path'));
    const listing = await browseDirectory(rootReal, relPath);
    return { root: W2ProjectFilesService.rootOf(row), ...listing };
  };

  /** GET /v2/spaces/:spaceId/projects/:projectId/files/content?path= */
  readonly read = async (ctx: RequestContext): Promise<FileReadView> => {
    const { rootReal } = await this.requireLinkedProject(ctx);
    const relPath = normalizeRelPath(ctx.query.get('path'));
    if (relPath.length === 0) {
      throw new CollabError('invalid_input', 'path is required and may not be the project root');
    }
    // A refusal rides IN the view (`refusal`), not as an HTTP error: the caller
    // asked a legitimate question and deserves a named answer, not a 4xx that
    // an offline client cannot tell from a network fault.
    return readFileContent(rootReal, relPath);
  };
}
