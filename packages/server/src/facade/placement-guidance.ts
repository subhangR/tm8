/**
 * P0f: where an entity belongs (Design Rules 01a10c5d §2.4).
 *
 *   1. A sub-item of the same kind uses `parentId`: subtask, sub-doc, child
 *      story, sub-session. The DB already refuses any other parent (001:398,
 *      176:525); `parentKindRefusal` turns that bare refusal into one that
 *      names the edge to make instead.
 *   2. A cross-kind link is an edge, never a parent: a deliverable gets
 *      `produces` from its task, an input or reference gets `attached_to`.
 *   3. Only roots go into a story (`contains`); children follow through
 *      `parentId`.
 *
 * Only STRUCTURAL facts are checked: a server cannot judge what an entity is
 * about, so whether a root task "should" be a subtask is the agent's call,
 * taught by PLACEMENT_RULE in the prompt (owner, 6 Oct; #1065). Warnings ride
 * the add result and never refuse a write; each lookup runs in its own read
 * AFTER the write committed, so a failed lookup yields no warning rather than
 * an aborted transaction.
 */
import { CollabError, isCollabError, type ResultWarning } from '@tm8/contract';
import type { Db, DbClaims, Querier } from '../db/types.js';

export const STORY_ROOT_NOT_ROOT = 'story_root_not_root';
export const STORY_ROOT_REDUNDANT = 'story_root_redundant';
export const PARENT_KIND_MISMATCH = 'parent_kind_mismatch';

/** Kinds that are usually a task's output: a task parent means `produces`. */
const DELIVERABLE_KINDS = new Set(['doc', 'artifact', 'file', 'drawing']);
function moveCommand(id: string, parent: string): string {
  return `tm8 entity move ${id} --parent ${parent} --position 0 --expect-version <current>`;
}

/** The SQLSTATE the parent trigger raises for a wrong kind (and a wrong space). */
function isCheckViolation(error: unknown): boolean {
  return isCollabError(error) && error.details?.['sqlstate'] === '23514';
}

/**
 * A create or move refused for a parent of another kind, rewritten to say what
 * to do instead. Decided from the rows, not the message text: the parent's
 * kind is read back and compared with the child's. Returns null when the
 * refusal was something else (e.g. the cross-space check, same SQLSTATE).
 */
export async function parentKindRefusal(
  db: Db,
  claims: DbClaims,
  error: unknown,
  child: { id?: string; kind?: string; parentId?: string | null },
): Promise<CollabError | null> {
  if (!isCheckViolation(error) || !child.parentId) return null;
  let rows: Array<{ id: string; kind: string }> = [];
  try {
    rows = await db.query<{ id: string; kind: string }>(claims,
      'select id, kind from public.entities where id = any($1::uuid[]) and deleted_at is null',
      [[child.parentId, ...(child.id ? [child.id] : [])]]);
  } catch {
    return null;
  }
  const parent = rows.find((r) => r.id === child.parentId);
  const kind = child.kind ?? rows.find((r) => r.id === child.id)?.kind;
  if (!parent || !kind || parent.kind === kind) return null;
  const self = child.id ?? `<new-${kind}-id>`;
  const edge = parent.kind === 'task' && DELIVERABLE_KINDS.has(kind)
    ? `tm8 edge create ${parent.id} produces ${self}`
    : `tm8 edge create ${self} attached_to ${parent.id}`;
  const where = child.id
    ? `Leave it where it is (or nest it under a ${kind}: ${moveCommand(child.id, `<${kind}-id>`)})`
    : `Create it as a root (--parent none) or under another ${kind}`;
  const next = [edge];
  return new CollabError('invariant_violation',
    `a ${kind} cannot be a child of a ${parent.kind}: --parent only nests the same kind ` +
    `(subtask, sub-doc, child story, sub-session). ${where}, then link it with an edge: ` +
    `${edge} for a deliverable of the ${parent.kind}, or attached_to for an input or reference.`,
    { details: { sqlstate: '23514', reason: PARENT_KIND_MISMATCH, parentId: parent.id, parentKind: parent.kind, kind, next } });
}

/**
 * Warnings for `collection add <story> <item>`: only roots belong in a story.
 * A child is reached through its parent; a child whose ancestor is already a
 * root of the story is reached twice. Never refuses (chapter stories may pick
 * a branch on purpose).
 */
export async function storyRootWarnings(db: Db, dbClaims: DbClaims, storyId: string, itemId: string): Promise<ResultWarning[]> {
  try {
    return await db.tx(dbClaims, (q) => storyRootWarningsIn(q, storyId, itemId));
  } catch {
    return [];
  }
}

async function storyRootWarningsIn(q: Querier, storyId: string, itemId: string): Promise<ResultWarning[]> {
  const story = await q.query<{ kind: string }>(
    'select kind from public.entities where id = $1 and deleted_at is null', [storyId]);
  if (story[0]?.kind !== 'story') return [];
  const chain = await q.query<{ id: string; depth: number; is_root_of_story: boolean }>(
    `with recursive up(id, parent_id, depth) as (
       select e.id, e.parent_id, 0 from public.entities e where e.id = $2 and e.deleted_at is null
       union all
       select p.id, p.parent_id, up.depth + 1
         from up join public.entities p on p.id = up.parent_id and p.deleted_at is null
        where up.depth < 64)
     select up.id, up.depth,
            exists (select 1 from public.edges c
                     where c.src_id = $1 and c.dst_id = up.id and c.type = 'contains') as is_root_of_story
       from up where up.depth > 0 order by up.depth asc`,
    [storyId, itemId],
  );
  if (chain.length === 0) return [];
  const top = chain[chain.length - 1]!.id;
  const covering = chain.find((r) => r.is_root_of_story);
  if (covering) {
    return [{
      code: STORY_ROOT_REDUNDANT,
      message: `${itemId} is already in this story through its ancestor ${covering.id}, a root of the story; ` +
        `children follow their parent, so this root is redundant: tm8 collection remove ${storyId} ${itemId} --yes.`,
    }];
  }
  return [{
    code: STORY_ROOT_NOT_ROOT,
    message: `${itemId} is not a root (it has a parent); only roots go into a story and children follow through ` +
      `their parent. Add its root instead: tm8 collection add ${storyId} ${top} ` +
      `(then tm8 collection remove ${storyId} ${itemId} --yes), unless this story picks one branch on purpose.`,
  }];
}
