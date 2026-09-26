/**
 * The in-full channel's read (launch card v3, contract decision 1 and its
 * amendment): `execution.spawn.inFullIds`, each entity read whole under the
 * caller's RLS in the spawn's own transaction.
 *
 * Refusals, in this order so a caller learns the kind rule before anything
 * about readability:
 *   - a readable id of another kind: `invalid_input`,
 *     `details.reason = 'in_full_kind_not_allowed'`, `details.ids`;
 *   - an id that is not a live entity the caller can read in this space:
 *     `not_found`, `details.ids` (existence is not leaked: deleted, other
 *     space and unreadable are one answer).
 * A resume re-reads instead (`replay`): such ids are left out and named in
 * `unavailable`, and the resume goes on.
 */
import { readFile } from 'node:fs/promises';
import { SPAWN_IN_FULL_KINDS, type SpawnInFullKind } from '@tm8/contract';
import type { InFullEntity } from '@tm8/execution';
import type { Querier } from '../db/types.js';
import { fail } from '../http/errors.js';
import { renderMemoryText } from '../facade/spawn-memories.js';

const IN_FULL_KINDS: ReadonlySet<string> = new Set(SPAWN_IN_FULL_KINDS);

interface InFullRow {
  id: string;
  kind: string;
  version: number;
  title: string | null;
  task_status: string | null;
  task_priority: string | null;
  task_description: string | null;
  task_criteria: unknown;
  doc_body: string | null;
  doc_format: string | null;
  statement: string | null;
  superseded: boolean;
  disputed: boolean;
  verified: boolean;
  skill_description: string | null;
  skill_content: string | null;
  skill_source_path: string | null;
}

/** Unique, in request order, without the subject task (it is already `<task>`). */
export function inFullIdsFor(ids: readonly string[] | undefined, subjectTaskIds: readonly string[]): string[] {
  const subject = new Set(subjectTaskIds);
  return [...new Set(ids ?? [])].filter((id) => !subject.has(id));
}

/** Kind and readability, refused by name; the spawn handler runs it before anything is written. */
export async function assertInFullIds(q: Querier, spaceId: string, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  const rows = await q.query<{ id: string; kind: string }>(
    `select e.id, e.kind from public.entities e
      where e.id = any($1::uuid[]) and e.space_id = $2 and e.deleted_at is null`,
    [[...ids], spaceId],
  );
  refuse(ids, rows);
}

function refuse(ids: readonly string[], rows: ReadonlyArray<{ id: string; kind: string }>): void {
  const wrongKind = rows.filter((row) => !IN_FULL_KINDS.has(row.kind)).map((row) => row.id);
  if (wrongKind.length > 0) {
    throw fail(
      'invalid_input',
      `inFullIds may name only ${SPAWN_IN_FULL_KINDS.join(', ')} entities: ${wrongKind.join(', ')}`,
      { reason: 'in_full_kind_not_allowed', ids: wrongKind },
    );
  }
  const found = new Set(rows.map((row) => row.id));
  const missing = ids.filter((id) => !found.has(id));
  if (missing.length > 0) {
    throw fail('not_found', `inFullIds not found in this space: ${missing.join(', ')}`, { ids: missing });
  }
}

/** The entities, read whole, in request order. */
export async function loadInFullEntities(
  q: Querier,
  spaceId: string,
  ids: readonly string[],
  options: { replay?: boolean } = {},
): Promise<{ entities: InFullEntity[]; unavailable: string[] }> {
  if (ids.length === 0) return { entities: [], unavailable: [] };
  const rows = await q.query<InFullRow>(
    `select e.id, e.kind, e.version,
            coalesce(t.title, d.title, sk.name, left(m.statement, 120)) as title,
            t.work_status as task_status, t.priority as task_priority,
            t.description as task_description, t.acceptance_criteria as task_criteria,
            d.body as doc_body, d.format as doc_format,
            m.statement,
            (m.entity_id is not null and exists (select 1 from public.edges s
               where s.type = 'supersedes' and s.dst_id = m.entity_id)) as superseded,
            (m.entity_id is not null and exists (select 1 from public.edges x
               where x.type = 'disputes' and x.dst_id = m.entity_id
                 and (x.props ->> 'pinnedVersion')::int = e.version)) as disputed,
            (m.entity_id is not null and exists (select 1 from public.edges v
               where v.type = 'verifies' and v.dst_id = m.entity_id
                 and (v.props ->> 'pinnedVersion')::int = e.version)) as verified,
            sk.description as skill_description, sk.content as skill_content,
            sk.source_path as skill_source_path
       from public.entities e
       left join public.tasks t on t.entity_id = e.id
       left join public.documents d on d.entity_id = e.id
       left join public.memories m on m.entity_id = e.id
       left join public.skills sk on sk.entity_id = e.id
      where e.id = any($1::uuid[]) and e.space_id = $2 and e.deleted_at is null`,
    [[...ids], spaceId],
  );
  const usable = options.replay ? rows.filter((row) => IN_FULL_KINDS.has(row.kind)) : rows;
  if (!options.replay) refuse(ids, rows);
  const byId = new Map(usable.map((row) => [row.id, row]));
  const entities: InFullEntity[] = [];
  const unavailable: string[] = [];
  for (const id of ids) {
    const row = byId.get(id);
    if (!row) {
      unavailable.push(id);
      continue;
    }
    entities.push({
      entityId: row.id,
      kind: row.kind as SpawnInFullKind,
      title: row.title ?? '',
      version: row.version,
      body: await bodyOf(row),
    });
  }
  return { entities, unavailable };
}

async function bodyOf(row: InFullRow): Promise<string> {
  switch (row.kind) {
    case 'task': {
      const criteria = Array.isArray(row.task_criteria) ? row.task_criteria : [];
      const lines = criteria.flatMap((c) => {
        if (typeof c === 'string') return [`- [ ] ${c}`];
        if (c && typeof c === 'object' && typeof (c as { text?: unknown }).text === 'string') {
          const done = (c as { done?: unknown }).done === true;
          return [`- [${done ? 'x' : ' '}] ${(c as { text: string }).text}`];
        }
        return [];
      });
      return [
        `Status: ${row.task_status ?? 'unknown'}`,
        `Priority: ${row.task_priority ?? 'unknown'}`,
        row.task_description ? `Description:\n${row.task_description}` : null,
        lines.length > 0 ? `Acceptance criteria:\n${lines.join('\n')}` : null,
      ].filter((part): part is string => part !== null).join('\n\n');
    }
    case 'doc':
      return row.doc_format && row.doc_format !== 'markdown'
        ? `Format: ${row.doc_format}\n\n${row.doc_body ?? ''}`
        : row.doc_body ?? '';
    case 'memory':
      return renderMemoryText({
        statement: row.statement ?? '',
        superseded: row.superseded,
        disputed: row.disputed,
        verified: row.verified,
      });
    case 'skill':
      return [
        row.skill_description ? `Description: ${row.skill_description}` : null,
        await skillBody(row),
      ].filter((part): part is string => part !== null && part !== '').join('\n\n');
    default:
      return '';
  }
}

/** A tm8 skill keeps its body in the row; a filesystem skill's body is its file (never a stale copy). */
async function skillBody(row: InFullRow): Promise<string> {
  if (!row.skill_source_path) return row.skill_content ?? '';
  try {
    return await readFile(row.skill_source_path, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? 'unknown';
    return `(The skill file could not be read: ${code}.)`;
  }
}

/**
 * The body a derived "Work on:" task carries when its source entity is sent
 * in full (owner answer non_task_subject): a pointer, so the text is sent and
 * counted once.
 */
export function derivedInFullPointer(sourceId: string): string {
  return `Derived from \`${sourceId}\`, which is sent in full below (an in-full section with entity_id="${sourceId}"). Work on it.`;
}
