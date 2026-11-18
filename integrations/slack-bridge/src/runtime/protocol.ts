// The connector protocol (BRIDGE-ENTITY-DESIGN §2.5, D35): the frames a connector runtime and tm8-server exchange.
// Runtime → server frames are POSTed to /v2/bridge-runtime/<route>; server → runtime frames arrive on one WebSocket.
// Every id here is the provider's.
//   WhatsApp: a conversation id is a JID (`…@g.us`, or the owner's own `…@s.whatsapp.net` for a self chat the owner
//   connected), a message id is WhatsApp's key id, a person is a JID.
//   Slack (v4): a conversation id is a channel id (`C…`/`G…`), a message id is the message `ts` ("1700000000.123456"),
//   a person is a user id (`U…`/`W…`, org-wide on Enterprise Grid). A thread is named by its root message's ts.
//
// BYTE-IDENTICAL COPIES (coordinator ruling, B1b, 2026-10-30; a third copy in v4). The canonical one is
// packages/contract/src/bridge-runtime-protocol.ts, exported from @tm8/contract for tm8-server. The mirrors are
// integrations/whatsapp-bridge/src/runtime/protocol.ts and integrations/slack-bridge/src/runtime/protocol.ts, because
// each runtime's Docker context is its own directory alone and the server's rootDir cannot reach it. Edit all copies
// together: packages/contract/test/bridge-runtime-protocol.test.ts fails when they differ. The module stays
// dependency-free.

// v2: group.create follows sourceConversationId's community. Servers refuse source-based creates on v1 runtimes.
// v3: outbound attachments are authenticated HTTP streams, never whole-file WS frames.
// v4: a second provider (Slack). `hello.provider` names it; token connections carry `connect.credential`; native
//     threads (`inbound.thread`, `send.threadTs`); per-message voice (`send.voice`); edits and deletes on `inbound`;
//     slash commands on `inbound.slashCommand`; `state.account` for the connected workspace; `failed.retryAfterSec`.
//     Every v4 addition is optional, so a v3 WhatsApp runtime's frames still parse.
export const PROTOCOL_VERSION = 4

/** The providers a connector runtime can speak for. */
export type RuntimeProvider = 'whatsapp' | 'slack'

/** What the WhatsApp runtime can do, sent once in `hello`. The UI shows only what this sheet allows (§5). */
export const WHATSAPP_CAPABILITIES = {
  threads: 'quotes',
  reactions: true,
  polls: true,
  media: true,
  typing: true,
  readReceipts: true,
  perUserVoice: false,
  history: 'none',
} as const

/**
 * What the Slack runtime can do (v4). `threads: 'native'`: replies name their thread root and the server can post
 * into a thread. `perUserVoice`: each outbound message carries its own display name and icon (chat:write.customize),
 * so the server sends `send.voice` instead of a `Title (handle):` prefix. No typing indicator and no read receipts for
 * bots, so the hub sends neither `typing` nor `read` to this runtime. No polls and no group creation.
 */
export const SLACK_CAPABILITIES = {
  threads: 'native',
  reactions: true,
  polls: false,
  media: true,
  typing: false,
  readReceipts: false,
  perUserVoice: true,
  history: 'full',
} as const

/** Either sheet, as the server holds it per runtime. */
export type RuntimeCapabilities = typeof WHATSAPP_CAPABILITIES | typeof SLACK_CAPABILITIES

export type ConnectionStatus = 'connecting' | 'linked' | 'logged_out' | 'offline'

export type SenderRef = {
  /** WhatsApp: the sender's JID (PN or LID, whichever the group used). Slack: the user id (`U…`/`W…`). */
  externalId: string | null
  /** The other half of the PN/LID pair, when WhatsApp sent it. Always null on Slack. */
  altId: string | null
  /** WhatsApp push name / Slack display name; display only, never matched on (§6). */
  name: string | null
  fromMe: boolean
  /**
   * v4, Slack only: the profile email (users:read.email), when Slack shares it. The server links the sender to the
   * tm8 member whose verified email matches it (design default 5); it is not stored on the message.
   */
  email?: string | null
  /** v4, Slack only: the profile image URL, display only. */
  avatarUrl?: string | null
  /** v4: the sender is a bot or app (Slack `bot_id`/`subtype: bot_message`). Never a tm8 member. */
  bot?: boolean
}

export type MediaRef = {
  kind: 'image' | 'document' | 'video' | 'audio' | 'sticker'
  mime: string | null
  fileName: string | null
  caption: string | null
  size: number | null
  durationSec?: number | null
  ptt?: boolean
  /**
   * Opaque, self-contained fetch handle for `media.fetch`, valid across runtime restarts. WhatsApp: the message's media
   * keys. Slack: the file id (the runtime fetches `url_private` with the bot token; the handle holds no secret).
   */
  handle: string
}

// ---------------------------------------------------------------------------------------------------------------
// runtime → server
// ---------------------------------------------------------------------------------------------------------------

export type HelloFrame =
  | { provider: 'whatsapp'; version: number; runtimeId: string; capabilities: typeof WHATSAPP_CAPABILITIES }
  | { provider: 'slack'; version: number; runtimeId: string; capabilities: typeof SLACK_CAPABILITIES }

/** The server's answer to `hello`: the connections this runtime runs and each one's allowlist. */
export type HelloReply = { connections: { connectionId: string; stateKey: string; allowlist: AllowlistFrame }[] }

export type StateFrame = {
  connectionId: string
  status: ConnectionStatus
  detail: string | null
  /** The number's own JIDs once linked (PN and LID), so the server can offer the owner's self chat. */
  self?: { id: string | null; lid: string | null }
  /**
   * v4, Slack: what `auth.test` answered once the tokens checked out, sent with `status: 'linked'`. The server keeps it
   * on the connection (externalAccountId = teamId, or enterpriseId on an org-wide Grid install) and shows it as
   * "Connected to <teamName> (<url host>) as @<botName>". Bad tokens arrive as `status: 'logged_out'` with
   * `detail` = Slack's error code (`invalid_auth`, `not_allowed_token_type`, `missing_scope: <scope>`…), never a token.
   */
  account?: SlackAccount
}

export type SlackAccount = {
  teamId: string
  teamName: string
  /** The workspace URL, e.g. https://acme.slack.com/ — the base for "View in Slack" links. */
  url: string
  /** Set on Enterprise Grid, for an org-wide install AND for a single workspace of a Grid org. */
  enterpriseId: string | null
  enterpriseName: string | null
  /** auth.test `is_enterprise_install`: the app is installed org-wide on a Grid org (externalAccountId = enterpriseId). */
  isEnterpriseInstall: boolean
  botUserId: string
  botId: string | null
  botName: string
  /** Bot scopes Slack granted (the `x-oauth-scopes` header); the server warns about any the manifest asks for that are missing. */
  scopes: string[]
}

/** QR or pairing code, relayed by the server to the requesting member only and never stored (§2.5, §7.3 item 8). */
export type AuthFrame = { connectionId: string; qrPng?: string; pairingCode?: string; expiresAt: string }

export type ConversationItem = {
  conversationId: string
  /** WhatsApp: group | self. Slack (v4): channel (public) | private_channel; only channels the bot is a member of. */
  kind: 'group' | 'self' | 'channel' | 'private_channel'
  name: string
  size: number | null
  /** Admins-only group the number is not an admin of: the bridge falls back to `direction: in` (D28). */
  canSend: boolean
  reason: CannotSendReason | null
}

export type CannotSendReason = 'admins_only' | 'not_a_member'

/** The live group list for the picker: answered on request, never cached or written by the runtime (D28). */
export type ConversationsFrame = { requestId: string; connectionId: string; items: ConversationItem[] } | { requestId: string; connectionId: string; error: string }

/**
 * A connected conversation's posting ability changed (or was first learned). v4: a Slack rename carries `name`; an
 * archive, or the bot leaving or being removed, arrives as canSend false with reason 'not_a_member' and `archived` set
 * when Slack archived it.
 */
export type ConversationStateFrame = {
  connectionId: string
  conversationId: string
  canSend: boolean
  reason: CannotSendReason | null
  name?: string
  archived?: boolean
}

export type InboundFrame = {
  connectionId: string
  conversationId: string
  externalMessageId: string
  sender: SenderRef
  body: string
  kind: 'text' | 'media' | 'poll' | 'other'
  media: MediaRef[]
  replyTo: { externalMessageId: string; senderExternalId: string | null; media: MediaRef | null } | null
  /** JIDs as WhatsApp sent them (PN or LID, device part stripped); the number itself appears as one of StateFrame.self. */
  mentions: string[]
  reaction?: { externalMessageId: string; emoji: string } | null
  /** A vote on a poll this runtime sent. Decrypted when the runtime still holds the poll's secret, else passed sealed. */
  pollVote?: { pollMessageId: string; voterIds: string[]; selectedHashes?: string[]; sealed?: { encPayload: string; encIv: string } } | null
  /**
   * v4, native-thread providers: set on a thread REPLY, naming the thread's root message (Slack `thread_ts`). Absent or
   * null on a top-level message, whose own externalMessageId is the root of any thread it starts. A Slack thread reply
   * also fills `replyTo` with the root, so quote-based routing keeps working. Slack's own unfurl/attachment-only
   * `message_changed` events are not edits and never arrive.
   */
  thread?: { rootExternalMessageId: string } | null
  /**
   * v4: an edit of an earlier message (Slack `message_changed`). externalMessageId names the EDITED message, `body` and
   * `media` are its new content. The server updates its copy; an edit is never routed as a new turn.
   */
  edit?: { /** epoch SECONDS (Slack `edited.ts`, floored). */ editedAt: number } | null
  /**
   * v4: the message was deleted at the provider (Slack `message_deleted`). externalMessageId names it; body is ''. The
   * server tombstones its copy (Enterprise retention, design §2.3) and routes nothing.
   */
  deleted?: boolean
  /**
   * v4, Slack: a `/tm8 <command> <args>` slash command. The runtime normalises it to `body` = `/<command> <args>` (so the
   * server's existing command parser handles it exactly as a WhatsApp `/work`) and sets this. externalMessageId is
   * `cmd:<trigger_id>`, kind 'text'. Slash commands carry no thread, so the answer goes to the channel.
   */
  slashCommand?: { /** The slash command as Slack names it, e.g. '/tm8'. */ command: string; /** Everything after it, as typed. */ text: string } | null
  /** WhatsApp's messageTimestamp: epoch SECONDS. Slack: the ts, floored to seconds. */
  ts: number
}

/**
 * Settles an outbox row; authoritative. `message` is the sent proto.IMessage content as JSON (bytes as
 * {type:'Buffer',data:base64}), not the key: it holds media keys and a poll's messageSecret. The server keeps it
 * server-only and hands it back as QuoteRef.message to quote that message, or to open a sealed poll vote.
 * The runtime runs with emitOwnEvents off, so its own sends never come back as `inbound`.
 */
export type SentFrame =
  | { outboxId: string; connectionId: string; externalMessageId: string; message: unknown }
  /** v4: `retryAfterSec` is the provider's own backoff (Slack 429 `Retry-After`); the server waits at least that long. */
  | { outboxId: string; connectionId: string; failed: { reason: string; retryable: boolean; retryAfterSec?: number } }

/** Counts only, never content (D28). */
export type DropCounters = {
  /** Stanzas from off-list JIDs acked undecrypted (messages, receipts, notifications, presence). */
  stanzas: number
  /** Messages and poll updates that reached the socket from off the list and were dropped on their JID alone. */
  messages: number
  /** Outbound frames the guard refused. */
  outboundRefused: number
}

export type HeartbeatFrame = {
  runtimeId: string
  /** ISO-8601. */
  at: string
  connections: { connectionId: string; status: ConnectionStatus; dropped: DropCounters; allowlistVersion: number | null }[]
}

export type MediaFrame = { requestId: string; mime: string | null; data: string } | { requestId: string; error: string; tooLarge?: boolean }

/**
 * What happened to each person asked into a group (`group.create`, `group.add`). `invite_needed`: their privacy
 * settings refuse adds, so they need the group's invite link instead; `already`: in the group already.
 */
export type GroupMemberResult = { id: string; status: 'added' | 'already' | 'invite_needed' | 'failed' }

export type GroupCommunity = { id: string; name: string }

/** The answer to `group.create` / `group.add`. `community` is set on v2 creates; optional for adds and v1 runtimes. */
export type GroupFrame =
  | { requestId: string; connectionId: string; conversationId: string; subject: string; results: GroupMemberResult[]; inviteLink: string | null; community?: GroupCommunity | null }
  | { requestId: string; connectionId: string; error: string; code?: 'not_community_admin' | 'community_create_failed'; community?: GroupCommunity; createdConversationId?: string }

export type RuntimeRoute = 'hello' | 'state' | 'auth' | 'conversations' | 'conversation-state' | 'inbound' | 'sent' | 'heartbeat' | 'media' | 'group' | 'outbound-progress'

export type RuntimeFrames = {
  hello: HelloFrame
  state: StateFrame
  auth: AuthFrame
  conversations: ConversationsFrame
  'conversation-state': ConversationStateFrame
  inbound: InboundFrame
  sent: SentFrame
  heartbeat: HeartbeatFrame
  media: MediaFrame
  group: GroupFrame
  'outbound-progress': { outboxId: string; connectionId: string }
}

// ---------------------------------------------------------------------------------------------------------------
// server → runtime
// ---------------------------------------------------------------------------------------------------------------

/**
 * A connection's allowlist: its live, unpaused bridges' conversation ids (groups, or the number's own self chat).
 * Replaces the previous list whole. A version below the one held is stale and ignored on every path (push, `hello`
 * reply, `connect`), so `version` must only ever grow for a connection, across server restarts too (derive it from
 * the database, never from process memory). An empty list means nothing is read or sent.
 */
export type AllowlistFrame = { type: 'allowlist'; connectionId: string; version: number; conversationIds: string[] }

/**
 * What to quote. For a message this runtime sent, pass SentFrame.message back as `message`; for an inbound message pass
 * its `text` (the InboundFrame body). With neither, WhatsApp still threads the reply but shows an empty quote.
 */
export type QuoteRef = { externalMessageId: string; senderExternalId: string | null; fromMe: boolean; message?: unknown; text?: string }

/**
 * v4: the secret a token provider connects with, sent ONLY on `connect` from `bridges.connections.begin` (a paste).
 * The runtime checks it (`auth.test`), seals it under the connection's stateKey in its own state directory (D38, as
 * WhatsApp's device keys) and never echoes it in any frame or log. On a later `connect` or `hello` reply without a
 * credential, the runtime unseals what it holds; holding nothing, it answers `state logged_out` detail `no_credential`.
 * A `disconnect {logout: true}` deletes the sealed bytes.
 */
export type ConnectCredential = { kind: 'slack_tokens'; botToken: string; appToken: string }

/**
 * v4: how an outbound message is signed on a perUserVoice provider (Slack chat:write.customize): the author's display
 * name and icon replace the `Title (handle):` prefix. `iconUrl` must be a public https URL; null uses the app's icon.
 * Slack file uploads cannot carry a custom name or icon: a `send` with media posts the file as the app, and the
 * runtime posts the caption (if any) as a separate voiced message in the same thread.
 */
export type SendVoice = { username: string; iconUrl: string | null; iconEmoji?: string | null }

export type ServerFrame =
  | AllowlistFrame
  | { type: 'connect'; connectionId: string; stateKey: string; authFlow?: { kind: 'qr' } | { kind: 'pairing'; phone: string }; credential?: ConnectCredential; allowlist?: AllowlistFrame }
  | { type: 'disconnect'; connectionId: string; logout?: boolean }
  /**
   * v4 adds `threadTs` (native threads: post into the thread whose root is this message id; Slack `thread_ts`) and
   * `voice` (perUserVoice providers). Text is tm8 markdown; the Slack runtime converts it to mrkdwn and splits it at
   * about 3,500 characters, answering `sent` with the FIRST part's ts.
   */
  | { type: 'send'; outboxId: string; connectionId: string; conversationId: string; text?: string; media?: { kind: 'image' | 'document'; mime: string; fileName: string; caption: string; data?: string; fileEntityId?: string }; poll?: { name: string; values: string[]; selectableCount: number }; replyTo?: QuoteRef; threadTs?: string; voice?: SendVoice }
  | { type: 'react'; outboxId: string; connectionId: string; conversationId: string; target: QuoteRef; emoji: string }
  | { type: 'typing'; connectionId: string; conversationId: string; state: 'composing' | 'paused' }
  | { type: 'read'; connectionId: string; conversationId: string; messages: { externalMessageId: string; senderExternalId: string | null }[] }
  | { type: 'conversation.list'; requestId: string; connectionId: string }
  | { type: 'media.fetch'; requestId: string; connectionId: string; conversationId: string; handle: string; maxBytes: number }
  /**
   * Make a new group on the number with these people (JIDs) in it; the number is its admin. It is not on the allowlist
   * until the server connects it (a bridge), so nothing in it is read or sent before then. A source must be on the
   * allowlist; its community is followed only when the linked number is a community admin, otherwise refused.
   */
  | { type: 'group.create'; requestId: string; connectionId: string; subject: string; participants: string[]; sourceConversationId?: string }
  /** Add people to a connected group (the number must be its admin). */
  | { type: 'group.add'; requestId: string; connectionId: string; conversationId: string; participants: string[] }

export type ServerFrameType = ServerFrame['type']
