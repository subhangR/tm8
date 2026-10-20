import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { briefMainChat, envelope, rebriefTrust } from '../src/briefing.js'
import { parseConfig, trustedSenders } from '../src/config.js'
import { GROUP, OWNER, OWNER_LID, inbound, withMain } from './helpers.js'

const MEMBER = '919999999999@s.whatsapp.net'
const lastPost = (t: { tm8: { posts: { to: string; body: string }[] } }) => t.tm8.posts.at(-1)!
const load = (o: { trustedSenders?: unknown; chTrusted?: unknown }) =>
  parseConfig(
    {
      ownerJids: [OWNER, OWNER_LID],
      ...(o.trustedSenders !== undefined ? { trustedSenders: o.trustedSenders } : {}),
      channels: [{ id: 'g', jid: GROUP, title: 'G', ...(o.chTrusted !== undefined ? { trustedSenders: o.chTrusted } : {}) }],
    },
    '/r',
  )

describe('trusted senders: config', () => {
  test('default: nobody is trusted', () => {
    const cfg = load({})
    assert.deepEqual(cfg.trustedSenders, [])
    assert.equal(trustedSenders(cfg, cfg.channels[0]).size, 0)
  })
  test('global and per-channel lists merge; "owner" expands to ownerJids', () => {
    const cfg = load({ trustedSenders: ['owner'], chTrusted: [MEMBER, '100000000000009@lid'] })
    assert.deepEqual([...trustedSenders(cfg, cfg.channels[0])].sort(), [OWNER_LID, '100000000000009@lid', OWNER, MEMBER].sort())
  })
  test('rejects anything that is not "owner" or a sender JID', () => {
    for (const bad of [['everyone'], [GROUP], ['+919999999999'], ['919999999999'], [42], 'owner']) {
      assert.throws(() => load({ trustedSenders: bad }), /trustedSenders/, JSON.stringify(bad))
      assert.throws(() => load({ chTrusted: bad }), /channel g: trustedSenders/, JSON.stringify(bad))
    }
  })
})

describe('trusted senders: envelope', () => {
  const base = { ch: { id: 'g', jid: GROUP, title: 'G' }, senderName: 'A', senderJid: MEMBER, waMsgId: 'W1', to: 'g-main', notes: [], text: 'hi' }
  test('labels', () => {
    assert.match(envelope({ ...base, owner: false }), /\(UNTRUSTED group member\)/)
    assert.match(envelope({ ...base, owner: false, trusted: true }), /\(TRUSTED group member\)/)
    assert.match(envelope({ ...base, owner: true }), /\(owner's number, still UNTRUSTED\)/)
    assert.match(envelope({ ...base, owner: true, trusted: true }), /\(owner's number, TRUSTED\)/)
  })
})

describe('trusted senders: routing', () => {
  const fromMember = (text: string, senderJid = MEMBER) =>
    inbound({ text, chatJid: GROUP, chatAltJid: null, fromMe: false, senderJid, senderAltJid: null, senderName: 'Rahul' })

  test('a listed member is TRUSTED, everyone else stays UNTRUSTED', async () => {
    const t = await withMain()
    await t.bridge.ensureMainChat(t.cfg.channels[1])
    await t.bridge.onInbound(fromMember('@tm8 help'))
    assert.match(lastPost(t).body, /\(UNTRUSTED group member\)/)
    t.cfg.channels[1].trustedSenders = [MEMBER]
    await t.bridge.onInbound(fromMember('@tm8 help again'))
    assert.match(lastPost(t).body, /^\[whatsapp "Infra" · from "Rahul" \+91…9999 \(TRUSTED group member\) · to: infra-main · wa_msg_id /)
  })
  test('a sender trusted in one channel is not trusted in another', async () => {
    const t = await withMain()
    t.cfg.channels[1].trustedSenders = [OWNER]
    await t.bridge.onInbound(inbound({ text: '@tm8 hi' }))
    assert.match(lastPost(t).body, /\(owner's number, still UNTRUSTED\)/)
  })
  test('global "owner" trusts the owner, including fromMe messages', async () => {
    const t = await withMain()
    t.cfg.trustedSenders = ['owner']
    await t.bridge.onInbound(inbound({ text: '@tm8 hi' }))
    assert.match(lastPost(t).body, /\(owner's number, TRUSTED\)/)
  })
  test('trust does not make a sender allowed to trigger agents', async () => {
    const t = await withMain()
    await t.bridge.ensureMainChat(t.cfg.channels[1])
    const other = '918888888888@s.whatsapp.net'
    t.cfg.channels[1].trustedSenders = [other]
    const before = t.tm8.posts.length
    await t.bridge.onInbound(fromMember('@tm8 help', other))
    assert.equal(t.tm8.posts.length, before)
  })
})

describe('trusted senders: briefings', () => {
  test('briefings explain the label and keep the hard rule', async () => {
    const t = await withMain()
    const brief = briefMainChat({ cfg: t.cfg, ch: t.cfg.channels[0], name: 'self-main', tokenFile: '/x' })
    assert.ok(brief.includes('"TRUSTED" label'))
    assert.ok(brief.length < 9000, `main chat briefing is ${brief.length} chars`)
    const up = rebriefTrust({ cfg: t.cfg, ch: t.cfg.channels[0], name: 'self-main' })
    assert.ok(up.includes('TRUSTED or not'))
  })
})
