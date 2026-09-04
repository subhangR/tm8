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
      threadRootId: EntityId;
      messageId: EntityId;
      seq: number;
      part: ChatTurnItem;
    }
  | {
      type: 'chat.turn.done';
      threadRootId: EntityId;
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
  rootId: EntityId;
  /**
   * The entity this conversation hangs off — the seeded default channel for
   * bare Home, the crafted `graph` row for a Craft thread.
   *
   * SURFACED BECAUSE A HOST CANNOT SCOPE WITHOUT IT. `listThreads` is
   * space-wide by construction, so a contextual surface (Craft) that wants
   * "the conversations about THIS object" had no way to ask: the L2 read has
   * carried `anchorId` all along (`ChatThreadListItem`) and the fold to a
   * summary simply dropped it. Filtering here is honest — same rows, fewer —
   * where a second anchored read would be a second source of truth.
   */
  anchorId: EntityId;
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

export interface ChatRootInput {
  spaceId: SpaceId | string;
  /** Bare Home uses the space entity id; contextual Chat uses that context entity. */
  anchorId: EntityId;
  body: string;
  clientMutationId: string;
  /**
   * Files staged on the composer, already uploaded against `anchorId` — this
   * carries their entity ids onto the message (R4: chat surfaces stage chips).
   * Optional because a port older than the rich-input adoption simply never
   * sends any, and a message with none is the ordinary case.
   */
  attachmentIds?: EntityId[];
}

export interface ChatConfigureInput {
  rootMessageId: EntityId;
  teammateId: EntityId;
  model: string;
  mode: ChatMode;
  clientMutationId: string;
}

export interface ChatPostInput {
  threadRootId: EntityId;
  body: string;
  clientMutationId: string;
  /** Same contract as `ChatRootInput.attachmentIds` — every turn may carry files. */
  attachmentIds?: EntityId[];
}

export interface ChatStartResult {
  threadRootId: EntityId;
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
  readThread(threadRootId: EntityId): Promise<ChatThreadDetail>;
  listTeammates(spaceId: SpaceId | string): Promise<readonly ChatTeammateOption[]>;
  /**
   * C4's sole new catalog operation. A non-null reason keeps the visible new-chat
   * composer honest while an older node has no start/config operation yet.
   */
  startThread: {
    unavailableReason: string | null;
    /** Call 1: existing messages.post creates the human-authored root/first prompt. */
    createRoot(input: ChatRootInput): Promise<{ threadRootId: EntityId }>;
    /** Call 2: the sole new catalog op write-once configures the root and triggers turn one. */
    configure(input: ChatConfigureInput): Promise<ChatStartResult>;
  };
  /** C4: every user turn, including the first, is an existing messages.post reply. */
  postTurn(input: ChatPostInput): Promise<ChatPostResult>;
  interrupt?(threadRootId: EntityId): Promise<void>;
  subscribe(listener: (frame: ChatTurnFrame) => void): () => void;
}

export function isChatTurnFrame(value: unknown): value is ChatTurnFrame {
  if (typeof value !== 'object' || value === null) return false;
  const frame = value as Record<string, unknown>;
  if (frame.type === 'chat.turn.delta') {
    return (
      typeof frame.threadRootId === 'string' &&
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
      typeof frame.threadRootId === 'string' &&
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
