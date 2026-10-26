// tm8 forms in WhatsApp groups (POST /form): choice questions go out as native polls, text and scale questions as numbered
// messages. Votes and replies are collected per group member and submitted into tm8 as that member's form response.
//
// tm8 records every submit as the bridge token's member, so each WhatsApp member gets their own response chain
// (settings.responses "unlimited") and the bridge fills an optional question, wa_respondent, with who it was.
import crypto from 'node:crypto'
import { maskJid } from './briefing.js'
import type { ChannelConfig } from './config.js'
import { HttpError, type Bridge, type Inbound } from './core.js'
import { stableUuid } from './media.js'
import type { FormDeliveryRow, FormRespondentRow, Lang, OutboxPoll } from './store.js'
import { asciiDigits, detectLang, speakerLine } from './text.js'
import type { FormInfo, FormQuestionSpec } from './tm8.js'

/** The question the bridge adds to a form so every response says which WhatsApp member gave it. */
export const WA_RESPONDENT_KEY = 'wa_respondent'
const WA_RESPONDENT_QUESTION: FormQuestionSpec = {
  key: WA_RESPONDENT_KEY,
  type: 'short_text',
  title: 'WhatsApp respondent',
  help: 'Filled in by the WhatsApp bridge: who answered in the group. Leave it empty.',
  required: false,
  config: {},
}
/** WhatsApp shows at most 12 poll options; a choice question with more goes out as a numbered list. */
export const POLL_MAX_OPTIONS = 12
const POLL_NAME_MAX = 255
const SUPPORTED = new Set(['single_choice', 'multi_choice', 'short_text', 'long_text', 'scale'])
const FORM_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** How often an active delivery re-reads its form's status (to stop collecting once it is closed). */
const STATUS_CHECK_MS = 5 * 60_000
const MAX_SUBMIT_ATTEMPTS = 5

/** An option as sent: `name` is the poll option text, `hash` its SHA-256 (what a vote carries). */
type SentOption = { value: string; label: string; name: string; hash: string }
/** A question as the bridge put it into the group: `n` is its number there, `mode` how it went out. */
export type FormQuestion = {
  n: number
  key: string
  type: string
  title: string
  help: string | null
  required: boolean
  config: Record<string, any>
  mode: 'poll' | 'text'
  options: SentOption[] | null
}
type Answer = { value: string } | { values: string[] } | { text: string } | { number: number }
export type PollVote = { chatJid: string; pollId: string; voterJids: string[]; voterName: string | null; hashes: string[] }

/** The bridge's own words around a form, per language. Question titles, help and options are the form author's. */
const T = {
  en: {
    optionalPoll: ' (optional)',
    optionalText: ' _(optional)_',
    q: (n: number) => `Q${n}`,
    scale: (min: string, max: string) => `Reply with a number from ${min} to ${max}.`,
    one: 'Reply with one number.',
    many: 'Reply with the numbers, e.g. "1, 3".',
    text: (n: number) => `Reply to this message with your answer, or write "${n}: your answer".`,
    howPolls: 'vote in the polls below',
    howTexts: 'reply to each numbered question (or write "2: your answer")',
    how: (parts: string[]) => `To answer, ${parts.join(' and ')}. You can change an answer any time.`,
    needs: (q: string) => `${q} needs an answer`,
    scaleErr: (q: string, min: number, max: number) => `${q} takes a number from ${min} to ${max}`,
    optErr: (q: string, single: boolean, n: number) => `${q}: reply with ${single ? 'one option number' : 'option numbers'} from 1 to ${n}`,
    oneErr: (q: string) => `${q} takes one option number`,
    atMost: (q: string, n: number) => `${q}: pick at most ${n}`,
    atLeast: (q: string, n: number) => `${q}: pick at least ${n}`,
    maxLen: (q: string, n: number) => `${q} is limited to ${n} characters`,
    minLen: (q: string, n: number) => `${q} needs at least ${n} characters`,
    refused: (who: string | null, title: string) => `couldn't record ${who ? `${who}'s` : 'some'} answers to "${title}"; please check them and answer again`,
  },
  ar: {
    optionalPoll: ' (اختياري)',
    optionalText: ' _(اختياري)_',
    q: (n: number) => `س${n}`,
    scale: (min: string, max: string) => `أرسل رقمًا من ${min} إلى ${max}.`,
    one: 'أرسل رقمًا واحدًا.',
    many: 'أرسل الأرقام، مثلًا "1، 3".',
    text: (n: number) => `ردّ على هذه الرسالة بإجابتك، أو اكتب "${n}: إجابتك".`,
    howPolls: 'صوّت في الاستطلاعات أدناه',
    howTexts: 'ردّ على كل سؤال مرقّم (أو اكتب "2: إجابتك")',
    how: (parts: string[]) => `للإجابة، ${parts.join(' و')}. يمكنك تغيير إجابتك في أي وقت.`,
    needs: (q: string) => `${q} يحتاج إلى إجابة`,
    scaleErr: (q: string, min: number, max: number) => `${q}: أرسل رقمًا من ${min} إلى ${max}`,
    optErr: (q: string, single: boolean, n: number) => `${q}: أرسل ${single ? 'رقم خيار واحد' : 'أرقام الخيارات'} من 1 إلى ${n}`,
    oneErr: (q: string) => `${q}: اختر خيارًا واحدًا فقط`,
    atMost: (q: string, n: number) => `${q}: اختر ${n} على الأكثر`,
    atLeast: (q: string, n: number) => `${q}: اختر ${n} على الأقل`,
    maxLen: (q: string, n: number) => `${q}: الحد الأقصى ${n} حرفًا`,
    minLen: (q: string, n: number) => `${q}: يحتاج إلى ${n} حرفًا على الأقل`,
    refused: (who: string | null, title: string) => `تعذّر تسجيل إجابات ${who ?? 'أحد المشاركين'} على "${title}"؛ يرجى مراجعتها والإجابة مرة أخرى`,
  },
} satisfies Record<Lang, unknown>

/** The language of a form's own text: Arabic if its title and questions are mostly Arabic. */
export function formLang(form: Pick<FormInfo, 'title' | 'description' | 'questions'>): Lang {
  return detectLang([form.title, form.description ?? '', ...form.questions.map((q) => q.title)].join(' '))
}

const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex')
const clip = (s: string, n: number) => ([...s].length > n ? [...s].slice(0, n - 1).join('') + '…' : s)

/** The questions as they go out: numbered from 1, options with unique poll names, the bridge's own question left out. */
export function planQuestions(questions: FormQuestionSpec[]): FormQuestion[] {
  return questions
    .filter((q) => q.key !== WA_RESPONDENT_KEY)
    .map((q, i) => {
      const choice = q.type === 'single_choice' || q.type === 'multi_choice'
      const opts: { value: string; label: string }[] = choice ? (q.config.options ?? []) : []
      const seen = new Set<string>()
      const options = choice
        ? opts.map((o) => {
            // Poll options must be unique; a repeated label gets its value appended.
            let name = clip(o.label, 100)
            if (seen.has(name)) name = clip(`${o.label} (${o.value})`, 100)
            seen.add(name)
            return { value: o.value, label: o.label, name, hash: sha256(name) }
          })
        : null
      return {
        n: i + 1,
        key: q.key,
        type: q.type,
        title: q.title,
        help: q.help ?? null,
        required: q.required,
        config: q.config ?? {},
        mode: choice && opts.length <= POLL_MAX_OPTIONS ? 'poll' : 'text',
        options,
      }
    })
}

function scaleRange(q: FormQuestion) {
  return { min: q.config.min ?? 1, max: q.config.max ?? 5, minLabel: q.config.minLabel as string | undefined, maxLabel: q.config.maxLabel as string | undefined }
}

/** The poll for a choice question. */
export function pollFor(q: FormQuestion, lang: Lang = 'en'): OutboxPoll {
  const name = clip(`${q.n}. ${q.title}${q.required ? '' : T[lang].optionalPoll}`, POLL_NAME_MAX)
  const selectableCount = q.type === 'single_choice' ? 1 : Math.min(q.config.maxSelected ?? 0, q.options!.length)
  return { name, values: q.options!.map((o) => o.name), selectableCount }
}

/** The numbered message for a text, scale or long choice question (without the speaker prefix). */
export function questionText(q: FormQuestion, lang: Lang = 'en'): string {
  const t = T[lang]
  const lines = [`*${t.q(q.n)}.* ${q.title}${q.required ? '' : t.optionalText}`]
  if (q.help) lines.push(clip(q.help, 300))
  if (q.type === 'scale') {
    const r = scaleRange(q)
    lines.push(t.scale(`${r.min}${r.minLabel ? ` (${r.minLabel})` : ''}`, `${r.max}${r.maxLabel ? ` (${r.maxLabel})` : ''}`))
  } else if (q.mode === 'text' && q.options) {
    lines.push(...q.options.map((o, i) => `${i + 1}) ${o.label}`))
    lines.push(q.type === 'single_choice' ? t.one : t.many)
  } else {
    lines.push(t.text(q.n))
  }
  return lines.join('\n')
}

export function introText(form: Pick<FormInfo, 'title' | 'description'>, qs: FormQuestion[], lang: Lang = 'en'): string {
  const t = T[lang]
  const lines = [`📋 *${clip(form.title, 200)}*`]
  if (form.description) lines.push(clip(form.description.replace(/\s+/g, ' ').trim(), 300))
  const polls = qs.some((q) => q.mode === 'poll')
  const texts = qs.some((q) => q.mode === 'text')
  const how = [polls ? t.howPolls : null, texts ? t.howTexts : null].filter((x): x is string => !!x)
  lines.push(t.how(how))
  return lines.join('\n')
}

/** Parse a typed answer for one question; `error` is a short hint for the group. */
export function parseTextAnswer(q: FormQuestion, raw: string, lang: Lang = 'en'): { answer: Answer } | { error: string } {
  const t = T[lang]
  const Q = t.q(q.n)
  const text = raw.trim()
  if (!text) return { error: t.needs(Q) }
  // Numbers may come in Arabic-Indic digits; free text keeps whatever was typed.
  const digits = asciiDigits(text)
  if (q.type === 'scale') {
    const r = scaleRange(q)
    const m = /^(\d{1,2})(?!\d)/.exec(digits)
    const n = m ? Number(m[1]) : NaN
    if (!(n >= r.min && n <= r.max)) return { error: t.scaleErr(Q, r.min, r.max) }
    return { answer: { number: n } }
  }
  if (q.options) {
    // The option's label typed out, or its number(s) from the list.
    const byLabel = q.options.find((o) => o.label.toLowerCase() === text.toLowerCase())
    const values: string[] = []
    if (byLabel) values.push(byLabel.value)
    else {
      // "1, 3", "1 and 3", "١ و ٣", "1،3"; an Arabic "و" (and) may be glued to the number.
      for (const p of digits.split(/[\s,;&\u060C]+|\band\b/i).map((x) => x.replace(/^\u0648/, '')).filter(Boolean)) {
        const opt = /^\d{1,2}$/.test(p) ? q.options[Number(p) - 1] : undefined
        if (!opt) return { error: t.optErr(Q, q.type === 'single_choice', q.options.length) }
        if (!values.includes(opt.value)) values.push(opt.value)
      }
    }
    if (q.type === 'single_choice') {
      if (values.length !== 1) return { error: t.oneErr(Q) }
      return { answer: { value: values[0] } }
    }
    const max = q.config.maxSelected as number | undefined
    if (max !== undefined && values.length > max) return { error: t.atMost(Q, max) }
    if (values.length < (q.config.minSelected ?? 0)) return { error: t.atLeast(Q, q.config.minSelected) }
    return { answer: { values } }
  }
  const max = q.config.maxLength ?? (q.type === 'short_text' ? 500 : 20000)
  if ([...text].length > max) return { error: t.maxLen(Q, max) }
  if (q.type === 'long_text' && q.config.minLength && [...text].length < q.config.minLength) {
    return { error: t.minLen(Q, q.config.minLength) }
  }
  return { answer: { text } }
}

/**
 * "2: answer", "Q2. answer", "2) answer", "س٢: إجابة": one segment per numbered line; text after a number line continues
 * it. The number may be in Arabic-Indic digits.
 */
export function parseNumbered(text: string): { n: number; text: string }[] | null {
  const out: { n: number; text: string }[] = []
  for (const line of text.split('\n')) {
    const m = /^\s*(?:[Qq]|\u0633)?([0-9\u0660-\u0669\u06F0-\u06F9]{1,2})\s*[:.)\uFF1A]\s*(.*)$/.exec(line)
    if (m) out.push({ n: Number(asciiDigits(m[1])), text: m[2] })
    else if (out.length) out[out.length - 1].text += '\n' + line
    else return null
  }
  return out.length ? out : null
}

/** Who answered, as the wa_respondent answer: their WhatsApp name (self-chosen) and masked number. */
function respondentLabel(r: Pick<FormRespondentRow, 'name' | 'person'>, ch: ChannelConfig): string {
  return clip(`"${r.name ?? 'unknown'}" ${maskJid(r.person)} in WhatsApp group "${ch.title}"`, 500)
}

/** The PN JID if we have one (stable across LID/PN), else the first. */
function personKey(jids: string[]): string {
  return jids.find((j) => j.endsWith('@s.whatsapp.net')) ?? jids[0]
}

export class Forms {
  private flushing: Promise<void> | null = null
  private timer: NodeJS.Timeout | null = null

  constructor(private b: Bridge) {}

  // ---------------------------------------------------------------- POST /form

  async deliver(auth: { nameStr: string; ch: ChannelConfig }, body: any): Promise<{ status: number; body: Record<string, unknown> }> {
    const formId = typeof body?.form_id === 'string' ? body.form_id.trim() : ''
    if (!FORM_ID_RE.test(formId)) throw new HttpError(400, 'form_id must be a tm8 form id')
    const key = typeof body?.idempotency_key === 'string' ? body.idempotency_key : ''
    if (!key || key.length > 200) throw new HttpError(400, 'idempotency_key is required (≤200 chars, unique per form you send)')
    const { ch } = auth
    const prior = this.b.store.formDeliveryByKey(auth.nameStr, key)
    if (prior) return { status: 200, body: { ...this.summary(prior), duplicate: true } }
    const active = this.b.store.activeFormDelivery(formId, ch.id)
    if (active) throw new HttpError(409, 'this form is already in the group and still collecting answers', { delivery: this.summary(active) })

    const tm8 = this.b.tm8For(ch)
    if (!tm8.configured()) throw new HttpError(503, 'the bridge has no tm8 token for this group yet')
    let form = await tm8.formGet(formId).catch((e) => {
      throw new HttpError(400, `form_id is not a tm8 form the bridge can read: ${(e as Error).message.slice(0, 200)}`)
    })
    if (form.status !== 'open') throw new HttpError(409, `the form is ${form.status}; open it first (tm8 form open ${formId})`)
    const unsupported = form.questions.filter((q) => q.key !== WA_RESPONDENT_KEY && !SUPPORTED.has(q.type))
    if (unsupported.length) throw new HttpError(400, `question types the bridge can't put in WhatsApp: ${unsupported.map((q) => `${q.key} (${q.type})`).join(', ')}`)
    const qs = planQuestions(form.questions)
    if (qs.length === 0) throw new HttpError(400, 'the form has no questions')
    // For a case: the intro answers the ask (its thread) and the bridge's words are in the case's language.
    const kase = body?.case !== undefined && body?.case !== null && body?.case !== '' ? this.b.cases.resolve(auth, body.case) : null
    const lang: Lang = kase?.lang ?? (body?.lang === 'ar' || body?.lang === 'en' ? body.lang : formLang(form))
    form = await this.prepare(tm8, form, ch)

    // One rate-limit slot for the whole form; its messages go out back to back.
    const wait = this.b.takeSendSlot(auth.nameStr, ch.id)
    if (wait) throw new HttpError(429, 'rate limited', { retry_after_ms: wait })
    const store = this.b.store
    const deliveryId = store.db.transaction(() => {
      const id = store.insertFormDelivery({
        form_id: formId, channel_id: ch.id, requested_by: auth.nameStr, idempotency_key: key, title: form.title,
        questions_json: JSON.stringify(qs), allow_amend: form.settings.allowAmend === false ? 0 : 1, lang, case_id: kase?.task_id ?? null,
      })
      const add = (kind: 'intro' | 'poll' | 'text', questionKey: string | null, text: string, poll?: OutboxPoll) => {
        const replyTo = kind === 'intro' ? (kase?.ask_wa_msg_id ?? null) : null
        const outboxId = store.insertOutbox({ idempotency_key: null, name: auth.nameStr, channel_id: ch.id, text, reply_to: replyTo, poll })
        store.insertFormMessage({ outbox_id: outboxId, delivery_id: id, question_key: questionKey, kind })
      }
      add('intro', null, speakerLine({ kind: 'main' }, introText(form, qs, lang)))
      for (const q of qs) {
        if (q.mode === 'poll') {
          const poll = pollFor(q, lang)
          add('poll', q.key, `[poll] ${poll.name}: ${poll.values.join(' / ')}`, poll)
        } else add('text', q.key, speakerLine({ kind: 'main' }, questionText(q, lang)))
      }
      return id
    })()
    this.b.log(`[forms ${ch.id}] ${auth.nameStr} put form ${formId} "${form.title}" in the group (${qs.length} questions, ${lang}, delivery ${deliveryId}${kase ? `, case ${kase.task_id}` : ''})`)
    if (this.b.wa.connected()) await this.b.flushQueue()
    const d = store.formDelivery(deliveryId)!
    const sent = store.formMessagesOf(deliveryId).every((m) => m.wa_msg_id)
    return { status: sent ? 200 : 202, body: { ...this.summary(d), ...(sent ? {} : { queued: true }) } }
  }

  /**
   * Ready the form for many WhatsApp respondents: responses "unlimited" (one chain per member, all submitted by the
   * bridge's token) and the wa_respondent question. Both change the form's structure, so they only work before its
   * first submitted response.
   */
  private async prepare(tm8: ReturnType<Bridge['tm8For']>, form: FormInfo, ch: ChannelConfig): Promise<FormInfo> {
    const needsUnlimited = form.settings.responses !== 'unlimited'
    const needsQuestion = !form.questions.some((q) => q.key === WA_RESPONDENT_KEY)
    if (!needsUnlimited && !needsQuestion) return form
    let version = form.version
    try {
      if (needsUnlimited) {
        version = await tm8.formUpdateSettings(form.id, version, { responses: 'unlimited' }, stableUuid(`form-settings:${form.id}:${version}`))
      }
      if (needsQuestion) {
        version = await tm8.formAddQuestion(form.id, version, WA_RESPONDENT_QUESTION, stableUuid(`form-question:${form.id}:${version}`))
      }
    } catch (e) {
      const msg = (e as Error).message
      if (/form_structure_frozen|frozen/i.test(msg)) {
        throw new HttpError(409, 'the form already has responses, so the bridge cannot set it up for WhatsApp (responses: unlimited plus a wa_respondent question). Create a new form and send that one.')
      }
      if (/version_conflict/i.test(msg)) throw new HttpError(409, 'the form changed while the bridge was setting it up; send it again')
      throw new HttpError(502, `couldn't set the form up for WhatsApp: ${msg.slice(0, 300)}`)
    }
    this.b.log(`[forms ${ch.id}] form ${form.id} set up for WhatsApp (${needsUnlimited ? 'responses unlimited' : ''}${needsUnlimited && needsQuestion ? ', ' : ''}${needsQuestion ? WA_RESPONDENT_KEY : ''})`)
    return { ...form, version }
  }

  summary(d: FormDeliveryRow) {
    const qs: FormQuestion[] = JSON.parse(d.questions_json)
    const msgs = this.b.store.formMessagesOf(d.id)
    const waOf = (k: string | null) => msgs.find((m) => m.question_key === k)?.wa_msg_id ?? null
    const respondents = this.b.store.formRespondents(d.id)
    return {
      delivery_id: d.id,
      form_id: d.form_id,
      title: d.title,
      status: d.status,
      lang: d.lang,
      ...(d.case_id ? { case: d.case_id } : {}),
      intro_wa_msg_id: waOf(null),
      questions: qs.map((q) => ({ n: q.n, key: q.key, type: q.type, as: q.mode, wa_msg_id: waOf(q.key) })),
      respondents: respondents.map((r) => ({
        name: r.name,
        number: maskJid(r.person),
        answered: Object.keys(JSON.parse(r.answers_json)),
        response_id: r.response_id,
        state: r.error ? 'error' : r.due_at ? 'submitting' : r.response_id ? 'submitted' : 'incomplete',
        ...(r.error ? { error: r.error } : {}),
      })),
    }
  }

  /** GET /forms: the group's deliveries, newest first. */
  list(ch: ChannelConfig) {
    return { forms: this.b.store.formDeliveries(ch.id, { limit: 20 }).map((d) => this.summary(d)) }
  }

  // ---------------------------------------------------------------- answers

  /** A poll vote (already decrypted by the WhatsApp adapter). An empty vote clears the answer. */
  async onPollVote(v: PollVote): Promise<void> {
    const msg = this.b.store.formMessage(v.pollId)
    if (!msg || msg.kind !== 'poll') return
    const d = this.b.store.formDelivery(msg.delivery_id)
    if (!d || d.status !== 'active') return
    const ch = this.b.channelOf(d.channel_id)
    if (!ch || !this.b.channelJids(ch).includes(v.chatJid)) return
    if (!this.b.senderAllowedJids(ch, v.voterJids)) return
    const q = (JSON.parse(d.questions_json) as FormQuestion[]).find((x) => x.key === msg.question_key)
    if (!q?.options) return
    const values = v.hashes.map((h) => q.options!.find((o) => o.hash === h)?.value).filter((x): x is string => !!x)
    let answer: Answer | null = null
    if (values.length) {
      if (q.type === 'single_choice') answer = { value: values[0] }
      else if (values.length >= (q.config.minSelected ?? 0)) answer = { values }
    }
    this.b.log(`[forms ${ch.id}] ${v.voterName ?? v.voterJids[0]} voted on Q${q.n} of delivery ${d.id}: ${values.join(', ') || '(cleared)'}`)
    this.record(d, ch, v.voterJids, v.voterName, q.key, answer)
  }

  /**
   * A typed answer: a reply to a numbered question, or "n: answer" while a form is collecting in the group. Returns true
   * if the message was taken as an answer (then it isn't routed to the agents). Mentions of the bridge always route.
   */
  async onText(ch: ChannelConfig, m: Inbound): Promise<boolean> {
    if (m.kind !== 'text' || !m.text.trim()) return false
    if (m.mentionedJids.some((j) => this.b.ownJids.has(j))) return false
    const jids = [m.senderJid, m.senderAltJid].filter((j): j is string => !!j)
    if (jids.length === 0) return false

    if (m.quotedId) {
      const fm = this.b.store.formMessage(m.quotedId)
      if (!fm || fm.kind !== 'text') return false
      const d = this.b.store.formDelivery(fm.delivery_id)
      if (!d || d.status !== 'active' || d.channel_id !== ch.id) return false
      const q = (JSON.parse(d.questions_json) as FormQuestion[]).find((x) => x.key === fm.question_key)!
      // "2: answer" quoting question 2 is fine too.
      const numbered = parseNumbered(m.text)
      const raw = numbered?.length === 1 && numbered[0].n === q.n ? numbered[0].text : m.text
      return this.applyTyped(ch, m, d, [{ q, raw }], jids)
    }

    const segs = parseNumbered(m.text)
    if (!segs) return false
    // The newest collecting form in this group whose numbered questions cover every segment.
    for (const d of this.b.store.formDeliveries(ch.id, { activeOnly: true })) {
      const qs: FormQuestion[] = JSON.parse(d.questions_json)
      const picked = segs.map((s) => ({ q: qs.find((q) => q.n === s.n && q.mode === 'text'), raw: s.text }))
      if (picked.every((p) => p.q)) return this.applyTyped(ch, m, d, picked as { q: FormQuestion; raw: string }[], jids)
    }
    return false
  }

  private async applyTyped(ch: ChannelConfig, m: Inbound, d: FormDeliveryRow, items: { q: FormQuestion; raw: string }[], jids: string[]): Promise<boolean> {
    const errors: string[] = []
    for (const { q, raw } of items) {
      const r = parseTextAnswer(q, raw, d.lang)
      if ('error' in r) errors.push(r.error)
      else {
        this.b.log(`[forms ${ch.id}] ${m.senderName ?? jids[0]} answered Q${q.n} of delivery ${d.id}`)
        this.record(d, ch, jids, m.senderName, q.key, r.answer)
      }
    }
    if (errors.length) await this.b.sendBridge(ch, errors.join('; '), m.id)
    else await this.b.reactTo(ch, m.id, '📝')
    return true
  }

  /** Store one answer for a member; once every required question is answered, their submit is scheduled. */
  private record(d: FormDeliveryRow, ch: ChannelConfig, jids: string[], name: string | null, key: string, answer: Answer | null) {
    const store = this.b.store
    const rows = store.formRespondents(d.id)
    let r = rows.find((x) => (JSON.parse(x.jids) as string[]).some((j) => jids.includes(j)))
    if (!r) {
      const id = store.insertFormRespondent({ delivery_id: d.id, person: personKey(jids), jids: JSON.stringify(jids), name })
      r = store.formRespondent(id)!
    }
    const known = new Set<string>(JSON.parse(r.jids))
    for (const j of jids) known.add(j)
    const answers: Record<string, Answer> = JSON.parse(r.answers_json)
    if (answer) answers[key] = answer
    else delete answers[key]
    const qs: FormQuestion[] = JSON.parse(d.questions_json)
    const complete = qs.every((q) => !q.required || answers[q.key])
    const changed = JSON.stringify(sortKeys(answers)) !== r.submitted_json
    // Once submitted without allowAmend, the response is final.
    const amendable = !r.response_id || d.allow_amend === 1
    const due = complete && changed && amendable ? this.b.now() + this.b.cfg.forms.submitDelaySeconds * 1000 : null
    store.updateFormRespondent(r.id, { jids: JSON.stringify([...known]), name: name ?? r.name, answers_json: JSON.stringify(answers), due_at: due, attempts: 0, error: null })
    if (due !== null) this.schedule(due - this.b.now())
    else if (complete && changed && !amendable) this.b.log(`[forms ${ch.id}] delivery ${d.id}: ${name ?? r.person} changed an answer, but the form doesn't allow amends`)
  }

  private schedule(ms: number) {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => void this.flushDue(), Math.max(0, ms) + 50)
    this.timer.unref?.()
  }

  // ---------------------------------------------------------------- submitting

  /** Submit every member whose answers are due. Also run from the bridge's periodic tick (after a restart, retries). */
  flushDue(): Promise<void> {
    if (this.flushing) return this.flushing
    const run = async () => {
      for (const r of this.b.store.dueFormRespondents(this.b.now())) await this.submit(r)
    }
    // Cleared only after it is stored: with nothing due, run() settles before this assignment would otherwise happen.
    const p: Promise<void> = run().finally(() => {
      if (this.flushing === p) this.flushing = null
    })
    this.flushing = p
    return p
  }

  private async submit(r: FormRespondentRow) {
    const store = this.b.store
    const d = store.formDelivery(r.delivery_id)
    const ch = d && this.b.channelOf(d.channel_id)
    if (!d || !ch) return store.updateFormRespondent(r.id, { due_at: null })
    const answers = sortKeys(JSON.parse(r.answers_json))
    const body = { ...answers, [WA_RESPONDENT_KEY]: { text: respondentLabel(r, ch) } }
    const snapshot = JSON.stringify(answers)
    try {
      const res = await this.b.tm8For(ch).formSubmit(d.form_id, body, {
        amendOf: r.response_id,
        // Same member, same revision, same answers: a retried call is the same submit.
        mutationId: stableUuid(`form-submit:${d.id}:${r.id}:${r.submissions}:${snapshot}`),
      })
      store.updateFormRespondent(r.id, { response_id: res.id, submitted_json: snapshot, submissions: r.submissions + 1, due_at: null, attempts: 0, error: null })
      this.b.log(`[forms ${ch.id}] submitted ${r.name ?? r.person}'s answers to form ${d.form_id}: response ${res.id} (revision ${res.revision})`)
    } catch (e) {
      const msg = (e as Error).message
      if (/form_not_open/i.test(msg)) {
        store.closeFormDelivery(d.id)
        store.updateFormRespondent(r.id, { due_at: null, error: 'the form is no longer open' })
        this.b.log(`[forms ${ch.id}] form ${d.form_id} is no longer open; delivery ${d.id} stops collecting`)
        return
      }
      if (/form_answers_invalid|answers is invalid/i.test(msg)) {
        store.updateFormRespondent(r.id, { due_at: null, error: msg.slice(0, 300) })
        this.b.log(`[forms ${ch.id}] tm8 refused ${r.name ?? r.person}'s answers to form ${d.form_id}: ${msg}`)
        await this.b.sendBridge(ch, T[d.lang].refused(r.name, clip(d.title, 60)), null)
        return
      }
      const attempts = r.attempts + 1
      const giveUp = attempts >= MAX_SUBMIT_ATTEMPTS
      store.updateFormRespondent(r.id, { attempts, due_at: giveUp ? null : this.b.now() + 30_000 * attempts, error: giveUp ? msg.slice(0, 300) : null })
      this.b.log(`[forms ${ch.id}] submit for ${r.name ?? r.person} on form ${d.form_id} failed (attempt ${attempts}): ${msg}`)
    }
  }

  /** Periodic: submit what is due and notice forms that were closed or cancelled in tm8. */
  async tick() {
    await this.flushDue()
    for (const d of this.b.store.allActiveFormDeliveries()) {
      if (d.checked_at && this.b.now() - d.checked_at < STATUS_CHECK_MS) continue
      const ch = this.b.channelOf(d.channel_id)
      if (!ch) continue
      this.b.store.setFormDeliveryChecked(d.id)
      try {
        const f = await this.b.tm8For(ch).formGet(d.form_id)
        if (f.status !== 'open') {
          this.b.store.closeFormDelivery(d.id)
          this.b.log(`[forms ${ch.id}] form ${d.form_id} is ${f.status}; delivery ${d.id} stops collecting`)
        }
      } catch (e) {
        this.b.log(`[forms ${ch.id}] status check for form ${d.form_id}: ${(e as Error).message}`)
      }
    }
  }
}

function sortKeys<T extends Record<string, unknown>>(o: T): T {
  return Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]])) as T
}
