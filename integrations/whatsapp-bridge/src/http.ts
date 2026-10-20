// Speaker-token HTTP API for agents (§6). The token picks the name and the group; agents never pass either.
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import { Bridge, HttpError, type SayMediaInput } from './core.js'

const MAX_BODY = 64 * 1024
/** /admin/inject may carry a small media fixture. */
const MAX_ADMIN_BODY = 2 * 1024 * 1024

function readBody(req: http.IncomingMessage, max: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > max) {
        reject(new HttpError(413, 'body too large'))
        req.destroy()
      } else chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

async function readJson(req: http.IncomingMessage, max = MAX_BODY): Promise<any> {
  const raw = (await readBody(req, max)).toString('utf8')
  if (!raw.trim()) return {}
  try {
    return JSON.parse(raw)
  } catch {
    throw new HttpError(400, 'body must be JSON')
  }
}

/** POST /say-media body: multipart/form-data with a "file" part (curl -F), or JSON {"tm8_file_id": …}. */
async function readSayMedia(req: http.IncomingMessage, maxFile: number): Promise<SayMediaInput> {
  const type = req.headers['content-type'] ?? ''
  if (!/^multipart\/form-data/i.test(type)) {
    if (!/^application\/json/i.test(type)) throw new HttpError(415, 'send multipart/form-data (curl -F file=@path) or JSON {"tm8_file_id": …}')
    const body = await readJson(req)
    if (body?.file !== undefined) throw new HttpError(400, 'JSON bodies take tm8_file_id; upload bytes as multipart (curl -F file=@path)')
    return body
  }
  const raw = await readBody(req, maxFile + MAX_BODY)
  let form: FormData
  try {
    form = await new Response(new Uint8Array(raw), { headers: { 'content-type': type } }).formData()
  } catch {
    throw new HttpError(400, 'malformed multipart body')
  }
  const out: Record<string, unknown> = {}
  for (const [k, v] of form.entries()) {
    if (k === 'file') {
      if (typeof v === 'string') throw new HttpError(400, 'the "file" part must be a file (curl -F file=@path)')
      if (out.file) throw new HttpError(400, 'one file per message')
      out.file = { data: Buffer.from(await v.arrayBuffer()), fileName: v.name || null, mime: v.type || null }
    } else if (typeof v === 'string') out[k] = v
  }
  return out as SayMediaInput
}

export function handler(bridge: Bridge) {
  return async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(body) + '\n')
    }
    try {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const q = Object.fromEntries(url.searchParams) as Record<string, string>
      const route = `${req.method} ${url.pathname}`
      if (route === 'GET /health') return send(200, bridge.health())
      if (url.pathname.startsWith('/admin/')) {
        const given = /^Bearer\s+(\S+)$/.exec(req.headers.authorization ?? '')?.[1] ?? ''
        const want = bridge.adminToken ?? ''
        const ok = !!want && given.length === want.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(want))
        if (!ok) throw new HttpError(401, 'admin token required')
        if (route === 'POST /admin/inject') return send(200, await bridge.injectTest(await readJson(req, MAX_ADMIN_BODY)))
        throw new HttpError(404, 'not found')
      }
      const auth = bridge.authenticate(req.headers.authorization)
      switch (route) {
        case 'POST /say': {
          const r = await bridge.say(auth, await readJson(req))
          return send(r.status, r.body)
        }
        case 'POST /say-media': {
          const r = await bridge.sayMedia(auth, await readSayMedia(req, bridge.cfg.media.maxBytes))
          return send(r.status, r.body)
        }
        case 'POST /react':
          return send(200, await bridge.react(auth, await readJson(req)))
        case 'GET /history':
          return send(200, bridge.history(auth.ch, q))
        case 'GET /search':
          return send(200, bridge.search(auth.ch, q))
        case 'GET /names':
          return send(200, bridge.names(auth.ch))
        case 'POST /sync':
          await bridge.poll()
          return send(200, { ok: bridge.lastPoll.ok, error: bridge.lastPoll.error, names: bridge.names(auth.ch).names })
      }
      const m = /^\/message\/([^/]+)$/.exec(url.pathname)
      if (req.method === 'GET' && m) return send(200, bridge.message(auth.ch, decodeURIComponent(m[1])))
      const md = /^\/media\/([^/]+)$/.exec(url.pathname)
      if (req.method === 'GET' && md) {
        const f = await bridge.mediaFile(auth.ch, decodeURIComponent(md[1]))
        res.writeHead(200, {
          'content-type': f.mime,
          'content-length': String(f.size),
          'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(f.fileName)}`,
          'x-content-type-options': 'nosniff',
        })
        fs.createReadStream(f.path).on('error', () => res.destroy()).pipe(res)
        return
      }
      throw new HttpError(404, 'not found')
    } catch (e) {
      if (e instanceof HttpError) return send(e.status, { error: e.message, ...e.extra })
      bridge.log(`[http] ${req.method} ${req.url}: ${(e as Error).stack ?? e}`)
      return send(500, { error: 'internal error' })
    }
  }
}

export function startHttp(bridge: Bridge, host: string, port: number): Promise<http.Server> {
  const server = http.createServer(handler(bridge))
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => resolve(server))
  })
}
