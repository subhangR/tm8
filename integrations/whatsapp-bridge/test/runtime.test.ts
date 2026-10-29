// The WhatsApp connector runtime (B1a): the allowlist drop, the outbound guard, admins-only groups, the live group
// list, sealed keys and the protocol frames. Baileys is replaced by a fake socket; nothing here touches WhatsApp.
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, test } from 'node:test'
import type { UserFacingSocketConfig, WAMessage } from '@whiskeysockets/baileys'
import { Allowlist, OutboundRefused, bareJid } from '../src/runtime/allowlist.js'
import { RuntimeConnection, mediaHandle, type WaSocketLike } from '../src/runtime/connection.js'
import type { RuntimeFrames, RuntimeRoute, ServerFrame } from '../src/runtime/protocol.js'
import { Runtime, failure } from '../src/runtime/runtime.js'
import { seal, unseal, useSealedAuthState } from '../src/runtime/sealed-auth.js'

const G1 = '120363000000000001@g.us' // connected
const G2 = '120363000000000002@g.us' // not connected
const ME = '911111111111@s.whatsapp.net'
const ME_LID = '55555555555555@lid'
const ALICE = '922222222222@s.whatsapp.net'
const CONN = '01a189f1-0000-7000-8000-000000000001'
const KEY = crypto.randomBytes(32)

type Sent = { route: RuntimeRoute; frame: any }

class FakeSocket {
  ev = new EventEmitter()
  user = { id: '911111111111:7@s.whatsapp.net', lid: '55555555555555:7@lid' }
  calls: { fn: string; args: unknown[] }[] = []
  groups: Record<string, any> = {
    [G1]: { id: G1, subject: 'Infra', announce: false, participants: [{ id: ME_LID, phoneNumber: ME, admin: null }, { id: ALICE }] },
    [G2]: { id: G2, subject: 'Family', announce: false, participants: [{ id: ME, admin: null }] },
    'c@g.us': { id: 'c@g.us', subject: 'A community', isCommunity: true, participants: [{ id: ME }] },
  }
  config: UserFacingSocketConfig | null = null
  private n = 0
  private rec(fn: string, args: unknown[]) {
    this.calls.push({ fn, args })
  }
  sendMessage = async (...args: unknown[]) => {
    this.rec('sendMessage', args)
    return { key: { id: `OUT${++this.n}`, remoteJid: args[0] }, message: { conversation: 'x' } } as any
  }
  sendPresenceUpdate = async (...args: unknown[]) => this.rec('sendPresenceUpdate', args)
  readMessages = async (...args: unknown[]) => this.rec('readMessages', args)
  groupMetadata = async (jid: string) => {
    this.rec('groupMetadata', [jid])
    return this.groups[jid]
  }
  groupFetchAllParticipating = async () => {
    this.rec('groupFetchAllParticipating', [])
    return { ...this.groups }
  }
  requestPairingCode = async () => 'ABCD1234'
  logout = async () => this.rec('logout', [])
  end = () => this.rec('end', [])
  updateMediaMessage = async (m: unknown) => m as any
  open() {
    this.ev.emit('connection.update', { connection: 'open' })
  }
  /** Calls that reached WhatsApp for a conversation. */
  touched(jid: string) {
    return this.calls.filter((c) => c.args[0] === jid || (Array.isArray(c.args[0]) && (c.args[0] as any[]).some((k) => k?.remoteJid === jid)) || c.args[1] === jid)
  }
}

const tick = () => new Promise((r) => setImmediate(r))

async function connection(ids: string[] = [G1]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-rt-'))
  const sock = new FakeSocket()
  const emitted: Sent[] = []
  const conn = new RuntimeConnection(CONN, {
    authDir: dir,
    stateKey: KEY,
    authFlow: { kind: 'qr' },
    log: () => {},
    emit: async (route, frame) => void emitted.push({ route, frame }),
    socketFactory: (c) => {
      sock.config = c
      return sock as unknown as WaSocketLike
    },
  })
  conn.applyAllowlist({ version: 1, conversationIds: ids })
  await conn.start()
  sock.open()
  await tick()
  await tick()
  return { conn, sock, emitted, dir, of: (r: RuntimeRoute) => emitted.filter((e) => e.route === r).map((e) => e.frame) }
}

let seq = 0
function msg(chat: string, message: object, o: Partial<WAMessage['key']> & { pushName?: string } = {}): WAMessage {
  const { pushName, ...key } = o
  return { key: { remoteJid: chat, id: `M${++seq}`, fromMe: false, participant: chat.endsWith('@g.us') ? ALICE : undefined, ...key }, message, pushName: pushName ?? 'Alice', messageTimestamp: 1761780000 } as WAMessage
}

/** A message whose content throws if anything reads it: proves an off-list message is dropped on its key alone. */
function untouchable(chat: string): WAMessage {
  const m = { key: { remoteJid: chat, id: `X${++seq}`, fromMe: false, participant: ALICE }, messageTimestamp: 1 } as WAMessage
  for (const field of ['message', 'pushName']) {
    Object.defineProperty(m, field, { get: () => assert.fail(`read ${field} of a message from a conversation that is not connected`), enumerable: true })
  }
  return m
}

describe('allowlist', () => {
  test('allows nothing before the first list, then exactly the list', () => {
    const a = new Allowlist()
    assert.equal(a.allows(G1), false)
    a.apply({ version: 3, conversationIds: [G1] })
    assert.equal(a.allows(G1), true)
    assert.equal(a.allows(G2), false)
    assert.equal(a.allows(null, undefined), false)
  })

  test('a stale version is ignored; hello forces; removal is reported', () => {
    const a = new Allowlist()
    a.apply({ version: 5, conversationIds: [G1, G2] })
    assert.equal(a.apply({ version: 4, conversationIds: [] }).applied, false)
    assert.equal(a.allows(G2), true)
    const r = a.apply({ version: 6, conversationIds: [G1] })
    assert.deepEqual(r.removed, [G2])
    assert.equal(a.allows(G2), false)
    assert.equal(a.apply({ version: 1, conversationIds: [] }, true).applied, true)
    assert.equal(a.allows(G1), false)
  })

  test('device parts are stripped; a connected self chat matches under PN or LID', () => {
    assert.equal(bareJid('911111111111:7@s.whatsapp.net'), ME)
    assert.equal(bareJid('911111111111@c.us'), ME)
    const a = new Allowlist()
    a.own.add(ME).add(ME_LID)
    a.apply({ version: 1, conversationIds: [ME] })
    assert.equal(a.allows(ME_LID), true)
    assert.equal(a.allows('911111111111:3@s.whatsapp.net'), true)
  })

  test('shouldIgnoreJid: off-list stanzas are ignored and counted; the device\'s own JIDs never are', () => {
    const a = new Allowlist()
    a.own.add(ME).add(ME_LID)
    a.apply({ version: 1, conversationIds: [G1] })
    assert.equal(a.shouldIgnore(G1), false)
    assert.equal(a.shouldIgnore('911111111111:2@s.whatsapp.net'), false)
    assert.equal(a.shouldIgnore(ME_LID), false)
    assert.equal(a.shouldIgnore(G2), true)
    assert.equal(a.shouldIgnore(ALICE), true)
    assert.equal(a.shouldIgnore('status@broadcast'), true)
    assert.equal(a.dropped.stanzas, 3)
  })
})

describe('inbound: only connected conversations are forwarded (D28)', () => {
  test('the socket is configured to read and announce nothing beyond the list', async () => {
    const { sock, conn } = await connection()
    const c = sock.config!
    assert.equal(c.markOnlineOnConnect, false)
    assert.equal(c.syncFullHistory, false)
    assert.equal(c.emitOwnEvents, false)
    assert.equal(c.shouldSyncHistoryMessage!({} as any), false)
    assert.equal(c.shouldIgnoreJid, conn.allowlist.shouldIgnore)
    assert.equal(c.shouldIgnoreJid!(G2), true)
  })

  test('a message, a poll update and a DM from off the list are dropped unread, counted, never forwarded', async () => {
    const { sock, of, conn } = await connection()
    sock.ev.emit('messages.upsert', { type: 'notify', messages: [untouchable(G2), untouchable(ALICE), untouchable('status@broadcast')] })
    await tick()
    assert.deepEqual(of('inbound'), [])
    assert.equal(conn.allowlist.dropped.messages, 3)
    // No receipt, no read, no typing, nothing at all went to those chats.
    assert.deepEqual(sock.touched(G2), [])
    assert.deepEqual(sock.touched(ALICE), [])
  })

  test('a connected group\'s text arrives as an inbound frame', async () => {
    const { sock, of } = await connection()
    sock.ev.emit('messages.upsert', {
      type: 'notify',
      messages: [msg(G1, { extendedTextMessage: { text: '@tm8 is the deploy done?', contextInfo: { stanzaId: 'Q1', participant: ME, mentionedJid: ['55555555555555:7@lid'] } } }, { participantAlt: '922222222222:1@s.whatsapp.net' })],
    })
    await tick()
    const [f] = of('inbound')
    assert.equal(f.connectionId, CONN)
    assert.equal(f.conversationId, G1)
    assert.equal(f.body, '@tm8 is the deploy done?')
    assert.equal(f.kind, 'text')
    assert.deepEqual(f.sender, { externalId: ALICE, altId: ALICE, name: 'Alice', fromMe: false })
    assert.deepEqual(f.replyTo, { externalMessageId: 'Q1', senderExternalId: ME, media: null })
    assert.deepEqual(f.mentions, [ME_LID])
    assert.equal(f.ts, 1761780000)
    assert.equal('echo' in f, false)
  })

  test('a reaction and media in a connected group carry their parts; media gets a fetch handle', async () => {
    const { sock, of } = await connection()
    sock.ev.emit('messages.upsert', {
      type: 'notify',
      messages: [
        msg(G1, { reactionMessage: { key: { id: 'OUT9', remoteJid: G1 }, text: '👍' } }),
        msg(G1, { imageMessage: { mimetype: 'image/png', caption: 'look', fileLength: 10, mediaKey: Buffer.from('k') } }),
      ],
    })
    await tick()
    const [r, m] = of('inbound')
    assert.deepEqual(r.reaction, { externalMessageId: 'OUT9', emoji: '👍' })
    assert.equal(m.kind, 'media')
    assert.equal(m.media[0].kind, 'image')
    assert.equal(m.media[0].caption, 'look')
    assert.equal(typeof m.media[0].handle, 'string')
  })

  test('a poll vote from a connected group is forwarded sealed when the poll is not held', async () => {
    const { sock, of } = await connection()
    sock.ev.emit('messages.upsert', {
      type: 'notify',
      messages: [msg(G1, { pollUpdateMessage: { pollCreationMessageKey: { id: 'POLL1' }, vote: { encPayload: Buffer.from('p'), encIv: Buffer.from('i') } } })],
    })
    await tick()
    const [f] = of('inbound')
    assert.equal(f.kind, 'poll')
    assert.deepEqual(f.pollVote, { pollMessageId: 'POLL1', voterIds: [ALICE], sealed: { encPayload: 'cA==', encIv: 'aQ==' } })
  })

  test('pausing a group takes it off the list at once: its next message is dropped', async () => {
    const { conn, sock, of } = await connection([G1, G2])
    conn.applyAllowlist({ version: 2, conversationIds: [G2] })
    sock.ev.emit('messages.upsert', { type: 'notify', messages: [untouchable(G1)] })
    await tick()
    assert.deepEqual(of('inbound'), [])
  })

  test('an unconnected self chat is dropped; a connected one arrives under either own JID', async () => {
    const off = await connection([G1])
    off.sock.ev.emit('messages.upsert', { type: 'notify', messages: [untouchable(ME_LID)] })
    await tick()
    assert.deepEqual(off.of('inbound'), [])
    const on = await connection([ME])
    on.sock.ev.emit('messages.upsert', { type: 'notify', messages: [msg(ME_LID, { conversation: '/help' }, { fromMe: true, remoteJidAlt: ME })] })
    await tick()
    assert.equal(on.of('inbound')[0].conversationId, ME)
    assert.equal(on.of('inbound')[0].sender.fromMe, true)
  })
})

describe('outbound guard (D28)', () => {
  const frames = (to: string): ServerFrame[] => [
    { type: 'send', outboxId: 'o1', connectionId: CONN, conversationId: to, text: 'hi' },
    { type: 'send', outboxId: 'o2', connectionId: CONN, conversationId: to, media: { kind: 'image', mime: 'image/png', fileName: 'a.png', caption: '', data: 'AA==' } },
    { type: 'send', outboxId: 'o3', connectionId: CONN, conversationId: to, poll: { name: 'q', values: ['a', 'b'], selectableCount: 1 } },
    { type: 'react', outboxId: 'o4', connectionId: CONN, conversationId: to, target: { externalMessageId: 'M1', senderExternalId: ALICE, fromMe: false }, emoji: '👀' },
    { type: 'typing', connectionId: CONN, conversationId: to, state: 'composing' },
    { type: 'read', connectionId: CONN, conversationId: to, messages: [{ externalMessageId: 'M1', senderExternalId: ALICE }] },
  ]

  async function run(conn: RuntimeConnection, f: ServerFrame) {
    switch (f.type) {
      case 'send':
        return conn.send(f)
      case 'react':
        return conn.react(f)
      case 'typing':
        return conn.typing(f)
      case 'read':
        return conn.read(f)
    }
  }

  test('text, media, polls, reactions, typing and read receipts to an unconnected chat are refused before the socket', async () => {
    const { conn, sock } = await connection()
    for (const to of [G2, ALICE]) {
      for (const f of frames(to)) await assert.rejects(run(conn, f), (e) => e instanceof OutboundRefused && e.reason === 'not_connected', f.type)
      assert.deepEqual(sock.touched(to), [])
    }
    assert.equal(conn.allowlist.dropped.outboundRefused, 12)
  })

  test('the same frames to a connected group go out', async () => {
    const { conn, sock } = await connection()
    for (const f of frames(G1)) await run(conn, f)
    const fns = sock.touched(G1).map((c) => c.fn)
    assert.deepEqual(fns.filter((f) => f !== 'groupMetadata'), ['sendMessage', 'sendMessage', 'sendMessage', 'sendMessage', 'sendPresenceUpdate', 'readMessages'])
  })

  test('a media handle forged to point at another chat is refused', async () => {
    const { conn } = await connection([G1, G2])
    conn.applyAllowlist({ version: 2, conversationIds: [G1] })
    const handle = mediaHandle({ remoteJid: G2, id: 'M1' }, { imageMessage: {} })
    await assert.rejects(conn.fetchMedia({ type: 'media.fetch', requestId: 'r', connectionId: CONN, conversationId: G1, handle, maxBytes: 1000 }), OutboundRefused)
    await assert.rejects(conn.fetchMedia({ type: 'media.fetch', requestId: 'r', connectionId: CONN, conversationId: G2, handle, maxBytes: 1000 }), OutboundRefused)
  })
})

describe('admins-only groups', () => {
  test('a group only admins post in is reported once and refuses posts but not reactions or receipts', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-rt-'))
    const sock = new FakeSocket()
    sock.groups[G1].announce = true
    const emitted: Sent[] = []
    const conn = new RuntimeConnection(CONN, { authDir: dir, stateKey: KEY, authFlow: { kind: 'qr' }, log: () => {}, emit: async (route, frame) => void emitted.push({ route, frame }), socketFactory: () => sock as unknown as WaSocketLike })
    conn.applyAllowlist({ version: 1, conversationIds: [G1] })
    await conn.start()
    sock.open()
    await tick()
    await tick()
    const states = emitted.filter((e) => e.route === 'conversation-state').map((e) => e.frame)
    assert.deepEqual(states, [{ connectionId: CONN, conversationId: G1, canSend: false, reason: 'admins_only' }])
    await assert.rejects(conn.send({ type: 'send', outboxId: 'o', connectionId: CONN, conversationId: G1, text: 'hi' }), (e) => e instanceof OutboundRefused && e.reason === 'admins_only')
    await conn.react({ type: 'react', outboxId: 'o', connectionId: CONN, conversationId: G1, target: { externalMessageId: 'M1', senderExternalId: ALICE, fromMe: false }, emoji: '👍' })
    await conn.read({ type: 'read', connectionId: CONN, conversationId: G1, messages: [{ externalMessageId: 'M1', senderExternalId: ALICE }] })

    // Promoted to admin: posting comes back, and the server hears it.
    sock.groups[G1].participants[0].admin = 'admin'
    sock.ev.emit('group-participants.update', { id: G1, author: ALICE, participants: [{ id: ME_LID }], action: 'promote' })
    await tick()
    await tick()
    assert.deepEqual(emitted.filter((e) => e.route === 'conversation-state').at(-1)!.frame, { connectionId: CONN, conversationId: G1, canSend: true, reason: null })
    await conn.send({ type: 'send', outboxId: 'o', connectionId: CONN, conversationId: G1, text: 'hi' })
  })

  test('posting rights are only looked up for connected groups', async () => {
    const { sock } = await connection([G1])
    sock.ev.emit('groups.update', [{ id: G2, announce: true }])
    await tick()
    assert.deepEqual(sock.touched(G2), [])
  })
})

describe('the live group list', () => {
  test('lists groups with posting rights and the self chat, skips communities, stores nothing', async () => {
    const { conn, sock, dir } = await connection()
    sock.groups[G2].announce = true
    const items = await conn.listConversations()
    assert.deepEqual(items.map((i) => [i.conversationId, i.kind, i.canSend, i.reason]), [
      [ME, 'self', true, null],
      [G2, 'group', false, 'admins_only'],
      [G1, 'group', true, null],
    ])
    for (const f of fs.readdirSync(dir)) assert.match(f, /\.seal$/, `only sealed key files on disk, found ${f}`)
  })
})

describe('sealed keys', () => {
  test('round-trips, holds no plaintext, refuses the wrong key', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-seal-'))
    const a = await useSealedAuthState(dir, KEY)
    await a.saveCreds()
    await a.state.keys.set({ 'pre-key': { '1': { public: Buffer.from('pub'), private: Buffer.from('SECRET-PRIVATE') } } })
    for (const f of fs.readdirSync(dir)) {
      const raw = fs.readFileSync(path.join(dir, f))
      assert.equal(raw.includes('SECRET'), false)
      assert.equal(raw.includes('noiseKey'), false)
      assert.equal(fs.statSync(path.join(dir, f)).mode & 0o077, 0)
    }
    assert.equal(fs.statSync(dir).mode & 0o077, 0)
    const b = await useSealedAuthState(dir, KEY)
    assert.deepEqual(b.state.creds.noiseKey, a.state.creds.noiseKey)
    const got = await b.state.keys.get('pre-key', ['1'])
    assert.equal(Buffer.from(got['1']!.private).toString(), 'SECRET-PRIVATE')
    await assert.rejects(useSealedAuthState(dir, crypto.randomBytes(32)))
    assert.throws(() => unseal(crypto.randomBytes(32), seal(KEY, Buffer.from('x'))))
    await b.wipe()
    assert.deepEqual(fs.readdirSync(dir), [])
  })
})

describe('runtime', () => {
  function runtime(reply: unknown) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-rtm-'))
    const posts: Sent[] = []
    const socks: FakeSocket[] = []
    const allowAtStart: boolean[] = []
    const rt = new Runtime({
      runtimeId: 'wa-test',
      dataDir: dir,
      log: () => {},
      link: { post: async <R extends RuntimeRoute>(route: R, frame: RuntimeFrames[R]) => (posts.push({ route, frame }), route === 'hello' ? reply : null) },
      socketFactory: (c) => {
        // The allowlist is in place before the socket exists: nothing can be read before it is known.
        allowAtStart.push(c.shouldIgnoreJid!(G1) === false)
        const s = new FakeSocket()
        socks.push(s)
        return s as unknown as WaSocketLike
      },
    })
    return { rt, posts, socks, allowAtStart, dir }
  }
  const k = KEY.toString('base64')

  test('hello applies each connection\'s allowlist before its socket starts; both numbers run on one runtime', async () => {
    const CONN2 = '01a189f1-0000-7000-8000-000000000002'
    const { rt, posts, socks, allowAtStart } = runtime({
      connections: [
        { connectionId: CONN, stateKey: k, allowlist: { type: 'allowlist', connectionId: CONN, version: 1, conversationIds: [G1] } },
        { connectionId: CONN2, stateKey: k, allowlist: { type: 'allowlist', connectionId: CONN2, version: 1, conversationIds: [G1] } },
      ],
    })
    // Registered creds are needed to start without an auth flow: seed them sealed, as a real link would have left them.
    for (const id of [CONN, CONN2]) {
      const s = await useSealedAuthState(path.join((rt as any).o.dataDir, 'bridges', id), KEY)
      s.state.creds.registered = true
      await s.saveCreds()
    }
    await rt.hello()
    assert.equal(posts[0]!.route, 'hello')
    assert.equal(posts[0]!.frame.provider, 'whatsapp')
    assert.equal(socks.length, 2)
    assert.deepEqual(allowAtStart, [true, true])
    assert.equal(rt.connections.size, 2)
  })

  test('a send to an unconnected chat settles failed_permanent not_connected and never reaches WhatsApp', async () => {
    const { rt, posts, socks } = runtime({ connections: [] })
    await rt.onFrame({ type: 'connect', connectionId: CONN, stateKey: k, authFlow: { kind: 'qr' }, allowlist: { type: 'allowlist', connectionId: CONN, version: 1, conversationIds: [G1] } })
    socks[0]!.open()
    await tick()
    await rt.onFrame({ type: 'send', outboxId: 'ob1', connectionId: CONN, conversationId: G2, text: 'leak?' })
    await rt.onFrame({ type: 'send', outboxId: 'ob2', connectionId: CONN, conversationId: G1, text: 'hi' })
    const sent = posts.filter((p) => p.route === 'sent').map((p) => p.frame)
    assert.deepEqual(sent[0], { outboxId: 'ob1', connectionId: CONN, failed: { reason: 'not_connected', retryable: false } })
    assert.equal(sent[1].externalMessageId, 'OUT1')
    assert.deepEqual(socks[0]!.touched(G2), [])
  })

  test('an allowlist frame replaces the list; a stale one does not', async () => {
    const { rt, socks } = runtime({ connections: [] })
    await rt.onFrame({ type: 'connect', connectionId: CONN, stateKey: k, authFlow: { kind: 'qr' }, allowlist: { type: 'allowlist', connectionId: CONN, version: 5, conversationIds: [G1] } })
    socks[0]!.open()
    await rt.onFrame({ type: 'allowlist', connectionId: CONN, version: 6, conversationIds: [] })
    await rt.onFrame({ type: 'allowlist', connectionId: CONN, version: 4, conversationIds: [G1] })
    assert.equal(rt.connections.get(CONN)!.allowlist.allows(G1), false)
  })

  test('the QR goes to the server as an auth frame and is never written to disk', async () => {
    const { rt, posts, socks, dir } = runtime({ connections: [] })
    await rt.onFrame({ type: 'connect', connectionId: CONN, stateKey: k, authFlow: { kind: 'qr' } })
    socks[0]!.ev.emit('connection.update', { qr: '2@abc,def,ghi' })
    for (let i = 0; i < 100 && !posts.some((p) => p.route === 'auth'); i++) await new Promise((r) => setTimeout(r, 50))
    const auth = posts.find((p) => p.route === 'auth')!.frame
    assert.equal(auth.connectionId, CONN)
    assert.ok(Buffer.from(auth.qrPng, 'base64').subarray(1, 4).equals(Buffer.from('PNG')))
    const files = fs.readdirSync(dir, { recursive: true }).map(String)
    assert.equal(files.some((f) => /qr|pairing/i.test(f)), false)
  })

  test('the heartbeat carries status and counters only', async () => {
    const { rt, socks } = runtime({ connections: [] })
    await rt.onFrame({ type: 'connect', connectionId: CONN, stateKey: k, authFlow: { kind: 'qr' }, allowlist: { type: 'allowlist', connectionId: CONN, version: 2, conversationIds: [G1] } })
    socks[0]!.open()
    socks[0]!.ev.emit('messages.upsert', { type: 'notify', messages: [untouchable(G2)] })
    await tick()
    const hb = rt.heartbeatFrame()
    assert.deepEqual(hb.connections, [{ connectionId: CONN, status: 'linked', dropped: { stanzas: 0, messages: 1, outboundRefused: 0 }, allowlistVersion: 2 }])
  })

  test('conversation.list and unknown connections answer instead of hanging', async () => {
    const { rt, posts, socks } = runtime({ connections: [] })
    await rt.onFrame({ type: 'conversation.list', requestId: 'r1', connectionId: CONN })
    await rt.onFrame({ type: 'send', outboxId: 'ob', connectionId: CONN, conversationId: G1, text: 'x' })
    assert.deepEqual(posts.map((p) => p.frame), [
      { requestId: 'r1', connectionId: CONN, error: 'unknown_connection' },
      { outboxId: 'ob', connectionId: CONN, failed: { reason: 'unknown_connection', retryable: false } },
    ])
    await rt.onFrame({ type: 'connect', connectionId: CONN, stateKey: k, authFlow: { kind: 'qr' }, allowlist: { type: 'allowlist', connectionId: CONN, version: 1, conversationIds: [G1] } })
    socks[0]!.open()
    await tick()
    await rt.onFrame({ type: 'conversation.list', requestId: 'r2', connectionId: CONN })
    assert.equal(posts.find((p) => p.route === 'conversations' && p.frame.requestId === 'r2')!.frame.items.length, 3)
  })

  test('a connection id that is not a uuid is refused (it names a directory)', async () => {
    const { rt } = runtime({ connections: [] })
    await assert.rejects(rt.onFrame({ type: 'connect', connectionId: '../../etc', stateKey: k }))
  })

  test('failures map to the outbox words', () => {
    assert.deepEqual(failure(new OutboundRefused('admins_only', G1, 'text')), { reason: 'admins_only', retryable: false })
    assert.deepEqual(failure(new Error('WhatsApp is not connected')), { reason: 'whatsapp_unavailable', retryable: true })
  })
})

describe('server link', () => {
  test('frames go up as POST /v2/bridge-runtime/<route> with the bearer; 5xx is retried, 4xx is not', async () => {
    const http = await import('node:http')
    const { HttpWsLink } = await import('../src/runtime/link.js')
    const seen: { url: string; auth: string; body: string }[] = []
    let fail503 = 1
    const server = http.createServer((req, res) => {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        seen.push({ url: req.url!, auth: req.headers.authorization ?? '', body })
        if (req.url!.endsWith('/state') && fail503-- > 0) return void res.writeHead(503).end('busy')
        if (req.url!.endsWith('/inbound')) return void res.writeHead(400).end('{"error":"invalid_input"}')
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"connections":[]}')
      })
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as { port: number }).port
    const link = new HttpWsLink({ serverUrl: `http://127.0.0.1:${port}`, runtimeId: 'wa-test', token: () => 'tok', log: () => {}, onOpen: async () => {}, onFrame: async () => {} })
    try {
      assert.deepEqual(await link.post('hello', { provider: 'whatsapp', version: 1, runtimeId: 'wa-test', capabilities: {} as any }), { connections: [] })
      await link.post('state', { connectionId: CONN, status: 'linked', detail: null })
      await assert.rejects(link.post('inbound', { connectionId: CONN } as any))
      assert.deepEqual(seen.map((s) => s.url), ['/v2/bridge-runtime/hello', '/v2/bridge-runtime/state', '/v2/bridge-runtime/state', '/v2/bridge-runtime/inbound'])
      assert.ok(seen.every((s) => s.auth === 'Bearer tok'))
    } finally {
      server.close()
    }
  })
})
