/**
 * Spawn-on-story (task 01a0fc77): the story side of a launch.
 *
 *   * `loadStoryContextForTask` — the nearest story containing the primary
 *     task, folded into the bounded `PromptStoryContext` every prompt frame
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
import type { Db, DbClaims } from '../db/types.js';

interface StoryHit {
  story_id: string;
  root_id: string | null;
  depth: number | string;
  title: string | null;
}

function rec(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function cap(text: string, max: number): { text: string; cut: boolean } {
  return text.length > max ? { text: `${text.slice(0, max - 1)}…`, cut: true } : { text, cut: false };
}

/** The stories containing `entityId`, nearest first, one row per story. */
async function storiesContaining(db: Db, claims: DbClaims, entityId: string): Promise<StoryHit[]> {
  const rows = await db.tx(claims, (q) =>
    q.query<StoryHit>(
      `select distinct on (s.story_id) s.story_id, s.root_id, s.depth, e.title
         from public.stories_containing($1::uuid) s
         join public.entities e on e.id = s.story_id and e.deleted_at is null
        order by s.story_id, s.depth, s.root_id`,
      [entityId],
    ),
  );
  return rows.sort((a, b) => Number(a.depth) - Number(b.depth) || a.story_id.localeCompare(b.story_id));
}

export async function loadStoryContextForTask(
  db: Db,
  claims: DbClaims,
  taskId: string,
): Promise<PromptStoryContext | null> {
  const hits = await storiesContaining(db, claims, taskId);
  const nearest = hits[0];
  if (!nearest) return null;
  const others = hits.slice(1, 1 + STORY_PROMPT_LIMITS.others).map((h) => ({
    id: h.story_id,
    title: cap(h.title ?? '', STORY_PROMPT_LIMITS.title).text,
  }));
  const ref: PromptStoryContext = {
    id: nearest.story_id,
    title: cap(nearest.title ?? '', STORY_PROMPT_LIMITS.title).text,
    taskId,
    viaRootId: nearest.root_id,
    depth: Number(nearest.depth),
    snapshot: 'unavailable',
    ...(others.length > 0 ? { others } : {}),
  };

  // The detail is a second, separate read: a page that fails (a function
  // missing on an older node, a statement timeout) still leaves the ref.
  let row: { description: string | null; state: unknown; page: unknown } | undefined;
  try {
    [row] = await db.tx(claims, (q) =>
      q.query<{ description: string | null; state: unknown; page: unknown }>(
        `select e.content->>'description' as description,
                internal.story_summary(e.id) as state,
                internal.story_page(e.id) as page
           from public.entities e
          where e.id = $1::uuid and e.deleted_at is null`,
        [nearest.story_id],
      ),
    );
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    return { ...ref, snapshot: typeof code === 'string' && code !== '' ? `read_failed:${code}` : 'read_failed' };
  }
  if (!row) return { ...ref, snapshot: 'not_found' };

  const state = rec(row.state);
  const page = rec(row.page);
  let truncated = state?.truncated === true || rec(page?.follow)?.truncated === true;

  const description = cap(row.description ?? '', STORY_PROMPT_LIMITS.description);
  truncated ||= description.cut;

  const nodes = Array.isArray(page?.nodes) ? page.nodes.map(rec).filter((n) => n !== null) : [];
  const self = nodes.find((n) => n.id === nearest.story_id);

  const toItem = (r: Record<string, unknown>): PromptStoryItem | null => {
    const id = str(r.id);
    if (!id) return null;
    return {
      id,
      kind: str(r.kind) ?? 'entity',
      title: cap(str(r.title) ?? '', STORY_PROMPT_LIMITS.title).text,
      status: str(r.status),
      ...(r.blocked === true ? { blocked: true } : {}),
    };
  };
  const allRoots = (Array.isArray(page?.roots) ? page.roots.map(rec) : [])
    .flatMap((r) => (r ? [toItem(r)] : []))
    .filter((r): r is PromptStoryItem => r !== null);
  const blockedRows = nodes
    .filter((n) => n.blocked === true && n.statusCategory !== 'done' && n.id !== nearest.story_id)
    .flatMap((n) => {
      const item = toItem(n);
      return item ? [item] : [];
    });
  const liveRows = (Array.isArray(page?.sessions) ? page.sessions.map(rec) : [])
    .filter((s): s is Record<string, unknown> => s !== null && s.live === true && typeof s.id === 'string')
    .map((s) => ({
      id: s.id as string,
      title: cap(str(s.title) ?? '', STORY_PROMPT_LIMITS.title).text,
      callSign: str(s.callSign),
    }));
  truncated ||=
    blockedRows.length > STORY_PROMPT_LIMITS.blocked || liveRows.length > STORY_PROMPT_LIMITS.live;

  const progress = rec(state?.taskProgress);
  const rootCount = typeof state?.rootCount === 'number' ? state.rootCount : allRoots.length;
  return {
    ...ref,
    snapshot: 'loaded',
    status: str(self?.status) ?? null,
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
    roots: allRoots.slice(0, STORY_PROMPT_LIMITS.roots),
    rootCount,
    live: liveRows.slice(0, STORY_PROMPT_LIMITS.live),
    blocked: blockedRows.slice(0, STORY_PROMPT_LIMITS.blocked),
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
