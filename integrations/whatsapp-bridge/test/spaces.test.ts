// Per-channel tm8 spaces: config fallback, one client per (space, token), isolation of a missing token, names/poller.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, test } from 'node:test'
import { channelTm8, parseConfig } from '../src/config.js'
import { Bridge } from '../src/core.js'
import { Store } from '../src/store.js'
import { Tm8Cli } from '../src/tm8.js'
import { FakeTm8, FakeWa, OWNER, OWNER_LID, inbound } from './helpers.js'

const HOME_SPACE = '01a0fb3d-558e-7d92-b370-d0601112607a'
const LVLUP = '019fea87-7f2e-73c6-989f-8fdf9410cbbb'
const LVLUP_TEAMMATE = '019fea87-7f4e-7836-a3c1-e77ebbb3ef5f'
const LVL_GROUP = '120363000000000002@g.us'
const MEMBER = '919888877777@s.whatsapp.net'

function spaces(lvlupTm8: Record<string, string>, extra: { mainChatId?: string } = {}) {
  const cfg = parseConfig(
    {
      ownerJids: [OWNER, OWNER_LID],
      channels: [
        { id: 'self', jid: OWNER, altJids: [OWNER_LID], title: 'Message yourself' },
        { id: 'lvlup', jid: LVL_GROUP, title: 'lvlup + autograde', allowedSenders: ['everyone'], tm8: lvlupTm8, ...extra },
      ],
    },
    '/srv/bridge',
  )
  const fakes = new Map<string, FakeTm8>()
  const made: { spaceId: string; tokenFile: string; homeSpaceId: string }[] = []
  const fake = (spaceId: string, tokenFile: string) => {
    const key = `${spaceId}|${tokenFile}`
    if (!fakes.has(key)) fakes.set(key, new FakeTm8())
    return fakes.get(key)!
  }
  // Fakes exist before the bridge asks for them, so a test can set them up first.
  const home = fake(HOME_SPACE, '/srv/bridge/secrets/tm8-token')
  const lvl = fake(lvlupTm8.spaceId ?? HOME_SPACE, lvlupTm8.tokenFile ? path.resolve('/srv/bridge', lvlupTm8.tokenFile) : '/srv/bridge/secrets/tm8-token')
  lvl.team = [{ id: LVLUP_TEAMMATE, title: 'Opus 5 1M Teammate' }, { id: 'lv-backend', title: 'Backend Owner · Dasara Auto Grade' }]
  const store = new Store(':memory:')
  const wa = new FakeWa()
  const logs: string[] = []
  const mediaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wab-spaces-'))
  const bridge = new Bridge(cfg, store, wa, (o) => {
    made.push(o)
    return fake(o.spaceId, o.tokenFile)
  }, { log: (m) => logs.push(m), retryDelaysMs: [0, 0, 0], mediaDir })
  return { cfg, store, wa, bridge, home, lvl, made, logs, self: cfg.channels[0], lvlup: cfg.channels[1] }
}

const groupMsg = (text: string, p: Partial<Parameters<typeof inbound>[0]> = {}) =>
  inbound({ text, chatJid: LVL_GROUP, chatAltJid: null, fromMe: false, senderJid: MEMBER, senderAltJid: null, senderName: 'Asha', ...p })

describe('per-channel tm8 config', () => {
  test('missing fields fall back to the global tm8 block; tokenFile resolves against the root', () => {
    const cfg = parseConfig(
      {
        ownerJids: [OWNER],
        tm8: { defaultTeammate: 'global-tm', defaultModel: 'global-model' },
        channels: [
          { id: 'self', jid: OWNER, title: 'Self' },
          { id: 'a', jid: '1@g.us', title: 'A', tm8: { spaceId: LVLUP } },
          { id: 'b', jid: '2@g.us', title: 'B', tm8: { spaceId: LVLUP, tokenFile: 'secrets/tm8-token-lvlup', defaultTeammate: 't', defaultModel: 'm' } },
        ],
      },
      '/srv/bridge',
    )
    assert.deepEqual(channelTm8(cfg, cfg.channels[0]), { spaceId: HOME_SPACE, tokenFile: '/srv/bridge/secrets/tm8-token', defaultTeammate: 'global-tm', defaultModel: 'global-model' })
    assert.deepEqual(channelTm8(cfg, cfg.channels[1]), { spaceId: LVLUP, tokenFile: '/srv/bridge/secrets/tm8-token', defaultTeammate: 'global-tm', defaultModel: 'global-model' })
    assert.deepEqual(channelTm8(cfg, cfg.channels[2]), { spaceId: LVLUP, tokenFile: '/srv/bridge/secrets/tm8-token-lvlup', defaultTeammate: 't', defaultModel: 'm' })
  })
  test('invalid per-channel tm8 blocks are refused at load', () => {
    const load = (tm8: unknown) => parseConfig({ ownerJids: [OWNER], channels: [{ id: 'g', jid: '1@g.us', title: 'G', tm8 }] }, '/r')
    assert.throws(() => load({ spaceId: 'lvlup' }), /tm8.spaceId must be a tm8 space id/)
    assert.throws(() => load({ spaceId: LVLUP, baseUrl: 'http://x' }), /tm8.baseUrl can't be set per channel/)
    assert.throws(() => load({ tokenFile: '' }), /tm8.tokenFile must be a non-empty string/)
    assert.throws(() => load('lvlup'), /tm8 must be an object/)
    assert.doesNotThrow(() => load({ spaceId: LVLUP }))
  })
})

describe('per-space clients and routing', () => {
  test('one client per (space, token); each channel routes, briefs and validates teammates in its own space', async () => {
    const t = spaces({ spaceId: LVLUP, defaultTeammate: LVLUP_TEAMMATE }, { mainChatId: 'lv-chat' })
    assert.deepEqual(t.made, [
      { spaceId: HOME_SPACE, tokenFile: '/srv/bridge/secrets/tm8-token', homeSpaceId: HOME_SPACE },
      { spaceId: LVLUP, tokenFile: '/srv/bridge/secrets/tm8-token', homeSpaceId: HOME_SPACE },
    ])
    assert.equal(t.bridge.clientFor(t.lvlup).viaLink, true)
    assert.equal(t.bridge.clientFor(t.self).viaLink, false)
    await t.bridge.poll()
    assert.equal(t.bridge.lastPoll.ok, true, String(t.bridge.lastPoll.error))
    // self creates its chat in the home space; lvlup adopts the configured chat (no chat start through the link).
    assert.equal(t.home.chats.length, 1)
    assert.equal(t.lvl.chats.length, 0)
    const brief = t.lvl.posts.find((p) => p.to === 'lv-chat')!
    assert.match(brief.body, /You are \*\*lvlup-main\*\*/)
    assert.match(brief.body, new RegExp(`tm8 space is ${LVLUP}`))
    assert.equal(t.store.getName('lvlup-main')!.space_id, LVLUP)
    assert.equal(t.store.getName('lvlup-main')!.teammate, 'Opus 5 1M Teammate')
    assert.equal(t.store.getName('self-main')!.space_id, HOME_SPACE)

    // Any member may trigger agents in lvlup; the post goes to the lvlup client only.
    const before = t.home.posts.length
    await t.bridge.onInbound(groupMsg('@tm8-backend can you look at grading?'))
    const post = t.lvl.posts.at(-1)!
    assert.equal(post.to, 'lv-chat')
    assert.match(post.body, /teammate "backend" → Backend Owner · Dasara Auto Grade \(lv-backend\)/)
    assert.equal(t.home.posts.length, before)
    // /stop stays owner-only.
    await t.bridge.onInbound(groupMsg('/stop lvlup-main'))
    assert.match(t.wa.sent.at(-1)!.text, /\/stop is owner-only/)
  })

  test('names and the poller across two spaces: globally unique names, each session briefed in its own space', async () => {
    const t = spaces({ spaceId: LVLUP }, { mainChatId: 'lv-chat' })
    await t.bridge.poll()
    const homeMain = t.store.getName('self-main')!.entity_id
    t.home.contexts.set(homeMain, { id: homeMain, kind: 'chat', launchedSessions: [{ id: 'h-s1', kind: 'work_session', status: 'running' }] })
    t.home.contexts.set('h-s1', { id: 'h-s1', kind: 'work_session', status: 'running', title: 'Home work', launchedSessions: [] })
    t.lvl.contexts.set('lv-chat', { id: 'lv-chat', kind: 'chat', launchedSessions: [{ id: 'l-s1', kind: 'work_session', status: 'running' }, { id: 'l-s2', kind: 'work_session', status: 'running' }] })
    t.lvl.contexts.set('l-s1', { id: 'l-s1', kind: 'work_session', status: 'running', tasks: [{ id: 'k', title: 'Grade the autograde batch' }], launchedSessions: [] })
    t.lvl.contexts.set('l-s2', { id: 'l-s2', kind: 'work_session', status: 'running', title: 'Other', launchedSessions: [] })
    await t.bridge.poll()
    const h = t.store.nameByEntity('h-s1')!
    const l1 = t.store.nameByEntity('l-s1')!
    const l2 = t.store.nameByEntity('l-s2')!
    assert.equal(new Set([h.name, l1.name, l2.name]).size, 3)
    assert.deepEqual([h.space_id, h.channel_id], [HOME_SPACE, 'self'])
    assert.deepEqual([l1.space_id, l1.channel_id, l1.parent_name], [LVLUP, 'lvlup', 'lvlup-main'])
    assert.ok(t.lvl.posts.some((p) => p.to === 'l-s1' && p.body.includes('[whatsapp bridge briefing]') && p.body.includes(LVLUP)))
    assert.ok(t.home.posts.some((p) => p.to === 'h-s1'))
    assert.ok(!t.home.posts.some((p) => p.to.startsWith('l-')))
    assert.ok(!t.lvl.posts.some((p) => p.to === 'h-s1'))
    // A lvlup handle doesn't resolve in the self chat (names stay in their group).
    await t.bridge.onInbound(inbound({ text: `@${l1.name} hi` }))
    assert.match(t.home.posts.at(-1)!.body, new RegExp(`unknown name @${l1.name}`))
    // Ending in lvlup is read from lvlup.
    t.lvl.contexts.set('lv-chat', { id: 'lv-chat', kind: 'chat', launchedSessions: [{ id: 'l-s1', kind: 'work_session', status: 'completed' }] })
    await t.bridge.poll()
    assert.equal(t.store.getName(l1.name)!.status, 'ended')
    assert.equal(t.store.getName(h.name)!.status, 'live')
  })

  test('through the link without mainChatId: no chat start, the error is on that channel only', async () => {
    const t = spaces({ spaceId: LVLUP })
    await t.bridge.poll()
    assert.equal(t.lvl.chats.length, 0)
    assert.equal(t.home.chats.length, 1)
    const h = t.bridge.health()
    const lv = h.channels.find((c) => c.id === 'lvlup')!
    const self = h.channels.find((c) => c.id === 'self')!
    assert.equal(lv.tm8.via_link, true)
    assert.equal(lv.tm8.last_poll_ok, false)
    assert.match(String(lv.tm8.last_poll_error), /chat start is not allowed through a space link.*mainChatId/)
    assert.equal(self.tm8.last_poll_ok, true)
    assert.ok(self.main_chat_id)
  })

  test('with its own tokenFile the channel creates its main chat in its space with its teammate and model', async () => {
    const t = spaces({ spaceId: LVLUP, tokenFile: 'secrets/tm8-token-lvlup', defaultTeammate: LVLUP_TEAMMATE, defaultModel: 'claude-opus-5' })
    assert.equal(t.bridge.clientFor(t.lvlup).viaLink, false)
    assert.deepEqual(t.made[1], { spaceId: LVLUP, tokenFile: '/srv/bridge/secrets/tm8-token-lvlup', homeSpaceId: LVLUP })
    await t.bridge.poll()
    assert.equal(t.lvl.chats.length, 1)
    assert.equal(t.lvl.chats[0].teammate, LVLUP_TEAMMATE)
    assert.equal((t.lvl.chats[0] as any).model, 'claude-opus-5')
    assert.equal(t.lvl.chats[0].title, 'lvlup + autograde (WhatsApp)')
    assert.equal(t.home.chats.length, 1)
    assert.equal(t.home.chats[0].teammate, '01a0fb41-3317-77f3-b2b5-2bba3e489f4d')
  })

  test('a missing token file for one channel: log-only with the notice there, the other channel keeps working', async () => {
    const t = spaces({ spaceId: LVLUP, tokenFile: 'secrets/tm8-token-lvlup' })
    t.lvl.token = false
    await t.bridge.poll()
    assert.equal(t.bridge.lastPoll.ok, false)
    assert.match(String(t.bridge.lastPoll.error), /lvlup: tm8 token not configured/)
    assert.ok(t.logs.some((l) => l.includes('[poll] waiting for the tm8 token file /srv/bridge/secrets/tm8-token-lvlup')))
    // self: main chat created, routing works.
    await t.bridge.onInbound(inbound({ text: '@tm8 hello' }))
    assert.match(t.home.posts.at(-1)!.body, /hello/)
    // lvlup: logged, "link not configured" notice, nothing posted anywhere.
    const m = groupMsg('@tm8 are you there?')
    const homePosts = t.home.posts.length
    await t.bridge.onInbound(m)
    assert.ok(t.store.getMessage(m.id))
    assert.deepEqual(t.wa.sent.filter((s) => s.jid === LVL_GROUP).map((s) => s.text), ['tm8: link not configured yet'])
    assert.equal(t.lvl.posts.length, 0)
    assert.equal(t.home.posts.length, homePosts)
    const h = t.bridge.health()
    assert.equal(h.tm8.configured, true)
    const lv = h.channels.find((c) => c.id === 'lvlup')!.tm8
    assert.deepEqual([lv.configured, lv.token_file, lv.last_poll_ok], [false, 'tm8-token-lvlup', false])
    assert.equal(h.channels.find((c) => c.id === 'self')!.tm8.last_poll_ok, true)
    // The token appears: the next poll picks it up.
    t.lvl.token = true
    await t.bridge.poll()
    assert.equal(t.lvl.chats.length, 1)
    assert.equal(t.bridge.lastPoll.ok, true)
    assert.ok(t.logs.some((l) => l.includes('tm8 token found in /srv/bridge/secrets/tm8-token-lvlup')))
  })

  test('media in a link-only channel is routed once, "not attached", without an upload attempt', async () => {
    const t = spaces({ spaceId: LVLUP }, { mainChatId: 'lv-chat' })
    await t.bridge.poll()
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')
    await t.bridge.onInbound(groupMsg('[image] @tm8 look', { kind: 'media', media: { kind: 'image', mime: 'image/png', fileName: null, caption: '@tm8 look', size: png.length, ref: null, data: png } }))
    assert.equal(t.lvl.uploads.length, 0)
    assert.equal(t.home.uploads.length, 0)
    const routed = t.lvl.posts.filter((p) => p.to === 'lv-chat' && p.body.includes('@tm8 look'))
    assert.equal(routed.length, 1)
    assert.match(routed[0].body, /not attached \(upload to tm8 failed: file upload is not allowed through a space link/)
  })

  test('token expiry per token file: health per channel, one notice per token naming its channels', async () => {
    let now = Date.parse('2026-11-01T00:00:00Z')
    const t = spaces({ spaceId: LVLUP, tokenFile: 'secrets/tm8-token-lvlup' })
    ;(t.bridge as any).o.now = () => now
    t.home.expiresAt = '2027-01-01T00:00:00Z'
    t.lvl.expiresAt = '2026-11-03T00:00:00Z'
    t.lvl.fingerprint = 'lvfp'
    await t.bridge.checkTokenExpiry()
    const h = t.bridge.health()
    assert.equal(h.tm8.token_expires_at, '2027-01-01T00:00:00.000Z')
    assert.equal(h.channels.find((c) => c.id === 'lvlup')!.tm8.token_expires_at, '2026-11-03T00:00:00.000Z')
    assert.equal(t.wa.sent.length, 1)
    assert.equal(t.wa.sent[0].jid, OWNER)
    assert.match(t.wa.sent[0].text, /^tm8: heads-up: the tm8 token for lvlup expires 2026-11-03 00:00 UTC .*secrets\/tm8-token-lvlup/)
    assert.ok(t.logs.some((l) => /\[expiry\] WARNING: .*secrets\/tm8-token-lvlup \(channels lvlup\)/.test(l)))
  })
})

describe('Tm8Cli', () => {
  test('passes --space <target> on every call except auth session, with the token\'s own space as TM8_SPACE_ID', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wab-cli-'))
    // A stand-in CLI that records its argv and env.
    const cli = path.join(dir, 'tm8.mjs')
    fs.writeFileSync(cli, `import fs from 'node:fs'
fs.appendFileSync(${JSON.stringify(path.join(dir, 'calls'))}, JSON.stringify({ argv: process.argv.slice(2), space: process.env.TM8_SPACE_ID, token: process.env.TM8_AGENT_TOKEN }) + '\\n')
console.log(JSON.stringify({ page: { items: [] }, session: { expiresAt: null } }))`)
    fs.writeFileSync(path.join(dir, 'tok'), 'token: tm8s_abc123\n')
    const c = new Tm8Cli({ cliPath: cli, baseUrl: 'http://x', spaceId: LVLUP, homeSpaceId: HOME_SPACE, tokenFile: path.join(dir, 'tok'), home: dir })
    await c.teammates()
    await c.authSession()
    const calls = fs.readFileSync(path.join(dir, 'calls'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    assert.deepEqual(calls[0], { argv: ['--space', LVLUP, 'teammate', 'list', '--limit', '200', '--format', 'json'], space: HOME_SPACE, token: 'tm8s_abc123' })
    assert.deepEqual(calls[1].argv, ['auth', 'session', '--format', 'json'])
  })
})

describe('a bridge on another number (no self chat)', () => {
  test("the owner is a group member, not one of the bridge's own JIDs; mentioning the owner doesn't route", async () => {
    const cfg = parseConfig(
      { ownerJids: [OWNER, OWNER_LID], channels: [{ id: 'lvlup', jid: LVL_GROUP, title: 'lvlup + autograde', allowedSenders: ['owner'] }] },
      '/srv/bridge',
    )
    const tm8 = new FakeTm8()
    const bridge = new Bridge(cfg, new Store(':memory:'), new FakeWa(), () => tm8, { log: () => {}, mediaDir: fs.mkdtempSync(path.join(os.tmpdir(), 'wab-num2-')) })
    assert.deepEqual([...bridge.ownJids], [])
    bridge.ownJids.add('910000000002@s.whatsapp.net')
    await bridge.poll()
    const before = tm8.posts.length
    await bridge.onInbound(inbound({ text: 'hey', chatJid: LVL_GROUP, chatAltJid: null, fromMe: false, senderJid: OWNER, senderAltJid: OWNER_LID, senderName: 'Subhang', mentionedJids: [OWNER] }))
    assert.equal(tm8.posts.length, before)
    await bridge.onInbound(inbound({ text: 'hi', chatJid: LVL_GROUP, chatAltJid: null, fromMe: false, senderJid: OWNER, senderAltJid: OWNER_LID, senderName: 'Subhang', mentionedJids: ['910000000002@s.whatsapp.net'] }))
    assert.equal(tm8.posts.length, before + 1)
  })
})
