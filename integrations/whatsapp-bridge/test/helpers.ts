// Test fakes: an in-memory WhatsApp port, a scripted tm8 port and a bridge wired to both.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseConfig } from '../src/config.js'
import { Bridge, type Inbound, type WaKey, type WaPort } from '../src/core.js'
import { TooLargeError } from '../src/media.js'
import { Store } from '../src/store.js'
import type { OutboxPoll } from '../src/store.js'
import type { ChatMessage, EntityContext, FormInfo, FormQuestionSpec, Teammate, Tm8Port } from '../src/tm8.js'
import type { Transcriber } from '../src/transcribe.js'

export const OWNER = '910000000001@s.whatsapp.net'
export const OWNER_LID = '100000000000001@lid'
export const GROUP = '120363000000000001@g.us'

export class FakeWa implements WaPort {
  up = true
  sent: { jid: string; text: string; quoted?: string; id: string; media?: { kind: string; mime: string; fileName: string; size: number }; poll?: OutboxPoll }[] = []
  /** Download results by ref: bytes, or an Error to throw. */
  downloads = new Map<string, Buffer | Error>()
  downloadCalls: string[] = []
  reactions: { jid: string; id: string; emoji: string }[] = []
  private n = 0
  connected() {
    return this.up
  }
  async sendText(jid: string, text: string, quoted?: { key: WaKey; message: unknown }) {
    if (!this.up) throw new Error('down')
    const id = `OUT${++this.n}`
    this.sent.push({ jid, text, quoted: quoted?.key.id ?? undefined, id })
    return { id, key: { remoteJid: jid, id, fromMe: true }, message: { conversation: text } }
  }
  async react(jid: string, key: WaKey, emoji: string) {
    this.reactions.push({ jid, id: key.id!, emoji })
  }
  async sendMedia(jid: string, m: { kind: 'image' | 'document'; data: Buffer; mime: string; fileName: string; caption: string }, quoted?: { key: WaKey; message: unknown }) {
    if (!this.up) throw new Error('down')
    const id = `OUT${++this.n}`
    this.sent.push({ jid, text: m.caption, quoted: quoted?.key.id ?? undefined, id, media: { kind: m.kind, mime: m.mime, fileName: m.fileName, size: m.data.length } })
    const message = m.kind === 'image' ? { imageMessage: { caption: m.caption, mimetype: m.mime } } : { documentMessage: { caption: m.caption, mimetype: m.mime, fileName: m.fileName } }
    return { id, key: { remoteJid: jid, id, fromMe: true }, message }
  }
  async sendPoll(jid: string, poll: OutboxPoll) {
    if (!this.up) throw new Error('down')
    const id = `OUT${++this.n}`
    this.sent.push({ jid, text: poll.name, id, poll })
    return { id, key: { remoteJid: jid, id, fromMe: true }, message: { pollCreationMessageV3: { name: poll.name }, messageContextInfo: { messageSecret: 'c2VjcmV0' } } }
  }
  async downloadMedia(ref: string, maxBytes: number) {
    this.downloadCalls.push(ref)
    const r = this.downloads.get(ref)
    if (!r) throw new Error('no such media')
    if (r instanceof Error) throw r
    if (r.length > maxBytes) throw new TooLargeError(r.length, maxBytes)
    return r
  }
}

export class FakeTm8 implements Tm8Port {
  token = true
  posts: { to: string; body: string; attach?: string[] }[] = []
  uploads: { path: string; name: string; mime: string; mutationId: string; bytes: number }[] = []
  failUploads = 0
  files = new Map<string, { name: string; mime: string | null; data: Buffer }>()
  chats: { title: string; body: string; teammate: string }[] = []
  contexts = new Map<string, EntityContext>()
  failPosts = 0
  stopped: string[] = []
  private n = 0
  configured() {
    return this.token
  }
  async context(id: string) {
    return this.contexts.get(id) ?? { id, kind: 'chat', launchedSessions: [] }
  }
  async post(to: string, body: string, _mutationId?: string, attach?: string[]) {
    if (this.failPosts > 0) {
      this.failPosts--
      throw new Error('tm8 down')
    }
    this.posts.push({ to, body, ...(attach?.length ? { attach } : {}) })
    this.chatMessages.get(to)?.push({ id: nextId(), body, isAgent: false, batch: 'b' })
  }
  /** Messages per chat for message list (fallback relay); posts to a chat listed here are added as human messages. */
  chatMessages = new Map<string, ChatMessage[]>()
  messageCalls = 0
  async messages(anchorId: string, limit: number) {
    this.messageCalls++
    return (this.chatMessages.get(anchorId) ?? []).slice(-limit)
  }
  async uploadFile(p: string, o: { name: string; mime: string; mutationId: string }) {
    if (this.failUploads > 0) {
      this.failUploads--
      throw new Error('upload failed')
    }
    this.uploads.push({ path: p, ...o, bytes: fs.statSync(p).size })
    return { fileId: `file-${this.uploads.length}` }
  }
  async fileInfo(id: string) {
    const f = this.files.get(id)
    if (!f) throw new Error('not found')
    return { name: f.name, mime: f.mime, size: f.data.length }
  }
  async downloadFile(id: string, out: string) {
    fs.writeFileSync(out, this.files.get(id)!.data)
  }
  async startChat(o: { teammate: string; title: string; body: string }) {
    this.chats.push(o)
    return { chatId: `chat-${++this.n}` }
  }
  /** Overrides the default teammate list (another space has other teammates). */
  team: Teammate[] | null = null
  async teammates(): Promise<Teammate[]> {
    if (this.team) return this.team
    return [
      { id: '01a0fb41-3317-77f3-b2b5-2bba3e489f4d', title: 'Opus 5.5 1M Teammate' },
      { id: 'tm-backend', title: 'Backend Engineer' },
    ]
  }
  expiresAt: string | null = null
  fingerprint = 'fp1'
  authCalls = 0
  async authSession() {
    this.authCalls++
    return { expiresAt: this.expiresAt }
  }
  tokenFingerprint() {
    return this.token ? this.fingerprint : null
  }
  async stopSession(id: string) {
    this.stopped.push(id)
  }
  /** Forms by id; submits are recorded, and `responses` counts submitted responses (structure freezes at the first). */
  forms = new Map<string, FormInfo & { responses: number }>()
  submits: { formId: string; answers: Record<string, any>; amendOf: string | null; mutationId: string }[] = []
  /** Errors the next submits throw (then they succeed). */
  submitErrors: Error[] = []
  formCalls: string[] = []
  async formGet(id: string): Promise<FormInfo> {
    this.formCalls.push(`get ${id}`)
    const f = this.forms.get(id)
    if (!f) throw new Error(`tm8 entity get failed: not_found`)
    return structuredClone(f)
  }
  async formUpdateSettings(id: string, v: number, settings: Record<string, unknown>) {
    const f = this.forms.get(id)!
    if (f.version !== v) throw new Error('version_conflict')
    if (f.responses && 'responses' in settings) throw new Error('form_structure_frozen')
    this.formCalls.push(`update ${id} ${JSON.stringify(settings)}`)
    Object.assign(f.settings, settings)
    return ++f.version
  }
  async formAddQuestion(id: string, v: number, q: FormQuestionSpec) {
    const f = this.forms.get(id)!
    if (f.version !== v) throw new Error('version_conflict')
    if (f.responses) throw new Error('form_structure_frozen')
    this.formCalls.push(`add ${id} ${q.key}`)
    f.questions.push(q)
    return ++f.version
  }
  async formSubmit(formId: string, answers: Record<string, unknown>, o: { amendOf?: string | null; mutationId: string }) {
    const err = this.submitErrors.shift()
    if (err) throw err
    const f = this.forms.get(formId)!
    if (f.status !== 'open') throw new Error('tm8 form submit failed: form_not_open')
    f.responses++
    this.submits.push({ formId, answers: structuredClone(answers), amendOf: o.amendOf ?? null, mutationId: o.mutationId })
    return { id: `resp-${this.submits.length}`, revision: o.amendOf ? 2 : 1 }
  }
}

export function setup(extra: { now?: () => number; rateLimits?: any; selfOnly?: boolean; media?: any; transcription?: any; transcriber?: Transcriber } = {}) {
  const cfg = parseConfig(
    {
      ownerJids: [OWNER, OWNER_LID],
      rateLimits: extra.rateLimits,
      media: extra.media,
      transcription: extra.transcription,
      channels: [
        { id: 'self', jid: OWNER, altJids: [OWNER_LID], title: 'Message yourself' },
        ...(extra.selfOnly ? [] : [{ id: 'infra', jid: GROUP, title: 'Infra', allowedSenders: ['owner', '919999999999@s.whatsapp.net'] }]),
      ],
    },
    '/tmp',
  )
  const store = new Store(':memory:', extra.now)
  const wa = new FakeWa()
  const tm8 = new FakeTm8()
  const logs: string[] = []
  const mediaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wab-media-'))
  const tokenDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wab-tokens-'))
  const bridge = new Bridge(cfg, store, wa, tm8, { now: extra.now, log: (m) => logs.push(m), retryDelaysMs: [0, 0, 0], mediaDir, transcriber: extra.transcriber, tokenDir })
  return { cfg, store, wa, tm8, bridge, logs, mediaDir, tokenDir }
}

let seq = 0
export function inbound(p: Partial<Inbound> & { text: string }): Inbound {
  const id = p.id ?? `IN${++seq}`
  return {
    id,
    chatJid: OWNER_LID,
    chatAltJid: OWNER,
    fromMe: true,
    senderJid: OWNER,
    senderAltJid: OWNER_LID,
    senderName: 'Subhang',
    kind: 'text',
    quotedId: null,
    mentionedJids: [],
    ts: Math.floor(Date.now() / 1000),
    key: { remoteJid: p.chatJid ?? OWNER_LID, id, fromMe: p.fromMe ?? true },
    message: { conversation: p.text },
    ...p,
  }
}

/** Bridge with the self channel's main chat created and a known speaker token for it. */
export async function withMain(extra: Parameters<typeof setup>[0] = {}) {
  const t = setup(extra)
  const ch = t.cfg.channels[0]
  await t.bridge.ensureMainChat(ch)
  const mainToken = t.bridge.issueToken('self-main', 'self')
  return { ...t, ch, mainToken, auth: (tok = mainToken) => t.bridge.authenticate(`Bearer ${tok}`) }
}

/** The speaker token a briefing points at: briefings name only the file (TOKEN=$(cat <file>)), so read it from there. */
export function briefToken(body: string): string {
  assert.ok(!/wab_/.test(body), 'a briefing must never carry a token')
  const file = /TOKEN=\$\(cat (\S+?)\)/.exec(body)?.[1]
  assert.ok(file, 'briefing names no token file')
  const st = fs.statSync(file)
  assert.equal(st.mode & 0o777, 0o600)
  return fs.readFileSync(file, 'utf8').trim()
}

let idSeq = 0
/** Increasing uuidv7-like ids, so message and turn ids sort in time order as tm8's do. */
export function nextId(): string {
  return `01a2${(++idSeq).toString(16).padStart(8, '0')}-0000-7000-8000-000000000000`
}

/** An agent's chat-turn reply: `turnId` from nextId() taken when the turn started; parts as tm8 stores them. */
export function agentTurn(turnId: string, parts: ({ text: string; itemId?: string } | 'tool' | 'done')[]): ChatMessage {
  return {
    id: nextId(), body: 'Agent turn in progress.', isAgent: true, batch: `chat-turn:${turnId}`,
    parts: parts.flatMap((p, i) =>
      p === 'tool'
        ? [{ seq: i * 2, kind: 'tool_call', payload: '{"name":"Bash"}' }, { seq: i * 2 + 1, kind: 'tool_result', payload: '{}' }]
        : p === 'done'
          ? [{ seq: i * 2, kind: 'done', payload: '{"reason":"success"}' }]
          : [{ seq: i * 2, kind: 'text', payload: JSON.stringify(p) }],
    ),
  }
}
