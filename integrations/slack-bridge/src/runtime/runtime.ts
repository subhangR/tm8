// The Slack connector runtime (§2.5, D7): every Slack app install on this node on one process, speaking the connector
// protocol v4 to tm8-server as provider 'slack'. It routes nothing and stores nothing but each install's sealed
// tokens; the server owns the rest.
import path from 'node:path'
import { OutboundRefused } from './allowlist.js'
import { SlackConnection, type Emit, type MediaStream } from './connection.js'
import { PermanentError, TooLargeError } from './errors.js'
import { PROTOCOL_VERSION, SLACK_CAPABILITIES, type AllowlistFrame, type HeartbeatFrame, type HelloReply, type RuntimeFrames, type RuntimeRoute, type ServerFrame } from './protocol.js'
import { parseStateKey } from './sealed-auth.js'
import { SlackApi, SlackApiError, isRetryable } from './slack-api.js'

/** How the runtime reaches the server; `post` answers with the server's JSON reply. */
export interface ServerLink {
  post<R extends RuntimeRoute>(route: R, frame: RuntimeFrames[R]): Promise<unknown>
  openMedia?(input: { outboxId: string; connectionId: string; fileEntityId: string }): Promise<MediaStream>
}

export const HEARTBEAT_MS = 30_000
const CONNECTION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type RuntimeOptions = {
  runtimeId: string
  /** Sealed tokens live under <stateDir>/bridges/<connectionId>/. */
  stateDir: string
  link: ServerLink
  log: (m: string) => void
  api?: SlackApi
  /** Per-connection tuning, for tests. */
  tuning?: { pingMs?: number; helloTimeoutMs?: number; backoffMs?: (n: number) => number; userTtlMs?: number; sharePollMs?: number }
}

type Failed = { reason: string; retryable: boolean; retryAfterSec?: number }

export class Runtime {
  readonly connections = new Map<string, SlackConnection>()
  readonly api: SlackApi
  private receipts = new Map<string, { externalMessageId: string; message: unknown }>()
  private outbound = new Map<string, Promise<void>>()
  /** The newest allowlist pushed for a connection not running yet; applied when it is made (allowlists jump the queue). */
  private pendingAllowlists = new Map<string, AllowlistFrame>()
  /** Which connection runs each Slack app (one per app: Socket Mode splits an app's events across its sockets). */
  private apps = new Map<string, string>()

  constructor(private o: RuntimeOptions) {
    this.api = o.api ?? new SlackApi()
  }

  /** One in-order delivery chain per connection for the frames whose LAST arrival wins on the server. */
  private ordered = new Map<string, Promise<unknown>>()

  /**
   * Frames up to the server. `state` and `conversation-state` go one at a time per connection, in the order they were
   * made: the server keeps whichever it applies last, so a slow `connecting` POST overtaken by the `logged_out` right
   * behind it would leave the connection showing `connecting` forever. The chain is per connection id, not per
   * SlackConnection, so a restart's `offline` and the new `connecting` stay in order too. Everything else is unordered.
   */
  private emit: Emit = (route, frame) => {
    if (route !== 'state' && route !== 'conversation-state') return this.o.link.post(route, frame)
    const id = (frame as { connectionId: string }).connectionId
    const next = (this.ordered.get(id) ?? Promise.resolve()).catch(() => {}).then(() => this.o.link.post(route, frame))
    this.ordered.set(id, next)
    void next.catch(() => {}).finally(() => {
      if (this.ordered.get(id) === next) this.ordered.delete(id)
    })
    return next
  }

  private connection(connectionId: string, stateKey: string): SlackConnection {
    if (!CONNECTION_ID.test(connectionId)) throw new Error(`bad connection id ${JSON.stringify(connectionId)}`)
    let c = this.connections.get(connectionId)
    if (!c) {
      c = new SlackConnection(connectionId, {
        dir: path.join(this.o.stateDir, 'bridges', connectionId),
        stateKey: parseStateKey(stateKey),
        api: this.api,
        emit: this.emit,
        log: this.o.log,
        ...this.o.tuning,
        claimApp: (app, id) => {
          const holder = this.apps.get(app)
          if (holder && holder !== id && this.connections.has(holder)) return false
          this.apps.set(app, id)
          return true
        },
        releaseApp: (app, id) => {
          if (this.apps.get(app) === id) this.apps.delete(app)
        },
        openMedia: (input) => {
          if (!this.o.link.openMedia) throw new Error('runtime attachment streaming is unavailable')
          return this.o.link.openMedia(input)
        },
      })
      this.connections.set(connectionId, c)
      const pending = this.pendingAllowlists.get(connectionId)
      this.pendingAllowlists.delete(connectionId)
      if (pending) c.applyAllowlist(pending)
    }
    return c
  }

  /**
   * Says hello and takes the server's whole truth: the connections to run and their allowlists, applied before any
   * socket opens so nothing is read before the list is known. Called on start and on every reconnect to the server.
   */
  async hello(): Promise<void> {
    const reply = (await this.o.link.post('hello', { provider: 'slack', version: PROTOCOL_VERSION, runtimeId: this.o.runtimeId, capabilities: SLACK_CAPABILITIES })) as HelloReply
    const wanted = new Set<string>()
    for (const r of reply?.connections ?? []) {
      wanted.add(r.connectionId)
      const fresh = !this.connections.has(r.connectionId)
      let c: SlackConnection
      try {
        c = this.connection(r.connectionId, r.stateKey)
      } catch (e) {
        this.o.log(`[slack ${r.connectionId}] refused: ${(e as Error).message}`)
        continue
      }
      c.applyAllowlist(r.allowlist)
      if (fresh) await c.start().catch((e) => this.o.log(`[slack ${r.connectionId}] start failed: ${(e as Error).message}`))
    }
    for (const [id, c] of this.connections) {
      if (wanted.has(id)) continue
      await c.stop()
      this.connections.delete(id)
    }
  }

  async onFrame(f: ServerFrame): Promise<void> {
    if (f.type === 'connect') {
      const existing = this.connections.get(f.connectionId)
      // New tokens, or a connection that gave up (bad or missing tokens): start over.
      const restart = !!existing && (!!f.credential || existing.status === 'logged_out')
      if (restart) {
        await existing!.stop()
        this.connections.delete(f.connectionId)
      }
      const c = this.connection(f.connectionId, f.stateKey)
      if (f.allowlist) c.applyAllowlist(f.allowlist)
      if (!existing || restart) await c.start(f.credential)
      return
    }
    const c = this.connections.get(f.connectionId)
    if (!c) {
      if (f.type === 'allowlist') {
        const held = this.pendingAllowlists.get(f.connectionId)
        if (CONNECTION_ID.test(f.connectionId) && (!held || f.version >= held.version)) {
          this.pendingAllowlists.delete(f.connectionId)
          this.pendingAllowlists.set(f.connectionId, f)
          while (this.pendingAllowlists.size > 100) this.pendingAllowlists.delete(this.pendingAllowlists.keys().next().value!)
        }
        return
      }
      if (f.type === 'send' || f.type === 'react') await this.settle(f.outboxId, f.connectionId, { reason: 'unknown_connection', retryable: false })
      else if (f.type === 'conversation.list') await this.emit('conversations', { requestId: f.requestId, connectionId: f.connectionId, error: 'unknown_connection' })
      else if (f.type === 'media.fetch') await this.emit('media', { requestId: f.requestId, error: 'unknown_connection' })
      else if (f.type === 'group.create' || f.type === 'group.add') await this.emit('group', { requestId: f.requestId, connectionId: f.connectionId, error: 'unknown_connection' })
      return
    }
    switch (f.type) {
      case 'allowlist': {
        const r = c.applyAllowlist(f)
        if (r.applied) this.o.log(`[allowlist ${f.connectionId}] v${f.version}: ${f.conversationIds.length} connected (+${r.added.length} -${r.removed.length})`)
        return
      }
      case 'disconnect':
        await c.stop({ logout: f.logout })
        this.connections.delete(f.connectionId)
        return
      case 'send':
      case 'react': {
        const active = this.outbound.get(f.outboxId)
        if (active) return active // reconnects can replay while the first upload is still running
        const pending = this.sendOutbound(c, f)
        this.outbound.set(f.outboxId, pending)
        try { await pending } finally { this.outbound.delete(f.outboxId) }
        return
      }
      case 'typing':
      case 'read':
        // Slack bots have neither (SLACK_CAPABILITIES): nothing to do, nothing to refuse.
        return
      case 'conversation.list':
        try {
          await this.emit('conversations', { requestId: f.requestId, connectionId: f.connectionId, items: await c.listConversations() })
        } catch (e) {
          await this.emit('conversations', { requestId: f.requestId, connectionId: f.connectionId, error: errorText(e) })
        }
        return
      case 'group.create':
      case 'group.add':
        await this.emit('group', { requestId: f.requestId, connectionId: f.connectionId, error: 'Slack bridges cannot create channels or add people; do it in Slack.' })
        return
      case 'media.fetch':
        try {
          const m = await c.fetchMedia(f)
          await this.emit('media', { requestId: f.requestId, mime: m.mime, data: m.data.toString('base64') })
        } catch (e) {
          await this.emit('media', { requestId: f.requestId, error: errorText(e), ...(e instanceof TooLargeError ? { tooLarge: true } : {}) })
        }
        return
    }
  }

  private async sendOutbound(c: SlackConnection, f: Extract<ServerFrame, { type: 'send' | 'react' }>): Promise<void> {
    const progress = () => this.emit('outbound-progress', { outboxId: f.outboxId, connectionId: f.connectionId })
    // The server admits one active row per connection: renew its lease while a large upload runs.
    const timer = setInterval(() => void progress().catch((e) => this.o.log(`[outbound] lease renewal failed: ${(e as Error).message}`)), 30_000)
    timer.unref()
    try {
      let r = this.receipts.get(f.outboxId)
      if (!r) {
        try {
          r = f.type === 'send' ? await c.send(f) : await c.react(f)
        } catch (e) {
          await this.settle(f.outboxId, f.connectionId, failure(e))
          return
        }
        this.receipts.set(f.outboxId, r)
        while (this.receipts.size > 1000) this.receipts.delete(this.receipts.keys().next().value!)
      }
      // Failure to deliver a success receipt is NOT a provider failure. A replay resends the receipt, not the message.
      await this.emit('sent', { outboxId: f.outboxId, connectionId: f.connectionId, ...r })
    } finally {
      clearInterval(timer)
    }
  }

  private settle(outboxId: string, connectionId: string, failed: Failed) {
    return this.emit('sent', { outboxId, connectionId, failed })
  }

  heartbeatFrame(): HeartbeatFrame {
    return {
      runtimeId: this.o.runtimeId,
      at: new Date().toISOString(),
      connections: [...this.connections.values()].map((c) => ({ connectionId: c.connectionId, status: c.status, dropped: { ...c.allowlist.dropped }, allowlistVersion: c.allowlist.version })),
    }
  }

  async heartbeat(): Promise<void> {
    await this.o.link.post('heartbeat', this.heartbeatFrame())
  }

  async stop(): Promise<void> {
    for (const c of this.connections.values()) await c.stop()
  }
}

function errorText(e: unknown): string {
  if (e instanceof SlackApiError) return e.detail
  return ((e as Error)?.message ?? String(e)).slice(0, 200)
}

/**
 * An outbound failure in the outbox's words. Refusals, oversize and Slack's "never" codes are permanent; a 429 is
 * retryable after Slack's Retry-After; Slack or the attachment stream being unavailable is retryable.
 */
export function failure(e: unknown): Failed {
  if (e instanceof OutboundRefused) return { reason: e.reason, retryable: false }
  if (e instanceof TooLargeError) return { reason: 'too_large', retryable: false }
  if (e instanceof PermanentError) return { reason: e.reason, retryable: false }
  if (e instanceof SlackApiError) {
    return { reason: e.detail, retryable: isRetryable(e.code), ...(e.retryAfterSec !== undefined ? { retryAfterSec: e.retryAfterSec } : {}) }
  }
  const msg = (e as Error)?.message ?? String(e)
  if (/attachment download failed: (HTTP (408|429|5[0-9]{2})|stream interrupted)|fetch failed/i.test(msg)) return { reason: msg.slice(0, 200), retryable: true }
  return { reason: msg.slice(0, 200), retryable: false }
}
