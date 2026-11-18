// Slack → tm8 at the runtime boundary: the allowlist drop, messages, mentions, threads, files, reactions, edits,
// deletes, bots, slash commands and channel state.
import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { CONN, rig, seed, sleep, type Rig } from './harness.js'

let r: Rig
beforeEach(async () => {
  r = await rig()
  seed(r.slack)
  await r.start()
  await r.connect()
})
afterEach(() => r.stop())

/** Pushes an event, waits for its ack, and gives the runtime a moment to post (or not). */
async function deliver(event: Record<string, unknown>, o: { eventId?: string } = {}) {
  await r.slack.waitForAck(r.slack.event(event, o))
  await sleep(40)
}

const inbound = () => r.tm8.of('inbound')
/** Waits until at least n inbound frames arrived (sender lookups take a moment), then settles briefly for extras. */
async function got(n: number): Promise<any[]> {
  const end = Date.now() + 5000
  while (inbound().length < n && Date.now() < end) await sleep(10)
  await sleep(40)
  return inbound()
}

describe('the allowlist guard (D28)', () => {
  test('a message from an unconnected channel is acked, counted and never forwarded', async () => {
    await deliver({ type: 'message', channel: 'C2', user: 'U1', text: 'not for tm8', ts: r.slack.ts() })
    await deliver({ type: 'app_mention', channel: 'C2', user: 'U1', text: '<@U0BOT> hi', ts: r.slack.ts() })
    await deliver({ type: 'reaction_added', user: 'U1', reaction: 'eyes', item: { type: 'message', channel: 'C2', ts: '1.1' } })
    assert.deepEqual(inbound(), [])
    assert.equal(r.runtime.connections.get(CONN)!.allowlist.dropped.messages, 3)
    // Nothing about it was looked up either: no users.info for the sender.
    assert.equal(r.slack.callsOf('users.info').length, 0)
  })

  test('a channel taken off the list stops at once; a newer list brings it back; a stale one is ignored', async () => {
    r.tm8.push(r.allowlist(['G1'], 2))
    await sleep(40)
    await deliver({ type: 'message', channel: 'C1', user: 'U1', text: 'paused', ts: r.slack.ts() })
    assert.equal(inbound().length, 0)
    r.tm8.push(r.allowlist(['C1'], 1)) // stale
    await sleep(40)
    await deliver({ type: 'message', channel: 'C1', user: 'U1', text: 'still paused', ts: r.slack.ts() })
    assert.equal(inbound().length, 0)
    r.tm8.push(r.allowlist(['C1'], 3))
    await sleep(40)
    await deliver({ type: 'message', channel: 'C1', user: 'U1', text: 'back', ts: r.slack.ts() })
    assert.equal((await got(1)).length, 1)
  })

  test('DM ids are never honoured, even when the server lists one', async () => {
    r.tm8.push(r.allowlist(['C1', 'D0DM'], 2))
    await sleep(40)
    await deliver({ type: 'message', channel: 'D0DM', channel_type: 'im', user: 'U1', text: 'dm', ts: r.slack.ts() })
    assert.equal(inbound().length, 0)
  })
})

describe('messages', () => {
  test('text with mentions, a channel link, a URL and escapes reads naturally; the ids stay in mentions', async () => {
    const ts = r.slack.ts()
    await deliver({ type: 'message', channel: 'C1', user: 'U1', ts, text: '<@U0BOT> can <@U2> check <#C1|eng> and <https://x.io/a?b=1&amp;c=2|the docs>? 1 &lt; 2 &amp;&amp; <!here>' })
    const [f] = await got(1)
    assert.deepEqual(f, {
      connectionId: CONN,
      conversationId: 'C1',
      externalMessageId: ts,
      sender: { externalId: 'U1', altId: null, name: 'Priya', fromMe: false, email: 'priya@acme.io', avatarUrl: 'https://avatars.slack-edge.com/priya_192.png', bot: false },
      body: '@tm8 can @Rahul check #eng and the docs (https://x.io/a?b=1&c=2)? 1 < 2 && @here',
      kind: 'text',
      media: [],
      replyTo: null,
      mentions: ['U0BOT', 'U2'],
      thread: null,
      ts: Math.floor(Number(ts)),
    })
  })

  test('message and app_mention for the same ts become one inbound', async () => {
    const ts = r.slack.ts()
    await deliver({ type: 'app_mention', channel: 'C1', user: 'U1', text: '<@U0BOT> hi', ts })
    await deliver({ type: 'message', channel: 'C1', user: 'U1', text: '<@U0BOT> hi', ts })
    assert.equal((await got(1)).length, 1)
  })

  test('a redelivered envelope (same event_id) is forwarded once', async () => {
    const ev = { type: 'message', channel: 'C1', user: 'U1', text: 'once', ts: r.slack.ts() }
    await deliver(ev, { eventId: 'Ev1' })
    await deliver({ ...ev, ts: r.slack.ts() }, { eventId: 'Ev1' })
    assert.equal((await got(1)).length, 1)
  })

  test('a thread reply names its root in thread and replyTo', async () => {
    const root = r.slack.ts()
    const ts = r.slack.ts()
    await deliver({ type: 'message', channel: 'C1', user: 'U2', text: 'can you add a test?', ts, thread_ts: root, parent_user_id: 'U1' })
    const [f] = await got(1)
    assert.deepEqual(f.thread, { rootExternalMessageId: root })
    assert.deepEqual(f.replyTo, { externalMessageId: root, senderExternalId: 'U1', media: null })
    assert.equal(f.sender.email, null)
  })

  test('a thread root (thread_ts equal to ts) and a thread_broadcast are top-level and in-thread as Slack says', async () => {
    const root = r.slack.ts()
    await deliver({ type: 'message', channel: 'C1', user: 'U1', text: 'root', ts: root, thread_ts: root })
    await deliver({ type: 'message', subtype: 'thread_broadcast', channel: 'C1', user: 'U1', text: 'also to channel', ts: r.slack.ts(), thread_ts: root })
    const [a, b] = await got(2)
    assert.equal(a.thread, null)
    assert.deepEqual(b.thread, { rootExternalMessageId: root })
  })

  test('files arrive as MediaRefs whose handle is the file id', async () => {
    const img = r.slack.file({ name: 'shot.png', mimetype: 'image/png', bytes: Buffer.from('png'), channels: ['C1'] })
    const pdf = r.slack.file({ name: 'spec.pdf', mimetype: 'application/pdf', bytes: Buffer.from('pdf!'), channels: ['C1'] })
    const ts = r.slack.ts()
    await deliver({ type: 'message', subtype: 'file_share', channel: 'C1', user: 'U1', text: 'see these', ts, files: [r.slack.fileRef(img), r.slack.fileRef(pdf), { id: 'F0GONE', mode: 'tombstone' }] })
    const [f] = await got(1)
    assert.equal(f.kind, 'media')
    assert.equal(f.body, 'see these')
    assert.deepEqual(f.media, [
      { kind: 'image', mime: 'image/png', fileName: 'shot.png', caption: null, size: 3, handle: img.id },
      { kind: 'document', mime: 'application/pdf', fileName: 'spec.pdf', caption: null, size: 4, handle: pdf.id },
    ])
  })

  test('the bot\'s own messages are skipped; another bot is marked bot', async () => {
    await deliver({ type: 'message', channel: 'C1', user: 'U0BOT', bot_id: 'B0BOT', text: 'my own reply', ts: r.slack.ts() })
    await deliver({ type: 'message', subtype: 'bot_message', channel: 'C1', bot_id: 'B0BOT', username: 'brave-otter', text: 'voiced reply', ts: r.slack.ts() })
    await deliver({ type: 'message', subtype: 'bot_message', channel: 'C1', bot_id: 'B0OTHER', username: 'CI', text: 'build green', ts: r.slack.ts() })
    const fs = await got(1)
    assert.equal(fs.length, 1)
    assert.deepEqual(fs[0].sender, { externalId: null, altId: null, name: 'CI', fromMe: false, email: null, avatarUrl: null, bot: true })
  })

  test('channel plumbing subtypes (joins, topic changes) are not messages', async () => {
    await deliver({ type: 'message', subtype: 'channel_join', channel: 'C1', user: 'U2', text: '<@U2> has joined the channel', ts: r.slack.ts() })
    await deliver({ type: 'message', subtype: 'channel_topic', channel: 'C1', user: 'U2', text: 'set the topic', ts: r.slack.ts() })
    assert.equal(inbound().length, 0)
  })

  test('users.info is cached: one lookup for many messages from the same person', async () => {
    for (let i = 0; i < 3; i++) await deliver({ type: 'message', channel: 'C1', user: 'U1', text: `m${i}`, ts: r.slack.ts() })
    assert.equal(r.slack.callsOf('users.info').filter((c) => c.params.user === 'U1').length, 1)
  })
})

describe('reactions, edits, deletes', () => {
  test('reaction_added arrives as a reaction in unicode; the bot\'s own are skipped; custom emoji keep their name', async () => {
    const target = r.slack.ts()
    await deliver({ type: 'reaction_added', user: 'U1', reaction: 'eyes', item: { type: 'message', channel: 'C1', ts: target }, item_user: 'U2' })
    await deliver({ type: 'reaction_added', user: 'U0BOT', reaction: 'white_check_mark', item: { type: 'message', channel: 'C1', ts: target } })
    await deliver({ type: 'reaction_added', user: 'U2', reaction: 'shipit', item: { type: 'message', channel: 'C1', ts: target } })
    await deliver({ type: 'reaction_added', user: 'U2', reaction: '+1::skin-tone-3', item: { type: 'message', channel: 'C1', ts: target } })
    const fs = await got(3)
    assert.equal(fs.length, 3)
    assert.deepEqual(fs[0].reaction, { externalMessageId: target, emoji: '👀' })
    assert.equal(fs[0].kind, 'other')
    assert.equal(fs[0].sender.externalId, 'U1')
    assert.match(fs[0].externalMessageId, new RegExp(`^reaction:${target.replace('.', '\\.')}:U1:`))
    assert.equal(fs[1].reaction.emoji, ':shipit:')
    assert.equal(fs[2].reaction.emoji, '👍🏼')
  })

  test('reaction_removed is forwarded deliberately: the same reaction shape with an empty emoji (WhatsApp\'s removal)', async () => {
    const target = r.slack.ts()
    await deliver({ type: 'reaction_removed', user: 'U1', reaction: 'eyes', item: { type: 'message', channel: 'C1', ts: target } })
    await deliver({ type: 'reaction_removed', user: 'U0BOT', reaction: 'eyes', item: { type: 'message', channel: 'C1', ts: target } })
    await deliver({ type: 'reaction_removed', user: 'U1', reaction: 'eyes', item: { type: 'message', channel: 'C2', ts: target } })
    const fs = await got(1)
    assert.equal(fs.length, 1)
    assert.deepEqual(fs[0].reaction, { externalMessageId: target, emoji: '' })
    assert.equal(fs[0].body, '')
    assert.equal(fs[0].sender.externalId, 'U1')
  })

  test('message_changed with an edit is an edit of that message; Slack\'s own bookkeeping changes are not', async () => {
    const ts = r.slack.ts()
    await deliver({ type: 'message', subtype: 'message_changed', channel: 'C1', hidden: true, ts: r.slack.ts(),
      message: { type: 'message', user: 'U1', text: 'fixed <@U2>', ts, edited: { user: 'U1', ts: '1763000999.000000' } },
      previous_message: { type: 'message', user: 'U1', text: 'fixd', ts } })
    // An unfurl, and a reply count update: no `edited`.
    await deliver({ type: 'message', subtype: 'message_changed', channel: 'C1', hidden: true, ts: r.slack.ts(),
      message: { type: 'message', user: 'U1', text: 'see https://x.io', ts, attachments: [{ title: 'x' }] }, previous_message: { type: 'message', user: 'U1', text: 'see https://x.io', ts } })
    await deliver({ type: 'message', subtype: 'message_changed', channel: 'C1', hidden: true, ts: r.slack.ts(),
      message: { type: 'message', user: 'U1', text: 'root', ts, reply_count: 2 }, previous_message: { type: 'message', user: 'U1', text: 'root', ts, reply_count: 1 } })
    const fs = await got(1)
    assert.equal(fs.length, 1)
    assert.equal(fs[0].externalMessageId, ts)
    assert.equal(fs[0].body, 'fixed @Rahul')
    assert.deepEqual(fs[0].mentions, ['U2'])
    assert.deepEqual(fs[0].edit, { editedAt: 1763000999 })
  })

  test('message_deleted arrives as deleted with an empty body', async () => {
    const ts = r.slack.ts()
    const root = r.slack.ts()
    await deliver({ type: 'message', subtype: 'message_deleted', channel: 'C1', hidden: true, ts: r.slack.ts(), deleted_ts: ts,
      previous_message: { type: 'message', user: 'U1', text: 'oops, a secret', ts, thread_ts: root } })
    const [f] = await got(1)
    assert.equal(f.externalMessageId, ts)
    assert.equal(f.deleted, true)
    assert.equal(f.body, '')
    assert.deepEqual(f.thread, { rootExternalMessageId: root })
    assert.equal(f.sender.externalId, 'U1')
    assert.ok(!JSON.stringify(f).includes('secret'))
  })
})

describe('/tm8 slash commands', () => {
  test('become body "/<cmd> <args>", slashCommand {/tm8, text}, id cmd:<trigger_id>, acked with no message', async () => {
    const id = r.slack.slash({ channel: 'C1', user: 'U1', text: 'work fix the Safari login 500', triggerId: '123.456.abc' })
    const ack = await r.slack.waitForAck(id)
    assert.deepEqual(ack, { envelope_id: id })
    const f = await r.tm8.waitFor('inbound')
    assert.equal(f.externalMessageId, 'cmd:123.456.abc')
    assert.equal(f.body, '/work fix the Safari login 500')
    assert.deepEqual(f.slashCommand, { command: '/tm8', text: 'work fix the Safari login 500' })
    assert.equal(f.kind, 'text')
    assert.equal(f.thread, undefined)
    assert.equal(f.sender.externalId, 'U1')
    assert.equal(f.sender.email, 'priya@acme.io')
  })

  test('a bare /tm8 is /help; the command word is lowercased, its args kept', async () => {
    await r.slack.waitForAck(r.slack.slash({ channel: 'C1', user: 'U1', text: '' }))
    await r.slack.waitForAck(r.slack.slash({ channel: 'C1', user: 'U1', text: 'STATUS Of Thing' }))
    await sleep(40)
    assert.deepEqual((await got(2)).map((f) => f.body), ['/help', '/status Of Thing'])
  })

  test('from an unconnected channel: an ephemeral note to the invoker in the ack, nothing forwarded', async () => {
    const ack = await r.slack.waitForAck(r.slack.slash({ channel: 'C2', user: 'U1', text: 'work leak this' }))
    assert.match(String((ack.payload as { text: string }).text), /isn't connected to tm8/)
    await sleep(40)
    assert.equal(inbound().length, 0)
    assert.equal(r.runtime.connections.get(CONN)!.allowlist.dropped.messages, 1)
  })
})

describe('channel state', () => {
  const states = () => r.tm8.of('conversation-state')

  test('rename carries the new name; archive and the bot leaving refuse posts', async () => {
    await deliver({ type: 'channel_rename', channel: { id: 'C1', name: 'eng-support', created: 1 } })
    await deliver({ type: 'channel_archive', channel: 'C1', user: 'U1' })
    await deliver({ type: 'group_left', channel: 'G1' })
    assert.deepEqual(states(), [
      { connectionId: CONN, conversationId: 'C1', canSend: true, reason: null, name: 'eng-support' },
      { connectionId: CONN, conversationId: 'C1', canSend: false, reason: 'not_a_member', archived: true },
      { connectionId: CONN, conversationId: 'G1', canSend: false, reason: 'not_a_member' },
    ])
    // The guard now refuses a send there without calling Slack.
    r.tm8.push({ type: 'send', outboxId: 'o-arch', connectionId: CONN, conversationId: 'C1', text: 'hello?' })
    assert.deepEqual((await r.tm8.waitFor('sent')).failed, { reason: 'not_a_member', retryable: false })
    assert.equal(r.slack.callsOf('chat.postMessage').length, 0)
  })

  test('unarchive (channel_ and group_) gives canSend back; group_rename and group_archive act like channel_', async () => {
    await deliver({ type: 'channel_archive', channel: 'C1', user: 'U1' })
    r.slack.channels.get('C1')!.archived = false
    await deliver({ type: 'channel_unarchive', channel: 'C1', user: 'U1' })
    await deliver({ type: 'group_rename', channel: { id: 'G1', name: 'secret-2', created: 1 } })
    await deliver({ type: 'group_archive', channel: 'G1' })
    r.slack.channels.get('G1')!.archived = false
    await deliver({ type: 'group_unarchive', channel: 'G1' })
    await sleep(60)
    assert.deepEqual(states().map((s) => [s.conversationId, s.canSend, s.reason, s.archived ?? null, s.name ?? null]), [
      ['C1', false, 'not_a_member', true, null],
      ['C1', true, null, false, 'eng'],
      ['G1', true, null, null, 'secret-2'],
      ['G1', false, 'not_a_member', true, null],
      ['G1', true, null, false, 'secret'],
    ])
    // Posting works again after the unarchive.
    r.tm8.push({ type: 'send', outboxId: 'o-unarch', connectionId: CONN, conversationId: 'C1', text: 'back' })
    assert.equal((await r.tm8.waitFor('sent', (f) => f.outboxId === 'o-unarch')).failed, undefined)
  })

  test('the bot removed (member_left_channel) and re-invited (member_joined_channel)', async () => {
    r.slack.channels.get('C1')!.member = false
    await deliver({ type: 'member_left_channel', channel: 'C1', user: 'U0BOT', channel_type: 'C' })
    await deliver({ type: 'member_left_channel', channel: 'C1', user: 'U2', channel_type: 'C' }) // someone else: nothing
    r.slack.channels.get('C1')!.member = true
    await deliver({ type: 'member_joined_channel', channel: 'C1', user: 'U0BOT', channel_type: 'C' })
    await sleep(40)
    assert.deepEqual(states().map((s) => [s.conversationId, s.canSend]), [['C1', false], ['C1', true]])
  })

  test('a channel added to the list that the bot is not in is reported cannot-send', async () => {
    r.slack.channel({ id: 'C7', name: 'not-invited', member: false })
    r.tm8.push(r.allowlist(['C1', 'G1', 'C7'], 2))
    const s = await r.tm8.waitFor('conversation-state', (f) => f.conversationId === 'C7')
    assert.deepEqual(s, { connectionId: CONN, conversationId: 'C7', canSend: false, reason: 'not_a_member', name: 'not-invited', archived: false })
  })

  test('events about unconnected channels change nothing and are counted as stanzas', async () => {
    await deliver({ type: 'channel_rename', channel: { id: 'C2', name: 'x' } })
    await deliver({ type: 'channel_archive', channel: 'C2' })
    assert.equal(states().length, 0)
    assert.equal(r.runtime.connections.get(CONN)!.allowlist.dropped.stanzas, 2)
  })
})
