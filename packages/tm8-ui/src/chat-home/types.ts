import type { ReactNode } from 'react';
import type { ActorSummary, ChatMode, EntityId, FileAttachment, SpaceId } from '@tm8/contract';

/** C1, normalized for rendering. The durable row sequence lives beside each item. */
export type ChatTurnItem =
  | { kind: 'thinking'; text: string }
  | { kind: 'text'; text: string }
  | {
      kind: 'tool_call';
      toolCallId: string;
      name: string;
      args: unknown;
      state: 'running' | 'completed' | 'error';
    }
  | { kind: 'tool_result'; toolCallId: string; content: unknown; isError?: boolean }
  | { kind: 'usage'; usage: ChatUsage }
  | { kind: 'error'; message: string }
  | { kind: 'done' };

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

export interface ChatModelOption {
  model: string;
  label: string;
  provider: string;
  agentTool: string;
  note?: string;
}

export interface ChatTeammateOption {
  id: EntityId;
  label: string;
  avatar?: string | null;
}

export interface ChatThreadConfig {
  teammateId: EntityId;
  teammateLabel: string;
  model: string;
  modelLabel: string;
  mode: ChatMode;
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
   * IT IS NOT POPULATED BY `listThreads`. A chat's subject is an edge and no
   * list read carries edges, so Wave 1 paid one `connections` call PER CHAT to
   * fill this in — a documented N+1 on the one read that scales with the
   * space. That read is gone: `readThread` fills the field for the ONE chat
   * being opened, and a host that wants "the conversations about X" asks X
   * instead (`chatIdsAbout`, one incoming-edge read).
   */
  aboutId: EntityId | null;
  title: string;
  preview: string;
  updatedAt: string;
  replyCount: number;
  config: ChatThreadConfig;
  state: 'idle' | 'streaming' | 'stopped-continuable' | 'error';
}

/**
 * A work session row for the merged Home column (R4, 2026-08-15: Home's left
 * column lists chat threads AND work sessions in one time-grouped list).
 *
 * COMPOSED BY THE HOST, not read here: `status` must come from the host's
 * liveness verdict composed with the stored record — `execution.liveness` is
 * the only authority for "live", a `running` record with no live process is
 * stale, and `idle` is a LEGAL LIVE STATE (an idle session is running, just
 * quiet). This module renders the words; it must not re-derive them.
 */
export interface ChatSessionRow {
  id: string;
  title: string;
  /** The host's composed word — rendered verbatim, never re-derived here. */
  statusWord: string;
  /** The kit's pill tone vocabulary, chosen by the host's projection. */
  tone: 'run' | 'wait' | 'block' | 'info' | 'idle' | 'brand';
  /** True only when the liveness verdict says a process exists right now. */
  live: boolean;
  /** e.g. `forge · sonnet-4-5` — whatever the host can truthfully compose. */
  detail?: string;
  updatedAt: string;
  /** Visible but not yours: listing has no owner gate; terminal attach does. */
  viewOnly?: boolean;
  /**
   * The workspace tile's badge sub-row, composed BY THE HOST from the same
   * components the tiles use (`SessionLaneLine` branch/worktree facts,
   * `LinkedPullRequestChips`, `TileCountBadges`) — one vocabulary, zero
   * re-derivation here. Rendered as a SIBLING of the row button because PR
   * chips carry real `<a>` links, which cannot nest inside a button.
   */
  badges?: ReactNode;
}

/**
 * A task row for Home's Tasks tab (task 01a006f8 D1/D11). Same contract as
 * `ChatSessionRow`: COMPOSED BY THE HOST — the status word and tone come from
 * the host's registry projection (`homeRowOf`), and the host owns ordering
 * (open-first, then recency — Q1's provisional scope). This module renders
 * rows in the order given and filters them client-side; it re-derives nothing.
 */
export interface ChatTaskRow {
  id: string;
  title: string;
  /** The host's composed word — rendered verbatim, never re-derived here. */
  statusWord: string;
  /** The kit's pill tone vocabulary, chosen by the host's projection. */
  tone: 'run' | 'wait' | 'block' | 'info' | 'idle' | 'brand';
  /** e.g. priority or assignee — whatever the host can truthfully compose. */
  detail?: string;
  updatedAt: string;
  /** Same contract as `ChatSessionRow.badges` — PR chips + entity counts. */
  badges?: ReactNode;
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
}

export interface ChatThreadDetail {
  summary: ChatThreadSummary;
  turns: ChatTurn[];
}

/**
 * ONE input, and one call (176).
 *
 * This used to be two: `createRoot` posted a message, then `configure` bound a
 * chat_threads row to it. That shape existed because a chat WAS its root
 * message — there was nothing to create until something had been posted. A
 * chat is an entity now, so `chat.start` creates it and posts its opening turn
 * in one transaction, and the two-call dance (with its window in which a
 * message existed that was not yet a chat) has nothing left to express.
 */
export interface ChatCreateInput {
  spaceId: SpaceId | string;
  /**
   * The entity this chat is ABOUT — the Craft blueprint, the task, whatever the
   * host opened it from. Written as an `about` edge.
   *
   * It replaces `anchorId`, and the rename is the point: a chat is the anchor
   * of its own transcript now, so the context entity is a relation rather than
   * the place the messages had to live. Bare Home passes none.
   */
  aboutId?: EntityId | null;
  body: string;
  teammateId: EntityId;
  model: string;
  mode: ChatMode;
  clientMutationId: string;
  /**
   * Files staged on the composer, already uploaded — this carries their entity
   * ids onto the opening message (R4: chat surfaces stage chips). Optional
   * because a port older than the rich-input adoption simply never sends any,
   * and a message with none is the ordinary case.
   */
  attachmentIds?: EntityId[];
}

export interface ChatPostInput {
  chatId: EntityId;
  body: string;
  clientMutationId: string;
  /** Same contract as `ChatCreateInput.attachmentIds` — every turn may carry files. */
  attachmentIds?: EntityId[];
}

export interface ChatStartResult {
  chatId: EntityId;
  teammateId: EntityId;
  model: string;
  mode: ChatMode;
}

export interface ChatPostResult {
  messageId: EntityId;
}

export interface ChatHomePort {
  /** Non-null means the space-wide L2 read does not exist on this node yet. */
  threadListUnavailableReason?: string | null;
  listThreads(spaceId: SpaceId | string): Promise<readonly ChatThreadSummary[]>;
  /**
   * The chats whose `about` edge points at one entity — the ONE read that
   * replaces Wave 1's per-chat N+1.
   *
   * ASKED OF THE SUBJECT, NOT OF THE CHATS, and that is the whole saving: the
   * edge is chat → subject, so reading it from the subject's INCOMING side
   * answers for every chat at once. Wave 1 asked each chat what it was about
   * (one `connections` call per row, bounded only by the chat list) to serve a
   * single host — Craft's picker — that already knew which subject it cared
   * about.
   *
   * Returns ids rather than summaries: the caller already holds the rows from
   * `listThreads` and wants to FILTER them, and returning summaries here would
   * be a second source of truth about what exists — the thing `onThreadsChange`
   * exists to prevent.
   */
  chatIdsAbout(aboutId: EntityId): Promise<readonly EntityId[]>;
  readThread(chatId: EntityId): Promise<ChatThreadDetail>;
  listTeammates(spaceId: SpaceId | string): Promise<readonly ChatTeammateOption[]>;
  /**
   * `chat.start`. A non-null reason keeps the visible new-chat composer honest
   * while an older node has no start operation.
   */
  startThread: {
    unavailableReason: string | null;
    /** Creates the chat AND posts its opening turn. One call, one transaction. */
    create(input: ChatCreateInput): Promise<ChatStartResult>;
  };
  /** Every later turn is a messages.post ANCHORED on the chat. */
  postTurn(input: ChatPostInput): Promise<ChatPostResult>;
  interrupt?(chatId: EntityId): Promise<void>;
  subscribe(listener: (frame: ChatTurnFrame) => void): () => void;
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
