/**
 * Run on a design (Craft → Designs, migration 304; change list item 6): the
 * design side of a launch.
 *
 * Run on a design is the ordinary launch sheet on the design entity: the
 * spawn derives the session's task from it (`derive_task_for_entity`, a
 * `derived_from` edge task -> design), and the session works on that task.
 * `loadDesignContextForTask` finds that design from the primary task and
 * folds the design's ORDERED pages — nested design pages expanded to a fixed
 * depth, pre-order — into the bounded `PromptDesignContext` every prompt
 * frame renders, with the standing Run instruction (`@tm8/prompt`
 * design-context.ts): create what the graph pages describe, nothing else.
 *
 * Read as the SPAWNER (the caller's claims), so a page the launcher cannot
 * read is not named. Fail-soft: a design is context, never a reason to refuse
 * a launch; a failed page read keeps the ref and says why.
 */
import { confirmOnlyNodeKinds } from '@tm8/contract';
import {
  DESIGN_PROMPT_LIMITS,
  type PromptDesignContext,
  type PromptDesignPage,
} from '@tm8/prompt';
import type { Db, DbClaims, Querier } from '../db/types.js';
import { TITLE_JOINS, TITLE_SELECT } from './spawn-story.js';

interface DesignHead {
  id: string;
  title: string | null;
  description: string | null;
  page_count: number | string | null;
}

interface PageRow {
  id: string;
  kind: string;
  title: string | null;
  pos: number | string | null;
  graph_type: string | null;
}

function cap(text: string, max: number): { text: string; cut: boolean } {
  return text.length > max ? { text: `${text.slice(0, max - 1)}…`, cut: true } : { text, cut: false };
}

/** One design's live, readable pages in page order. */
async function pagesOf(q: Querier, designId: string): Promise<PageRow[]> {
  return q.query<PageRow>(
    `select e.id, e.kind, ${TITLE_SELECT} as title, gp.graph_type,
            case when jsonb_typeof(c.props -> 'position') = 'number'
                 then (c.props ->> 'position')::double precision end as pos
       from public.edges c
       join public.entities e on e.id = c.dst_id and e.deleted_at is null
       left join public.graphs gp on gp.entity_id = e.id
           ${TITLE_JOINS}
      where c.src_id = $1::uuid and c.type = 'contains'
      order by pos nulls last, c.created_at, c.id
      limit ${DESIGN_PROMPT_LIMITS.pages + 1}`,
    [designId],
  );
}

/**
 * The design `taskId` was derived from, with its ordered pages, or null when
 * the task was not launched from a design.
 */
export async function loadDesignContextForTask(
  db: Db,
  claims: DbClaims,
  taskId: string,
): Promise<PromptDesignContext | null> {
  const heads = await db.tx(claims, (q) =>
    q.query<DesignHead>(
      `select d.entity_id as id, d.title, d.description, (internal.design_summary(d.entity_id) ->> 'pageCount')::int as page_count
         from public.edges df
         join public.designs d on d.entity_id = df.dst_id
         join public.entities e on e.id = d.entity_id and e.deleted_at is null
        where df.src_id = $1::uuid and df.type = 'derived_from'
        order by df.created_at desc, df.id
        limit 1`,
      [taskId],
    ),
  );
  const head = heads[0];
  if (!head) return null;
  const description = cap(head.description ?? '', DESIGN_PROMPT_LIMITS.description);
  const ref: PromptDesignContext = {
    id: head.id,
    title: cap(head.title ?? '', DESIGN_PROMPT_LIMITS.title).text,
    taskId,
    snapshot: 'unavailable',
    confirmOnlyKinds: confirmOnlyNodeKinds(),
  };

  let truncated = description.cut;
  const pages: PromptDesignPage[] = [];
  try {
    await db.tx(claims, async (q) => {
      // Pre-order: a nested design's pages follow it directly. `seen` makes a
      // loop an older build let in (the 304 guard refuses new ones) harmless.
      const seen = new Set<string>([head.id]);
      const walk = async (designId: string, depth: number): Promise<void> => {
        const rows = await pagesOf(q, designId);
        if (rows.length > DESIGN_PROMPT_LIMITS.pages) truncated = true;
        for (const row of rows.slice(0, DESIGN_PROMPT_LIMITS.pages)) {
          if (pages.length >= DESIGN_PROMPT_LIMITS.pages) {
            truncated = true;
            return;
          }
          pages.push({
            id: row.id,
            kind: row.kind,
            title: cap(row.title ?? '', DESIGN_PROMPT_LIMITS.title).text,
            position: row.pos === null ? null : Number(row.pos),
            depth,
            designId,
            ...(row.kind === 'graph' ? { graphType: row.graph_type } : {}),
          });
          if (row.kind !== 'design' || seen.has(row.id)) continue;
          seen.add(row.id);
          if (depth + 1 >= DESIGN_PROMPT_LIMITS.depth) {
            // Deeper designs are named, not opened: the agent reads them.
            truncated = true;
            continue;
          }
          await walk(row.id, depth + 1);
        }
      };
      await walk(head.id, 0);
    });
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    return { ...ref, snapshot: typeof code === 'string' && code !== '' ? `read_failed:${code}` : 'read_failed' };
  }

  return {
    ...ref,
    snapshot: 'loaded',
    ...(description.text ? { description: description.text } : {}),
    pages,
    pageCount: Number(head.page_count ?? pages.filter((p) => p.depth === 0).length),
    ...(truncated ? { truncated: true } : {}),
  };
}
