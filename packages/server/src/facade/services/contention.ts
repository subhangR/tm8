/**
 * `projects.contention` — the file-contention map, read-only.
 *
 * The killer this targets: two lanes branch from the same base, both merge
 * cleanly, and one silently reverts the other's fix because they touched the
 * same file. Merge tools only see that AFTER the second merge; this read sees
 * it while both lanes are still ACTIVE, by intersecting the touched-path sets
 * of every active worktree of a project.
 *
 * Facts come from two places and only two: `public.worktrees` (which lanes
 * exist, where, from what base — read under the CALLER's claims, so RLS
 * decides which lanes they may see) and read-only argv git against those
 * paths (what each lane touched). A worktree whose directory this node cannot
 * read is reported as SKIPPED with its reason, never silently omitted — an
 * unreadable lane is exactly the one you want named in a contention report.
 */
import { CollabError, type ContentionLane, type ContentionPair, type ContentionReport } from '@tm8/contract';

import type { RequestContext } from '../../http/types.js';
import { claimsFor, requireUuidParam } from '../context.js';
import type { FacadeDeps } from '../deps.js';
import type { HandlerRegistry } from '../registry.js';
import { touchedPaths } from '../../tracking/git-local.js';

interface WorktreeRow {
  entity_id: string;
  path: string;
  branch: string;
  base_commit_oid: string;
  session_id: string | null;
}

export class ContentionService {
  private readonly deps: FacadeDeps;

  constructor(deps: FacadeDeps) {
    this.deps = deps;
  }

  readonly report = async (ctx: RequestContext): Promise<ContentionReport> => {
    const owner = await this.deps.owner();
    const projectId = requireUuidParam(ctx, 'projectId');
    const claims = claimsFor(owner, ctx);

    const exists = await this.deps.db.query<{ id: string }>(
      claims,
      'select id from public.projects where id = $1',
      [projectId],
    );
    if (exists.length === 0) throw new CollabError('not_found', `no such project: ${projectId}`);

    // The lane's session is the newest `in_worktree` edge pointing at it —
    // 081's link_session_worktree writes session -> worktree.
    const rows = await this.deps.db.query<WorktreeRow>(
      claims,
      `select w.entity_id, w.path, w.branch, w.base_commit_oid,
              (select e.src_id from public.edges e
                where e.dst_id = w.entity_id and e.type = 'in_worktree'
                order by e.created_at desc limit 1) as session_id
         from public.worktrees w
        where w.project_id = $1 and w.status = 'active'
        order by w.branch asc, w.entity_id asc`,
      [projectId],
    );

    const lanes: ContentionLane[] = [];
    const touched = new Map<string, Set<string>>();
    for (const row of rows) {
      const set = await touchedPaths(row.path, row.base_commit_oid);
      if (set === null) {
        lanes.push({
          worktreeId: row.entity_id,
          branch: row.branch,
          path: row.path,
          sessionId: row.session_id,
          touchedCount: 0,
          touchedPaths: [],
          skipped: 'worktree is not readable on this node',
        });
        continue;
      }
      touched.set(row.entity_id, set);
      lanes.push({
        worktreeId: row.entity_id,
        branch: row.branch,
        path: row.path,
        sessionId: row.session_id,
        touchedCount: set.size,
        touchedPaths: [...set].sort(),
        skipped: null,
      });
    }

    const pairs: ContentionPair[] = [];
    const readable = lanes.filter((l) => l.skipped === null);
    for (let i = 0; i < readable.length; i++) {
      for (let j = i + 1; j < readable.length; j++) {
        const a = readable[i];
        const b = readable[j];
        if (a === undefined || b === undefined) continue;
        const bSet = touched.get(b.worktreeId);
        const overlap = [...(touched.get(a.worktreeId) ?? [])].filter((p) => bSet?.has(p)).sort();
        if (overlap.length > 0) {
          pairs.push({
            aWorktreeId: a.worktreeId,
            bWorktreeId: b.worktreeId,
            aBranch: a.branch,
            bBranch: b.branch,
            overlappingPaths: overlap,
          });
        }
      }
    }

    return { projectId, generatedAt: new Date().toISOString(), lanes, pairs };
  };
}

export function registerContentionHandlers(registry: HandlerRegistry, deps: FacadeDeps): void {
  const service = new ContentionService(deps);
  registry.registerAll({ 'projects.contention': service.report });
}
