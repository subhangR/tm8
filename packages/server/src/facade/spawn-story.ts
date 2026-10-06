/**
 * Spawn-on-story (task 01a0fc77): the story side of a launch.
 *
 *   * `loadStoryContextForTask` — the session's direct story anchor, or the
 *     nearest story containing its primary task, folded into the bounded `PromptStoryContext` every prompt frame
 *     renders. Membership is the backend's reverse trail walk,
 *     `public.stories_containing(task)` (282): the same edge set, depth and
 *     bound the story page follows, so "the prompt says this task is in the
 *     story" and "the story page lists this task" cannot disagree.
 *   * `putDerivedTasksInStories` — a launch ON a story derives a task from it
 *     (`derive_task_for_entity`); unless the story's trail already reaches that
 *     task, it is put in by hand (a `contains` root), so the session's
 *     `working_on` edge lands it in the trail.
 *
 * Both read as the SPAWNER (the caller's claims), and both are fail-soft: a
 * story is context, never a reason to refuse a launch.
 */
import {
  STORY_PROMPT_LIMITS,
  type PromptStoryContext,
  type PromptStoryItem,
} from '@tm8/prompt';
import { storyCallSign } from '@tm8/contract';
import type { Db, DbClaims } from '../db/types.js';

interface StoryHit {
  story_id: string;
  root_id: string | null;
  depth: number | string;
  title: string | null;
}

interface StoryHeadRow {
  description: string | null;
  status_category: string | null;
  state: unknown;
}

interface StoryTrailRow {
  id: string;
  kind: string;
  title: string | null;
  created_at: string | Date;
  status: string | null;
  status_category: string | null;
  depth: number | string;
  root_position: number | null;
  runtime_status: string | null;
  blocked: boolean;
}

/**
 * `public.entities` has no title column and `internal.entity_content` is not
 * granted to tm8_app, so a trail row's title is read from the kind detail
 * tables a story's trail actually holds (each under its own RLS).
 */
const TITLE_TABLES: ReadonlyArray<readonly [table: string, column: string]> = [
  ['tasks', 'title'], ['stories', 'title'], ['work_sessions', 'title'], ['documents', 'title'],
  ['artifacts', 'name'], ['collections', 'name'], ['team_members', 'name'], ['pull_requests', 'title'],
  ['files', 'name'], ['drawings', 'title'], ['chats', 'title'], ['channels', 'name'], ['loops', 'title'],
  ['forms', 'title'], ['skills', 'name'], ['graphs', 'title'], ['designs', 'title'],
];
/** Shared with spawn-design.ts: a design's pages are read the same way. */
export const TITLE_JOINS = TITLE_TABLES
  .map(([table], i) => `left join public.${table} tt${i} on tt${i}.entity_id = e.id`)
  .join('\n           ');
export const TITLE_SELECT = `coalesce(${TITLE_TABLES.map(([, column], i) => `tt${i}.${column}`).join(', ')})`;

/** The runtime states `internal.story_summary` counts as live. */
const LIVE_RUNTIME = new Set(['spawning', 'running', 'idle']);

function rec(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function cap(text: string, max: number): { text: string; cut: boolean } {
  return text.length > max ? { text: `${text.slice(0, max - 1)}…`, cut: true } : { text, cut: false };
}

/** The stories containing `entityId`, nearest first, one row per story. */
async function storiesContaining(db: Db, claims: DbClaims, entityId: string): Promise<StoryHit[]> {
  const rows = await db.tx(claims, (q) =>
    q.query<StoryHit>(
      `select distinct on (s.story_id) s.story_id, s.root_id, s.depth, st.title
         from public.stories_containing($1::uuid) s
         join public.entities e on e.id = s.story_id and e.deleted_at is null
         left join public.stories st on st.entity_id = e.id
        order by s.story_id, s.depth, s.root_id`,
      [entityId],
    ),
  );
  return rows.sort((a, b) => Number(a.depth) - Number(b.depth) || a.story_id.localeCompare(b.story_id));
}

export async function loadStoryContextForTask(
  db: Db,
  claims: DbClaims,
  taskId?: string,
  sessionId?: string,
): Promise<PromptStoryContext | null> {
  const direct = sessionId ? await db.tx(claims, q => q.query<StoryHit>(
    `select st.entity_id story_id, e.id root_id, 0 depth, st.title
       from public.edges c join public.stories st on st.entity_id=c.src_id
       join public.entities e on e.id=c.dst_id and e.deleted_at is null
       join public.entities se on se.id=st.entity_id and se.deleted_at is null
       where c.dst_id=$1 and c.type='contains' order by c.created_at,c.id limit 1`, [sessionId])) : [];
  const hits = direct.length ? direct : taskId ? await storiesContaining(db, claims, taskId) : [];
  const nearest = hits[0];
  if (!nearest) return null;
  const others = hits.slice(1, 1 + STORY_PROMPT_LIMITS.others).map((h) => ({
    id: h.story_id,
    title: cap(h.title ?? '', STORY_PROMPT_LIMITS.title).text,
  }));
  const ref: PromptStoryContext = {
    id: nearest.story_id,
    title: cap(nearest.title ?? '', STORY_PROMPT_LIMITS.title).text,
    taskId: direct.length ? null : taskId ?? null,
    viaRootId: nearest.root_id,
    depth: Number(nearest.depth),
    snapshot: 'unavailable',
    ...(others.length > 0 ? { others } : {}),
  };

  // The detail is a second, separate read: one that fails (a statement
  // timeout, an older node) still leaves the ref. It is built from the
  // backend's own trail and summary (282), not a walk of its own.
  let detail: { head: StoryHeadRow | undefined; rows: StoryTrailRow[] };
  try {
    detail = await db.tx(claims, async (q) => ({
      head: (
        await q.query<StoryHeadRow>(
          `select st.description, e.status_category, internal.story_summary(e.id) as state
             from public.entities e
             left join public.stories st on st.entity_id = e.id
            where e.id = $1::uuid and e.deleted_at is null`,
          [nearest.story_id],
        )
      )[0],
      rows: await q.query<StoryTrailRow>(
        `with tr as (
           select distinct on (t.entity_id) t.entity_id, t.depth, t.root_position
             from internal.story_trail($1::uuid) t
            order by t.entity_id, t.depth
         )
         select e.id, e.kind, ${TITLE_SELECT} as title, e.created_at,
                coalesce(tk.work_status, e.status_category) as status,
                e.status_category, tr.depth, tr.root_position,
                ws.status as runtime_status,
                exists (select 1 from public.edges dep
                         where dep.src_id = e.id and dep.type = 'depends_on'
                           and coalesce((dep.props ->> 'hard')::boolean, true)
                           and not internal.is_resolved(dep.dst_id)) as blocked
           from tr
           join public.entities e on e.id = tr.entity_id and e.deleted_at is null
           left join public.tasks tk on tk.entity_id = e.id
           left join public.work_sessions ws on ws.entity_id = e.id
           ${TITLE_JOINS}`,
        [nearest.story_id],
      ),
    }));
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    return { ...ref, snapshot: typeof code === 'string' && code !== '' ? `read_failed:${code}` : 'read_failed' };
  }
  const head = detail.head;
  if (!head) return { ...ref, snapshot: 'not_found' };

  const state = rec(head.state);
  let truncated = state?.truncated === true;
  const description = cap(head.description ?? '', STORY_PROMPT_LIMITS.description);
  truncated ||= description.cut;

  const toItem = (r: StoryTrailRow): PromptStoryItem => ({
    id: r.id,
    kind: r.kind,
    title: cap(r.title ?? '', STORY_PROMPT_LIMITS.title).text,
    status: r.status,
    ...(r.blocked && (r.status_category === 'to_do' || r.status_category === 'in_progress') ? { blocked: true } : {}),
  });
  const roots = detail.rows
    .filter((r) => Number(r.depth) === 0)
    .sort((a, b) => (a.root_position ?? Infinity) - (b.root_position ?? Infinity) || a.id.localeCompare(b.id))
    .map(toItem);
  const blocked = detail.rows.map(toItem).filter((r) => r.blocked === true);
  // Call signs as the contract rules them: every session in the story by
  // created_at (ties by id), so a sign here is the sign on the story page.
  const sessions = detail.rows
    .filter((r) => r.kind === 'work_session')
    .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime() || a.id.localeCompare(b.id));
  const live = sessions.flatMap((r, i) =>
    r.runtime_status !== null && LIVE_RUNTIME.has(r.runtime_status)
      ? [{ id: r.id, title: cap(r.title ?? '', STORY_PROMPT_LIMITS.title).text, callSign: storyCallSign(i) }]
      : [],
  );
  truncated ||= blocked.length > STORY_PROMPT_LIMITS.blocked || live.length > STORY_PROMPT_LIMITS.live;

  const progress = rec(state?.taskProgress);
  return {
    ...ref,
    snapshot: 'loaded',
    status: head.status_category,
    ...(description.text ? { description: description.text } : {}),
    taskProgress: progress
      ? {
          work: Number(progress.work ?? 0),
          done: Number(progress.done ?? 0),
          inProgress: Number(progress.inProgress ?? 0),
          toDo: Number(progress.toDo ?? 0),
          blocked: Number(progress.blocked ?? 0),
        }
      : null,
    roots: roots.slice(0, STORY_PROMPT_LIMITS.roots),
    rootCount: typeof state?.rootCount === 'number' ? state.rootCount : roots.length,
    live: live.slice(0, STORY_PROMPT_LIMITS.live),
    blocked: blocked.slice(0, STORY_PROMPT_LIMITS.blocked),
    ...(truncated ? { truncated: true } : {}),
  };
}

/**
 * A launch on a story: put each task derived from a story into that story
 * unless its trail already reaches it. `pairs` is subject -> resolved task,
 * in launch order. Best-effort per pair; returns what it did, for the log.
 */
export async function putDerivedTasksInStories(
  db: Db,
  claims: DbClaims,
  pairs: ReadonlyArray<{ subjectId: string; taskId: string }>,
): Promise<Array<{ storyId: string; taskId: string; outcome: 'added' | 'already_in' | 'failed'; error?: string }>> {
  const candidates = pairs.filter((p) => p.subjectId !== p.taskId);
  if (candidates.length === 0) return [];
  const stories = new Set(
    (
      await db.tx(claims, (q) =>
        q.query<{ id: string }>(
          `select id from public.entities
            where id = any($1::uuid[]) and kind = 'story' and deleted_at is null`,
          [candidates.map((p) => p.subjectId)],
        ),
      )
    ).map((r) => r.id),
  );
  const out: Array<{ storyId: string; taskId: string; outcome: 'added' | 'already_in' | 'failed'; error?: string }> = [];
  for (const { subjectId: storyId, taskId } of candidates) {
    if (!stories.has(storyId)) continue;
    try {
      const reached = (await storiesContaining(db, claims, taskId)).some((h) => h.story_id === storyId);
      if (reached) {
        out.push({ storyId, taskId, outcome: 'already_in' });
        continue;
      }
      // The ordinary put-in path (`tm8 collection add`), widened by 282 to
      // accept a story container: one `contains` root, auto-positioned last.
      await db.rpc(claims, 'public.set_collection_item', [storyId, taskId, null, null, null]);
      out.push({ storyId, taskId, outcome: 'added' });
    } catch (error) {
      out.push({ storyId, taskId, outcome: 'failed', error: error instanceof Error ? error.message : String(error) });
    }
  }
  return out;
}
