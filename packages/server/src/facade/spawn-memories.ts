/**
 * A MEMORY AS SPAWN INJECTS IT — its statement with its epistemic marks
 * (design §4.2: the receiving agent must see what is verified vs disputed
 * rather than trusting everything equally).
 *
 * ONE RENDERING, TWO READERS. `loadSpawnContext` (execution-handlers) renders
 * the memories a launch injects; Ask Jev measures each memory candidate's
 * `promptBytes` from the same text (design 01a0d348 §10 Q5.8), so the budget
 * the launch sheet fills is the budget spawn spends.
 *
 * Every reader takes the caller's transaction, so RLS decides what exists.
 */
import type { Querier } from '../db/types.js';

export interface MemoryRow {
  entity_id: string;
  statement: string;
  version: number;
  /** In the teammate's `remembers` working set (vs. only requested by id). */
  remembered: boolean;
  /** In some spawn task's `remembers` working set (D9: remembers(task → memory)). */
  task_remembered: boolean;
  superseded: boolean;
  disputed: boolean;
  verified: boolean;
  created_at: Date | string;
}

/** The statement, then `[superseded, disputed, verified]` for the marks it carries. */
export function renderMemoryText(r: Pick<MemoryRow, 'statement' | 'superseded' | 'disputed' | 'verified'>): string {
  const marks: string[] = [];
  if (r.superseded) marks.push('superseded');
  if (r.disputed) marks.push('disputed');
  if (r.verified) marks.push('verified');
  return marks.length > 0 ? `${r.statement} [${marks.join(', ')}]` : r.statement;
}

/**
 * Live memories of this space by id, with their marks, in no particular
 * order — the rows a `selection.memoryIds` launch injects. An id that is not
 * a readable live memory here is simply absent.
 */
export async function loadMemoriesById(q: Querier, spaceId: string, ids: readonly string[]): Promise<MemoryRow[]> {
  return q.query<MemoryRow>(
    `select m.entity_id, m.statement, e.version,
            false as remembered, false as task_remembered,
            exists (select 1 from public.edges s
                     where s.type = 'supersedes' and s.dst_id = m.entity_id) as superseded,
            exists (select 1 from public.edges d
                     where d.type = 'disputes' and d.dst_id = m.entity_id
                       and (d.props ->> 'pinnedVersion')::int = e.version) as disputed,
            exists (select 1 from public.edges v
                     where v.type = 'verifies' and v.dst_id = m.entity_id
                       and (v.props ->> 'pinnedVersion')::int = e.version) as verified,
            m.created_at
       from public.memories m
       join public.entities e on e.id = m.entity_id and e.deleted_at is null
      where e.space_id = $2 and m.entity_id = any($1::uuid[])`,
    [[...ids], spaceId],
  );
}
