import type { ReactNode } from 'react';
import type { ChatCredentialIntent, ChatRuntimeState, ChatCredentialSelection, ActorSummary, ChatMode, ChatWorkdirMode, EntityId, EntityKind, FileAttachment, LaunchModelEffort, SessionTranscriptContext, SpaceId, TeamMemberMode } from '@tm8/contract';
import type { ChatContextFrame, ChatThreadDetail, ChatThreadSummary, ChatTurn, ChatTurnFrame } from '@tm8/client-core/chat';

export interface ChatModelOption {
  model: string;
  label: string;
  provider: string;
  agentTool: string;
  note?: string;
  /**
   * Reasoning-effort stops the model accepts, ascending. ABSENT means the
   * catalog entry predates effort capability data (a browser-added model, an
   * older node) and the effort dial renders disabled with that reason; EMPTY
   * means the model has one fixed level. Never invented client-side.
   */
  efforts?: readonly LaunchModelEffort[];
}

export interface ChatTeammateOption {
  id: EntityId;
  label: string;
  avatar?: string | null;
  /**
   * `team_members.mode`, projected by the node (ac_11). ABSENT ⇒ the node
   * does not project it and no filter may pretend to know; `null` ⇒ the row
   * has no role. Only `coordinator` / `coordinated-coordinator` are
   * coordinators.
   */
  mode?: TeamMemberMode | null;
  /** `team_members.permission_mode` — free text; the rail derives its default rung from it. */
  permissionMode?: string | null;
  /** The teammate's own model, when the node projects it. */
  model?: string | null;
}

/**
 * The new-thread composer's STARTING chips, chosen by a host before the first
 * message (the entity chat's settings card, design 01a0da4e §3.4). `projectId`
 * is a `projects.id`; `null` is scratch. Nothing is created from it — it only
 * decides what the composer shows until the viewer sends or edits.
 */
export interface NewChatSeed {
  teammateId?: EntityId | null;
  model?: string | null;
  mode?: ChatMode | null;
  projectId?: EntityId | null;
  /** Focus the message box once the composer is on screen. */
  focus?: boolean;
}

export interface ChatProjectOption {
  id: EntityId;
  name: string;
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

/** One older page of a chat, oldest first, and where the page before it starts. */
export interface ChatOlderTurns {
  turns: ChatTurn[];
  olderCursor: string | null;
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
  /** The Coordinator's team (328): a turn field the server renders into the prompt, never body text. */
  team?: import('@tm8/contract').ChatTurnTeam;
  credentialSelection?: ChatCredentialSelection;
  reasoningEffort?: LaunchModelEffort | null;
  mcpSelections?: import("../mcp/port").McpSelection[];
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
  /**
   * Where the thread's changes land. Write-once on the server (167), which is
   * why the composer offers it only in the empty state. Absent ⇒ `scratch`.
   */
  workdirMode?: ChatWorkdirMode;
  projectId?: EntityId | null;
  /** Overrides the server's default title (the opening body, trimmed). */
  title?: string | null;
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
  /** The Coordinator's team (328): a turn field the server renders into the prompt, never body text. */
  team?: import('@tm8/contract').ChatTurnTeam;
  chatId: EntityId;
  body: string;
  clientMutationId: string;
  /** Same contract as `ChatCreateInput.attachmentIds` — every turn may carry files. */
  attachmentIds?: EntityId[];
  /**
   * THE MODE THIS ONE TURN RUNS UNDER, and the reason it is per-turn rather
   * than a second `setModel`-style write.
   *
   * The server has carried this since 153/154: `messages.requested_chat_mode`
   * is copied onto `chat_turns.mode` by the enqueue trigger, and the claim
   * resolves `coalesce(turn.mode, chat.chat_mode)` — so a turn names its own
   * mode and the chat's default covers the rest. `PostMessageInput.mode`
   * already accepts it on the wire; nothing in this UI was sending it.
   *
   * It needs NO relaunch, which is what separates it from the model: the
   * system prompt is deliberately mode-independent and carries a guide to
   * every mode (`chatSystemPrompt`, "input.chatMode is not read here"), each
   * turn's `[mode: x]` envelope line selects which one applies, and the tool
   * surface does not vary — `toolPermission` returns 'allow' for every mode,
   * so `exposedToolNames` is the identity filter. A mode states INTENT, not
   * permission.
   *
   * OMITTED means "the thread's default", and stays omitted unless the viewer
   * actually picks something, so `requested_chat_mode` stays NULL on a turn
   * nobody redirected.
   */
  mode?: ChatMode;
}

/**
 * MOVE AN OPEN CHAT ONTO ANOTHER MODEL (276).
 *
 * Deliberately NOT a field on `ChatPostInput`. The model is a property of the
 * CHAT, not of one message: a per-message field would make every turn a place
 * the model could silently differ, and would have to be re-sent identically on
 * every send to mean "no change". Sending the change once, when the human makes
 * it, is also what lets the rail show the current model without inspecting the
 * last message.
 */
export interface ChatSetModelInput {
  chatId: EntityId;
  /** A launch-catalog model id admitted by the server's adapter registry. */
  model: string;
  reasoningEffort?: LaunchModelEffort | null;
  credentialSelection?: ChatCredentialSelection;
  expectedConfigRevision?: number;
  clientMutationId?: string;
}

export interface ChatSetModelResult {
  model: string;
  /** Server-resolved from the model. Shown nowhere yet; kept so it cannot be invented. */
  provider: string;
  reasoningEffort?: LaunchModelEffort | null;
  credentialSelection?: ChatCredentialSelection;
  credentialIntent?: ChatCredentialIntent;
  configRevision?: number;
  appliesAt?: 'next_claim';
}

export interface ChatStartResult {
  chatId: EntityId;
  teammateId: EntityId;
  model: string;
  mode: ChatMode;
  /** The opening message `chat.start` stored — what the optimistic first turn
   *  is re-keyed to. Optional: a port that does not know it leaves the
   *  optimistic turn to the next snapshot. */
  messageId?: EntityId;
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
  /**
   * The page of turns before `cursor` (a `ChatThreadDetail.olderCursor`).
   * OPTIONAL: a port that reads a chat whole (fixtures) never hands out one.
   */
  readOlderTurns?(chatId: EntityId, cursor: string): Promise<ChatOlderTurns>;
  listTeammates(spaceId: SpaceId | string): Promise<readonly ChatTeammateOption[]>;
  /**
   * Projects this space can bind a chat to. OPTIONAL: a port without one
   * renders the project control disabled with that reason rather than an
   * empty menu that implies the space has no projects.
   */
  listProjects?(spaceId: SpaceId | string): Promise<readonly ChatProjectOption[]>;
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
  /**
   * `chat.setModel` (276) — the only door that changes an existing chat's model.
   *
   * OPTIONAL for the same reason as `listProjects`: a port without one leaves the
   * model control locked with the reason it has always shown, which is the truth
   * on a node whose server has no such operation. The screen must therefore
   * check for it rather than assume it, and a stale port literal in a test keeps
   * working instead of crashing on a member it never declared.
   */
  credentialOptions?(spaceId: SpaceId | string, model?: string): Promise<readonly { id: string; label: string }[]>;
  setCredentials?(input: { chatId: EntityId; credentialSelection: ChatCredentialSelection; expectedConfigRevision?: number; clientMutationId?: string }): Promise<ChatCredentialSelection>;
  setModel?(input: ChatSetModelInput): Promise<ChatSetModelResult>;
  interrupt?(chatId: EntityId): Promise<void>;
  subscribe(listener: (frame: ChatTurnFrame) => void): () => void;
  /**
   * The live socket came back after dropping. Chat frames are NOT durable
   * events — nothing replays the deltas published while it was down — so the
   * screen re-reads the open thread on this. Absent on a port with no socket
   * (fixtures).
   */
  subscribeReconnect?(listener: () => void): () => void;
  /** Live context readings. Absent on a port with no live runtime (fixtures). */
  subscribeContext?(listener: (frame: ChatContextFrame) => void): () => void;
}
