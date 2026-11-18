// A FAKE tm8-server for the runtime's side of the connector protocol: POST /v2/bridge-runtime/<route> (recorded; the
// hello reply is whatever the test set), POST /v2/bridge-runtime/outbound-media (attachment bytes by fileEntityId),
// and the push WebSocket at /v2/ws?bridgeRuntime=<id>. Every request must carry the runtime bearer.
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebSocketServer, type WebSocket } from 'ws'
import type { HelloReply, RuntimeRoute, ServerFrame } from '../src/runtime/protocol.js'

export type Posted = { route: RuntimeRoute; frame: any }

export class FakeTm8 {
  readonly token = 'bridge-runtime-bearer-for-tests'
  readonly posted: Posted[] = []
  helloReply: HelloReply = { connections: [] }
  /** fileEntityId → bytes, served by outbound-media. */
  readonly media = new Map<string, Buffer>()
  /** Requests refused for a missing or wrong bearer. */
  refused = 0
  /**
   * How long the "server" takes to apply a frame before it is recorded (ms): a slow POST, as a busy database makes
   * one. `posted` is in APPLY order, which is what decides a connection's state on the real server. Infinity never
   * answers (and never applies).
   */
  applyDelay: (route: RuntimeRoute, frame: any) => number = () => 0
  private server: http.Server
  private wss: WebSocketServer
  private sockets: WebSocket[] = []
  private waiters: (() => void)[] = []

  private constructor() {
    this.server = http.createServer((req, res) => void this.handle(req, res))
    this.wss = new WebSocketServer({ noServer: true })
    this.server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url ?? '/', 'http://x')
      if (url.pathname !== '/v2/ws' || !url.searchParams.get('bridgeRuntime') || req.headers.authorization !== `Bearer ${this.token}`) {
        this.refused++
        return socket.destroy()
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.sockets.push(ws)
        this.wake()
      })
    })
  }

  static async start(): Promise<FakeTm8> {
    const f = new FakeTm8()
    await new Promise<void>((r) => f.server.listen(0, '127.0.0.1', r))
    return f
  }

  get url(): string {
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`
  }

  async close() {
    for (const ws of this.wss.clients) ws.terminate()
    this.wss.close()
    this.server.closeAllConnections()
    await new Promise((r) => this.server.close(r))
  }

  private wake() {
    for (const w of this.waiters.splice(0)) w()
  }

  /** Pushes a server frame to the runtime on the live socket. */
  push(frame: ServerFrame) {
    const ws = [...this.sockets].reverse().find((s) => s.readyState === s.OPEN)
    if (!ws) throw new Error('the runtime has no push socket open')
    ws.send(JSON.stringify(frame))
  }

  /** The state the server would show for a connection: the last state frame it applied. */
  lastState(connectionId: string): any {
    return this.of('state').filter((f) => f.connectionId === connectionId).at(-1)
  }

  of(route: RuntimeRoute): any[] {
    return this.posted.filter((p) => p.route === route).map((p) => p.frame)
  }

  /** Waits for a posted frame on `route` matching `pred` (counting from `after`, an index into `posted`). */
  async waitFor(route: RuntimeRoute, pred: (f: any) => boolean = () => true, timeoutMs = 5000): Promise<any> {
    const end = Date.now() + timeoutMs
    for (;;) {
      const hit = this.posted.find((p) => p.route === route && pred(p.frame))
      if (hit) return hit.frame
      if (Date.now() > end) throw new Error(`no ${route} frame matched within ${timeoutMs} ms; got ${JSON.stringify(this.of(route)).slice(0, 600)}`)
      await new Promise<void>((r) => {
        this.waiters.push(r)
        setTimeout(r, 25)
      })
    }
  }

  async waitForSocket(timeoutMs = 5000) {
    const end = Date.now() + timeoutMs
    while (!this.sockets.some((s) => s.readyState === s.OPEN)) {
      if (Date.now() > end) throw new Error('the runtime never opened its push socket')
      await new Promise<void>((r) => {
        this.waiters.push(r)
        setTimeout(r, 25)
      })
    }
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = new URL(req.url ?? '/', this.url)
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    if (req.headers.authorization !== `Bearer ${this.token}`) {
      this.refused++
      res.writeHead(401).end('{"error":"unauthorized"}')
      return
    }
    const prefix = '/v2/bridge-runtime/'
    if (req.method !== 'POST' || !url.pathname.startsWith(prefix)) {
      res.writeHead(404).end()
      return
    }
    const route = url.pathname.slice(prefix.length)
    const frame = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
    if (route === 'outbound-media') {
      const bytes = this.media.get(frame.fileEntityId)
      if (!bytes) {
        res.writeHead(404).end('{"error":"not_found"}')
        return
      }
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': bytes.length })
      res.end(bytes)
      return
    }
    const delay = this.applyDelay(route as RuntimeRoute, frame)
    // Infinity: the server never answers this request (it is dropped when the fake closes).
    if (delay === Infinity) return void (await new Promise(() => {}))
    if (delay > 0) await new Promise((r) => setTimeout(r, delay))
    this.posted.push({ route: route as RuntimeRoute, frame })
    this.wake()
    if (route === 'hello') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(this.helloReply))
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end('{}')
  }
}
