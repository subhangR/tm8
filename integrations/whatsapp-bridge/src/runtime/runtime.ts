// The WhatsApp connector runtime (§2.5, D7): every linked number on this node on one process, speaking the connector
// protocol to tm8-server. It routes nothing and stores nothing but each number's sealed keys; the server owns the rest.
import path from 'node:path'
import { TooLargeError } from '../media.js'
import { OutboundRefused } from './allowlist.js'
import { RuntimeConnection, type Emit, type SocketFactory } from './connection.js'
import { PROTOCOL_VERSION, WHATSAPP_CAPABILITIES, type HeartbeatFrame, type AllowlistFrame, type HelloReply, type RuntimeFrames, type RuntimeRoute, type ServerFrame } from './protocol.js'
import { parseStateKey } from './sealed-auth.js'

/** How the runtime reaches the server; `post` answers with the server's JSON reply. */
export interface ServerLink {
  post<R extends RuntimeRoute>(route: R, frame: RuntimeFrames[R]): Promise<unknown>
}

export const HEARTBEAT_MS = 30_000
const CONNECTION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export class Runtime {
  readonly connections = new Map<string, RuntimeConnection>()
  /**
   * The newest allowlist pushed for a connection not running yet (its `connect` still queued behind a slow frame).
   * Allowlists jump the queue, so this is held and applied when the connection is made, and the newer list wins.
   */
  private pendingAllowlists = new Map<string, AllowlistFrame>()

  constructor(
    private o: { runtimeId: string; dataDir: string; link: ServerLink; log: (m: string) => void; socketFactory?: SocketFactory; logLevel?: string },
  ) {}

  private emit: Emit = (route, frame) => this.o.link.post(route, frame)

  private connection(connectionId: string, stateKey: string, authFlow?: Extract<ServerFrame, { type: 'connect' }>['authFlow']): RuntimeConnection {
    if (!CONNECTION_ID.test(connectionId)) throw new Error(`bad connection id ${JSON.stringify(connectionId)}`)
    let c = this.connections.get(connectionId)
    if (!c) {
      c = new RuntimeConnection(connectionId, {
        authDir: path.join(this.o.dataDir, 'bridges', connectionId),
        stateKey: parseStateKey(stateKey),
        emit: this.emit,
        log: this.o.log,
        authFlow,
        socketFactory: this.o.socketFactory,
        logLevel: this.o.logLevel,
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
    const reply = (await this.o.link.post('hello', { provider: 'whatsapp', version: PROTOCOL_VERSION, runtimeId: this.o.runtimeId, capabilities: WHATSAPP_CAPABILITIES })) as HelloReply
    const wanted = new Set<string>()
    for (const r of reply?.connections ?? []) {
      wanted.add(r.connectionId)
      const fresh = !this.connections.has(r.connectionId)
      const c = this.connection(r.connectionId, r.stateKey)
      c.applyAllowlist(r.allowlist)
      if (fresh) await c.start().catch((e) => this.o.log(`[wa ${r.connectionId}] start failed: ${(e as Error).message}`))
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
      if (existing && f.authFlow) {
        // Re-linking: drop the old socket and start over with the flow asked for.
        await existing.stop()
        this.connections.delete(f.connectionId)
      }
      const c = this.connection(f.connectionId, f.stateKey, f.authFlow)
      if (f.allowlist) c.applyAllowlist(f.allowlist)
      if (!existing || f.authFlow) await c.start()
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
      case 'react':
        try {
          const r = f.type === 'send' ? await c.send(f) : await c.react(f)
          await this.emit('sent', { outboxId: f.outboxId, connectionId: f.connectionId, externalMessageId: r.externalMessageId, message: r.message })
        } catch (e) {
          await this.settle(f.outboxId, f.connectionId, failure(e))
        }
        return
      case 'typing':
      case 'read':
        // Fire-and-forget frames: a refusal is counted by the guard and logged without content.
        try {
          if (f.type === 'typing') await c.typing(f)
          else await c.read(f)
        } catch (e) {
          this.o.log(`[${f.type} ${f.connectionId}] ${(e as Error).message}`)
        }
        return
      case 'conversation.list':
        try {
          await this.emit('conversations', { requestId: f.requestId, connectionId: f.connectionId, items: await c.listConversations() })
        } catch (e) {
          await this.emit('conversations', { requestId: f.requestId, connectionId: f.connectionId, error: (e as Error).message })
        }
        return
      case 'group.create':
      case 'group.add':
        try {
          const g = f.type === 'group.create' ? await c.createGroup(f) : await c.addToGroup(f)
          await this.emit('group', { requestId: f.requestId, connectionId: f.connectionId, ...g })
        } catch (e) {
          await this.emit('group', { requestId: f.requestId, connectionId: f.connectionId, error: (e as Error).message })
        }
        return
      case 'media.fetch':
        try {
          const m = await c.fetchMedia(f)
          await this.emit('media', { requestId: f.requestId, mime: m.mime, data: m.data.toString('base64') })
        } catch (e) {
          await this.emit('media', { requestId: f.requestId, error: (e as Error).message, ...(e instanceof TooLargeError ? { tooLarge: true } : {}) })
        }
        return
    }
  }

  private settle(outboxId: string, connectionId: string, failed: { reason: string; retryable: boolean }) {
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

/** An outbound failure as the outbox's words: refusals and oversize are permanent, a dropped socket is retryable. */
export function failure(e: unknown): { reason: string; retryable: boolean } {
  if (e instanceof OutboundRefused) return { reason: e.reason, retryable: false }
  if (e instanceof TooLargeError) return { reason: 'too_large', retryable: false }
  const msg = (e as Error)?.message ?? String(e)
  if (/not connected|connection closed|timed out/i.test(msg)) return { reason: 'whatsapp_unavailable', retryable: true }
  return { reason: msg.slice(0, 200), retryable: false }
}
