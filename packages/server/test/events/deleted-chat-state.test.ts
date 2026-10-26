/**
 * A DELETED chat's state must still be a contract EntityState.
 *
 * The `chats_select` policy hides the `chats` row once its entity is deleted,
 * so both summary twins read every `chat_*` column as null. They used to fall
 * back to '' — which `model: z.string().min(1)` refuses. On prod, migration
 * 330's launched_by backfill pointed edges at a deleted chat, every replay of
 * that `edge.upsert` threw OffContractEventError, and the space's event feed
 * stuck at that seq (lvlup space, seq 157584, 2026-10-17).
 */
import { describe, expect, it } from 'vitest';
import { EntityStateSchema } from '@tm8/contract';
import { stateOf, type AssemblyContext, type EntityRow } from '../../src/facade/entity-read.js';
import { PgEntityProjector } from '../../src/events/projector.js';
import type { Querier } from '../../src/db/types.js';

const CHAT = '00000000-0000-7000-8000-000000000051';
const CREATOR = '00000000-0000-7000-8000-000000000052';

/** The row the summary SQL returns for a deleted chat: the chats join is empty. */
const deletedChatRow = {
  id: CHAT,
  space_id: '00000000-0000-7000-8000-000000000053',
  kind: 'chat',
  parent_id: null,
  position: 1,
  visibility: 'space',
  version: 4,
  activity_at: '2026-10-16T12:10:20.575Z',
  created_at: '2026-10-16T10:00:00.000Z',
  updated_at: '2026-10-16T12:10:20.575Z',
  deleted_at: '2026-10-16T12:10:20.575Z',
  created_by: CREATOR,
  chat_title: null,
  chat_teammate_id: null,
  chat_model: null,
  chat_provider: null,
  chat_agent_tool: null,
  chat_mode: null,
  chat_workdir_mode: null,
  chat_project_id: null,
  chat_runtime_state: null,
  chat_turn_state: null,
  chat_turn_count: null,
  chat_last_turn_at: null,
  chat_context: null,
};

describe('deleted chat state', () => {
  it('the projector (event feed) emits a contract-valid chat state', async () => {
    const q = {
      query: async (sql: string) => (sql.includes('from public.entities e') ? [deletedChatRow] : []),
    } as unknown as Querier;
    const summaries = await new PgEntityProjector().entitySummaries(q, [CHAT]);
    const state = summaries.get(CHAT)?.state;
    expect(state?.kind).toBe('chat');
    expect(EntityStateSchema.safeParse(state).success).toBe(true);
  });

  it('entity-read (entities.get) emits the same contract-valid state', () => {
    const ctx = { actors: new Map(), relations: {}, viewerReactions: new Map() } as unknown as AssemblyContext;
    const state = stateOf(deletedChatRow as unknown as EntityRow, ctx);
    expect(EntityStateSchema.safeParse(state).success).toBe(true);
  });
});
