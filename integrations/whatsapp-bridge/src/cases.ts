// Cases (POST /case, /pack, GET /case/<id>): one WhatsApp ask that a team of sessions works on. The session that answers
// the ask opens a case for its tm8 task; from then on any session in the group can pass {"case": <task id>} to /say,
// /say-media and /form and it lands on the ask's thread, in the asker's language. The final pack goes out only when the
// case's reviewer has passed it (caseGate).
import { HttpError, type Bridge } from './core.js'
import { packHtml } from './packdoc.js'
import type { CaseRow, Lang, NameRow } from './store.js'
import { detectLang } from './text.js'
import type { ChannelConfig } from './config.js'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** At most one progress ping per case in this window (the contract: about one per 2 minutes). */
export const PING_GAP_MS = 120_000
const SUMMARY_MAX = 1000

type Auth = { name: NameRow | null; nameStr: string; ch: ChannelConfig }

/** What the reviewer gate looks at: every VERDICT on the Review subtask, and the result docs of the other subtasks. */
export type GateSnapshot = {
  /** Messages on the Review subtask: `at` ISO time, isAgent = posted by an agent. */
  verdicts: { at: string; isAgent: boolean; body: string }[]
  /** Result docs (children or produces-targets of the non-Review subtasks), with when they last changed. */
  docs: { id: string; updatedAt: string | null }[]
}

const VERDICT_RE = /^\s*VERDICT:\s*/i

/**
 * The reviewer gate, ported from integrations/case-engine/case-gate (the canonical rule, owned by the Reviewer): the
 * newest agent VERDICT on the Review subtask is a pass, and no result doc changed after it.
 */
export function caseGate(s: GateSnapshot): { pass: boolean; reason: string } {
  const verdicts = s.verdicts.filter((v) => v.isAgent && VERDICT_RE.test(v.body)).sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
  const last = verdicts.at(-1)
  if (!last) return { pass: false, reason: 'no VERDICT from the reviewer on the Review subtask yet' }
  if (!/^pass\b/i.test(last.body.replace(VERDICT_RE, ''))) return { pass: false, reason: `the latest verdict is not a pass: "${last.body.trim().slice(0, 120)}"` }
  const at = Date.parse(last.at)
  const changed = s.docs.filter((d) => d.updatedAt && Date.parse(d.updatedAt) > at)
  if (changed.length) return { pass: false, reason: `result docs changed after the pass verdict (review again): ${changed.map((d) => d.id).join(', ')}` }
  return { pass: true, reason: 'the reviewer passed it and no result changed since' }
}

const REVIEW_TITLE_RE = /^\s*review\b/i

export class Cases {
  constructor(private b: Bridge) {}

  // ---------------------------------------------------------------- POST /case

  async open(auth: Auth, body: any): Promise<{ status: number; body: Record<string, unknown> }> {
    const taskId = typeof body?.task_id === 'string' ? body.task_id.trim() : ''
    if (!UUID_RE.test(taskId)) throw new HttpError(400, 'task_id must be the tm8 id of the case task')
    const ask = typeof body?.ask_wa_msg_id === 'string' ? body.ask_wa_msg_id.trim() : ''
    if (!ask) throw new HttpError(400, 'ask_wa_msg_id is required: the wa_msg_id of the WhatsApp message that asked')
    let lang: Lang | null = null
    if (body?.lang !== undefined && body?.lang !== null && body?.lang !== '') {
      if (body.lang !== 'ar' && body.lang !== 'en') throw new HttpError(400, 'lang must be "ar" or "en" (leave it out to detect it from the ask)')
      lang = body.lang
    }
    const { ch } = auth
    const msg = this.b.store.getMessage(ask)
    if (!msg || msg.channel_id !== ch.id) throw new HttpError(400, 'ask_wa_msg_id is not a message in this group')
    // Whoever may answer the ask may open its case: the main chat, or a session the ask's thread is addressed to.
    if (auth.name?.kind === 'session' && !this.b.threadAddressedTo(ask, auth.nameStr)) {
      throw new HttpError(403, `the ask is not in a thread addressed to ${auth.nameStr}; the main chat opens cases`)
    }
    const prior = this.b.store.getCase(taskId)
    if (prior) {
      if (prior.channel_id !== ch.id || prior.ask_wa_msg_id !== ask) throw new HttpError(409, 'this task is already a case for another ask', { case: this.summary(prior) })
      if (lang && lang !== prior.lang) this.b.store.setCaseLang(taskId, lang)
      return { status: 200, body: { ...this.summary(this.b.store.getCase(taskId)!), duplicate: true } }
    }
    this.b.store.insertCase({ task_id: taskId, channel_id: ch.id, ask_wa_msg_id: ask, lang: lang ?? detectLang(msg.text), opened_by: auth.nameStr })
    const row = this.b.store.getCase(taskId)!
    this.b.log(`[cases ${ch.id}] ${auth.nameStr} opened case ${taskId} for ${ask} (${row.lang}${lang ? '' : ', detected'})`)
    return { status: 200, body: this.summary(row) }
  }

  /** The case a send names, checked to be in the caller's group. */
  resolve(auth: Pick<Auth, 'ch'>, caseId: unknown): CaseRow {
    const id = typeof caseId === 'string' ? caseId.trim() : ''
    if (!UUID_RE.test(id)) throw new HttpError(400, 'case must be a case task id')
    const row = this.b.store.getCase(id)
    if (!row || row.channel_id !== auth.ch.id) throw new HttpError(404, 'no such case in this group: the main chat opens it first with POST /case')
    return row
  }

  /** Is `waId` the case's ask or a message in its thread (quoting its way back to the ask)? */
  inThread(waId: string, c: CaseRow): boolean {
    let cur = this.b.store.getMessage(waId)
    for (let i = 0; cur && i < 20; i++) {
      if (cur.wa_msg_id === c.ask_wa_msg_id) return true
      cur = cur.quoted_wa_msg_id ? this.b.store.getMessage(cur.quoted_wa_msg_id) : undefined
    }
    return false
  }

  /** ms until the case may ping again (0: now). */
  pingWait(c: CaseRow): number {
    return c.last_ping_at === null ? 0 : Math.max(0, c.last_ping_at + PING_GAP_MS - this.b.now())
  }

  summary(c: CaseRow) {
    return {
      case: c.task_id,
      lang: c.lang,
      ask_wa_msg_id: c.ask_wa_msg_id,
      opened_by: c.opened_by,
      pings: c.pings,
      next_ping_in_ms: this.pingWait(c),
      forms: this.b.store.formDeliveriesOfCase(c.task_id).map((d) => ({ form_id: d.form_id, delivery_id: d.id, title: d.title, status: d.status })),
      delivered: c.delivered_at !== null,
      ...(c.delivered_at !== null ? { pack_doc_id: c.pack_doc_id, pack_wa_msg_id: c.pack_wa_msg_id } : {}),
    }
  }

  /** GET /case/<task id> */
  get(auth: Pick<Auth, 'ch'>, id: string) {
    return this.summary(this.resolve(auth, id))
  }

  // ---------------------------------------------------------------- the gate

  /** Read the case from tm8 into a GateSnapshot. `packDocId` is not a result doc. */
  async snapshot(ch: ChannelConfig, caseId: string, packDocId: string | null): Promise<GateSnapshot | { error: string }> {
    const tm8 = this.b.tm8For(ch)
    const ctx = await tm8.context(caseId)
    const subtasks = (ctx.children ?? []).filter((c) => c.kind === 'task')
    const review = subtasks.find((c) => REVIEW_TITLE_RE.test(c.title ?? ''))
    if (!review) return { error: 'the case has no Review subtask' }
    const verdicts = (await tm8.messages(review.id, 200)).map((m) => ({ at: m.at ?? '', isAgent: m.isAgent, body: m.body }))
    const docIds = new Set<string>()
    for (const t of subtasks) {
      if (t.id === review.id) continue
      const tctx = await tm8.context(t.id)
      for (const c of tctx.children ?? []) if (c.kind === 'doc') docIds.add(c.id)
      for (const e of await tm8.connections(t.id)) if (e.type === 'produces' && e.dir === 'out' && e.other.kind === 'doc') docIds.add(e.other.id)
    }
    if (packDocId) docIds.delete(packDocId)
    const docs: GateSnapshot['docs'] = []
    for (const id of docIds) docs.push({ id, updatedAt: await tm8.updatedAt(id) })
    return { verdicts, docs }
  }

  // ---------------------------------------------------------------- POST /pack

  /** The final pack: the summary as the caption of the pack doc (HTML), on the ask's thread. Only after a pass. */
  async pack(auth: Auth, body: any): Promise<{ status: number; body: Record<string, unknown> }> {
    const c = this.resolve(auth, body?.case)
    const docId = typeof body?.doc_id === 'string' ? body.doc_id.trim() : ''
    if (!UUID_RE.test(docId)) throw new HttpError(400, 'doc_id must be the tm8 id of the pack doc')
    const summary = typeof body?.summary === 'string' ? body.summary.trim() : ''
    if (!summary) throw new HttpError(400, `summary is required: a few short lines for the phone, in the case's language (${c.lang})`)
    if (summary.length > SUMMARY_MAX) throw new HttpError(400, `summary is limited to ${SUMMARY_MAX} characters; the details belong in the doc`)
    const key = typeof body?.idempotency_key === 'string' ? body.idempotency_key : ''
    if (!key || key.length > 200) throw new HttpError(400, 'idempotency_key is required (≤200 chars, unique per pack you send)')
    // A retry of a pack that already went out (or is queued) is answered without asking the gate again.
    const repeat = this.b.repeatSend(auth.nameStr, key)
    if (repeat) return { status: repeat.status, body: { ...repeat.body, case: this.summary(c) } }

    const tm8 = this.b.tm8For(auth.ch)
    if (!tm8.configured()) throw new HttpError(503, 'the bridge has no tm8 token for this group yet')
    const snap = await this.snapshot(auth.ch, c.task_id, docId).catch((e) => {
      throw new HttpError(502, `couldn't read the case from tm8 to check the review: ${(e as Error).message.slice(0, 200)}`)
    })
    const gate = 'error' in snap ? { pass: false, reason: snap.error } : caseGate(snap)
    if (!gate.pass) {
      this.b.log(`[cases ${auth.ch.id}] pack for case ${c.task_id} refused: ${gate.reason}`)
      throw new HttpError(409, `the pack can't go out yet: ${gate.reason}`, { reason: 'review_gate', gate: gate.reason })
    }
    const doc = await tm8.docGet(docId).catch((e) => {
      throw new HttpError(400, `doc_id is not a tm8 doc the bridge can read: ${(e as Error).message.slice(0, 200)}`)
    })
    if (!doc.body.trim()) throw new HttpError(400, 'the pack doc is empty')
    const html = packHtml({ title: doc.title, body: doc.body, format: doc.format, lang: c.lang })
    const fileName = typeof body?.file_name === 'string' && body.file_name.trim() ? body.file_name.trim() : `${doc.title || 'pack'}.html`
    const res = await this.b.sayMedia(auth, {
      idempotency_key: key, case: c.task_id, caption: summary, kind: 'document', mime: 'text/html',
      file: { data: Buffer.from(html, 'utf8'), fileName: /\.html?$/i.test(fileName) ? fileName : `${fileName}.html`, mime: 'text/html' },
    })
    this.b.store.recordCasePack(c.task_id, docId, (res.body.wa_msg_id as string | undefined) ?? null)
    this.b.log(`[cases ${auth.ch.id}] ${auth.nameStr} sent the pack for case ${c.task_id} (doc ${docId})`)
    return { status: res.status, body: { ...res.body, case: this.summary(this.b.store.getCase(c.task_id)!) } }
  }
}
