/**
 * `memories.search` — full-text search over one Space's memories.
 *
 * The whole search lives in the database: `public.search_memories` (186)
 * parses the query, matches it against the indexed document built from all
 * four fields of a memory, ranks with `ts_rank_cd`, resolves a superseded hit
 * to its live chain head, derives the marks from the mark edges, and runs as
 * the caller so row-level security decides what is visible. This handler only
 * carries the request to that function under the caller's claims and renders
 * the rows into the contract's shape. Nothing is filtered, ranked or
 * re-ordered here — a second opinion on relevance in TypeScript is exactly the
 * split the JavaScript substring search used to be.
 *
 * Space membership is not checked separately: a caller outside the space
 * simply matches nothing, which is the same answer `collections.query` gives
 * and does not reveal whether the space exists.
 */
import { CollabError, type MemorySearchInput, type MemorySearchResult } from '@tm8/contract';

import type { OperationHandler } from '../../http/types.js';
import { claimsFor, optionalUuid } from '../context.js';
import type { FacadeDeps } from '../deps.js';
import type { HandlerRegistry } from '../registry.js';

/** `public.search_memories`'s row, as node-pg parses it (float4 → number, text[] → string[]). */
interface SearchRow {
  entity_id: string;
  statement: string;
  subject_scope: string;
  does_not_establish: string;
  rank: number;
  marks: string[];
}

const DEFAULT_LIMIT = 20;

export function memoriesSearch(deps: FacadeDeps): OperationHandler {
  return async (ctx): Promise<MemorySearchResult> => {
    const owner = await deps.owner();
    // Validated against `MemorySearchInputSchema` before the handler runs
    // (input-schemas.ts), so the shape holds; the id is checked here because
    // the schema only says "a string" and a malformed uuid must be a client
    // error, not a 22P02 dressed up as a database outage.
    const input = ctx.body as MemorySearchInput;
    const spaceId = optionalUuid(input.spaceId, 'spaceId');
    if (spaceId === null) throw new CollabError('invalid_input', 'spaceId is required');
    const query = input.query.trim();
    const limit = input.limit ?? DEFAULT_LIMIT;

    const rows = await deps.db.query<SearchRow>(
      claimsFor(owner, ctx),
      `select entity_id, statement, subject_scope, does_not_establish, rank, marks
         from public.search_memories($1, $2, $3)`,
      [spaceId, query, limit],
    );
    return {
      items: rows.map((row) => ({
        id: row.entity_id,
        statement: row.statement,
        subjectScope: row.subject_scope,
        doesNotEstablish: row.does_not_establish,
        rank: Number(row.rank),
        marks: row.marks ?? [],
      })),
    };
  };
}

export function registerMemoryHandlers(registry: HandlerRegistry, deps: FacadeDeps): void {
  registry.registerAll({ 'memories.search': memoriesSearch(deps) });
}
