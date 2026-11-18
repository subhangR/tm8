import { Egress, httpRequest, readText } from './egress.js'

// A minimal Slack Web API client: form-encoded POSTs to <base><method> with the token as a Bearer header. The base is
// TM8_SLACK_API_URL (default https://slack.com/api/), the seam the fake Slack in test/ plugs into. Errors carry Slack's
// own error code and, on HTTP 429, the Retry-After seconds. Nothing here logs, and no error message holds a token.

export const DEFAULT_SLACK_API_URL = 'https://slack.com/api/'

export class SlackApiError extends Error {
  constructor(
    /** Slack's error code (`invalid_auth`, `channel_not_found`, `ratelimited`…), or `http_<status>` / `network_error`. */
    readonly code: string,
    readonly method: string,
    readonly o: { retryAfterSec?: number; needed?: string; status?: number } = {},
  ) {
    super(`slack ${method}: ${code}${o.needed ? ` (needs ${o.needed})` : ''}`)
  }

  get retryAfterSec(): number | undefined {
    return this.o.retryAfterSec
  }

  /** The detail the server shows for a refused token: Slack's code, `missing_scope: <scope>` when it named one. */
  get detail(): string {
    return this.code === 'missing_scope' && this.o.needed ? `missing_scope: ${this.o.needed}` : this.code
  }
}

/**
 * Codes that mean the token itself is dead: only these log the connection out and delete its sealed tokens. Everything
 * else (no_permission, team_access_not_granted on one Grid workspace, channel_not_found…) fails that one request.
 */
export const DEAD_TOKEN: ReadonlySet<string> = new Set(['invalid_auth', 'not_authed', 'account_inactive', 'token_revoked', 'token_expired', 'app_uninstalled'])

/** Codes that refuse a paste at link time: a dead token, the wrong kind of token, or a missing scope. */
export const LINK_REFUSED: ReadonlySet<string> = new Set([...DEAD_TOKEN, 'not_allowed_token_type', 'missing_scope'])

/** Codes worth trying again later; anything else is the request's own fault. */
const RETRYABLE: ReadonlySet<string> = new Set([
  'ratelimited', 'internal_error', 'fatal_error', 'service_unavailable', 'request_timeout', 'network_error', 'slack_not_connected',
])

export function isRetryable(code: string): boolean {
  return RETRYABLE.has(code) || /^http_(408|429|5\d\d)$/.test(code)
}

export type ApiResult = Record<string, any> & { ok: true }

export class SlackApi {
  readonly base: URL

  constructor(base: string = DEFAULT_SLACK_API_URL, readonly egress: Egress = Egress.direct()) {
    this.base = new URL(base.endsWith('/') ? base : `${base}/`)
  }

  /** Calls one Web API method. Arrays and objects in `params` go JSON-encoded, as Slack's form encoding expects. */
  async call(method: string, token: string, params: Record<string, unknown> = {}): Promise<{ body: ApiResult; headers: Headers }> {
    const form = new URLSearchParams()
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null) continue
      form.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v))
    }
    let res: Awaited<ReturnType<typeof httpRequest>>
    let text: string
    try {
      res = await httpRequest(this.egress, new URL(method, this.base), {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' },
        body: form.toString(),
        timeoutMs: 30_000,
      })
      if (res.status === 429) {
        res.body.resume()
        throw new SlackApiError('ratelimited', method, { retryAfterSec: retryAfter(res.headers), status: 429 })
      }
      text = await readText(res.body)
    } catch (e) {
      if (e instanceof SlackApiError) throw e
      throw new SlackApiError('network_error', method)
    }
    let body: Record<string, any> | null = null
    try {
      body = JSON.parse(text)
    } catch {
      body = null
    }
    if (!body || typeof body !== 'object') throw new SlackApiError(`http_${res.status}`, method, { status: res.status })
    if (body.ok !== true) {
      const code = typeof body.error === 'string' ? body.error : `http_${res.status}`
      throw new SlackApiError(code, method, { status: res.status, needed: typeof body.needed === 'string' ? body.needed : undefined,
        retryAfterSec: code === 'ratelimited' ? retryAfter(res.headers) : undefined })
    }
    return { body: body as ApiResult, headers: res.headers }
  }

  /**
   * May the bot token be sent to this file URL? Exactly the hosts Slack serves `url_private` from: files.slack.com
   * (workspaces and Enterprise Grid alike), over https, on the default port. Or the configured API base's own origin,
   * when it was pointed elsewhere (the fake Slack in tests). No wildcard: a token never goes to another *.slack.com
   * name, let alone anything else.
   */
  trustsFileHost(url: string): boolean {
    let u: URL
    try {
      u = new URL(url)
    } catch {
      return false
    }
    if (u.origin === this.base.origin && this.base.hostname !== 'slack.com') return true
    return u.protocol === 'https:' && FILE_HOSTS.has(u.hostname) && (u.port === '' || u.port === '443') && !u.username && !u.password
  }
}

/** Where Slack serves files (`url_private`, `url_private_download`). */
export const FILE_HOSTS: ReadonlySet<string> = new Set(['files.slack.com'])

function retryAfter(h: Headers): number {
  const n = Number(h.get('retry-after'))
  return Number.isFinite(n) && n > 0 ? Math.ceil(n) : 1
}
