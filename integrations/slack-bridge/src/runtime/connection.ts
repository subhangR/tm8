// One Slack app install on the runtime: its tokens (sealed at rest), its Socket Mode socket, its allowlist.
// Inbound: every envelope is acked at once; one from a channel off the allowlist is counted and dropped on its channel
// id alone, before a single other field is read (D28). Outbound: every frame that touches a channel goes through
// `allowlist.check` first. The tokens are used to call Slack and for nothing else: never in a frame, log or error.
import crypto from 'node:crypto'
import type { Readable } from 'node:stream'
import { Allowlist, OutboundRefused, type OutboundKind } from './allowlist.js'
import { Egress, httpRequest, type HttpResponse } from './egress.js'
import { slackNameOf, unicodeOf } from './emoji.js'
import { PermanentError, TooLargeError } from './errors.js'
import type {
  CannotSendReason,
  ConnectCredential,
  ConnectionStatus,
  ConversationItem,
  InboundFrame,
  MediaRef,
  RuntimeFrames,
  RuntimeRoute,
  SenderRef,
  ServerFrame,
  SlackAccount,
} from './protocol.js'
import { SealedTokens, type SlackTokens } from './sealed-auth.js'
import { DEAD_TOKEN, LINK_REFUSED, SlackApiError, type SlackApi } from './slack-api.js'
import { SocketModeClient, type Envelope } from './socket-mode.js'
import { fromSlackText, splitMessage, toMrkdwn } from './text.js'

export type Emit = <R extends RuntimeRoute>(route: R, frame: RuntimeFrames[R]) => Promise<unknown>

/** An attachment stream from the server; `contentLength` when the server sent one (Slack's upload needs the length). */
export type MediaStream = Readable & { contentLength?: number | null }
export type OpenMedia = (input: { outboxId: string; connectionId: string; fileEntityId: string }) => Promise<MediaStream>

/** A Slack message ts ("1700000000.123456"). Anything else (a `cmd:` pseudo id) is never sent to Slack as one. */
const TS = /^\d{9,}\.\d{1,9}$/
const FILE_ID = /^F[A-Z0-9]+$/
const USER_ID = /^[UW][A-Z0-9]+$/
/** Slack's own ceiling for one file. */
const MAX_UPLOAD = 1024 * 1024 * 1024
const SEEN_CAP = 5000
/** users.conversations pages (of 200) read per workspace for the picker. */
const PICKER_PAGES = 50
const HELD_CAP = 2000

/** Message subtypes that are someone saying something; every other subtype is channel plumbing and skipped. */
const SAYS = new Set([undefined, 'bot_message', 'file_share', 'thread_broadcast', 'me_message'])
/** Events that carry a message, reaction or command: dropped off-list ones count as `messages`, the rest as `stanzas`. */
const MESSAGE_EVENTS = new Set(['message', 'app_mention', 'reaction_added', 'reaction_removed'])

type UserInfo = { name: string | null; email: string | null; avatarUrl: string | null; bot: boolean }

export type ConnectionOptions = {
  /** This connection's own directory; the sealed tokens live in it. */
  dir: string
  stateKey: Buffer
  api: SlackApi
  emit: Emit
  log: (m: string) => void
  openMedia?: OpenMedia
  /** Socket liveness ping, ms (default 30 s). */
  pingMs?: number
  /** Reconnect backoff after the n-th failure, ms. */
  backoffMs?: (failures: number) => number
  /** How long a users.info answer is trusted (default 1 h). */
  userTtlMs?: number
  /** How long to wait between files.info looks for an upload's message ts (default 1 s, 5 looks). */
  sharePollMs?: number
  /**
   * One live connection per Slack app on this runtime. Socket Mode spreads an APP's events over all of its open
   * sockets, so a second connection on the same app would get, ack and drop the first one's events. Answers false when
   * another connection holds the app.
   */
  claimApp?: (appKey: string, connectionId: string) => boolean
  releaseApp?: (appKey: string, connectionId: string) => void
}

/** The app an app-level token belongs to (`xapp-1-A0123ABC-…`), or a hash of the token when it has another shape. */
export function appKeyOf(appToken: string): string {
  const m = /^xapp-\d+-(A[A-Z0-9]+)-/.exec(appToken)
  return m ? `app:${m[1]}` : `token:${crypto.createHash('sha256').update(appToken).digest('hex').slice(0, 16)}`
}

export class SlackConnection {
  readonly allowlist = new Allowlist()
  status: ConnectionStatus = 'connecting'
  account: SlackAccount | null = null
  private tokens: SlackTokens | null = null
  private sealed: SealedTokens
  private appKey: string | null = null
  private socket: SocketModeClient | null = null
  private stopped = false
  private retryTimer: NodeJS.Timeout | null = null
  private failures = 0
  private users = new Map<string, { at: number; info: Promise<UserInfo | null> }>()
  /** Envelope event ids and channel:ts pairs already handled (Slack redelivers, and sends app_mention beside message). */
  private seen = new Set<string>()
  /** The reaction this runtime last put on a message, so the next one replaces it (WhatsApp keeps one per sender). */
  private held = new Map<string, string>()

  constructor(readonly connectionId: string, private o: ConnectionOptions) {
    this.sealed = new SealedTokens(o.dir, o.stateKey)
  }

  connected(): boolean {
    return !!this.tokens && !!this.socket?.live
  }

  private setStatus(status: ConnectionStatus, detail: string | null = null) {
    this.status = status
    const linked = status === 'linked' && this.account
    void this.o.emit('state', {
      connectionId: this.connectionId,
      status,
      detail: detail === null ? null : detail.slice(0, 500),
      ...(linked ? { self: { id: this.account!.botUserId, lid: null }, account: this.account! } : {}),
    }).catch(() => {})
  }

  /** Server-pushed allowlist. Channels that joined the list get their posting ability checked. */
  applyAllowlist(frame: { version: number; conversationIds: string[] }) {
    const r = this.allowlist.apply(frame)
    if (r.applied && this.connected()) for (const id of r.added) void this.refreshCanSend(id)
    return r
  }

  // ------------------------------------------------------------------------------------------------------------
  // lifecycle
  // ------------------------------------------------------------------------------------------------------------

  /**
   * Starts with a pasted credential (checked, then sealed) or with what is sealed here. Bad tokens end in
   * `logged_out` with Slack's error code as the detail; Slack being unreachable ends in `offline` and a retry.
   */
  async start(credential?: ConnectCredential): Promise<void> {
    if (this.stopped) return
    this.setStatus('connecting')
    let tokens: SlackTokens
    const pasted = !!credential
    if (credential) {
      if (credential.kind !== 'slack_tokens') return this.setStatus('logged_out', 'unsupported_credential')
      if (typeof credential.botToken !== 'string' || !credential.botToken.startsWith('xoxb-')) return this.setStatus('logged_out', 'not_allowed_token_type')
      if (typeof credential.appToken !== 'string' || !credential.appToken.startsWith('xapp-')) return this.setStatus('logged_out', 'app_token: not_allowed_token_type')
      tokens = { botToken: credential.botToken.trim(), appToken: credential.appToken.trim() }
    } else {
      const held = await this.sealed.read()
      if (this.stopped) return
      if (!held) return this.setStatus('logged_out', 'no_credential')
      tokens = held
    }
    let account: SlackAccount
    try {
      account = await this.authTest(tokens.botToken)
    } catch (e) {
      if (this.stopped) return
      const err = e instanceof SlackApiError ? e : new SlackApiError('network_error', 'auth.test')
      if (LINK_REFUSED.has(err.code)) {
        // A refused paste leaves whatever was sealed before alone; refused sealed tokens are worthless and go.
        if (!pasted) await this.sealed.wipe()
        return this.setStatus('logged_out', err.detail)
      }
      // Slack unreachable or failing: try again later with the same tokens (a paste stays in memory only until it checks out).
      this.failures++
      const delay = Math.max((err.retryAfterSec ?? 0) * 1000, (this.o.backoffMs ?? defaultBackoff)(this.failures))
      this.setStatus('offline', `${err.code}; retrying in ${Math.round(delay / 1000)} s`)
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null
        void this.start(credential).catch((x) => this.o.log(`[slack ${this.connectionId}] start failed: ${(x as Error).message}`))
      }, delay)
      this.retryTimer.unref?.()
      return
    }
    if (this.stopped) return
    this.failures = 0
    const appKey = appKeyOf(tokens.appToken)
    if (this.o.claimApp && !this.o.claimApp(appKey, this.connectionId)) {
      // Another connection runs this app here: refuse, and leave its seal (and any held here) alone.
      return this.setStatus('logged_out', 'app_already_connected')
    }
    this.appKey = appKey
    if (pasted) await this.sealed.write(tokens)
    if (this.stopped) return
    this.tokens = tokens
    this.account = account
    this.socket?.stop()
    const socket = new SocketModeClient({
      api: this.o.api,
      appToken: () => this.tokens?.appToken ?? '',
      log: (m) => this.o.log(`[slack ${this.connectionId}] ${m}`),
      pingMs: this.o.pingMs,
      backoffMs: this.o.backoffMs,
      ackPayload: (env) => this.ackPayload(env),
      onEnvelope: (env) => this.onEnvelope(env),
      onOpen: () => {
        this.setStatus('linked')
        this.o.log(`[slack ${this.connectionId}] linked to ${account.teamName} as @${account.botName}`)
        for (const id of this.allowlist.conversationIds()) void this.refreshCanSend(id)
      },
      onDrop: (detail) => {
        if (!this.stopped) this.setStatus('offline', detail)
      },
      onAuthError: (e) => void this.loggedOut(`app_token: ${e.detail}`),
    })
    this.socket = socket
    socket.start()
  }

  private async authTest(botToken: string): Promise<SlackAccount> {
    const { body, headers } = await this.o.api.call('auth.test', botToken)
    if (!body.bot_id && !String(body.user_id ?? '').length) throw new SlackApiError('not_allowed_token_type', 'auth.test')
    return {
      // An org-wide Enterprise Grid install may answer without a team (or with the org): fall back to the org id.
      teamId: String(body.team_id || body.enterprise_id || ''),
      teamName: String(body.team ?? ''),
      url: String(body.url ?? ''),
      enterpriseId: body.enterprise_id ? String(body.enterprise_id) : null,
      enterpriseName: body.enterprise_name ? String(body.enterprise_name) : null,
      isEnterpriseInstall: body.is_enterprise_install === true,
      botUserId: String(body.user_id ?? ''),
      botId: body.bot_id ? String(body.bot_id) : null,
      botName: String(body.user ?? ''),
      scopes: (headers.get('x-oauth-scopes') ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    }
  }

  /** Slack refused a held token (revoked, app uninstalled): stop, wipe the sealed bytes, say why. */
  private releaseApp() {
    if (this.appKey) this.o.releaseApp?.(this.appKey, this.connectionId)
    this.appKey = null
  }

  private async loggedOut(detail: string) {
    if (this.stopped) return
    this.socket?.stop()
    this.socket = null
    this.tokens = null
    this.releaseApp()
    await this.sealed.wipe()
    this.setStatus('logged_out', detail)
    this.o.log(`[slack ${this.connectionId}] logged out: ${detail}`)
  }

  async stop(o: { logout?: boolean } = {}) {
    this.stopped = true
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
    this.socket?.stop()
    this.socket = null
    this.releaseApp()
    if (o.logout) {
      // Removed: the tokens go even if the socket is down, so nothing of the install outlives it (D38).
      this.tokens = null
      await this.sealed.wipe()
      this.setStatus('logged_out', 'removed')
    } else {
      this.setStatus('offline', 'disconnected by the server')
    }
  }

  // ------------------------------------------------------------------------------------------------------------
  // inbound
  // ------------------------------------------------------------------------------------------------------------

  private once(key: string): boolean {
    if (this.seen.has(key)) return false
    this.seen.add(key)
    while (this.seen.size > SEEN_CAP) this.seen.delete(this.seen.values().next().value!)
    return true
  }

  /** The ack's response payload: an off-list slash command tells its invoker (only them) why nothing happens. */
  private ackPayload(env: Envelope): unknown {
    if (env.type === 'slash_commands' && !this.allowlist.allows(env.payload?.channel_id)) {
      return { text: "This channel isn't connected to tm8. A tm8 admin can bridge it under Settings → Bridges." }
    }
    return undefined
  }

  onEnvelope(env: Envelope): void {
    if (env.type === 'events_api') {
      const p = env.payload ?? {}
      if (p.event_id && !this.once(`event:${p.event_id}`)) return
      void this.onEvent(p.event ?? {}).catch((e) => this.o.log(`[slack ${this.connectionId}] inbound failed: ${(e as Error).message}`))
    } else if (env.type === 'slash_commands') {
      void this.onSlash(env.payload ?? {}).catch((e) => this.o.log(`[slack ${this.connectionId}] command failed: ${(e as Error).message}`))
    } else {
      // interactive and anything newer: acked, not used.
      this.allowlist.dropped.stanzas++
    }
  }

  /** The first thing done with any event: is its channel connected? If not, count it and stop (D28). */
  async onEvent(ev: any): Promise<void> {
    const channel = channelOf(ev)
    if (!this.allowlist.allows(channel)) {
      if (MESSAGE_EVENTS.has(ev.type)) this.allowlist.dropped.messages++
      else this.allowlist.dropped.stanzas++
      return
    }
    switch (ev.type) {
      case 'message':
      case 'app_mention':
        return this.onMessage(channel!, ev)
      case 'reaction_added':
      case 'reaction_removed':
        return this.onReaction(channel!, ev)
      case 'channel_rename':
      case 'group_rename':
        return this.conversationState(channel!, this.allowlist.cannotSendReason(channel!), { name: String(ev.channel?.name ?? '') || undefined, force: true })
      case 'channel_archive':
      case 'group_archive':
        return this.conversationState(channel!, 'not_a_member', { archived: true })
      case 'channel_unarchive':
      case 'group_unarchive':
        return this.refreshCanSend(channel!)
      case 'channel_left':
      case 'group_left':
        return this.conversationState(channel!, 'not_a_member')
      case 'member_left_channel':
        if (ev.user && ev.user === this.account?.botUserId) return this.conversationState(channel!, 'not_a_member')
        return
      case 'member_joined_channel':
        if (ev.user && ev.user === this.account?.botUserId) return this.refreshCanSend(channel!)
        return
    }
  }

  private isOwn(m: any): boolean {
    const a = this.account
    return !!a && ((!!m?.user && m.user === a.botUserId) || (!!m?.bot_id && m.bot_id === a.botId))
  }

  private async onMessage(channel: string, ev: any): Promise<void> {
    if (ev.subtype === 'message_changed') return this.onEdit(channel, ev)
    if (ev.subtype === 'message_deleted') return this.onDelete(channel, ev)
    if (!SAYS.has(ev.subtype) || ev.hidden || !ev.ts) return
    // `message` and `app_mention` both arrive for a message that mentions the bot: the first one wins.
    if (!this.once(`msg:${channel}:${ev.ts}`)) return
    if (this.isOwn(ev)) return // our own sends settle through `sent`, never as inbound
    await this.o.emit('inbound', await this.toInbound(channel, ev))
  }

  private async onEdit(channel: string, ev: any): Promise<void> {
    const m = ev.message
    if (!m?.ts || this.isOwn(m)) return
    if (m.subtype === 'tombstone') return this.onDelete(channel, { deleted_ts: m.ts, previous_message: ev.previous_message, event_ts: ev.event_ts })
    // A message_changed without `edited` is Slack's own bookkeeping (a reply count, an unfurl): not an edit.
    if (!m.edited?.ts) return
    if (!this.once(`edit:${channel}:${m.ts}:${m.edited.ts}`)) return
    const frame = await this.toInbound(channel, { ...m, channel })
    await this.o.emit('inbound', { ...frame, edit: { editedAt: Math.floor(Number(m.edited.ts)) } })
  }

  private async onDelete(channel: string, ev: any): Promise<void> {
    const ts = ev.deleted_ts ?? ev.previous_message?.ts
    if (!ts || !this.once(`del:${channel}:${ts}`)) return
    const prev = ev.previous_message ?? {}
    const root = prev.thread_ts && prev.thread_ts !== ts ? String(prev.thread_ts) : null
    await this.o.emit('inbound', {
      connectionId: this.connectionId,
      conversationId: channel,
      externalMessageId: String(ts),
      sender: { externalId: USER_ID.test(prev.user ?? '') ? prev.user : null, altId: null, name: null, fromMe: this.isOwn(prev) },
      body: '',
      kind: 'other',
      media: [],
      replyTo: null,
      mentions: [],
      thread: root ? { rootExternalMessageId: root } : null,
      deleted: true,
      ts: Math.floor(Number(ev.event_ts ?? ts)),
    })
  }

  private async onReaction(channel: string, ev: any): Promise<void> {
    if (ev.item?.type !== 'message' || !ev.item.ts || !ev.user) return
    if (ev.user === this.account?.botUserId) return
    const added = ev.type === 'reaction_added'
    const emoji = added ? unicodeOf(String(ev.reaction ?? '')) : ''
    await this.o.emit('inbound', {
      connectionId: this.connectionId,
      conversationId: channel,
      externalMessageId: `reaction:${ev.item.ts}:${ev.user}:${ev.event_ts ?? ''}`,
      sender: await this.sender({ user: ev.user }),
      body: emoji,
      kind: 'other',
      media: [],
      replyTo: null,
      mentions: [],
      reaction: { externalMessageId: String(ev.item.ts), emoji },
      ts: Math.floor(Number(ev.event_ts ?? ev.item.ts)),
    })
  }

  /** `/tm8 <command> <args>` → body `/<command> <args>`, as a WhatsApp `/work` reads. No thread: answered in the channel. */
  private async onSlash(p: any): Promise<void> {
    const channel = p.channel_id
    if (!this.allowlist.allows(channel)) {
      this.allowlist.dropped.messages++
      return
    }
    if (!p.trigger_id) return
    const raw = String(p.text ?? '').trim()
    const { body: text, mentions } = await this.render(raw)
    const word = /^\S+/.exec(text)?.[0] ?? ''
    const command = word.replace(/^\//, '').toLowerCase() || 'help'
    const args = text.slice(word.length).trim()
    await this.o.emit('inbound', {
      connectionId: this.connectionId,
      conversationId: channel,
      externalMessageId: `cmd:${p.trigger_id}`,
      sender: await this.sender({ user: p.user_id, user_profile: { display_name: p.user_name } }),
      body: `/${command}${args ? ` ${args}` : ''}`,
      kind: 'text',
      media: [],
      replyTo: null,
      mentions,
      slashCommand: { command: String(p.command ?? '/tm8'), text: raw },
      ts: Math.floor(Date.now() / 1000),
    })
  }

  private async toInbound(channel: string, m: any): Promise<InboundFrame> {
    const { body, mentions } = await this.render(String(m.text ?? ''))
    const media: MediaRef[] = (Array.isArray(m.files) ? m.files : [])
      .filter((f: any) => FILE_ID.test(f?.id ?? '') && f.mode !== 'tombstone' && f.mode !== 'hidden_by_limit')
      .map(mediaRefOf)
    const root = m.thread_ts && m.thread_ts !== m.ts ? String(m.thread_ts) : null
    return {
      connectionId: this.connectionId,
      conversationId: channel,
      externalMessageId: String(m.ts),
      sender: await this.sender(m),
      body,
      kind: media.length ? 'media' : body.trim() ? 'text' : 'other',
      media,
      replyTo: root ? { externalMessageId: root, senderExternalId: USER_ID.test(m.parent_user_id ?? '') ? m.parent_user_id : null, media: null } : null,
      mentions,
      thread: root ? { rootExternalMessageId: root } : null,
      ts: Math.floor(Number(m.ts)),
    }
  }

  /** Readable text: mentioned users by their display names (looked up and cached), the ids kept in `mentions`. */
  private async render(text: string): Promise<{ body: string; mentions: string[] }> {
    const ids = [...new Set([...text.matchAll(/<@([UW][A-Z0-9]+)>/g)].map((x) => x[1]!))]
    const names = new Map<string, string | null>()
    await Promise.all(ids.map(async (id) => names.set(id, (await this.user(id))?.name ?? null)))
    return fromSlackText(text, (id) => names.get(id) ?? null)
  }

  private async sender(m: any): Promise<SenderRef> {
    if (!USER_ID.test(m.user ?? '')) {
      // An app posting without a bot user (incoming webhooks, legacy bots): no person to name or link.
      return { externalId: null, altId: null, name: m.username ?? m.bot_profile?.name ?? null, fromMe: false, email: null, avatarUrl: null, bot: true }
    }
    const u = await this.user(m.user)
    return {
      externalId: m.user,
      altId: null,
      name: u?.name ?? m.user_profile?.display_name ?? m.user_profile?.real_name ?? null,
      fromMe: false,
      email: u?.email ?? null,
      avatarUrl: u?.avatarUrl ?? null,
      bot: !!m.bot_id || m.subtype === 'bot_message' || !!u?.bot,
    }
  }

  /** users.info, cached for the TTL (misses too); a rate-limited or failed look is not cached. */
  private user(id: string): Promise<UserInfo | null> {
    const now = Date.now()
    const hit = this.users.get(id)
    if (hit && now - hit.at < (this.o.userTtlMs ?? 3_600_000)) return hit.info
    const token = this.tokens?.botToken
    if (!token) return Promise.resolve(null)
    const info = this.o.api.call('users.info', token, { user: id }).then(
      ({ body }): UserInfo => {
        const u = body.user ?? {}
        const p = u.profile ?? {}
        return {
          name: p.display_name || p.real_name || u.real_name || u.name || null,
          email: p.email || null,
          avatarUrl: p.image_192 || p.image_72 || null,
          bot: !!u.is_bot,
        }
      },
      (e: unknown) => {
        if (!(e instanceof SlackApiError) || e.code === 'ratelimited' || e.code === 'network_error') this.users.delete(id)
        return null
      },
    )
    this.users.set(id, { at: now, info })
    while (this.users.size > 5000) this.users.delete(this.users.keys().next().value!)
    return info
  }

  // ------------------------------------------------------------------------------------------------------------
  // outbound: every path starts with the guard
  // ------------------------------------------------------------------------------------------------------------

  private guard(conversationId: string, kind: OutboundKind): string {
    this.allowlist.check(conversationId, kind)
    if (!this.tokens) throw new SlackApiError('slack_not_connected', kind)
    return this.tokens.botToken
  }

  /** A Web API call with the bot token. A refused token logs the connection out; a lost channel is reported. */
  private async bot(method: string, params: Record<string, unknown>, conversationId?: string) {
    const token = this.tokens?.botToken
    if (!token) throw new SlackApiError('slack_not_connected', method)
    try {
      return await this.o.api.call(method, token, params)
    } catch (e) {
      if (e instanceof SlackApiError) {
        if (DEAD_TOKEN.has(e.code)) void this.loggedOut(e.detail)
        else if (conversationId && ['not_in_channel', 'channel_not_found', 'is_archived', 'team_access_not_granted'].includes(e.code)) {
          void this.conversationState(conversationId, 'not_a_member', e.code === 'is_archived' ? { archived: true } : {})
        }
      }
      throw e
    }
  }

  async send(f: Extract<ServerFrame, { type: 'send' }>): Promise<{ externalMessageId: string; message: unknown }> {
    if (f.poll) throw new PermanentError('polls_unsupported')
    const kind: OutboundKind = f.media ? 'media' : 'text'
    this.guard(f.conversationId, kind)
    // Only a real message ts names a thread; a `cmd:` pseudo id (a slash command) answers in the channel.
    const threadTs = f.threadTs && TS.test(f.threadTs) ? f.threadTs : undefined
    if (f.media) return this.sendFile(f, threadTs)
    const body = toMrkdwn(f.text ?? '')
    if (!body.trim()) throw new PermanentError('empty_message')
    const { params: voice, prefix } = this.voice(f.voice)
    const parts = splitMessage(prefix + body)
    const post = (text: string) => this.bot('chat.postMessage', { channel: f.conversationId, text, thread_ts: threadTs, ...voice, unfurl_links: false }, f.conversationId)
    const first = String((await post(parts[0]!)).body.ts)
    const all = [first]
    // The first part is the receipt. Later parts are retried here (a 429 mid-reply is likely); a part that still
    // fails is logged, never turned into a failed outbox row, which would post the first part twice.
    for (const part of parts.slice(1)) {
      let done = false
      for (let attempt = 0; attempt < 4 && !done; attempt++) {
        try {
          all.push(String((await post(part)).body.ts))
          done = true
        } catch (e) {
          const retryable = e instanceof SlackApiError && ['ratelimited', 'network_error', 'internal_error', 'service_unavailable', 'fatal_error', 'request_timeout'].includes(e.code)
          if (!retryable || attempt === 3) {
            this.o.log(`[slack ${this.connectionId}] part ${all.length + 1}/${parts.length} of outbox ${f.outboxId} not sent: ${(e as Error).message}`)
            break
          }
          await sleep(Math.min(30_000, ((e as SlackApiError).retryAfterSec ?? 1) * 1000))
        }
      }
      if (!done) break
    }
    return { externalMessageId: first, message: { channel: f.conversationId, ts: first, threadTs: threadTs ?? null, parts: all } }
  }

  /** files.getUploadURLExternal → upload the bytes → files.completeUploadExternal into the channel (and thread). */
  private async sendFile(f: Extract<ServerFrame, { type: 'send' }>, threadTs: string | undefined): Promise<{ externalMessageId: string; message: unknown }> {
    const m = f.media!
    let stream: MediaStream | undefined
    try {
      let source: Buffer | MediaStream
      let length: number
      if (m.fileEntityId) {
        if (!this.o.openMedia) throw new Error('runtime attachment streaming is unavailable')
        stream = await this.o.openMedia({ outboxId: f.outboxId, connectionId: f.connectionId, fileEntityId: m.fileEntityId })
        this.guard(f.conversationId, 'media') // it may have been paused during the fetch
        if (stream.contentLength != null && Number.isFinite(stream.contentLength)) {
          source = stream
          length = stream.contentLength
        } else {
          source = await collect(stream, MAX_UPLOAD)
          length = source.length
        }
      } else if (m.data !== undefined) {
        source = Buffer.from(m.data, 'base64')
        length = source.length
      } else {
        throw new Error('attachment has no stream reference or bytes')
      }
      if (length > MAX_UPLOAD) throw new TooLargeError(length, MAX_UPLOAD)
      if (length === 0) throw new PermanentError('empty_file')
      const fileName = m.fileName || (m.kind === 'image' ? 'image' : 'file')
      const up = (await this.bot('files.getUploadURLExternal', { filename: fileName, length }, f.conversationId)).body
      const url = String(up.upload_url ?? '')
      const fileId = String(up.file_id ?? '')
      if (!url || !fileId) throw new SlackApiError('no_upload_url', 'files.getUploadURLExternal')
      await uploadTo(this.o.api.egress, url, source, length, m.mime)
      this.guard(f.conversationId, 'media')
      // A file is always posted as the app (uploads take no username/icon). With a voice, the caption follows as its
      // own voiced message in the same place, so the words still come from their author.
      const { params: voice, prefix } = this.voice(f.voice)
      const caption = m.caption?.trim() ? toMrkdwn(m.caption) : ''
      const voiced = !!voice.username && !!caption
      const done = (await this.bot('files.completeUploadExternal', {
        files: [{ id: fileId, title: fileName }],
        channel_id: f.conversationId,
        thread_ts: threadTs,
        initial_comment: caption && !voiced ? prefix + caption : undefined,
      }, f.conversationId)).body
      const ts = shareTs(done.files?.[0], f.conversationId) ?? (await this.waitForShare(fileId, f.conversationId)) ?? `file:${fileId}`
      let captionTs: string | null = null
      if (voiced) {
        try {
          const parts = splitMessage(caption)
          captionTs = String((await this.bot('chat.postMessage', { channel: f.conversationId, text: parts[0], thread_ts: threadTs, ...voice, unfurl_links: false }, f.conversationId)).body.ts)
          for (const part of parts.slice(1)) await this.bot('chat.postMessage', { channel: f.conversationId, text: part, thread_ts: threadTs, ...voice, unfurl_links: false }, f.conversationId)
        } catch (e) {
          // The file is posted: failing the row now would post it twice. The lost caption is logged.
          this.o.log(`[slack ${this.connectionId}] caption of outbox ${f.outboxId} not sent: ${(e as Error).message}`)
        }
      }
      return { externalMessageId: ts, message: { channel: f.conversationId, ts, threadTs: threadTs ?? null, fileId, captionTs } }
    } finally {
      stream?.destroy()
    }
  }

  /** Slack shares an uploaded file asynchronously: look for the message it became, briefly. */
  private async waitForShare(fileId: string, channel: string): Promise<string | null> {
    for (let i = 0; i < 5; i++) {
      await sleep(this.o.sharePollMs ?? 1000)
      try {
        const ts = shareTs((await this.bot('files.info', { file: fileId })).body.file, channel)
        if (ts) return ts
      } catch {
        return null
      }
    }
    return null
  }

  /**
   * How a message is signed. With chat:write.customize granted, the author's name and icon replace the app's (no
   * prefix). Without it Slack would refuse or ignore them, so the message goes as the app with a `*Name:*` prefix, as
   * a WhatsApp message is signed. When Slack did not say which scopes it granted, customize is assumed.
   */
  private voice(v: Extract<ServerFrame, { type: 'send' }>['voice']): { params: Record<string, string>; prefix: string } {
    const params = voiceParams(v)
    if (!params.username) return { params: {}, prefix: '' }
    const scopes = this.account?.scopes ?? []
    if (!scopes.length || scopes.includes('chat:write.customize')) return { params, prefix: '' }
    return { params: {}, prefix: `*${params.username.replace(/[*_~`<>&]/g, '')}:* ` }
  }

  /**
   * reactions.add, replacing the reaction this runtime put on that message before (WhatsApp keeps one reaction per
   * sender, and the 427 progress set 📨 → 👀 → ✅ means "now this"). An empty emoji takes ours off.
   */
  async react(f: Extract<ServerFrame, { type: 'react' }>): Promise<{ externalMessageId: string; message: unknown }> {
    const ts = f.target.externalMessageId
    if (!TS.test(ts)) throw new PermanentError('not_reactable') // a `cmd:` slash command, or anything not a Slack message
    this.guard(f.conversationId, 'reaction')
    const name = f.emoji ? slackNameOf(f.emoji) : null
    if (f.emoji && !name) throw new PermanentError('unknown_emoji')
    const key = `${f.conversationId}:${ts}`
    const prev = this.held.get(key) ?? null
    if (name && name !== prev) {
      try {
        await this.bot('reactions.add', { channel: f.conversationId, timestamp: ts, name }, f.conversationId)
      } catch (e) {
        if (!(e instanceof SlackApiError && e.code === 'already_reacted')) throw e
      }
    }
    if (prev && prev !== name) {
      await this.bot('reactions.remove', { channel: f.conversationId, timestamp: ts, name: prev }, f.conversationId).catch((e) => {
        if (!(e instanceof SlackApiError && e.code === 'no_reaction')) this.o.log(`[slack ${this.connectionId}] reactions.remove failed: ${(e as Error).message}`)
      })
    }
    this.held.delete(key)
    if (name) this.held.set(key, name)
    while (this.held.size > HELD_CAP) this.held.delete(this.held.keys().next().value!)
    return { externalMessageId: `reaction:${ts}:${name ?? ''}`, message: { channel: f.conversationId, ts, name } }
  }

  /** Bytes of a file posted in a connected channel: files.info, then url_private with the bot token, under maxBytes. */
  async fetchMedia(f: Extract<ServerFrame, { type: 'media.fetch' }>): Promise<{ mime: string | null; data: Buffer }> {
    const token = this.guard(f.conversationId, 'media.fetch')
    if (!FILE_ID.test(f.handle)) {
      this.allowlist.dropped.outboundRefused++
      throw new OutboundRefused('not_connected', f.conversationId, 'media.fetch')
    }
    const file = (await this.bot('files.info', { file: f.handle })).body.file ?? {}
    // A handle must name a file shared in the channel asked about: one from elsewhere is refused like any off-list frame.
    const where = new Set<string>([...(file.channels ?? []), ...(file.groups ?? []), ...Object.keys(file.shares?.public ?? {}), ...Object.keys(file.shares?.private ?? {})])
    if (!where.has(f.conversationId)) {
      this.allowlist.dropped.outboundRefused++
      throw new OutboundRefused('not_connected', f.conversationId, 'media.fetch')
    }
    if (typeof file.size === 'number' && file.size > f.maxBytes) throw new TooLargeError(file.size, f.maxBytes)
    const url = String(file.url_private_download ?? file.url_private ?? '')
    if (!this.o.api.trustsFileHost(url)) throw new Error('file url is not a Slack url')
    // Slack may redirect a file to another of its hosts; the token follows only to a host it trusts.
    let res: HttpResponse | null = null
    let at = url
    for (let hop = 0; hop < 4; hop++) {
      try {
        res = await httpRequest(this.o.api.egress, at, { headers: { authorization: `Bearer ${token}` }, timeoutMs: 120_000 })
      } catch {
        throw new SlackApiError('network_error', 'url_private')
      }
      const next = res.headers.get('location')
      if (res.status < 300 || res.status >= 400 || !next) break
      res.body.resume()
      at = new URL(next, at).href
      if (!this.o.api.trustsFileHost(at)) throw new Error('file url redirected away from Slack')
    }
    if (!res || res.status < 200 || res.status >= 300) {
      res?.body.resume()
      throw new SlackApiError(`http_${res?.status ?? 0}`, 'url_private')
    }
    // A bad token gets Slack's sign-in page, not the file.
    const type = res.headers.get('content-type') ?? ''
    if (type.startsWith('text/html') && !String(file.mimetype ?? '').startsWith('text/html')) {
      res.body.resume()
      throw new SlackApiError('file_access_denied', 'url_private')
    }
    const data = await collect(res.body, f.maxBytes)
    return { mime: file.mimetype ?? (type || null), data }
  }

  // ------------------------------------------------------------------------------------------------------------
  // channels: the live picker list and posting rights
  // ------------------------------------------------------------------------------------------------------------

  /**
   * The picker's list: the channels the bot is in (public and private), fetched live and never cached (D28).
   * On an org-wide Enterprise Grid install the token spans workspaces and Slack's listing methods need a team_id:
   * the list is gathered per approved workspace (auth.teams.list). A channel shared between workspaces is listed once,
   * and a name used in more than one workspace (every one has a #general) is told apart by its workspace's name.
   */
  async listConversations(): Promise<ConversationItem[]> {
    if (!this.tokens) throw new Error('Slack is not connected')
    const workspaces = this.account?.isEnterpriseInstall ? await this.workspaces() : [null]
    const seen = new Map<string, { item: ConversationItem; workspace: string | null }>()
    const failed: { id: string; code: string }[] = []
    for (const ws of workspaces) {
      let cursor: string | undefined
      // The page budget is per workspace: a big one can't starve the ones after it.
      for (let page = 0; page < PICKER_PAGES; page++) {
        let body: Record<string, any>
        try {
          body = (await this.bot('users.conversations', { types: 'public_channel,private_channel', exclude_archived: true, limit: 200, cursor, team_id: ws?.id })).body
        } catch (e) {
          // On Grid one workspace failing (not granted, rate-limited, down) is that workspace's problem: skip it and
          // say so in the log; the rest of the org still lists. A workspace install has nothing to fall back on.
          if (!ws || !(e instanceof SlackApiError) || DEAD_TOKEN.has(e.code)) throw e
          failed.push({ id: ws.id, code: e.detail })
          break
        }
        for (const c of body.channels ?? []) {
          if (!c?.id || c.is_archived || seen.has(c.id)) continue
          seen.set(c.id, {
            item: { conversationId: c.id, kind: c.is_private ? 'private_channel' : 'channel', name: c.name ?? c.id, size: typeof c.num_members === 'number' ? c.num_members : null, canSend: true, reason: null },
            workspace: ws?.name ?? null,
          })
        }
        cursor = body.response_metadata?.next_cursor || undefined
        if (!cursor) break
        if (page === PICKER_PAGES - 1) this.o.log(`[slack ${this.connectionId}] picker: ${ws ? `workspace ${ws.id}` : 'workspace'} has more than ${PICKER_PAGES * 200} channels; the list is cut there`)
      }
    }
    if (failed.length) {
      this.o.log(`[slack ${this.connectionId}] picker: ${failed.length} of ${workspaces.length} workspaces skipped: ${failed.map((f) => `${f.id} ${f.code}`).join(', ')}`)
      // Every workspace failed: that is an error, not an empty org.
      if (failed.length === workspaces.length) throw new SlackApiError(failed[0]!.code, 'users.conversations')
    }
    const count = new Map<string, number>()
    for (const { item } of seen.values()) count.set(item.name, (count.get(item.name) ?? 0) + 1)
    return [...seen.values()]
      .map(({ item, workspace }) => ((count.get(item.name) ?? 0) > 1 && workspace ? { ...item, name: `${item.name} (${workspace})` } : item))
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  /** The workspaces an org-wide install was approved into (auth.teams.list, every page). */
  private async workspaces(): Promise<{ id: string; name: string }[]> {
    const out: { id: string; name: string }[] = []
    let cursor: string | undefined
    for (let page = 0; page < 50; page++) {
      const { body } = await this.bot('auth.teams.list', { limit: 100, cursor })
      for (const t of body.teams ?? []) if (t?.id) out.push({ id: String(t.id), name: String(t.name ?? t.id) })
      cursor = body.response_metadata?.next_cursor || undefined
      if (!cursor) break
    }
    return out
  }

  /** Learns whether the bot may post in a connected channel and tells the server when that changes. */
  async refreshCanSend(conversationId: string): Promise<void> {
    if (!this.tokens || !this.allowlist.allows(conversationId)) return
    try {
      const c = (await this.bot('conversations.info', { channel: conversationId }, conversationId)).body.channel ?? {}
      const reason: CannotSendReason | null = c.is_archived || c.is_member === false ? 'not_a_member' : null
      await this.conversationState(conversationId, reason, { archived: !!c.is_archived, name: c.name })
    } catch (e) {
      if (e instanceof SlackApiError && ['channel_not_found', 'team_access_not_granted'].includes(e.code)) return // already reported by bot()
      this.o.log(`[slack ${this.connectionId}] conversations.info for a connected channel failed: ${(e as Error).message}`)
    }
  }

  /** Records the bot's posting ability and sends conversation-state when it changed (or a rename forces it). */
  private async conversationState(conversationId: string, reason: CannotSendReason | null, o: { name?: string; archived?: boolean; force?: boolean } = {}) {
    if (!this.allowlist.allows(conversationId)) return
    const changed = this.allowlist.setCanSend(conversationId, reason)
    if (!changed && !o.force) return
    await this.o.emit('conversation-state', {
      connectionId: this.connectionId,
      conversationId,
      canSend: !reason,
      reason,
      ...(o.name ? { name: o.name } : {}),
      ...(o.archived !== undefined ? { archived: o.archived } : {}),
    })
  }
}

const defaultBackoff = (n: number) => Math.min(60_000, 1000 * 2 ** Math.min(n, 6))
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** The channel an event is about, wherever Slack put it. */
function channelOf(ev: any): string | null {
  if (typeof ev?.channel === 'string') return ev.channel
  if (typeof ev?.channel?.id === 'string') return ev.channel.id
  if (typeof ev?.item?.channel === 'string') return ev.item.channel
  if (typeof ev?.channel_id === 'string') return ev.channel_id
  return null
}

function mediaRefOf(f: any): MediaRef {
  const mime: string | null = f.mimetype ?? null
  const kind: MediaRef['kind'] = mime?.startsWith('image/') ? 'image' : mime?.startsWith('video/') ? 'video' : mime?.startsWith('audio/') ? 'audio' : 'document'
  return {
    kind,
    mime,
    fileName: f.name ?? null,
    caption: null,
    size: typeof f.size === 'number' ? f.size : null,
    ...(typeof f.duration_ms === 'number' ? { durationSec: Math.round(f.duration_ms / 1000) } : {}),
    ...(f.subtype === 'slack_audio' ? { ptt: true } : {}),
    handle: f.id,
  }
}

/** chat:write.customize: the author's name and icon instead of the app's. Slack takes only a public https icon. */
function voiceParams(v: Extract<ServerFrame, { type: 'send' }>['voice']): Record<string, string> {
  if (!v?.username?.trim()) return {}
  const out: Record<string, string> = { username: v.username.trim().slice(0, 80) }
  if (v.iconUrl && /^https:\/\//.test(v.iconUrl)) out.icon_url = v.iconUrl
  else if (v.iconEmoji && /^:[a-z0-9_+'-]+:$/.test(v.iconEmoji)) out.icon_emoji = v.iconEmoji
  return out
}

function shareTs(file: any, channel: string): string | null {
  const s = file?.shares?.public?.[channel] ?? file?.shares?.private?.[channel]
  const ts = Array.isArray(s) ? s[0]?.ts : null
  return typeof ts === 'string' && TS.test(ts) ? ts : null
}

async function collect(stream: Readable, max: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const c of stream) {
    total += (c as Buffer).length
    if (total > max) {
      stream.destroy()
      throw new TooLargeError(total, max)
    }
    chunks.push(c as Buffer)
  }
  return Buffer.concat(chunks)
}

/** POSTs the bytes to Slack's pre-signed upload URL (no token: the URL is the authority) with an exact length. */
function uploadTo(egress: Egress, url: string, source: Buffer | Readable, length: number, mime: string | undefined): Promise<void> {
  return httpRequest(egress, url, { method: 'POST', headers: { 'content-type': mime || 'application/octet-stream', 'content-length': length }, body: source, timeoutMs: 300_000 }).then(
    (res) => {
      res.body.resume()
      if (res.status < 200 || res.status >= 300) throw new SlackApiError(`http_${res.status}`, 'file upload')
    },
    (e: Error) => {
      throw /attachment download failed/.test(e.message) ? e : new SlackApiError('network_error', 'file upload')
    },
  )
}
