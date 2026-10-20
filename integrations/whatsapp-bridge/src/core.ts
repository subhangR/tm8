// Bridge core: inbound routing, name registry + tm8 poller, speaker-token API, outbox, watchdog.
// WhatsApp and tm8 are injected ports, so all of this runs in tests without either.
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { allowedSenders, channelTm8, trustedSenders, type ChannelConfig, type Config } from './config.js'
import {
  IMAGE_MIMES,
  MAX_IMAGE_BYTES,
  MIME_RE,
  MediaDir,
  TooLargeError,
  audioLabel,
  durationLabel,
  extFor,
  humanSize,
  isAudio,
  mediaPlaceholder,
  mimeFromName,
  safeFileName,
  sniffMime,
  stableUuid,
  type InboundMedia,
  type MediaKind,
} from './media.js'
import type { MediaRow, MessageRow, NameRow, OutboxMedia, OutboxPoll, OutboxRow, Store } from './store.js'
import { Forms } from './forms.js'
import type { ChatMessage, EntityContext, Teammate, Tm8Factory, Tm8Port } from './tm8.js'
import {
  MAIN_PREFIX,
  RESERVED,
  RateLimiter,
  bodyHash,
  cleanLabel,
  envelopeWaId,
  finalTurnText,
  generateName,
  hashToken,
  looksSecret,
  matchTeammate,
  newToken,
  parseCommand,
  parseMentions,
  shortTitle,
  speakerLine,
  titled,
  whatsappText,
  type Command,
} from './text.js'
import { briefMainChat, briefSession, envelope, rebriefTokenFile } from './briefing.js'
import { readTokenFile, tokenFilePath, writeTokenFile } from './tokens.js'
import { NoneTranscriber, TooLongError, transcribeTimeoutMs, type Transcriber } from './transcribe.js'

export type WaKey = { remoteJid?: string | null; id?: string | null; fromMe?: boolean | null; participant?: string | null }

export interface WaPort {
  connected(): boolean
  /** Only ever called with a configured channel JID; the adapter refuses anything else too. */
  sendText(jid: string, text: string, quoted?: { key: WaKey; message: unknown }): Promise<{ id: string; key: WaKey; message: unknown }>
  react(jid: string, key: WaKey, emoji: string): Promise<void>
  /** Send an image or document. `message` comes back JSON-safe (buffers as {type: 'Buffer', data: base64}). */
  sendMedia(
    jid: string,
    m: { kind: 'image' | 'document'; data: Buffer; mime: string; fileName: string; caption: string },
    quoted?: { key: WaKey; message: unknown },
  ): Promise<{ id: string; key: WaKey; message: unknown }>
  /** Download inbound media from its reference (InboundMedia.ref); throws TooLargeError past maxBytes. */
  downloadMedia(ref: string, maxBytes: number): Promise<Buffer>
  /** Send a native poll. `message` must keep messageContextInfo.messageSecret: votes are decrypted with it. */
  sendPoll(jid: string, poll: OutboxPoll): Promise<{ id: string; key: WaKey; message: unknown }>
}

/** Body of POST /say-media after HTTP parsing: a multipart file, or a tm8 file id to forward. */
export type SayMediaInput = {
  file?: { data: Buffer; fileName: string | null; mime: string | null }
  tm8_file_id?: unknown
  caption?: unknown
  reply_to?: unknown
  idempotency_key?: unknown
  kind?: unknown
  mime?: unknown
  file_name?: unknown
  label?: unknown
}

export type Inbound = {
  id: string
  chatJid: string
  chatAltJid?: string | null
  fromMe: boolean
  senderJid: string | null
  senderAltJid: string | null
  senderName: string | null
  /** Message text; for media the placeholder (`[image] caption`, see mediaPlaceholder). Mentions in captions route. */
  text: string
  kind: 'text' | 'media'
  /** Images, documents, video, audio, stickers: downloaded to data/media and attached when routed. */
  media?: InboundMedia | null
  quotedId: string | null
  /** The quoted message's media as the reply carries it (keys included), so it can be fetched even if never logged. */
  quotedMedia?: InboundMedia | null
  quotedSenderJid?: string | null
  mentionedJids: string[]
  /** Unix seconds. */
  ts: number
  key: WaKey
  message: unknown
}

/** An operation tm8 refuses through a space link (chat start, file upload): not retried. */
export class LinkRefused extends Error {}

export class HttpError extends Error {
  constructor(public status: number, message: string, public extra: Record<string, unknown> = {}) {
    super(message)
  }
}

type Target = { name: NameRow; notes: string[] }
type PollStatus = { at: number | null; ok: boolean; error: string | null }
/** One tm8 client per (space, token file); channels in the same space with the same token share it. */
type Tm8Client = {
  key: string
  spaceId: string
  tokenFile: string
  port: Tm8Port
  /** The global token with another space's id: calls go through a space link, which refuses chat start and file upload. */
  viaLink: boolean
  teammates: { at: number; list: Teammate[] }
  waitingForToken: boolean
}
/** Token expiry, per token file. */
type Expiry = { expiresAt: number | null; checkedAt: number; fingerprint: string | null; warnedAt: number }
type Log = (msg: string) => void

const ENDED_STATUSES = new Set(['exited', 'failed', 'completed', 'stopped', 'cancelled', 'canceled', 'killed', 'lost', 'terminated', 'exited_clean'])
const BRIDGE = 'bridge'
export const TEST_PREFIX = 'TEST-'
/** An echo of a send still in flight is matched by its exact body only this long after the send started. */
export const PENDING_ECHO_MS = 60_000

/** How a name is shown in WhatsApp text and command replies: `Title (handle)`. */
export function displayName(n: Pick<NameRow, 'name' | 'kind' | 'title'>): string {
  return titled(n.title ?? (n.kind === 'chat' ? 'Main chat' : null), n.name)
}

/** The default title for a session: its (first) task's title, else the session title, cut to ≤4 words. */
export function defaultTitle(ctx: Pick<EntityContext, 'title' | 'tasks'>): string | null {
  return shortTitle(ctx.tasks?.find((t) => t.title)?.title) ?? shortTitle(ctx.title)
}

export class Bridge {
  private tokenLimiter: RateLimiter
  private channelLimiter: RateLimiter
  private clients = new Map<string, Tm8Client>()
  private makeTm8: Tm8Factory
  private expiry = new Map<string, Expiry>()
  /** Last poll per channel (a channel whose space fails doesn't hold up the others). */
  private channelPoll = new Map<string, PollStatus>()
  private sendChain: Promise<unknown> = Promise.resolve()
  private sendAttempts = new Map<number, number>()
  private notConfiguredAt = new Map<string, number>()
  private polling: Promise<void> | null = null
  /** Fallback relay: the main chat's turn signature at its last message fetch, per chat. */
  private relayChecked = new Map<string, { sig: string; at: number }>()
  private ensuring = new Map<string, Promise<void>>()
  /** Sends in flight (registered before sendText, removed once the outbox has the wa_msg_id). */
  private pendingSends: { channelId: string; hash: string; at: number }[] = []
  private fetching = new Map<string, Promise<MediaRow | undefined>>()
  private uploading = new Map<string, Promise<string | null>>()
  /** Transcriptions queued or running, by wa_msg_id; sttChain runs them one at a time. */
  private transcribing = new Map<string, Promise<MediaRow | undefined>>()
  private sttChain: Promise<unknown> = Promise.resolve()
  transcriber: Transcriber
  media: MediaDir
  /** tm8 forms in the group: polls, numbered questions, answers back into tm8 (forms.ts). */
  forms: Forms
  /** Speaker token files (<name>.token, 0600); agents read theirs, briefings only name the path. */
  tokenDir: string
  ownJids = new Set<string>()
  lastPoll: PollStatus = { at: null, ok: false, error: null }
  waState = 'starting'

  constructor(
    public cfg: Config,
    public store: Store,
    public wa: WaPort,
    /** One port for every channel, or a factory called once per (spaceId, tokenFile). */
    tm8: Tm8Port | Tm8Factory,
    private o: { now?: () => number; log?: Log; retryDelaysMs?: number[]; mediaDir?: string; transcriber?: Transcriber; tokenDir?: string } = {},
  ) {
    this.makeTm8 = typeof tm8 === 'function' ? tm8 : () => tm8
    this.tokenDir = o.tokenDir ?? path.join(os.tmpdir(), 'wa-bridge-tokens')
    this.media = new MediaDir(o.mediaDir ?? path.join(os.tmpdir(), 'wa-bridge-media'))
    this.transcriber = o.transcriber ?? new NoneTranscriber()
    this.forms = new Forms(this)
    // A transcription cut off by a restart is started again (resumeTranscriptions).
    store.db.prepare(`UPDATE media SET transcript_status = NULL WHERE transcript_status = 'pending'`).run()
    const now = this.now
    this.tokenLimiter = new RateLimiter(cfg.rateLimits.perTokenPerMinute, 60_000, now)
    this.channelLimiter = new RateLimiter(cfg.rateLimits.perChannelPerMinute, 60_000, now)
    for (const ch of cfg.channels) {
      this.tm8For(ch)
      store.channel(ch.id)
      store.backfillChannel(ch.id, this.channelJids(ch))
    }
    // With a self chat the owner's number is ours. A bridge on another number (no self chat, the owner is a group member)
    // learns its JIDs on connect; seeding the owner there would treat the owner's messages and @mentions as the bridge's.
    if (cfg.channels.some((c) => !c.jid.endsWith('@g.us'))) for (const j of cfg.ownerJids) this.ownJids.add(j)
  }

  now = () => (this.o.now ?? Date.now)()
  log: Log = (m) => (this.o.log ?? ((s) => console.log(`[${new Date().toISOString()}] ${s}`)))(m)

  // ---------------------------------------------------------------- tm8 clients

  private client(spaceId: string, tokenFile: string): Tm8Client {
    const key = `${spaceId}|${tokenFile}`
    let c = this.clients.get(key)
    if (!c) {
      const viaLink = spaceId !== this.cfg.tm8.spaceId && tokenFile === this.cfg.tm8.tokenFile
      c = { key, spaceId, tokenFile, port: this.makeTm8({ spaceId, tokenFile, homeSpaceId: viaLink ? this.cfg.tm8.spaceId : spaceId }), viaLink, teammates: { at: 0, list: [] }, waitingForToken: false }
      this.clients.set(key, c)
    }
    return c
  }
  clientFor(ch: ChannelConfig): Tm8Client {
    const t = channelTm8(this.cfg, ch)
    return this.client(t.spaceId, t.tokenFile)
  }
  /** The tm8 port a channel's calls go through (its space, its token). */
  tm8For(ch: ChannelConfig): Tm8Port {
    return this.clientFor(ch).port
  }
  /** The global tm8 block's client (the default space). */
  get tm8(): Tm8Port {
    return this.client(this.cfg.tm8.spaceId, this.cfg.tm8.tokenFile).port
  }
  channelOf(channelId: string | null | undefined): ChannelConfig | undefined {
    return this.cfg.channels.find((c) => c.id === channelId)
  }

  // ---------------------------------------------------------------- channels

  channelJids(ch: ChannelConfig): string[] {
    return [ch.jid, ...(ch.altJids ?? [])]
  }
  channelForJid(jid: string | null | undefined): ChannelConfig | undefined {
    if (!jid) return undefined
    return this.cfg.channels.find((c) => this.channelJids(c).includes(jid))
  }
  channelById(id: string): ChannelConfig {
    const ch = this.cfg.channels.find((c) => c.id === id)
    if (!ch) throw new HttpError(403, 'channel no longer configured')
    return ch
  }
  /** The only JIDs the bridge may ever send to. */
  sendableJids(): Set<string> {
    return new Set(this.cfg.channels.map((c) => c.jid))
  }
  private assertSendable(jid: string) {
    if (!this.sendableJids().has(jid)) throw new Error(`refusing to send to unconfigured chat ${jid}`)
  }
  isOwner(m: Pick<Inbound, 'fromMe' | 'senderJid' | 'senderAltJid'>): boolean {
    return m.fromMe || this.cfg.ownerJids.some((j) => j === m.senderJid || j === m.senderAltJid)
  }
  /** Is the sender on the channel's trusted list? Only changes the envelope label (TRUSTED vs UNTRUSTED). */
  isTrusted(ch: ChannelConfig, m: Pick<Inbound, 'fromMe' | 'senderJid' | 'senderAltJid'>): boolean {
    const trusted = trustedSenders(this.cfg, ch)
    if (m.fromMe && this.cfg.ownerJids.some((j) => trusted.has(j))) return true
    return [m.senderJid, m.senderAltJid].some((j) => !!j && trusted.has(j))
  }
  /** May these JIDs (one person's PN/LID) take part in the channel? Votes carry no fromMe, only the voter's JIDs. */
  senderAllowedJids(ch: ChannelConfig, jids: string[]): boolean {
    const allowed = allowedSenders(this.cfg, ch)
    if (allowed.has('everyone')) return true
    const owner = jids.some((j) => this.cfg.ownerJids.includes(j) || this.ownJids.has(j))
    if (owner && (allowed.has('owner') || this.cfg.ownerJids.some((j) => allowed.has(j)))) return true
    return jids.some((j) => allowed.has(j))
  }
  private senderAllowed(ch: ChannelConfig, m: Inbound): boolean {
    const allowed = allowedSenders(this.cfg, ch)
    // "everyone": any member of the chat may trigger agents (owner-only commands stay owner-only).
    if (allowed.has('everyone')) return true
    if (m.fromMe && allowed.has('owner')) return true
    if (m.fromMe && this.cfg.ownerJids.some((j) => allowed.has(j))) return true
    return [m.senderJid, m.senderAltJid].some((j) => !!j && allowed.has(j))
  }
  mainName(ch: ChannelConfig): NameRow | undefined {
    const row = this.store.channel(ch.id)
    return row.main_chat_id ? this.store.nameByEntity(row.main_chat_id) : undefined
  }

  // ---------------------------------------------------------------- inbound

  async onInbound(m: Inbound): Promise<void> {
    const ch = this.channelForJid(m.chatJid) ?? this.channelForJid(m.chatAltJid)
    if (!ch) return // unconfigured chats are not logged at all
    // Loop guard 1: our own sends are in the outbox by wa_msg_id. An echo that arrives while sendText is still running
    // (before we know the id) matches a pending send of the exact same body in this chat. Anything else the owner typed,
    // even text starting with "tm8:", is the owner's.
    const fromBridge = this.store.isOurs(m.id) || (m.fromMe && this.takePendingEcho(ch.id, m.text))
    const isNew = this.store.insertMessage({
      wa_msg_id: m.id,
      channel_id: ch.id,
      chat_jid: m.chatJid,
      sender_jid: m.senderJid,
      sender_alt_jid: m.senderAltJid,
      sender_name: m.senderName,
      text: m.text,
      quoted_wa_msg_id: m.quotedId,
      ts: m.ts,
      from_me: m.fromMe ? 1 : 0,
      from_bridge: fromBridge ? 1 : 0,
      key_json: JSON.stringify(m.key),
      message_json: JSON.stringify(m.message ?? null),
    })
    if (fromBridge) {
      this.log(`[in ${ch.id}] ${m.id}: our own message, ignored (loop guard)`)
      return
    }
    if (!isNew) return // redelivery: already routed (or not) the first time
    this.log(`[in ${ch.id}] ${m.senderName ?? m.senderJid ?? '?'}: ${m.text.slice(0, 200)}`)
    // An answer to a form in the group (a reply to a numbered question, or "2: …") is collected, not routed. No age limit:
    // answers sent while the bridge was down still count.
    if (this.senderAllowed(ch, m) && (await this.forms.onText(ch, m))) return
    if (m.media) {
      // Every logged media message is downloaded (unrouted ones too); only routed ones are uploaded to tm8.
      this.store.insertMedia({
        wa_msg_id: m.id, channel_id: ch.id, direction: 'in', kind: m.media.kind, mime: m.media.mime, file_name: m.media.fileName,
        caption: m.media.caption, declared_size: m.media.size, ref_json: m.media.ref,
        duration_sec: m.media.durationSec ?? null, ptt: m.media.kind === 'audio' ? (m.media.ptt ? 1 : 0) : null,
      })
      await this.fetchMedia(m.id, m.media.data)
      // Every downloaded voice note is transcribed (in the background) so the log and FTS have its words.
      void this.transcribe(m.id)
    }
    if (m.ts * 1000 < this.now() - this.cfg.maxRouteAgeMinutes * 60_000) {
      this.log(`[in ${ch.id}] ${m.id} is older than ${this.cfg.maxRouteAgeMinutes} min: logged, not routed`)
      return
    }
    if (!this.senderAllowed(ch, m)) return

    const cmd = parseCommand(m.text)
    if (cmd) {
      await this.runCommand(ch, m, cmd)
      return
    }

    const targets = this.resolveTargets(ch, m)
    if (targets === 'none') return
    if (!this.tm8For(ch).configured()) return this.replyNotConfigured(ch, m)
    if (targets === 'no-main') {
      void this.ensureMainChat(ch)
      await this.sendBridge(ch, 'the main chat for this group is not ready yet, try again in a minute', m.id)
      return
    }
    const quotedMediaId = await this.prepareQuotedMedia(ch, m)
    await Promise.all(targets.map((t) => this.routeTo(ch, m, t, quotedMediaId)))
  }

  private takePendingEcho(channelId: string, text: string): boolean {
    const cutoff = this.now() - PENDING_ECHO_MS
    this.pendingSends = this.pendingSends.filter((p) => p.at >= cutoff)
    const hash = bodyHash(text)
    const i = this.pendingSends.findIndex((p) => p.channelId === channelId && p.hash === hash)
    if (i < 0) return false
    this.pendingSends.splice(i, 1)
    return true
  }

  /** Decide where a message goes: quoted bot message → its name; @name; @tm8 / unknown → main chat. */
  resolveTargets(ch: ChannelConfig, m: Inbound): Target[] | 'none' | 'no-main' {
    const wants: { name?: NameRow; main?: boolean; note?: string }[] = []
    if (m.quotedId) {
      const ob = this.store.outboxByWaId(m.quotedId)
      if (ob && ob.name !== BRIDGE && ob.channel_id === ch.id) {
        const n = this.store.getName(ob.name)
        if (n) wants.push({ name: n })
      }
    }
    const mentions = parseMentions(m.text)
    if (m.mentionedJids.some((j) => this.ownJids.has(j))) mentions.push({ kind: 'tm8' })
    for (const mention of mentions) {
      if (mention.kind === 'tm8') {
        wants.push({ main: true, note: mention.teammate ? this.teammateNote(ch, mention.teammate) : undefined })
        continue
      }
      const n = this.store.getName(mention.handle)
      if (n && n.channel_id === ch.id) wants.push({ name: n })
      else wants.push({ main: true, note: `unknown name @${mention.handle}; no session has that name in this group` })
    }
    if (wants.length === 0) return 'none'
    const main = this.mainName(ch)
    const byEntity = new Map<string, Target>()
    for (const w of wants) {
      let target = w.name
      const notes: string[] = []
      if (w.note) notes.push(w.note)
      if (target && target.status === 'ended') {
        notes.push(`was for ${target.name} (ended); that session can't take messages any more, handle it here or spawn a new one`)
        target = undefined
        w.main = true
      }
      if (!target) {
        if (!main) return 'no-main'
        target = main
      }
      const t = byEntity.get(target.entity_id) ?? { name: target, notes: [] }
      t.notes.push(...notes)
      byEntity.set(target.entity_id, t)
    }
    return [...byEntity.values()]
  }

  private teammateNote(ch: ChannelConfig, hint: string): string {
    const tm = matchTeammate(hint, this.clientFor(ch).teammates.list)
    return tm
      ? `the user asked for teammate "${hint}" → ${tm.title} (${tm.id}); decide whether to spawn it`
      : `the user asked for teammate "${hint}"; no teammate in the Space matches that name`
  }

  private async routeTo(ch: ChannelConfig, m: Inbound, t: Target, quotedMediaId: string | null) {
    const routeId = this.store.insertRoute(m.id, ch.id, t.name.name)
    if (routeId === null) return
    const quoted = m.quotedId ? this.store.getMessage(m.quotedId) : undefined
    const mutationId = crypto.randomUUID()
    const delays = this.o.retryDelaysMs ?? [1000, 5000, 15000]
    const mediaIds = [{ id: m.id, quoted: false }, ...(quotedMediaId ? [{ id: quotedMediaId, quoted: true }] : [])].filter((x) => this.store.getMedia(x.id))
    // Give a running transcription a moment so the transcript can ride along; past that, post now and send it after.
    const running = mediaIds.map((x) => this.transcribing.get(x.id)).filter((p) => !!p)
    if (running.length) await within(Promise.all(running), this.cfg.transcription.waitSeconds * 1000)
    for (let attempt = 0; ; attempt++) {
      try {
        // Media goes up to tm8 once per message and every copy references it. If the upload keeps failing, the last
        // attempt posts without it (the envelope says so and points at GET /media).
        const lines: string[] = []
        const fileIds: string[] = []
        const followUps: { id: string; quoted: boolean }[] = []
        for (const x of mediaIds) {
          const att = await this.attachmentFor(x.id, attempt < delays.length - 1, x.quoted)
          if (!att) continue
          lines.push(...att.lines)
          fileIds.push(...att.fileIds)
          if (att.transcriptPending) followUps.push(x)
        }
        const body = envelope({
          ch,
          senderName: m.senderName,
          senderJid: m.senderAltJid?.endsWith('@s.whatsapp.net') ? m.senderAltJid : (m.senderJid ?? m.senderAltJid),
          owner: this.isOwner(m),
          trusted: this.isTrusted(ch, m),
          waMsgId: m.id,
          to: t.name.name,
          quoted: quoted ? { by: quoted.by_name ?? quoted.sender_name ?? 'someone', text: quoted.text } : undefined,
          attachment: lines.length ? lines.join('\n') : undefined,
          notes: t.notes,
          text: m.text,
        })
        await this.tm8For(ch).post(t.name.entity_id, body, mutationId, this.cfg.media.attach === 'attach' ? fileIds : undefined)
        this.store.setRouteStatus(routeId, 'posted')
        this.log(`[route] ${m.id} → ${t.name.name} (${t.name.entity_id})`)
        for (const x of followUps) void this.followUpTranscript(t.name, m.id, x.id, x.quoted, routeId)
        await this.reactSafe(ch, m.id, '👀')
        return
      } catch (e) {
        if (attempt >= delays.length - 1) {
          this.store.setRouteStatus(routeId, 'failed')
          this.log(`[route] ${m.id} → ${t.name.name} failed: ${(e as Error).message}`)
          await this.reactSafe(ch, m.id, '❌')
          return
        }
        await sleep(delays[attempt])
      }
    }
  }

  /**
   * A routed message that quotes a media message (image, document, audio) carries that media too. It's normally in the
   * log already; if not (sent before the bridge ran) it is logged from the copy the reply carries. A failed or missing
   * download is tried again now. Returns the quoted message id if it has media in this channel.
   */
  private async prepareQuotedMedia(ch: ChannelConfig, m: Inbound): Promise<string | null> {
    if (!m.quotedId) return null
    const id = m.quotedId
    let row = this.store.getMedia(id)
    if (row && row.channel_id !== ch.id) return null
    if (!row && m.quotedMedia) {
      const msg = this.store.getMessage(id)
      if (msg && msg.channel_id !== ch.id) return null
      const qm = m.quotedMedia
      if (!msg) {
        this.store.insertMessage({
          wa_msg_id: id, channel_id: ch.id, chat_jid: m.chatJid, sender_jid: m.quotedSenderJid ?? null, sender_alt_jid: null, sender_name: null,
          text: mediaPlaceholder(qm.kind, qm.caption, qm.fileName, qm), quoted_wa_msg_id: null, ts: m.ts,
          from_me: m.quotedSenderJid && this.ownJids.has(m.quotedSenderJid) ? 1 : 0, from_bridge: 0, key_json: null, message_json: null,
        })
      }
      this.store.insertMedia({
        wa_msg_id: id, channel_id: ch.id, direction: 'in', kind: qm.kind, mime: qm.mime, file_name: qm.fileName, caption: qm.caption,
        declared_size: qm.size, ref_json: qm.ref, duration_sec: qm.durationSec ?? null, ptt: qm.kind === 'audio' ? (qm.ptt ? 1 : 0) : null,
      })
      this.log(`[media] ${id}: quoted ${qm.kind} was not in the log; logged from the reply`)
      row = this.store.getMedia(id)
    } else if (row && m.quotedMedia) {
      // Fill in what older rows lack (audio length, voice-note flag, a download reference).
      const qm = m.quotedMedia
      const patch: Parameters<Store['updateMedia']>[1] = {}
      if (row.duration_sec === null && qm.durationSec) patch.duration_sec = qm.durationSec
      if (row.ptt === null && row.kind === 'audio') patch.ptt = qm.ptt ? 1 : 0
      if (!row.ref_json && row.direction === 'in' && qm.ref) patch.ref_json = qm.ref
      if (Object.keys(patch).length) {
        this.store.updateMedia(id, patch)
        row = this.store.getMedia(id)
      }
    }
    if (!row) return null
    if (row.direction === 'in' && row.status !== 'downloaded' && row.status !== 'too_large') row = await this.fetchMedia(id)
    void this.transcribe(id, { retryFailed: true })
    return id
  }

  // ---------------------------------------------------------------- media

  /** Download an inbound message's media into data/media (once; concurrent callers share the attempt). Never throws. */
  fetchMedia(id: string, data?: Buffer): Promise<MediaRow | undefined> {
    const running = this.fetching.get(id)
    if (running) return running
    const p = this.fetchMediaOnce(id, data).finally(() => this.fetching.delete(id))
    this.fetching.set(id, p)
    return p
  }

  private async fetchMediaOnce(id: string, data?: Buffer): Promise<MediaRow | undefined> {
    const row = this.store.getMedia(id)
    if (!row || row.direction !== 'in' || row.status === 'downloaded' || row.status === 'too_large') return row
    const max = this.cfg.media.maxBytes
    const attempts = row.attempts + 1
    try {
      if (row.declared_size !== null && row.declared_size > max) throw new TooLargeError(row.declared_size, max)
      if (!data && !row.ref_json) throw new Error('no download reference')
      const buf = data ?? (await this.wa.downloadMedia(row.ref_json!, max))
      if (buf.length > max) throw new TooLargeError(buf.length, max)
      if (buf.length === 0) throw new Error('empty download')
      const mime = row.mime ?? sniffMime(buf) ?? mimeFromName(row.file_name) ?? 'application/octet-stream'
      const rel = this.media.write(this.media.nameFor(id, extFor(mime, row.file_name)), buf)
      this.store.updateMedia(id, { status: 'downloaded', size: buf.length, path: rel, mime, attempts, error: null })
      this.log(`[media] ${id}: downloaded ${row.kind} ${mime} ${humanSize(buf.length)}`)
    } catch (e) {
      const tooLarge = e instanceof TooLargeError
      const msg = (e as Error).message.slice(0, 300)
      this.store.updateMedia(id, { status: tooLarge ? 'too_large' : 'failed', attempts, error: msg })
      this.log(`[media] ${id}: ${tooLarge ? 'not downloaded' : `download attempt ${attempts} failed`}: ${msg}`)
    }
    return this.store.getMedia(id)
  }

  /** Retry failed inbound downloads with backoff (1, 2, 4, 8 min), for a day. */
  async retryMedia() {
    if (!this.wa.connected()) return
    for (const r of this.store.retryableMedia(5, this.now() - 24 * 3600_000)) {
      if (this.fetching.has(r.wa_msg_id)) continue
      if (r.attempts > 0 && this.now() - (r.updated_at ?? r.created_at) < 60_000 * 2 ** (r.attempts - 1)) continue
      await this.fetchMedia(r.wa_msg_id)
    }
  }

  /** Upload a downloaded media file to tm8 (once per message). Returns the tm8 file id, or null if it can't. */
  ensureUploaded(id: string): Promise<string | null> {
    const running = this.uploading.get(id)
    if (running) return running
    const p = (async () => {
      const row = this.store.getMedia(id)
      if (!row) return null
      if (row.tm8_file_id) return row.tm8_file_id
      if (row.status !== 'downloaded' || !row.path) return null
      const ch = this.channelOf(row.channel_id)
      if (!ch) return null
      const c = this.clientFor(ch)
      if (c.viaLink) throw new LinkRefused('file upload is not allowed through a space link; give the channel its own tm8.tokenFile')
      const { fileId } = await c.port.uploadFile(this.media.abs(row.path), {
        name: row.file_name ?? row.path,
        mime: row.mime ?? 'application/octet-stream',
        mutationId: stableUuid(`wa-bridge-media:${c.spaceId}:${id}`),
      })
      this.store.updateMedia(id, { tm8_file_id: fileId })
      this.log(`[media] ${id}: uploaded to tm8 as file ${fileId}`)
      return fileId
    })().finally(() => this.uploading.delete(id))
    this.uploading.set(id, p)
    return p
  }

  /** How a media row is named in envelopes: `image`, `document`, `voice note 0:12`, `audio song.mp3`. */
  private mediaLabel(row: MediaRow): string {
    return row.kind === 'audio' ? audioLabel({ fileName: row.file_name, durationSec: row.duration_sec, ptt: !!row.ptt }) : row.kind
  }

  /**
   * The envelope's attachment line (plus a transcript line for audio) and the tm8 file ids, for a routed message's own
   * media or (quoted) the media of the message it quotes.
   */
  private async attachmentFor(id: string, strict: boolean, quoted = false): Promise<{ lines: string[]; fileIds: string[]; transcriptPending: boolean } | null> {
    let row = this.store.getMedia(id)
    if (!row) return null
    let fileId: string | null = null
    let uploadError: string | null = null
    if (row.status === 'downloaded') {
      try {
        fileId = await this.ensureUploaded(id)
      } catch (e) {
        // Through a space link the upload can never work: don't retry, route without it.
        if (strict && !(e instanceof LinkRefused)) throw e
        uploadError = (e as Error).message.slice(0, 120)
        this.log(`[media] ${id}: upload failed, routing without the attachment: ${uploadError}`)
      }
      row = this.store.getMedia(id)!
    }
    const label = this.mediaLabel(row)
    const parts = [label, row.mime ?? 'unknown type', humanSize(row.size ?? row.declared_size)]
    if (row.file_name && row.kind !== 'audio') parts.push(`"${row.file_name.replace(/"/g, "'")}"`)
    const get = `GET /media/${id}`
    if (fileId) {
      parts.push(this.cfg.media.attach === 'attach' ? `attached as tm8 file ${fileId}` : `tm8 file ${fileId} (tm8 file download ${fileId} --output <path>)`)
      parts.push(`bytes also at ${get}`)
    } else if (row.status === 'downloaded') parts.push(`not attached (upload to tm8 failed${uploadError ? `: ${uploadError}` : ''})`, `bytes at ${get}`)
    else if (row.status === 'too_large') parts.push(`over the ${humanSize(this.cfg.media.maxBytes)} limit, not downloaded`)
    else if (quoted) parts.splice(0, parts.length, `quoted ${label} could not be downloaded (${row.error ?? 'pending'}); ${get} retries`)
    else parts.push(`not downloaded yet (${row.error ?? 'pending'}); ${get} retries`)
    const lines = [quoted ? `[quoted attachment, from the quoted message ${id}: ${parts.join(' · ')}]` : `[attachment: ${parts.join(' · ')}]`]
    const tr = this.transcriptLine(row, quoted)
    if (tr) lines.push(tr)
    return { lines, fileIds: fileId ? [fileId] : [], transcriptPending: row.transcript_status === 'pending' }
  }

  /** `[transcript (auto, hi): …]` for audio, or why there is none; null when transcription doesn't apply. */
  transcriptLine(row: MediaRow, quoted: boolean): string | null {
    if (!isAudio(row.kind, row.mime)) return null
    const of = quoted ? ` of the quoted ${this.mediaLabel(row)}` : ''
    switch (row.transcript_status) {
      case 'done': {
        const t = row.transcript?.trim() ? clip(row.transcript.replace(/\s+/g, ' ').trim(), TRANSCRIPT_ENVELOPE_MAX, ` … (full text: GET /message/${row.wa_msg_id})`) : '(no speech detected)'
        return `[transcript${of} (auto, ${row.transcript_lang ?? '?'}): ${t}]`
      }
      case 'pending':
        return `[transcript${of}: still running; it will follow as a separate message]`
      case 'too_long':
        return `[transcript${of}: none, the audio is longer than the ${durationLabel(this.cfg.transcription.maxDurationSec)} limit]`
      case 'failed':
        return `[transcript${of}: failed (${(row.transcript_error ?? 'unknown error').slice(0, 160)})]`
      default:
        return null // never tried (not downloaded) or transcription turned off
    }
  }

  // ---------------------------------------------------------------- transcription

  /**
   * Transcribe a downloaded audio message (once; queued behind any other). Resolves with the updated row; never throws.
   * `retryFailed` gives a failed one another go (when someone quotes it).
   */
  transcribe(id: string, o: { retryFailed?: boolean } = {}): Promise<MediaRow | undefined> {
    const running = this.transcribing.get(id)
    if (running) return running
    const row = this.store.getMedia(id)
    if (!row || !isAudio(row.kind, row.mime) || row.status !== 'downloaded' || !row.path) return Promise.resolve(row)
    // Done/too long stay; failed is retried on request; "disabled" (provider was "none") is done once a provider is on.
    const again = (o.retryFailed && row.transcript_status === 'failed') || (row.transcript_status === 'disabled' && this.transcriber.enabled)
    if (row.transcript_status && !again) return Promise.resolve(row)
    const provider = this.transcriber.provider
    if (!this.transcriber.enabled) {
      this.store.updateMedia(id, { transcript_status: 'disabled', transcript_provider: provider })
      return Promise.resolve(this.store.getMedia(id))
    }
    const max = this.cfg.transcription.maxDurationSec
    if (row.duration_sec !== null && row.duration_sec > max) {
      this.store.updateMedia(id, { transcript_status: 'too_long', transcript_provider: provider, transcript_error: `${Math.round(row.duration_sec)} s > ${max} s` })
      return Promise.resolve(this.store.getMedia(id))
    }
    this.store.updateMedia(id, { transcript_status: 'pending', transcript_provider: provider, transcript_error: null })
    const p = this.sttChain
      .then(() => this.transcribeOnce(id))
      .finally(() => this.transcribing.delete(id))
    this.sttChain = p.catch(() => {})
    this.transcribing.set(id, p)
    return p
  }

  private async transcribeOnce(id: string): Promise<MediaRow | undefined> {
    const row = this.store.getMedia(id)
    if (!row?.path) return row
    const max = this.cfg.transcription.maxDurationSec
    const started = Date.now()
    try {
      const r = await this.transcriber.transcribe(this.media.abs(row.path), { timeoutMs: transcribeTimeoutMs(row.duration_sec, max), maxDurationSec: max })
      const ms = Date.now() - started
      const duration = row.duration_sec ?? (r.durationSec !== null ? Math.round(r.durationSec * 10) / 10 : null)
      this.store.updateMedia(id, { transcript_status: 'done', transcript: r.text, transcript_lang: r.lang, transcript_ms: ms, transcript_error: null, duration_sec: duration })
      // The log text (and so FTS) gets the words: "[voice note 0:12] transcript: …".
      const msg = this.store.getMessage(id)
      if (msg) {
        const base = row.kind === 'audio' ? mediaPlaceholder('audio', null, row.file_name, { durationSec: duration, ptt: !!row.ptt }) : msg.text.replace(/ transcript: [\s\S]*$/, '')
        this.store.setMessageText(id, r.text ? `${base} transcript: ${r.text}` : base)
      }
      this.log(`[stt] ${id}: ${durationLabel(duration) ?? '?'} transcribed in ${(ms / 1000).toFixed(1)} s (${r.lang ?? '?'}): ${r.text.slice(0, 120)}`)
    } catch (e) {
      const tooLong = e instanceof TooLongError
      const msg = (e as Error).message.slice(0, 300)
      this.store.updateMedia(id, { transcript_status: tooLong ? 'too_long' : 'failed', transcript_error: msg, transcript_ms: Date.now() - started })
      this.log(`[stt] ${id}: ${tooLong ? 'not transcribed' : 'transcription failed'}: ${msg}`)
    }
    return this.store.getMedia(id)
  }

  /** Transcribe recent audio that was never done (e.g. cut off by a restart). Called at start. */
  resumeTranscriptions() {
    const rows = this.store.db
      .prepare(`SELECT wa_msg_id FROM media WHERE direction = 'in' AND status = 'downloaded' AND transcript_status IS NULL AND created_at >= ?`)
      .all(this.now() - 24 * 3600_000) as { wa_msg_id: string }[]
    for (const r of rows) void this.transcribe(r.wa_msg_id)
  }

  /** The transcript didn't make the routed post: send it to the same target once it's done (or say it failed). */
  private async followUpTranscript(target: NameRow, waId: string, mediaId: string, quoted: boolean, routeId: number) {
    const row = (await this.transcribing.get(mediaId)) ?? this.store.getMedia(mediaId)
    if (!row) return
    const line = this.transcriptLine(row, quoted) ?? `[transcript: not available]`
    const body = `[whatsapp transcript · to: ${target.name} · for wa_msg_id ${waId}${quoted ? ` (quoting ${mediaId})` : ''}, routed to you earlier]\n${line}`
    const delays = this.o.retryDelaysMs ?? [1000, 5000, 15000]
    for (let attempt = 0; ; attempt++) {
      try {
        const ch = this.channelOf(target.channel_id)
        if (!ch) return
        const c = this.clientFor(ch)
        await c.port.post(target.entity_id, body, stableUuid(`wa-bridge-transcript:${c.spaceId}:${routeId}:${mediaId}`))
        this.log(`[stt] ${mediaId}: transcript sent to ${target.name} as a follow-up`)
        return
      } catch (e) {
        if (attempt >= delays.length - 1) return this.log(`[stt] ${mediaId}: follow-up to ${target.name} failed: ${(e as Error).message}`)
        await sleep(delays[attempt])
      }
    }
  }

  /** GET /media/<id>: the file for a media message in the caller's channel (retrying a failed download first). */
  async mediaFile(ch: ChannelConfig, id: string): Promise<{ path: string; mime: string; fileName: string; size: number }> {
    const msg = this.store.getMessage(id)
    let row = this.store.getMedia(id)
    if (!msg || msg.channel_id !== ch.id || !row || row.channel_id !== ch.id) throw new HttpError(404, 'no media message with that id in this group')
    if (row.status !== 'downloaded' && row.direction === 'in') row = (await this.fetchMedia(id))!
    if (row.status === 'too_large') throw new HttpError(413, `media is over the ${humanSize(this.cfg.media.maxBytes)} limit and was not downloaded`)
    if (row.status !== 'downloaded' || !row.path || !this.media.exists(row.path)) {
      throw new HttpError(502, `media not available: ${row.error ?? 'not downloaded'}`, { status: row.status })
    }
    const fileName = row.file_name ?? `${row.kind}.${extFor(row.mime, null)}`
    return { path: this.media.abs(row.path), mime: row.mime ?? 'application/octet-stream', fileName, size: row.size ?? 0 }
  }

  private async replyNotConfigured(ch: ChannelConfig, m: Inbound) {
    const last = this.notConfiguredAt.get(ch.id) ?? 0
    if (this.now() - last < 60_000) return
    this.notConfiguredAt.set(ch.id, this.now())
    await this.sendRaw(ch, `${MAIN_PREFIX} link not configured yet`, m.id)
  }

  // ---------------------------------------------------------------- commands

  private async runCommand(ch: ChannelConfig, m: Inbound, cmd: Command) {
    const owner = this.isOwner(m)
    const reply = (t: string) => this.sendBridge(ch, t, m.id)
    switch (cmd.cmd) {
      case 'help':
        return reply(
          [
            'mention @tm8 to talk to this group\'s main chat, @tm8-<teammate> to ask for a teammate, @<handle> or reply to a session\'s message to talk to that session.',
            'commands: /who · /status <name> · /stop <name> (owner) · /new (owner, new main chat) · /help',
          ].join('\n'),
        )
      case 'who': {
        const names = this.store.namesIn(ch.id)
        const main = this.mainName(ch)
        if (names.length === 0) return reply('no names yet in this group')
        const live = names.filter((n) => n.status === 'live')
        const ended = names.length - live.length
        const lines = live.map((n) => `${displayName(n)}${n.entity_id === main?.entity_id ? ' · @tm8' : ''} · ${n.kind}${n.teammate ? ` · ${n.teammate}` : ''}`)
        return reply(`live: \n${lines.join('\n') || '(none)'}${ended ? `\n${ended} ended` : ''}`)
      }
      case 'status': {
        const n = this.store.getName(cmd.name)
        if (!n || n.channel_id !== ch.id) return reply(`no name ${cmd.name} in this group`)
        const r = this.store.lastRoute(n.name)
        return reply(
          `${displayName(n)}: ${n.status} ${n.kind}${n.teammate ? ` (${n.teammate})` : ''}, tm8 ${n.entity_id}` +
            `${n.parent_name ? `, launched by ${n.parent_name}` : ''}${r ? `, last message ${r.status}` : ''}`,
        )
      }
      case 'stop': {
        if (!owner) return reply('/stop is owner-only')
        const n = this.store.getName(cmd.name)
        if (!n || n.channel_id !== ch.id) return reply(`no name ${cmd.name} in this group`)
        if (n.kind === 'chat') return reply(`${n.name} is a main chat; use /new to start a fresh one`)
        if (n.status === 'ended') return reply(`${n.name} has already ended`)
        if (!this.tm8For(ch).configured()) return this.replyNotConfigured(ch, m)
        try {
          await this.tm8For(ch).stopSession(n.entity_id, `stopped from WhatsApp by the owner (/stop ${n.name})`, crypto.randomUUID())
          this.store.endName(n.name)
          // Its tm8 status may still read "running" for a moment: a stopped name is never revived.
          this.store.setKv(`stopped:${n.name}`, new Date(this.now()).toISOString())
          return reply(`stopped ${n.name}`)
        } catch (e) {
          return reply(`couldn't stop ${n.name}: ${(e as Error).message.slice(0, 200)}`)
        }
      }
      case 'new': {
        if (!owner) return reply('/new is owner-only')
        if (!this.tm8For(ch).configured()) return this.replyNotConfigured(ch, m)
        const old = this.mainName(ch)
        try {
          const created = await this.createMainChat(ch)
          if (old) {
            await this.tm8For(ch)
              .post(
                old.entity_id,
                `[whatsapp bridge] This main chat (${old.name}) has been rolled over. The new main chat for "${ch.title}" is ${created.name} (tm8 chat ${created.chatId}). ` +
                  `Please send it a short summary (open threads, live names, decisions) with \`tm8 message send --to ${created.chatId} '<summary>'\`. ` +
                  `Your token keeps working for ${old.name}, but @tm8 now goes to ${created.name}.`,
                crypto.randomUUID(),
              )
              .catch((e) => this.log(`[new] couldn't notify ${old.name}: ${e.message}`))
          }
          return reply(`new main chat ${created.name} is up (epoch ${created.epoch}); @tm8 goes there now`)
        } catch (e) {
          return reply(`couldn't create a new main chat: ${(e as Error).message.slice(0, 200)}`)
        }
      }
    }
  }

  // ---------------------------------------------------------------- main chats

  /** Make sure the channel has a main chat: the configured one, or a newly created one. */
  ensureMainChat(ch: ChannelConfig): Promise<void> {
    const running = this.ensuring.get(ch.id)
    if (running) return running
    const p = (async () => {
      const row = this.store.channel(ch.id)
      if (row.main_chat_id) return
      const c = this.clientFor(ch)
      if (!c.port.configured()) return
      if (ch.mainChatId) {
        const known = this.store.nameByEntity(ch.mainChatId)
        const name = known?.name ?? this.allocMainName(ch, 1)
        if (!known) {
          this.store.insertName({
            name, space_id: c.spaceId, entity_id: ch.mainChatId, kind: 'chat',
            teammate: await this.teammateTitle(ch, this.teammateOf(ch)), channel_id: ch.id, parent_name: null,
          })
        }
        this.store.setMainChat(ch.id, ch.mainChatId, name)
        this.store.revokeTokens(name)
        this.issueToken(name, ch.id)
        await c.port.post(ch.mainChatId, briefMainChat({ cfg: this.cfg, ch, name, tokenFile: this.tokenFileFor(name), chatId: ch.mainChatId }), crypto.randomUUID())
        this.store.markBriefed(name)
        this.markTokenFile(name)
        this.log(`[main] ${ch.id}: using configured main chat ${ch.mainChatId} as ${name}`)
        return
      }
      await this.createMainChat(ch)
    })()
      .catch((e) => {
        this.log(`[main] ${ch.id}: ${(e as Error).message}`)
        this.channelPoll.set(ch.id, { at: this.now(), ok: false, error: `main chat: ${(e as Error).message.slice(0, 300)}` })
      })
      .finally(() => this.ensuring.delete(ch.id))
    this.ensuring.set(ch.id, p)
    return p
  }

  private allocMainName(ch: ChannelConfig, epoch: number): string {
    const base = epoch <= 1 ? `${ch.id}-main` : `${ch.id}-main-${epoch}`
    return this.store.nameTaken(base) ? generateName(this.store.nameTaken) : base
  }

  /** Create a new main chat (a new epoch) for the channel; needs the human token. */
  async createMainChat(ch: ChannelConfig): Promise<{ chatId: string; name: string; epoch: number }> {
    const c = this.clientFor(ch)
    if (c.viaLink) {
      throw new LinkRefused(
        `chat start is not allowed through a space link (space ${c.spaceId}): create the chat in that space and set the channel's mainChatId, or give it its own tm8.tokenFile`,
      )
    }
    const row = this.store.channel(ch.id)
    const epoch = row.epoch + 1
    // A crash between chat.start and recording it must not create a second chat: replay the same mutation.
    const pendingKey = `pending-main:${ch.id}`
    const pendingRaw = this.store.getKv(pendingKey)
    const pending: { mutationId: string; name: string; epoch: number; token?: string } | null = pendingRaw ? JSON.parse(pendingRaw) : null
    // The token is in the name's token file, never in kv. A pending entry from before token files (it has a "token") is
    // dropped: its briefing would carry the token, so it gets a fresh mutation.
    const replay = pending && pending.epoch === epoch && !pending.token && readTokenFile(this.tokenDir, pending.name)
    const p = replay ? { mutationId: pending.mutationId, name: pending.name, epoch } : { mutationId: crypto.randomUUID(), name: this.allocMainName(ch, epoch), epoch }
    const token = (replay ? readTokenFile(this.tokenDir, p.name) : null) ?? newToken()
    if (!replay) writeTokenFile(this.tokenDir, p.name, token)
    this.store.setKv(pendingKey, JSON.stringify(p))
    const teammateId = this.teammateOf(ch)
    const teammate = await this.teammateTitle(ch, teammateId)
    const { chatId } = await c.port.startChat({
      teammate: teammateId,
      model: ch.model ?? channelTm8(this.cfg, ch).defaultModel,
      title: `${ch.title} (WhatsApp)`,
      body: briefMainChat({ cfg: this.cfg, ch, name: p.name, tokenFile: this.tokenFileFor(p.name) }),
      mutationId: p.mutationId,
    })
    this.store.db.transaction(() => {
      if (!this.store.nameByEntity(chatId)) {
        this.store.insertName({
          name: p.name, space_id: c.spaceId, entity_id: chatId, kind: 'chat',
          teammate, channel_id: ch.id, parent_name: null,
        })
      }
      this.store.addToken(hashToken(token), p.name, ch.id)
      this.store.markBriefed(p.name)
      this.markTokenFile(p.name)
      this.store.setMainChat(ch.id, chatId, p.name)
      this.store.db.prepare(`DELETE FROM kv WHERE k = ?`).run(pendingKey)
    })()
    this.log(`[main] ${ch.id}: created main chat ${chatId} as ${p.name} (epoch ${epoch})`)
    return { chatId, name: p.name, epoch }
  }

  /** The main chat's teammate: channel.teammate, else the channel's (or global) tm8.defaultTeammate. */
  private teammateOf(ch: ChannelConfig): string {
    return ch.teammate ?? channelTm8(this.cfg, ch).defaultTeammate
  }

  private async teammateTitle(ch: ChannelConfig, id: string): Promise<string | null> {
    const c = this.clientFor(ch)
    await this.refreshTeammates(c).catch(() => {})
    return c.teammates.list.find((t) => t.id === id)?.title ?? null
  }

  private async refreshTeammates(c: Tm8Client, force = false) {
    if (!force && this.now() - c.teammates.at < 5 * 60_000 && c.teammates.list.length) return
    c.teammates = { at: this.now(), list: await c.port.teammates() }
  }

  /** A new token for a name, written to its token file (replacing the file). Returns the token, for tests only. */
  issueToken(name: string, channelId: string): string {
    const token = newToken()
    writeTokenFile(this.tokenDir, name, token)
    this.store.addToken(hashToken(token), name, channelId)
    return token
  }

  tokenFileFor(name: string): string {
    return tokenFilePath(this.tokenDir, name)
  }

  /** The name was briefed with a token file (so it never needs the token-file rotation). */
  private markTokenFile(name: string) {
    this.store.setKv(`token-file:${name}`, new Date(this.now()).toISOString())
  }

  /**
   * Names briefed before token files got their token in a tm8 message. Rotate each live one once: revoke, write a new
   * token to its file, and post the update naming the file. A failed post is tried again next poll (with a new token).
   * Returns the names re-briefed.
   */
  async rotatePostedTokens(ch: ChannelConfig): Promise<string[]> {
    const done: string[] = []
    for (const n of this.store.namesIn(ch.id)) {
      if (n.status !== 'live' || !n.briefed_at || this.store.getKv(`token-file:${n.name}`)) continue
      this.store.revokeTokens(n.name)
      this.issueToken(n.name, ch.id)
      const main = n.kind === 'chat'
      await this.tm8For(ch).post(n.entity_id, rebriefTokenFile({ cfg: this.cfg, ch, name: n.name, main, tokenFile: this.tokenFileFor(n.name) }), crypto.randomUUID())
      this.markTokenFile(n.name)
      this.log(`[tokens] rotated ${n.name}'s token; re-briefed with ${this.tokenFileFor(n.name)}`)
      done.push(n.name)
    }
    return done
  }

  // ---------------------------------------------------------------- poller

  /** Poll tm8 once (coalesces concurrent callers). */
  poll(): Promise<void> {
    if (!this.polling) {
      this.polling = this.pollOnce()
        .then(() => {
          this.lastPoll = { at: this.now(), ok: true, error: null }
        })
        .catch((e) => {
          this.lastPoll = { at: this.now(), ok: false, error: (e as Error).message.slice(0, 300) }
          this.log(`[poll] ${(e as Error).message}`)
        })
        .finally(() => {
          this.polling = null
        })
    }
    return this.polling
  }

  /**
   * Each channel polls its own space with its own client. A channel whose token is missing or whose space fails is
   * recorded (health, logs) and skipped; the others carry on. Throws (for lastPoll) if any channel failed.
   */
  private async pollOnce() {
    const ready = new Set<string>()
    for (const c of this.clients.values()) {
      if (!c.port.configured()) {
        if (!c.waitingForToken) this.log(`[poll] waiting for the tm8 token file ${c.tokenFile} (space ${c.spaceId})`)
        c.waitingForToken = true
        continue
      }
      if (c.waitingForToken) this.log(`[poll] tm8 token found in ${c.tokenFile}, polling space ${c.spaceId}`)
      c.waitingForToken = false
      ready.add(c.key)
      await this.refreshTeammates(c).catch((e) => this.log(`[poll] teammates (space ${c.spaceId}): ${e.message}`))
    }
    await this.checkTokenExpiry().catch((e) => this.log(`[expiry] ${e.message}`))
    const errors: string[] = []
    for (const ch of this.cfg.channels) {
      const c = this.clientFor(ch)
      if (!ready.has(c.key)) {
        const error = `tm8 token not configured (${c.tokenFile})`
        this.channelPoll.set(ch.id, { at: this.now(), ok: false, error })
        errors.push(`${ch.id}: ${error}`)
        continue
      }
      try {
        // The previous status stays in /health until this poll finishes (it used to be cleared here, so /health showed
        // ok: false, last_poll_at: null mid-poll). ensureMainChat records its own failure as a new status (it never throws).
        const before = this.channelPoll.get(ch.id)
        await this.ensureMainChat(ch)
        const mainFailed = this.channelPoll.get(ch.id)
        await this.rotatePostedTokens(ch)
        const main = this.mainName(ch)
        for (const ep of this.store.epochs(ch.id)) {
          const ctx = await c.port.context(ep.chat_id)
          await this.syncLaunched(ch, ep.name, ctx, 0, new Set([ep.chat_id]))
          if (main && ep.chat_id === main.entity_id) await this.relayUnanswered(ch, main, ctx).catch((e) => this.log(`[relay] ${main.name}: ${(e as Error).message}`))
        }
        if (mainFailed && mainFailed !== before && !mainFailed.ok) errors.push(`${ch.id}: ${mainFailed.error}`)
        else this.channelPoll.set(ch.id, { at: this.now(), ok: true, error: null })
      } catch (e) {
        const error = (e as Error).message.slice(0, 300)
        this.channelPoll.set(ch.id, { at: this.now(), ok: false, error })
        errors.push(`${ch.id}: ${error}`)
      }
    }
    if (errors.length) throw new Error(errors.join('; '))
  }

  private async syncLaunched(ch: ChannelConfig, parentName: string, ctx: EntityContext, depth: number, seen: Set<string>) {
    if (depth > 5) return
    for (const s of ctx.launchedSessions ?? []) {
      if (seen.has(s.id)) continue
      seen.add(s.id)
      const ended = ENDED_STATUSES.has(s.status)
      let n = this.store.nameByEntity(s.id)
      if (n && n.status === 'ended') {
        if (ended || this.store.getKv(`stopped:${n.name}`)) continue
        // Resumed or relaunched (tm8 session resume, an auto-relaunch): the name is live again and gets a fresh briefing.
        this.store.reviveName(n.name)
        n = this.store.getName(n.name)!
        this.log(`[names] ${n.name} is ${s.status} again: revived`)
      }
      if (n && ended) {
        this.store.endName(n.name)
        this.log(`[names] ${n.name} ended (${s.status})`)
        continue
      }
      // New or live: read its context for the teammate and for sessions it launched.
      const sctx = await this.tm8For(ch).context(s.id)
      if (!n) {
        const name = generateName(this.store.nameTaken)
        this.store.insertName({
          name, space_id: this.clientFor(ch).spaceId, entity_id: s.id, kind: 'session',
          teammate: sctx.teammate ?? null, channel_id: ch.id, parent_name: parentName, status: ended ? 'ended' : 'live',
          title: defaultTitle({ title: sctx.title ?? s.title, tasks: sctx.tasks }),
        })
        if (ended) this.store.db.prepare(`UPDATE names SET ended_at = ? WHERE name = ?`).run(this.now(), name)
        n = this.store.getName(name)!
        this.log(`[names] ${s.id} → ${name} (${ended ? 'already ended' : 'live'}, launched by ${parentName})`)
      }
      if (!n.title) {
        // Names from before titles existed (or whose task had no title yet) get one as soon as there is one.
        const t = defaultTitle({ title: sctx.title ?? s.title, tasks: sctx.tasks })
        if (t) {
          this.store.setTitle(n.name, t, 'default')
          n = this.store.getName(n.name)!
          this.log(`[names] ${n.name} titled "${t}"`)
        }
      }
      if (n.status === 'live' && !n.briefed_at) await this.briefSessionName(ch, n)
      await this.syncLaunched(ch, n.name, sctx, depth + 1, seen)
    }
  }

  private async briefSessionName(ch: ChannelConfig, n: NameRow) {
    this.store.revokeTokens(n.name)
    this.issueToken(n.name, ch.id)
    try {
      await this.tm8For(ch).post(n.entity_id, briefSession({ cfg: this.cfg, ch, name: n, tokenFile: this.tokenFileFor(n.name) }), crypto.randomUUID())
      this.store.markBriefed(n.name)
      this.markTokenFile(n.name)
      this.log(`[names] briefed ${n.name}`)
    } catch (e) {
      this.store.revokeTokens(n.name)
      throw e
    }
  }

  // ---------------------------------------------------------------- fallback relay

  /**
   * RULE 1 backstop: a main-chat turn that came with [whatsapp …] envelopes ended, and no /say answered them. Post the
   * turn's final text (after its last tool call) to the group, as the main chat, on the last unanswered message's thread.
   * Text that looks like a secret is never posted; the group gets a notice instead.
   */
  async relayUnanswered(ch: ChannelConfig, main: NameRow, ctx: EntityContext) {
    const open = this.store.openRoutes(main.name, this.now() - RELAY_WINDOW_MS)
    if (!open.length) return
    // Fetch the chat's messages only when its turns moved (or once a minute): they carry every turn's parts.
    const sig = `${ctx.turnState ?? ''}|${ctx.turnCount ?? ''}|${ctx.lastTurnAt ?? ''}`
    const last = this.relayChecked.get(main.entity_id)
    if (last && last.sig === sig && this.now() - last.at < 60_000) return
    this.relayChecked.set(main.entity_id, { sig, at: this.now() })
    const msgs = (await this.tm8For(ch).messages(main.entity_id, RELAY_FETCH)).sort((a, b) => (a.id < b.id ? -1 : 1))
    const turns = msgs
      .filter((m) => m.isAgent && m.batch?.startsWith('chat-turn:'))
      .map((m) => ({ m, turnId: m.batch!.slice('chat-turn:'.length) }))
      .sort((a, b) => (a.turnId < b.turnId ? -1 : 1))
    for (let i = 0; i < turns.length; i++) {
      const { m, turnId } = turns[i]
      // A turn's inputs are the messages queued after the previous turn and before it. Without a previous turn in view,
      // they may be outside the page.
      const prev = turns[i - 1]?.turnId
      if (prev === undefined && msgs.length >= RELAY_FETCH) continue
      const done = m.parts?.find((p) => p.kind === 'done')
      if (!done || this.store.getKv(`relayed-turn:${turnId}`)) continue
      const waIds = msgs
        .filter((x) => !x.isAgent && (prev === undefined || x.id > prev) && x.id < turnId)
        .map((x) => envelopeWaId(x.body))
        .filter((w): w is string => !!w)
      const unanswered = open.filter((r) => waIds.includes(r.wa_msg_id) && ['posted', 'warned'].includes(this.store.routesTo(main.name, r.wa_msg_id)?.status ?? ''))
      if (!unanswered.length) continue
      await this.relayTurn(ch, main, turnId, m, unanswered.map((r) => r.wa_msg_id))
    }
  }

  private async relayTurn(ch: ChannelConfig, main: NameRow, turnId: string, m: ChatMessage, waIds: string[]) {
    const replyTo = waIds.at(-1)!
    let text = finalTurnText(m.parts ?? [])
    if (!text || /^sent\s+\S+\.?$/i.test(text) || /^Agent turn (failed|in progress)\.?$/i.test(text)) {
      // Nothing to say (or only the RULE 1 marker): leave it to the watchdog.
      this.store.setKv(`relayed-turn:${turnId}`, 'nothing')
      return
    }
    if (this.channelLimiter.take(`ch:${ch.id}`)) return // try again next poll
    this.store.setKv(`relayed-turn:${turnId}`, new Date(this.now()).toISOString())
    if (looksSecret(text)) {
      this.log(`[relay] turn ${turnId} of ${main.name}: its final text looks like it holds a secret; not relayed`)
      text = 'answered in tm8, but the answer looks like it holds a secret, so it is not posted here. Ask in the tm8 app.'
      const id = this.store.insertOutbox({ idempotency_key: null, name: BRIDGE, channel_id: ch.id, text: speakerLine({ kind: 'main' }, text), reply_to: replyTo })
      if (this.wa.connected()) await this.deliver(id)
    } else {
      text = whatsappText(text)
      if (text.length > 4000) text = text.slice(0, 3990).trimEnd() + ' …'
      const id = this.store.insertOutbox({ idempotency_key: `relay:${turnId}`, name: main.name, channel_id: ch.id, text: speakerLine({ kind: 'main' }, text), reply_to: replyTo })
      if (this.wa.connected()) await this.deliver(id)
      this.log(`[relay] turn ${turnId} of ${main.name} ended without a /say for ${waIds.join(', ')}: relayed its final text`)
    }
    for (const w of waIds) {
      const r = this.store.routesTo(main.name, w)
      if (r) this.store.setRouteStatus(r.id, 'replied')
      await this.reactSafe(ch, w, '✅')
    }
  }

  // ---------------------------------------------------------------- outbound

  /** Who is calling: the speaker token decides the name and the channel. */
  authenticate(header: string | undefined): { name: NameRow | null; nameStr: string; ch: ChannelConfig } {
    const token = /^Bearer\s+(\S+)$/.exec(header ?? '')?.[1]
    if (!token) throw new HttpError(401, 'missing bearer token')
    const row = this.store.tokenLookup(hashToken(token))
    if (!row) throw new HttpError(401, 'invalid or revoked token')
    const name = this.store.getName(row.name) ?? null
    if (name && name.status === 'ended') throw new HttpError(401, 'this name has ended')
    return { name, nameStr: row.name, ch: this.channelById(row.channel_id) }
  }

  async say(auth: { name: NameRow | null; nameStr: string; ch: ChannelConfig }, body: any): Promise<{ status: number; body: Record<string, unknown> }> {
    const text = typeof body?.text === 'string' ? body.text.trim() : ''
    if (!text) throw new HttpError(400, 'text is required')
    if (text.length > 4000) throw new HttpError(400, 'text is limited to 4000 characters')
    const pre = this.precheckSend(auth, body)
    if ('prior' in pre) return this.sayResult(pre.prior, true)
    const name = this.commitSend(auth, pre.label)
    const full = speakerLine(this.speakerOf(name), text)
    const id = this.store.insertOutbox({ idempotency_key: pre.key, name: auth.nameStr, channel_id: auth.ch.id, text: full, reply_to: pre.replyTo })
    this.markReplied(auth.ch, auth.nameStr, pre.replyTo)
    if (name?.kind === 'chat' && pre.replyTo) this.grantThread(auth.ch, pre.replyTo, text)
    if (this.wa.connected()) await this.deliver(id)
    return this.sayResult(this.store.getOutbox(id)!, false)
  }

  /**
   * POST /say-media: an image or document, with the same auth, scoping, reply_to thread rule, idempotency, rate limit,
   * queueing and loop guard as /say. The caption gets the speaker prefix ("tm8: …" / "Title (handle): …").
   */
  async sayMedia(auth: { name: NameRow | null; nameStr: string; ch: ChannelConfig }, body: SayMediaInput): Promise<{ status: number; body: Record<string, unknown> }> {
    const caption = typeof body.caption === 'string' ? body.caption.trim() : ''
    if (body.caption !== undefined && typeof body.caption !== 'string') throw new HttpError(400, 'caption must be a string')
    if (caption.length > 4000) throw new HttpError(400, 'caption is limited to 4000 characters')
    const kindReq = body.kind === undefined || body.kind === '' ? 'auto' : body.kind
    if (kindReq !== 'auto' && kindReq !== 'image' && kindReq !== 'document') throw new HttpError(400, 'kind must be "image", "document" or "auto"')
    let mimeReq: string | null = null
    if (body.mime !== undefined && body.mime !== '') {
      mimeReq = typeof body.mime === 'string' ? body.mime.toLowerCase().trim() : ''
      if (!MIME_RE.test(mimeReq)) throw new HttpError(400, 'mime must look like type/subtype')
    }
    const fileId = typeof body.tm8_file_id === 'string' ? body.tm8_file_id.trim() : ''
    if (!!body.file === !!fileId) throw new HttpError(400, 'send exactly one of: a multipart "file" part, or "tm8_file_id"')
    if (fileId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(fileId)) throw new HttpError(400, 'tm8_file_id must be a tm8 file id')

    const pre = this.precheckSend(auth, body)
    if ('prior' in pre) return this.sayResult(pre.prior, true)

    const max = this.cfg.media.maxBytes
    let data: Buffer
    let givenName: string | null
    let givenMime: string | null
    if (body.file) {
      ;({ data, fileName: givenName, mime: givenMime } = body.file)
    } else {
      const tm8 = this.tm8For(auth.ch)
      if (!tm8.configured()) throw new HttpError(503, 'the bridge has no tm8 token yet, so it cannot read tm8 files')
      const info = await tm8.fileInfo(fileId).catch((e) => {
        throw new HttpError(400, `tm8_file_id is not a tm8 file the bridge can read: ${(e as Error).message.slice(0, 200)}`)
      })
      if (info.size !== null && info.size > max) throw new HttpError(413, `file is ${humanSize(info.size)}; the limit is ${humanSize(max)}`)
      const tmp = this.media.tmpPath(extFor(info.mime, info.name))
      try {
        await tm8.downloadFile(fileId, tmp).catch((e) => {
          throw new HttpError(502, `couldn't download the tm8 file: ${(e as Error).message.slice(0, 200)}`)
        })
        data = fs.readFileSync(tmp)
      } finally {
        fs.rmSync(tmp, { force: true })
      }
      givenName = info.name
      givenMime = info.mime
    }
    if (data.length === 0) throw new HttpError(400, 'file is empty')
    if (data.length > max) throw new HttpError(413, `file is ${humanSize(data.length)}; the limit is ${humanSize(max)}`)
    const declared = givenMime?.split(';')[0].trim().toLowerCase() || null
    const mime =
      mimeReq ?? sniffMime(data) ?? (declared && declared !== 'application/octet-stream' && MIME_RE.test(declared) ? declared : null) ??
      mimeFromName(givenName) ?? 'application/octet-stream'
    const kind: 'image' | 'document' = kindReq === 'auto' ? (IMAGE_MIMES.has(mime) && data.length <= MAX_IMAGE_BYTES ? 'image' : 'document') : kindReq
    if (kind === 'image' && !IMAGE_MIMES.has(mime)) throw new HttpError(400, `kind "image" needs a JPEG, PNG or WebP (got ${mime}); send it as a document`)
    if (kind === 'image' && data.length > MAX_IMAGE_BYTES) throw new HttpError(413, `WhatsApp images are limited to ${humanSize(MAX_IMAGE_BYTES)}; send it as a document`)
    const fileName = safeFileName(typeof body.file_name === 'string' ? body.file_name : givenName, `${kind}.${extFor(mime, null)}`)

    const name = this.commitSend(auth, pre.label)
    const rel = this.media.write(`out-${crypto.randomUUID()}.${extFor(mime, fileName)}`, data)
    const captionLine = speakerLine(this.speakerOf(name), caption).trim()
    const id = this.store.insertOutbox({
      idempotency_key: pre.key, name: auth.nameStr, channel_id: auth.ch.id, text: captionLine, reply_to: pre.replyTo,
      media: { kind, mime, file_name: fileName, size: data.length, path: rel, tm8_file_id: fileId || null },
    })
    this.markReplied(auth.ch, auth.nameStr, pre.replyTo)
    if (this.wa.connected()) await this.deliver(id)
    const res = this.sayResult(this.store.getOutbox(id)!, false)
    return { status: res.status, body: { ...res.body, kind, mime, size: data.length, file_name: fileName } }
  }

  private speakerOf(name: NameRow | null) {
    return name?.kind === 'session' ? ({ kind: 'session', handle: name.name, title: name.title } as const) : ({ kind: 'main' } as const)
  }

  /** Shared /say and /say-media checks before anything is sent: key, label, idempotent repeat, reply_to and the thread rule. */
  private precheckSend(
    auth: { name: NameRow | null; nameStr: string; ch: ChannelConfig },
    body: { idempotency_key?: unknown; reply_to?: unknown; label?: unknown; escalate?: unknown },
  ): { prior: OutboxRow } | { key: string; replyTo: string | null; label: string | null } {
    const key = typeof body?.idempotency_key === 'string' ? body.idempotency_key : ''
    const replyTo = typeof body?.reply_to === 'string' && body.reply_to ? body.reply_to : null
    if (!key || key.length > 200) throw new HttpError(400, 'idempotency_key is required (≤200 chars, unique per message)')
    const { ch, nameStr, name } = auth
    let label: string | null = null
    if (body?.label !== undefined && body?.label !== null && body?.label !== '') {
      const l = cleanLabel(body.label)
      if ('error' in l) throw new HttpError(400, l.error)
      if (!name) throw new HttpError(400, 'label is only for named chats and sessions')
      label = l.label
    }

    const prior = this.store.outboxByKey(nameStr, key)
    if (prior) return { prior }

    if (replyTo) {
      const target = this.store.getMessage(replyTo)
      if (!target || target.channel_id !== ch.id) throw new HttpError(400, 'reply_to is not a message in this group')
    }
    // Sessions speak only when addressed: their reply must be in a thread addressed to them. The exception is an
    // escalation (escalate: true): a blocker, decision or question for the humans, which may start its own message.
    if (name?.kind === 'session' && !(body?.escalate === true && !replyTo)) {
      if (!replyTo) throw new HttpError(403, 'sessions must reply to a message addressed to them: pass reply_to (the wa_msg_id from your envelope)')
      if (!this.threadAddressedTo(replyTo, nameStr)) throw new HttpError(403, `reply_to is not in a thread addressed to ${nameStr}`)
    }
    return { key, replyTo, label }
  }

  /** Take one send's rate-limit slots (per name and per group); returns ms to wait, or 0 if taken. */
  takeSendSlot(nameStr: string, channelId: string): number {
    return this.tokenLimiter.take(`name:${nameStr}`) || this.channelLimiter.take(`ch:${channelId}`)
  }

  /** Take the rate-limit slots and apply a label; returns the (possibly re-titled) name. */
  private commitSend(auth: { name: NameRow | null; nameStr: string; ch: ChannelConfig }, label: string | null): NameRow | null {
    const wait = this.takeSendSlot(auth.nameStr, auth.ch.id)
    if (wait) throw new HttpError(429, 'rate limited', { retry_after_ms: wait })
    let { name } = auth
    if (label && name && label !== name.title) {
      this.store.setTitle(name.name, label, 'label')
      name = this.store.getName(name.name)!
      this.log(`[names] ${name.name} labelled "${label}"`)
    }
    return name
  }

  private sayResult(row: OutboxRow, duplicate: boolean) {
    if (row.status === 'sent') return { status: 200, body: { wa_msg_id: row.wa_msg_id, duplicate } }
    if (row.status === 'failed') {
      // A retry of a failed send re-queues it with the same key.
      this.store.db.prepare(`UPDATE outbox_v1 SET status = 'queued' WHERE id = ?`).run(row.id)
      this.sendAttempts.delete(row.id)
      if (this.wa.connected()) void this.flushQueue()
    }
    return { status: 202, body: { queued: true, idempotency_key: row.idempotency_key, duplicate } }
  }

  /**
   * A main chat announcing a session on a thread ("Deploy check (swift-otter) is on it", reply_to the request) hands that
   * session the thread: it may post its first message there (a "granted" route, which the watchdog ignores).
   */
  private grantThread(ch: ChannelConfig, replyTo: string, text: string) {
    for (const m of text.matchAll(/\(([a-z]+-[a-z]+(?:-\d+)?)\)/g)) {
      const n = this.store.getName(m[1])
      if (!n || n.kind !== 'session' || n.status !== 'live' || n.channel_id !== ch.id) continue
      const routeId = this.store.insertRoute(replyTo, ch.id, n.name)
      if (routeId === null) continue
      this.store.setRouteStatus(routeId, 'granted')
      this.log(`[names] ${n.name} may post in the thread of ${replyTo} (announced by the main chat)`)
    }
  }

  /** Is `waId` (or anything it quotes) a message routed to `name` or sent by it? */
  threadAddressedTo(waId: string, name: string): boolean {
    let cur: MessageRow | undefined = this.store.getMessage(waId)
    for (let i = 0; cur && i < 20; i++) {
      if (this.store.routesTo(name, cur.wa_msg_id)) return true
      if (cur.by_name === name) return true
      if (this.store.outboxByWaId(cur.wa_msg_id)?.name === name) return true
      cur = cur.quoted_wa_msg_id ? this.store.getMessage(cur.quoted_wa_msg_id) : undefined
    }
    return false
  }

  /** Watchdog: the first reply to a routed message (or the oldest open one) clears it to ✅. */
  private markReplied(ch: ChannelConfig, name: string, replyTo: string | null) {
    let r = replyTo ? this.store.routesTo(name, replyTo) : undefined
    if (r && !['posted', 'warned'].includes(r.status)) r = undefined
    r ??= this.store.oldestOpenRoute(name)
    if (!r) return
    this.store.setRouteStatus(r.id, 'replied')
    void this.reactSafe(ch, r.wa_msg_id, '✅')
  }

  async react(auth: { nameStr: string; ch: ChannelConfig }, body: any) {
    const waId = typeof body?.wa_msg_id === 'string' ? body.wa_msg_id : ''
    const emoji = typeof body?.emoji === 'string' ? body.emoji : ''
    if (!waId) throw new HttpError(400, 'wa_msg_id is required')
    if ([...emoji].length > 4) throw new HttpError(400, 'emoji must be a single emoji (or "" to clear)')
    const msg = this.store.getMessage(waId)
    if (!msg || msg.channel_id !== auth.ch.id) throw new HttpError(404, 'no such message in this group')
    const wait = this.tokenLimiter.take(`name:${auth.nameStr}`)
    if (wait) throw new HttpError(429, 'rate limited', { retry_after_ms: wait })
    if (!this.wa.connected()) throw new HttpError(503, 'WhatsApp is disconnected; reactions are not queued')
    await this.reactOn(auth.ch, msg, emoji)
    return { ok: true }
  }

  private async reactOn(ch: ChannelConfig, msg: MessageRow, emoji: string) {
    this.assertSendable(ch.jid)
    if (msg.wa_msg_id.startsWith(TEST_PREFIX)) return // injected test messages don't exist on WhatsApp
    const key: WaKey = msg.key_json ? JSON.parse(msg.key_json) : { remoteJid: msg.chat_jid, id: msg.wa_msg_id, fromMe: !!msg.from_me }
    await this.wa.react(ch.jid, key, emoji)
  }

  /** React to a logged message; failures are logged, never thrown. */
  reactTo(ch: ChannelConfig, waId: string, emoji: string) {
    return this.reactSafe(ch, waId, emoji)
  }

  private async reactSafe(ch: ChannelConfig, waId: string, emoji: string) {
    const msg = this.store.getMessage(waId)
    if (!msg || !this.wa.connected()) return
    try {
      await this.reactOn(ch, msg, emoji)
    } catch (e) {
      this.log(`[react] ${waId} ${emoji}: ${(e as Error).message}`)
    }
  }

  /** A bridge notice ("tm8: …"): commands, watchdog. Dropped if the group is rate limited. */
  async sendBridge(ch: ChannelConfig, text: string, replyTo: string | null): Promise<boolean> {
    return this.sendRaw(ch, speakerLine({ kind: 'main' }, text), replyTo)
  }

  /** Returns false if the notice was dropped by the group rate limit; otherwise it is sent or queued. */
  private async sendRaw(ch: ChannelConfig, full: string, replyTo: string | null): Promise<boolean> {
    if (this.channelLimiter.take(`ch:${ch.id}`)) {
      this.log(`[bridge] ${ch.id} rate limited, dropped notice: ${full.slice(0, 80)}`)
      return false
    }
    const id = this.store.insertOutbox({ idempotency_key: null, name: BRIDGE, channel_id: ch.id, text: full, reply_to: replyTo })
    if (this.wa.connected()) await this.deliver(id)
    return true
  }

  /** Send one outbox row, serialised with every other send so the group sees them in order. */
  private deliver(id: number): Promise<void> {
    const run = async () => {
      const row = this.store.getOutbox(id)
      if (!row || row.status !== 'queued') return
      if (!this.wa.connected()) return
      const ch = this.channelById(row.channel_id)
      this.assertSendable(ch.jid)
      let quoted: { key: WaKey; message: unknown } | undefined
      if (row.reply_to) {
        const q = this.store.getMessage(row.reply_to)
        if (q?.key_json && q.message_json && q.message_json !== 'null') quoted = { key: JSON.parse(q.key_json), message: JSON.parse(q.message_json) }
      }
      // A media row's caption is row.text; its WhatsApp echo (and our log line) reads "[image] <caption>", so the
      // pending-send guard hashes that.
      const media: OutboxMedia | null = row.kind === 'media' && row.media_json ? JSON.parse(row.media_json) : null
      const poll: OutboxPoll | null = row.kind === 'poll' && row.poll_json ? JSON.parse(row.poll_json) : null
      const logText = media ? mediaPlaceholder(media.kind, row.text, media.file_name) : row.text
      const pending = { channelId: ch.id, hash: bodyHash(logText), at: this.now() }
      this.pendingSends.push(pending)
      try {
        const send = (q?: { key: WaKey; message: unknown }) =>
          poll
            ? this.wa.sendPoll(ch.jid, poll)
            : media
              ? this.wa.sendMedia(ch.jid, { kind: media.kind, data: this.media.read(media.path), mime: media.mime, fileName: media.file_name, caption: row.text }, q)
              : this.wa.sendText(ch.jid, row.text, q)
        const sent = await send(quoted).catch((e) => {
          if (!quoted) throw e
          this.log(`[out ${ch.id}] quoting ${row.reply_to} failed (${(e as Error).message}); sending unquoted`)
          return send()
        })
        this.store.markSent(row.id, sent.id, JSON.stringify(sent.message ?? null))
        this.store.formMessageSent(row.id, sent.id)
        this.store.upsertBridgeMessage({
          wa_msg_id: sent.id, channel_id: ch.id, chat_jid: ch.jid, sender_jid: [...this.ownJids][0] ?? null, sender_alt_jid: null,
          sender_name: row.name, text: logText, quoted_wa_msg_id: row.reply_to, ts: Math.floor(this.now() / 1000), from_me: 1,
          by_name: row.name, key_json: JSON.stringify(sent.key), message_json: JSON.stringify(sent.message ?? null),
        })
        if (media) this.recordSentMedia(row.id, ch.id, sent.id, media, row.text)
        this.sendAttempts.delete(row.id)
        this.log(`[out ${ch.id}] ${sent.id}: ${logText.slice(0, 200)}`)
      } catch (e) {
        const n = (this.sendAttempts.get(row.id) ?? 0) + 1
        this.sendAttempts.set(row.id, n)
        this.log(`[out ${ch.id}] outbox ${row.id} attempt ${n} failed: ${(e as Error).message}`)
        if (n >= 5) this.store.markFailed(row.id)
      } finally {
        // From here the outbox id check covers the echo; a leftover entry must not swallow an owner's message.
        this.pendingSends = this.pendingSends.filter((p) => p !== pending)
      }
    }
    const p = this.sendChain.then(run, run)
    this.sendChain = p.catch(() => {})
    return p
  }

  /** Keep a sent media file as data/media/<wa_msg_id>.<ext> and record it, so history and GET /media show it. */
  private recordSentMedia(outboxId: number, channelId: string, waId: string, media: OutboxMedia, caption: string) {
    let rel = media.path
    try {
      const target = this.media.nameFor(waId, extFor(media.mime, media.file_name))
      this.media.rename(media.path, target)
      rel = target
      this.store.setOutboxMedia(outboxId, { ...media, path: rel })
    } catch (e) {
      this.log(`[media] ${waId}: couldn't rename ${media.path}: ${(e as Error).message}`)
    }
    this.store.insertMedia({
      wa_msg_id: waId, channel_id: channelId, direction: 'out', kind: media.kind, mime: media.mime, file_name: media.file_name,
      caption, declared_size: media.size, ref_json: null, size: media.size, path: rel, status: 'downloaded', tm8_file_id: media.tm8_file_id,
    })
  }

  /** Send everything queued while disconnected, oldest first. */
  async flushQueue() {
    for (const row of this.store.queued()) {
      if (!this.wa.connected()) return
      await this.deliver(row.id)
    }
  }

  // ---------------------------------------------------------------- tm8 token expiry

  /** The global token's expiry (ms), as in /health tm8.token_expires_at. */
  get tokenExpiresAt(): number | null {
    return this.expiry.get(this.cfg.tm8.tokenFile)?.expiresAt ?? null
  }

  /**
   * For each token file in use: read the token's expiry (`tm8 auth session`) hourly, or when the file changes. From
   * EXPIRY_WARN_MS before expiry: log a warning (hourly) and post one "tm8:" notice in the self chat per token.
   */
  async checkTokenExpiry() {
    const byFile = new Map<string, Tm8Client[]>()
    for (const c of this.clients.values()) byFile.set(c.tokenFile, [...(byFile.get(c.tokenFile) ?? []), c])
    const errors: string[] = []
    for (const [file, cs] of byFile) {
      await this.checkTokenFileExpiry(file, cs).catch((e) => errors.push(`${path.basename(file)}: ${(e as Error).message}`))
    }
    if (errors.length) throw new Error(errors.join('; '))
  }

  private async checkTokenFileExpiry(file: string, cs: Tm8Client[]) {
    const port = cs[0].port
    const fp = port.tokenFingerprint()
    if (!fp) return
    const st = this.expiry.get(file) ?? { expiresAt: null, checkedAt: 0, fingerprint: null, warnedAt: 0 }
    this.expiry.set(file, st)
    if (fp !== st.fingerprint || this.now() - st.checkedAt > 3600_000) {
      const { expiresAt } = await port.authSession()
      st.expiresAt = expiresAt ? Date.parse(expiresAt) : null
      st.checkedAt = this.now()
      st.fingerprint = fp
    }
    const exp = st.expiresAt
    if (exp === null || !Number.isFinite(exp)) return
    const left = exp - this.now()
    if (left > EXPIRY_WARN_MS) return
    const when = new Date(exp).toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
    const rel = left <= 0 ? 'has EXPIRED' : `expires ${when} (in ${humanDuration(left)})`
    const shown = path.join(path.basename(path.dirname(file)), path.basename(file))
    const channels = this.cfg.channels.filter((ch) => this.clientFor(ch).tokenFile === file).map((ch) => ch.id)
    if (this.now() - st.warnedAt > 3600_000) {
      st.warnedAt = this.now()
      this.log(`[expiry] WARNING: the bridge's tm8 token in ${shown} (channels ${channels.join(', ')}) ${rel}. Put a new one in ${shown} (OPERATIONS.md › token rotation).`)
    }
    const kvKey = `expiry-notice:${fp}`
    if (this.store.getKv(kvKey)) return
    const ch = this.cfg.channels.find((c) => this.cfg.ownerJids.includes(c.jid))
    if (!ch) return
    const what = file === this.cfg.tm8.tokenFile ? 'the tm8 link token' : `the tm8 token for ${channels.join(', ')}`
    const text = `heads-up: ${what} ${rel}. Put a new token in wa-bridge/${shown} (no restart needed).`
    if (await this.sendBridge(ch, text, null)) this.store.setKv(kvKey, new Date(this.now()).toISOString())
  }

  // ---------------------------------------------------------------- operator test hook

  /** Admin token for /admin/*; set by main from data/admin-token. */
  adminToken: string | null = null

  /**
   * Feed a synthetic owner message through the normal inbound path (log → loop guard → routing), as if the owner had
   * typed it in the channel. Lets the E2E run without anyone typing. Nothing is sent to WhatsApp for it except replies.
   */
  async injectTest(body: any) {
    let text = typeof body?.text === 'string' ? body.text : ''
    // Optional media fixture: {"media": {"kind": "image", "mime": "image/png", "file_name": "x.png", "data_base64": "..."}};
    // "text" is then the caption.
    let media: InboundMedia | null = null
    if (body?.media) {
      const md = body.media
      const kinds: MediaKind[] = ['image', 'document', 'video', 'audio', 'sticker']
      if (!kinds.includes(md.kind)) throw new HttpError(400, `media.kind must be one of ${kinds.join(', ')}`)
      if (typeof md.data_base64 !== 'string' || !md.data_base64) throw new HttpError(400, 'media.data_base64 is required')
      const data = Buffer.from(md.data_base64, 'base64')
      const fileName = typeof md.file_name === 'string' ? safeFileName(md.file_name, 'file') : null
      media = {
        kind: md.kind, mime: typeof md.mime === 'string' ? md.mime : null, fileName, caption: text.trim() || null, size: data.length, ref: null, data,
        durationSec: typeof md.duration_sec === 'number' ? md.duration_sec : null, ptt: !!md.ptt,
      }
      text = mediaPlaceholder(md.kind, media.caption, fileName, media)
      // Audio has no caption; "text" (e.g. "@tm8 …") can't route it, so an audio fixture should quote a bridge message.
    }
    if (!text.trim()) throw new HttpError(400, 'text is required')
    const ch = body?.channel ? this.channelById(String(body.channel)) : this.cfg.channels[0]
    if (!ch) throw new HttpError(400, 'no channels configured')
    const id = `${TEST_PREFIX}${crypto.randomUUID().replace(/-/g, '').slice(0, 16).toUpperCase()}`
    const owner = this.cfg.ownerJids
    await this.onInbound({
      id, chatJid: ch.jid, chatAltJid: null, fromMe: true,
      senderJid: owner.find((j) => j.endsWith('@s.whatsapp.net')) ?? owner[0] ?? null,
      senderAltJid: owner.find((j) => j.endsWith('@lid')) ?? null,
      senderName: typeof body?.sender_name === 'string' ? body.sender_name : 'owner (injected test)',
      text, kind: media ? 'media' : 'text', media,
      quotedId: typeof body?.quoted_wa_msg_id === 'string' ? body.quoted_wa_msg_id : null,
      mentionedJids: [], ts: Math.floor(this.now() / 1000),
      key: { remoteJid: ch.jid, id, fromMe: true }, message: { conversation: text },
    })
    return { wa_msg_id: id, routes: this.store.routesFor(id).map((r) => ({ target: r.target_name, status: r.status })) }
  }

  // ---------------------------------------------------------------- watchdog

  async watchdogTick() {
    const overdue = this.store.overdueRoutes(this.now() - this.cfg.watchdogMinutes * 60_000)
    for (const r of overdue) {
      this.store.setRouteStatus(r.id, 'warned')
      const ch = this.cfg.channels.find((c) => c.id === r.channel_id)
      if (!ch) continue
      // Only the ⚠️ reaction: a "no reply yet" text in the group is filler (Bhargav, 19 Oct).
      await this.reactSafe(ch, r.wa_msg_id, '⚠️')
      this.log(`[watchdog] ${r.wa_msg_id} in ${ch.id}: no reply from ${r.target_name} after ${this.cfg.watchdogMinutes} min`)
    }
    this.store.expireIdempotencyKeys()
    await this.retryMedia().catch((e) => this.log(`[media] retry: ${(e as Error).message}`))
  }

  // ---------------------------------------------------------------- reads

  history(ch: ChannelConfig, q: { before?: string; limit?: string }) {
    const limit = clampInt(q.limit, 50, 1, 200)
    const rows = this.store.history(ch.id, limit, q.before || undefined)
    return {
      messages: rows.reverse().map(this.publicMessage),
      next_before: rows.length === limit ? rows[0]?.wa_msg_id : null,
    }
  }

  search(ch: ChannelConfig, q: { q?: string; from?: string; since?: string; limit?: string }) {
    if (!q.q?.trim()) throw new HttpError(400, 'q is required')
    const limit = clampInt(q.limit, 20, 1, 200)
    let since: number | undefined
    if (q.since) {
      since = /^\d+$/.test(q.since) ? Number(q.since) : Math.floor(Date.parse(q.since) / 1000)
      if (!Number.isFinite(since)) throw new HttpError(400, 'since must be unix seconds or an ISO date')
    }
    return { messages: this.store.search(ch.id, q.q, { from: q.from || undefined, since, limit }).map(this.publicMessage) }
  }

  message(ch: ChannelConfig, id: string) {
    const m = this.store.getMessage(id)
    if (!m || m.channel_id !== ch.id) throw new HttpError(404, 'no such message in this group')
    const chain: ReturnType<typeof this.publicMessage>[] = []
    let cur = m.quoted_wa_msg_id ? this.store.getMessage(m.quoted_wa_msg_id) : undefined
    for (let i = 0; cur && cur.channel_id === ch.id && i < 20; i++) {
      chain.push(this.publicMessage(cur))
      cur = cur.quoted_wa_msg_id ? this.store.getMessage(cur.quoted_wa_msg_id) : undefined
    }
    return { message: this.publicMessage(m), quote_chain: chain }
  }

  publicMessage = (m: MessageRow) => {
    const md = this.store.getMedia(m.wa_msg_id)
    return {
      wa_msg_id: m.wa_msg_id,
      ts: m.ts,
      time: new Date(m.ts * 1000).toISOString(),
      from: m.from_bridge ? (m.by_name ?? 'bridge') : (m.sender_name ?? m.sender_jid),
      from_bridge: !!m.from_bridge,
      by_name: m.by_name,
      text: m.text,
      quoted_wa_msg_id: m.quoted_wa_msg_id,
      ...(md
        ? {
            media: {
              kind: md.kind, mime: md.mime, size: md.size ?? md.declared_size, file_name: md.file_name, caption: md.caption,
              status: md.status, tm8_file_id: md.tm8_file_id, url: `/media/${encodeURIComponent(m.wa_msg_id)}`,
              ...(isAudio(md.kind, md.mime)
                ? {
                    duration_sec: md.duration_sec, voice_note: !!md.ptt,
                    transcript: md.transcript_status
                      ? { status: md.transcript_status, text: md.transcript, lang: md.transcript_lang, provider: md.transcript_provider, error: md.transcript_error }
                      : null,
                  }
                : {}),
            },
          }
        : {}),
    }
  }

  names(ch: ChannelConfig) {
    const main = this.mainName(ch)
    return {
      names: this.store.namesIn(ch.id).map((n) => ({
        name: n.name, title: n.title, display: displayName(n), kind: n.kind, teammate: n.teammate, status: n.status, parent_name: n.parent_name,
        main: n.entity_id === main?.entity_id, tm8_id: n.entity_id,
      })),
    }
  }

  health() {
    return {
      ok: true,
      wa: { state: this.waState, connected: this.wa.connected(), me: [...this.ownJids] },
      // Top level: the global token (default space). Each channel has its own tm8 block below.
      tm8: { configured: this.tm8.configured(), token_expires_at: iso(this.tokenExpiresAt), last_poll_at: iso(this.lastPoll.at), last_poll_ok: this.lastPoll.ok, last_poll_error: this.lastPoll.error },
      queue_depth: this.store.queued().length,
      channels: this.cfg.channels.map((c) => {
        const row = this.store.channel(c.id)
        const cl = this.clientFor(c)
        const poll = this.channelPoll.get(c.id)
        return {
          id: c.id, main_chat_id: row.main_chat_id, epoch: row.epoch, live_names: this.store.namesIn(c.id).filter((n) => n.status === 'live').length,
          tm8: {
            space_id: cl.spaceId, token_file: path.basename(cl.tokenFile), via_link: cl.viaLink, configured: cl.port.configured(),
            token_expires_at: iso(this.expiry.get(cl.tokenFile)?.expiresAt ?? null),
            last_poll_at: iso(poll?.at ?? null), last_poll_ok: poll?.ok ?? false, last_poll_error: poll?.error ?? null,
          },
        }
      }),
    }
  }
}


function clampInt(v: string | undefined, dflt: number, min: number, max: number) {
  const n = v === undefined || v === '' ? dflt : Number.parseInt(v, 10)
  if (!Number.isFinite(n)) throw new HttpError(400, 'limit must be a number')
  return Math.min(max, Math.max(min, n))
}

/** The fallback relay looks at turns for messages routed in the last 30 minutes, over the newest 20 chat messages. */
const RELAY_WINDOW_MS = 30 * 60_000
const RELAY_FETCH = 20
const iso = (t: number | null) => (t === null ? null : new Date(t).toISOString())
const EXPIRY_WARN_MS = 3 * 24 * 3600_000
function humanDuration(ms: number) {
  const h = Math.round(ms / 3600_000)
  return h >= 48 ? `${Math.round(h / 24)} days` : `${h} hours`
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
/** Wait for `p`, but no longer than `ms` (the timer is cleared either way). */
async function within(p: Promise<unknown>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined
  await Promise.race([p, new Promise((r) => (timer = setTimeout(r, ms)))])
  clearTimeout(timer)
}
/** Transcripts longer than this are cut in envelopes (the full text is in /message and the log). */
const TRANSCRIPT_ENVELOPE_MAX = 6000
const clip = (s: string, max: number, more: string) => (s.length <= max ? s : s.slice(0, max) + more)

export { RESERVED }
