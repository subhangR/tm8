// Linking, sealed tokens, the Socket Mode lifecycle and the heartbeat, at the runtime boundary: the real runtime
// between a fake tm8-server and a fake Slack.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, test } from 'node:test'
import { SLACK_CAPABILITIES } from '../src/runtime/protocol.js'
import { FakeTm8 } from './fake-tm8.js'
import { CONN, rig, seed, sleep, waitUntil, type Rig } from './harness.js'

let r: Rig | null = null
afterEach(async () => {
  await r?.stop()
  r = null
})

async function linked() {
  r = await rig()
  seed(r.slack)
  await r.start()
  await r.connect()
  return r
}

describe('hello and linking', () => {
  test('hello names provider slack, protocol v4 and the Slack capability sheet', async () => {
    r = await rig()
    await r.start()
    const hello = r.tm8.of('hello')[0]
    assert.equal(hello.provider, 'slack')
    assert.equal(hello.version, 4)
    assert.equal(hello.runtimeId, 'slack-test')
    assert.deepEqual(hello.capabilities, SLACK_CAPABILITIES)
  })

  test('a pasted credential is checked with auth.test, sealed, and reported as linked with the account', async () => {
    const r = await linked()
    const states = r.tm8.of('state').filter((s) => s.connectionId === CONN)
    const ok = states.find((s) => s.status === 'linked')
    assert.deepEqual(ok.account, {
      teamId: 'T0FAKE', teamName: 'Acme', url: 'https://acme.enterprise.slack.com/', enterpriseId: 'E0FAKE', enterpriseName: null,
      isEnterpriseInstall: false, botUserId: 'U0BOT', botId: 'B0BOT', botName: 'tm8', scopes: r.slack.scopes,
    })
    assert.deepEqual(ok.self, { id: 'U0BOT', lid: null })
    assert.equal(states[0].status, 'connecting')
    // auth.test ran on the bot token, the socket was opened with the app token.
    assert.equal(r.slack.callsOf('auth.test')[0]!.token, r.slack.botToken)
    assert.equal(r.slack.callsOf('apps.connections.open')[0]!.token, r.slack.appToken)
    // Sealed: the file exists, 0600 in a 0700 dir, and holds neither token in clear.
    const file = r.sealedFile()
    const raw = fs.readFileSync(file)
    assert.equal(fs.statSync(file).mode & 0o777, 0o600)
    assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700)
    assert.ok(!raw.includes(r.slack.botToken) && !raw.includes(r.slack.appToken) && !raw.includes('xoxb-') && !raw.includes('xapp-'))
    // And no frame to the server, nor any log line, ever carries a token.
    const everything = JSON.stringify(r.tm8.posted) + r.logs.join('\n')
    assert.ok(!everything.includes(r.slack.botToken) && !everything.includes(r.slack.appToken))
  })

  test('an org-wide Enterprise Grid install: teamId falls back to the org, isEnterpriseInstall is set', async () => {
    r = await rig()
    seed(r.slack)
    r.slack.team.isEnterpriseInstall = true
    await r.start()
    await r.connect()
    const ok = r.tm8.of('state').find((s) => s.status === 'linked')
    assert.equal(ok.account.teamId, 'E0FAKE')
    assert.equal(ok.account.enterpriseId, 'E0FAKE')
    assert.equal(ok.account.isEnterpriseInstall, true)
  })

  test('a bad bot token is logged_out with Slack\'s code and nothing is sealed or opened', async () => {
    r = await rig()
    seed(r.slack)
    await r.start()
    r.tm8.push({ type: 'connect', connectionId: CONN, stateKey: r.key.toString('base64'), credential: { kind: 'slack_tokens', botToken: 'xoxb-1-2-WRONG', appToken: r.slack.appToken } })
    const s = await r.tm8.waitFor('state', (f) => f.status === 'logged_out')
    assert.equal(s.detail, 'invalid_auth')
    assert.equal(s.account, undefined)
    assert.equal(fs.existsSync(r.sealedFile()), false)
    assert.equal(r.slack.opens, 0)
    assert.ok(!JSON.stringify(r.tm8.posted).includes('WRONG'))
  })

  test('tokens of the wrong kind are refused before Slack is asked', async () => {
    r = await rig()
    await r.start()
    r.tm8.push({ type: 'connect', connectionId: CONN, stateKey: r.key.toString('base64'), credential: { kind: 'slack_tokens', botToken: 'xoxp-user-token', appToken: r.slack.appToken } })
    assert.equal((await r.tm8.waitFor('state', (f) => f.status === 'logged_out')).detail, 'not_allowed_token_type')
    assert.equal(r.slack.calls.length, 0)
  })

  test('a bad app token is logged_out as app_token: <code>, and the pair is wiped', async () => {
    r = await rig()
    seed(r.slack)
    await r.start()
    r.tm8.push({ type: 'connect', connectionId: CONN, stateKey: r.key.toString('base64'), credential: { kind: 'slack_tokens', botToken: r.slack.botToken, appToken: 'xapp-1-A0X-1-wrong' } })
    const s = await r.tm8.waitFor('state', (f) => f.status === 'logged_out')
    assert.equal(s.detail, 'app_token: invalid_auth')
    await waitUntil(() => !fs.existsSync(r!.sealedFile()))
  })

  test('missing_scope names the scope; details are capped at 500 chars', async () => {
    r = await rig()
    await r.start()
    r.slack.fail('auth.test', 'missing_scope', 1, 'chat:write')
    r.tm8.push({ type: 'connect', connectionId: CONN, stateKey: r.key.toString('base64'), credential: { kind: 'slack_tokens', botToken: r.slack.botToken, appToken: r.slack.appToken } })
    assert.equal((await r.tm8.waitFor('state', (f) => f.status === 'logged_out')).detail, 'missing_scope: chat:write')
    r.slack.fail('auth.test', 'x'.repeat(900))
    r.tm8.push({ type: 'connect', connectionId: CONN, stateKey: r.key.toString('base64'), credential: { kind: 'slack_tokens', botToken: r.slack.botToken, appToken: r.slack.appToken } })
    await r.tm8.waitFor('state', (f) => f.status === 'offline' && f.detail.startsWith('x'))
    assert.ok(r.tm8.of('state').every((s) => s.detail === null || s.detail.length <= 500))
  })

  test('Slack unreachable at link time: offline, then linked on the retry', async () => {
    r = await rig()
    seed(r.slack)
    await r.start()
    r.slack.rateLimit('auth.test', 1, 0)
    r.slack.fail('auth.test', 'service_unavailable')
    r.tm8.push({ type: 'connect', connectionId: CONN, stateKey: r.key.toString('base64'), credential: { kind: 'slack_tokens', botToken: r.slack.botToken, appToken: r.slack.appToken } })
    await r.tm8.waitFor('state', (f) => f.status === 'offline')
    await r.tm8.waitFor('state', (f) => f.status === 'linked')
    assert.equal(r.slack.callsOf('auth.test').length, 3)
  })

  test('a connect with no credential and nothing sealed answers logged_out no_credential', async () => {
    r = await rig()
    await r.start()
    r.tm8.push({ type: 'connect', connectionId: CONN, stateKey: r.key.toString('base64') })
    assert.equal((await r.tm8.waitFor('state', (f) => f.status === 'logged_out')).detail, 'no_credential')
    assert.equal(r.slack.calls.length, 0)
  })

  test('a restarted runtime unseals what it holds from the hello reply; disconnect {logout} deletes the bytes', async () => {
    const first = await linked()
    const { stateDir, key, slack } = first
    first.link.stop()
    await first.runtime.stop()
    await first.tm8.close()
    const tm8 = await FakeTm8.start()
    tm8.helloReply = { connections: [{ connectionId: CONN, stateKey: key.toString('base64'), allowlist: { type: 'allowlist', connectionId: CONN, version: 3, conversationIds: ['C1'] } }] }
    const opensBefore = slack.opens
    r = await rig({ stateDir, key, slack, tm8 })
    await r.start()
    const s = await tm8.waitFor('state', (f) => f.status === 'linked')
    assert.equal(s.account.teamId, 'T0FAKE')
    await waitUntil(() => slack.opens > opensBefore)
    assert.ok(fs.existsSync(r.sealedFile()))
    tm8.push({ type: 'disconnect', connectionId: CONN, logout: true })
    const out = await tm8.waitFor('state', (f) => f.status === 'logged_out')
    assert.equal(out.detail, 'removed')
    assert.equal(fs.existsSync(r.sealedFile()), false)
    assert.equal(r.runtime.connections.size, 0)
  })

  test('a stateKey that does not open the sealed file is no_credential, never a crash', async () => {
    const first = await linked()
    const { stateDir, slack } = first
    first.link.stop()
    await first.runtime.stop()
    await first.tm8.close()
    const tm8 = await FakeTm8.start()
    const other = Buffer.alloc(32, 7)
    tm8.helloReply = { connections: [{ connectionId: CONN, stateKey: other.toString('base64'), allowlist: { type: 'allowlist', connectionId: CONN, version: 1, conversationIds: [] } }] }
    r = await rig({ stateDir, key: other, slack, tm8 })
    await r.start()
    assert.equal((await tm8.waitFor('state', (f) => f.status === 'logged_out')).detail, 'no_credential')
  })

  test('the hello reply drops connections the server no longer runs', async () => {
    const r = await linked()
    r.tm8.helloReply = { connections: [] }
    await r.runtime.hello()
    assert.equal(r.runtime.connections.size, 0)
    await waitUntil(() => !r.slack.socket)
  })

  test('a revoked token on a send logs the connection out and wipes the tokens', async () => {
    const r = await linked()
    r.slack.fail('chat.postMessage', 'token_revoked')
    r.tm8.push({ type: 'send', outboxId: 'o-rev', connectionId: CONN, conversationId: 'C1', text: 'hi' })
    const sent = await r.tm8.waitFor('sent', (f) => f.outboxId === 'o-rev')
    assert.deepEqual(sent.failed, { reason: 'token_revoked', retryable: false })
    assert.equal((await r.tm8.waitFor('state', (f) => f.status === 'logged_out')).detail, 'token_revoked')
    await waitUntil(() => !fs.existsSync(r.sealedFile()))
  })
})

describe('Socket Mode lifecycle', () => {
  test('every envelope is acked with its envelope_id, well inside 3 s', async () => {
    const r = await linked()
    const t0 = Date.now()
    const id = r.slack.event({ type: 'message', channel: 'C1', user: 'U1', text: 'hi', ts: r.slack.ts() })
    const ack = await r.slack.waitForAck(id)
    assert.ok(Date.now() - t0 < 3000)
    assert.deepEqual(ack, { envelope_id: id })
  })

  test('disconnect refresh_requested opens a fresh socket at once, and events flow on it', async () => {
    const r = await linked()
    const opened = r.slack.sockets.length
    r.slack.disconnect('refresh_requested')
    await r.slack.waitForSocket(opened + 1)
    const ts = r.slack.ts()
    await r.slack.waitForAck(r.slack.event({ type: 'message', channel: 'C1', user: 'U1', text: 'after refresh', ts }))
    await r.tm8.waitFor('inbound', (f) => f.externalMessageId === ts)
  })

  test('a dropped socket goes offline and comes back linked', async () => {
    const r = await linked()
    const opened = r.slack.sockets.length
    r.slack.dropSocket()
    await r.tm8.waitFor('state', (f) => f.status === 'offline' && /socket closed/.test(f.detail))
    await r.slack.waitForSocket(opened + 1)
    await waitUntil(() => r.tm8.of('state').filter((s) => s.status === 'linked').length >= 2)
  })

  test('a 429 on apps.connections.open waits Retry-After before reopening', async () => {
    const r = await linked()
    r.slack.rateLimit('apps.connections.open', 1, 1)
    const opened = r.slack.sockets.length
    const t0 = Date.now()
    r.slack.dropSocket()
    await r.slack.waitForSocket(opened + 1, 5000)
    assert.ok(Date.now() - t0 >= 950, `reopened after ${Date.now() - t0} ms`)
  })

  test('a socket that stops answering pings is replaced', async () => {
    const r = await linked()
    const ws = r.slack.socket!
    // Stop the fake from answering pings: ws auto-pongs, so pause the underlying socket.
    ;(ws as any)._socket.pause()
    const opened = r.slack.sockets.length
    await r.slack.waitForSocket(opened + 1, 3000)
  })

  test('a second connection on the same Slack app is refused app_already_connected; the first keeps every event', async () => {
    r = await rig()
    seed(r.slack)
    await r.start()
    await r.connect(['C1'])
    const CONN2 = '01a1eddf-0000-7000-8000-000000000002'
    const key2 = Buffer.alloc(32, 2).toString('base64')
    const connect2 = () => r!.tm8.push({ type: 'connect', connectionId: CONN2, stateKey: key2, credential: { kind: 'slack_tokens', botToken: r!.slack.botToken, appToken: r!.slack.appToken }, allowlist: { type: 'allowlist', connectionId: CONN2, version: 1, conversationIds: ['C2'] } })
    connect2()
    const refused = await r.tm8.waitFor('state', (f) => f.connectionId === CONN2 && f.status === 'logged_out')
    assert.equal(refused.detail, 'app_already_connected')
    assert.equal(fs.existsSync(r.sealedFile(CONN2)), false)
    // Still one socket for the app, so the fake (round-robin over the app's sockets, like Slack) cannot split events.
    assert.equal(r.slack.sockets.filter((s) => s.readyState === s.OPEN).length, 1)
    const tss = [r.slack.ts(), r.slack.ts(), r.slack.ts(), r.slack.ts()]
    for (const ts of tss) await r.slack.waitForAck(r.slack.event({ type: 'message', channel: 'C1', user: 'U1', text: 'x', ts }))
    for (const ts of tss) assert.equal((await r.tm8.waitFor('inbound', (f) => f.externalMessageId === ts)).connectionId, CONN)
    // Once the first is removed, the app is free and the second links.
    r.tm8.push({ type: 'disconnect', connectionId: CONN, logout: true })
    await r.tm8.waitFor('state', (f) => f.connectionId === CONN && f.detail === 'removed')
    connect2()
    await r.tm8.waitFor('state', (f) => f.connectionId === CONN2 && f.status === 'linked')
  })

  test('the fake is honest: two sockets for one app split its events (what the refusal prevents)', async () => {
    r = await rig()
    seed(r.slack)
    await r.start()
    await r.connect(['C1'])
    // A second process (or a foreign client) opening a socket on the same app steals every other envelope.
    const { WebSocket } = await import('ws')
    const open = (await (await fetch(new URL('apps.connections.open', r.slack.apiUrl), { method: 'POST', headers: { authorization: `Bearer ${r.slack.appToken}` } })).json()) as { url: string }
    const thief = new WebSocket(open.url)
    await new Promise((res) => thief.once('open', res))
    let stolen = 0
    thief.on('message', (d) => {
      const env = JSON.parse(String(d))
      if (!env.envelope_id) return
      stolen++
      thief.send(JSON.stringify({ envelope_id: env.envelope_id }))
    })
    for (let i = 0; i < 4; i++) await r.slack.waitForAck(r.slack.event({ type: 'message', channel: 'C1', user: 'U1', text: 'x', ts: r.slack.ts() }))
    thief.close()
    assert.ok(stolen >= 2, `stolen ${stolen}`)
  })

  test('the heartbeat reports status, allowlist version and drop counters, never content', async () => {
    const r = await linked()
    await r.slack.waitForAck(r.slack.event({ type: 'message', channel: 'C2', user: 'U1', text: 'secret plans', ts: r.slack.ts() }))
    await r.slack.waitForAck(r.slack.event({ type: 'channel_rename', channel: { id: 'C2', name: 'renamed' } }))
    await r.runtime.heartbeat()
    const hb = await r.tm8.waitFor('heartbeat')
    assert.equal(hb.runtimeId, 'slack-test')
    assert.deepEqual(hb.connections, [{ connectionId: CONN, status: 'linked', dropped: { stanzas: 1, messages: 1, outboundRefused: 0 }, allowlistVersion: 1 }])
    assert.ok(!JSON.stringify(r.tm8.posted).includes('secret plans'))
  })
})
