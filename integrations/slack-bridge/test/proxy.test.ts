// Enterprise proxies: every Slack-bound connection (Web API, Socket Mode WSS, file upload and download) goes through
// an HTTP CONNECT tunnel when a proxy is configured, NO_PROXY is honoured, and the tm8-server link never uses it.
import assert from 'node:assert/strict'
import { afterEach, describe, test } from 'node:test'
import { Egress, bypassed } from '../src/runtime/egress.js'
import { ConnectProxy } from './connect-proxy.js'
import { CONN, rig, seed, sleep, type Rig } from './harness.js'

let r: Rig | null = null
let proxy: ConnectProxy | null = null
afterEach(async () => {
  await r?.stop()
  await proxy?.close()
  r = null
  proxy = null
})

describe('egress configuration', () => {
  const at = (env: Record<string, string>, url = 'https://slack.com/api/auth.test') => new Egress(env).proxyFor(url)?.href ?? null

  test('TM8_SLACK_PROXY_URL wins; HTTPS_PROXY / https_proxy for https and wss; HTTP_PROXY for http', () => {
    assert.equal(at({}), null)
    assert.equal(at({ HTTPS_PROXY: 'http://corp:3128' }), 'http://corp:3128/')
    assert.equal(at({ https_proxy: 'corp:3128' }), 'http://corp:3128/')
    assert.equal(at({ HTTPS_PROXY: 'http://corp:3128', TM8_SLACK_PROXY_URL: 'http://slack-only:8080' }), 'http://slack-only:8080/')
    assert.equal(at({ HTTPS_PROXY: 'http://corp:3128' }, 'wss://wss-primary.slack.com/link/'), 'http://corp:3128/')
    assert.equal(at({ HTTPS_PROXY: 'http://corp:3128' }, 'http://127.0.0.1:9/api/'), null)
    assert.equal(at({ HTTP_PROXY: 'http://plain:80' }, 'http://127.0.0.1:9/api/'), 'http://plain/')
  })

  test('NO_PROXY: *, hosts, .domains, *.domains, ports', () => {
    const u = (s: string) => new URL(s)
    assert.equal(bypassed(u('https://slack.com/'), '*'), true)
    assert.equal(bypassed(u('https://files.slack.com/x'), '.slack.com'), true)
    assert.equal(bypassed(u('https://files.slack.com/x'), '*.slack.com'), true)
    assert.equal(bypassed(u('https://slack.com/x'), 'slack.com'), true)
    assert.equal(bypassed(u('https://notslack.com/x'), 'slack.com'), false)
    assert.equal(bypassed(u('https://slack.com/x'), 'slack.com:8443'), false)
    assert.equal(bypassed(u('https://slack.com/x'), 'localhost, slack.com:443'), true)
    assert.equal(at({ HTTPS_PROXY: 'http://corp:3128', no_proxy: 'slack.com' }), null)
  })

  test('the log line names the proxy host, never its credentials', () => {
    const e = new Egress({ TM8_SLACK_PROXY_URL: 'http://alice:s3cret@corp:3128' })
    assert.equal(e.describe(), 'via proxy http://corp:3128')
  })
})

describe('through a CONNECT proxy', () => {
  test('auth.test, the Socket Mode socket, posting, file upload and download all tunnel through it', async () => {
    proxy = await ConnectProxy.start()
    proxy.requireAuth = 'alice:s3cret'
    const url = new URL(proxy.url)
    url.username = 'alice'
    url.password = 's3cret'
    r = await rig({ egress: new Egress({ TM8_SLACK_PROXY_URL: url.href }) })
    seed(r.slack)
    await r.start()
    await r.connect(['C1'])
    const slackHost = new URL(r.slack.origin).host

    // Inbound over the tunnelled socket.
    const ts = r.slack.ts()
    await r.slack.waitForAck(r.slack.event({ type: 'message', channel: 'C1', user: 'U1', text: 'via proxy', ts }))
    await r.tm8.waitFor('inbound', (f) => f.externalMessageId === ts)
    // Outbound text, a file up, a file down.
    r.tm8.push({ type: 'send', outboxId: 'p1', connectionId: CONN, conversationId: 'C1', text: 'hi' })
    assert.equal((await r.tm8.waitFor('sent', (f) => f.outboxId === 'p1')).failed, undefined)
    r.tm8.media.set('fe', Buffer.from('proxied bytes'))
    r.tm8.push({ type: 'send', outboxId: 'p2', connectionId: CONN, conversationId: 'C1', media: { kind: 'document', mime: 'text/plain', fileName: 'p.txt', caption: '', fileEntityId: 'fe' } })
    assert.equal((await r.tm8.waitFor('sent', (f) => f.outboxId === 'p2')).failed, undefined)
    const file = r.slack.file({ name: 'd.txt', mimetype: 'text/plain', bytes: Buffer.from('down'), channels: ['C1'] })
    r.tm8.push({ type: 'media.fetch', requestId: 'p3', connectionId: CONN, conversationId: 'C1', handle: file.id, maxBytes: 100 })
    assert.equal(Buffer.from((await r.tm8.waitFor('media', (f) => f.requestId === 'p3')).data, 'base64').toString(), 'down')

    const lines = proxy.tunnels.flatMap((t) => t.requests)
    assert.ok(proxy.tunnels.every((t) => t.target === slackHost), JSON.stringify(proxy.tunnels))
    assert.ok(proxy.tunnels.every((t) => t.auth === `Basic ${Buffer.from('alice:s3cret').toString('base64')}`))
    assert.ok(lines.some((l) => l.startsWith('POST /api/auth.test')), JSON.stringify(lines))
    // Every Web API call the fake answered came through the proxy.
    assert.equal(lines.filter((l) => l.startsWith('POST /api/')).length, r.slack.calls.length)
    assert.ok(lines.some((l) => l.startsWith('GET /link/')), 'the Socket Mode upgrade went through the proxy')
    assert.ok(lines.some((l) => l.startsWith('POST /upload/')), 'the file upload went through the proxy')
    assert.ok(lines.some((l) => l.startsWith('GET /files-pri/')), 'the file download went through the proxy')
    assert.ok(lines.some((l) => l.startsWith('POST /api/chat.postMessage')))
    // Every Slack request reached the fake through the proxy: the fake saw no direct connection.
    assert.equal(proxy.refused, 0)
    // The tm8-server link is loopback and never proxied.
    assert.ok(!proxy.tunnels.some((t) => t.target === new URL(r!.tm8.url).host))
  })

  test('a proxy that refuses the credentials leaves the connection offline and retrying, never linked', async () => {
    proxy = await ConnectProxy.start()
    proxy.requireAuth = 'alice:s3cret'
    r = await rig({ egress: new Egress({ TM8_SLACK_PROXY_URL: proxy.url }) })
    seed(r.slack)
    await r.start()
    r.tm8.push({ type: 'connect', connectionId: CONN, stateKey: r.key.toString('base64'), credential: { kind: 'slack_tokens', botToken: r.slack.botToken, appToken: r.slack.appToken } })
    const s = await r.tm8.waitFor('state', (f) => f.status === 'offline')
    assert.match(s.detail, /network_error/)
    await sleep(100)
    assert.equal(r.slack.calls.length, 0)
    assert.ok(proxy.refused >= 1)
    assert.ok(!r.tm8.of('state').some((f) => f.status === 'linked'))
  })

  test('NO_PROXY sends the fake Slack direct', async () => {
    proxy = await ConnectProxy.start()
    r = await rig({ egress: new Egress({ HTTP_PROXY: proxy.url, NO_PROXY: '127.0.0.1' }) })
    seed(r.slack)
    await r.start()
    await r.connect(['C1'])
    assert.equal(proxy.tunnels.length, 0)
  })
})
