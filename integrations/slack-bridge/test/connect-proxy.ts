// A tiny HTTP CONNECT proxy for tests: tunnels to whatever the client asks, records each tunnel (its target, its
// Proxy-Authorization, and the request lines that went through it), and can demand credentials.
import http from 'node:http'
import net from 'node:net'
import type { AddressInfo } from 'node:net'

/** `requests`: every HTTP request line seen inside the tunnel (keep-alive tunnels carry several; an upgrade one). */
export type Tunnel = { target: string; auth: string | null; requests: string[] }

export class ConnectProxy {
  readonly tunnels: Tunnel[] = []
  /** When set, CONNECT without exactly this `user:password` answers 407. */
  requireAuth: string | null = null
  refused = 0
  private server: http.Server
  private sockets = new Set<net.Socket>()

  private constructor() {
    this.server = http.createServer((_req, res) => res.writeHead(405).end('CONNECT only'))
    this.server.on('connect', (req: http.IncomingMessage, client: net.Socket, head: Buffer) => {
      this.sockets.add(client)
      client.on('close', () => this.sockets.delete(client))
      client.on('error', () => {})
      const auth = req.headers['proxy-authorization'] ?? null
      if (this.requireAuth && auth !== `Basic ${Buffer.from(this.requireAuth).toString('base64')}`) {
        this.refused++
        client.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic\r\n\r\n')
        return
      }
      const [host, port] = String(req.url).split(/:(?=\d+$)/)
      const tunnel: Tunnel = { target: String(req.url), auth: auth ? String(auth) : null, requests: [] }
      this.tunnels.push(tunnel)
      const upstream = net.connect(Number(port), host!.replace(/^\[|\]$/g, ''), () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        if (head.length) upstream.write(head)
        client.pipe(upstream)
        upstream.pipe(client)
      })
      this.sockets.add(upstream)
      upstream.on('close', () => this.sockets.delete(upstream))
      upstream.on('error', () => client.destroy())
      // Plain HTTP inside the tunnel (the fake Slack is http): note each request line (POST /api/…, GET /link/…).
      client.on('data', (d: Buffer) => {
        for (const m of d.toString('latin1').matchAll(/^(GET|POST|PUT) (\S+) HTTP\/1\.1\r$/gm)) tunnel.requests.push(`${m[1]} ${m[2]}`)
      })
    })
  }

  static async start(): Promise<ConnectProxy> {
    const p = new ConnectProxy()
    await new Promise<void>((r) => p.server.listen(0, '127.0.0.1', r))
    return p
  }

  get url(): string {
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`
  }

  async close() {
    for (const s of this.sockets) s.destroy()
    this.server.closeAllConnections()
    await new Promise((r) => this.server.close(r))
  }
}
