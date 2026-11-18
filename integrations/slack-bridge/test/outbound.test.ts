// tm8 → Slack at the runtime boundary: send (mrkdwn, split, thread, voice), reactions, files out and in, the channel
// list, rate limits and error mapping, and the frames Slack has no use for.
import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, test } from 'node:test'
import type { ServerFrame } from '../src/runtime/protocol.js'
import { CONN, rig, seed, sleep, type Rig } from './harness.js'

let r: Rig
beforeEach(async () => {
  r = await rig()
  seed(r.slack)
  await r.start()
  await r.connect()
})
afterEach(() => r.stop())

let n = 0
type Send = Extract<ServerFrame, { type: 'send' }>
async function send(o: Partial<Send>): Promise<any> {
  const outboxId = `o-${++n}`
  r.tm8.push({ type: 'send', outboxId, connectionId: CONN, conversationId: 'C1', ...o } as Send)
  return r.tm8.waitFor('sent', (f) => f.outboxId === outboxId)
}
async function react(target: string, emoji: string, conversationId = 'C1'): Promise<any> {
  const outboxId = `r-${++n}`
  r.tm8.push({ type: 'react', outboxId, connectionId: CONN, conversationId, emoji, target: { externalMessageId: target, senderExternalId: 'U1', fromMe: false } })
  return r.tm8.waitFor('sent', (f) => f.outboxId === outboxId)
}

describe('send', () => {
  test('markdown goes out as mrkdwn, in the thread, in the author\'s voice; sent carries Slack\'s ts', async () => {
    const root = r.slack.ts()
    const sent = await send({ text: '## Found it\nThe **CSP header** blocks the *new* font CDN: see [PR #812](https://github.com/o/r/pull/812).\n- `font-src` misses it', threadTs: root, voice: { username: 'brave-otter', iconUrl: 'https://tm8.example/avatars/brave-otter.png' } })
    const [m] = r.slack.messages
    assert.equal(m!.text, '*Found it*\nThe *CSP header* blocks the _new_ font CDN: see <https://github.com/o/r/pull/812|PR #812>.\n• `font-src` misses it')
    assert.equal(m!.thread_ts, root)
    assert.equal(m!.username, 'brave-otter')
    assert.equal(m!.icon_url, 'https://tm8.example/avatars/brave-otter.png')
    assert.equal(sent.externalMessageId, m!.ts)
    assert.deepEqual(sent.message, { channel: 'C1', ts: m!.ts, threadTs: root, parts: [m!.ts] })
    assert.equal(sent.failed, undefined)
  })

  test('without a voice, the app\'s own name; a non-https icon is not sent; no tm8 prefix is added', async () => {
    await send({ text: 'plain' })
    await send({ text: 'voiced', voice: { username: 'calm-heron', iconUrl: 'http://insecure/x.png', iconEmoji: ':robot_face:' } })
    const [a, b] = r.slack.messages
    assert.equal(a!.text, 'plain')
    assert.equal(a!.username, undefined)
    assert.equal(b!.username, 'calm-heron')
    assert.equal(b!.icon_url, undefined)
    assert.equal(b!.icon_emoji, ':robot_face:')
  })

  test('a long reply is split near 3,500 chars; sent answers the first part\'s ts', async () => {
    const para = (i: number) => `Paragraph ${i}: ` + 'lorem ipsum dolor sit amet '.repeat(40)
    const text = Array.from({ length: 8 }, (_, i) => para(i)).join('\n\n')
    const sent = await send({ text, threadTs: r.slack.ts() })
    assert.ok(r.slack.messages.length >= 3)
    for (const m of r.slack.messages) assert.ok(m.text.length <= 3500, `part of ${m.text.length}`)
    assert.equal(sent.externalMessageId, r.slack.messages[0]!.ts)
    assert.deepEqual(sent.message.parts, r.slack.messages.map((m) => m.ts))
    assert.ok(r.slack.messages.every((m) => m.thread_ts === r.slack.messages[0]!.thread_ts))
    assert.equal(r.slack.messages.map((m) => m.text).join(' ').replace(/\s+/g, ' ').trim(), text.replace(/\s+/g, ' ').trim())
  })

  test('a 429 on a later part is waited out (Retry-After) and the part still goes', async () => {
    const text = 'a '.repeat(1500) + '\n\n' + 'b '.repeat(1500)
    const outboxId = `o-${++n}`
    // Let the first part through, then rate-limit the second once.
    r.tm8.push({ type: 'send', outboxId, connectionId: CONN, conversationId: 'C1', text })
    while (r.slack.callsOf('chat.postMessage').length === 0) await sleep(2)
    r.slack.rateLimit('chat.postMessage', 1, 1)
    const sent = await r.tm8.waitFor('sent', (f) => f.outboxId === outboxId, 8000)
    assert.equal(sent.message.parts.length, 2)
    assert.equal(r.slack.callsOf('chat.postMessage').length, 3)
  })

  test('a slash command\'s cmd: id is never a thread: the answer goes to the channel', async () => {
    await send({ text: 'Started brave-otter', threadTs: 'cmd:123.456.abc', replyTo: { externalMessageId: 'cmd:123.456.abc', senderExternalId: 'U1', fromMe: false } })
    assert.equal(r.slack.messages[0]!.thread_ts, undefined)
  })

  test('a 429 settles as retryable with Slack\'s Retry-After', async () => {
    r.slack.rateLimit('chat.postMessage', 1, 7)
    const sent = await send({ text: 'hi' })
    assert.deepEqual(sent.failed, { reason: 'ratelimited', retryable: true, retryAfterSec: 7 })
  })

  test('Slack errors map to retryable or not', async () => {
    r.slack.fail('chat.postMessage', 'internal_error')
    assert.deepEqual((await send({ text: 'x' })).failed, { reason: 'internal_error', retryable: true })
    r.slack.fail('chat.postMessage', 'msg_too_long')
    assert.deepEqual((await send({ text: 'x' })).failed, { reason: 'msg_too_long', retryable: false })
    assert.deepEqual((await send({ text: '   ' })).failed, { reason: 'empty_message', retryable: false })
    assert.deepEqual((await send({ poll: { name: 'lunch?', values: ['a', 'b'], selectableCount: 1 } })).failed, { reason: 'polls_unsupported', retryable: false })
  })

  test('not_in_channel fails the row and tells the server the channel cannot be posted to', async () => {
    r.slack.channels.get('C1')!.member = false
    const sent = await send({ text: 'x' })
    assert.deepEqual(sent.failed, { reason: 'not_in_channel', retryable: false })
    const s = await r.tm8.waitFor('conversation-state')
    assert.deepEqual(s, { connectionId: CONN, conversationId: 'C1', canSend: false, reason: 'not_a_member' })
  })

  test('the guard refuses an unconnected channel without calling Slack, and counts it', async () => {
    const sent = await send({ conversationId: 'C2', text: 'leak' })
    assert.deepEqual(sent.failed, { reason: 'not_connected', retryable: false })
    assert.equal(r.slack.callsOf('chat.postMessage').length, 0)
    assert.equal(r.runtime.heartbeatFrame().connections[0]!.dropped.outboundRefused, 1)
  })

  test('an unknown connection settles unknown_connection', async () => {
    r.tm8.push({ type: 'send', outboxId: 'o-x', connectionId: '01a1eddf-0000-7000-8000-00000000ffff', conversationId: 'C1', text: 'x' })
    assert.deepEqual((await r.tm8.waitFor('sent', (f) => f.outboxId === 'o-x')).failed, { reason: 'unknown_connection', retryable: false })
  })

  test('a replayed send of the same outbox row posts once', async () => {
    r.tm8.push({ type: 'send', outboxId: 'o-dup', connectionId: CONN, conversationId: 'C1', text: 'once' })
    r.tm8.push({ type: 'send', outboxId: 'o-dup', connectionId: CONN, conversationId: 'C1', text: 'once' })
    await r.tm8.waitFor('sent', (f) => f.outboxId === 'o-dup')
    await sleep(60)
    assert.equal(r.slack.messages.length, 1)
    assert.equal(r.tm8.of('sent').filter((f) => f.outboxId === 'o-dup').length, 2) // the replay gets the receipt again
  })
})

describe('react', () => {
  test('📨 then 👀 then ✅: each replaces the runtime\'s previous reaction on that message', async () => {
    const target = r.slack.ts()
    const a = await react(target, '📨')
    await react(target, '👀')
    await react(target, '✅')
    assert.equal(a.externalMessageId, `reaction:${target}:incoming_envelope`)
    assert.deepEqual(r.slack.reactions.map((x) => [x.name, !!x.removed]), [['incoming_envelope', true], ['eyes', true], ['white_check_mark', false]])
    assert.deepEqual(r.slack.callsOf('reactions.add').map((c) => c.params), [
      { channel: 'C1', timestamp: target, name: 'incoming_envelope' }, { channel: 'C1', timestamp: target, name: 'eyes' }, { channel: 'C1', timestamp: target, name: 'white_check_mark' },
    ])
  })

  test('an empty emoji takes the runtime\'s reaction off; already_reacted is success', async () => {
    const target = r.slack.ts()
    await react(target, '👍')
    r.slack.fail('reactions.add', 'already_reacted')
    const again = await react(target, '🎉')
    assert.equal(again.failed, undefined)
    await react(target, '')
    assert.ok(r.slack.reactions.every((x) => x.removed || x.name !== '+1'))
  })

  test('a cmd: target is not_reactable without calling Slack; an unknown emoji is refused', async () => {
    assert.deepEqual((await react('cmd:123.456.abc', '👀')).failed, { reason: 'not_reactable', retryable: false })
    assert.deepEqual((await react(r.slack.ts(), '🦩🦩')).failed, { reason: 'unknown_emoji', retryable: false })
    assert.equal(r.slack.callsOf('reactions.add').length, 0)
    assert.deepEqual((await react(r.slack.ts(), '👀', 'C2')).failed, { reason: 'not_connected', retryable: false })
  })
})

describe('files', () => {
  test('a file streams from tm8 to Slack\'s upload URL (no token on it) and lands in the thread', async () => {
    const bytes = Buffer.from('%PDF-1.7 a report '.repeat(500))
    r.tm8.media.set('file-entity-1', bytes)
    const root = r.slack.ts()
    const sent = await send({ threadTs: root, media: { kind: 'document', mime: 'application/pdf', fileName: 'report.pdf', caption: 'The **report**', fileEntityId: 'file-entity-1' } })
    const [up] = r.slack.callsOf('files.getUploadURLExternal')
    assert.deepEqual(up!.params, { filename: 'report.pdf', length: String(bytes.length) })
    const [done] = r.slack.callsOf('files.completeUploadExternal')
    const fileId = JSON.parse(done!.params.files!)[0].id
    assert.ok(r.slack.uploaded(fileId)!.equals(bytes))
    assert.equal(done!.params.channel_id, 'C1')
    assert.equal(done!.params.thread_ts, root)
    assert.equal(done!.params.initial_comment, 'The *report*')
    assert.ok(r.slack.fileRequests.every((q) => q.authorization === null))
    const share = r.slack.messages.find((m) => m.params.file === fileId)!
    assert.equal(sent.externalMessageId, share.ts)
    assert.equal(sent.message.fileId, fileId)
  })

  test('with a voice, the file goes as the app and the caption follows as a voiced message in the thread', async () => {
    r.tm8.media.set('file-entity-2', Buffer.from('png-bytes'))
    const root = r.slack.ts()
    const sent = await send({ threadTs: root, voice: { username: 'brave-otter', iconUrl: 'https://tm8.example/a.png' }, media: { kind: 'image', mime: 'image/png', fileName: 'shot.png', caption: 'Here is the _diff_', fileEntityId: 'file-entity-2' } })
    const [done] = r.slack.callsOf('files.completeUploadExternal')
    assert.equal(done!.params.initial_comment, undefined)
    const caption = r.slack.messages.find((m) => m.username === 'brave-otter')!
    assert.equal(caption.text, 'Here is the _diff_')
    assert.equal(caption.thread_ts, root)
    assert.equal(sent.message.captionTs, caption.ts)
  })

  test('base64 bytes from an older server still upload; an upload\'s late share is waited for', async () => {
    r.slack.shareDelayMs = 50
    const sent = await send({ media: { kind: 'image', mime: 'image/png', fileName: 'a.png', caption: '', data: Buffer.from('abc').toString('base64') } })
    assert.match(sent.externalMessageId, /^\d+\.\d+$/)
    assert.ok(r.slack.callsOf('files.info').length >= 1)
  })

  test('an attachment tm8 refuses (404) fails for good and nothing reaches Slack', async () => {
    const sent = await send({ media: { kind: 'document', mime: 'text/plain', fileName: 'x.txt', caption: '', fileEntityId: 'missing' } })
    assert.deepEqual(sent.failed, { reason: 'attachment download failed: HTTP 404', retryable: false })
    assert.equal(r.slack.callsOf('files.getUploadURLExternal').length, 0)
  })

  test('media.fetch reads url_private with the bot token, within maxBytes, only for files in that channel', async () => {
    const f = r.slack.file({ name: 'shot.png', mimetype: 'image/png', bytes: Buffer.from('PNGDATA'), channels: ['C1'] })
    const elsewhere = r.slack.file({ name: 'other.png', mimetype: 'image/png', bytes: Buffer.from('NOPE'), channels: ['C2'] })
    const ask = (handle: string, maxBytes = 1000, requestId = `m-${++n}`) => {
      r.tm8.push({ type: 'media.fetch', requestId, connectionId: CONN, conversationId: 'C1', handle, maxBytes })
      return r.tm8.waitFor('media', (x) => x.requestId === requestId)
    }
    const ok = await ask(f.id)
    assert.equal(ok.mime, 'image/png')
    assert.equal(Buffer.from(ok.data, 'base64').toString(), 'PNGDATA')
    assert.equal(r.slack.fileRequests.at(-1)!.authorization, `Bearer ${r.slack.botToken}`)
    const big = await ask(f.id, 3)
    assert.equal(big.tooLarge, true)
    const off = await ask(elsewhere.id)
    assert.match(off.error, /not a connected conversation/)
    const forged = await ask('../../etc/passwd')
    assert.match(forged.error, /not a connected conversation/)
    // Neither the elsewhere file nor the forged handle reached a download.
    assert.equal(r.slack.fileRequests.filter((q) => q.path.includes(elsewhere.id)).length, 0)
  })
})

describe('channels and the rest', () => {
  test('conversation.list answers the bot\'s channels, public and private, across pages, sorted', async () => {
    r.slack.channel({ id: 'C5', name: 'alpha', members: 3 })
    r.slack.channel({ id: 'C6', name: 'not-in', member: false })
    r.slack.channel({ id: 'C8', name: 'old', archived: true })
    r.tm8.push({ type: 'conversation.list', requestId: 'q1', connectionId: CONN })
    const f = await r.tm8.waitFor('conversations', (x) => x.requestId === 'q1')
    assert.deepEqual(f.items, [
      { conversationId: 'C5', kind: 'channel', name: 'alpha', size: 3, canSend: true, reason: null },
      { conversationId: 'C1', kind: 'channel', name: 'eng', size: 12, canSend: true, reason: null },
      { conversationId: 'C2', kind: 'channel', name: 'random', size: null, canSend: true, reason: null },
      { conversationId: 'G1', kind: 'private_channel', name: 'secret', size: null, canSend: true, reason: null },
    ])
    assert.ok(r.slack.callsOf('users.conversations').length >= 2)
    assert.equal(r.slack.callsOf('users.conversations')[0]!.params.types, 'public_channel,private_channel')
  })

  test('conversation.list errors answer an error frame', async () => {
    r.slack.fail('users.conversations', 'missing_scope', 1, 'groups:read')
    r.tm8.push({ type: 'conversation.list', requestId: 'q2', connectionId: CONN })
    assert.equal((await r.tm8.waitFor('conversations', (x) => x.requestId === 'q2')).error, 'missing_scope: groups:read')
  })

  test('typing and read are ignored; group.create and group.add answer an error', async () => {
    const calls = r.slack.calls.length
    r.tm8.push({ type: 'typing', connectionId: CONN, conversationId: 'C1', state: 'composing' })
    r.tm8.push({ type: 'read', connectionId: CONN, conversationId: 'C1', messages: [{ externalMessageId: '1.1', senderExternalId: 'U1' }] })
    r.tm8.push({ type: 'group.create', requestId: 'g1', connectionId: CONN, subject: 'x', participants: ['U1'] })
    r.tm8.push({ type: 'group.add', requestId: 'g2', connectionId: CONN, conversationId: 'C1', participants: ['U1'] })
    assert.match((await r.tm8.waitFor('group', (x) => x.requestId === 'g1')).error, /cannot create channels/)
    assert.ok((await r.tm8.waitFor('group', (x) => x.requestId === 'g2')).error)
    await sleep(40)
    assert.equal(r.slack.calls.length, calls)
  })
})
