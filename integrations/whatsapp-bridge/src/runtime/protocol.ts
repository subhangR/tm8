// The connector protocol (BRIDGE-ENTITY-DESIGN §2.5, D35): the frames the WhatsApp runtime and tm8-server exchange.
// Runtime → server frames are POSTed to /v2/bridge-runtime/<route>; server → runtime frames arrive on one WebSocket.
// Every id here is the provider's: a conversation id is a WhatsApp JID (`…@g.us`, or the owner's own `…@s.whatsapp.net`
// for a self chat the owner connected), a message id is WhatsApp's key id.

export const PROTOCOL_VERSION = 1

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

export type ConnectionStatus = 'connecting' | 'linked' | 'logged_out' | 'offline'

export type SenderRef = {
  /** The sender's WhatsApp JID (PN or LID, whichever the group used). */
  externalId: string | null
  /** The other half of the PN/LID pair, when WhatsApp sent it. */
  altId: string | null
  /** The WhatsApp push name; display only, never matched on (§6). */
  name: string | null
  fromMe: boolean
}

export type MediaRef = {
  kind: 'image' | 'document' | 'video' | 'audio' | 'sticker'
  mime: string | null
  fileName: string | null
  caption: string | null
  size: number | null
  durationSec?: number | null
  ptt?: boolean
  /** Opaque, self-contained fetch handle for `media.fetch` (the message's media keys); valid across runtime restarts. */
  handle: string
}

// ---------------------------------------------------------------------------------------------------------------
// runtime → server
// ---------------------------------------------------------------------------------------------------------------

export type HelloFrame = { provider: 'whatsapp'; version: number; runtimeId: string; capabilities: typeof WHATSAPP_CAPABILITIES }

/** The server's answer to `hello`: the connections this runtime runs and each one's allowlist. */
export type HelloReply = { connections: { connectionId: string; stateKey: string; allowlist: AllowlistFrame }[] }

export type StateFrame = {
  connectionId: string
  status: ConnectionStatus
  detail: string | null
  /** The number's own JIDs once linked (PN and LID), so the server can offer the owner's self chat. */
  self?: { id: string | null; lid: string | null }
}

/** QR or pairing code, relayed by the server to the requesting member only and never stored (§2.5, §7.3 item 8). */
export type AuthFrame = { connectionId: string; qrPng?: string; pairingCode?: string; expiresAt: string }

export type ConversationItem = {
  conversationId: string
  kind: 'group' | 'self'
  name: string
  size: number | null
  /** Admins-only group the number is not an admin of: the bridge falls back to `direction: in` (D28). */
  canSend: boolean
  reason: CannotSendReason | null
}

export type CannotSendReason = 'admins_only' | 'not_a_member'

/** The live group list for the picker: answered on request, never cached or written by the runtime (D28). */
export type ConversationsFrame = { requestId: string; connectionId: string; items: ConversationItem[] } | { requestId: string; connectionId: string; error: string }

/** A connected conversation's posting ability changed (or was first learned). */
export type ConversationStateFrame = { connectionId: string; conversationId: string; canSend: boolean; reason: CannotSendReason | null }

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
  /** WhatsApp's messageTimestamp: epoch SECONDS. */
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
  | { outboxId: string; connectionId: string; failed: { reason: string; retryable: boolean } }

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

export type RuntimeRoute = 'hello' | 'state' | 'auth' | 'conversations' | 'conversation-state' | 'inbound' | 'sent' | 'heartbeat' | 'media'

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

export type ServerFrame =
  | AllowlistFrame
  | { type: 'connect'; connectionId: string; stateKey: string; authFlow?: { kind: 'qr' } | { kind: 'pairing'; phone: string }; allowlist?: AllowlistFrame }
  | { type: 'disconnect'; connectionId: string; logout?: boolean }
  | { type: 'send'; outboxId: string; connectionId: string; conversationId: string; text?: string; media?: { kind: 'image' | 'document'; mime: string; fileName: string; caption: string; data: string }; poll?: { name: string; values: string[]; selectableCount: number }; replyTo?: QuoteRef }
  | { type: 'react'; outboxId: string; connectionId: string; conversationId: string; target: QuoteRef; emoji: string }
  | { type: 'typing'; connectionId: string; conversationId: string; state: 'composing' | 'paused' }
  | { type: 'read'; connectionId: string; conversationId: string; messages: { externalMessageId: string; senderExternalId: string | null }[] }
  | { type: 'conversation.list'; requestId: string; connectionId: string }
  | { type: 'media.fetch'; requestId: string; connectionId: string; conversationId: string; handle: string; maxBytes: number }

export type ServerFrameType = ServerFrame['type']
