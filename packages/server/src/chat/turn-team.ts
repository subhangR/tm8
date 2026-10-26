/**
 * 328 — stamp the Coordinator's team onto the chat turn a message just queued.
 *
 * Call it INSIDE the transaction that created the message (`messages.post`,
 * `chat.start`): `set_chat_turn_team` only stamps a message created in the
 * caller's own transaction, and the claim only sees committed rows, so the
 * turn can never run before its team is on it.
 *
 * A database that predates 328 has no function to call, and calling a missing
 * one would abort the whole post — so there the team is dropped and the turn
 * goes out without its line.
 */
import type { ChatTurnTeam } from '@tm8/contract';
import type { Querier } from '../db/types.js';

export async function stampChatTurnTeam(
  q: Querier,
  messageIds: readonly string[],
  team: ChatTurnTeam | undefined,
): Promise<void> {
  if (!team || team.members.length === 0 || messageIds.length === 0) return;
  const [stampable] = await q.query<{ ok: boolean }>(
    `select to_regprocedure('public.set_chat_turn_team(uuid,jsonb)') is not null as ok`,
    [],
  );
  if (!stampable?.ok) return;
  for (const messageId of messageIds) {
    await q.rpc('set_chat_turn_team', [messageId, JSON.stringify(team)]);
  }
}
