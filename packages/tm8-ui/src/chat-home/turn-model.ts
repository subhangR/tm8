import type { EntityId } from '@tm8/contract';
import type {
  ChatThreadDetail,
  ChatTurn,
  ChatTurnFrame,
  ChatTurnPart,
  ChatUsage,
} from './types';

export type ProjectedTurnPart =
  | Extract<ChatTurnPart, { kind: 'thinking' | 'text' | 'usage' | 'error' }>
  | {
      kind: 'tool';
      seq: number;
      toolCallId: string;
      name: string;
      args: unknown;
      state: 'running' | 'completed' | 'error';
      result?: unknown;
      resultIsError?: boolean;
    };

/**
 * Storage remains append-only. Rendering projects every state record for one
 * toolCallId into one card whose status is the newest state by sequence.
 */
export function projectTurnParts(parts: readonly ChatTurnPart[]): ProjectedTurnPart[] {
  const projected: ProjectedTurnPart[] = [];
  const toolIndex = new Map<string, number>();

  for (const part of [...parts].sort((a, b) => a.seq - b.seq)) {
    if (part.kind === 'done') continue;
    if (part.kind === 'tool_call') {
      const index = toolIndex.get(part.toolCallId);
      if (index === undefined) {
        toolIndex.set(part.toolCallId, projected.length);
        projected.push({
          kind: 'tool',
          seq: part.seq,
          toolCallId: part.toolCallId,
          name: part.name,
          args: part.args,
          state: part.state,
        });
      } else {
        const existing = projected[index];
        if (existing?.kind === 'tool') {
          projected[index] = {
            ...existing,
            name: part.name,
            args: part.args,
            state: part.state,
          };
        }
      }
      continue;
    }
    if (part.kind === 'tool_result') {
      const index = toolIndex.get(part.toolCallId);
      const existing = index === undefined ? undefined : projected[index];
      if (existing?.kind === 'tool') {
        projected[index!] = {
          ...existing,
          result: part.content,
          ...(part.isError !== undefined ? { resultIsError: part.isError } : {}),
        };
      }
      continue;
    }
    projected.push(part);
  }

  return projected;
}

export function hasUsage(usage: ChatUsage): boolean {
  return Object.values(usage).some((value) => value !== undefined);
}

export function mergeChatTurnFrame(
  detail: ChatThreadDetail,
  frame: ChatTurnFrame,
): ChatThreadDetail {
  if (frame.chatId !== detail.summary.rootId) return detail;
  const turns = [...detail.turns];
  let index = turns.findIndex((turn) => turn.messageId === frame.messageId);

  if (index < 0) {
    // A done for a message we never saw a delta or snapshot row for carries
    // nothing worth rendering — fabricating an empty assistant turn would put
    // a blank bubble with a made-up timestamp in the transcript.
    if (frame.type === 'chat.turn.done') return detail;
    turns.push(emptyAssistantTurn(frame.messageId, detail));
    index = turns.length - 1;
  }

  const turn = turns[index]!;
  if (frame.type === 'chat.turn.delta') {
    if (turn.parts.some((part) => part.seq === frame.seq)) return detail;
    turns[index] = {
      ...turn,
      parts: [...turn.parts, { ...frame.part, seq: frame.seq }].sort((a, b) => a.seq - b.seq),
    };
    return {
      ...detail,
      summary: { ...detail.summary, state: 'streaming' },
      turns,
    };
  }

  const parts = turn.parts;
  const alreadyHasUsage = parts.some((part) => part.kind === 'usage');
  /* A TURN HOLDING ITS DONE PART NEEDS NO STAND-IN USAGE. The server stores a
     turn's usage part BEFORE its done part, so once the done part is here the
     real usage is durable at a LOWER seq even if a reconnect gap kept its
     delta from us — and the re-read this done triggers brings it. A stand-in
     at max seq + 1 landed past the done, and the snapshot's union by seq kept
     both: two usage parts on one turn (L3, #877). */
  const heldDone = parts.some((part) => part.kind === 'done');
  /* THE TURN IS OVER, SO IT IS NO LONGER IN FLIGHT. `turnInFlight` came from
     the read that found the turn claimed; left set, it outlived the turn and
     kept hiding the body of a turn that finished while it was watched — and a
     finished turn that drew no parts rendered as an empty bubble until the
     next reload. The placeholder body goes with the marker: it described the
     claim, and the durable final body arrives on the re-read a done triggers. */
  const { turnInFlight: _settled, ...rest } = turn;
  turns[index] = {
    ...rest,
    body: turn.turnInFlight && turn.body === CLAIMED_TURN_BODY ? '' : turn.body,
    parts:
      alreadyHasUsage || heldDone || !hasUsage(frame.usage)
        ? parts
        : [
            ...parts,
            {
              kind: 'usage' as const,
              seq: nextSeq(parts),
              usage: frame.usage,
              synthetic: true as const,
            },
          ],
  };
  return {
    ...detail,
    summary: { ...detail.summary, state: 'idle' },
    turns,
  };
}

/**
 * Reconcile a fresh snapshot with what is already on screen, monotonically:
 * a read that captured its snapshot before parts were durable but resolved
 * after them must never make visible content disappear. Chat is append-only,
 * so unioning turns and parts (by message id / seq) is always safe.
 */
export function reconcileDetails(
  current: ChatThreadDetail | null,
  next: ChatThreadDetail,
): ChatThreadDetail {
  if (!current || current.summary.rootId !== next.summary.rootId) return next;
  const nextIds = new Set(next.turns.map((turn) => turn.messageId));
  const turns = next.turns.map((turn) => {
    const existing = current.turns.find((candidate) => candidate.messageId === turn.messageId);
    if (!existing) return turn;
    const seqs = new Set(turn.parts.map((part) => part.seq));
    // A stand-in usage gives way to the stored one: one usage part per turn.
    const storedUsage = turn.parts.some((part) => part.kind === 'usage');
    const extra = existing.parts.filter(
      (part) => !seqs.has(part.seq) && !(storedUsage && part.kind === 'usage' && part.synthetic),
    );
    if (extra.length === 0 && (turn.body || !existing.body)) return turn;
    return {
      ...turn,
      body: turn.body || existing.body,
      parts: [...turn.parts, ...extra].sort((a, b) => a.seq - b.seq),
    };
  });
  /* AN ECHO RETIRES WHEN ITS STORED COPY ARRIVES. An optimistic turn the ack
     could not re-key (a port that returns no message id, or a snapshot that
     beat the ack) is matched one-to-one against a user turn NEW to this read
     with the same words; anything unmatched is still in flight and stays. */
  const currentIds = new Set(current.turns.map((turn) => turn.messageId));
  const arrivals = next.turns.filter((turn) => turn.role === 'user' && !currentIds.has(turn.messageId));
  const missing = current.turns.filter((turn) => {
    if (nextIds.has(turn.messageId)) return false;
    if (!turn.optimistic) return true;
    const match = arrivals.findIndex((arrival) => arrival.body === turn.body);
    if (match < 0) return true;
    arrivals.splice(match, 1);
    return false;
  });
  return missing.length === 0 ? { ...next, turns } : { ...next, turns: [...turns, ...missing] };
}

/** The body the server writes onto the agent message when it claims a turn —
 *  `orchestrator.ts` `createAgentMessage`, asserted by
 *  `server/test/db/chat-storage.pg.test.ts`. Not a UI string: the transcript
 *  never authors it, it only recognises it. */
export const CLAIMED_TURN_BODY = 'Agent turn in progress.';

/** The id an optimistic turn carries until the server acks it. */
export function optimisticTurnId(clientMutationId: string): EntityId {
  return `optimistic:${clientMutationId}` as EntityId;
}

/** Highest stored part seq for one message; -1 when it has none (or is absent). */
export function maxPartSeq(detail: ChatThreadDetail | null, messageId: EntityId): number {
  const turn = detail?.turns.find((candidate) => candidate.messageId === messageId);
  return turn ? turn.parts.reduce((highest, part) => Math.max(highest, part.seq), -1) : -1;
}

/**
 * Paint a turn the server has not acked yet — the user's own words, in the
 * same commit as Send. A detail for another thread is returned untouched.
 */
export function appendOptimisticTurn(
  detail: ChatThreadDetail | null,
  rootId: EntityId,
  turn: ChatTurn,
): ChatThreadDetail | null {
  if (!detail || detail.summary.rootId !== rootId) return detail;
  return { ...detail, turns: [...detail.turns, turn] };
}

/**
 * The ack named the real message: re-key the optimistic turn to it, so the
 * next snapshot's copy REPLACES it rather than standing beside it. When a
 * snapshot already carried the real message, the optimistic copy just goes.
 * With no id to re-key to (a port that does not return one), the optimistic
 * turn stays until `dropTurn` after the next read.
 */
export function settleOptimisticTurn(
  detail: ChatThreadDetail | null,
  optimisticId: EntityId,
  realId: EntityId | null | undefined,
): ChatThreadDetail | null {
  if (!detail || !realId) return detail;
  const index = detail.turns.findIndex((turn) => turn.messageId === optimisticId);
  if (index < 0) return detail;
  if (detail.turns.some((turn) => turn.messageId === realId)) return dropTurn(detail, optimisticId);
  const turns = [...detail.turns];
  turns[index] = { ...turns[index]!, messageId: realId };
  return { ...detail, turns };
}

export function dropTurn(detail: ChatThreadDetail | null, messageId: EntityId): ChatThreadDetail | null {
  if (!detail || !detail.turns.some((turn) => turn.messageId === messageId)) return detail;
  return { ...detail, turns: detail.turns.filter((turn) => turn.messageId !== messageId) };
}

/** A chat's agent turns are all its configured teammate's, so a turn first seen
 *  as a delta is bylined with that teammate rather than a bare "Agent" that the
 *  next read renames — the same byline the turn shell already showed. */
function emptyAssistantTurn(messageId: EntityId, detail: ChatThreadDetail): ChatTurn {
  const { teammateId, teammateLabel } = detail.summary.config;
  return {
    messageId,
    role: 'assistant',
    author: { id: teammateId, kind: 'team_member', displayName: teammateLabel, isAgent: true },
    createdAt: new Date().toISOString(),
    body: '',
    parts: [],
  };
}

function nextSeq(parts: readonly ChatTurnPart[]): number {
  return parts.reduce((highest, part) => Math.max(highest, part.seq), -1) + 1;
}

