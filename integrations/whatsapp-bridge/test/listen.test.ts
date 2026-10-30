import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { briefMainChat, rebriefListen } from '../src/briefing.js'
import { parseConfig } from '../src/config.js'
import { BRIDGE_MARK, hasBridgeMark, parseMentions, withBridgeMark } from '../src/text.js'
import { GROUP, OWNER, OWNER_LID, inbound, withMain } from './helpers.js'

const MEMBER = '919999999999@s.whatsapp.net'
const STRANGER = '918888888888@s.whatsapp.net'
const fromGroup = (text: string, sender = MEMBER) =>
  inbound({ text, chatJid: GROUP, chatAltJid: null, fromMe: false, senderJid: sender, senderAltJid: null, senderName: 'Rahul' })
const load = (channels: unknown[], extra: Record<string, unknown> = {}) =>
  parseConfig({ ownerJids: [OWNER, OWNER_LID], ...extra, channels }, '/r')
const SELF = { id: 'self', jid: OWNER, title: 'Me' }

/** The self chat plus the group, with the group's main chat up and a speaker token for it. */
async function group(o: { trigger?: 'all'; deliverTo?: string; allowedSenders?: string[] }) {
  const t = await withMain()
  Object.assign(t.cfg.channels[1], o)
  await t.bridge.ensureMainChat(t.cfg.channels[1])
  const token = t.bridge.issueToken('infra-main', 'infra')
  const say = (body: Record<string, unknown>) => t.bridge.say(t.bridge.authenticate(`Bearer ${token}`), { idempotency_key: crypto.randomUUID(), ...body })
  return { ...t, say }
}

describe('config: trigger, deliverTo, handle', () => {
  test('defaults: mention trigger, no redirect, handle tm8', () => {
    const cfg = load([SELF, { id: 'g', jid: GROUP, title: 'G' }])
    assert.equal(cfg.handle, 'tm8')
    assert.equal(cfg.channels[1].trigger, undefined)
    assert.equal(cfg.channels[1].deliverTo, undefined)
  })
  test('rejects a bad trigger, a deliverTo to nowhere, to itself, or through another redirect', () => {
    assert.throws(() => load([{ id: 'g', jid: GROUP, title: 'G', trigger: 'everything' }]), /trigger must be/)
    assert.throws(() => load([{ id: 'g', jid: GROUP, title: 'G', deliverTo: 'nope' }]), /not a configured channel/)
    assert.throws(() => load([{ id: 'g', jid: GROUP, title: 'G', deliverTo: 'g' }]), /the channel itself/)
    assert.throws(
      () => load([SELF, { id: 'g', jid: GROUP, title: 'G', deliverTo: 'h' }, { id: 'h', jid: '120363000000000002@g.us', title: 'H', deliverTo: 'self' }]),
      /itself redirected/,
    )
    assert.throws(() => load([SELF], { handle: 'two words' }), /handle must match/)
    assert.throws(() => load([SELF], { handle: 'tm8.' }), /handle must match/)
    assert.equal(load([SELF], { handle: 'tm8.uhn' }).handle, 'tm8.uhn')
  })
})

describe('handle: bridges sharing a chat each answer only their own mention', () => {
  test('parseMentions takes the handle', () => {
    assert.deepEqual(parseMentions('@strykr look', 'strykr'), [{ kind: 'tm8' }])
    assert.deepEqual(parseMentions('@strykr-backend look', 'strykr'), [{ kind: 'tm8', teammate: 'backend' }])
    assert.deepEqual(parseMentions('@tm8 look', 'strykr'), [{ kind: 'handle', handle: 'tm8' }])
    assert.deepEqual(parseMentions('@tm8 look'), [{ kind: 'tm8' }])
  })
  test('a dotted handle is one word: @tm8.uhn is not @tm8', () => {
    assert.deepEqual(parseMentions('@tm8.uhn look', 'tm8.uhn'), [{ kind: 'tm8' }])
    assert.deepEqual(parseMentions('@tm8.uhn-backend look', 'tm8.uhn'), [{ kind: 'tm8', teammate: 'backend' }])
    assert.deepEqual(parseMentions('ping @tm8.uhn.', 'tm8.uhn'), [{ kind: 'tm8' }])
    assert.deepEqual(parseMentions('@tm8.uhn look'), [{ kind: 'handle', handle: 'tm8.uhn' }])
    assert.deepEqual(parseMentions('thanks @tm8.'), [{ kind: 'tm8' }])
  })
  test('with handle "strykr", @strykr routes in the self chat', async () => {
    const t = await withMain()
    t.cfg.handle = 'strykr'
    const before = t.tm8.posts.length
    await t.bridge.onInbound(inbound({ text: '@strykr hello' }))
    assert.equal(t.tm8.posts.length, before + 1)
  })
})

describe('trigger "all": every message reaches the main chat', () => {
  test('an unaddressed message from any allowed sender is routed, without the 👀 reaction', async () => {
    const t = await group({ trigger: 'all', allowedSenders: ['everyone'] })
    const before = t.tm8.posts.length
    await t.bridge.onInbound(fromGroup('withdrawal stuck since yesterday', STRANGER))
    assert.equal(t.tm8.posts.length, before + 1)
    assert.equal(t.tm8.posts.at(-1)!.to, 'chat-2')
    assert.match(t.tm8.posts.at(-1)!.body, /withdrawal stuck since yesterday/)
    assert.deepEqual(t.wa.reactions, [])
  })
  test('allowedSenders still applies', async () => {
    const t = await group({ trigger: 'all' })
    const before = t.tm8.posts.length
    await t.bridge.onInbound(fromGroup('not allowed', STRANGER))
    assert.equal(t.tm8.posts.length, before)
  })
  test('the briefing tells the main chat to triage and to end with "skip <id>" when nothing needs an answer', () => {
    const cfg = load([SELF, { id: 'g', jid: GROUP, title: 'Feedback', trigger: 'all' }])
    const b = briefMainChat({ cfg, ch: cfg.channels[1], name: 'g-main', tokenFile: '/t' })
    assert.match(b, /Every message in this group comes to you/)
    assert.match(b, /skip <wa_msg_id>/)
    assert.doesNotMatch(b, /Test mode/)
    assert.ok(b.length < 10000, `briefing is ${b.length} chars; chat.start takes at most 10000`)
  })
})

describe('deliverTo: shadow mode', () => {
  test('a reply for the group goes to the self chat, tagged and unquoted; the group gets nothing', async () => {
    const t = await group({ trigger: 'all', deliverTo: 'self' })
    const m = fromGroup('app crashed on deposit')
    await t.bridge.onInbound(m)
    const r = await t.say({ text: 'Looking into it.', reply_to: m.id })
    assert.equal(r.status, 200)
    const sent = t.wa.sent.at(-1)!
    assert.equal(sent.jid, OWNER)
    assert.equal(sent.text, '[Infra] tm8: Looking into it.')
    assert.equal(sent.quoted, undefined)
    assert.ok(t.wa.sent.every((s) => s.jid !== GROUP))
    // The group's history still records it, under the group.
    assert.ok(t.store.history('infra', 10).some((h) => h.text === '[Infra] tm8: Looking into it.'))
  })
  test('no reactions reach the group, not even an agent /react', async () => {
    const t = await group({ deliverTo: 'self' })
    const m = fromGroup('@tm8 hi')
    await t.bridge.onInbound(m)
    await t.bridge.react({ nameStr: 'infra-main', ch: t.cfg.channels[1] }, { wa_msg_id: m.id, emoji: '👍' })
    assert.deepEqual(t.wa.reactions, [])
  })
  test('replying in the self chat to a shadowed message goes back to the group\'s main chat', async () => {
    const t = await group({ trigger: 'all', deliverTo: 'self' })
    const m = fromGroup('bet not settled')
    await t.bridge.onInbound(m)
    await t.say({ text: 'Provider confirmation pending.', reply_to: m.id })
    const shadowed = t.wa.sent.at(-1)!
    await t.bridge.onInbound(inbound({ text: 'make it shorter', quotedId: shadowed.id }))
    assert.equal(t.tm8.posts.at(-1)!.to, 'chat-2')
  })
  test('the briefing says replies go to the self chat', () => {
    const cfg = load([SELF, { id: 'g', jid: GROUP, title: 'Feedback', trigger: 'all', deliverTo: 'self' }])
    assert.match(briefMainChat({ cfg, ch: cfg.channels[1], name: 'g-main', tokenFile: '/t' }), /Test mode: the group doesn't see your replies[\s\S]*"Me"/)
    assert.match(rebriefListen({ cfg, ch: cfg.channels[1], name: 'g-main' }), /Test mode/)
  })
})

describe('bridge mark: another bridge on the same number', () => {
  test('withBridgeMark is idempotent and invisible text only', () => {
    assert.equal(withBridgeMark(withBridgeMark('hi')), 'hi' + BRIDGE_MARK)
    assert.ok(hasBridgeMark('tm8: done' + BRIDGE_MARK))
    assert.ok(!hasBridgeMark('tm8: typed by a person'))
    assert.match(BRIDGE_MARK, /^[⁣⁤]+$/)
  })
  test('a fromMe message carrying the mark is logged as a bridge message and never routed', async () => {
    const t = await withMain()
    const before = t.tm8.posts.length
    await t.bridge.onInbound(inbound({ text: '@tm8 reply from the other server' + BRIDGE_MARK }))
    assert.equal(t.tm8.posts.length, before)
    assert.ok(t.logs.some((l) => /our own message, ignored \(loop guard\)/.test(l)))
  })
  test('the owner typing the same words without the mark is still routed', async () => {
    const t = await withMain()
    const before = t.tm8.posts.length
    await t.bridge.onInbound(inbound({ text: '@tm8 reply from the other server' }))
    assert.equal(t.tm8.posts.length, before + 1)
  })
})

describe('admin inject with sender_jid', () => {
  test('replays a member\'s message: not fromMe, the member\'s JID in the envelope', async () => {
    const t = await group({ trigger: 'all', allowedSenders: ['everyone'] })
    await t.bridge.injectTest({ channel: 'infra', text: 'bet not settled', sender_jid: MEMBER, sender_name: 'Rahul' })
    assert.match(t.tm8.posts.at(-1)!.body, /from "Rahul" \+91…9999 \(UNTRUSTED group member\)/)
  })
})

describe('purpose', () => {
  test('goes into the main chat briefing; bounded', () => {
    const cfg = load([SELF, { id: 'g', jid: GROUP, title: 'Feedback', trigger: 'all', purpose: 'User reports forwarded by the CEO.' }])
    assert.match(briefMainChat({ cfg, ch: cfg.channels[1], name: 'g-main', tokenFile: '/t' }), /## What this group is for\nUser reports forwarded by the CEO\./)
    assert.throws(() => load([{ id: 'g', jid: GROUP, title: 'G', purpose: 'x'.repeat(801) }]), /purpose must be/)
  })
})
