// SenderRef.team: where each Slack sender belongs relative to the install, so the server auto-links by email only for
// a full member of the connection's own install (and fails closed when team is null). And no bot is ever a person.
import assert from 'node:assert/strict'
import { afterEach, describe, test } from 'node:test'
import { CONN, rig, seed, sleep, type Rig } from './harness.js'

let r: Rig
afterEach(() => r.stop())

async function boot(o: { grid?: 'none' | 'workspace' | 'org' } = {}) {
  r = await rig()
  seed(r.slack)
  if (o.grid === 'none') r.slack.team.enterpriseId = null
  if (o.grid === 'org') {
    r.slack.team.isEnterpriseInstall = true
    r.slack.workspaces = [{ id: 'T0FAKE', name: 'Acme' }, { id: 'T0EU', name: 'Acme EU' }]
  }
  const u = r.slack.user.bind(r.slack)
  u({ id: 'U0MEMBER', name: 'Mem', email: 'mem@acme.io' })
  u({ id: 'U0GUEST', name: 'Gus', email: 'gus@vendor.io', guest: 'multi' })
  u({ id: 'U0SINGLE', name: 'Sig', email: 'sig@vendor.io', guest: 'single' })
  u({ id: 'U0STRANGER', name: 'Str', email: 'str@partner.io', team: 'T0PARTNER', enterprise: null, stranger: true })
  u({ id: 'W0OTHERORG', name: 'Oth', email: 'oth@other.io', team: 'T0OTHER', enterprise: 'E0OTHER' })
  u({ id: 'W0SIBLING', name: 'Sib', email: 'sib@acme.io', team: 'T0EU' })
  u({ id: 'W0BOTH', name: 'Bot', email: 'both@acme.io', team: 'T0EU', teams: ['T0FAKE'] })
  u({ id: 'U0CONNECT', name: 'Con', email: 'con@partner.io', external: true })
  u({ id: 'U0NOENT', name: 'Noe', email: 'noe@x.io', team: 'T0ELSE', enterprise: null })
  u({ id: 'U0APPBOT', name: 'ci-bot', bot: true })
  await r.start()
  await r.connect(['C1'])
}

async function senderOf(user: string, extra: Record<string, unknown> = {}) {
  const ts = r.slack.ts()
  await r.slack.waitForAck(r.slack.event({ type: 'message', channel: 'C1', user, text: 'hi', ts, ...extra }))
  return (await r.tm8.waitFor('inbound', (f) => f.externalMessageId === ts)).sender
}

describe('SenderRef.team on a workspace install in a Grid org (E0FAKE)', () => {
  test('a full member of the install', async () => {
    await boot()
    const s = await senderOf('U0MEMBER')
    assert.deepEqual(s.team, { teamId: 'T0FAKE', enterpriseId: 'E0FAKE', guest: false, external: false })
    assert.equal(s.bot, false)
    assert.equal(s.email, 'mem@acme.io')
  })

  test('multi- and single-channel guests are guests', async () => {
    await boot()
    assert.deepEqual((await senderOf('U0GUEST')).team, { teamId: 'T0FAKE', enterpriseId: 'E0FAKE', guest: true, external: false })
    assert.equal((await senderOf('U0SINGLE')).team.guest, true)
  })

  test('a Slack Connect stranger, a user of another org, and a sibling workspace of the same org', async () => {
    await boot()
    assert.deepEqual((await senderOf('U0STRANGER', { user_team: 'T0PARTNER' })).team, { teamId: 'T0PARTNER', enterpriseId: null, guest: false, external: true })
    assert.deepEqual((await senderOf('W0OTHERORG')).team, { teamId: 'T0OTHER', enterpriseId: 'E0OTHER', guest: false, external: true })
    // Same Grid org but not a member of the install's workspace: external to this (workspace) install.
    assert.deepEqual((await senderOf('W0SIBLING')).team, { teamId: 'T0EU', enterpriseId: 'E0FAKE', guest: false, external: true })
    // Home workspace elsewhere in the org, but also a member of the install's: in, reported under the install's team.
    assert.deepEqual((await senderOf('W0BOTH')).team, { teamId: 'T0FAKE', enterpriseId: 'E0FAKE', guest: false, external: false })
    // The fake's Slack Connect shorthand.
    assert.deepEqual((await senderOf('U0CONNECT')).team, { teamId: 'T0EXTERNAL', enterpriseId: null, guest: false, external: true })
    // No enterprise at all while the install is in one: external.
    assert.equal((await senderOf('U0NOENT')).team.external, true)
  })

  test('users.info failing gives team null (the server fails closed)', async () => {
    await boot()
    r.slack.fail('users.info', 'user_not_found')
    const s = await senderOf('U0GHOST')
    assert.equal(s.team, null)
    assert.equal(s.email, null)
  })

  test('reactions and slash commands carry the sender\'s team too', async () => {
    await boot()
    await r.slack.waitForAck(r.slack.event({ type: 'reaction_added', user: 'U0GUEST', reaction: 'eyes', item: { type: 'message', channel: 'C1', ts: r.slack.ts() } }))
    assert.equal((await r.tm8.waitFor('inbound', (f) => !!f.reaction)).sender.team.guest, true)
    await r.slack.waitForAck(r.slack.slash({ channel: 'C1', user: 'U0MEMBER', text: 'status' }))
    const cmd = await r.tm8.waitFor('inbound', (f) => !!f.slashCommand)
    assert.deepEqual(cmd.sender.team, { teamId: 'T0FAKE', enterpriseId: 'E0FAKE', guest: false, external: false })
    assert.equal(cmd.sender.bot, false)
  })
})

describe('SenderRef.team on other install shapes', () => {
  test('a plain workspace (no Grid): another workspace is external, the own one is not', async () => {
    await boot({ grid: 'none' })
    assert.deepEqual((await senderOf('U0MEMBER')).team, { teamId: 'T0FAKE', enterpriseId: null, guest: false, external: false })
    assert.equal((await senderOf('U0NOENT')).team.external, true)
  })

  test('an org-wide install: any workspace of the org is in, another org is external', async () => {
    await boot({ grid: 'org' })
    assert.equal((await senderOf('W0SIBLING')).team.external, false)
    assert.equal((await senderOf('U0MEMBER')).team.external, false)
    assert.equal((await senderOf('W0OTHERORG')).team.external, true)
  })
})

describe('no bot is ever a person', () => {
  test('the install\'s own bot user and bot id never reach the server as a person', async () => {
    await boot()
    // Its own posts are not forwarded at all, whichever field names it.
    await r.slack.waitForAck(r.slack.event({ type: 'message', channel: 'C1', user: 'U0BOT', text: 'mine', ts: r.slack.ts() }))
    await r.slack.waitForAck(r.slack.event({ type: 'message', channel: 'C1', bot_id: 'B0BOT', subtype: 'bot_message', text: 'mine too', ts: r.slack.ts() }))
    await r.slack.waitForAck(r.slack.event({ type: 'message', channel: 'C1', user: 'U0BOT', bot_id: 'B0BOT', text: 'and this', ts: r.slack.ts() }))
    await sleep(60)
    assert.equal(r.tm8.of('inbound').length, 0)
    // A delete of its own message is forwarded (to tombstone the copy) as the bot, from itself.
    const ts = r.slack.ts()
    await r.slack.waitForAck(r.slack.event({ type: 'message', subtype: 'message_deleted', channel: 'C1', hidden: true, ts: r.slack.ts(), deleted_ts: ts, previous_message: { type: 'message', user: 'U0BOT', bot_id: 'B0BOT', text: 'x', ts } }))
    const d = await r.tm8.waitFor('inbound', (f) => f.externalMessageId === ts)
    assert.equal(d.sender.bot, true)
    assert.equal(d.sender.fromMe, true)
  })

  test('another app\'s bot user (is_bot, no bot_id on the event) is a bot', async () => {
    await boot()
    const s = await senderOf('U0APPBOT')
    assert.equal(s.bot, true)
  })
})
