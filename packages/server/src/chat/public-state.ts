import { ChatRuntimeStateSchema, type ChatRuntimeState } from '@tm8/contract';
import type { Querier } from '../db/types.js';

export interface ChatPublicRuntimeRow {
  id: string;
  config_revision: string | number;
  runtime_phase: string;
  turn_id: string | null;
  claimed_revision: string | number | null;
  generation: string | number | null;
  model: string | null;
  provider: string | null;
  agent_tool: string | null;
  reasoning_effort: string | null;
  attempt_phase: string | null;
  seed_acknowledged: boolean;
  native_verified: boolean;
  observed_at: Date | string | null;
}

/** Only explicit public fields survive; private snapshots and native references never do. */
export function chatPublicRuntime(row: ChatPublicRuntimeRow): ChatRuntimeState {
  const configRevision = Number(row.config_revision);
  const generation = row.generation == null ? null : Number(row.generation);
  const active = row.turn_id && row.model && row.provider && row.agent_tool
    && ['prepared', 'dispatching', 'accepted', 'delivery_unknown'].includes(row.attempt_phase ?? '');
  const phase: ChatRuntimeState['runtime']['phase'] =
    row.runtime_phase === 'running' || row.runtime_phase === 'dispatching' ? 'running'
    : row.runtime_phase === 'ready' ? 'ready'
    : row.runtime_phase === 'closing' ? 'stopping'
    : ['preparing', 'opening', 'prepared'].includes(row.runtime_phase) ? 'starting'
    : row.runtime_phase === 'idle' ? 'stopped' : 'unknown';
  return ChatRuntimeStateSchema.parse({
    schemaVersion: 1, configRevision,
    activeTurn: active ? {
      turnId: row.turn_id, configRevision: Number(row.claimed_revision), generation,
      model: row.model, provider: row.provider, agentTool: row.agent_tool,
      reasoningEffort: row.reasoning_effort,
      status: row.attempt_phase === 'delivery_unknown' ? 'interrupted'
        : row.attempt_phase === 'prepared' ? 'preparing' : 'running',
    } : null,
    runtime: {
      generation, phase,
      continuity: row.native_verified ? 'native_verified'
        : row.seed_acknowledged ? 'portable_verified'
        : phase === 'stopped' ? 'unavailable' : 'pending',
      observedAt: row.observed_at instanceof Date ? row.observed_at.toISOString() : row.observed_at,
    },
    pendingForNextClaim: Boolean(active && configRevision > Number(row.claimed_revision)),
  });
}

/** One bounded query for the batch, guarded by column presence for position-pinned databases. */
export async function attachChatRuntimeFacts<T extends {
  id: string; kind: string; chat_config_revision?: string | number | null; chat_runtime_public?: ChatRuntimeState;
}>(q: Querier, rows: readonly T[]): Promise<void> {
  const ids = rows.filter(row => row.kind === 'chat' && row.chat_config_revision != null).map(row => row.id);
  if (!ids.length) return;
  const facts = await q.query<ChatPublicRuntimeRow>(`
    select c.entity_id id,c.config_revision,c.runtime_phase,a.turn_id,
      a.config_revision claimed_revision,a.native_generation generation,
      a.configuration_snapshot->'desired'->>'model' model,
      a.configuration_snapshot->'desired'->>'provider' provider,
      a.configuration_snapshot->'desired'->>'agentTool' agent_tool,
      a.configuration_snapshot->'desired'->>'reasoningEffort' reasoning_effort,
      a.phase attempt_phase,
      coalesce(b.seed_ack_digest is not null,false) seed_acknowledged,
      coalesce(b.covered_cursor is not null and b.native_checkpoint->>'verified'='true'
        and b.status='ready',false) native_verified,
      coalesce(a.settled_at,a.accepted_at,a.dispatch_started_at,a.created_at) observed_at
    from public.chats c
    left join public.chat_turn_attempts a on a.snapshot_id=c.active_execution_snapshot_id
    left join public.chat_native_bindings b on b.chat_id=c.entity_id and b.generation=a.native_generation
    where c.entity_id=any($1::uuid[])
  `, [ids]);
  const byId = new Map(facts.map(row => [row.id, chatPublicRuntime(row)]));
  for (const row of rows) {
    const runtime = byId.get(row.id);
    if (runtime) row.chat_runtime_public = runtime;
  }
}
