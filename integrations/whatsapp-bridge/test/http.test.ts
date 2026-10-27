import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import { test } from 'node:test'
import { startHttp } from '../src/http.js'
import { inbound, withMain } from './helpers.js'

test('HTTP: /health is open, everything else needs a token; /say, /history, /search, /names round-trip', async () => {
  const t = await withMain()
  const server = await startHttp(t.bridge, '127.0.0.1', 0)
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const auth = { authorization: `Bearer ${t.mainToken}`, 'content-type': 'application/json' }
  try {
    const h = await (await fetch(`${base}/health`)).json()
    assert.equal(h.wa.connected, true)
    assert.equal(h.channels[0].main_chat_id, 'chat-1')
    assert.equal((await fetch(`${base}/history`)).status, 401)
    assert.equal((await fetch(`${base}/history`, { headers: { authorization: 'Bearer nope' } })).status, 401)
    await t.bridge.onInbound(inbound({ text: '@tm8 hello there' }))
    const say = await fetch(`${base}/say`, { method: 'POST', headers: auth, body: JSON.stringify({ text: 'hi back', idempotency_key: 'h1' }) })
    assert.equal(say.status, 200)
    const { wa_msg_id } = await say.json()
    assert.ok(wa_msg_id)
    const again = await (await fetch(`${base}/say`, { method: 'POST', headers: auth, body: JSON.stringify({ text: 'hi back', idempotency_key: 'h1' }) })).json()
    assert.equal(again.wa_msg_id, wa_msg_id)
    assert.equal((await fetch(`${base}/say`, { method: 'POST', headers: auth, body: '{bad' })).status, 400)
    const hist = await (await fetch(`${base}/history?limit=10`, { headers: auth })).json()
    assert.deepEqual(hist.messages.map((m: any) => m.from), ['Subhang', 'self-main'])
    const s = await (await fetch(`${base}/search?q=hello`, { headers: auth })).json()
    assert.equal(s.messages.length, 1)
    const one = await (await fetch(`${base}/message/${wa_msg_id}`, { headers: auth })).json()
    assert.equal(one.message.by_name, 'self-main')
    const names = await (await fetch(`${base}/names`, { headers: auth })).json()
    assert.equal(names.names[0].main, true)
    assert.equal((await fetch(`${base}/nope`, { headers: auth })).status, 404)
  } finally {
    server.close()
  }
})

test('HTTP: /admin/inject needs the admin token and routes like a typed owner message', async () => {
  const t = await withMain()
  t.bridge.adminToken = 'wab_admin'
  const server = await startHttp(t.bridge, '127.0.0.1', 0)
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  try {
    const body = JSON.stringify({ text: '@tm8 injected hello' })
    assert.equal((await fetch(`${base}/admin/inject`, { method: 'POST', body })).status, 401)
    assert.equal((await fetch(`${base}/admin/inject`, { method: 'POST', body, headers: { authorization: `Bearer ${t.mainToken}` } })).status, 401)
    const r = await fetch(`${base}/admin/inject`, { method: 'POST', body, headers: { authorization: 'Bearer wab_admin' } })
    assert.equal(r.status, 200)
    const j = await r.json()
    assert.match(j.wa_msg_id, /^TEST-/)
    assert.deepEqual(j.routes, [{ target: 'self-main', status: 'posted' }])
    assert.equal(t.tm8.posts.at(-1)!.to, 'chat-1')
    assert.equal(t.wa.reactions.length, 0) // no reactions on messages that don't exist on WhatsApp
  } finally {
    server.close()
  }
})
