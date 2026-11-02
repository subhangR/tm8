// The runtime's line to tm8-server over loopback: frames up by POST /v2/bridge-runtime/<route>, frames down on one
// WebSocket at the node's single upgrade path, told apart by `?bridgeRuntime=<runtimeId>` (the PTY's `?sessionId` idiom).
// Both carry the runtime's `bridge_runtime` bearer. Nothing is queued to disk: a frame that can't be delivered after
// its retries is dropped and logged by route only, never by content.
import { Readable } from 'node:stream'
import type { RuntimeFrames, RuntimeRoute, ServerFrame } from './protocol.js'
import type { ServerLink } from './runtime.js'

const RETRY_MS = [1000, 2000, 4000, 8000, 16000]

export class HttpError extends Error {
  constructor(public status: number, body: string) {
    super(`server answered ${status}: ${body.slice(0, 200)}`)
  }
}

export class HttpWsLink implements ServerLink {
  private ws: WebSocket | null = null
  private closed = false
  private wsFailures = 0

  constructor(
    private o: {
      serverUrl: string
      runtimeId: string
      token: () => string
      log: (m: string) => void
      /** Called on each (re)open of the push socket, before any frame is read: the runtime says hello again. */
      onOpen: () => Promise<void>
      onFrame: (f: ServerFrame) => Promise<void>
    },
  ) {}

  async post<R extends RuntimeRoute>(route: R, frame: RuntimeFrames[R]): Promise<unknown> {
    // Heartbeats are not retried: the next one is 30 s away and a late one says nothing true.
    const delays = route === 'heartbeat' ? [] : RETRY_MS
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await fetch(new URL(`/v2/bridge-runtime/${route}`, this.o.serverUrl), {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${this.o.token()}` },
          body: JSON.stringify(frame),
        })
        const text = await res.text()
        if (!res.ok) throw new HttpError(res.status, text)
        return text ? JSON.parse(text) : null
      } catch (e) {
        // 4xx is the server refusing this frame (not ours to retry), except 429.
        const status = e instanceof HttpError ? e.status : 0
        const retryable = status === 0 || status === 429 || status >= 500
        if (!retryable || attempt >= delays.length) {
          this.o.log(`[link] ${route} not delivered: ${(e as Error).message}`)
          throw e
        }
        await new Promise((r) => setTimeout(r, delays[attempt]))
      }
    }
  }

  /** A fresh stream on each attempt; neither side buffers the entire file. */
  async openMedia(input: { outboxId: string; connectionId: string; fileEntityId: string }): Promise<Readable> {
    const res = await fetch(new URL('/v2/bridge-runtime/outbound-media', this.o.serverUrl), {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${this.o.token()}` },
      body: JSON.stringify(input),
    })
    if (!res.ok || !res.body) {
      await res.body?.cancel()
      throw new Error(`attachment download failed: HTTP ${res.status}`)
    }
    const body = Readable.fromWeb(res.body as import('node:stream/web').ReadableStream<Uint8Array>)
    const stream = Readable.from((async function* () {
      try {
        yield* body
      } catch (cause) {
        // Fetch can succeed before its body is cut short (for example during
        // a server restart). Preserve that as a download failure for retry.
        throw new Error('attachment download failed: stream interrupted', { cause })
      } finally {
        body.destroy()
      }
    })(), { objectMode: false })
    // A provider may reject before reading even the first chunk.
    stream.once('close', () => body.destroy())
    return stream
  }

  start() {
    this.closed = false
    const url = new URL('/v2/ws', this.o.serverUrl)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    url.searchParams.set('bridgeRuntime', this.o.runtimeId)
    // Node's WebSocket (undici) takes headers in its init; the DOM type doesn't know that.
    const ws = new WebSocket(url, { headers: { authorization: `Bearer ${this.o.token()}` } } as unknown as string[])
    this.ws = ws
    // Each connection keeps its own order; revocations below can overtake a slow upload.
    let ready = Promise.resolve()
    const chains = new Map<string, Promise<void>>()
    let opened = false
    ws.onopen = () => {
      opened = true
      this.wsFailures = 0
      ready = ready.then(() => this.o.onOpen()).catch((e) => this.o.log(`[link] hello failed: ${(e as Error).message}`))
    }
    ws.onmessage = (ev) => {
      let frame: ServerFrame
      try {
        frame = JSON.parse(String(ev.data)) as ServerFrame
      } catch {
        return this.o.log('[link] unreadable frame dropped')
      }
      // An allowlist change jumps the queue: a pause must take effect at once (§7.3 item 12, within 5 s), not behind
      // a send that is waiting on the server. Overtaking a send only ever refuses it, never lets one through.
      if (frame.type === 'allowlist') {
        void this.o.onFrame(frame).catch((e) => this.o.log(`[link] allowlist failed: ${(e as Error).message}`))
        return
      }
      // A large upload on one number must not stall another number's lease.
      const previous = chains.get(frame.connectionId) ?? ready
      const chain = previous.then(() => this.o.onFrame(frame)).catch((e) => this.o.log(`[link] ${frame.type} failed: ${(e as Error).message}`))
      chains.set(frame.connectionId, chain)
      void chain.finally(() => { if (chains.get(frame.connectionId) === chain) chains.delete(frame.connectionId) })
    }
    ws.onerror = () => {}
    ws.onclose = () => {
      if (this.ws === ws) this.ws = null
      if (this.closed) return
      if (!opened) this.wsFailures++
      const delay = Math.min(30_000, 1000 * 2 ** Math.min(this.wsFailures, 5))
      this.o.log(`[link] push socket closed, reconnecting in ${delay} ms`)
      setTimeout(() => this.start(), delay)
    }
  }

  stop() {
    this.closed = true
    this.ws?.close()
  }
}
