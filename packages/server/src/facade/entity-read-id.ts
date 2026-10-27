import { CollabError } from '@tm8/contract';
import type { Querier } from '../db/types.js';

export const FULL_ENTITY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Read-only resolution under caller RLS. Mutation paths must keep requireUuidParam. */
export async function resolveEntityReadId(q: Querier, value: string): Promise<string> {
  if (FULL_ENTITY_ID.test(value)) return value;
  const compact = value.replaceAll('-', '').toLowerCase();
  const uuid = (text: string) => `${text.slice(0, 8)}-${text.slice(8, 12)}-${text.slice(12, 16)}-${text.slice(16, 20)}-${text.slice(20)}`;
  // A prefix as printed in a body, with canonical hyphens or without them.
  if (!/^[0-9a-f]{8,32}$/.test(compact) || (value.includes('-') && !uuid(compact.padEnd(32, '0')).startsWith(value.toLowerCase()))) {
    throw new CollabError('not_found', `no such id: ${value}`);
  }
  // UUID range uses the primary-key index; LIMIT 2 is enough to refuse ambiguity.
  const rows = await q.query<{ id: string }>(
    'select id from public.entities where deleted_at is null and id >= $1::uuid and id <= $2::uuid order by id limit 2',
    [uuid(compact.padEnd(32, '0')), uuid(compact.padEnd(32, 'f'))],
  );
  if (rows.length === 0) throw new CollabError('not_found', `no readable entity matches id prefix: ${value}`);
  if (rows.length > 1) throw new CollabError('invalid_input', `ambiguous entity id prefix: ${value}; candidates: ${rows.map(row => row.id).join(', ')} (possibly more); use a longer prefix or full id`, { details: { candidates: rows.map(row => row.id), morePossible: true } });
  return rows[0]!.id;
}
