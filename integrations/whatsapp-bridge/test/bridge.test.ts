import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { HttpError, PENDING_ECHO_MS } from '../src/core.js'
import { apiReference, briefMainChat, briefSession, rebriefDelegateRule, rebriefMainChat, rebriefReplyRule, rebriefStyle } from '../src/briefing.js'
import { cleanLabel, envelopeWaId, escapeMentions, finalTurnText, looksSecret, generateName, matchTeammate, parseCommand, parseMentions, RateLimiter, extractTm8Token, shortTitle, speakerLine } from '../src/text.js'
import { parseCliJson } from '../src/tm8.js'
import { DEFAULT_STYLE, parseConfig } from '../src/config.js'
import { GROUP, OWNER, agentTurn, briefToken, inbound, nextId, setup, withMain } from './helpers.js'

const lastPost = (t: { tm8: { posts: { to: string; body: string }[] } }) => t.tm8.posts.at(-1)!

async function addSession(t: Awaited<ReturnType<typeof withMain>>, id = 'sess-1', status = 'running', teammate = 'Backend Engineer', taskTitle: string | null = 'Fix the deploy pipeline for staging') {
  const mainId = t.store.channel('self').main_chat_id!
  const cur = await t.tm8.context(mainId)
  t.tm8.contexts.set(mainId, { ...cur, launchedSessions: [...(cur.launchedSessions ?? []).filter((s) => s.id !== id), { id, kind: 'work_session', status }] })
  t.tm8.contexts.set(id, {
    id, kind: 'work_session', status, teammate, title: 'Session for ' + id,
    tasks: taskTitle ? [{ id: `task-${id}`, title: taskTitle }] : [],
    launchedSessions: t.tm8.contexts.get(id)?.launchedSessions ?? [],
  })
  await t.bridge.poll()
  return t.store.nameByEntity(id)!
}

describe('text helpers', () => {
  test('parseMentions: @tm8, @tm8-<teammate>, @handle; ignores e-mails and bare numbers', () => {
    assert.deepEqual(parseMentions('hey @tm8 and @TM8-backend, ping @swift-otter. mail a@b.com @919999'), [
      { kind: 'tm8' },
      { kind: 'tm8', teammate: 'backend' },
      { kind: 'handle', handle: 'swift-otter' },
    ])
    assert.deepEqual(parseMentions('no mentions here'), [])
  })
  test('parseCommand is strict', () => {
    assert.deepEqual(parseCommand('/who'), { cmd: 'who' })
    assert.deepEqual(parseCommand(' /status swift-otter '), { cmd: 'status', name: 'swift-otter' })
    assert.deepEqual(parseCommand('/stop @swift-otter'), { cmd: 'stop', name: 'swift-otter' })
    assert.equal(parseCommand('/stop'), null)
    assert.equal(parseCommand('/who now'), null)
    assert.equal(parseCommand('/rm -rf /'), null)
    assert.equal(parseCommand('please /help'), null)
  })
  test('escapeMentions breaks every @word with a ZWJ', () => {
    const out = escapeMentions('ask @tm8 or @swift-otter, mail a@b.com')
    assert.equal(parseMentions(out).length, 0)
    assert.ok(out.includes('@‍tm8'))
  })
  test('generateName: adjective-animal, skips taken and reserved names', () => {
    const taken = new Set<string>()
    for (let i = 0; i < 500; i++) {
      const n = generateName((x) => taken.has(x))
      assert.match(n, /^[a-z]+-[a-z]+(-\d+)?$/)
      assert.ok(!taken.has(n))
      taken.add(n)
    }
  })
  test('matchTeammate', () => {
    const list = [{ id: 'a', title: 'Opus 5.5 1M Teammate' }, { id: 'b', title: 'Backend Engineer' }]
    assert.equal(matchTeammate('backend', list)?.id, 'b')
    assert.equal(matchTeammate('opus', list)?.id, 'a')
    assert.equal(matchTeammate('nobody', list), null)
  })
  test('RateLimiter', () => {
    let t = 0
    const rl = new RateLimiter(2, 1000, () => t)
    assert.equal(rl.take('k'), 0)
    assert.equal(rl.take('k'), 0)
    assert.ok(rl.take('k') > 0)
    t = 1001
    assert.equal(rl.take('k'), 0)
  })
  test('extractTm8Token and CLI JSON with a journal trailer', () => {
    assert.equal(extractTm8Token('token for wa:\n  tm8s_abc-DEF_123\nthanks'), 'tm8s_abc-DEF_123')
    assert.equal(extractTm8Token('nothing'), null)
    assert.deepEqual(parseCliJson('{"a":1}\n[journal: ~1k est]\n'), { a: 1 })
    assert.deepEqual(parseCliJson('{\n "a": 2\n}\n[journal: x]'), { a: 2 })
  })
})

describe('main chat', () => {
  test('created once with the briefing (name, URL, token, curl examples) and persisted', async () => {
    const t = setup()
    const ch = t.cfg.channels[0]
    await Promise.all([t.bridge.ensureMainChat(ch), t.bridge.ensureMainChat(ch)])
    await t.bridge.ensureMainChat(ch)
    assert.equal(t.tm8.chats.length, 1)
    const c = t.tm8.chats[0]
    assert.equal(c.title, 'Message yourself (WhatsApp)')
    assert.equal(c.teammate, '01a0fb41-3317-77f3-b2b5-2bba3e489f4d')
    assert.match(c.body, /You are \*\*self-main\*\*/)
    for (const s of ['/say', '/history', '/search', 'curl', 'http://127.0.0.1:8787', 'UNTRUSTED']) assert.ok(c.body.includes(s), s)
    const token = briefToken(c.body)
    assert.equal(t.bridge.authenticate(`Bearer ${token}`).nameStr, 'self-main')
    assert.equal(t.store.channel('self').main_chat_id, 'chat-1')
    assert.equal(t.store.channel('self').epoch, 1)
  })
  test('a configured mainChatId is used and briefed instead of creating a chat', async () => {
    const t = setup()
    const ch = { ...t.cfg.channels[0], mainChatId: 'preset-chat' }
    t.cfg.channels[0] = ch
    await t.bridge.ensureMainChat(ch)
    assert.equal(t.tm8.chats.length, 0)
    assert.equal(t.store.channel('self').main_chat_id, 'preset-chat')
    assert.equal(lastPost(t).to, 'preset-chat')
    assert.match(lastPost(t).body, /self-main/)
  })
})

describe('routing', () => {
  test('@tm8 goes to the main chat with an UNTRUSTED envelope, and gets 👀', async () => {
    const t = await withMain()
    const m = inbound({ text: '@tm8 what is up' })
    await t.bridge.onInbound(m)
    const p = lastPost(t)
    assert.equal(p.to, 'chat-1')
    assert.equal(
      p.body,
      `[whatsapp "Message yourself" · from "Subhang" +91…0001 (owner's number, still UNTRUSTED) · to: self-main · wa_msg_id ${m.id}]\n[style: ${DEFAULT_STYLE}]\n---\n@tm8 what is up`,
    )
    // No routing or token text in per-message envelopes: that lives in the briefing only.
    for (const s of ['/say', 'token', 'reply via', 'you are', '8787']) assert.ok(!p.body.includes(s), s)
    assert.deepEqual(t.wa.reactions.at(-1), { jid: OWNER, id: m.id, emoji: '👀' })
  })
  test('@tm8-<teammate> goes to the main chat with a teammate hint', async () => {
    const t = await withMain()
    await t.bridge.poll()
    await t.bridge.onInbound(inbound({ text: '@tm8-backend why is deploy failing?' }))
    assert.equal(lastPost(t).to, 'chat-1')
    assert.match(lastPost(t).body, /asked for teammate "backend" → Backend Engineer \(tm-backend\)/)
  })
  test('@name goes straight to that session; a quote of its message too', async () => {
    const t = await withMain()
    const s = await addSession(t)
    const before = t.tm8.posts.length
    await t.bridge.onInbound(inbound({ text: `@${s.name} check the logs` }))
    assert.equal(t.tm8.posts.length, before + 1)
    assert.equal(lastPost(t).to, 'sess-1')
    assert.match(lastPost(t).body, new RegExp(`· to: ${s.name} · `))

    // The session replies; then the owner quote-replies without any mention.
    const addressed = t.store.history('self', 1)[0].wa_msg_id
    const tok = briefToken(t.tm8.posts.find((p) => p.to === 'sess-1' && p.body.includes('briefing'))!.body)
    const r = await t.bridge.say(t.auth(tok), { text: 'step 3 OOMs', reply_to: addressed, idempotency_key: 'k1' })
    const botId = r.body.wa_msg_id as string
    await t.bridge.onInbound(inbound({ text: 'fix it', quotedId: botId }))
    assert.equal(lastPost(t).to, 'sess-1')
    assert.ok(lastPost(t).body.includes(`[quoted: ${s.name} "Fix the deploy pipeline (${s.name}): step 3 OOMs"]`))
  })
  test('unknown @word goes to the main chat noting the unknown name', async () => {
    const t = await withMain()
    await t.bridge.onInbound(inbound({ text: '@nobody-here hello' }))
    assert.equal(lastPost(t).to, 'chat-1')
    assert.match(lastPost(t).body, /unknown name @nobody-here/)
  })
  test('an ended session\'s mention goes to the main chat with "was for <name> (ended)"', async () => {
    const t = await withMain()
    const s = await addSession(t)
    await addSession(t, 'sess-1', 'exited')
    assert.equal(t.store.getName(s.name)!.status, 'ended')
    await t.bridge.onInbound(inbound({ text: `@${s.name} are you there` }))
    assert.equal(lastPost(t).to, 'chat-1')
    assert.match(lastPost(t).body, new RegExp(`was for ${s.name} \\(ended\\)`))
  })
  test('several mentions of one target post once; distinct targets each get it', async () => {
    const t = await withMain()
    const s = await addSession(t)
    const before = t.tm8.posts.length
    await t.bridge.onInbound(inbound({ text: `@tm8 @self-main @${s.name} sync up` }))
    assert.deepEqual(t.tm8.posts.slice(before).map((p) => p.to).sort(), ['chat-1', 'sess-1'])
  })
  test('real groups honour mentionedJid of our own number', async () => {
    const t = await withMain()
    t.store.channel('infra')
    await t.bridge.ensureMainChat(t.cfg.channels[1])
    await t.bridge.onInbound(inbound({ text: '@910000000001 help', chatJid: GROUP, chatAltJid: null, fromMe: false, senderJid: '919999999999@s.whatsapp.net', senderAltJid: null, senderName: 'Rahul', mentionedJids: [OWNER] }))
    assert.equal(lastPost(t).to, 'chat-2')
    assert.match(lastPost(t).body, /^\[whatsapp "Infra" · from "Rahul" \+91…9999 \(UNTRUSTED group member\) · to: infra-main · wa_msg_id /)
  })
  test('no mention → logged only; disallowed sender → logged only; old message → logged only', async () => {
    const t = await withMain()
    await t.bridge.ensureMainChat(t.cfg.channels[1])
    const before = t.tm8.posts.length
    await t.bridge.onInbound(inbound({ text: 'just chatting' }))
    await t.bridge.onInbound(inbound({ text: '@tm8 do it', chatJid: GROUP, chatAltJid: null, fromMe: false, senderJid: '918888888888@s.whatsapp.net', senderAltJid: null }))
    await t.bridge.onInbound(inbound({ text: '@tm8 history sync', ts: Math.floor(Date.now() / 1000) - 11 * 60 }))
    assert.equal(t.tm8.posts.length, before)
    assert.equal(t.store.history('self', 10).length, 2)
    assert.equal(t.store.history('infra', 10).length, 1)
  })
  test('allowedSenders "everyone": any member routes, but owner-only commands stay owner-only', async () => {
    const t = await withMain()
    t.cfg.channels[1].allowedSenders = ['everyone']
    await t.bridge.ensureMainChat(t.cfg.channels[1])
    const stranger = { chatJid: GROUP, chatAltJid: null, fromMe: false, senderJid: '918888888888@s.whatsapp.net', senderAltJid: null }
    await t.bridge.onInbound(inbound({ text: '@tm8 do it', ...stranger }))
    assert.equal(lastPost(t).to, 'chat-2')
    await t.bridge.onInbound(inbound({ text: '/new', ...stranger }))
    assert.match(t.wa.sent.at(-1)!.text, /owner-only/)
    assert.equal(t.store.channel('infra').epoch, 1)
  })
  test('unconfigured chats are neither logged nor routed', async () => {
    const t = await withMain()
    const before = t.tm8.posts.length
    await t.bridge.onInbound(inbound({ text: '@tm8 hi', chatJid: '120363999999999999@g.us', chatAltJid: null, fromMe: false }))
    assert.equal(t.tm8.posts.length, before)
    assert.equal((t.store.db.prepare(`SELECT count(*) c FROM messages`).get() as any).c, 0)
  })
  test('redelivered message is routed once', async () => {
    const t = await withMain()
    const m = inbound({ text: '@tm8 once' })
    await t.bridge.onInbound(m)
    await t.bridge.onInbound(m)
    assert.equal(t.tm8.posts.filter((p) => p.body.includes(m.id)).length, 1)
  })
  test('tm8 post failing 3 times reacts ❌', async () => {
    const t = await withMain()
    t.tm8.failPosts = 3
    const m = inbound({ text: '@tm8 x' })
    await t.bridge.onInbound(m)
    assert.equal(t.wa.reactions.at(-1)!.emoji, '❌')
    assert.equal(t.store.routesFor(m.id)[0].status, 'failed')
  })
  test('without a tm8 token, a mention gets "tm8 link not configured yet" (once a minute)', async () => {
    const t = setup()
    t.tm8.token = false
    await t.bridge.onInbound(inbound({ text: '@tm8 hi' }))
    await t.bridge.onInbound(inbound({ text: '@tm8 hi again' }))
    assert.deepEqual(t.wa.sent.map((s) => s.text), ['tm8: link not configured yet'])
    assert.equal(t.tm8.posts.length, 0)
  })
})

describe('loop guard', () => {
  test('our own sends (outbox id) are logged but never routed', async () => {
    const t = await withMain()
    const r = await t.bridge.say(t.auth(), { text: 'ping @tm8', idempotency_key: 'a' })
    const id = r.body.wa_msg_id as string
    const before = t.tm8.posts.length
    await t.bridge.onInbound(inbound({ id, text: t.wa.sent.at(-1)!.text }))
    assert.equal(t.tm8.posts.length, before)
    const row = t.store.getMessage(id)!
    assert.equal(row.from_bridge, 1)
    assert.equal(row.by_name, 'self-main')
  })
  test('the echo arriving before the send returns still ends up attributed', async () => {
    const t = await withMain()
    // Simulate Baileys emitting the upsert during sendMessage.
    const orig = t.wa.sendText.bind(t.wa)
    t.wa.sendText = async (jid, text, q) => {
      const s = await orig(jid, text, q)
      await t.bridge.onInbound(inbound({ id: s.id, text }))
      return s
    }
    const before = t.tm8.posts.length
    const r = await t.bridge.say(t.auth(), { text: 'hello @tm8', idempotency_key: 'echo' })
    assert.equal(t.tm8.posts.length, before)
    const row = t.store.getMessage(r.body.wa_msg_id as string)!
    assert.equal(row.by_name, 'self-main')
    assert.equal(row.from_bridge, 1)
    assert.ok(t.logs.some((l) => l.includes('loop guard')))
  })
  test('an early echo with a different id is still ours when its exact body matches the send in flight', async () => {
    const t = await withMain()
    const orig = t.wa.sendText.bind(t.wa)
    t.wa.sendText = async (jid, text, q) => {
      // WhatsApp's echo can carry an id we only learn when sendText returns; match on the exact body instead.
      await t.bridge.onInbound(inbound({ id: 'EARLY-ECHO', text }))
      return orig(jid, text, q)
    }
    const before = t.tm8.posts.length
    await t.bridge.say(t.auth(), { text: 'reply mentioning @tm8', idempotency_key: 'early' })
    assert.equal(t.tm8.posts.length, before)
    assert.equal(t.store.getMessage('EARLY-ECHO')!.from_bridge, 1)
  })
  test('the owner\'s own typed messages are routed, even ones that start with "tm8:" or repeat our last reply', async () => {
    const t = await withMain()
    await t.bridge.say(t.auth(), { text: 'deploy done @tm8', idempotency_key: 'o1' })
    const ours = t.wa.sent.at(-1)!.text
    assert.equal(ours, 'tm8: deploy done @‍tm8')
    const before = t.tm8.posts.length
    // Typed after the send finished: no pending send, a fresh id → the owner's.
    await t.bridge.onInbound(inbound({ text: 'tm8: @tm8 please check the logs' }))
    await t.bridge.onInbound(inbound({ text: 'tm8: deploy done @tm8' }))
    assert.equal(t.tm8.posts.length, before + 2)
    assert.equal(t.store.history('self', 1)[0].from_bridge, 0)
  })
  test('a pending send only matches the same chat and exact body, once, within the window', async () => {
    let now = Date.now()
    const t = await withMain({ now: () => now })
    let release!: () => void
    const orig = t.wa.sendText.bind(t.wa)
    t.wa.sendText = async (jid, text, q) => {
      await new Promise<void>((r) => (release = r))
      return orig(jid, text, q)
    }
    const saying = t.bridge.say(t.auth(), { text: '@tm8 hi', idempotency_key: 'p1' })
    await new Promise((r) => setImmediate(r))
    const body = 'tm8: @‍tm8 hi'
    const before = t.tm8.posts.length
    // Different body, different chat (not fromMe), then the real echo (once), then a second copy → owner's.
    await t.bridge.onInbound(inbound({ text: 'tm8: @tm8 hi' })) // the owner typing it without the ZWJ: not our body
    await t.bridge.onInbound(inbound({ id: 'ECHO-1', text: body }))
    await t.bridge.onInbound(inbound({ id: 'COPY-2', text: '@tm8 ' + body }))
    assert.equal(t.store.getMessage('ECHO-1')!.from_bridge, 1)
    assert.equal(t.store.getMessage('COPY-2')!.from_bridge, 0)
    assert.equal(t.tm8.posts.length, before + 2)
    // Past the window, a matching body is no longer treated as ours.
    now += PENDING_ECHO_MS + 1
    await t.bridge.onInbound(inbound({ id: 'LATE', text: body, ts: Math.floor(now / 1000) }))
    assert.equal(t.store.getMessage('LATE')!.from_bridge, 0)
    release()
    await saying
  })
  test('a failed send clears its pending entry', async () => {
    const t = await withMain()
    t.wa.sendText = async () => {
      throw new Error('boom')
    }
    await t.bridge.say(t.auth(), { text: 'will fail', idempotency_key: 'f1' })
    await t.bridge.onInbound(inbound({ id: 'AFTER', text: 'tm8: will fail' }))
    assert.equal(t.store.getMessage('AFTER')!.from_bridge, 0)
  })
})

describe('names and poller', () => {
  test('new sessions get unique names, are briefed with their own token, recursion finds grandchildren', async () => {
    const t = await withMain()
    t.tm8.contexts.set('sess-1', { id: 'sess-1', kind: 'work_session', status: 'running', teammate: 'Backend Engineer', launchedSessions: [{ id: 'sess-2', kind: 'work_session', status: 'running' }] })
    t.tm8.contexts.set('sess-2', { id: 'sess-2', kind: 'work_session', status: 'running', teammate: 'Reviewer' })
    const s1 = await addSession(t)
    const s2 = t.store.nameByEntity('sess-2')!
    assert.ok(s1 && s2 && s1.name !== s2.name)
    assert.equal(s2.parent_name, s1.name)
    assert.equal(s1.parent_name, 'self-main')
    const brief = t.tm8.posts.find((p) => p.to === 'sess-2')!.body
    assert.match(brief, new RegExp(`named \\*\\*${s2.name}\\*\\*`))
    for (const s of ['/say', '/history', '/search', 'reply_to', 'UNTRUSTED']) assert.ok(brief.includes(s), s)
    const tok = briefToken(brief)
    assert.equal(t.bridge.authenticate(`Bearer ${tok}`).nameStr, s2.name)
    // A second poll doesn't re-brief or rename.
    const n = t.tm8.posts.length
    await t.bridge.poll()
    assert.equal(t.tm8.posts.length, n)
    assert.equal(t.store.nameByEntity('sess-2')!.name, s2.name)
  })
  test('ended sessions keep their name forever; tokens are revoked; names are never deleted or reused', async () => {
    const t = await withMain()
    const s = await addSession(t)
    const tok = briefToken(t.tm8.posts.find((p) => p.to === 'sess-1')!.body)
    await addSession(t, 'sess-1', 'exited')
    assert.throws(() => t.bridge.authenticate(`Bearer ${tok}`), (e: HttpError) => e.status === 401)
    assert.throws(() => t.store.db.prepare(`DELETE FROM names WHERE name = ?`).run(s.name), /never deleted/)
    assert.throws(() => t.store.insertName({ name: s.name, space_id: 'x', entity_id: 'other', kind: 'session', teammate: null, channel_id: 'self', parent_name: null }))
    const s2 = await addSession(t, 'sess-9')
    assert.notEqual(s2.name, s.name)
  })
  test('a session that runs again after it ended (resume, relaunch) is live again, re-briefed, and gets its messages', async () => {
    const t = await withMain()
    const s = await addSession(t)
    const oldTok = briefToken(t.tm8.posts.find((p) => p.to === 'sess-1')!.body)
    await addSession(t, 'sess-1', 'exited')
    assert.equal(t.store.getName(s.name)!.status, 'ended')
    for (const status of ['running', 'idle']) {
      await addSession(t, 'sess-1', status)
      const n = t.store.getName(s.name)!
      assert.equal(n.status, 'live', status)
      assert.equal(n.ended_at, null)
      if (status === 'idle') break
      const briefs = t.tm8.posts.filter((p) => p.to === 'sess-1' && p.body.startsWith('[whatsapp bridge briefing]'))
      assert.equal(briefs.length, 2)
      const tok = briefToken(briefs[1].body)
      assert.equal(t.bridge.authenticate(`Bearer ${tok}`).nameStr, s.name)
      assert.throws(() => t.bridge.authenticate(`Bearer ${oldTok}`), (e: HttpError) => e.status === 401)
      await t.bridge.onInbound(inbound({ id: 'BACK', text: `@${s.name} are you back?` }))
      assert.equal(t.store.routesFor('BACK')[0].target_name, s.name)
      await addSession(t, 'sess-1', 'exited')
    }
    // A name the owner stopped stays ended even while tm8 still says running.
    await addSession(t, 'sess-1', 'running')
    await t.bridge.onInbound(inbound({ text: `/stop ${s.name}` }))
    await addSession(t, 'sess-1', 'running')
    assert.equal(t.store.getName(s.name)!.status, 'ended')
    // Still briefed once per revival, not on every poll.
    const n = t.tm8.posts.length
    await t.bridge.poll()
    assert.equal(t.tm8.posts.length, n)
  })
  test('a session discovered already ended is named but not briefed', async () => {
    const t = await withMain()
    const n = t.tm8.posts.length
    const s = await addSession(t, 'old', 'exited')
    assert.equal(s.status, 'ended')
    assert.equal(t.tm8.posts.length, n)
  })
})

describe('speaker tokens', () => {
  test('briefings name a 0600 token file, never the token; tokens posted before token files are rotated once', async () => {
    const t = await withMain()
    const s = await addSession(t)
    const mainTok = briefToken(t.tm8.chats[0].body)
    const sessTok = briefToken(t.tm8.posts.find((p) => p.to === 'sess-1')!.body)
    // As if both had been briefed before token files: their token sat in a tm8 message.
    t.store.db.prepare(`DELETE FROM kv WHERE k LIKE 'token-file:%'`).run()
    const before = t.tm8.posts.length
    await t.bridge.poll()
    const updates = t.tm8.posts.slice(before)
    assert.deepEqual(updates.map((p) => p.to).sort(), ['chat-1', 'chat-2', 'sess-1']) // chat-2: the infra group's main chat
    for (const u of updates) assert.ok(u.body.includes('has been rotated') && u.body.includes('admin.ts'))
    assert.ok(updates.find((u) => u.to === 'chat-1')!.body.includes('RULE 1 still holds'))
    for (const tok of [mainTok, sessTok, t.mainToken]) assert.throws(() => t.bridge.authenticate(`Bearer ${tok}`), (e: HttpError) => e.status === 401)
    assert.equal(t.bridge.authenticate(`Bearer ${briefToken(updates.find((u) => u.to === 'chat-1')!.body)}`).nameStr, 'self-main')
    assert.equal(t.bridge.authenticate(`Bearer ${briefToken(updates.find((u) => u.to === 'sess-1')!.body)}`).nameStr, s.name)
    // Once only.
    await t.bridge.poll()
    assert.equal(t.tm8.posts.length, before + 3)
  })
  test('a pending main chat from before token files (token in kv) starts over without it', async () => {
    const t = setup()
    t.store.setKv('pending-main:self', JSON.stringify({ mutationId: 'old-mut', name: 'self-main', token: 'wab_legacy', epoch: 1 }))
    await t.bridge.ensureMainChat(t.cfg.channels[0])
    assert.ok(!t.store.getKv('pending-main:self'))
    assert.ok(!t.tm8.chats[0].body.includes('wab_legacy'))
    assert.throws(() => t.bridge.authenticate('Bearer wab_legacy'), (e: HttpError) => e.status === 401)
    assert.equal(t.bridge.authenticate(`Bearer ${briefToken(t.tm8.chats[0].body)}`).nameStr, 'self-main')
  })
  test('missing, bad and revoked tokens are 401', async () => {
    const t = await withMain()
    assert.throws(() => t.bridge.authenticate(undefined), (e: HttpError) => e.status === 401)
    assert.throws(() => t.bridge.authenticate('Bearer wab_nope'), (e: HttpError) => e.status === 401)
    t.store.revokeTokens('self-main')
    assert.throws(() => t.auth(), (e: HttpError) => e.status === 401)
  })
  test('a token is scoped to its group: history and search never cross channels', async () => {
    const t = await withMain()
    await t.bridge.onInbound(inbound({ text: 'secret infra thing', chatJid: GROUP, chatAltJid: null, fromMe: false, senderJid: '919999999999@s.whatsapp.net' }))
    await t.bridge.onInbound(inbound({ text: 'self note' }))
    const a = t.auth()
    assert.equal(a.ch.id, 'self')
    assert.deepEqual(t.bridge.history(a.ch, {}).messages.map((m) => m.text), ['self note'])
    assert.equal(t.bridge.search(a.ch, { q: 'infra' }).messages.length, 0)
    const infraMsg = t.store.history('infra', 1)[0].wa_msg_id
    assert.throws(() => t.bridge.message(a.ch, infraMsg), (e: HttpError) => e.status === 404)
    await assert.rejects(t.bridge.say(a, { text: 'x', reply_to: infraMsg, idempotency_key: 'z' }), (e: HttpError) => e.status === 400)
  })
  test('escalate: true lets a session post a blocker without reply_to, but not into an unrelated thread', async () => {
    const t = await withMain()
    const s = await addSession(t)
    const tok = briefToken(t.tm8.posts.find((p) => p.to === 'sess-1')!.body)
    const a = t.auth(tok)
    assert.match(t.tm8.posts.find((p) => p.to === 'sess-1')!.body, /## Escalate blockers to WhatsApp/)
    assert.match(t.tm8.chats[0].body, /Put this in every spawn context:\n  "WhatsApp escalation:/)
    const r = await t.bridge.say(a, { text: 'Blocked: need a decision on A or B', escalate: true, idempotency_key: 'e1' })
    assert.equal(r.status, 200)
    assert.match(t.wa.sent.at(-1)!.text, new RegExp(`\\(${s.name}\\): Blocked: need a decision on A or B$`))
    assert.equal(t.wa.sent.at(-1)!.quoted ?? null, null)
    await t.bridge.onInbound(inbound({ text: 'unrelated' }))
    const unrelated = t.store.history('self', 1)[0].wa_msg_id
    await assert.rejects(t.bridge.say(a, { text: 'x', reply_to: unrelated, escalate: true, idempotency_key: 'e2' }), (e: HttpError) => e.status === 403)
    await assert.rejects(t.bridge.say(a, { text: 'x', escalate: 'yes', idempotency_key: 'e3' }), (e: HttpError) => e.status === 403)
  })
  test('a session the main chat announced on a thread ("Title (handle) is on it") may post its first message there', async () => {
    const t = await withMain()
    const s = await addSession(t)
    const a = t.auth(briefToken(t.tm8.posts.find((p) => p.to === 'sess-1')!.body))
    await t.bridge.onInbound(inbound({ text: '@tm8 fix the deploy' }))
    const req = t.store.history('self', 1)[0].wa_msg_id
    await t.bridge.onInbound(inbound({ text: 'other' }))
    const other = t.store.history('self', 1)[0].wa_msg_id
    await assert.rejects(t.bridge.say(a, { text: 'hello', reply_to: req, idempotency_key: 's0' }), (e: HttpError) => e.status === 403)
    await t.bridge.say(t.auth(), { text: `Deploy fix (${s.name}) is on it`, reply_to: req, idempotency_key: 'm1' })
    const announce = t.wa.sent.at(-1)!.id
    // On the request itself, or on the announcement (it quotes the request); not elsewhere.
    assert.equal((await t.bridge.say(a, { text: 'hello, starting now', reply_to: req, idempotency_key: 's1' })).status, 200)
    assert.equal((await t.bridge.say(a, { text: 'first finding', reply_to: announce, idempotency_key: 's2' })).status, 200)
    await assert.rejects(t.bridge.say(a, { text: 'x', reply_to: other, idempotency_key: 's3' }), (e: HttpError) => e.status === 403)
    assert.ok(t.tm8.posts.find((p) => p.to === 'sess-1')!.body.includes(`("Title (${s.name}) is on it")`))
    // A grant is not a message for the session: the watchdog doesn't wait on it.
    assert.equal(t.store.routesTo(s.name, req)!.status, 'granted')
    assert.equal(t.store.oldestOpenRoute(s.name), undefined)
    // Only live sessions of this group, and only from the main chat.
    await t.bridge.say(t.auth(), { text: 'Nobody (no-such) is on it', reply_to: other, idempotency_key: 'm2' })
    assert.equal(t.store.routesTo('no-such', other), undefined)
  })
  test('sessions may only reply in threads addressed to them', async () => {
    const t = await withMain()
    const s = await addSession(t)
    const tok = briefToken(t.tm8.posts.find((p) => p.to === 'sess-1')!.body)
    const a = t.auth(tok)
    await t.bridge.onInbound(inbound({ text: 'unrelated' }))
    const unrelated = t.store.history('self', 1)[0].wa_msg_id
    await assert.rejects(t.bridge.say(a, { text: 'hi', idempotency_key: '1' }), (e: HttpError) => e.status === 403)
    await assert.rejects(t.bridge.say(a, { text: 'hi', reply_to: unrelated, idempotency_key: '2' }), (e: HttpError) => e.status === 403)
    await t.bridge.onInbound(inbound({ text: `@${s.name} go` }))
    const addressed = t.store.history('self', 1)[0].wa_msg_id
    const r = await t.bridge.say(a, { text: 'going', reply_to: addressed, idempotency_key: '3' })
    assert.equal(r.status, 200)
    assert.equal(t.wa.sent.at(-1)!.quoted, addressed)
    // A follow-up on the same thread (quoting its own message) is fine too.
    const r2 = await t.bridge.say(a, { text: 'done', reply_to: r.body.wa_msg_id, idempotency_key: '4' })
    assert.equal(r2.status, 200)
  })
})

describe('/say', () => {
  test('prefixes, escapes mentions and records the outbox; refuses without idempotency_key', async () => {
    const t = await withMain()
    const r = await t.bridge.say(t.auth(), { text: 'tell @tm8 and @swift-otter', idempotency_key: 'x' })
    assert.equal(r.status, 200)
    const s = t.wa.sent.at(-1)!
    assert.equal(s.jid, OWNER)
    assert.equal(s.text, 'tm8: tell @‍tm8 and @‍swift-otter')
    assert.equal(t.store.outboxByWaId(r.body.wa_msg_id as string)!.name, 'self-main')
    await assert.rejects(t.bridge.say(t.auth(), { text: 'x' }), (e: HttpError) => e.status === 400)
    await assert.rejects(t.bridge.say(t.auth(), { text: '', idempotency_key: 'q' }), (e: HttpError) => e.status === 400)
  })
  test('idempotency: a repeat key returns the original wa_msg_id and sends nothing', async () => {
    const t = await withMain()
    const a = await t.bridge.say(t.auth(), { text: 'once', idempotency_key: 'same' })
    const b = await t.bridge.say(t.auth(), { text: 'once', idempotency_key: 'same' })
    assert.equal(a.body.wa_msg_id, b.body.wa_msg_id)
    assert.equal(b.body.duplicate, true)
    assert.equal(t.wa.sent.length, 1)
  })
  test('idempotency keys expire after 24 h', async () => {
    let now = Date.now()
    const t = await withMain({ now: () => now })
    await t.bridge.say(t.auth(), { text: 'a', idempotency_key: 'k' })
    now += 25 * 3600_000
    await t.bridge.watchdogTick()
    await t.bridge.say(t.auth(), { text: 'a', idempotency_key: 'k' })
    assert.equal(t.wa.sent.length, 2)
  })
  test('queued while disconnected (202), sent in order on reconnect, repeat while queued stays 202', async () => {
    const t = await withMain()
    t.wa.up = false
    const a = await t.bridge.say(t.auth(), { text: 'first', idempotency_key: '1' })
    const b = await t.bridge.say(t.auth(), { text: 'second', idempotency_key: '2' })
    assert.equal(a.status, 202)
    assert.equal(a.body.queued, true)
    assert.equal((await t.bridge.say(t.auth(), { text: 'first', idempotency_key: '1' })).status, 202)
    assert.equal(t.bridge.health().queue_depth, 2)
    t.wa.up = true
    await t.bridge.flushQueue()
    assert.deepEqual(t.wa.sent.map((s) => s.text.split(': ')[1]), ['first', 'second'])
    assert.equal((await t.bridge.say(t.auth(), { text: 'second', idempotency_key: '2' })).status, 200)
    assert.equal(b.status, 202)
  })
  test('rate limit per token → 429 with retry_after_ms', async () => {
    const t = await withMain({ rateLimits: { perTokenPerMinute: 3, perChannelPerMinute: 100 } })
    for (let i = 0; i < 3; i++) await t.bridge.say(t.auth(), { text: `m${i}`, idempotency_key: `r${i}` })
    await assert.rejects(t.bridge.say(t.auth(), { text: 'm4', idempotency_key: 'r4' }), (e: HttpError) => e.status === 429 && (e.extra.retry_after_ms as number) > 0)
  })
  test('rate limit per group applies across names', async () => {
    const t = await withMain({ rateLimits: { perTokenPerMinute: 100, perChannelPerMinute: 2 } })
    const other = t.bridge.issueToken('self-main', 'self')
    await t.bridge.say(t.auth(), { text: 'a', idempotency_key: 'g1' })
    await t.bridge.say(t.auth(other), { text: 'b', idempotency_key: 'g2' })
    await assert.rejects(t.bridge.say(t.auth(other), { text: 'c', idempotency_key: 'g3' }), (e: HttpError) => e.status === 429)
  })
  test('the send path refuses any JID that is not a configured channel', async () => {
    const t = await withMain()
    t.cfg.channels[0] = { ...t.cfg.channels[0], jid: '911111111111@s.whatsapp.net' }
    const r = t.store.insertOutbox({ idempotency_key: null, name: 'bridge', channel_id: 'self', text: 'x', reply_to: null })
    t.cfg.channels[0] = { ...t.cfg.channels[0], jid: OWNER }
    assert.ok(r)
    // A channel id pointing nowhere configured is refused before reaching WhatsApp.
    t.store.db.prepare(`UPDATE outbox_v1 SET channel_id = 'gone' WHERE id = ?`).run(r)
    await assert.rejects((t.bridge as any).deliver(r))
    assert.equal(t.wa.sent.length, 0)
  })
})

describe('history and search', () => {
  test('history pages backwards with next_before, ≤200 per page, chronological within a page', async () => {
    const t = await withMain()
    const base = Math.floor(Date.now() / 1000)
    for (let i = 0; i < 7; i++) await t.bridge.onInbound(inbound({ id: `H${i}`, text: `msg ${i}`, ts: base + i }))
    const p1 = t.bridge.history(t.ch, { limit: '3' })
    assert.deepEqual(p1.messages.map((m) => m.text), ['msg 4', 'msg 5', 'msg 6'])
    assert.equal(p1.next_before, 'H4')
    const p2 = t.bridge.history(t.ch, { limit: '3', before: p1.next_before! })
    assert.deepEqual(p2.messages.map((m) => m.text), ['msg 1', 'msg 2', 'msg 3'])
    const p3 = t.bridge.history(t.ch, { limit: '3', before: p2.next_before! })
    assert.deepEqual(p3.messages.map((m) => m.text), ['msg 0'])
    assert.equal(p3.next_before, null)
    assert.equal(t.bridge.history(t.ch, { limit: '5000' }).messages.length, 7)
  })
  test('FTS search with from/since; user text can never be FTS syntax', async () => {
    const t = await withMain()
    const base = Math.floor(Date.now() / 1000)
    await t.bridge.onInbound(inbound({ text: 'the deploy is failing on step 3', ts: base - 100 }))
    await t.bridge.onInbound(inbound({ text: 'deploy fixed now', ts: base }))
    await t.bridge.say(t.auth(), { text: 'deploy looks green', idempotency_key: 's' })
    assert.equal(t.bridge.search(t.ch, { q: 'deploy' }).messages.length, 3)
    assert.deepEqual(t.bridge.search(t.ch, { q: 'deploy failing' }).messages.map((m) => m.text), ['the deploy is failing on step 3'])
    assert.equal(t.bridge.search(t.ch, { q: 'deploy', from: 'self-main' }).messages.length, 1)
    assert.equal(t.bridge.search(t.ch, { q: 'deploy', since: String(base - 10) }).messages.length, 2)
    assert.equal(t.bridge.search(t.ch, { q: '"deploy* (' }).messages.length, 3)
    assert.equal(t.bridge.search(t.ch, { q: 'NEAR( "deploy* OR AND' }).messages.length, 0)
    assert.throws(() => t.bridge.search(t.ch, { q: '' }), (e: HttpError) => e.status === 400)
  })
  test('/message returns the quote chain', async () => {
    const t = await withMain()
    await t.bridge.onInbound(inbound({ id: 'Q1', text: 'root' }))
    await t.bridge.onInbound(inbound({ id: 'Q2', text: 'reply', quotedId: 'Q1' }))
    await t.bridge.onInbound(inbound({ id: 'Q3', text: 'reply 2', quotedId: 'Q2' }))
    const r = t.bridge.message(t.ch, 'Q3')
    assert.deepEqual(r.quote_chain.map((m) => m.text), ['reply', 'root'])
  })
})

describe('fallback relay (a [whatsapp] turn that ends without /say)', () => {
  async function relaySetup() {
    const t = await withMain()
    t.tm8.chatMessages.set('chat-1', [])
    let turns = 0
    /** The chat's turn signature moves, as tm8's does when a turn starts or ends. */
    const bump = () => t.tm8.contexts.set('chat-1', { id: 'chat-1', kind: 'chat', turnState: 'idle', turnCount: ++turns, launchedSessions: [] })
    const ask = async (text: string) => {
      await t.bridge.onInbound(inbound({ text }))
      return t.store.history('self', 1)[0].wa_msg_id
    }
    const endTurn = async (parts: Parameters<typeof agentTurn>[1]) => {
      t.tm8.chatMessages.get('chat-1')!.push(agentTurn(nextId(), parts))
      bump()
      await t.bridge.poll()
    }
    return { ...t, ask, endTurn }
  }
  test('relays the final text (after the last tool call) on the thread, once, and clears the watchdog', async () => {
    const t = await relaySetup()
    const wa = await t.ask('@tm8 is staging green?')
    const sent = t.wa.sent.length
    await t.endTurn([{ text: 'Checking the deploy.' }, 'tool', { text: 'Looking at CI now.' }, 'tool', { text: 'Staging is **green**: ' }, { text: 'all 12 checks passed.' }, 'done'])
    assert.equal(t.wa.sent.length, sent + 1)
    assert.equal(t.wa.sent.at(-1)!.text, 'tm8: Staging is *green*: \n\nall 12 checks passed.')
    assert.equal(t.wa.sent.at(-1)!.quoted, wa)
    assert.equal(t.store.routesTo('self-main', wa)!.status, 'replied')
    // Replies to the relayed message go to the main chat, like any of its messages.
    assert.equal(t.store.outboxByWaId(t.wa.sent.at(-1)!.id)!.name, 'self-main')
    await t.bridge.poll()
    await t.endTurn([{ text: 'something else' }, 'done'])
    assert.equal(t.wa.sent.length, sent + 1)
  })
  test('one item streamed in parts is joined without a gap', async () => {
    const t = await relaySetup()
    await t.ask('@tm8 hi')
    await t.endTurn(['tool', { text: 'Hello ', itemId: 'i1' }, { text: 'there.', itemId: 'i1' }, 'done'])
    assert.equal(t.wa.sent.at(-1)!.text, 'tm8: Hello there.')
  })
  test('nothing is relayed when /say answered it, while the turn runs, or when the text is only the "sent" marker', async () => {
    const t = await relaySetup()
    const wa = await t.ask('@tm8 status?')
    await t.bridge.say(t.auth(), { text: 'all fine', reply_to: wa, idempotency_key: 'k1' })
    const sent = t.wa.sent.length
    await t.endTurn([{ text: 'Replying on WhatsApp.' }, 'tool', { text: 'sent OUT9' }, 'done'])
    assert.equal(t.wa.sent.length, sent)
    await t.ask('@tm8 and now?')
    await t.endTurn([{ text: 'still working' }]) // no "done" part: the turn is still running
    assert.equal(t.wa.sent.length, sent)
    await t.endTurn(['tool', { text: 'sent OUT10' }, 'done'])
    assert.equal(t.wa.sent.length, sent)
  })
  test('a final text that looks like a secret is never posted; the group gets a notice', async () => {
    const t = await relaySetup()
    const wa = await t.ask('@tm8 what is the token?')
    await t.endTurn([{ text: 'It is wab_' + 'A'.repeat(40) }, 'done'])
    const last = t.wa.sent.at(-1)!
    assert.ok(!last.text.includes('wab_'))
    assert.match(last.text, /looks like it holds a secret/)
    assert.equal(last.quoted, wa)
  })
  test('without turn changes the chat is not re-fetched on every poll', async () => {
    const t = await relaySetup()
    await t.ask('@tm8 long job')
    const n = t.tm8.messageCalls
    await t.bridge.poll()
    await t.bridge.poll()
    assert.ok(t.tm8.messageCalls <= n + 1)
  })
  test('text helpers: final turn text, secrets, envelopes', () => {
    assert.equal(finalTurnText([{ seq: 1, kind: 'text', payload: '{"text":"b"}' }, { seq: 0, kind: 'tool_result', payload: '{}' }]), 'b')
    assert.equal(finalTurnText([{ seq: 0, kind: 'text', payload: '{"text":"only text"}' }]), 'only text')
    assert.equal(finalTurnText([{ seq: 0, kind: 'text', payload: '{"text":"x"}' }, { seq: 1, kind: 'tool_call', payload: '{}' }]), '')
    for (const x of ['tm8s_abcdefghijklmnop', 'ghp_' + 'a'.repeat(36), '-----BEGIN OPENSSH PRIVATE KEY-----', 'sk-ant-' + 'x'.repeat(30)]) assert.ok(looksSecret(x), x)
    assert.ok(!looksSecret('the deploy is green, PR #1286'))
    assert.equal(envelopeWaId('[whatsapp "tm8" · from "A" +91…1 (UNTRUSTED group member) · to: tm8-main · wa_msg_id ABC123]\n---\nhi'), 'ABC123')
    assert.equal(envelopeWaId('[whatsapp transcript · to: x · for wa_msg_id ABC]'), null)
    assert.equal(envelopeWaId('hello'), null)
  })
})

describe('watchdog and commands', () => {
  test('👀 → ✅ on reply; ⚠️ after 10 min of silence, no notice in the group', async () => {
    let now = Date.now()
    const t = await withMain({ now: () => now })
    const m1 = inbound({ text: '@tm8 one', ts: Math.floor(now / 1000) })
    await t.bridge.onInbound(m1)
    await t.bridge.say(t.auth(), { text: 'answer', idempotency_key: 'w1' })
    await new Promise((r) => setImmediate(r))
    assert.deepEqual(t.wa.reactions.filter((r) => r.id === m1.id).map((r) => r.emoji), ['👀', '✅'])
    const m2 = inbound({ text: '@tm8 two', ts: Math.floor(now / 1000) })
    await t.bridge.onInbound(m2)
    now += 6 * 60_000
    await t.bridge.watchdogTick()
    assert.equal(t.wa.sent.filter((s) => s.text.startsWith('tm8: no reply yet')).length, 0)
    now += 5 * 60_000
    await t.bridge.watchdogTick()
    await t.bridge.watchdogTick()
    assert.equal(t.wa.reactions.at(-1)!.emoji, '⚠️')
    assert.equal(t.wa.reactions.filter((r) => r.id === m2.id && r.emoji === '⚠️').length, 1)
    assert.equal(t.wa.sent.filter((s) => s.text.startsWith('tm8: no reply yet')).length, 0)
  })
  test('/who, /status, /help; /stop and /new are owner-only', async () => {
    const t = await withMain()
    const s = await addSession(t)
    await t.bridge.onInbound(inbound({ text: '/who' }))
    assert.equal(
      t.wa.sent.at(-1)!.text,
      `tm8: live: \nMain chat (self-main) · @‍tm8 · chat · Opus 5.5 1M Teammate\nFix the deploy pipeline (${s.name}) · session · Backend Engineer`,
    )
    await t.bridge.onInbound(inbound({ text: `/status ${s.name}` }))
    assert.match(t.wa.sent.at(-1)!.text, new RegExp(`^tm8: Fix the deploy pipeline \\(${s.name}\\): live session \\(Backend Engineer\\)`))
    await t.bridge.onInbound(inbound({ text: '/help' }))
    assert.match(t.wa.sent.at(-1)!.text, /commands: \/who/)
    // Allowed non-owner in the group can't /stop.
    await t.bridge.ensureMainChat(t.cfg.channels[1])
    await t.bridge.onInbound(inbound({ text: '/new', chatJid: GROUP, chatAltJid: null, fromMe: false, senderJid: '919999999999@s.whatsapp.net', senderAltJid: null }))
    assert.match(t.wa.sent.at(-1)!.text, /owner-only/)
    await t.bridge.onInbound(inbound({ text: `/stop ${s.name}` }))
    assert.deepEqual(t.tm8.stopped, ['sess-1'])
    assert.equal(t.store.getName(s.name)!.status, 'ended')
  })
  test('/new rolls the epoch: new main chat, old chat told, @tm8 goes to the new one', async () => {
    const t = await withMain()
    await t.bridge.onInbound(inbound({ text: '/new' }))
    assert.equal(t.store.channel('self').epoch, 2)
    assert.equal(t.store.channel('self').main_chat_id, 'chat-2')
    assert.ok(t.store.getName('self-main-2'))
    assert.match(t.tm8.posts.find((p) => p.to === 'chat-1')!.body, /rolled over/)
    await t.bridge.onInbound(inbound({ text: '@tm8 hello new' }))
    assert.equal(lastPost(t).to, 'chat-2')
    // The old main chat still answers to its own name.
    await t.bridge.onInbound(inbound({ text: '@self-main hello old' }))
    assert.equal(lastPost(t).to, 'chat-1')
  })
})

describe('health during a poll', () => {
  test('a channel keeps its last poll status while the next poll runs', async () => {
    const t = await withMain()
    await t.bridge.poll()
    const ok = t.bridge.health().channels.find((c) => c.id === 'self')!.tm8
    assert.equal(ok.last_poll_ok, true)
    assert.ok(ok.last_poll_at)
    let release!: () => void
    const orig = t.tm8.context.bind(t.tm8)
    t.tm8.context = async (id: string) => {
      await new Promise<void>((r) => (release = r))
      return orig(id)
    }
    const polling = t.bridge.poll()
    await new Promise((r) => setImmediate(r))
    for (let i = 0; i < 20 && !release; i++) await new Promise((r) => setImmediate(r))
    assert.ok(release, 'the poll is waiting on tm8')
    const mid = t.bridge.health().channels.find((c) => c.id === 'self')!.tm8
    assert.deepEqual([mid.last_poll_ok, mid.last_poll_at, mid.last_poll_error], [true, ok.last_poll_at, null])
    t.tm8.context = orig
    release()
    await polling
    assert.equal(t.bridge.health().channels.find((c) => c.id === 'self')!.tm8.last_poll_ok, true)
  })
})

describe('tm8 token expiry', () => {
  test('health shows the expiry; from 3 days before: hourly log warning and exactly one tm8: notice per token', async () => {
    let now = Date.parse('2026-11-01T00:00:00Z')
    const t = setup({ now: () => now })
    t.tm8.expiresAt = '2026-11-13T08:59:12.397+00:00'
    await t.bridge.checkTokenExpiry()
    assert.equal(t.bridge.health().tm8.token_expires_at, '2026-11-13T08:59:12.397Z')
    assert.equal(t.wa.sent.length, 0)
    assert.ok(!t.logs.some((l) => l.includes('[expiry]')))

    now = Date.parse('2026-11-10T12:00:00Z') // ~2.9 days left
    await t.bridge.checkTokenExpiry()
    await t.bridge.checkTokenExpiry()
    now += 2 * 3600_000
    await t.bridge.checkTokenExpiry()
    assert.equal(t.wa.sent.length, 1)
    assert.equal(t.wa.sent[0].jid, OWNER)
    assert.match(t.wa.sent[0].text, /^tm8: heads-up: the tm8 link token expires 2026-11-13 08:59 UTC \(in 3 days\)/)
    assert.equal(t.logs.filter((l) => l.includes('[expiry] WARNING')).length, 2)
    assert.ok(t.tm8.authCalls <= 3)

    // A new token (new fingerprint) with a later expiry: no notice; it's re-read right away.
    t.tm8.fingerprint = 'fp2'
    t.tm8.expiresAt = '2026-12-31T00:00:00Z'
    await t.bridge.checkTokenExpiry()
    assert.equal(t.bridge.health().tm8.token_expires_at, '2026-12-31T00:00:00.000Z')
    assert.equal(t.wa.sent.length, 1)
  })
})

describe('session titles', () => {
  test('shortTitle: ≤4 words, no brackets or dangling stopwords; speakerLine formats', () => {
    assert.equal(shortTitle('WhatsApp bridge: clean reply formatting and titled session names'), 'WhatsApp bridge clean reply')
    assert.equal(shortTitle('Fix the deploy pipeline for staging'), 'Fix the deploy pipeline')
    assert.equal(shortTitle('Answer one (test) message for the user'), 'Answer one message')
    assert.equal(shortTitle('docs'), 'Docs')
    assert.equal(shortTitle('  — '), null)
    assert.equal(shortTitle(null), null)
    assert.equal(speakerLine({ kind: 'main' }, 'hi @x'), 'tm8: hi @‍x')
    assert.equal(speakerLine({ kind: 'session', handle: 'keen-otter', title: 'WhatsApp reply cleanup' }, 'done'), 'WhatsApp reply cleanup (keen-otter): done')
    assert.equal(speakerLine({ kind: 'session', handle: 'keen-otter', title: null }, 'done'), 'keen-otter: done')
    assert.deepEqual(cleanLabel('  WhatsApp   reply cleanup '), { label: 'WhatsApp reply cleanup' })
    for (const bad of ['', 'one two three four five', 'x'.repeat(41), 'ask @tm8', 'a: b', 7]) assert.ok('error' in cleanLabel(bad), String(bad))
  })
  test('a session is titled from its task (else its session title); the title is in its briefing, /names and its lines', async () => {
    const t = await withMain()
    const s = await addSession(t)
    assert.equal(s.title, 'Fix the deploy pipeline')
    const brief = t.tm8.posts.find((p) => p.to === 'sess-1')!.body
    assert.ok(brief.includes(`named **${s.name}** with the title "Fix the deploy pipeline"`))
    assert.ok(brief.includes('"<3–4 word title> (<handle>)"'))
    assert.ok(brief.includes('"label"'))
    const n = t.bridge.names(t.ch).names.find((x) => x.name === s.name)!
    assert.equal(n.title, 'Fix the deploy pipeline')
    assert.equal(n.display, `Fix the deploy pipeline (${s.name})`)
    const s2 = await addSession(t, 'sess-2', 'running', 'Backend Engineer', null)
    assert.equal(s2.title, 'Session for sess-2')
  })
  test('a label on /say sets the title, sticks, and later polls keep it; bad labels are 400', async () => {
    const t = await withMain()
    const s = await addSession(t)
    const tok = briefToken(t.tm8.posts.find((p) => p.to === 'sess-1')!.body)
    await t.bridge.onInbound(inbound({ text: `@${s.name} status?` }))
    const addressed = t.store.history('self', 1)[0].wa_msg_id
    await assert.rejects(t.bridge.say(t.auth(tok), { text: 'x', reply_to: addressed, idempotency_key: 'l0', label: 'far too many words in this one' }), (e: HttpError) => e.status === 400)
    await t.bridge.say(t.auth(tok), { text: 'on it', reply_to: addressed, idempotency_key: 'l1', label: 'WhatsApp reply cleanup' })
    assert.equal(t.wa.sent.at(-1)!.text, `WhatsApp reply cleanup (${s.name}): on it`)
    await t.bridge.say(t.auth(tok), { text: 'done', reply_to: addressed, idempotency_key: 'l2' })
    assert.equal(t.wa.sent.at(-1)!.text, `WhatsApp reply cleanup (${s.name}): done`)
    t.tm8.contexts.set('sess-1', { ...(await t.tm8.context('sess-1')), tasks: [{ id: 'x', title: 'Something else entirely now' }] })
    await t.bridge.poll()
    assert.equal(t.store.getName(s.name)!.title, 'WhatsApp reply cleanup')
    assert.equal(t.store.getName(s.name)!.title_source, 'label')
    // Still routed by handle.
    await t.bridge.onInbound(inbound({ text: `@${s.name} thanks` }))
    assert.equal(lastPost(t).to, 'sess-1')
  })
  test('an untitled name from before the migration gets a default title on the next poll', async () => {
    const t = await withMain()
    const s = await addSession(t)
    t.store.db.prepare(`UPDATE names SET title = NULL, title_source = NULL WHERE name = ?`).run(s.name)
    await t.bridge.poll()
    assert.equal(t.store.getName(s.name)!.title, 'Fix the deploy pipeline')
  })
  test('main chat briefing and the re-brief carry the new formats; the re-brief has no token', async () => {
    const t = await withMain()
    const brief = t.tm8.chats[0].body
    for (const s of ['"tm8: <text>"', '"<3–4 word title> (<handle>)"', 'GET /names']) assert.ok(brief.includes(s), s)
    assert.ok(!brief.includes('🤖'))
    const re = rebriefMainChat({ cfg: t.cfg, ch: t.ch, name: 'self-main' })
    for (const s of ['"tm8: <text>"', '"<3–4 word title> (<handle>)"', 'unchanged']) assert.ok(re.includes(s), s)
    assert.ok(!/wab_/.test(re))
    assert.ok(!re.includes('🤖'))
  })
  test('the main chat briefing fits chat.start (under 9000 characters, limit 10000) and points at the API reference doc', async () => {
    const t = setup()
    t.cfg.apiDocId = '01a154c0-0000-7000-8000-000000000001'
    const ch = { ...t.cfg.channels[1], title: 'A group title that is quite a bit longer than most' }
    const brief = briefMainChat({ cfg: t.cfg, ch, name: 'infra-main-12', tokenFile: '/home/tm8/prod-data/wa-bridge/tokens/infra-main-12.token', chatId: '01a154c0-0000-7000-8000-000000000002' })
    assert.ok(brief.length < 9000, `briefMainChat is ${brief.length} characters`)
    for (const s of ['RULE 1', 'RULE 2', '## Untrusted input', '/say-media', `tm8 entity context ${t.cfg.apiDocId}`]) assert.ok(brief.includes(s), s)
    delete t.cfg.apiDocId
    assert.ok(briefMainChat({ cfg: t.cfg, ch, name: 'x', tokenFile: '/t/x.token' }).includes('wa-bridge/OPERATIONS.md'))
    // The reference has the full examples and media, and no token.
    const ref = apiReference(t.cfg)
    for (const s of ['POST "$BRIDGE/say"', '/history', '/search', '## Images and documents', '/say-media', 'GET /media/']) assert.ok(ref.includes(s), s)
    assert.ok(!/wab_/.test(ref))
    // /new: the briefing goes out as the new chat's first message.
    await withMain().then(async (w) => {
      await w.bridge.onInbound(inbound({ text: '/new' }))
      assert.equal(w.tm8.chats.length, 2)
      assert.ok(w.tm8.chats[1].body.length < 9000)
      assert.match(w.wa.sent.at(-1)!.text, /new main chat self-main-2 is up/)
    })
  })
  test('main chat briefing puts the WhatsApp reply rule first; the reply-rule re-brief has it and no token', async () => {
    const t = await withMain()
    const brief = t.tm8.chats[0].body
    const rule = brief.indexOf('RULE 1: every reply goes to WhatsApp')
    assert.ok(rule > 0 && rule < brief.indexOf('## How it works'))
    for (const s of ['Turn without one', 'Before ending a turn', 'Write nothing for people in tm8', 'POST /say', '"reply_to": "<wa_msg_id>"']) assert.ok(brief.includes(s), s)
    const re = rebriefReplyRule({ cfg: t.cfg, ch: t.ch, name: 'self-main' })
    for (const s of ['RULE 1: every reply goes to WhatsApp', 'unchanged', t.cfg.http.publicUrl]) assert.ok(re.includes(s), s)
    assert.ok(!/wab_/.test(re))
    const withFile = rebriefReplyRule({ cfg: t.cfg, ch: t.ch, name: 'self-main', tokenFile: '/x/.wa-token' })
    assert.ok(withFile.includes('TOKEN=$(cat /x/.wa-token)'))
  })
  test('main chat briefing has RULE 2 (delegate by default) right after RULE 1; the delegate re-brief has it and no token', async () => {
    const t = await withMain()
    const brief = t.tm8.chats[0].body
    const r1 = brief.indexOf('RULE 1: every reply goes to WhatsApp')
    const r2 = brief.indexOf('RULE 2: delegate by default')
    assert.ok(r1 > 0 && r2 > r1 && r2 < brief.indexOf('## How it works'))
    for (const s of ['NEW worker session', "that task's worker session", 'When in doubt, delegate.']) assert.ok(brief.includes(s), s)
    // F+G: one reused --mutation-id per task, look for a session before retrying, code work starts in a worktree.
    for (const s of ['ONE --mutation-id for the task', 'same id on every retry', 'before any retry, look for a session on the task',
      '--sections connections', '--launch-project <project id>', '--workdir worktree']) assert.ok(brief.includes(s), s)
    const re = rebriefDelegateRule({ cfg: t.cfg, ch: t.ch, name: 'self-main' })
    assert.ok(re.includes('ONE --mutation-id for the task') && re.includes('--workdir worktree'))
    for (const s of ['RULE 2: delegate by default', 'RULE 1', 'unchanged', t.cfg.http.publicUrl]) assert.ok(re.includes(s), s)
    assert.ok(!/wab_/.test(re))
  })
})

describe('channel style', () => {
  test('config: style is optional, one line, trimmed, capped', () => {
    const load = (style: unknown) => parseConfig({ ownerJids: [OWNER], channels: [{ id: 'g', jid: '1@g.us', title: 'G', style }] }, '/r').channels[0]
    assert.equal(load(undefined).style, undefined)
    assert.ok(!('style' in load(null)))
    assert.equal(load('  casual & short  ').style, 'casual & short')
    assert.throws(() => load(''), /style must be a non-empty string/)
    assert.throws(() => load(3), /style must be a non-empty string/)
    assert.throws(() => load('a\nb'), /style must be one line/)
    assert.throws(() => load('x'.repeat(301)), /at most 300/)
  })
  test('every inbound envelope carries [style: …], and the briefings say it', async () => {
    const t = await withMain()
    const ch = t.cfg.channels[1]
    ch.style = 'casual & short'
    await t.bridge.ensureMainChat(ch)
    assert.match(t.tm8.chats.at(-1)!.body, /## Keep it short\n[^\n]*\n- Style: casual & short \(/)
    for (const text of ['@tm8 hi', '@tm8 again']) {
      await t.bridge.onInbound(inbound({ text, chatJid: GROUP, chatAltJid: null, fromMe: false, senderJid: '919999999999@s.whatsapp.net', senderAltJid: null, senderName: 'Rahul' }))
      assert.match(lastPost(t).body, /^\[whatsapp "Infra" · [^\n]*\]\n\[style: casual & short\]\n---\n/)
    }
    // A channel without style gets the default short style, on envelopes and in briefings.
    await t.bridge.onInbound(inbound({ text: '@tm8 plain' }))
    assert.ok(lastPost(t).body.includes(`[style: ${DEFAULT_STYLE}]`))
    assert.ok(briefMainChat({ cfg: t.cfg, ch: t.ch, name: 'self-main', tokenFile: '/t/x.token' }).includes(`- Style: ${DEFAULT_STYLE} (`))
    const name = { name: 'kind-falcon', title: 'Style rule', parent_name: 'infra-main' } as any
    const brief = briefSession({ cfg: t.cfg, ch, name, tokenFile: '/t/k.token' })
    assert.match(brief, /## Keep it short\n[\s\S]*casual & short/)
    assert.match(rebriefStyle({ cfg: t.cfg, ch, name: 'infra-main' }), /## Keep it short[\s\S]*casual & short[\s\S]*No reply to this update/)
  })
})
