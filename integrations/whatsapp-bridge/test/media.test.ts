import assert from 'node:assert/strict'
import fs from 'node:fs'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { describe, test } from 'node:test'
import { HttpError, type Inbound } from '../src/core.js'
import { startHttp } from '../src/http.js'
import { mediaPlaceholder, safeFileName, sniffMime, stableUuid } from '../src/media.js'
import { GROUP, inbound, withMain } from './helpers.js'

// A 1×1 PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
const PDF = Buffer.from('%PDF-1.4\n%fake\n')

let n = 0
/** An inbound image (or other media) whose bytes the fake WhatsApp serves under ref `ref-<id>`. */
function mediaIn(t: Awaited<ReturnType<typeof withMain>>, p: Omit<Partial<Inbound>, 'kind'> & { caption?: string | null; bytes?: Buffer | Error; kind?: any; mime?: string | null; fileName?: string | null; size?: number | null } = {}): Inbound {
  const id = p.id ?? `MEDIA${++n}`
  const kind = p.kind ?? 'image'
  const caption = p.caption === undefined ? '@tm8 look at this' : p.caption
  const bytes = p.bytes ?? PNG
  t.wa.downloads.set(`ref-${id}`, bytes)
  const fileName = p.fileName ?? null
  return inbound({
    id,
    text: mediaPlaceholder(kind, caption, fileName),
    kind: 'media',
    media: { kind, mime: p.mime === undefined ? 'image/png' : p.mime, fileName, caption, size: p.size === undefined ? (bytes instanceof Buffer ? bytes.length : null) : p.size, ref: `ref-${id}` },
    ...Object.fromEntries(Object.entries(p).filter(([k]) => !['caption', 'bytes', 'kind', 'mime', 'fileName', 'size'].includes(k))),
  })
}

describe('media helpers', () => {
  test('placeholders, sniffing, safe names, stable mutation ids', () => {
    assert.equal(mediaPlaceholder('image', 'hi @tm8'), '[image] hi @tm8')
    assert.equal(mediaPlaceholder('image', null), '[image]')
    assert.equal(mediaPlaceholder('document', 'see p3', 'report.pdf'), '[document] report.pdf see p3')
    assert.equal(mediaPlaceholder('audio', 'ignored'), '[audio]')
    assert.equal(sniffMime(PNG), 'image/png')
    assert.equal(sniffMime(PDF), 'application/pdf')
    assert.equal(sniffMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg')
    assert.equal(sniffMime(Buffer.from('hello')), null)
    assert.equal(safeFileName('../../etc/passwd', 'x'), 'passwd')
    assert.equal(safeFileName('a\u0000b"c.pdf', 'x'), 'abc.pdf')
    assert.equal(safeFileName('...', 'fallback.bin'), 'fallback.bin')
    assert.equal(safeFileName('x'.repeat(300) + '.png', 'f').length, 100)
    assert.match(stableUuid('a'), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    assert.equal(stableUuid('a'), stableUuid('a'))
    assert.notEqual(stableUuid('a'), stableUuid('b'))
  })
})

describe('inbound media', () => {
  test('a captioned image mentioning @tm8 is downloaded, uploaded once and referenced (by tm8 file id) in the routed message', async () => {
    const t = await withMain()
    const m = mediaIn(t)
    await t.bridge.onInbound(m)
    const row = t.store.getMedia(m.id)!
    assert.equal(row.status, 'downloaded')
    assert.equal(row.size, PNG.length)
    assert.equal(row.mime, 'image/png')
    assert.equal(row.path, `${m.id}.png`)
    assert.deepEqual(fs.readFileSync(path.join(t.mediaDir, row.path!)), PNG)
    assert.equal(t.tm8.uploads.length, 1)
    assert.equal(t.tm8.uploads[0].mime, 'image/png')
    assert.equal(row.tm8_file_id, 'file-1')
    const post = t.tm8.posts.at(-1)!
    assert.equal(post.to, 'chat-1')
    // Default media.attach "reference": no --attach (tm8 chat turns fail on attachments), the file id is in the text.
    assert.equal(post.attach, undefined)
    assert.match(post.body, /\[attachment: image · image\/png · \d+ B · tm8 file file-1 \(tm8 file download file-1 --output <path>\) · bytes also at GET \/media\/MEDIA\d+\]/)
    assert.match(post.body, /---\n\[image\] @tm8 look at this$/)
    // FTS keeps the placeholder and caption; history shows the media metadata.
    assert.equal(t.bridge.search(t.ch, { q: 'look' }).messages.length, 1)
    const h = t.bridge.history(t.ch, {}).messages.at(-1)!
    assert.deepEqual(h.media, {
      kind: 'image', mime: 'image/png', size: PNG.length, file_name: null, caption: '@tm8 look at this', status: 'downloaded',
      tm8_file_id: 'file-1', url: `/media/${m.id}`,
    })
    assert.deepEqual(t.bridge.message(t.ch, m.id).message.media?.tm8_file_id, 'file-1')
  })

  test('a document with a caption, quoting a session, goes to that session with the file', async () => {
    const t = await withMain({ media: { attach: 'attach' } })
    const r = await t.bridge.say(t.auth(), { text: 'here', idempotency_key: 'q' })
    const m = mediaIn(t, { kind: 'document', mime: 'application/pdf', fileName: 'Q3 report.pdf', caption: 'numbers', bytes: PDF, quotedId: r.body.wa_msg_id as string })
    await t.bridge.onInbound(m)
    assert.equal(t.store.getMedia(m.id)!.path, `${m.id}.pdf`)
    const post = t.tm8.posts.at(-1)!
    assert.deepEqual(post.attach, ['file-1'])
    assert.match(post.body, /\[attachment: document · application\/pdf · \d+ B · "Q3 report.pdf" · attached as tm8 file file-1/)
    assert.equal(t.tm8.uploads[0].name, 'Q3 report.pdf')
  })

  test('unrouted media is logged and downloaded but not uploaded', async () => {
    const t = await withMain()
    const before = t.tm8.posts.length
    const m = mediaIn(t, { caption: 'just a photo' })
    await t.bridge.onInbound(m)
    assert.equal(t.store.getMedia(m.id)!.status, 'downloaded')
    assert.equal(t.tm8.uploads.length, 0)
    assert.equal(t.tm8.posts.length, before)
  })

  test('size cap: declared or actual size over media.maxBytes is not downloaded/kept, and the envelope says so', async () => {
    const t = await withMain({ media: { maxBytes: 50 } })
    const big = mediaIn(t, { size: 10_000 })
    await t.bridge.onInbound(big)
    assert.equal(t.store.getMedia(big.id)!.status, 'too_large')
    assert.ok(!t.wa.downloadCalls.includes(`ref-${big.id}`))
    assert.match(t.tm8.posts.at(-1)!.body, /over the 50 B limit, not downloaded/)
    assert.equal(t.tm8.posts.at(-1)!.attach, undefined)
    // Declared size missing, real bytes too big: the stream is cut off.
    const sneaky = mediaIn(t, { size: null, bytes: Buffer.alloc(200, 1) })
    await t.bridge.onInbound(sneaky)
    assert.equal(t.store.getMedia(sneaky.id)!.status, 'too_large')
    assert.equal(fs.readdirSync(t.mediaDir).length, 0)
    await assert.rejects(t.bridge.mediaFile(t.ch, sneaky.id), (e: HttpError) => e.status === 413)
  })

  test('a failed (undecryptable) download never crashes: routed with a note, retried with backoff and on GET /media', async () => {
    let now = Date.now()
    const t = await withMain({ now: () => now })
    const m = mediaIn(t, { bytes: new Error('bad decrypt') })
    await t.bridge.onInbound(m)
    const row = t.store.getMedia(m.id)!
    assert.equal(row.status, 'failed')
    assert.equal(row.attempts, 1)
    assert.match(t.tm8.posts.at(-1)!.body, /not downloaded yet \(bad decrypt\); GET \/media\/MEDIA\d+ retries/)
    // Backoff: not retried within the first minute, retried after.
    await t.bridge.retryMedia()
    assert.equal(t.store.getMedia(m.id)!.attempts, 1)
    now += 61_000
    await t.bridge.retryMedia()
    assert.equal(t.store.getMedia(m.id)!.attempts, 2)
    // Now it works: GET /media retries right away.
    t.wa.downloads.set(`ref-${m.id}`, PNG)
    const f = await t.bridge.mediaFile(t.ch, m.id)
    assert.equal(f.mime, 'image/png')
    assert.deepEqual(fs.readFileSync(f.path), PNG)
  })

  test('a failing tm8 upload is retried; if it keeps failing the message is posted without the file and says why', async () => {
    const t = await withMain({ media: { attach: 'attach' } })
    t.tm8.failUploads = 1
    const a = mediaIn(t)
    await t.bridge.onInbound(a)
    assert.deepEqual(t.tm8.posts.at(-1)!.attach, ['file-1'])
    t.tm8.failUploads = 10
    const b = mediaIn(t)
    await t.bridge.onInbound(b)
    const post = t.tm8.posts.at(-1)!
    assert.equal(post.attach, undefined)
    assert.match(post.body, /not attached \(upload to tm8 failed: upload failed\) · bytes at GET \/media\//)
  })

  test('one upload serves several targets', async () => {
    const t = await withMain({ media: { attach: 'attach' } })
    await t.bridge.onInbound(inbound({ text: 'unrelated' }))
    const m = mediaIn(t, { caption: '@tm8 and @nobody-here' })
    await t.bridge.onInbound(m)
    assert.equal(t.tm8.uploads.length, 1)
    // @nobody-here resolves to the main chat too, so this is one target; add a session for a second one.
    const t2 = await withMain({ media: { attach: 'attach' } })
    const mainId = t2.store.channel('self').main_chat_id!
    t2.tm8.contexts.set(mainId, { id: mainId, kind: 'chat', launchedSessions: [{ id: 's1', kind: 'work_session', status: 'running' }] })
    t2.tm8.contexts.set('s1', { id: 's1', kind: 'work_session', status: 'running', title: 'Session', tasks: [], launchedSessions: [] })
    await t2.bridge.poll()
    const s = t2.store.nameByEntity('s1')!
    await t2.bridge.onInbound(mediaIn(t2, { caption: `@tm8 @${s.name} both of you` }))
    assert.equal(t2.tm8.uploads.length, 1)
    const withFile = t2.tm8.posts.filter((p) => p.attach)
    assert.deepEqual(withFile.map((p) => p.to).sort(), ['chat-1', 's1'])
  })

  test('/admin/inject takes a media fixture and routes it like a real one', async () => {
    const t = await withMain({ media: { attach: 'attach' } })
    const r = await t.bridge.injectTest({ text: '@tm8 injected picture', media: { kind: 'image', mime: 'image/png', file_name: 'card.png', data_base64: PNG.toString('base64') } })
    assert.match(r.wa_msg_id, /^TEST-/)
    assert.deepEqual(r.routes, [{ target: 'self-main', status: 'posted' }])
    assert.deepEqual(t.tm8.posts.at(-1)!.attach, ['file-1'])
    assert.equal(t.store.getMessage(r.wa_msg_id)!.text, '[image] @tm8 injected picture')
    await assert.rejects(t.bridge.injectTest({ media: { kind: 'nope', data_base64: 'AA==' } }), (e: HttpError) => e.status === 400)
  })
})

describe('outbound media (/say-media)', () => {
  const file = (data = PNG, fileName: string | null = 'chart.png', mime: string | null = 'image/png') => ({ data, fileName, mime })

  test('an image goes out with the caption prefixed, is logged as "[image] tm8: …" and recorded with its file', async () => {
    const t = await withMain()
    const r = await t.bridge.sayMedia(t.auth(), { file: file(), caption: 'error rate @tm8', idempotency_key: 'm1' })
    assert.equal(r.status, 200)
    assert.equal(r.body.kind, 'image')
    const s = t.wa.sent.at(-1)!
    assert.equal(s.text, 'tm8: error rate @‍tm8')
    assert.deepEqual(s.media, { kind: 'image', mime: 'image/png', fileName: 'chart.png', size: PNG.length })
    const id = r.body.wa_msg_id as string
    const msg = t.store.getMessage(id)!
    assert.equal(msg.text, '[image] tm8: error rate @‍tm8')
    assert.equal(msg.by_name, 'self-main')
    const md = t.store.getMedia(id)!
    assert.equal(md.direction, 'out')
    assert.equal(md.path, `${id}.png`)
    assert.deepEqual(fs.readFileSync(path.join(t.mediaDir, md.path!)), PNG)
    assert.deepEqual(fs.readdirSync(t.mediaDir), [`${id}.png`]) // the out-<uuid> staging file was renamed
    assert.equal(t.bridge.history(t.ch, {}).messages.at(-1)!.media?.kind, 'image')
    assert.deepEqual(fs.readFileSync((await t.bridge.mediaFile(t.ch, id)).path), PNG)
  })

  test('no caption: just the speaker; sessions get "Title (handle):" and the thread rule', async () => {
    const t = await withMain()
    await t.bridge.sayMedia(t.auth(), { file: file(), idempotency_key: 'nc' })
    assert.equal(t.wa.sent.at(-1)!.text, 'tm8:')
    const mainId = t.store.channel('self').main_chat_id!
    t.tm8.contexts.set(mainId, { id: mainId, kind: 'chat', launchedSessions: [{ id: 's1', kind: 'work_session', status: 'running' }] })
    t.tm8.contexts.set('s1', { id: 's1', kind: 'work_session', status: 'running', title: 'x', tasks: [{ id: 'k', title: 'Deploy log check' }], launchedSessions: [] })
    await t.bridge.poll()
    const s = t.store.nameByEntity('s1')!
    const tok = /TOKEN=(wab_\S+)/.exec(t.tm8.posts.find((p) => p.to === 's1')!.body)![1]
    await assert.rejects(t.bridge.sayMedia(t.auth(tok), { file: file(), idempotency_key: 's0' }), (e: HttpError) => e.status === 403)
    await t.bridge.onInbound(inbound({ text: `@${s.name} send the chart` }))
    const addressed = t.store.history('self', 1)[0].wa_msg_id
    const r = await t.bridge.sayMedia(t.auth(tok), { file: file(), caption: 'here', reply_to: addressed, idempotency_key: 's1' })
    assert.equal(r.status, 200)
    assert.equal(t.wa.sent.at(-1)!.text, `Deploy log check (${s.name}): here`)
    assert.equal(t.wa.sent.at(-1)!.quoted, addressed)
  })

  test('kind by mime (PDF → document, sniffed over a wrong part type), explicit kind override, validation errors', async () => {
    const t = await withMain({ media: { maxBytes: 1000 } })
    const a = t.auth()
    const d = await t.bridge.sayMedia(a, { file: file(PDF, 'report.pdf', 'application/octet-stream'), idempotency_key: 'd' })
    assert.equal(d.body.kind, 'document')
    assert.equal(d.body.mime, 'application/pdf')
    assert.equal(t.wa.sent.at(-1)!.media!.fileName, 'report.pdf')
    const forced = await t.bridge.sayMedia(a, { file: file(), kind: 'document', idempotency_key: 'f' })
    assert.equal(forced.body.kind, 'document')
    const named = await t.bridge.sayMedia(a, { file: file(Buffer.from('a,b\n1,2\n'), 'x.csv', 'text/csv'), file_name: '../../etc/data.csv', idempotency_key: 'n' })
    assert.equal(named.body.file_name, 'data.csv')
    assert.equal(named.body.mime, 'text/csv')
    const bad = async (body: any, status: number) =>
      assert.rejects(t.bridge.sayMedia(a, { idempotency_key: `b${Math.random()}`, ...body }), (e: HttpError) => e.status === status)
    await bad({}, 400) // neither file nor tm8_file_id
    await bad({ file: file(), tm8_file_id: '01a153d5-ae33-7961-b90c-f09b9e64ca17' }, 400) // both
    await bad({ file: file(PDF, 'r.pdf', 'application/pdf'), kind: 'image' }, 400)
    await bad({ file: file(), kind: 'video' }, 400)
    await bad({ file: file(), mime: 'not a mime' }, 400)
    await bad({ file: file(Buffer.alloc(0)) }, 400)
    await bad({ file: file(Buffer.alloc(1001, 1), 'big.bin', null) }, 413)
    await bad({ file: file(), caption: 'x'.repeat(4001) }, 400)
    await bad({ tm8_file_id: '../../etc/passwd' }, 400)
    await assert.rejects(t.bridge.sayMedia(a, { file: file() }), (e: HttpError) => e.status === 400) // no idempotency_key
  })

  test('idempotency, queue while disconnected, flush in order with the bytes', async () => {
    const t = await withMain()
    const a = await t.bridge.sayMedia(t.auth(), { file: file(), idempotency_key: 'same' })
    const b = await t.bridge.sayMedia(t.auth(), { file: file(), idempotency_key: 'same' })
    assert.equal(b.body.wa_msg_id, a.body.wa_msg_id)
    assert.equal(b.body.duplicate, true)
    assert.equal(t.wa.sent.length, 1)
    t.wa.up = false
    const q = await t.bridge.sayMedia(t.auth(), { file: file(PDF, 'r.pdf', null), caption: 'later', idempotency_key: 'q1' })
    assert.equal(q.status, 202)
    await t.bridge.say(t.auth(), { text: 'after the pdf', idempotency_key: 'q2' })
    assert.equal(t.bridge.health().queue_depth, 2)
    t.wa.up = true
    await t.bridge.flushQueue()
    assert.deepEqual(t.wa.sent.slice(-2).map((s) => [s.media?.kind ?? 'text', s.text]), [['document', 'tm8: later'], ['text', 'tm8: after the pdf']])
    assert.equal(t.wa.sent.at(-2)!.media!.size, PDF.length)
    assert.equal((await t.bridge.sayMedia(t.auth(), { file: file(), idempotency_key: 'q1' })).status, 200)
  })

  test('rate limit is shared with /say', async () => {
    const t = await withMain({ rateLimits: { perTokenPerMinute: 2, perChannelPerMinute: 100 } })
    await t.bridge.say(t.auth(), { text: 'a', idempotency_key: '1' })
    await t.bridge.sayMedia(t.auth(), { file: file(), idempotency_key: '2' })
    await assert.rejects(t.bridge.sayMedia(t.auth(), { file: file(), idempotency_key: '3' }), (e: HttpError) => e.status === 429)
  })

  test('loop guard: the echo of a media send (early, by caption hash; or later, by id) is never routed', async () => {
    const t = await withMain()
    const orig = t.wa.sendMedia.bind(t.wa)
    t.wa.sendMedia = async (jid, m, q) => {
      // WhatsApp echoes "[image] tm8: …" in the self chat before sendMessage returns.
      await t.bridge.onInbound(inbound({ id: 'EARLY-MEDIA', text: mediaPlaceholder(m.kind, m.caption, m.fileName), kind: 'media', media: { kind: m.kind, mime: m.mime, fileName: null, caption: m.caption, size: m.data.length, ref: 'x' } }))
      return orig(jid, m, q)
    }
    const before = t.tm8.posts.length
    const r = await t.bridge.sayMedia(t.auth(), { file: file(PDF, 'r.pdf', null), caption: 'ask @tm8', idempotency_key: 'e' })
    assert.equal(t.tm8.posts.length, before)
    assert.equal(t.store.getMessage('EARLY-MEDIA')!.from_bridge, 1)
    assert.equal(t.store.getMedia('EARLY-MEDIA'), undefined) // echoes are not downloaded again
    // The later echo under the real id.
    await t.bridge.onInbound(inbound({ id: r.body.wa_msg_id as string, text: '[document] r.pdf tm8: ask @‍tm8' }))
    assert.equal(t.tm8.posts.length, before)
    // The owner's own image with the same caption text later on is theirs.
    await t.bridge.onInbound(mediaIn(t, { caption: 'tm8: ask @tm8' }))
    assert.equal(t.tm8.posts.length, before + 1)
  })

  test('forwarding a tm8 file by id', async () => {
    const t = await withMain()
    t.tm8.files.set('01a153d5-ae33-7961-b90c-f09b9e64ca17', { name: 'diagram.png', mime: 'image/png', data: PNG })
    const r = await t.bridge.sayMedia(t.auth(), { tm8_file_id: '01a153d5-ae33-7961-b90c-f09b9e64ca17', caption: 'fwd', idempotency_key: 'fw' })
    assert.equal(r.status, 200)
    assert.deepEqual(t.wa.sent.at(-1)!.media, { kind: 'image', mime: 'image/png', fileName: 'diagram.png', size: PNG.length })
    assert.equal(t.store.getMedia(r.body.wa_msg_id as string)!.tm8_file_id, '01a153d5-ae33-7961-b90c-f09b9e64ca17')
    await assert.rejects(
      t.bridge.sayMedia(t.auth(), { tm8_file_id: '01a153d5-0000-7961-b90c-f09b9e64ca17', idempotency_key: 'nf' }),
      (e: HttpError) => e.status === 400,
    )
    assert.equal(fs.readdirSync(t.mediaDir).filter((f) => f.startsWith('tmp-')).length, 0)
  })
})

describe('HTTP media endpoints', () => {
  test('multipart /say-media, JSON tm8_file_id, 415 otherwise; GET /media is token- and channel-scoped', async () => {
    const t = await withMain()
    const server = await startHttp(t.bridge, '127.0.0.1', 0)
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const auth = { authorization: `Bearer ${t.mainToken}` }
    try {
      const fd = new FormData()
      fd.set('file', new Blob([PNG], { type: 'image/png' }), 'card.png')
      fd.set('caption', '@tm8 media test')
      fd.set('idempotency_key', 'http-1')
      const r = await fetch(`${base}/say-media`, { method: 'POST', headers: auth, body: fd })
      assert.equal(r.status, 200)
      const j = await r.json()
      assert.equal(j.kind, 'image')
      assert.equal(j.file_name, 'card.png')
      assert.equal(t.wa.sent.at(-1)!.text, 'tm8: @‍tm8 media test')
      assert.equal((await fetch(`${base}/say-media`, { method: 'POST', body: fd })).status, 401)
      assert.equal((await fetch(`${base}/say-media`, { method: 'POST', headers: { ...auth, 'content-type': 'text/plain' }, body: 'x' })).status, 415)
      t.tm8.files.set('01a153d5-ae33-7961-b90c-f09b9e64ca17', { name: 'r.pdf', mime: 'application/pdf', data: PDF })
      const jr = await fetch(`${base}/say-media`, {
        method: 'POST', headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ tm8_file_id: '01a153d5-ae33-7961-b90c-f09b9e64ca17', idempotency_key: 'http-2' }),
      })
      assert.equal(jr.status, 200)
      assert.equal((await jr.json()).kind, 'document')

      // GET /media: bytes for an inbound image in our channel.
      const m = mediaIn(t)
      await t.bridge.onInbound(m)
      const g = await fetch(`${base}/media/${m.id}`, { headers: auth })
      assert.equal(g.status, 200)
      assert.equal(g.headers.get('content-type'), 'image/png')
      assert.match(g.headers.get('content-disposition')!, /^attachment; filename\*=UTF-8''image\.png$/)
      assert.deepEqual(Buffer.from(await g.arrayBuffer()), PNG)
      assert.equal((await fetch(`${base}/media/${m.id}`)).status, 401)
      // Another channel's token can't see it, and can't see ours.
      const infraTok = t.bridge.issueToken('operator', 'infra')
      assert.equal((await fetch(`${base}/media/${m.id}`, { headers: { authorization: `Bearer ${infraTok}` } })).status, 404)
      const gm = mediaIn(t, { chatJid: GROUP, chatAltJid: null, fromMe: false, senderJid: '919999999999@s.whatsapp.net', caption: 'group pic' })
      await t.bridge.onInbound(gm)
      assert.equal((await fetch(`${base}/media/${gm.id}`, { headers: auth })).status, 404)
      assert.equal((await fetch(`${base}/media/${gm.id}`, { headers: { authorization: `Bearer ${infraTok}` } })).status, 200)
      // A text message has no media.
      await t.bridge.onInbound(inbound({ id: 'PLAIN1', text: 'plain' }))
      assert.equal((await fetch(`${base}/media/PLAIN1`, { headers: auth })).status, 404)
    } finally {
      server.close()
    }
  })
})
