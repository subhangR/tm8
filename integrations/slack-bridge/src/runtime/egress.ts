// How the runtime reaches Slack: directly, or through an HTTP proxy with CONNECT tunnels, as enterprise networks
// often require. One mechanism for every Slack-bound byte: the Web API, file downloads (url_private) and uploads, and
// the Socket Mode WebSocket. The link to tm8-server (loopback) never uses it.
//
//   TM8_SLACK_PROXY_URL           the proxy for all Slack traffic; wins over the standard variables
//   HTTPS_PROXY / https_proxy     the proxy for https:// and wss:// (HTTP_PROXY / http_proxy for http:// and ws://)
//   NO_PROXY / no_proxy           hosts reached directly: `*`, `host`, `.domain`, `*.domain`, `host:port`, comma-separated
//
// A proxy URL may carry `user:password@` (sent as Proxy-Authorization: Basic). An https:// proxy is reached over TLS.
// No dependency: the tunnel is a CONNECT request on a socket, handed to an http.Agent's createConnection.
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import type { Duplex, Readable } from 'node:stream'
import tls from 'node:tls'

export type Env = Record<string, string | undefined>

export class Egress {
  private agents = new Map<string, http.Agent>()

  constructor(private env: Env = {}) {}

  /** No proxy anywhere. */
  static direct(): Egress {
    return new Egress({})
  }

  /** The proxy for this URL, or null to go direct. */
  proxyFor(target: URL | string): URL | null {
    const u = typeof target === 'string' ? new URL(target) : target
    const secure = u.protocol === 'https:' || u.protocol === 'wss:'
    const raw = this.env.TM8_SLACK_PROXY_URL || (secure ? this.env.HTTPS_PROXY || this.env.https_proxy : this.env.HTTP_PROXY || this.env.http_proxy)
    if (!raw) return null
    if (bypassed(u, this.env.NO_PROXY ?? this.env.no_proxy ?? '')) return null
    try {
      return new URL(raw.includes('://') ? raw : `http://${raw}`)
    } catch {
      throw new Error('the Slack proxy URL is not a URL')
    }
  }

  /** The agent for a request to this URL: a tunnelling agent through the proxy, or undefined (Node's default). */
  agentFor(target: URL | string): http.Agent | undefined {
    const u = typeof target === 'string' ? new URL(target) : target
    const proxy = this.proxyFor(u)
    if (!proxy) return undefined
    const secure = u.protocol === 'https:' || u.protocol === 'wss:'
    const key = `${proxy.href}|${secure}`
    const held = this.agents.get(key)
    if (held) return held
    const a: http.Agent = new TunnelAgent(proxy, secure)
    this.agents.set(key, a)
    return a
  }

  /** A description for the startup log line: the proxy's host, never its credentials. */
  describe(sample = 'https://slack.com/api/'): string {
    const p = this.proxyFor(sample)
    return p ? `via proxy ${p.protocol}//${p.host}` : 'direct'
  }

  destroy() {
    for (const a of this.agents.values()) a.destroy()
    this.agents.clear()
  }
}

/** Does NO_PROXY send this URL direct? */
export function bypassed(u: URL, noProxy: string): boolean {
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  const port = u.port || (u.protocol === 'https:' || u.protocol === 'wss:' ? '443' : '80')
  for (const raw of noProxy.split(/[\s,]+/)) {
    const entry = raw.trim().toLowerCase()
    if (!entry) continue
    if (entry === '*') return true
    const m = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(entry)
    if (!m) continue
    const name = m[1]!.replace(/^\[|\]$/g, '').replace(/^\*?\./, '')
    if (m[2] && m[2] !== port) continue
    if (host === name || host.endsWith(`.${name}`)) return true
  }
  return false
}

/** An http.Agent whose sockets are CONNECT tunnels through a proxy (TLS on top for https/wss targets). */
class TunnelAgent extends http.Agent {
  constructor(private proxy: URL, private secure: boolean) {
    super({ keepAlive: true, maxSockets: 32 })
    // https.request refuses an agent of another protocol; ws (wss://) uses https.request with this agent.
    ;(this as unknown as { protocol: string }).protocol = secure ? 'https:' : 'http:'
    ;(this as unknown as { defaultPort: number }).defaultPort = secure ? 443 : 80
  }

  override createConnection(options: any, cb?: (err: Error | null, stream: Duplex) => void): any {
    const host = String(options.host ?? options.hostname ?? 'localhost').replace(/^\[|\]$/g, '')
    const port = Number(options.port) || (this.secure ? 443 : 80)
    tunnel(this.proxy, host, port).then(
      (sock) => {
        if (!this.secure) return cb!(null, sock)
        const t = tls.connect({ socket: sock, servername: options.servername || (net.isIP(host) ? undefined : host), ca: options.ca, rejectUnauthorized: options.rejectUnauthorized, ALPNProtocols: ['http/1.1'] })
        cb!(null, t)
      },
      (e) => cb!(e as Error, undefined as unknown as Duplex),
    )
    return undefined
  }
}

/** Opens a CONNECT tunnel to host:port through the proxy; resolves with the raw socket once the proxy says 200. */
export function tunnel(proxy: URL, host: string, port: number, timeoutMs = 30_000): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const proxyPort = Number(proxy.port) || (proxy.protocol === 'https:' ? 443 : 80)
    const sock: net.Socket = proxy.protocol === 'https:'
      ? tls.connect({ host: proxy.hostname, port: proxyPort, servername: net.isIP(proxy.hostname) ? undefined : proxy.hostname })
      : net.connect({ host: proxy.hostname, port: proxyPort })
    const authority = `${net.isIPv6(host) ? `[${host}]` : host}:${port}`
    const auth = proxy.username ? `Proxy-Authorization: Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64')}\r\n` : ''
    let buf = Buffer.alloc(0)
    const fail = (why: string) => {
      cleanup()
      sock.destroy()
      // The proxy's address is named, never its credentials.
      reject(new Error(`proxy ${proxy.host}: ${why}`))
    }
    const timer = setTimeout(() => fail('CONNECT timed out'), timeoutMs)
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk])
      const end = buf.indexOf('\r\n\r\n')
      if (end < 0) {
        if (buf.length > 16_384) fail('oversized CONNECT answer')
        return
      }
      const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(buf.subarray(0, end).toString('latin1'))?.[1])
      if (status !== 200) return fail(`CONNECT ${authority} answered ${status || 'garbage'}`)
      cleanup()
      // Anything past the header already belongs to the tunnelled stream.
      const rest = buf.subarray(end + 4)
      if (rest.length) sock.unshift(rest)
      resolve(sock)
    }
    const onError = (e: Error) => fail((e as NodeJS.ErrnoException).code ?? e.message)
    const onClose = () => fail('closed during CONNECT')
    const cleanup = () => {
      clearTimeout(timer)
      sock.off('data', onData)
      sock.off('error', onError)
      sock.off('close', onClose)
    }
    sock.on('data', onData)
    sock.on('error', onError)
    sock.on('close', onClose)
    sock.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${auth}\r\n`)
  })
}

export type HttpResponse = { status: number; headers: Headers; body: http.IncomingMessage }

/**
 * One HTTP(S) request through the egress (node:http, not fetch, so the proxy agent applies). The caller reads or
 * drains `body`. A Readable body needs `content-length` in headers when the far end requires a length.
 */
export function httpRequest(egress: Egress, url: string | URL, o: { method?: string; headers?: Record<string, string | number>; body?: string | Buffer | Readable; timeoutMs?: number } = {}): Promise<HttpResponse> {
  const u = typeof url === 'string' ? new URL(url) : url
  return new Promise((resolve, reject) => {
    const req = (u.protocol === 'https:' ? https : http).request(u, { method: o.method ?? 'GET', headers: o.headers, agent: egress.agentFor(u), timeout: o.timeoutMs ?? 30_000 }, (res) => {
      const headers = new Headers()
      for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(', ') : String(v))
      resolve({ status: res.statusCode ?? 0, headers, body: res })
    })
    req.on('timeout', () => req.destroy(new Error('request timed out')))
    req.on('error', reject)
    const b = o.body
    if (b === undefined || typeof b === 'string' || Buffer.isBuffer(b)) req.end(b)
    else {
      b.on('error', (e) => req.destroy(e))
      b.pipe(req)
    }
  })
}

/** Reads a whole response body as text. */
export async function readText(body: Readable): Promise<string> {
  const chunks: Buffer[] = []
  for await (const c of body) chunks.push(c as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}
