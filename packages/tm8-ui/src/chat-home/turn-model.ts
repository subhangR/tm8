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
  if (frame.threadRootId !== detail.summary.rootId) return detail;
  const turns = [...detail.turns];
  let index = turns.findIndex((turn) => turn.messageId === frame.messageId);

  if (index < 0) {
    turns.push(emptyAssistantTurn(frame.messageId));
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
  turns[index] = {
    ...turn,
    parts:
      alreadyHasUsage || !hasUsage(frame.usage)
        ? parts
        : [
            ...parts,
            {
              kind: 'usage' as const,
              seq: nextSeq(parts),
              usage: frame.usage,
            },
          ],
  };
  return {
    ...detail,
    summary: { ...detail.summary, state: 'idle' },
    turns,
  };
}

function emptyAssistantTurn(messageId: EntityId): ChatTurn {
  return {
    messageId,
    role: 'assistant',
    author: null,
    createdAt: new Date().toISOString(),
    body: '',
    parts: [],
  };
}

function nextSeq(parts: readonly ChatTurnPart[]): number {
  return parts.reduce((highest, part) => Math.max(highest, part.seq), -1) + 1;
}

