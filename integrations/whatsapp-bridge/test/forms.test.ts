// tm8 forms in groups: POST /form puts polls and numbered questions in the group; votes and replies come back as one
// tm8 form response per WhatsApp member.
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { describe, test } from 'node:test'
import { HttpError } from '../src/core.js'
import { proto } from '@whiskeysockets/baileys'
import { WA_RESPONDENT_KEY, parseNumbered, parseTextAnswer, planQuestions } from '../src/forms.js'
import { WaConnection } from '../src/wa.js'
import { GROUP, OWNER, inbound, setup } from './helpers.js'

const FORM = '01a2f000-0000-7000-8000-000000000001'
const RAHUL_PN = '919999999999@s.whatsapp.net'
const RAHUL_LID = '123456789012345@lid'
const STRANGER = '918888888888@s.whatsapp.net'
const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex')

function formSpec(over: Partial<{ status: string; responses: number; settings: Record<string, unknown> }> = {}) {
  const many = Array.from({ length: 13 }, (_, i) => ({ value: `r${i + 1}`, label: `Region ${i + 1}` }))
  return {
    id: FORM,
    version: 1,
    status: over.status ?? 'open',
    title: 'Offsite planning',
    description: 'Help us plan the offsite.',
    settings: { responses: 'per_member', allowAmend: true, ...over.settings },
    responses: over.responses ?? 0,
    questions: [
      { key: 'city', type: 'single_choice', title: 'Which city?', required: true, config: { options: [{ value: 'goa', label: 'Goa' }, { value: 'blr', label: 'Bangalore' }, { value: 'hyd', label: 'Hyderabad' }] } },
      { key: 'food', type: 'multi_choice', title: 'Food?', required: false, config: { options: [{ value: 'veg', label: 'Veg' }, { value: 'non', label: 'Non-veg' }, { value: 'vegan', label: 'Vegan' }], maxSelected: 2 } },
      { key: 'idea', type: 'short_text', title: 'One activity idea', required: true, config: {} },
      { key: 'excite', type: 'scale', title: 'How excited are you?', required: true, config: { min: 1, max: 5, minLabel: 'Meh', maxLabel: 'Very' } },
      { key: 'region', type: 'single_choice', title: 'Home region', required: false, config: { options: many } },
    ],
  }
}

async function delivered(over: Parameters<typeof formSpec>[0] = {}) {
  let t = 1_700_000_000_000
  const now = () => t
  const s = setup({ now })
  s.tm8.forms.set(FORM, formSpec(over))
  const token = s.bridge.issueToken('infra-main', 'infra')
  const auth = s.bridge.authenticate(`Bearer ${token}`)
  const res = await s.bridge.forms.deliver(auth, { form_id: FORM, idempotency_key: 'k1' })
  const waOf = (key: string) => (res.body.questions as { key: string; wa_msg_id: string }[]).find((q) => q.key === key)!.wa_msg_id
  const advance = (ms: number) => (t += ms)
  return { ...s, auth, res, waOf, advance, now }
}

const vote = (s: Awaited<ReturnType<typeof delivered>>, key: string, labels: string[], o: { jids?: string[]; name?: string } = {}) =>
  s.bridge.forms.onPollVote({ chatJid: GROUP, pollId: s.waOf(key), voterJids: o.jids ?? [RAHUL_LID, RAHUL_PN], voterName: o.name ?? 'Rahul', hashes: labels.map(sha) })

const say = (s: Awaited<ReturnType<typeof delivered>>, text: string, o: { quoted?: string; sender?: string; alt?: string | null; mentions?: string[] } = {}) =>
  s.bridge.onInbound(
    inbound({
      chatJid: GROUP, chatAltJid: null, fromMe: false, senderJid: o.sender ?? RAHUL_LID, senderAltJid: o.alt === undefined ? RAHUL_PN : o.alt,
      senderName: 'Rahul', text, quotedId: o.quoted ?? null, mentionedJids: o.mentions ?? [],
    }),
  )

describe('POST /form', () => {
  test('sets the form up for WhatsApp and posts an intro, polls and numbered questions', async () => {
    const s = await delivered()
    assert.equal(s.res.status, 200)
    assert.deepEqual(s.tm8.formCalls.filter((c) => !c.startsWith('get')), [`update ${FORM} {"responses":"unlimited"}`, `add ${FORM} ${WA_RESPONDENT_KEY}`])
    const sent = s.wa.sent
    assert.equal(sent.length, 6)
    assert.match(sent[0].text, /^tm8: 📋 \*Offsite planning\*\nHelp us plan the offsite\.\nTo answer, vote in the polls below and reply to each numbered question/)
    assert.deepEqual(sent[1].poll, { name: '1. Which city?', values: ['Goa', 'Bangalore', 'Hyderabad'], selectableCount: 1 })
    assert.deepEqual(sent[2].poll, { name: '2. Food? (optional)', values: ['Veg', 'Non-veg', 'Vegan'], selectableCount: 2 })
    assert.match(sent[3].text, /^tm8: \*Q3\.\* One activity idea\nReply to this message with your answer, or write "3: your answer"\.$/)
    assert.match(sent[4].text, /\*Q4\.\* How excited are you\?\nReply with a number from 1 \(Meh\) to 5 \(Very\)\./)
    // 13 options is more than a WhatsApp poll takes: a numbered list instead.
    assert.match(sent[5].text, /\*Q5\.\* Home region _\(optional\)_\n1\) Region 1\n[\s\S]*13\) Region 13\nReply with one number\.$/)
    assert.equal(s.res.body.questions instanceof Array && (s.res.body.questions as any[]).every((q) => q.wa_msg_id), true)
    // The bridge's own question is not asked in the group.
    assert.ok(!sent.some((m) => /WhatsApp respondent/.test(m.text)))
  })

  test('the same idempotency_key returns the delivery; the same form again is refused while collecting', async () => {
    const s = await delivered()
    const again = await s.bridge.forms.deliver(s.auth, { form_id: FORM, idempotency_key: 'k1' })
    assert.equal(again.body.duplicate, true)
    assert.equal(s.wa.sent.length, 6)
    await assert.rejects(s.bridge.forms.deliver(s.auth, { form_id: FORM, idempotency_key: 'k2' }), (e: HttpError) => e.status === 409)
  })

  test('a form that already has responses (structure frozen) is refused with a clear reason', async () => {
    const s = setup()
    s.tm8.forms.set(FORM, formSpec({ responses: 1 }))
    const auth = s.bridge.authenticate(`Bearer ${s.bridge.issueToken('infra-main', 'infra')}`)
    await assert.rejects(s.bridge.forms.deliver(auth, { form_id: FORM, idempotency_key: 'k' }), (e: HttpError) => e.status === 409 && /already has responses/.test(e.message))
    assert.equal(s.wa.sent.length, 0)
  })

  test('a form set up already is sent as is; closed forms and unknown question types are refused', async () => {
    const s = setup()
    const f = formSpec({ settings: { responses: 'unlimited' } })
    f.questions.push({ key: WA_RESPONDENT_KEY, type: 'short_text', title: 'WhatsApp respondent', required: false, config: {} } as any)
    s.tm8.forms.set(FORM, f)
    const auth = s.bridge.authenticate(`Bearer ${s.bridge.issueToken('infra-main', 'infra')}`)
    await s.bridge.forms.deliver(auth, { form_id: FORM, idempotency_key: 'k' })
    assert.deepEqual(s.tm8.formCalls.filter((c) => !c.startsWith('get')), [])

    const closed = setup()
    closed.tm8.forms.set(FORM, formSpec({ status: 'closed' }))
    const a2 = closed.bridge.authenticate(`Bearer ${closed.bridge.issueToken('infra-main', 'infra')}`)
    await assert.rejects(closed.bridge.forms.deliver(a2, { form_id: FORM, idempotency_key: 'k' }), (e: HttpError) => e.status === 409 && /closed/.test(e.message))

    const odd = setup()
    const f3 = formSpec()
    f3.questions.push({ key: 'when', type: 'date', title: 'When?', required: true, config: {} } as any)
    odd.tm8.forms.set(FORM, f3)
    const a3 = odd.bridge.authenticate(`Bearer ${odd.bridge.issueToken('infra-main', 'infra')}`)
    await assert.rejects(odd.bridge.forms.deliver(a3, { form_id: FORM, idempotency_key: 'k' }), (e: HttpError) => e.status === 400 && /when \(date\)/.test(e.message))
  })

  test('while WhatsApp is down the form is queued (202) and goes out on reconnect', async () => {
    const s = setup()
    s.tm8.forms.set(FORM, formSpec())
    s.wa.up = false
    const auth = s.bridge.authenticate(`Bearer ${s.bridge.issueToken('infra-main', 'infra')}`)
    const res = await s.bridge.forms.deliver(auth, { form_id: FORM, idempotency_key: 'k' })
    assert.equal(res.status, 202)
    s.wa.up = true
    await s.bridge.flushQueue()
    assert.equal(s.wa.sent.length, 6)
    assert.ok((s.bridge.forms.list(s.cfg.channels[1]).forms[0].questions as any[]).every((q) => q.wa_msg_id))
  })
})

describe('answers', () => {
  test('votes and replies from one member become one response, submitted once every required answer is in', async () => {
    const s = await delivered()
    await vote(s, 'city', ['Bangalore'])
    await say(s, 'Hackathon on the beach', { quoted: s.waOf('idea') })
    await s.bridge.forms.flushDue()
    assert.equal(s.tm8.submits.length, 0, 'Q4 (required) is still unanswered')
    // Typed numbered answers, two in one message; the same person seen by PN only.
    await say(s, '4: 5\n5: 3', { sender: RAHUL_PN, alt: null })
    await vote(s, 'food', ['Veg', 'Vegan'])
    // Collected, not routed to tm8 chats; each typed answer gets a 📝.
    assert.equal(s.tm8.posts.length, 0)
    assert.equal(s.wa.reactions.filter((r) => r.emoji === '📝').length, 2)
    await s.bridge.forms.flushDue()
    assert.equal(s.tm8.submits.length, 0, 'not before the quiet period')
    s.advance(21_000)
    await s.bridge.forms.flushDue()
    assert.equal(s.tm8.submits.length, 1)
    const sub = s.tm8.submits[0]
    assert.equal(sub.amendOf, null)
    assert.deepEqual(
      { ...sub.answers, [WA_RESPONDENT_KEY]: undefined },
      { city: { value: 'blr' }, excite: { number: 5 }, food: { values: ['veg', 'vegan'] }, idea: { text: 'Hackathon on the beach' }, region: { value: 'r3' }, [WA_RESPONDENT_KEY]: undefined },
    )
    assert.equal(sub.answers[WA_RESPONDENT_KEY].text, '"Rahul" +91…9999 in WhatsApp group "Infra"')
    const r = (s.bridge.forms.list(s.cfg.channels[1]).forms[0].respondents as any[])[0]
    assert.equal(r.state, 'submitted')
    assert.equal(r.response_id, 'resp-1')
  })

  test('a changed answer after submit amends the same chain; another member gets their own chain', async () => {
    const s = await delivered()
    await vote(s, 'city', ['Goa'])
    await say(s, '3: Kayaking\n4: 4')
    s.advance(21_000)
    await s.bridge.forms.flushDue()
    await vote(s, 'city', ['Hyderabad'])
    // Owner (allowed in this group) answers too.
    await vote(s, 'city', ['Goa'], { jids: [OWNER], name: 'Subhang' })
    await s.bridge.onInbound(
      inbound({ chatJid: GROUP, chatAltJid: null, fromMe: false, senderJid: OWNER, senderAltJid: null, senderName: 'Subhang', text: '3: Trek\n4: 2' }),
    )
    s.advance(21_000)
    await s.bridge.forms.flushDue()
    assert.equal(s.tm8.submits.length, 3)
    const amend = s.tm8.submits.find((x) => x.amendOf === 'resp-1')!
    assert.deepEqual(amend.answers.city, { value: 'hyd' })
    const other = s.tm8.submits.find((x) => /Subhang/.test(x.answers[WA_RESPONDENT_KEY].text))!
    assert.equal(other.amendOf, null)
    // A retried submit (same member, revision, answers) reuses its mutation id; different submits don't.
    assert.equal(new Set(s.tm8.submits.map((x) => x.mutationId)).size, 3)
  })

  test('a bad typed answer gets a hint and is not recorded; mentions of the bridge and plain chat still route', async () => {
    const s = await delivered()
    await say(s, '4: 9')
    assert.match(s.wa.sent.at(-1)!.text, /^tm8: Q4 takes a number from 1 to 5$/)
    assert.equal(s.wa.sent.at(-1)!.quoted !== undefined, true)
    const r = s.bridge.forms.list(s.cfg.channels[1]).forms[0].respondents as any[]
    assert.equal(r.length, 0)
    // "7: …" is not a numbered question of the form; a message that @mentions the bridge is for the agents.
    s.bridge.ownJids.add('910000000099@s.whatsapp.net')
    const before = s.wa.reactions.length
    await say(s, '7: what time is it')
    await say(s, '3: @tm8 what is this form?', { mentions: ['910000000099@s.whatsapp.net'] })
    assert.equal(s.wa.reactions.length, before)
    assert.equal(s.bridge.forms.list(s.cfg.channels[1]).forms[0].respondents.length, 0)
  })

  test('votes from people not allowed in the group are ignored; a cleared vote clears the answer', async () => {
    const s = await delivered()
    await vote(s, 'city', ['Goa'], { jids: [STRANGER], name: 'Stranger' })
    assert.equal(s.bridge.forms.list(s.cfg.channels[1]).forms[0].respondents.length, 0)
    await vote(s, 'city', ['Goa'])
    await vote(s, 'city', [])
    const r = (s.bridge.forms.list(s.cfg.channels[1]).forms[0].respondents as any[])[0]
    assert.deepEqual(r.answered, [])
  })

  test('a form closed in tm8 stops collecting: on submit (form_not_open) and on the status check', async () => {
    const s = await delivered()
    await vote(s, 'city', ['Goa'])
    await say(s, '3: x\n4: 1')
    s.tm8.forms.get(FORM)!.status = 'closed'
    s.advance(21_000)
    await s.bridge.forms.flushDue()
    assert.equal(s.tm8.submits.length, 0)
    assert.equal(s.bridge.forms.list(s.cfg.channels[1]).forms[0].status, 'closed')
    // Once closed, answers are no longer taken: "3: late" is an ordinary message.
    await say(s, '3: late')
    assert.deepEqual(JSON.parse(s.store.formRespondents(1)[0].answers_json).idea, { text: 'x' })

    const t = await delivered()
    t.tm8.forms.get(FORM)!.status = 'cancelled'
    await t.bridge.forms.tick()
    assert.equal(t.bridge.forms.list(t.cfg.channels[1]).forms[0].status, 'closed')
  })

  test('a transient submit failure is retried later; an invalid answer is reported once', async () => {
    const s = await delivered()
    s.tm8.submitErrors.push(new Error('tm8 form submit failed: upstream_unavailable'))
    await vote(s, 'city', ['Goa'])
    await say(s, '3: x\n4: 1')
    s.advance(21_000)
    await s.bridge.forms.flushDue()
    assert.equal(s.tm8.submits.length, 0)
    s.advance(31_000)
    await s.bridge.forms.flushDue()
    assert.equal(s.tm8.submits.length, 1)

    const t = await delivered()
    t.tm8.submitErrors.push(new Error('tm8: answers is invalid (1 issue; nothing was sent)'))
    await vote(t, 'city', ['Goa'])
    await say(t, '3: x\n4: 1')
    t.advance(21_000)
    await t.bridge.forms.flushDue()
    assert.match(t.wa.sent.at(-1)!.text, /couldn't record Rahul's answers to "Offsite planning"/)
    assert.equal((t.bridge.forms.list(t.cfg.channels[1]).forms[0].respondents as any[])[0].state, 'error')
  })
})

describe('parsing', () => {
  const qs = planQuestions(formSpec().questions)
  const q = (k: string) => qs.find((x) => x.key === k)!

  test('numbered segments', () => {
    assert.deepEqual(parseNumbered('2: yes'), [{ n: 2, text: 'yes' }])
    assert.deepEqual(parseNumbered('Q3. one\ntwo\n4) 5'), [{ n: 3, text: 'one\ntwo' }, { n: 4, text: '5' }])
    assert.equal(parseNumbered('hello\n2: x'), null)
    assert.equal(parseNumbered('2024 was great'), null)
  })

  test('typed answers per type', () => {
    assert.deepEqual(parseTextAnswer(q('excite'), ' 4 '), { answer: { number: 4 } })
    assert.ok('error' in parseTextAnswer(q('excite'), '0'))
    assert.ok('error' in parseTextAnswer(q('excite'), '45'))
    assert.deepEqual(parseTextAnswer(q('idea'), ' Beach volleyball '), { answer: { text: 'Beach volleyball' } })
    assert.ok('error' in parseTextAnswer(q('idea'), 'x'.repeat(501)))
    assert.deepEqual(parseTextAnswer(q('region'), '13'), { answer: { value: 'r13' } })
    assert.deepEqual(parseTextAnswer(q('region'), 'region 2'), { answer: { value: 'r2' } })
    assert.ok('error' in parseTextAnswer(q('region'), '1, 2'))
    assert.ok('error' in parseTextAnswer(q('region'), '14'))
  })

  test('poll option names are unique', () => {
    const [p] = planQuestions([{ key: 'k', type: 'single_choice', title: 'T', required: true, config: { options: [{ value: 'a', label: 'Same' }, { value: 'b', label: 'Same' }] } }])
    assert.deepEqual(p.options!.map((o) => o.name), ['Same', 'Same (b)'])
    assert.equal(p.mode, 'poll')
  })
})

describe('poll vote decryption (wa.ts)', () => {
  // A vote encrypted the way WhatsApp does it: key from the poll's messageSecret, signed with poll id, creator and voter.
  function encryptVote(o: { secret: Buffer; pollId: string; creator: string; voter: string; options: string[] }) {
    const sign = Buffer.concat([Buffer.from(o.pollId), Buffer.from(o.creator), Buffer.from(o.voter), Buffer.from('Poll Vote'), Buffer.from([1])])
    const key0 = crypto.createHmac('sha256', Buffer.alloc(32)).update(o.secret).digest()
    const key = crypto.createHmac('sha256', key0).update(sign).digest()
    const iv = crypto.randomBytes(12)
    const plain = proto.Message.PollVoteMessage.encode({ selectedOptions: o.options.map((n) => crypto.createHash('sha256').update(n).digest()) }).finish()
    const c = crypto.createCipheriv('aes-256-gcm', key, iv)
    c.setAAD(Buffer.from(`${o.pollId}\u0000${o.voter}`))
    return { encPayload: Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]), encIv: iv }
  }

  test('a vote is decrypted with the stored secret whichever PN/LID pairing the group used, and reaches the form', async () => {
    const s = await delivered()
    // The bridge's own number and LID (learned on connect); the poll's secret is in the outbox as sent.
    const BOT_PN = '910000000099@s.whatsapp.net'
    const BOT_LID = '100000000000099@lid'
    s.bridge.ownJids.add(BOT_PN)
    s.bridge.ownJids.add(BOT_LID)
    const secret = crypto.randomBytes(32)
    const pollId = s.waOf('city')
    s.store.db.prepare(`UPDATE outbox_v1 SET message_json = ? WHERE wa_msg_id = ?`).run(
      JSON.stringify({ pollCreationMessageV3: { name: '1. Which city?' }, messageContextInfo: { messageSecret: { type: 'Buffer', data: secret.toString('base64') } } }),
      pollId,
    )
    const conn = new WaConnection(s.bridge, { authDir: '/nonexistent', dataDir: '/tmp', allowLink: false })
    const voteMsg = (voter: string, alt: string | null) => ({
      key: { remoteJid: GROUP, id: crypto.randomUUID(), fromMe: false, participant: voter, ...(alt ? { participantAlt: alt } : {}) },
      pushName: 'Rahul',
      message: {},
    }) as any
    const update = (voter: string, options: string[], creator = BOT_LID) => ({
      pollCreationMessageKey: { remoteJid: GROUP, id: pollId, fromMe: true },
      vote: encryptVote({ secret, pollId, creator, voter, options }),
    })
    // Signed with LIDs, delivered with participant = LID and participantAlt = PN.
    await (conn as any).onPollUpdate(voteMsg(RAHUL_LID, RAHUL_PN), update(RAHUL_LID, ['Hyderabad']))
    let r = s.store.formRespondents(1)
    assert.deepEqual(JSON.parse(r[0].answers_json).city, { value: 'hyd' })
    // Signed with PNs; the same person (matched by PN) changes their vote.
    await (conn as any).onPollUpdate(voteMsg(RAHUL_LID, RAHUL_PN), update(RAHUL_PN, ['Goa'], BOT_PN))
    r = s.store.formRespondents(1)
    assert.equal(r.length, 1)
    assert.deepEqual(JSON.parse(r[0].answers_json).city, { value: 'goa' })
    // A vote under a key we don't hold is logged and dropped.
    const before = s.store.formRespondents(1)[0].answers_json
    await (conn as any).onPollUpdate(voteMsg(RAHUL_LID, RAHUL_PN), { ...update(RAHUL_LID, ['Bangalore']), vote: encryptVote({ secret: crypto.randomBytes(32), pollId, creator: BOT_LID, voter: RAHUL_LID, options: ['Bangalore'] }) })
    assert.equal(s.store.formRespondents(1)[0].answers_json, before)
    assert.ok(s.logs.some((l) => /couldn't decrypt a vote/.test(l)))
  })
})
