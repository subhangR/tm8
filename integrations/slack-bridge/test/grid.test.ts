// Enterprise Grid. An org-wide install (one app across the org's approved workspaces): auth.test answers the org,
// listing methods need a team_id per workspace, channel ids and W… user ids are org-wide. A workspace-level install on
// a Grid workspace behaves like any workspace install. The fake Slack refuses team-less listing on an org token.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { afterEach, describe, test } from 'node:test'
import { CONN, rig, sleep, waitUntil, type Rig } from './harness.js'

let r: Rig
afterEach(() => r.stop())

/** An org-wide install approved into two workspaces, with a shared channel and a #general in each. */
async function org() {
  r = await rig()
  const s = r.slack
  s.team.isEnterpriseInstall = true
  s.workspaces = [{ id: 'T0EU', name: 'Acme EU' }, { id: 'T0US', name: 'Acme US' }]
  s.channel({ id: 'C0EUGEN', name: 'general', teams: ['T0EU'] })
  s.channel({ id: 'C0USGEN', name: 'general', teams: ['T0US'] })
  s.channel({ id: 'C0EUENG', name: 'eng-eu', teams: ['T0EU'] })
  s.channel({ id: 'C0SHARED', name: 'incidents', teams: ['T0EU', 'T0US'] })
  s.channel({ id: 'G0USSEC', name: 'us-secret', private: true, teams: ['T0US'] })
  s.channel({ id: 'C0USNOT', name: 'not-in', member: false, teams: ['T0US'] })
  s.user({ id: 'W0PRIYA', name: 'Priya', email: 'priya@acme.io' })
  await r.start()
  await r.connect(['C0SHARED', 'G0USSEC'])
  return r
}

describe('an org-wide Enterprise Grid install', () => {
  test('links with the org as the account', async () => {
    await org()
    const ok = r.tm8.of('state').find((s) => s.status === 'linked')
    assert.equal(ok.account.isEnterpriseInstall, true)
    assert.equal(ok.account.teamId, 'E0FAKE')
    assert.equal(ok.account.enterpriseId, 'E0FAKE')
  })

  test('the picker lists every approved workspace\'s channels, each users.conversations with its team_id', async () => {
    await org()
    r.tm8.push({ type: 'conversation.list', requestId: 'q1', connectionId: CONN })
    const f = await r.tm8.waitFor('conversations', (x) => x.requestId === 'q1')
    assert.equal(f.error, undefined)
    assert.deepEqual(f.items.map((i: any) => [i.conversationId, i.kind, i.name]), [
      ['C0EUENG', 'channel', 'eng-eu'],
      ['C0EUGEN', 'channel', 'general (Acme EU)'],
      ['C0USGEN', 'channel', 'general (Acme US)'],
      ['C0SHARED', 'channel', 'incidents'], // shared by both workspaces, listed once
      ['G0USSEC', 'private_channel', 'us-secret'],
    ])
    const listCalls = r.slack.callsOf('users.conversations')
    assert.ok(listCalls.length >= 2)
    assert.ok(listCalls.every((c) => c.params.team_id === 'T0EU' || c.params.team_id === 'T0US'), JSON.stringify(listCalls.map((c) => c.params)))
    assert.ok(r.slack.callsOf('auth.teams.list').length >= 2) // paginated
  })

  test('an org install approved into no workspace lists nothing, without error', async () => {
    await org()
    r.slack.workspaces = []
    r.tm8.push({ type: 'conversation.list', requestId: 'q2', connectionId: CONN })
    assert.deepEqual((await r.tm8.waitFor('conversations', (x) => x.requestId === 'q2')).items, [])
  })

  test('inbound from an org-wide event: W… users, the org\'s envelope fields, threads and the guard as usual', async () => {
    await org()
    const root = r.slack.ts()
    const ts = r.slack.ts()
    await r.slack.waitForAck(r.slack.event({ type: 'message', channel: 'C0SHARED', user: 'W0PRIYA', team: 'T0US', user_team: 'T0EU', source_team: 'T0EU', text: '<@U0BOT> on it?', ts, thread_ts: root }))
    await r.slack.waitForAck(r.slack.event({ type: 'message', channel: 'C0EUGEN', user: 'W0PRIYA', text: 'off the list', ts: r.slack.ts() }))
    const f = await r.tm8.waitFor('inbound', (x) => x.externalMessageId === ts)
    assert.equal(f.sender.externalId, 'W0PRIYA')
    assert.equal(f.sender.email, 'priya@acme.io')
    assert.deepEqual(f.thread, { rootExternalMessageId: root })
    assert.deepEqual(f.mentions, ['U0BOT'])
    await sleep(40)
    assert.equal(r.tm8.of('inbound').length, 1)
  })

  test('posting, reactions, files out and in work on channel ids alone (no team_id needed)', async () => {
    await org()
    r.tm8.push({ type: 'send', outboxId: 'g1', connectionId: CONN, conversationId: 'C0SHARED', text: 'hello **org**', voice: { username: 'brave-otter', iconUrl: null } })
    const sent = await r.tm8.waitFor('sent', (x) => x.outboxId === 'g1')
    assert.equal(sent.failed, undefined)
    assert.equal(r.slack.messages[0]!.text, 'hello *org*')
    r.tm8.push({ type: 'react', outboxId: 'g2', connectionId: CONN, conversationId: 'C0SHARED', emoji: '👀', target: { externalMessageId: sent.externalMessageId, senderExternalId: null, fromMe: true } })
    assert.equal((await r.tm8.waitFor('sent', (x) => x.outboxId === 'g2')).failed, undefined)
    r.tm8.media.set('fe-1', Buffer.from('grid file'))
    r.tm8.push({ type: 'send', outboxId: 'g3', connectionId: CONN, conversationId: 'G0USSEC', media: { kind: 'document', mime: 'text/plain', fileName: 'a.txt', caption: '', fileEntityId: 'fe-1' } })
    assert.equal((await r.tm8.waitFor('sent', (x) => x.outboxId === 'g3')).failed, undefined)
    const file = r.slack.file({ name: 'b.txt', mimetype: 'text/plain', bytes: Buffer.from('from slack'), channels: ['G0USSEC'] })
    r.tm8.push({ type: 'media.fetch', requestId: 'g4', connectionId: CONN, conversationId: 'G0USSEC', handle: file.id, maxBytes: 100 })
    assert.equal(Buffer.from((await r.tm8.waitFor('media', (x) => x.requestId === 'g4')).data, 'base64').toString(), 'from slack')
  })

  test('a channel the bot is not in, connected anyway, is reported cannot-send (conversations.info needs no team)', async () => {
    await org()
    r.tm8.push(r.allowlist(['C0SHARED', 'G0USSEC', 'C0USNOT'], 2))
    const s = await r.tm8.waitFor('conversation-state', (x) => x.conversationId === 'C0USNOT')
    assert.equal(s.canSend, false)
  })
})

describe('per-request refusals never cost the install its tokens (review #2)', () => {
  test('one ungranted workspace: the picker skips it, a channel there is cannot-send, the install stays linked and sealed', async () => {
    await org()
    r.slack.workspaces.push({ id: 'T0LOCK', name: 'Acme Legal', locked: true })
    r.slack.channel({ id: 'C0LEGAL', name: 'legal', teams: ['T0LOCK'] })
    r.tm8.push({ type: 'conversation.list', requestId: 'l1', connectionId: CONN })
    const f = await r.tm8.waitFor('conversations', (x) => x.requestId === 'l1')
    assert.equal(f.error, undefined)
    assert.ok(f.items.length >= 5 && !f.items.some((i: any) => i.conversationId === 'C0LEGAL'))
    r.tm8.push(r.allowlist(['C0SHARED', 'G0USSEC', 'C0LEGAL'], 2))
    const s = await r.tm8.waitFor('conversation-state', (x) => x.conversationId === 'C0LEGAL')
    assert.equal(s.canSend, false)
    await sleep(50)
    assert.ok(fs.existsSync(r.sealedFile()))
    assert.ok(!r.tm8.of('state').some((x) => x.status === 'logged_out'))
    assert.equal(r.runtime.connections.get(CONN)!.status, 'linked')
  })

  for (const code of ['no_permission', 'team_access_not_granted', 'channel_not_found', 'not_in_channel', 'restricted_action', 'ekm_access_denied']) {
    test(`${code} on a send fails that send only`, async () => {
      await org()
      r.slack.fail('chat.postMessage', code)
      r.tm8.push({ type: 'send', outboxId: `x-${code}`, connectionId: CONN, conversationId: 'C0SHARED', text: 'x' })
      assert.equal((await r.tm8.waitFor('sent', (x) => x.outboxId === `x-${code}`)).failed.retryable, false)
      await sleep(50)
      assert.ok(fs.existsSync(r.sealedFile()))
      assert.ok(!r.tm8.of('state').some((x) => x.status === 'logged_out'))
      // And the install keeps posting (elsewhere: a lost channel is rightly marked cannot-send).
      r.tm8.push({ type: 'send', outboxId: `y-${code}`, connectionId: CONN, conversationId: 'G0USSEC', text: 'y' })
      assert.equal((await r.tm8.waitFor('sent', (x) => x.outboxId === `y-${code}`)).failed, undefined)
    })
  }

  for (const code of ['invalid_auth', 'account_inactive', 'token_revoked', 'token_expired', 'not_authed']) {
    test(`${code} is a dead token: logged out and wiped`, async () => {
      await org()
      r.slack.fail('chat.postMessage', code)
      r.tm8.push({ type: 'send', outboxId: `d-${code}`, connectionId: CONN, conversationId: 'C0SHARED', text: 'x' })
      assert.equal((await r.tm8.waitFor('state', (x) => x.status === 'logged_out')).detail, code)
      await waitUntil(() => !fs.existsSync(r.sealedFile()))
    })
  }
})

describe('a workspace install on a Grid workspace', () => {
  test('lists without auth.teams.list or a team_id, as any workspace install', async () => {
    r = await rig()
    r.slack.channel({ id: 'C1', name: 'eng' })
    await r.start()
    await r.connect(['C1'])
    const ok = r.tm8.of('state').find((s) => s.status === 'linked')
    assert.equal(ok.account.isEnterpriseInstall, false)
    assert.equal(ok.account.enterpriseId, 'E0FAKE')
    assert.equal(ok.account.teamId, 'T0FAKE')
    r.tm8.push({ type: 'conversation.list', requestId: 'w1', connectionId: CONN })
    assert.deepEqual((await r.tm8.waitFor('conversations', (x) => x.requestId === 'w1')).items.map((i: any) => i.conversationId), ['C1'])
    assert.equal(r.slack.callsOf('auth.teams.list').length, 0)
    assert.ok(r.slack.callsOf('users.conversations').every((c) => c.params.team_id === undefined))
  })
})
