// Baileys adapter: one linked-device connection, feeding inbound messages to the bridge and sending only to channels.
import makeWASocket, {
  Browsers,
  BufferJSON,
  DisconnectReason,
  decryptPollVote,
  downloadMediaMessage,
  jidNormalizedUser,
  normalizeMessageContent,
  useMultiFileAuthState,
  type WAMessage,
  type WAMessageKey,
  type WASocket,
  proto,
} from '@whiskeysockets/baileys'
import { Boom } from '@hapi/boom'
import fs from 'node:fs'
import path from 'node:path'
import pino from 'pino'
import QRCode from 'qrcode'
import qrcodeTerminal from 'qrcode-terminal'
import type { Bridge, Inbound, WaKey, WaPort } from './core.js'
import { TooLargeError, mediaPlaceholder, type InboundMedia } from './media.js'
import { withBridgeMark } from './text.js'
import type { OutboxPoll } from './store.js'

// libsignal dumps whole sessions (including private keys) via console.info/log; keep them out of stdout.
for (const level of ['log', 'info'] as const) {
  const orig = console[level].bind(console)
  console[level] = (...a: unknown[]) => {
    if (typeof a[0] === 'string' && /^Closing (open )?session/.test(a[0])) return
    orig(...a)
  }
}

export function textOf(m: proto.IMessage | null | undefined): string {
  if (!m) return ''
  const inner = m.ephemeralMessage?.message ?? m.viewOnceMessage?.message ?? m.viewOnceMessageV2?.message ?? m.documentWithCaptionMessage?.message
  if (inner) return textOf(inner)
  if (m.conversation) return m.conversation
  if (m.extendedTextMessage?.text) return m.extendedTextMessage.text
  const media = mediaOf(m)
  if (media) return mediaPlaceholder(media.kind, media.caption, media.fileName, media)
  const poll = m.pollCreationMessage ?? m.pollCreationMessageV2 ?? m.pollCreationMessageV3
  if (poll) return `[poll] ${poll.name ?? ''}: ${(poll.options ?? []).map((o) => o.optionName).join(' / ')}`
  return `[${Object.keys(m).find((k) => k !== 'messageContextInfo') ?? 'unknown'}]`
}

export function unwrap(m: proto.IMessage): proto.IMessage {
  return m.ephemeralMessage?.message ?? m.viewOnceMessage?.message ?? m.viewOnceMessageV2?.message ?? m.documentWithCaptionMessage?.message ?? m
}

/** JSON that keeps protobuf bytes (media keys) intact: Buffers become {type: 'Buffer', data: base64}. */
export const toJsonSafe = <T>(v: T): T => JSON.parse(JSON.stringify(v, BufferJSON.replacer))
/**
 * Back to a protobuf message. Stored messages went through proto toJSON (bytes as base64 strings) or toJsonSafe; fromObject
 * turns either back into real bytes, which media downloads, re-upload requests and quoting need.
 */
const toProto = (v: unknown): proto.IMessage => proto.Message.fromObject(JSON.parse(JSON.stringify(v), BufferJSON.reviver))

const num = (v: unknown): number | null => {
  if (v === null || v === undefined) return null
  const n = Number(typeof v === 'object' ? String(v) : v)
  return Number.isFinite(n) ? n : null
}

/** The media in a message (already unwrapped or not), without the download reference. */
export function mediaOf(msg: proto.IMessage): Omit<InboundMedia, 'ref'> | null {
  const m = unwrap(msg)
  if (m.imageMessage) return { kind: 'image', mime: m.imageMessage.mimetype ?? null, fileName: null, caption: m.imageMessage.caption ?? null, size: num(m.imageMessage.fileLength) }
  if (m.videoMessage) return { kind: 'video', mime: m.videoMessage.mimetype ?? null, fileName: null, caption: m.videoMessage.caption ?? null, size: num(m.videoMessage.fileLength) }
  if (m.audioMessage) {
    const a = m.audioMessage
    return { kind: 'audio', mime: a.mimetype ?? null, fileName: null, caption: null, size: num(a.fileLength), durationSec: num(a.seconds), ptt: !!a.ptt }
  }
  if (m.documentMessage) {
    const d = m.documentMessage
    return { kind: 'document', mime: d.mimetype ?? null, fileName: d.fileName ?? d.title ?? null, caption: d.caption ?? null, size: num(d.fileLength) }
  }
  if (m.stickerMessage) return { kind: 'sticker', mime: m.stickerMessage.mimetype ?? null, fileName: null, caption: null, size: num(m.stickerMessage.fileLength) }
  return null
}

export function contextInfoOf(m: proto.IMessage): proto.IContextInfo | null | undefined {
  const u = unwrap(m)
  return (
    u.extendedTextMessage?.contextInfo ?? u.imageMessage?.contextInfo ?? u.videoMessage?.contextInfo ?? u.documentMessage?.contextInfo ??
    u.audioMessage?.contextInfo ?? u.stickerMessage?.contextInfo
  )
}

/** WhatsApp plumbing that carries no user content. */
export function isPlumbing(m: proto.IMessage): boolean {
  const keys = Object.keys(m).filter((k) => k !== 'messageContextInfo')
  if (keys.length === 0) return true
  if (m.protocolMessage || m.reactionMessage || m.pollUpdateMessage || m.keepInChatMessage) return true
  return keys.every((k) => k === 'senderKeyDistributionMessage')
}

export class WaConnection implements WaPort {
  private sock: WASocket | null = null
  private logger: pino.Logger
  private open = false
  private failures = 0

  constructor(
    private bridge: Bridge,
    private o: { authDir: string; dataDir: string; allowLink: boolean; listGroups?: boolean; pairingPhone?: string; logLevel?: string },
  ) {
    this.logger = pino({ level: o.logLevel ?? 'warn' })
  }

  connected() {
    return this.open && !!this.sock
  }

  private guard(jid: string) {
    if (!this.bridge.sendableJids().has(jid)) throw new Error(`refusing to send to unconfigured chat ${jid}`)
    if (!this.sock || !this.open) throw new Error('WhatsApp is not connected')
    return this.sock
  }

  async sendText(jid: string, text: string, quoted?: { key: WaKey; message: unknown }) {
    const sock = this.guard(jid)
    const sent = await sock.sendMessage(jid, { text: withBridgeMark(text) }, this.quoteOpt(quoted))
    if (!sent?.key.id) throw new Error('send returned no message id')
    return { id: sent.key.id, key: sent.key as WaKey, message: toJsonSafe(sent.message) }
  }

  async sendMedia(
    jid: string,
    m: { kind: 'image' | 'document'; data: Buffer; mime: string; fileName: string; caption: string },
    quoted?: { key: WaKey; message: unknown },
  ) {
    const sock = this.guard(jid)
    const content =
      m.kind === 'image'
        ? { image: m.data, mimetype: m.mime, caption: withBridgeMark(m.caption) }
        : { document: m.data, mimetype: m.mime, fileName: m.fileName, caption: withBridgeMark(m.caption) }
    const sent = await sock.sendMessage(jid, content, this.quoteOpt(quoted))
    if (!sent?.key.id) throw new Error('send returned no message id')
    return { id: sent.key.id, key: sent.key as WaKey, message: toJsonSafe(sent.message) }
  }

  async sendPoll(jid: string, poll: OutboxPoll) {
    const sock = this.guard(jid)
    const sent = await sock.sendMessage(jid, { poll: { name: withBridgeMark(poll.name), values: poll.values, selectableCount: poll.selectableCount } })
    if (!sent?.key.id) throw new Error('send returned no message id')
    // toJsonSafe keeps messageContextInfo.messageSecret (the vote key) as base64, so it survives in the outbox.
    return { id: sent.key.id, key: sent.key as WaKey, message: toJsonSafe(sent.message) }
  }

  /**
   * A vote on one of our polls. Baileys 7 no longer decrypts votes, so we do: the key is the poll's messageSecret (kept
   * in the outbox), signed with the poll's id, its creator and the voter. Groups may name either side by PN or LID, so
   * every pairing is tried; AES-GCM only opens with the right one.
   */
  private async onPollUpdate(msg: WAMessage, update: proto.Message.IPollUpdateMessage) {
    const pollKey = update.pollCreationMessageKey
    const chat = msg.key.remoteJid
    if (!pollKey?.id || !chat || !update.vote?.encPayload || !update.vote.encIv) return
    const chatJid = jidNormalizedUser(chat)
    if (!this.bridge.channelForJid(chatJid)) return
    const json = this.bridge.store.sentMessageJson(pollKey.id)
    if (!json) return // not a poll we sent
    const secretRaw = JSON.parse(json, BufferJSON.reviver)?.messageContextInfo?.messageSecret
    const secret = typeof secretRaw === 'string' ? Buffer.from(secretRaw, 'base64') : secretRaw
    if (!secret) return this.bridge.log(`[poll] ${pollKey.id}: no messageSecret stored, can't read votes`)
    const own = [...this.bridge.ownJids]
    const isGroup = chatJid.endsWith('@g.us')
    const voters = msg.key.fromMe
      ? own
      : [isGroup ? msg.key.participant : chat, isGroup ? msg.key.participantAlt : msg.key.remoteJidAlt].filter((j): j is string => !!j).map((j) => jidNormalizedUser(j))
    let selected: Uint8Array[] | null = null
    for (const creator of own) {
      for (const voter of voters) {
        try {
          selected = decryptPollVote(update.vote as { encPayload: Uint8Array; encIv: Uint8Array }, {
            pollEncKey: secret, pollCreatorJid: creator, pollMsgId: pollKey.id, voterJid: voter,
          }).selectedOptions ?? []
          break
        } catch {
          // wrong pairing: try the next
        }
      }
      if (selected) break
    }
    if (!selected) return this.bridge.log(`[poll] ${pollKey.id}: couldn't decrypt a vote from ${voters.join(' / ') || '?'}`)
    await this.bridge.forms.onPollVote({
      chatJid,
      pollId: pollKey.id,
      voterJids: voters,
      voterName: msg.pushName ?? null,
      hashes: selected.map((h) => Buffer.from(h).toString('hex')),
    })
  }

  /** Stored messages are JSON (bytes as base64); turn them back into protobuf-ready objects for quoting. */
  private quoteOpt(quoted?: { key: WaKey; message: unknown }) {
    return quoted ? { quoted: { key: quoted.key as WAMessageKey, message: toProto(quoted.message) } } : undefined
  }

  async downloadMedia(ref: string, maxBytes: number): Promise<Buffer> {
    const parsed = JSON.parse(ref, BufferJSON.reviver) as WAMessage
    const msg: WAMessage = { ...parsed, message: toProto(parsed.message) }
    const stream = await downloadMediaMessage(msg, 'stream', {}, {
      logger: this.logger,
      // Old media is gone from WhatsApp's CDN; ask the phone to re-upload it (needs the connection).
      reuploadRequest: (m) => (this.sock && this.open ? this.sock.updateMediaMessage(m) : Promise.reject(new Error('WhatsApp is not connected'))),
    })
    const chunks: Buffer[] = []
    let total = 0
    for await (const c of stream) {
      total += (c as Buffer).length
      if (total > maxBytes) {
        stream.destroy()
        throw new TooLargeError(total, maxBytes)
      }
      chunks.push(c as Buffer)
    }
    return Buffer.concat(chunks)
  }

  async react(jid: string, key: WaKey, emoji: string) {
    const sock = this.guard(jid)
    await sock.sendMessage(jid, { react: { text: emoji, key: key as WAMessageKey } })
  }

  async start(): Promise<void> {
    const { state, saveCreds } = await useMultiFileAuthState(this.o.authDir)
    if (!state.creds.registered && !this.o.allowLink) {
      this.bridge.waState = 'not_linked'
      this.bridge.log('[wa] auth/ holds no linked device; run with --link to pair (see OPERATIONS.md). Not connecting.')
      return
    }
    const sock = makeWASocket({
      auth: state,
      logger: this.logger,
      // Pairing codes are rejected for custom browser names, so present as a stock desktop browser.
      browser: Browsers.macOS('Chrome'),
      markOnlineOnConnect: false,
      syncFullHistory: false,
      getMessage: async (key: WAMessageKey) => {
        const json = key.id ? this.bridge.store.sentMessageJson(key.id) : null
        return json ? toProto(JSON.parse(json)) : undefined
      },
    })
    this.sock = sock
    sock.ev.on('creds.update', saveCreds)

    let pairingRequested = false
    sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
      if (qr && this.o.allowLink) {
        if (this.o.pairingPhone && !pairingRequested) {
          pairingRequested = true
          const code = await sock.requestPairingCode(this.o.pairingPhone.replace(/\D/g, ''))
          fs.writeFileSync(path.join(this.o.dataDir, 'pairing-code.txt'), code + '\n')
          console.log(`\n[${new Date().toISOString()}] Pairing code: ${code}  (WhatsApp > Linked devices > Link a device > Link with phone number)\n`)
        } else if (!this.o.pairingPhone) {
          await QRCode.toFile(path.join(this.o.dataDir, 'qr.png'), qr, { width: 512 })
          qrcodeTerminal.generate(qr, { small: true })
          console.log(`QR also saved to ${path.join(this.o.dataDir, 'qr.png')} (it rotates every ~20s)`)
        }
      }
      if (connection === 'open') {
        this.open = true
        this.failures = 0
        fs.rmSync(path.join(this.o.dataDir, 'qr.png'), { force: true })
        fs.rmSync(path.join(this.o.dataDir, 'pairing-code.txt'), { force: true })
        for (const j of [sock.user?.id, sock.user?.lid]) if (j) this.bridge.ownJids.add(jidNormalizedUser(j))
        this.bridge.waState = 'open'
        this.bridge.log(`[wa] connected as ${sock.user?.id} (${sock.user?.lid ?? 'no lid'})`)
        if (this.o.listGroups) {
          // Operator mode only (--list-groups): the one place group metadata is fetched.
          const groups = Object.values(await sock.groupFetchAllParticipating())
            .map((g) => ({ name: g.subject, jid: g.id, size: g.participants.length }))
            .sort((a, b) => a.name.localeCompare(b.name))
          fs.writeFileSync(path.join(this.o.dataDir, 'groups.json'), JSON.stringify(groups, null, 2) + '\n')
          for (const g of groups) console.log(`${g.jid}\t${g.size}\t${g.name}`)
          console.log(`[groups] ${groups.length} groups, written to data/groups.json`)
          setTimeout(() => process.exit(0), 2000)
          return
        }
        void this.bridge.flushQueue()
      }
      if (connection === 'close') {
        this.open = false
        if (this.sock === sock) this.sock = null
        const code = (lastDisconnect?.error as Boom | undefined)?.output?.statusCode
        if (!state.creds.registered) {
          // Linking timed out before pairing finished. Only in --link mode do we start over with fresh keys.
          this.bridge.waState = 'linking'
          this.bridge.log(`[wa] closed (${code}) before linking finished, issuing a new code`)
          // auth/ is a mounted volume: empty it, don't remove the directory itself (rmdir of a mount point fails).
          for (const f of fs.readdirSync(this.o.authDir)) fs.rmSync(path.join(this.o.authDir, f), { recursive: true, force: true })
          setTimeout(() => void this.start(), 1000)
          return
        }
        if (code === DisconnectReason.loggedOut) {
          // Don't crash-loop the container: stay up (API, history) and wait for an operator to re-link.
          this.bridge.waState = 'logged_out'
          this.bridge.log('[wa] LOGGED OUT by WhatsApp: the device must be re-linked (OPERATIONS.md › Re-link). Not reconnecting.')
          return
        }
        this.bridge.waState = 'reconnecting'
        this.failures++
        const delay = code === DisconnectReason.restartRequired ? 0 : Math.min(60_000, 3000 * this.failures)
        this.bridge.log(`[wa] closed (${code}), reconnecting in ${delay} ms`)
        setTimeout(() => void this.start().catch((e) => this.bridge.log(`[wa] start failed: ${e.message}`)), delay)
      }
    })

    sock.ev.on('messages.upsert', ({ messages }) => {
      if (this.o.allowLink || this.o.listGroups) return // operator modes never log or route
      for (const msg of messages) {
        const pollUpdate = msg.message ? normalizeMessageContent(msg.message)?.pollUpdateMessage : null
        if (pollUpdate) {
          void this.onPollUpdate(msg, pollUpdate).catch((e) => this.bridge.log(`[poll] ${msg.key.id}: ${(e as Error).stack ?? e}`))
          continue
        }
        const inbound = this.toInbound(msg)
        if (inbound) void this.bridge.onInbound(inbound).catch((e) => this.bridge.log(`[in] ${msg.key.id}: ${(e as Error).stack ?? e}`))
      }
    })
  }

  private toInbound(msg: WAMessage): Inbound | null {
    const chat = msg.key.remoteJid
    if (!chat || !msg.key.id || !msg.message || isPlumbing(msg.message)) return null
    const chatJid = jidNormalizedUser(chat)
    const chatAltJid = msg.key.remoteJidAlt ? jidNormalizedUser(msg.key.remoteJidAlt) : null
    // Drop unconfigured chats before reading anything else.
    if (!this.bridge.channelForJid(chatJid) && !this.bridge.channelForJid(chatAltJid)) return null
    const fromMe = !!msg.key.fromMe
    const own = [...this.bridge.ownJids]
    const isGroup = chatJid.endsWith('@g.us')
    const senderJid = fromMe ? (own.find((j) => j.endsWith('@s.whatsapp.net')) ?? own[0] ?? null) : isGroup ? (msg.key.participant ?? null) : chatJid
    const senderAltJid = fromMe ? (own.find((j) => j.endsWith('@lid')) ?? null) : isGroup ? (msg.key.participantAlt ?? null) : chatAltJid
    const u = unwrap(msg.message)
    const ci = contextInfoOf(msg.message)
    const media = mediaOf(msg.message)
    // A reply carries the quoted message's content, media keys included, so quoted media can be fetched even if it was
    // never logged (sent before the bridge ran) or its stored reference went stale.
    const quotedMedia = ci?.stanzaId && ci.quotedMessage ? mediaOf(ci.quotedMessage) : null
    const quotedParticipant = ci?.participant ? jidNormalizedUser(ci.participant) : null
    const quotedKey = { remoteJid: msg.key.remoteJid, id: ci?.stanzaId, fromMe: !!quotedParticipant && own.includes(quotedParticipant), participant: isGroup ? ci?.participant : undefined }
    return {
      id: msg.key.id,
      chatJid,
      chatAltJid,
      fromMe,
      senderJid: senderJid ? jidNormalizedUser(senderJid) : null,
      senderAltJid: senderAltJid ? jidNormalizedUser(senderAltJid) : null,
      senderName: msg.pushName ?? null,
      text: textOf(msg.message),
      kind: u.conversation || u.extendedTextMessage?.text ? 'text' : 'media',
      // The whole message (keys as base64) is the download reference, so a failed download can be retried later.
      media: media ? { ...media, ref: JSON.stringify({ key: msg.key, message: msg.message }, BufferJSON.replacer) } : null,
      quotedId: ci?.stanzaId ?? null,
      quotedMedia: quotedMedia ? { ...quotedMedia, ref: JSON.stringify({ key: quotedKey, message: ci!.quotedMessage }, BufferJSON.replacer) } : null,
      quotedSenderJid: quotedParticipant,
      mentionedJids: (ci?.mentionedJid ?? []).map((j) => jidNormalizedUser(j)),
      ts: Number(msg.messageTimestamp ?? 0),
      key: { remoteJid: msg.key.remoteJid, id: msg.key.id, fromMe: msg.key.fromMe, participant: msg.key.participant },
      message: toJsonSafe(msg.message),
    }
  }
}
