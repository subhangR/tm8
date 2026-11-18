// A FAKE SLACK for tests: the Web API over HTTP (point TM8_SLACK_API_URL / `new SlackApi(fake.apiUrl)` at it) and a
// Socket Mode WebSocket server that apps.connections.open hands out. It pushes envelopes, records acks, keeps the
// messages, reactions and files the runtime posts, and injects 429s and errors. Reusable by any test that runs the
// runtime (an end-to-end test of server + runtime imports it from here).
//
//   const slack = await FakeSlack.start()
//   slack.channel({ id: 'C1', name: 'eng' })                // the bot is a member unless { member: false }
//   slack.user({ id: 'U1', name: 'Priya', email: 'p@x.io' })
//   ... connect the runtime with { botToken: slack.botToken, appToken: slack.appToken } ...
//   await slack.waitForSocket()
//   const id = slack.event({ type: 'message', channel: 'C1', user: 'U1', text: 'hi', ts: slack.ts() })
//   await slack.waitForAck(id)
//   slack.rateLimit('chat.postMessage', 1, 7)                // next call answers 429 Retry-After: 7
//   await slack.close()
import crypto from 'node:crypto'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebSocketServer, type WebSocket } from 'ws'

export type FakeUser = { id: string; name: string; realName?: string; email?: string | null; avatar?: string | null; bot?: boolean }
/** `teams`: the workspaces the channel is in (Grid: a shared channel is in several); default the main workspace. */
export type FakeChannel = { id: string; name: string; private?: boolean; member?: boolean; archived?: boolean; members?: number; teams?: string[] }
export type FakeFile = { id: string; name: string; mimetype: string; bytes: Buffer; channels: string[]; title?: string }
export type PostedMessage = { channel: string; ts: string; text: string; thread_ts?: string; username?: string; icon_url?: string; icon_emoji?: string; params: Record<string, string> }
export type ApiCall = { method: string; token: string | null; params: Record<string, string> }

export class FakeSlack {
  // Assembled at run time so secret scanners do not take these fakes for real tokens. They match the shapes tm8
  // checks (SLACK_BOT_TOKEN_RE / SLACK_APP_TOKEN_RE) and the fake accepts nothing else.
  readonly botToken = ['xoxb', '1000000001', '2000000002', 'FAKE0bot0token'].join('-')
  readonly appToken = ['xapp', '1', 'A0FAKEAPP', '3000000003', 'fake0app0token'].join('-')
  team = { id: 'T0FAKE', name: 'Acme', url: 'https://acme.enterprise.slack.com/', enterpriseId: 'E0FAKE' as string | null, enterpriseName: 'Acme Corp' as string | null, isEnterpriseInstall: false }
  bot = { userId: 'U0BOT', botId: 'B0BOT', name: 'tm8' }
  /**
   * The workspaces an org-wide Grid install (team.isEnterpriseInstall) was approved into: auth.teams.list answers
   * them, and on such an install users.conversations / conversations.list refuse to run without a team_id.
   */
  /** `locked`: not granted to the install; `failWith`: listing it answers this error. */
  workspaces: { id: string; name: string; locked?: boolean; failWith?: string }[] = [{ id: 'T0FAKE', name: 'Acme' }]
  scopes = ['app_mentions:read', 'channels:history', 'channels:read', 'chat:write', 'chat:write.customize', 'files:read', 'files:write', 'groups:history', 'groups:read', 'reactions:read', 'reactions:write', 'users:read', 'users:read.email', 'commands']

  readonly users = new Map<string, FakeUser>()
  readonly channels = new Map<string, FakeChannel>()
  readonly files = new Map<string, FakeFile>()
  readonly messages: PostedMessage[] = []
  readonly reactions: { channel: string; ts: string; name: string; removed?: boolean }[] = []
  readonly calls: ApiCall[] = []
  readonly acks: { envelope_id: string; payload?: unknown }[] = []
  /** Every socket ever opened (the newest is the live one). */
  readonly sockets: WebSocket[] = []
  /** apps.connections.open answers. */
  opens = 0
  /** Any request to a url_private / upload URL, with its Authorization header (never a bot token on an upload). */
  readonly fileRequests: { path: string; authorization: string | null }[] = []

  private server: http.Server
  private wss: WebSocketServer
  private seq = 0
  private tsSeq = 0
  private limits = new Map<string, { times: number; retryAfter: number }>()
  private errors = new Map<string, { times: number; error: string; needed?: string }>()
  private ackWaiters: (() => void)[] = []
  private socketWaiters: (() => void)[] = []
  private uploads = new Map<string, { name: string; length: number; bytes?: Buffer }>()
  /** Send `hello` on connect (turn off to test a socket that never says hello). */
  sayHello = true
  /** When set, a file download answers 302 to this URL (absolute, or a path on the fake) instead of the bytes. */
  fileRedirect: string | null = null
  /** Delay before the shares of an uploaded file appear (0: in the completeUploadExternal answer). */
  shareDelayMs = 0

  private constructor() {
    this.server = http.createServer((req, res) => void this.handle(req, res))
    this.wss = new WebSocketServer({ noServer: true })
    this.server.on('upgrade', (req, socket, head) => {
      if (!req.url?.startsWith('/link/')) return socket.destroy()
      this.wss.handleUpgrade(req, socket, head, (ws) => this.onSocket(ws))
    })
  }

  static async start(): Promise<FakeSlack> {
    const f = new FakeSlack()
    await new Promise<void>((r) => f.server.listen(0, '127.0.0.1', r))
    f.user({ id: f.bot.userId, name: f.bot.name, bot: true })
    return f
  }

  get origin(): string {
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`
  }

  /** The Web API base (TM8_SLACK_API_URL). */
  get apiUrl(): string {
    return `${this.origin}/api/`
  }

  async close(): Promise<void> {
    for (const ws of this.wss.clients) ws.terminate()
    this.wss.close()
    this.server.closeAllConnections()
    await new Promise((r) => this.server.close(r))
  }

  // -- world ------------------------------------------------------------------------------------------------------

  user(u: FakeUser) {
    this.users.set(u.id, u)
    return u
  }

  channel(c: FakeChannel) {
    this.channels.set(c.id, { member: true, teams: [this.team.id], ...c })
    return this.channels.get(c.id)!
  }

  file(f: Omit<FakeFile, 'id'> & { id?: string }): FakeFile {
    const file = { id: f.id ?? `F${String(++this.seq).padStart(8, '0')}`, ...f } as FakeFile
    this.files.set(file.id, file)
    return file
  }

  /** A fresh message ts, increasing. */
  ts(): string {
    return `${1_763_000_000 + ++this.tsSeq}.${String(this.tsSeq).padStart(6, '0')}`
  }

  // -- fault injection --------------------------------------------------------------------------------------------

  /** The next `times` calls of `method` answer HTTP 429 with Retry-After. */
  rateLimit(method: string, times = 1, retryAfter = 1) {
    this.limits.set(method, { times, retryAfter })
  }

  /** The next `times` calls of `method` answer {ok:false, error}. */
  fail(method: string, error: string, times = 1, needed?: string) {
    this.errors.set(method, { times, error, needed })
  }

  callsOf(method: string): ApiCall[] {
    return this.calls.filter((c) => c.method === method)
  }

  // -- Socket Mode --------------------------------------------------------------------------------------------------

  private onSocket(ws: WebSocket) {
    this.sockets.push(ws)
    ws.on('message', (data) => {
      const m = JSON.parse(String(data))
      if (m.envelope_id) {
        this.acks.push(m)
        for (const w of this.ackWaiters.splice(0)) w()
      }
    })
    if (this.sayHello) ws.send(JSON.stringify({ type: 'hello', num_connections: 1, debug_info: { host: 'fake', approximate_connection_time: 18060 }, connection_info: { app_id: 'A0FAKEAPP' } }))
    for (const w of this.socketWaiters.splice(0)) w()
  }

  get socket(): WebSocket | null {
    const s = this.sockets[this.sockets.length - 1]
    return s && s.readyState === s.OPEN ? s : null
  }

  /** Resolves once `count` sockets have been opened in total (default: at least one open now). */
  async waitForSocket(count?: number, timeoutMs = 5000): Promise<WebSocket> {
    const ok = () => (count === undefined ? !!this.socket : this.sockets.length >= count && !!this.socket)
    const end = Date.now() + timeoutMs
    while (!ok()) {
      if (Date.now() > end) throw new Error(`no Socket Mode socket (${this.sockets.length} opened)`)
      await new Promise<void>((r) => {
        this.socketWaiters.push(r)
        setTimeout(r, 50)
      })
    }
    return this.socket!
  }

  private rr = 0

  /**
   * Pushes an envelope; returns its envelope_id. Like real Socket Mode, an app's envelopes are spread round-robin over
   * ALL of its open sockets, so a runtime that opens two sockets for one app sees each event on only one of them.
   */
  push(type: string, payload: unknown, extra: Record<string, unknown> = {}): string {
    const open = this.sockets.filter((s) => s.readyState === s.OPEN)
    if (!open.length) throw new Error('no live Socket Mode socket')
    const ws = open[this.rr++ % open.length]!
    const envelope_id = crypto.randomUUID()
    ws.send(JSON.stringify({ envelope_id, type, payload, accepts_response_payload: type !== 'events_api', retry_attempt: 0, retry_reason: '', ...extra }))
    return envelope_id
  }

  /** An Events API envelope around `event`; returns its envelope_id. Pass `eventId` to replay the same event. */
  event(event: Record<string, unknown>, o: { eventId?: string } = {}): string {
    return this.push('events_api', {
      token: 'verification-token', team_id: this.team.id, api_app_id: 'A0FAKEAPP', type: 'event_callback',
      event_id: o.eventId ?? `Ev${String(++this.seq).padStart(8, '0')}`, event_time: Math.floor(Date.now() / 1000),
      event: { event_ts: event.ts ?? this.ts(), ...event },
    })
  }

  /** A `/tm8 …` slash command envelope; returns its envelope_id. */
  slash(o: { channel: string; user: string; text: string; command?: string; triggerId?: string }): string {
    return this.push('slash_commands', {
      token: 'verification-token', team_id: this.team.id, team_domain: 'acme', channel_id: o.channel, channel_name: this.channels.get(o.channel)?.name ?? 'x',
      user_id: o.user, user_name: this.users.get(o.user)?.name ?? 'someone', command: o.command ?? '/tm8', text: o.text, api_app_id: 'A0FAKEAPP',
      is_enterprise_install: 'false', response_url: `${this.origin}/commands/response`, trigger_id: o.triggerId ?? `${++this.seq}.1000.abcdef`,
    })
  }

  /** Slack asking the client to reconnect. */
  disconnect(reason = 'refresh_requested') {
    this.socket?.send(JSON.stringify({ type: 'disconnect', reason, debug_info: { host: 'fake' } }))
  }

  /** Kills the live socket without a word. */
  dropSocket() {
    this.socket?.terminate()
  }

  async waitForAck(envelopeId: string, timeoutMs = 3000): Promise<{ envelope_id: string; payload?: unknown }> {
    const end = Date.now() + timeoutMs
    for (;;) {
      const a = this.acks.find((x) => x.envelope_id === envelopeId)
      if (a) return a
      if (Date.now() > end) throw new Error(`envelope ${envelopeId} not acked within ${timeoutMs} ms`)
      await new Promise<void>((r) => {
        this.ackWaiters.push(r)
        setTimeout(r, 50)
      })
    }
  }

  // -- Web API ------------------------------------------------------------------------------------------------------

  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = new URL(req.url ?? '/', this.origin)
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    const raw = Buffer.concat(chunks)
    const json = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers })
      res.end(JSON.stringify(body))
    }
    if (url.pathname.startsWith('/upload/')) {
      this.fileRequests.push({ path: url.pathname, authorization: req.headers.authorization ?? null })
      const u = this.uploads.get(url.pathname.slice('/upload/'.length))
      if (!u) return json(404, { ok: false })
      if (Number(req.headers['content-length']) !== raw.length || raw.length !== u.length) {
        res.writeHead(400).end('length mismatch')
        return
      }
      u.bytes = raw
      res.writeHead(200, { 'content-type': 'text/plain' }).end('OK - ' + raw.length)
      return
    }
    if (url.pathname.startsWith('/files-pri/')) {
      this.fileRequests.push({ path: url.pathname, authorization: req.headers.authorization ?? null })
      const id = url.pathname.split('/')[2]!.split('-').pop()!
      const f = this.files.get(id)
      if (this.fileRedirect && !url.searchParams.has('redirected')) {
        const to = new URL(this.fileRedirect, this.origin)
        to.searchParams.set('redirected', '1')
        res.writeHead(302, { location: to.href }).end()
        return
      }
      if (req.headers.authorization !== `Bearer ${this.botToken}`) {
        res.writeHead(200, { 'content-type': 'text/html' }).end('<html>sign in</html>')
        return
      }
      if (!f) return json(404, { ok: false })
      res.writeHead(200, { 'content-type': f.mimetype, 'content-length': f.bytes.length }).end(f.bytes)
      return
    }
    if (!url.pathname.startsWith('/api/')) return json(404, { ok: false, error: 'unknown_method' })
    const method = url.pathname.slice('/api/'.length)
    const params: Record<string, string> = Object.fromEntries(url.searchParams)
    const type = String(req.headers['content-type'] ?? '')
    if (type.startsWith('application/x-www-form-urlencoded')) Object.assign(params, Object.fromEntries(new URLSearchParams(raw.toString('utf8'))))
    else if (type.startsWith('application/json') && raw.length) for (const [k, v] of Object.entries(JSON.parse(raw.toString('utf8')))) params[k] = typeof v === 'string' ? v : JSON.stringify(v)
    const auth = req.headers.authorization?.replace(/^Bearer /, '') ?? null
    this.calls.push({ method, token: auth, params })

    const limit = this.limits.get(method)
    if (limit && limit.times > 0) {
      if (--limit.times === 0) this.limits.delete(method)
      return json(429, { ok: false, error: 'ratelimited' }, { 'retry-after': String(limit.retryAfter) })
    }
    const err = this.errors.get(method)
    if (err && err.times > 0) {
      if (--err.times === 0) this.errors.delete(method)
      return json(200, { ok: false, error: err.error, ...(err.needed ? { needed: err.needed } : {}) })
    }
    const app = method === 'apps.connections.open'
    if (!auth) return json(200, { ok: false, error: 'not_authed' })
    if (app ? !auth.startsWith('xapp-') : auth.startsWith('xapp-')) return json(200, { ok: false, error: 'not_allowed_token_type' })
    if (auth !== (app ? this.appToken : this.botToken)) return json(200, { ok: false, error: 'invalid_auth' })
    const ok = (body: Record<string, unknown>, headers: Record<string, string> = {}) => json(200, { ok: true, ...body }, headers)
    const channel = (id: string | undefined) => (id ? this.channels.get(id) : undefined)

    switch (method) {
      case 'auth.test':
        // An org-wide Grid install answers with the org and no workspace team.
        return ok({
          url: this.team.url, team: this.team.name, user: this.bot.name, ...(this.team.isEnterpriseInstall ? {} : { team_id: this.team.id }), user_id: this.bot.userId, bot_id: this.bot.botId,
          is_enterprise_install: this.team.isEnterpriseInstall, ...(this.team.enterpriseId ? { enterprise_id: this.team.enterpriseId } : {}),
        }, { 'x-oauth-scopes': this.scopes.join(',') })
      case 'apps.connections.open':
        this.opens++
        return ok({ url: `ws://127.0.0.1:${(this.server.address() as AddressInfo).port}/link/?ticket=${crypto.randomUUID()}&app_id=A0FAKEAPP` })
      case 'users.info': {
        const u = this.users.get(params.user ?? '')
        if (!u) return json(200, { ok: false, error: 'user_not_found' })
        return ok({ user: { id: u.id, name: u.name.toLowerCase(), real_name: u.realName ?? u.name, is_bot: !!u.bot, profile: { display_name: u.name, real_name: u.realName ?? u.name, email: u.email ?? undefined, image_72: u.avatar ?? undefined, image_192: u.avatar ?? undefined } } })
      }
      case 'auth.teams.list': {
        // One per page, to exercise the cursor.
        const start = Number(params.cursor || 0)
        const page = this.team.isEnterpriseInstall ? this.workspaces.slice(start, start + 1) : start ? [] : [{ id: this.team.id, name: this.team.name }]
        const next = this.team.isEnterpriseInstall && start + 1 < this.workspaces.length ? String(start + 1) : ''
        return ok({ teams: page.map((t) => ({ id: t.id, name: t.name })), response_metadata: { next_cursor: next } })
      }
      case 'users.conversations':
      case 'conversations.list': {
        // An org-wide token must name the workspace (Slack: missing_argument); a workspace token may not name another.
        if (this.team.isEnterpriseInstall && !params.team_id) return json(200, { ok: false, error: 'missing_argument' })
        const team = params.team_id || this.team.id
        if (!this.team.isEnterpriseInstall && team !== this.team.id) return json(200, { ok: false, error: 'team_access_not_granted' })
        if (this.team.isEnterpriseInstall && !this.workspaces.some((w) => w.id === team && !w.locked)) return json(200, { ok: false, error: 'team_access_not_granted' })
        const down = this.workspaces.find((w) => w.id === team)?.failWith
        if (down) return json(200, { ok: false, error: down })
        const types = (params.types ?? 'public_channel').split(',')
        const all = [...this.channels.values()].filter((c) => (method === 'conversations.list' || c.member) && (c.teams ?? [this.team.id]).includes(team) && (params.exclude_archived !== 'true' || !c.archived) && types.includes(c.private ? 'private_channel' : 'public_channel'))
        // Two per page, to exercise the cursor.
        const start = Number(params.cursor || 0)
        const page = all.slice(start, start + 2)
        const next = start + 2 < all.length ? String(start + 2) : ''
        return ok({ channels: page.map((c) => ({ id: c.id, name: c.name, is_private: !!c.private, is_archived: !!c.archived, is_member: true, ...(c.members !== undefined ? { num_members: c.members } : {}) })), response_metadata: { next_cursor: next } })
      }
      case 'conversations.info': {
        const c = channel(params.channel)
        if (!c || (c.private && !c.member)) return json(200, { ok: false, error: 'channel_not_found' })
        // A channel only in workspaces an org install was not granted.
        if (this.team.isEnterpriseInstall && (c.teams ?? []).every((t) => this.workspaces.find((w) => w.id === t)?.locked)) return json(200, { ok: false, error: 'team_access_not_granted' })
        return ok({ channel: { id: c.id, name: c.name, is_private: !!c.private, is_archived: !!c.archived, is_member: !!c.member } })
      }
      case 'chat.postMessage': {
        const c = channel(params.channel)
        if (!c) return json(200, { ok: false, error: 'channel_not_found' })
        if (c.archived) return json(200, { ok: false, error: 'is_archived' })
        if (!c.member) return json(200, { ok: false, error: 'not_in_channel' })
        if (!params.text) return json(200, { ok: false, error: 'no_text' })
        const m: PostedMessage = { channel: c.id, ts: this.ts(), text: params.text, thread_ts: params.thread_ts, username: params.username, icon_url: params.icon_url, icon_emoji: params.icon_emoji, params }
        this.messages.push(m)
        return ok({ channel: c.id, ts: m.ts, message: { text: m.text, ts: m.ts, bot_id: this.bot.botId, user: this.bot.userId, ...(m.username ? { username: m.username } : {}) } })
      }
      case 'reactions.add': {
        if (!channel(params.channel)) return json(200, { ok: false, error: 'channel_not_found' })
        if (this.reactions.some((r) => !r.removed && r.channel === params.channel && r.ts === params.timestamp && r.name === params.name)) return json(200, { ok: false, error: 'already_reacted' })
        this.reactions.push({ channel: params.channel!, ts: params.timestamp!, name: params.name! })
        return ok({})
      }
      case 'reactions.remove': {
        const r = this.reactions.find((x) => !x.removed && x.channel === params.channel && x.ts === params.timestamp && x.name === params.name)
        if (!r) return json(200, { ok: false, error: 'no_reaction' })
        r.removed = true
        return ok({})
      }
      case 'files.getUploadURLExternal': {
        if (!params.filename || !Number(params.length)) return json(200, { ok: false, error: 'invalid_arguments' })
        const id = `F${String(++this.seq).padStart(8, '0')}`
        this.uploads.set(id, { name: params.filename, length: Number(params.length) })
        return ok({ upload_url: `${this.origin}/upload/${id}`, file_id: id })
      }
      case 'files.completeUploadExternal': {
        const specs = JSON.parse(params.files ?? '[]') as { id: string; title?: string }[]
        const out = []
        for (const s of specs) {
          const u = this.uploads.get(s.id)
          if (!u?.bytes) return json(200, { ok: false, error: 'file_not_found' })
          const c = channel(params.channel_id)
          if (!c) return json(200, { ok: false, error: 'channel_not_found' })
          const file = this.file({ id: s.id, name: u.name, title: s.title, mimetype: 'application/octet-stream', bytes: u.bytes, channels: [c.id] })
          const m: PostedMessage = { channel: c.id, ts: this.ts(), text: params.initial_comment ?? '', thread_ts: params.thread_ts, params: { ...params, file: file.id } }
          this.messages.push(m)
          ;(file as FakeFile & { shareTs?: string; sharedAt?: number }).shareTs = m.ts
          ;(file as FakeFile & { sharedAt?: number }).sharedAt = Date.now() + this.shareDelayMs
          out.push(this.fileObject(file))
        }
        return ok({ files: out })
      }
      case 'files.info': {
        const f = this.files.get(params.file ?? '')
        if (!f) return json(200, { ok: false, error: 'file_not_found' })
        return ok({ file: this.fileObject(f) })
      }
      default:
        return json(200, { ok: false, error: 'unknown_method' })
    }
  }

  private fileObject(f: FakeFile & { shareTs?: string; sharedAt?: number }) {
    const shared = f.shareTs && (f.sharedAt ?? 0) <= Date.now()
    const shares: Record<string, Record<string, { ts: string }[]>> = { public: {}, private: {} }
    if (shared) for (const c of f.channels) shares[this.channels.get(c)?.private ? 'private' : 'public']![c] = [{ ts: f.shareTs! }]
    return {
      id: f.id, name: f.name, title: f.title ?? f.name, mimetype: f.mimetype, size: f.bytes.length,
      url_private: `${this.origin}/files-pri/T0FAKE-${f.id}/${encodeURIComponent(f.name)}`,
      url_private_download: `${this.origin}/files-pri/T0FAKE-${f.id}/download/${encodeURIComponent(f.name)}`,
      channels: f.channels.filter((c) => !this.channels.get(c)?.private), groups: f.channels.filter((c) => this.channels.get(c)?.private),
      shares: shared ? shares : {},
    }
  }

  /** A file object as it appears inside a `message` event's `files`. */
  fileRef(f: FakeFile) {
    return { id: f.id, name: f.name, title: f.title ?? f.name, mimetype: f.mimetype, size: f.bytes.length, mode: 'hosted' }
  }

  /** The bytes the runtime uploaded for a file id. */
  uploaded(fileId: string): Buffer | undefined {
    return this.uploads.get(fileId)?.bytes
  }
}
