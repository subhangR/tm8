/*
 * SPLIT (t-p0-client-core, 2026-10-29): the render types of tm8-ui's
 * `chat-home/types.ts` (frames, parts, turns, the thread a transcript folds) and
 * the two frame guards, shared with the phone app (s-lld §7). The port types,
 * some of which carry `ReactNode`, stay in tm8-ui.
 */
import type { ChatCredentialIntent, ChatRuntimeState, ChatCredentialSelection, ActorSummary, ChatMode, ChatWorkdirMode, EntityId, EntityKind, FileAttachment, LaunchModelEffort, SessionTranscriptContext, SpaceId, TeamMemberMode } from '@tm8/contract';

/** C1, normalized for rendering. The durable row sequence lives beside each item. */
export type ChatTurnItem =
  | { kind: 'thinking'; text: string }
  | { kind: 'text'; text: string; itemId?: string; revision?: number; operation?: 'append' | 'replace'; phase?: 'commentary' | 'final' | 'unknown' }
  | {
      kind: 'tool_call';
      toolCallId: string;
      name: string;
      args: unknown;
      state: 'running' | 'completed' | 'error';
    }
  | { kind: 'tool_result'; toolCallId: string; content: unknown; isError?: boolean }
  | {
      kind: 'usage';
      usage: ChatUsage;
      /** CLIENT-ONLY: filled in from a done frame's usage because the usage
       *  part's own delta was never seen. The stored one replaces it. */
      synthetic?: true;
    }
  | { kind: 'error'; message: string }
  | { kind: 'done'; reason?: 'success' | 'error' | 'interrupted' | 'closed' };

export interface ChatUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  cache_creation_tokens?: number;
  /** Absent means the runtime did not report cost. It must never be coerced to zero. */
  total_cost_usd?: number;
  model?: string;
  provider?: string;
}

export type ChatTurnPart = ChatTurnItem & { seq: number };

/** C3 frames, carried on the existing authenticated /v2/ws connection. */
export type ChatTurnFrame =
  | {
      type: 'chat.turn.delta';
      chatId: EntityId;
      messageId: EntityId;
      seq: number;
      part: ChatTurnItem;
    }
  | {
      type: 'chat.turn.done';
      chatId: EntityId;
      messageId: EntityId;
      usage: ChatUsage;
    };

/**
 * The chat's latest context reading, published after the server stored it
 * (231). Its own frame, not a turn frame: it describes the conversation, not
 * a part of any one turn, so it never enters the turn merge.
 */
export interface ChatContextFrame {
  type: 'chat.context';
  chatId: EntityId;
  context: SessionTranscriptContext;
}

export function isChatContextFrame(value: unknown): value is ChatContextFrame {
  if (typeof value !== 'object' || value === null) return false;
  const frame = value as Record<string, unknown>;
  if (frame.type !== 'chat.context' || typeof frame.chatId !== 'string') return false;
  const context = frame.context as Record<string, unknown> | null | undefined;
  return (
    typeof context === 'object' &&
    context !== null &&
    (context.usedTokens === null || typeof context.usedTokens === 'number') &&
    (context.capacityTokens === null || typeof context.capacityTokens === 'number')
  );
}

export interface ChatThreadConfig {
  teammateId: EntityId;
  teammateLabel: string;
  model: string;
  modelLabel: string;
  credentialSelection?: ChatCredentialSelection;
  credentialIntent?: ChatCredentialIntent;
  reasoningEffort?: LaunchModelEffort | null;
  configRevision?: number;
  runtime?: ChatRuntimeState;
  mode: ChatMode;
  /** The write-once directory binding. Absent on a port that predates 167. */
  workdirMode?: ChatWorkdirMode;
  projectId?: EntityId | null;
  /**
   * Whether THIS viewer may change the chat's model, as the server answered it
   * (`state.canSetModel`: 276's rule, evaluated under the viewer's claims).
   * ABSENT means unknown — a node older than the field — and must never lock:
   * read as "someone else's chat", it would lock every configurer out of their
   * own chat on every node that predates it.
   */
  canSetModel?: boolean;
}

export interface ChatThreadSummary {
  /** The chat entity's id (176). It used to be the root message's. */
  rootId: EntityId;
  /**
   * The entity this conversation is ABOUT — the crafted `graph` row for a Craft
   * chat, `null` for a bare Home chat.
   *
   * RENAMED FROM `anchorId` (Wave 2). Since 176 it is the `about` EDGE, not
   * the message anchor: a chat is the anchor of its own transcript now, so the
   * context entity is a relation rather than the place the messages had to
   * live. Wave 1 kept the old name for one wave so the Craft picker's filter
   * did not move in the same change as the data model underneath it.
   *
   * `null` MEANS "NO SUBJECT", AND IT USED TO MEAN "ITSELF". Wave 1 folded an
   * absent subject to the chat's own id (`item.aboutId ?? item.chatId`), which
   * made every bare Home chat look like a chat about itself — harmless while
   * the only reader was an equality filter that never matched, and a lie the
   * moment a panel header draws the relation. It is null now.
   *
   * `listThreads` FILLS IT FROM THE SUMMARY (entity chat §3.6). Wave 1 paid
   * one `connections` call PER CHAT for this — a documented N+1 on the one read
   * that scales with the space. The server now batches each chat's subject
   * into its summary state (`state.about`), so the list carries it for free;
   * `readThread` still reads the edge for the ONE chat being opened.
   */
  aboutId: EntityId | null;
  /**
   * The subject's kind and title, for the Chats list's "about ‹title›" chip.
   * Present only when the list read carried them (`state.about`); a port or a
   * server that predates §3.6 leaves it absent and the row draws no chip.
   */
  about?: { id: EntityId; kind: EntityKind; title: string } | null;
  title: string;
  preview: string;
  updatedAt: string;
  replyCount: number;
  config: ChatThreadConfig;
  state: 'idle' | 'streaming' | 'stopped-continuable' | 'error';
  /** The runtime's own axis — only a live one is still updating `context`. */
  runtimeState?: 'cold' | 'live' | 'stopped';
  /** The latest stored context reading (231); null until measured. */
  context?: SessionTranscriptContext | null;
}

export interface ChatTurn {
  messageId: EntityId;
  role: 'user' | 'assistant';
  author: ActorSummary | null;
  createdAt: string;
  /** The ordinary durable message body. Rich assistant output may instead be in parts. */
  body: string;
  parts: ChatTurnPart[];
  /**
   * THE ENTITY THIS MESSAGE WAS AUTHORED FROM — the recorder-owned
   * `authored_from` edge's target (`FeedItem.sourceWorkSessionId`, which is
   * named for its first destination kind and carries whatever the edge points
   * at: since 176 that may be a work_session OR a chat).
   *
   * WHAT IT IS FOR: a chat is a routing target now, so a message in this
   * transcript may have been written by a work session reporting back or by
   * another chat — and neither is the person or the agent this conversation is
   * between. Those render as THIRD-PARTY bubbles with a chip naming the source,
   * and this is the only field that can tell them apart. `state.author` cannot:
   * a session's persona resolves to the same `team_member` summary the chat's
   * own agent has, and a chat author resolves to a bare `member`.
   *
   * THE CHAT'S OWN AGENT TURNS CARRY IT TOO, pointing at the chat itself —
   * `createAgentMessage` passes `p_source_chat_id = turn.chatId` so the SQL
   * self-guard fires and the chat is never handed its own output. So a reader
   * must compare against the chat's id rather than test for presence.
   *
   * OPTIONAL, like every other additive field here: `messages.list` does not
   * carry provenance, so a port that reads only that supplies none, and absent
   * renders exactly as today.
   */
  sourceEntityId?: EntityId | null;
  /**
   * Files carried on this message — the server's own `content.attachments`,
   * populated on every message read (`FileAttachment[]`, contract v1). The
   * write path staged and posted them all along; the transcript simply never
   * read them back, which is why an uploaded image was invisible on the one
   * surface that uploaded it.
   *
   * OPTIONAL, like every other additive field on this shape: a port that
   * predates this — or an optimistic turn built client-side before the server
   * echo — supplies none, and absent renders exactly as empty does. It is
   * never the marker for "this message has no files"; only a read is.
   */
  attachments?: readonly FileAttachment[];
  /** Server wire marker: this is a chat turn's agent message and the turn has
   *  not completed, so `body` is the claim placeholder, not content. */
  turnInFlight?: boolean;
  /**
   * CLIENT-ONLY: this turn was painted on Send, before the server acked it. Its
   * `messageId` is `optimistic:<clientMutationId>` until the ack names the real
   * message, and the next snapshot that carries that message replaces it. Never
   * on the wire.
   */
  optimistic?: true;
}

export interface ChatThreadDetail {
  summary: ChatThreadSummary;
  /** Oldest first. A paging port holds only the newest page(s) here. */
  turns: ChatTurn[];
  /**
   * Where the next OLDER page starts (`readOlderTurns`); `null` once the first
   * turn of the chat is loaded. Absent from a port that reads a chat whole.
   */
  olderCursor?: string | null;
}

export function isChatTurnFrame(value: unknown): value is ChatTurnFrame {
  if (typeof value !== 'object' || value === null) return false;
  const frame = value as Record<string, unknown>;
  if (frame.type === 'chat.turn.delta') {
    return (
      typeof frame.chatId === 'string' &&
      typeof frame.messageId === 'string' &&
      Number.isInteger(frame.seq) &&
      (frame.seq as number) >= 0 &&
      typeof frame.part === 'object' &&
      frame.part !== null &&
      TURN_ITEM_KINDS.has((frame.part as Record<string, unknown>).kind)
    );
  }
  if (frame.type === 'chat.turn.done') {
    return (
      typeof frame.chatId === 'string' &&
      typeof frame.messageId === 'string' &&
      typeof frame.usage === 'object' &&
      frame.usage !== null
    );
  }
  return false;
}

const TURN_ITEM_KINDS = new Set<unknown>([
  'thinking',
  'text',
  'tool_call',
  'tool_result',
  'usage',
  'error',
  'done',
]);
