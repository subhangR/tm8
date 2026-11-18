// A minimal Slack Socket Mode client (https://api.slack.com/apis/socket-mode), one per connection:
//   1. apps.connections.open with the app-level token (xapp-…) as Bearer answers a one-use wss:// URL.
//   2. Slack sends {type:'hello'} once the socket is live, then envelopes {envelope_id, type, payload, …}.
//   3. Every envelope is acked with {envelope_id} (optionally a response payload) within 3 seconds, before any work is
//      done, or Slack redelivers it (retry_attempt) and eventually shows the user an error.
//   4. {type:'disconnect', reason} (refresh_requested, warning, link_disabled, too_many_websockets…) means: open a
//      fresh socket. On a routine refresh the new socket is opened FIRST and the old one closed only once the new one
//      said hello, so there is never a moment with no socket (Slack would otherwise sit on envelopes until a retry).
//   5. A socket that opens but never says hello is given up after a timeout; a dropped socket is reopened with
//      backoff; pings detect a socket that died silently.
import WebSocket from 'ws'
import { DEAD_TOKEN, SlackApiError, type SlackApi } from './slack-api.js'

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
  /** How long a new socket may take to say hello (default 15 s). */
  helloTimeoutMs?: number
  /** Backoff after the n-th consecutive failure, ms. */
  backoffMs?: (failures: number) => number
}

const defaultBackoff = (n: number) => (n <= 1 ? 0 : Math.min(60_000, 1000 * 2 ** Math.min(n - 1, 6)))

export class SocketModeClient {
  /** The socket that said hello and carries the connection. */
  private current: WebSocket | null = null
  /** A socket being opened (first open, reconnect, or a refresh beside `current`). */
  private opening: WebSocket | null = null
  private connecting = false
  private stopped = true
  private failures = 0
  private timer: NodeJS.Timeout | null = null
  private pinger: NodeJS.Timeout | null = null
  /** How many times a socket said hello; tests and logs. */
  opens = 0

  constructor(private o: SocketModeOptions) {}

  get live(): boolean {
    return !!this.current && this.current.readyState === WebSocket.OPEN
  }

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    void this.open()
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.clearPinger()
    for (const ws of [this.current, this.opening]) if (ws) kill(ws)
    this.current = null
    this.opening = null
  }

  private clearPinger() {
    if (this.pinger) clearInterval(this.pinger)
    this.pinger = null
  }

  /** No socket is left: tell the connection and try again after the backoff (at least `minDelayMs`). */
  private retryLater(detail: string, minDelayMs = 0) {
    if (this.stopped || this.timer || this.current || this.opening || this.connecting) return
    this.failures++
    const delay = Math.max(minDelayMs, (this.o.backoffMs ?? defaultBackoff)(this.failures))
    this.o.onDrop(`${detail}; reconnecting in ${Math.round(delay / 1000)} s`)
    this.later(delay)
  }

  private later(delay: number) {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      void this.open()
    }, delay)
    this.timer.unref?.()
  }

  /** Opens a socket. With `current` live this is a refresh: `current` keeps working until the new one says hello. */
  private async open(): Promise<void> {
    if (this.stopped || this.opening || this.connecting) return
    this.connecting = true
    let url: string
    try {
      const { body } = await this.o.api.call('apps.connections.open', this.o.appToken())
      url = String(body.url ?? '')
      if (!url) throw new SlackApiError('no_url', 'apps.connections.open')
    } catch (e) {
      this.connecting = false
      if (this.stopped) return
      const err = e instanceof SlackApiError ? e : new SlackApiError('network_error', 'apps.connections.open')
      if (isAuthCode(err.code)) {
        this.stop()
        this.o.onAuthError(err)
        return
      }
      const wait = (err.retryAfterSec ?? 0) * 1000
      // A refresh that could not get a URL: the current socket still works; try again shortly, quietly.
      if (this.current) this.later(Math.max(wait, 5000))
      else this.retryLater(`apps.connections.open failed: ${err.code}`, wait)
      return
    }
    this.connecting = false
    if (this.stopped) return
    // The URL holds a one-use ticket: it is never logged. Through the proxy when one is configured.
    const ws = new WebSocket(url, { handshakeTimeout: 15_000, agent: this.o.api.egress.agentFor(url) })
    this.opening = ws
    let hello = false
    let minDelay = 0
    const helloTimer = setTimeout(() => {
      if (hello) return
      this.o.log('[socket] no hello from Slack: giving this socket up')
      kill(ws)
    }, this.o.helloTimeoutMs ?? 15_000)
    helloTimer.unref?.()
    let alive = true
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
        if (hello) return
        hello = true
        clearTimeout(helloTimer)
        if (this.opening === ws) this.opening = null
        const old = this.current
        this.current = ws
        this.failures = 0
        this.opens++
        this.watch(ws, () => alive, (v) => { alive = v })
        // The new socket is live: only now does the old one go (gracefully; envelopes on it were all acked).
        if (old && old !== ws) retire(old)
        this.o.onOpen()
        return
      }
      if (env.type === 'disconnect') {
        this.o.log(`[socket] disconnect requested: ${env.reason ?? 'unknown'}`)
        if (ws !== this.current) return
        if (env.reason === 'refresh_requested' || env.reason === 'warning') {
          // Routine: open the replacement beside this one; this one closes when the replacement says hello.
          void this.open()
          return
        }
        // link_disabled (Socket Mode turned off) and the rest: drop it and back off.
        if (env.reason === 'link_disabled') minDelay = 30_000
        kill(ws)
        return
      }
      if (env.envelope_id) {
        // Ack first, always, on the socket it came on: the 3 s clock is Slack's, and the work may wait on Slack or tm8.
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
      clearTimeout(helloTimer)
      if (this.opening === ws) this.opening = null
      if (this.current === ws) {
        this.current = null
        this.clearPinger()
      }
      if (this.stopped) return
      // Another socket carries on (a refresh's old or new half): nothing to do.
      if (this.current || this.opening) return
      this.retryLater(hello ? `socket closed (${code})` : `socket failed before hello (${code})`, minDelay)
    })
  }

  /** Pings the current socket; one that stops answering is dropped (and reopened by its close). */
  private watch(ws: WebSocket, isAlive: () => boolean, setAlive: (v: boolean) => void) {
    this.clearPinger()
    this.pinger = setInterval(() => {
      if (this.current !== ws) return
      if (!isAlive()) {
        this.o.log('[socket] no pong: reopening')
        kill(ws)
        return
      }
      setAlive(false)
      try {
        ws.ping()
      } catch {
        // close follows
      }
    }, this.o.pingMs ?? 30_000)
    this.pinger.unref?.()
  }
}

/** Closes a socket that was replaced: listeners stay (late envelopes are still acked), its close changes nothing. */
function retire(ws: WebSocket) {
  try {
    ws.close(1000, 'replaced')
  } catch {
    ws.terminate()
  }
  setTimeout(() => ws.terminate(), 5000).unref?.()
}

function kill(ws: WebSocket) {
  ws.on('error', () => {})
  ws.terminate()
}

/** The app token is dead, or is not an app-level token at all: reconnecting cannot help. */
function isAuthCode(code: string) {
  return DEAD_TOKEN.has(code) || code === 'not_allowed_token_type'
}
