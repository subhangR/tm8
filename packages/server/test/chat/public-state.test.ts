import { describe, expect, it, vi } from 'vitest';
import { attachChatRuntimeFacts, chatPublicRuntime, type ChatPublicRuntimeRow } from '../../src/chat/public-state.js';
import type { Querier } from '../../src/db/types.js';

const row: ChatPublicRuntimeRow = {
  id: '10000000-0000-4000-8000-000000000001', config_revision: '8', runtime_phase: 'running',
  turn_id: '10000000-0000-4000-8000-000000000002', claimed_revision: '7', generation: '3',
  model: 'gpt-6.1-sol', provider: 'openai', agent_tool: 'codex', reasoning_effort: 'xhigh',
  attempt_phase: 'accepted', seed_acknowledged: true, native_verified: false,
  observed_at: new Date('2026-10-10T00:00:00Z'),
};
describe('public chat runtime evidence', () => {
  it('shows immutable current-turn settings separately from the next desired revision', () => {
    const state = chatPublicRuntime(row);
    expect(state).toMatchObject({ configRevision: 8, pendingForNextClaim: true,
      activeTurn: { model: 'gpt-6.1-sol', configRevision: 7, reasoningEffort: 'xhigh', generation: 3 },
      runtime: { phase: 'running', continuity: 'portable_verified', observedAt: '2026-10-10T00:00:00.000Z' } });
    expect(JSON.stringify(state)).not.toMatch(/auth|nativeId|snapshot|storage|credential/);
  });
  it('never treats local launch materialization as acknowledged history', () => {
    expect(chatPublicRuntime({ ...row, runtime_phase: 'prepared', attempt_phase: 'prepared', seed_acknowledged: false }))
      .toMatchObject({ activeTurn: { status: 'preparing' }, runtime: { continuity: 'pending', phase: 'starting' } });
    expect(chatPublicRuntime({ ...row, runtime_phase: 'recovering', attempt_phase: 'delivery_unknown' }))
      .toMatchObject({ activeTurn: { status: 'interrupted' }, runtime: { phase: 'unknown' } });
  });
  it('does not query new tables on a position-pinned database and batches new chats once', async () => {
    const query = vi.fn(async () => [row]);
    const q = { query } as unknown as Querier;
    await attachChatRuntimeFacts(q, [{ id: row.id, kind: 'chat' }]);
    expect(query).not.toHaveBeenCalled();
    const rows = [{ id: row.id, kind: 'chat', chat_config_revision: 8, chat_runtime_public: undefined }];
    await attachChatRuntimeFacts(q, rows);
    expect(query).toHaveBeenCalledTimes(1);
    expect(rows[0]!.chat_runtime_public).toMatchObject({ configRevision: 8 });
  });
});
