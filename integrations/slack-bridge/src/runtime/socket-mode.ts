// A minimal Slack Socket Mode client (https://api.slack.com/apis/socket-mode), one per connection:
//   1. apps.connections.open with the app-level token (xapp-…) as Bearer answers a one-use wss:// URL.
//   2. Slack sends {type:'hello'} once the socket is live, then envelopes {envelope_id, type, payload, …}.
//   3. Every envelope is acked with {envelope_id} (optionally a response payload) within 3 seconds, before any work is
//      done, or Slack redelivers it (retry_attempt) and eventually shows the user an error.
//   4. {type:'disconnect', reason} (refresh_requested, warning, link_disabled, too_many_websockets…) means: open a
//      fresh socket. A dropped socket is reopened with backoff; pings detect a socket that died silently.
import WebSocket from 'ws'
import { SlackApiError, type SlackApi } from './slack-api.js'

export type Envelope = {
  envelope_id?: string
  type: string
  payload?: any
  reason?: string
  retry_attempt?: number
  retry_reason?: string
  accepts_response_payload?: boolean
}

export type SocketModeOptions = {
  api: SlackApi
  appToken: () => string
  log: (m: string) => void
  /** Called for each envelope after it is acked. `ack` already went; the handler only does the work. */
  onEnvelope: (e: Envelope) => void
  /** The response payload to ack with (slash commands may answer the invoker); undefined acks with no payload. */
  ackPayload?: (e: Envelope) => unknown
  /** The socket is live (Slack said hello). */
  onOpen: () => void
  /** The socket dropped and a reopen is scheduled. */
  onDrop: (detail: string) => void
  /** apps.connections.open refused the app token: give up, do not reconnect. */
  onAuthError: (e: SlackApiError) => void
  pingMs?: number
  /** Backoff after the n-th consecutive failure, ms. */
  backoffMs?: (failures: number) => number
}

const defaultBackoff = (n: number) => (n <= 1 ? 0 : Math.min(60_000, 1000 * 2 ** Math.min(n - 1, 6)))

export class SocketModeClient {
  private ws: WebSocket | null = null
  private stopped = true
  private failures = 0
  private timer: NodeJS.Timeout | null = null
  private pinger: NodeJS.Timeout | null = null
  /** How many times a socket said hello; tests and logs. */
  opens = 0

  constructor(private o: SocketModeOptions) {}

  get live(): boolean {
    return !!this.ws && this.ws.readyState === WebSocket.OPEN
  }

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    void this.connect()
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.clearPinger()
    const ws = this.ws
    this.ws = null
    if (ws) {
      ws.removeAllListeners()
      ws.on('error', () => {})
      ws.terminate()
    }
  }

  private clearPinger() {
    if (this.pinger) clearInterval(this.pinger)
    this.pinger = null
  }

  private schedule(detail: string, minDelayMs = 0) {
    if (this.stopped || this.timer) return
    this.failures++
    const delay = Math.max(minDelayMs, (this.o.backoffMs ?? defaultBackoff)(this.failures))
    this.o.onDrop(`${detail}; reconnecting in ${Math.round(delay / 1000)} s`)
    this.timer = setTimeout(() => {
      this.timer = null
      void this.connect()
    }, delay)
    this.timer.unref?.()
  }

  private async connect(): Promise<void> {
    if (this.stopped) return
    let url: string
    try {
      const { body } = await this.o.api.call('apps.connections.open', this.o.appToken())
      url = String(body.url ?? '')
      if (!url) throw new SlackApiError('no_url', 'apps.connections.open')
    } catch (e) {
      if (this.stopped) return
      const err = e instanceof SlackApiError ? e : new SlackApiError('network_error', 'apps.connections.open')
      if (isAuthCode(err.code)) {
        this.stopped = true
        this.o.onAuthError(err)
        return
      }
      this.schedule(`apps.connections.open failed: ${err.code}`, (err.retryAfterSec ?? 0) * 1000)
      return
    }
    if (this.stopped) return
    // The URL holds a one-use ticket: it is never logged.
    // Through the proxy when one is configured (a CONNECT tunnel, as for the Web API).
    const ws = new WebSocket(url, { handshakeTimeout: 15_000, agent: this.o.api.egress.agentFor(url) })
    this.ws = ws
    let alive = true
    let hello = false
    ws.on('ping', () => { alive = true })
    ws.on('pong', () => { alive = true })
    ws.on('message', (data) => {
      alive = true
      let env: Envelope
      try {
        env = JSON.parse(String(data)) as Envelope
      } catch {
        return this.o.log('[socket] unreadable frame dropped')
      }
      if (env.type === 'hello') {
        hello = true
        this.failures = 0
        this.opens++
        this.o.onOpen()
        return
      }
      if (env.type === 'disconnect') {
        // Slack is about to close this socket (refresh_requested every few hours, warning ~10 s ahead, link_disabled
        // when Socket Mode was turned off). Open a fresh one now; envelopes not acked here are redelivered there.
        this.o.log(`[socket] disconnect requested: ${env.reason ?? 'unknown'}`)
        const routine = env.reason === 'refresh_requested' || env.reason === 'warning'
        this.replace(ws, `slack asked to reconnect (${env.reason ?? 'unknown'})`, routine, env.reason === 'link_disabled' ? 30_000 : 0)
        return
      }
      if (env.envelope_id) {
        // Ack first, always: the 3 s clock is Slack's, and the work below may wait on Slack or tm8.
        const payload = this.o.ackPayload?.(env)
        try {
          ws.send(JSON.stringify(payload === undefined ? { envelope_id: env.envelope_id } : { envelope_id: env.envelope_id, payload }))
        } catch (e) {
          this.o.log(`[socket] ack failed: ${(e as Error).message}`)
        }
      }
      try {
        this.o.onEnvelope(env)
      } catch (e) {
        this.o.log(`[socket] ${env.type} envelope failed: ${(e as Error).message}`)
      }
    })
    ws.on('error', (e) => this.o.log(`[socket] error: ${e.message.replace(/ticket=[^&\s]+/g, 'ticket=…')}`))
    ws.on('close', (code) => {
      if (this.ws !== ws) return
      this.ws = null
      this.clearPinger()
      if (this.stopped) return
      this.schedule(hello ? `socket closed (${code})` : `socket failed before hello (${code})`)
    })
    const pingMs = this.o.pingMs ?? 30_000
    this.clearPinger()
    this.pinger = setInterval(() => {
      if (this.ws !== ws) return
      if (!alive) {
        this.o.log('[socket] no pong: reopening')
        this.replace(ws, 'socket went silent', false)
        return
      }
      alive = false
      try {
        ws.ping()
      } catch {
        // close follows
      }
    }, pingMs)
    this.pinger.unref?.()
  }

  /** Drops this socket and opens a fresh one. */
  private replace(ws: WebSocket, detail: string, routine: boolean, minDelayMs = 0) {
    if (this.ws !== ws) return
    this.ws = null
    this.clearPinger()
    ws.removeAllListeners()
    ws.on('error', () => {})
    ws.terminate()
    if (this.stopped) return
    if (routine) {
      // A requested refresh is routine: no backoff, no failure counted.
      void this.connect()
      return
    }
    this.schedule(detail, minDelayMs)
  }
}

function isAuthCode(code: string) {
  return ['invalid_auth', 'not_authed', 'account_inactive', 'token_revoked', 'token_expired', 'not_allowed_token_type', 'app_uninstalled'].includes(code)
}
