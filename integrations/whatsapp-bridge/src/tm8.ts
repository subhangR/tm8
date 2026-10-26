// tm8 access through the tm8 CLI as a subprocess (`--format json`), authenticated by the human token file.
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { extractTm8Token } from './text.js'

export type LaunchedSession = { id: string; kind: string; title?: string; status: string }
export type EntityContext = {
  id: string
  kind: string
  title?: string
  status?: string
  teammate?: string | null
  /** Tasks the session works on (work sessions); the first one's title is the default name title. */
  tasks?: { id: string; title?: string; status?: string }[]
  launchedSessions?: LaunchedSession[]
  /** Direct children (tasks: subtasks and child docs). */
  children?: { id: string; kind: string; title?: string; status?: string }[]
  /** Chats: "running" while a turn runs; turnCount and lastTurnAt move when turns start. */
  turnState?: string
  turnCount?: number
  lastTurnAt?: string
}
/** One part of an agent's chat-turn message: text, tool_call, tool_result, usage, done; payload is JSON. */
export type TurnPart = { seq: number; kind: string; payload: string }
/** A message on a chat, as the fallback relay needs it. `batch` is "chat-turn:<turn id>" for an agent's turn reply. */
export type ChatMessage = { id: string; body: string; isAgent: boolean; batch: string | null; parts?: TurnPart[]; at?: string | null }
/** A doc's text as stored (markdown unless format says otherwise). */
export type DocInfo = { id: string; title: string; body: string; format: string; updatedAt: string | null }
/** One edge of an entity: `produces` out of a task points at its deliverables. */
export type Connection = { type: string; dir: 'in' | 'out'; other: { id: string; kind: string; title?: string } }
export type Teammate = { id: string; title: string }
/** A form question as tm8 stores it (config with defaults not applied). */
export type FormQuestionSpec = { key: string; type: string; title: string; help?: string; required: boolean; config: Record<string, any> }
export type FormInfo = {
  id: string
  version: number
  status: string
  title: string
  description: string | null
  settings: { responses?: string; allowAmend?: boolean; respondents?: string }
  questions: FormQuestionSpec[]
}

export interface Tm8Port {
  /** False until the token file holds a `tm8s_…` token. */
  configured(): boolean
  context(id: string): Promise<EntityContext>
  /** The newest `limit` messages on an entity (agent turn replies with their parts), in any order. */
  messages(anchorId: string, limit: number): Promise<ChatMessage[]>
  /** Post a message; `attach` are tm8 file ids shown as attachments on it. */
  post(anchorId: string, body: string, mutationId: string, attach?: string[]): Promise<void>
  /** Upload a local file as a tm8 file entity. */
  uploadFile(path: string, o: { name: string; mime: string; mutationId: string }): Promise<{ fileId: string }>
  /** A tm8 file's name, mime and size (throws if the id is not a file). */
  fileInfo(id: string): Promise<{ name: string; mime: string | null; size: number | null }>
  /** Download a tm8 file's bytes to a local path. */
  downloadFile(id: string, outPath: string): Promise<void>
  startChat(o: { teammate: string; model: string; title: string; body: string; mutationId: string }): Promise<{ chatId: string }>
  teammates(): Promise<Teammate[]>
  stopSession(id: string, note: string, mutationId: string): Promise<void>
  /** The token's session; expiresAt is an ISO timestamp (null if it doesn't expire). */
  authSession(): Promise<{ expiresAt: string | null }>
  /** A non-secret fingerprint of the current token (changes when the token file changes), null if none. */
  tokenFingerprint(): string | null
  /** A form with its questions and settings (throws if the id is not a form). */
  formGet(id: string): Promise<FormInfo>
  /** Sparse settings patch; returns the form's new version. */
  formUpdateSettings(id: string, expectVersion: number, settings: Record<string, unknown>, mutationId: string): Promise<number>
  /** Append one question; returns the form's new version. */
  formAddQuestion(id: string, expectVersion: number, question: FormQuestionSpec, mutationId: string): Promise<number>
  /** Submit answers as the token's member; amendOf = the revision this one replaces (under responses: unlimited). */
  formSubmit(id: string, answers: Record<string, unknown>, o: { amendOf?: string | null; mutationId: string }): Promise<{ id: string; revision: number }>
  /** A doc's full body (throws if the id is not a doc). */
  docGet(id: string): Promise<DocInfo>
  /** When an entity last changed (ISO), null if tm8 doesn't say. */
  updatedAt(id: string): Promise<string | null>
  /** An entity's edges (both directions). */
  connections(id: string): Promise<Connection[]>
}

/** A uuidv7's timestamp (its first 48 bits, ms since the epoch) as ISO, null if the id isn't one. */
export function uuidv7Time(id: string): string | null {
  const hex = id.replace(/-/g, '')
  if (!/^[0-9a-f]{32}$/i.test(hex) || hex[12] !== '7') return null
  return new Date(parseInt(hex.slice(0, 12), 16)).toISOString()
}

export class Tm8Error extends Error {
  constructor(message: string, public code: number | null, public stderr: string) {
    super(message)
  }
}

/** Parse CLI JSON output: either the whole stdout, or its first line followed by a `[journal …]` trailer. */
export function parseCliJson(stdout: string): any {
  const cleaned = stdout
    .split('\n')
    .filter((l) => !/^\[journal/.test(l))
    .join('\n')
    .trim()
  try {
    return JSON.parse(cleaned)
  } catch {
    return JSON.parse(stdout.split('\n')[0])
  }
}

/**
 * Makes the client for one (spaceId, tokenFile) pair; the bridge keeps one per pair. homeSpaceId is the space the token
 * belongs to (TM8_SPACE_ID); when it differs from spaceId, calls reach spaceId through that space's link.
 */
export type Tm8Factory = (o: { spaceId: string; tokenFile: string; homeSpaceId: string }) => Tm8Port

/**
 * One client per (space, token). Every call passes `--space <spaceId>`: with a token pinned to another space the CLI
 * goes through that space's link (some operations, e.g. chat start and file upload, are refused through a link).
 */
export class Tm8Cli implements Tm8Port {
  private cached: { mtimeMs: number; token: string | null } | null = null
  constructor(private o: { cliPath: string; baseUrl: string; spaceId: string; homeSpaceId?: string; tokenFile: string; home: string }) {}

  private token(): string | null {
    try {
      const st = fs.statSync(this.o.tokenFile)
      if (this.cached?.mtimeMs !== st.mtimeMs) {
        this.cached = { mtimeMs: st.mtimeMs, token: extractTm8Token(fs.readFileSync(this.o.tokenFile, 'utf8')) }
      }
      return this.cached.token
    } catch {
      return null
    }
  }

  configured() {
    return this.token() !== null
  }

  private run(args: string[], stdin?: string, timeoutMs = 60_000, json = true, space = true): Promise<any> {
    const token = this.token()
    if (!token) return Promise.reject(new Tm8Error('tm8 token not configured', null, ''))
    // A clean env: nothing from whatever launched us (e.g. an agent session's TM8_* vars) leaks into the call.
    const env = {
      PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
      HOME: this.o.home,
      TM8_AGENT_TOKEN: token,
      TM8_BASE_URL: this.o.baseUrl,
      // The token's own space. A link call needs it here and the target in --space; with the target here instead, the
      // CLI answers with empty results rather than an error.
      TM8_SPACE_ID: this.o.homeSpaceId ?? this.o.spaceId,
    }
    return new Promise((resolve, reject) => {
      const child = execFile(
        process.execPath,
        [this.o.cliPath, ...(space ? ['--space', this.o.spaceId] : []), ...args, ...(json ? ['--format', 'json'] : [])],
        { env, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
        (err, stdout, stderr) => {
          if (err) {
            const code = typeof (err as any).code === 'number' ? (err as any).code : null
            // Never echo the token; stderr from the CLI doesn't contain it, but be safe.
            const msg = String(stderr || err.message).replaceAll(token, '<token>').slice(0, 800)
            return reject(new Tm8Error(`tm8 ${args.slice(0, 2).join(' ')} failed: ${msg}`, code, msg))
          }
          if (!json) return resolve({})
          try {
            resolve(stdout.trim() ? parseCliJson(stdout) : {})
          } catch (e) {
            reject(new Tm8Error(`tm8 ${args.slice(0, 2).join(' ')}: unparseable output`, null, stdout.slice(0, 300)))
          }
        },
      )
      if (stdin !== undefined) child.stdin?.end(stdin)
    })
  }

  async context(id: string): Promise<EntityContext> {
    return this.run(['entity', 'context', id])
  }

  async messages(anchorId: string, limit: number): Promise<ChatMessage[]> {
    const out = await this.run(['message', 'list', anchorId, '--order', 'newest', '--limit', String(limit)])
    const items: any[] = out?.items ?? out?.page?.items ?? []
    return items.map((m) => ({
      id: m.id,
      body: m.content?.body ?? '',
      isAgent: !!m.state?.author?.isAgent,
      batch: m.state?.messageBatchId ?? null,
      // message list carries no createdAt; tm8 message ids are uuidv7, so the id says when it was posted.
      at: m.createdAt ?? uuidv7Time(m.id),
      ...(Array.isArray(m.parts) ? { parts: m.parts.map((p: any) => ({ seq: p.seq, kind: p.kind, payload: typeof p.payload === 'string' ? p.payload : JSON.stringify(p.payload ?? null) })) } : {}),
    }))
  }

  async post(anchorId: string, body: string, mutationId: string, attach: string[] = []) {
    await this.run(['message', 'send', '--to', anchorId, ...attach.flatMap((a) => ['--attach', a]), '--mutation-id', mutationId, '-'], body)
  }

  async uploadFile(path: string, o: { name: string; mime: string; mutationId: string }) {
    const out = await this.run(['file', 'upload', path, '--name', o.name, '--mime', o.mime, '--mutation-id', o.mutationId], undefined, 300_000)
    const fileId = out?.entity?.id ?? out?.id
    if (!fileId) throw new Tm8Error('file upload returned no file id', null, JSON.stringify(out).slice(0, 300))
    return { fileId }
  }

  async fileInfo(id: string) {
    const out = await this.run(['entity', 'get', id])
    if (out?.kind !== 'file') throw new Tm8Error(`${id} is not a tm8 file`, null, '')
    const st = out.state ?? {}
    return { name: st.name ?? out.title ?? 'file', mime: st.mimeType ?? null, size: typeof st.sizeBytes === 'number' ? st.sizeBytes : null }
  }

  async downloadFile(id: string, outPath: string) {
    await this.run(['file', 'download', id, '--output', outPath, '--overwrite'], undefined, 300_000, false)
  }

  async startChat(o: { teammate: string; model: string; title: string; body: string; mutationId: string }) {
    const out = await this.run(
      ['chat', 'start', '--teammate', o.teammate, '--model', o.model, '--mode', 'orchestrate', '--workdir', 'scratch',
        '--title', o.title, '--mutation-id', o.mutationId, '-'],
      o.body,
    )
    const chatId = out?.chat?.id ?? out?.chatId ?? out?.id
    if (!chatId) throw new Tm8Error('chat start returned no chat id', null, JSON.stringify(out).slice(0, 300))
    return { chatId }
  }

  async teammates(): Promise<Teammate[]> {
    const out = await this.run(['teammate', 'list', '--limit', '200'])
    const items: any[] = out?.page?.items ?? out?.items ?? []
    return items.map((i) => ({ id: i.id, title: i.title }))
  }

  async authSession() {
    // The token's own session: auth.* is refused through a space link, so no --space here.
    const out = await this.run(['auth', 'session'], undefined, 60_000, true, false)
    return { expiresAt: out?.session?.expiresAt ?? null }
  }

  tokenFingerprint() {
    const t = this.token()
    return t ? createHash('sha256').update(t).digest('hex').slice(0, 16) : null
  }

  async formGet(id: string): Promise<FormInfo> {
    const out = await this.run(['entity', 'get', id, '--full'])
    if (out?.kind !== 'form') throw new Tm8Error(`${id} is not a tm8 form`, null, '')
    const c = out.content ?? {}
    return {
      id: out.id,
      version: out.version,
      status: c.status ?? out.state?.status ?? 'unknown',
      title: out.title ?? '',
      description: c.description ?? null,
      settings: c.settings ?? {},
      questions: (c.questions ?? []).map((q: any) => ({ key: q.key, type: q.type, title: q.title, help: q.help, required: q.required !== false, config: q.config ?? {} })),
    }
  }

  async formUpdateSettings(id: string, expectVersion: number, settings: Record<string, unknown>, mutationId: string) {
    const out = await this.run(['form', 'update', id, '--expect-version', String(expectVersion), '--settings', JSON.stringify(settings), '--mutation-id', mutationId])
    return Number(out?.entity?.version ?? expectVersion + 1)
  }

  async formAddQuestion(id: string, expectVersion: number, question: FormQuestionSpec, mutationId: string) {
    const out = await this.run(['form', 'question', 'add', id, '--expect-version', String(expectVersion), '--spec', JSON.stringify(question), '--mutation-id', mutationId])
    return Number(out?.entity?.version ?? expectVersion + 1)
  }

  async formSubmit(id: string, answers: Record<string, unknown>, o: { amendOf?: string | null; mutationId: string }) {
    // Answers go in on stdin: they hold whatever people typed in the group.
    const out = await this.run(['form', 'submit', id, '--answers', '-', ...(o.amendOf ? ['--amend-of', o.amendOf] : []), '--mutation-id', o.mutationId], JSON.stringify(answers))
    if (!out?.id) throw new Tm8Error('form submit returned no response id', null, JSON.stringify(out).slice(0, 300))
    return { id: out.id, revision: Number(out.revision ?? 1) }
  }

  async docGet(id: string): Promise<DocInfo> {
    const out = await this.run(['entity', 'get', id, '--full'])
    if (out?.kind !== 'doc') throw new Tm8Error(`${id} is not a tm8 doc`, null, '')
    const c = out.content ?? {}
    return { id: out.id, title: out.title ?? '', body: c.body ?? '', format: c.format ?? out.state?.format ?? 'markdown', updatedAt: out.updatedAt ?? null }
  }

  async updatedAt(id: string): Promise<string | null> {
    const out = await this.run(['entity', 'get', id, '--full'])
    return out?.updatedAt ?? null
  }

  async connections(id: string): Promise<Connection[]> {
    const out = await this.run(['entity', 'context', id, '--sections', 'connections'])
    return Array.isArray(out?.connections) ? out.connections : []
  }

  async stopSession(id: string, note: string, mutationId: string) {
    await this.run(['session', 'terminate', id, '--stop', '--note', note, '--yes', '--mutation-id', mutationId])
  }
}
