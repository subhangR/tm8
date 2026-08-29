// PR188 review F1 follow-through: the wire↔render normalizer.
//
// The server persists and publishes contract `MessagePart`s — `{seq,
// createdAt, kind, payload}` with snake_case payload fields — while this
// module's render types (`ChatTurnItem`/`ChatTurnPart`) are flattened and
// camelCased. The two were written by different lanes against C1 and never
// met until integration: reading a payload-wrapped part through the flattened
// type yields `undefined` in every field, silently. This file is the ONE
// place the translation happens; both the message-view read path and the WS
// frame path go through it.

import type { ChatTurnUsage, MessagePart } from '@tm8/contract';
import type { ChatTurnFrame, ChatTurnItem, ChatTurnPart, ChatUsage } from './types';

export function chatUsageFromWire(usage: ChatTurnUsage | null | undefined): ChatUsage {
  if (!usage) return {};
  return {
    ...(usage.input_tokens !== undefined ? { input_tokens: usage.input_tokens } : {}),
    ...(usage.output_tokens !== undefined ? { output_tokens: usage.output_tokens } : {}),
    ...(usage.cache_read_input_tokens !== undefined
      ? { cache_read_tokens: usage.cache_read_input_tokens }
      : {}),
    ...(usage.cache_creation_input_tokens !== undefined
      ? { cache_creation_tokens: usage.cache_creation_input_tokens }
      : {}),
    // Absent cost stays absent — never coerced to zero (D10).
    ...(usage.total_cost_usd !== undefined ? { total_cost_usd: usage.total_cost_usd } : {}),
  };
}

export function turnItemFromMessagePart(part: MessagePart): ChatTurnItem {
  switch (part.kind) {
    case 'thinking':
      return { kind: 'thinking', text: part.payload.text };
    case 'text':
      return { kind: 'text', text: part.payload.text };
    case 'tool_call':
      return {
        kind: 'tool_call',
        toolCallId: part.payload.id,
        name: part.payload.name,
        args: part.payload.args,
        state: part.payload.state,
      };
    case 'tool_result':
      return {
        kind: 'tool_result',
        toolCallId: part.payload.tool_call_id,
        content: part.payload.content,
        isError: part.payload.is_error,
      };
    case 'usage':
      return { kind: 'usage', usage: chatUsageFromWire(part.payload) };
    case 'error':
      return { kind: 'error', message: part.payload.message };
    case 'done':
      return { kind: 'done' };
  }
}

export function turnPartFromMessagePart(part: MessagePart): ChatTurnPart {
  return { ...turnItemFromMessagePart(part), seq: part.seq };
}

/** The server's C3 frame shapes, before normalization. */
export type WireChatTurnFrame =
  | {
      type: 'chat.turn.delta';
      threadRootId: string;
      messageId: string;
      seq: number;
      part: MessagePart;
    }
  | {
      type: 'chat.turn.done';
      threadRootId: string;
      messageId: string;
      usage: ChatTurnUsage | null;
    };

export function chatTurnFrameFromWire(frame: WireChatTurnFrame): ChatTurnFrame {
  if (frame.type === 'chat.turn.delta') {
    return {
      type: 'chat.turn.delta',
      threadRootId: frame.threadRootId,
      messageId: frame.messageId,
      seq: frame.seq,
      part: turnItemFromMessagePart(frame.part),
    };
  }
  return {
    type: 'chat.turn.done',
    threadRootId: frame.threadRootId,
    messageId: frame.messageId,
    usage: chatUsageFromWire(frame.usage),
  };
}
