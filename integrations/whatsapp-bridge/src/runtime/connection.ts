// One linked WhatsApp number on the runtime: its Baileys socket, its allowlist, and nothing stored but sealed keys.
// Inbound: a stanza from a conversation off the allowlist is acked undecrypted (Baileys' shouldIgnoreJid), and anything
// that still reaches `messages.upsert` from off the list is dropped before a single field past its JID is read.
// Outbound: every frame that touches a conversation goes through `allowlist.check` first (D28).
import makeWASocket, {
  Browsers,
  BufferJSON,
  DisconnectReason,
  decryptPollVote,
  downloadMediaMessage,
  jidNormalizedUser,
  normalizeMessageContent,
  proto,
  type GroupMetadata,
  type UserFacingSocketConfig,
  type WAMessage,
  type WAMessageKey,
  type WASocket,
} from '@whiskeysockets/baileys'
import type { Boom } from '@hapi/boom'
import pino from 'pino'
import QRCode from 'qrcode'
import { TooLargeError } from '../media.js'
import { withBridgeMark } from '../text.js'
import { contextInfoOf, isPlumbing, mediaOf, textOf, toJsonSafe, unwrap } from '../wa.js'
import { Allowlist, OutboundRefused, bareJid, type OutboundKind } from './allowlist.js'
import type {
  CannotSendReason,
  ConnectionStatus,
  ConversationItem,
  InboundFrame,
  MediaRef,
  QuoteRef,
  RuntimeFrames,
  RuntimeRoute,
  ServerFrame,
} from './protocol.js'
import { useSealedAuthState } from './sealed-auth.js'

export type Emit = <R extends RuntimeRoute>(route: R, frame: RuntimeFrames[R]) => Promise<unknown>

/** The slice of a Baileys socket the runtime uses; tests hand in a fake. */
export type WaSocketLike = Pick<
  WASocket,
  'ev' | 'user' | 'sendMessage' | 'sendPresenceUpdate' | 'readMessages' | 'groupMetadata' | 'groupFetchAllParticipating' | 'requestPairingCode' | 'logout' | 'end' | 'updateMediaMessage'
>
export type SocketFactory = (config: UserFacingSocketConfig) => WaSocketLike

/** Our own recent sends: Baileys' getMessage (retries) and poll vote keys. Memory only, bounded. */
const SENT_CAP = 1000
const LINK_ATTEMPTS = 5

type AuthFlow = Extract<ServerFrame, { type: 'connect' }>['authFlow']

export class RuntimeConnection {
  readonly allowlist = new Allowlist()
  status: ConnectionStatus = 'connecting'
  private sock: WaSocketLike | null = null
  private open = false
  private failures = 0
  private linkAttempts = 0
  private stopped = false
  private sent = new Map<string, proto.IMessage>()
  private logger: pino.Logger

  constructor(
    readonly connectionId: string,
    private o: {
      authDir: string
      stateKey: Buffer
      emit: Emit
      log: (m: string) => void
      authFlow?: AuthFlow
      socketFactory?: SocketFactory
      logLevel?: string
    },
  ) {
    this.logger = pino({ level: o.logLevel ?? 'warn' })
  }

  connected() {
    return this.open && !!this.sock
  }

  private setStatus(status: ConnectionStatus, detail: string | null = null) {
    this.status = status
    const self = this.sock?.user ? { id: this.sock.user.id ? jidNormalizedUser(this.sock.user.id) : null, lid: this.sock.user.lid ? jidNormalizedUser(this.sock.user.lid) : null } : undefined
    void this.o.emit('state', { connectionId: this.connectionId, status, detail, ...(status === 'linked' && self ? { self } : {}) }).catch(() => {})
  }

  /** Server-pushed allowlist. Groups that joined the list get their posting ability checked. */
  applyAllowlist(frame: { version: number; conversationIds: string[] }, force = false) {
    const r = this.allowlist.apply(frame, force)
    if (r.applied && this.connected()) for (const id of r.added) void this.refreshCanSend(id)
    return r
  }

  async start(): Promise<void> {
    this.stopped = false
    const { state, saveCreds, wipe } = await useSealedAuthState(this.o.authDir, this.o.stateKey)
    if (!state.creds.registered && !this.o.authFlow) {
      this.setStatus('logged_out', 'not linked')
      return
    }
    const factory = this.o.socketFactory ?? ((c: UserFacingSocketConfig) => makeWASocket(c))
    const sock = factory({
      auth: state,
      logger: this.logger,
      browser: Browsers.macOS('Chrome'),
      // No presence, no history: the device announces nothing and pulls no other chat's backlog (D28).
      markOnlineOnConnect: false,
      syncFullHistory: false,
      shouldSyncHistoryMessage: () => false,
      shouldIgnoreJid: this.allowlist.shouldIgnore,
      // Our own sends settle through `sent`; they are never echoed back as inbound.
      emitOwnEvents: false,
      getMessage: async (key: WAMessageKey) => (key.id ? this.sent.get(key.id) : undefined),
    })
    this.sock = sock
    this.setStatus('connecting')
    sock.ev.on('creds.update', saveCreds)

    let pairingRequested = false
    sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
      if (qr && this.o.authFlow && !state.creds.registered) {
        try {
          if (this.o.authFlow.kind === 'pairing') {
            if (!pairingRequested) {
              pairingRequested = true
              const code = await sock.requestPairingCode(this.o.authFlow.phone.replace(/\D/g, ''))
              await this.o.emit('auth', { connectionId: this.connectionId, pairingCode: code, expiresAt: new Date(Date.now() + 180_000).toISOString() })
            }
          } else {
            const png = await QRCode.toBuffer(qr, { width: 512 })
            await this.o.emit('auth', { connectionId: this.connectionId, qrPng: png.toString('base64'), expiresAt: new Date(Date.now() + 20_000).toISOString() })
          }
        } catch (e) {
          this.o.log(`[wa ${this.connectionId}] auth frame failed: ${(e as Error).message}`)
        }
      }
      if (connection === 'open') {
        this.open = true
        this.failures = 0
        this.linkAttempts = 0
        this.o.authFlow = undefined
        for (const j of [sock.user?.id, sock.user?.lid]) if (j) this.allowlist.own.add(bareJid(jidNormalizedUser(j)))
        this.setStatus('linked')
        this.o.log(`[wa ${this.connectionId}] linked`)
        for (const id of this.allowlist.conversationIds()) void this.refreshCanSend(id)
      }
      if (connection === 'close') {
        this.open = false
        if (this.sock === sock) this.sock = null
        if (this.stopped) return
        const code = (lastDisconnect?.error as Boom | undefined)?.output?.statusCode
        if (!state.creds.registered) {
          // Linking timed out before the phone finished. Start over with fresh keys, a bounded number of times.
          await wipe()
          if (++this.linkAttempts >= LINK_ATTEMPTS || !this.o.authFlow) {
            this.o.authFlow = undefined
            this.setStatus('logged_out', 'linking timed out')
            return
          }
          setTimeout(() => void this.start().catch((e) => this.o.log(`[wa ${this.connectionId}] start failed: ${e.message}`)), 1000)
          return
        }
        if (code === DisconnectReason.loggedOut) {
          await wipe()
          this.setStatus('logged_out', 'logged out by WhatsApp: link the number again')
          return
        }
        this.failures++
        const delay = code === DisconnectReason.restartRequired ? 0 : Math.min(60_000, 3000 * this.failures)
        this.setStatus('offline', `reconnecting in ${Math.round(delay / 1000)} s`)
        setTimeout(() => void this.start().catch((e) => this.o.log(`[wa ${this.connectionId}] start failed: ${e.message}`)), delay)
      }
    })

    sock.ev.on('messages.upsert', ({ messages }) => {
      for (const msg of messages) void this.onUpsert(msg).catch((e) => this.o.log(`[wa ${this.connectionId}] inbound failed: ${(e as Error).message}`))
    })
    // Posting rights change when an admin flips "only admins can send" or promotes/demotes the number. Events for
    // groups off the list never arrive (their stanzas are ignored), and are skipped here regardless.
    sock.ev.on('groups.update', (updates) => {
      for (const u of updates) if (u.id && this.allowlist.allows(u.id) && ('announce' in u || 'restrict' in u)) void this.refreshCanSend(u.id)
    })
    sock.ev.on('group-participants.update', ({ id, participants }) => {
      if (!this.allowlist.allows(id)) return
      const ids = participants.flatMap((p) => (typeof p === 'string' ? [p] : [p.id, p.lid, p.phoneNumber])).filter((j): j is string => !!j)
      if (ids.some((j) => this.allowlist.isOwn(j))) void this.refreshCanSend(id)
    })
  }

  async stop(o: { logout?: boolean } = {}) {
    this.stopped = true
    const sock = this.sock
    this.open = false
    this.sock = null
    if (!sock) return
    if (o.logout) {
      await sock.logout().catch(() => {})
      const { wipe } = await useSealedAuthState(this.o.authDir, this.o.stateKey)
      await wipe()
      this.setStatus('logged_out', 'removed')
    } else {
      sock.end(undefined)
      this.setStatus('offline', 'disconnected by the server')
    }
  }

  // ------------------------------------------------------------------------------------------------------------
  // inbound
  // ------------------------------------------------------------------------------------------------------------

  /** The first thing done with any message: is its conversation connected? If not, count it and stop (D28). */
  async onUpsert(msg: WAMessage): Promise<void> {
    const chat = msg.key.remoteJid
    if (!chat || !this.allowlist.allows(chat, msg.key.remoteJidAlt)) {
      const isPollUpdate = !!msg.message?.pollUpdateMessage || !!msg.message?.ephemeralMessage?.message?.pollUpdateMessage
      if (isPollUpdate) this.allowlist.dropped.pollUpdates++
      else this.allowlist.dropped.messages++
      return
    }
    const frame = this.toInbound(msg)
    if (frame) await this.o.emit('inbound', frame)
  }

  toInbound(msg: WAMessage): InboundFrame | null {
    if (!msg.key.id || !msg.key.remoteJid || !msg.message) return null
    const chatJid = jidNormalizedUser(msg.key.remoteJid)
    const conversationId = this.allowlist.allows(chatJid) ? chatJid : jidNormalizedUser(msg.key.remoteJidAlt ?? chatJid)
    const isGroup = chatJid.endsWith('@g.us')
    const fromMe = !!msg.key.fromMe
    const own = [...this.allowlist.own]
    const senderId = fromMe ? (own.find((j) => j.endsWith('@s.whatsapp.net')) ?? own[0] ?? null) : isGroup ? (msg.key.participant ?? null) : chatJid
    const senderAlt = fromMe ? (own.find((j) => j.endsWith('@lid')) ?? null) : isGroup ? (msg.key.participantAlt ?? null) : (msg.key.remoteJidAlt ?? null)
    const base = {
      connectionId: this.connectionId,
      conversationId,
      externalMessageId: msg.key.id,
      sender: { externalId: senderId ? jidNormalizedUser(senderId) : null, altId: senderAlt ? jidNormalizedUser(senderAlt) : null, name: msg.pushName ?? null, fromMe },
      ts: Number(msg.messageTimestamp ?? 0),
      media: [] as MediaRef[],
      replyTo: null,
      mentions: [] as string[],
    }
    const content = normalizeMessageContent(msg.message)
    if (content?.reactionMessage) {
      const r = content.reactionMessage
      if (!r.key?.id) return null
      return { ...base, body: r.text ?? '', kind: 'other', reaction: { externalMessageId: r.key.id, emoji: r.text ?? '' } }
    }
    if (content?.pollUpdateMessage) {
      const vote = this.pollVote(msg, content.pollUpdateMessage, isGroup)
      return vote ? { ...base, body: '', kind: 'poll', pollVote: vote } : null
    }
    if (isPlumbing(msg.message)) return null
    const u = unwrap(msg.message)
    const ci = contextInfoOf(msg.message)
    const media = mediaOf(msg.message)
    const quotedMedia = ci?.stanzaId && ci.quotedMessage ? mediaOf(ci.quotedMessage) : null
    const quotedParticipant = ci?.participant ? jidNormalizedUser(ci.participant) : null
    const quotedKey = { remoteJid: msg.key.remoteJid, id: ci?.stanzaId, fromMe: !!quotedParticipant && this.allowlist.isOwn(quotedParticipant), participant: isGroup ? ci?.participant : undefined }
    const poll = u.pollCreationMessage ?? u.pollCreationMessageV2 ?? u.pollCreationMessageV3
    return {
      ...base,
      body: textOf(msg.message),
      kind: u.conversation || u.extendedTextMessage?.text ? 'text' : media ? 'media' : poll ? 'poll' : 'other',
      media: media ? [{ ...media, handle: mediaHandle(msg.key, msg.message) }] : [],
      replyTo: ci?.stanzaId
        ? { externalMessageId: ci.stanzaId, senderExternalId: quotedParticipant, media: quotedMedia ? { ...quotedMedia, handle: mediaHandle(quotedKey, ci.quotedMessage!) } : null }
        : null,
      mentions: (ci?.mentionedJid ?? []).map((j) => jidNormalizedUser(j)),
    }
  }

  /**
   * A vote on a poll. Baileys 7 leaves votes encrypted; the key is the poll's messageSecret. When this runtime sent the
   * poll and still holds it, the vote is opened here (every PN/LID pairing is tried, AES-GCM opens only with the right
   * one); otherwise it goes to the server sealed, with the server's stored copy of the poll as the key.
   */
  private pollVote(msg: WAMessage, update: proto.Message.IPollUpdateMessage, isGroup: boolean): InboundFrame['pollVote'] {
    const pollId = update.pollCreationMessageKey?.id
    if (!pollId || !update.vote?.encPayload || !update.vote.encIv) return null
    const chat = msg.key.remoteJid!
    const own = [...this.allowlist.own]
    const voters = msg.key.fromMe
      ? own
      : [isGroup ? msg.key.participant : chat, isGroup ? msg.key.participantAlt : msg.key.remoteJidAlt].filter((j): j is string => !!j).map((j) => jidNormalizedUser(j))
    const sealed = { encPayload: Buffer.from(update.vote.encPayload).toString('base64'), encIv: Buffer.from(update.vote.encIv).toString('base64') }
    const secret = this.sent.get(pollId)?.messageContextInfo?.messageSecret
    if (!secret) return { pollMessageId: pollId, voterIds: voters, sealed }
    for (const creator of own) {
      for (const voter of voters) {
        try {
          const selected = decryptPollVote(update.vote as { encPayload: Uint8Array; encIv: Uint8Array }, {
            pollEncKey: secret, pollCreatorJid: creator, pollMsgId: pollId, voterJid: voter,
          }).selectedOptions ?? []
          return { pollMessageId: pollId, voterIds: voters, selectedHashes: selected.map((h) => Buffer.from(h).toString('hex')) }
        } catch {
          // wrong pairing: try the next
        }
      }
    }
    return { pollMessageId: pollId, voterIds: voters, sealed }
  }

  // ------------------------------------------------------------------------------------------------------------
  // outbound: every path starts with the guard
  // ------------------------------------------------------------------------------------------------------------

  private guard(conversationId: string, kind: OutboundKind): WaSocketLike {
    this.allowlist.check(conversationId, kind)
    if (!this.sock || !this.open) throw new Error('WhatsApp is not connected')
    return this.sock
  }

  private remember(id: string, message: proto.IMessage | null | undefined) {
    if (!message) return
    this.sent.set(id, message)
    while (this.sent.size > SENT_CAP) this.sent.delete(this.sent.keys().next().value!)
  }

  async send(f: Extract<ServerFrame, { type: 'send' }>): Promise<{ externalMessageId: string; message: unknown }> {
    const kind: OutboundKind = f.poll ? 'poll' : f.media ? 'media' : 'text'
    const sock = this.guard(f.conversationId, kind)
    const quoted = f.replyTo ? { quoted: quoteOf(f.conversationId, f.replyTo) } : undefined
    const content = f.poll
      ? { poll: { name: withBridgeMark(f.poll.name), values: f.poll.values, selectableCount: f.poll.selectableCount } }
      : f.media
        ? f.media.kind === 'image'
          ? { image: Buffer.from(f.media.data, 'base64'), mimetype: f.media.mime, caption: withBridgeMark(f.media.caption) }
          : { document: Buffer.from(f.media.data, 'base64'), mimetype: f.media.mime, fileName: f.media.fileName, caption: withBridgeMark(f.media.caption) }
        : { text: withBridgeMark(f.text ?? '') }
    const sent = await sock.sendMessage(f.conversationId, content, f.poll ? undefined : quoted)
    if (!sent?.key.id) throw new Error('send returned no message id')
    this.remember(sent.key.id, sent.message)
    // toJsonSafe keeps a poll's messageSecret (the vote key) as base64, so the server's copy can open votes later.
    return { externalMessageId: sent.key.id, message: toJsonSafe(sent.message) }
  }

  async react(f: Extract<ServerFrame, { type: 'react' }>): Promise<{ externalMessageId: string; message: unknown }> {
    const sock = this.guard(f.conversationId, 'reaction')
    const sent = await sock.sendMessage(f.conversationId, { react: { text: f.emoji, key: keyOf(f.conversationId, f.target) } })
    if (!sent?.key.id) throw new Error('react returned no message id')
    return { externalMessageId: sent.key.id, message: toJsonSafe(sent.message) }
  }

  async typing(f: Extract<ServerFrame, { type: 'typing' }>) {
    await this.guard(f.conversationId, 'typing').sendPresenceUpdate(f.state, f.conversationId)
  }

  async read(f: Extract<ServerFrame, { type: 'read' }>) {
    const sock = this.guard(f.conversationId, 'read')
    await sock.readMessages(f.messages.map((m) => ({ remoteJid: f.conversationId, id: m.externalMessageId, participant: m.senderExternalId ?? undefined, fromMe: false })))
  }

  /** Media bytes for a handle this runtime issued, only from a connected conversation. */
  async fetchMedia(f: Extract<ServerFrame, { type: 'media.fetch' }>): Promise<{ mime: string | null; data: Buffer }> {
    this.guard(f.conversationId, 'media.fetch')
    const parsed = JSON.parse(Buffer.from(f.handle, 'base64url').toString('utf8'), BufferJSON.reviver) as WAMessage
    // A handle names its own chat; one forged to point elsewhere is refused like any other off-list frame.
    if (!parsed.key?.remoteJid || !this.allowlist.allows(parsed.key.remoteJid) || bareJid(jidNormalizedUser(parsed.key.remoteJid)) !== bareJid(f.conversationId)) {
      this.allowlist.dropped.outboundRefused++
      throw new OutboundRefused('not_connected', parsed.key?.remoteJid ?? '?', 'media.fetch')
    }
    const message = proto.Message.fromObject(parsed.message ?? {})
    const stream = await downloadMediaMessage({ ...parsed, message }, 'stream', {}, {
      logger: this.logger,
      reuploadRequest: (m) => (this.sock && this.open ? this.sock.updateMediaMessage(m) : Promise.reject(new Error('WhatsApp is not connected'))),
    })
    const chunks: Buffer[] = []
    let total = 0
    for await (const c of stream) {
      total += (c as Buffer).length
      if (total > f.maxBytes) {
        stream.destroy()
        throw new TooLargeError(total, f.maxBytes)
      }
      chunks.push(c as Buffer)
    }
    return { mime: mediaOf(message)?.mime ?? null, data: Buffer.concat(chunks) }
  }

  // ------------------------------------------------------------------------------------------------------------
  // groups: the live picker list and posting rights
  // ------------------------------------------------------------------------------------------------------------

  /** The picker's list, fetched live and handed back; never cached or written (D28). Communities are out of scope. */
  async listConversations(): Promise<ConversationItem[]> {
    if (!this.sock || !this.open) throw new Error('WhatsApp is not connected')
    const groups = Object.values(await this.sock.groupFetchAllParticipating())
      .filter((g) => !g.isCommunity && !g.isCommunityAnnounce)
      .map((g): ConversationItem => {
        const reason = this.cannotSend(g)
        return { conversationId: g.id, kind: 'group', name: g.subject, size: g.participants.length, canSend: !reason, reason }
      })
      .sort((a, b) => a.name.localeCompare(b.name))
    const self = [...this.allowlist.own].find((j) => j.endsWith('@s.whatsapp.net'))
    return self ? [{ conversationId: self, kind: 'self', name: 'Self chat (messages to yourself)', size: 1, canSend: true, reason: null }, ...groups] : groups
  }

  cannotSend(meta: Pick<GroupMetadata, 'announce' | 'participants'>): CannotSendReason | null {
    const me = meta.participants.find((p) => [p.id, p.lid, p.phoneNumber].some((j) => !!j && this.allowlist.isOwn(j)))
    if (!me) return 'not_a_member'
    if (meta.announce && !me.admin) return 'admins_only'
    return null
  }

  /** Learns whether the number may post in a connected group and tells the server when that changes. */
  async refreshCanSend(conversationId: string): Promise<void> {
    if (!conversationId.endsWith('@g.us') || !this.sock || !this.open || !this.allowlist.allows(conversationId)) return
    try {
      const reason = this.cannotSend(await this.sock.groupMetadata(conversationId))
      if (this.allowlist.setCanSend(conversationId, reason)) {
        await this.o.emit('conversation-state', { connectionId: this.connectionId, conversationId, canSend: !reason, reason })
      }
    } catch (e) {
      this.o.log(`[wa ${this.connectionId}] group metadata for a connected group failed: ${(e as Error).message}`)
    }
  }
}

/** A self-contained media fetch handle: the message key and content (media keys as base64), base64url. */
export function mediaHandle(key: Partial<WAMessageKey>, message: proto.IMessage): string {
  return Buffer.from(JSON.stringify({ key, message }, BufferJSON.replacer)).toString('base64url')
}

function keyOf(conversationId: string, q: QuoteRef): WAMessageKey {
  return { remoteJid: conversationId, id: q.externalMessageId, fromMe: q.fromMe, participant: conversationId.endsWith('@g.us') ? (q.senderExternalId ?? undefined) : undefined }
}

function quoteOf(conversationId: string, q: QuoteRef): WAMessage {
  const message = q.message
    ? proto.Message.fromObject(JSON.parse(JSON.stringify(q.message), BufferJSON.reviver))
    : proto.Message.fromObject({ conversation: q.text ?? '' })
  return { key: keyOf(conversationId, q), message }
}
