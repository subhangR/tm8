import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, test } from 'node:test'
import type { Inbound } from '../src/core.js'
import { audioLabel, durationLabel, isAudio, mediaPlaceholder, sniffMime, type InboundMedia } from '../src/media.js'
import {
  LocalWhisper,
  NoneTranscriber,
  TimeoutError,
  TooLongError,
  transcribeTimeoutMs,
  type TranscribeOptions,
  type Transcriber,
  type TranscriptResult,
} from '../src/transcribe.js'
import { WaConnection, mediaOf, textOf } from '../src/wa.js'
import { OWNER, OWNER_LID, inbound, withMain } from './helpers.js'

const OGG = Buffer.concat([Buffer.from('OggS'), Buffer.alloc(200, 1)])
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

/** A transcriber that answers from a script; `gate` holds every run until released. */
class StubStt implements Transcriber {
  provider = 'stub'
  enabled = true
  calls: { path: string; o: TranscribeOptions }[] = []
  result: TranscriptResult | Error = { text: 'namaste bhai, kal milte hain at five', lang: 'hi', durationSec: 12 }
  private release: (() => void) | null = null
  private gate: Promise<void> | null = null
  hold() {
    this.gate = new Promise((r) => (this.release = r))
  }
  open() {
    this.release?.()
    this.gate = null
  }
  async transcribe(p: string, o: TranscribeOptions) {
    this.calls.push({ path: p, o })
    if (this.gate) await this.gate
    if (this.result instanceof Error) throw this.result
    return this.result
  }
}

type T = Awaited<ReturnType<typeof withMain>>
let n = 0
/** An inbound voice note served by the fake WhatsApp under ref `ref-<id>`. */
function voiceIn(t: T, p: Partial<Inbound> & { bytes?: Buffer | Error; seconds?: number | null; ptt?: boolean; mime?: string; fileName?: string | null } = {}): Inbound {
  const id = p.id ?? `VOICE${++n}`
  const bytes = p.bytes ?? OGG
  t.wa.downloads.set(`ref-${id}`, bytes)
  const media: InboundMedia = {
    kind: 'audio', mime: p.mime ?? 'audio/ogg; codecs=opus', fileName: p.fileName ?? null, caption: null,
    size: bytes instanceof Buffer ? bytes.length : 100, ref: `ref-${id}`, durationSec: p.seconds === undefined ? 12 : p.seconds, ptt: p.ptt ?? true,
  }
  const { bytes: _b, seconds: _s, ptt: _p, mime: _m, fileName: _f, ...rest } = p
  return inbound({ id, text: mediaPlaceholder('audio', null, media.fileName, media), kind: 'media', media, ...rest })
}

/** A bridge message to reply to (so a voice note, which has no caption, gets routed). */
async function bridgeMsg(t: T) {
  const r = await t.bridge.say(t.auth(), { text: 'send me a voice note', idempotency_key: `k${++n}` })
  return r.body.wa_msg_id as string
}

const settle = () => new Promise((r) => setTimeout(r, 20))

describe('audio helpers', () => {
  test('duration labels, placeholders, audio detection, timeouts', () => {
    assert.equal(durationLabel(0), '0:00')
    assert.equal(durationLabel(12), '0:12')
    assert.equal(durationLabel(65.4), '1:05')
    assert.equal(durationLabel(3725), '1:02:05')
    assert.equal(durationLabel(null), null)
    assert.equal(durationLabel(-1), null)
    assert.equal(mediaPlaceholder('audio', null, null, { durationSec: 12, ptt: true }), '[voice note 0:12]')
    assert.equal(mediaPlaceholder('audio', null, null, { ptt: true }), '[voice note]')
    assert.equal(mediaPlaceholder('audio', null, 'song.mp3', { durationSec: 200 }), '[audio song.mp3]')
    assert.equal(mediaPlaceholder('audio', 'ignored', null, { durationSec: 65 }), '[audio 1:05]')
    assert.equal(mediaPlaceholder('audio', null), '[audio]')
    assert.equal(audioLabel({ ptt: true, durationSec: 5, fileName: 'x.ogg' }), 'voice note 0:05')
    assert.ok(isAudio('audio', null))
    assert.ok(isAudio('document', 'audio/mpeg'))
    assert.ok(!isAudio('document', 'application/pdf'))
    assert.ok(!isAudio('image', 'image/png'))
    assert.equal(sniffMime(OGG), 'audio/ogg')
    assert.equal(transcribeTimeoutMs(12, 600), 54_000)
    assert.equal(transcribeTimeoutMs(null, 600), 1_230_000)
    assert.equal(transcribeTimeoutMs(0, 60), 150_000)
  })

  test('Baileys audioMessage parse: voice note vs audio file, and the quoted message media a reply carries', async () => {
    const ptt = { audioMessage: { mimetype: 'audio/ogg; codecs=opus', seconds: 12, ptt: true, fileLength: 5076 } }
    assert.deepEqual(mediaOf(ptt as any), { kind: 'audio', mime: 'audio/ogg; codecs=opus', fileName: null, caption: null, size: 5076, durationSec: 12, ptt: true })
    assert.equal(textOf(ptt as any), '[voice note 0:12]')
    assert.equal(textOf({ audioMessage: { mimetype: 'audio/mpeg', seconds: 95, ptt: false } } as any), '[audio 1:35]')
    assert.equal(textOf({ ephemeralMessage: { message: ptt } } as any), '[voice note 0:12]')

    const t = await withMain()
    const conn = new WaConnection(t.bridge, { authDir: '/nonexistent', dataDir: '/tmp', allowLink: false })
    const reply = {
      key: { remoteJid: OWNER_LID, id: 'REPLY1', fromMe: true },
      messageTimestamp: 1792408967,
      message: {
        extendedTextMessage: {
          text: '@tm8 listen to this',
          contextInfo: { stanzaId: 'ACF2DE84', participant: OWNER_LID, quotedMessage: { audioMessage: { mimetype: 'audio/ogg; codecs=opus', seconds: 5, ptt: true, mediaKey: Buffer.from('k') } } },
        },
      },
    }
    const m: Inbound = (conn as any).toInbound(reply)
    assert.equal(m.quotedId, 'ACF2DE84')
    assert.equal(m.quotedMedia?.kind, 'audio')
    assert.equal(m.quotedMedia?.durationSec, 5)
    assert.equal(m.quotedMedia?.ptt, true)
    const ref = JSON.parse(m.quotedMedia!.ref!)
    assert.equal(ref.key.id, 'ACF2DE84')
    assert.equal(ref.key.fromMe, true)
    assert.ok(ref.message.audioMessage.mediaKey, 'media key survives in the reference')
  })
})

describe('inbound voice notes', () => {
  test('a voice note replying to the bridge is downloaded, transcribed, referenced and its transcript is in the envelope, log, FTS and API', async () => {
    const stt = new StubStt()
    const t = await withMain({ transcriber: stt })
    const q = await bridgeMsg(t)
    const m = voiceIn(t, { quotedId: q })
    await t.bridge.onInbound(m)
    const row = t.store.getMedia(m.id)!
    assert.equal(row.status, 'downloaded')
    assert.equal(row.path, `${m.id}.ogg`)
    assert.equal(row.duration_sec, 12)
    assert.equal(row.ptt, 1)
    assert.equal(row.transcript_status, 'done')
    assert.equal(row.transcript_lang, 'hi')
    assert.equal(row.transcript_provider, 'stub')
    assert.equal(stt.calls.length, 1)
    assert.equal(stt.calls[0].o.timeoutMs, 54_000)
    assert.equal(stt.calls[0].o.maxDurationSec, 600)
    const post = t.tm8.posts.at(-1)!
    assert.equal(post.to, 'chat-1')
    assert.equal(post.attach, undefined)
    assert.match(post.body, /\[attachment: voice note 0:12 · audio\/ogg; codecs=opus · 204 B · tm8 file file-1 \(tm8 file download file-1 --output <path>\) · bytes also at GET \/media\/VOICE\d+\]/)
    assert.match(post.body, /\n\[transcript \(auto, hi\): namaste bhai, kal milte hain at five\]\n/)
    assert.match(post.body, /---\n\[voice note 0:12\]$/)
    assert.equal(t.tm8.uploads[0].mime, 'audio/ogg; codecs=opus')
    assert.equal(t.store.getMessage(m.id)!.text, '[voice note 0:12] transcript: namaste bhai, kal milte hain at five')
    assert.equal(t.bridge.search(t.ch, { q: 'milte' }).messages[0]?.wa_msg_id, m.id)
    const h = t.bridge.message(t.ch, m.id).message.media as any
    assert.equal(h.duration_sec, 12)
    assert.equal(h.voice_note, true)
    assert.deepEqual(h.transcript, { status: 'done', text: 'namaste bhai, kal milte hain at five', lang: 'hi', provider: 'stub', error: null })
    assert.equal((t.bridge.history(t.ch, {}).messages.at(-1)!.media as any).transcript.lang, 'hi')
  })

  test('unrouted voice notes are transcribed too (FTS), one at a time', async () => {
    const stt = new StubStt()
    stt.hold()
    const t = await withMain({ transcriber: stt })
    const a = voiceIn(t)
    const b = voiceIn(t, { seconds: 3 })
    await t.bridge.onInbound(a)
    await t.bridge.onInbound(b)
    await settle()
    assert.equal(stt.calls.length, 1, 'second waits for the first')
    stt.open()
    await t.bridge.transcribe(b.id)
    assert.equal(stt.calls.length, 2)
    assert.equal(t.store.getMedia(b.id)!.transcript_status, 'done')
    assert.equal(t.tm8.uploads.length, 0, 'unrouted: not uploaded')
    assert.equal(t.bridge.search(t.ch, { q: 'namaste' }).messages.length, 2)
  })

  test('slow transcription: routes after waitSeconds without it, then sends the transcript as a follow-up to the same target', async () => {
    const stt = new StubStt()
    stt.hold()
    const t = await withMain({ transcriber: stt, transcription: { waitSeconds: 0.05 } })
    const q = await bridgeMsg(t)
    const m = voiceIn(t, { quotedId: q })
    await t.bridge.onInbound(m)
    const post = t.tm8.posts.at(-1)!
    assert.match(post.body, /\[transcript: still running; it will follow as a separate message\]/)
    assert.match(post.body, /\[attachment: voice note 0:12/)
    const before = t.tm8.posts.length
    stt.open()
    await t.bridge.transcribe(m.id)
    await settle()
    assert.equal(t.tm8.posts.length, before + 1)
    const f = t.tm8.posts.at(-1)!
    assert.equal(f.to, 'chat-1')
    assert.match(f.body, new RegExp(`^\\[whatsapp transcript · to: self-main · for wa_msg_id ${m.id}, routed to you earlier\\]\\n\\[transcript \\(auto, hi\\): namaste`))
  })

  test('a failed transcription says so in the envelope (and in the follow-up); routing still happens', async () => {
    const stt = new StubStt()
    stt.result = new TimeoutError(54_000)
    const t = await withMain({ transcriber: stt })
    const m = voiceIn(t, { quotedId: await bridgeMsg(t) })
    await t.bridge.onInbound(m)
    assert.equal(t.store.getMedia(m.id)!.transcript_status, 'failed')
    assert.match(t.tm8.posts.at(-1)!.body, /\[transcript: failed \(transcription timed out after 54 s\)\]/)
    assert.equal(t.store.getMessage(m.id)!.text, '[voice note 0:12]')
  })

  test('over the max duration: not transcribed, envelope says why', async () => {
    const stt = new StubStt()
    const t = await withMain({ transcriber: stt, transcription: { maxDurationSec: 60 } })
    const m = voiceIn(t, { seconds: 61, quotedId: await bridgeMsg(t) })
    await t.bridge.onInbound(m)
    assert.equal(stt.calls.length, 0)
    assert.equal(t.store.getMedia(m.id)!.transcript_status, 'too_long')
    assert.match(t.tm8.posts.at(-1)!.body, /\[transcript: none, the audio is longer than the 1:00 limit\]/)
  })

  test('provider "none": audio is still downloaded and referenced, with no transcript line', async () => {
    const t = await withMain({ transcriber: new NoneTranscriber(), transcription: { provider: 'none' } })
    const m = voiceIn(t, { quotedId: await bridgeMsg(t) })
    await t.bridge.onInbound(m)
    const row = t.store.getMedia(m.id)!
    assert.equal(row.transcript_status, 'disabled')
    assert.equal(row.transcript_provider, 'none')
    const post = t.tm8.posts.at(-1)!
    assert.match(post.body, /\[attachment: voice note 0:12 · .* tm8 file file-1/)
    assert.doesNotMatch(post.body, /transcript/)
    assert.equal((t.bridge.message(t.ch, m.id).message.media as any).transcript.status, 'disabled')
    // Turned on later: a disabled one is transcribed when next asked.
    t.bridge.transcriber = new StubStt()
    assert.equal((await t.bridge.transcribe(m.id))!.transcript_status, 'done')
  })

  test('a regular audio file (not ptt) is labelled by name or length', async () => {
    const t = await withMain({ transcriber: new StubStt() })
    const m = voiceIn(t, { ptt: false, fileName: null, seconds: 95, mime: 'audio/mpeg', quotedId: await bridgeMsg(t) })
    assert.equal(m.text, '[audio 1:35]')
    await t.bridge.onInbound(m)
    assert.match(t.tm8.posts.at(-1)!.body, /\[attachment: audio 1:35 · audio\/mpeg/)
    assert.equal(t.store.getMedia(m.id)!.path, `${m.id}.mp3`)
  })
})

describe('quoted media', () => {
  test('quoting an earlier voice note with @tm8 attaches it, with its transcript, marked as from the quoted message', async () => {
    const stt = new StubStt()
    const t = await withMain({ transcriber: stt })
    const vn = voiceIn(t, { seconds: 5 })
    await t.bridge.onInbound(vn) // unrouted: no caption, no quote
    assert.equal(t.tm8.posts.length, 0)
    await t.bridge.onInbound(inbound({ text: '@tm8 this voice message also needs to be received', quotedId: vn.id }))
    const post = t.tm8.posts.at(-1)!
    assert.match(post.body, new RegExp(`\\[quoted: Subhang "\\[voice note 0:05\\] transcript: namaste bhai`))
    assert.match(post.body, new RegExp(`\\[quoted attachment, from the quoted message ${vn.id}: voice note 0:05 · audio/ogg; codecs=opus · 204 B · tm8 file file-1 \\(tm8 file download file-1 --output <path>\\) · bytes also at GET /media/${vn.id}\\]`))
    assert.match(post.body, /\[transcript of the quoted voice note 0:05 \(auto, hi\): namaste bhai, kal milte hain at five\]/)
    assert.equal(t.tm8.uploads.length, 1)
    assert.equal(stt.calls.length, 1, 'already transcribed, not again')
  })

  test('quoted media the bridge never logged is logged from the reply, downloaded and attached (attach mode passes both files)', async () => {
    const t = await withMain({ transcriber: new StubStt(), media: { attach: 'attach' } })
    t.wa.downloads.set('ref-OLDIMG', PNG)
    const quotedMedia: InboundMedia = { kind: 'image', mime: 'image/png', fileName: null, caption: 'old photo', size: PNG.length, ref: 'ref-OLDIMG' }
    const m = voiceIn(t, { quotedId: 'OLDIMG', quotedMedia, quotedSenderJid: OWNER })
    // A voice note quoting a non-bridge message isn't routed; a text with @tm8 is.
    await t.bridge.onInbound(m)
    assert.equal(t.tm8.posts.length, 0)
    await t.bridge.onInbound(inbound({ text: '@tm8 what is in this photo?', quotedId: 'OLDIMG', quotedMedia, quotedSenderJid: OWNER }))
    const msg = t.store.getMessage('OLDIMG')!
    assert.equal(msg.text, '[image] old photo')
    assert.equal(msg.from_me, 1)
    assert.equal(t.store.getMedia('OLDIMG')!.status, 'downloaded')
    const post = t.tm8.posts.at(-1)!
    assert.match(post.body, /\[quoted attachment, from the quoted message OLDIMG: image · image\/png · \d+ B · attached as tm8 file file-1/)
    assert.deepEqual(post.attach, ['file-1'])
    // A captioned image that also quotes the voice note: both files ride along.
    t.wa.downloads.set('ref-NEWIMG', PNG)
    await t.bridge.onInbound(inbound({
      id: 'NEWIMG', text: '[image] @tm8 and this', kind: 'media', quotedId: m.id,
      media: { kind: 'image', mime: 'image/png', fileName: null, caption: '@tm8 and this', size: PNG.length, ref: 'ref-NEWIMG' },
    }))
    assert.deepEqual(t.tm8.posts.at(-1)!.attach, ['file-2', 'file-3'])
  })

  test('a quoted voice note whose media key expired: "could not be downloaded", still routed', async () => {
    const t = await withMain({ transcriber: new StubStt() })
    const vn = voiceIn(t, { seconds: 5, bytes: new Error('media key expired (410)') })
    await t.bridge.onInbound(vn)
    assert.equal(t.store.getMedia(vn.id)!.status, 'failed')
    await t.bridge.onInbound(inbound({ text: '@tm8 hear this', quotedId: vn.id }))
    assert.equal(t.wa.downloadCalls.filter((r) => r === `ref-${vn.id}`).length, 2, 'retried when quoted')
    const post = t.tm8.posts.at(-1)!
    assert.match(post.body, new RegExp(`\\[quoted attachment, from the quoted message ${vn.id}: quoted voice note 0:05 could not be downloaded \\(media key expired \\(410\\)\\); GET /media/${vn.id} retries\\]`))
    assert.doesNotMatch(post.body, /transcript/)
    assert.equal(t.store.routesFor(t.store.getMessage(post.body.match(/wa_msg_id (\S+)\]/)![1])!.wa_msg_id)[0].status, 'posted')
  })

  test('backfill: a voice note logged before transcription existed (no duration, never transcribed) works when quoted', async () => {
    const stt = new StubStt()
    stt.result = { text: 'hello hello', lang: 'en', durationSec: 3.2 }
    const t = await withMain({ transcriber: stt })
    // As the live log has it: "[audio]", downloaded, no duration/ptt/transcript columns set.
    t.store.insertMessage({ wa_msg_id: 'ACF2', channel_id: 'self', chat_jid: OWNER_LID, sender_jid: OWNER, sender_alt_jid: OWNER_LID, sender_name: 'Subhang',
      text: '[audio]', quoted_wa_msg_id: null, ts: 1, from_me: 1, from_bridge: 0, key_json: null, message_json: null })
    t.store.insertMedia({ wa_msg_id: 'ACF2', channel_id: 'self', direction: 'in', kind: 'audio', mime: 'audio/ogg; codecs=opus', file_name: null, caption: null, declared_size: OGG.length, ref_json: 'ref-x' })
    t.store.updateMedia('ACF2', { status: 'downloaded', path: t.bridge.media.write('ACF2.ogg', OGG), size: OGG.length })
    const quotedMedia: InboundMedia = { kind: 'audio', mime: 'audio/ogg; codecs=opus', fileName: null, caption: null, size: OGG.length, ref: 'ref-y', durationSec: 3, ptt: true }
    await t.bridge.onInbound(inbound({ text: '@tm8 this voice message also needs to be received', quotedId: 'ACF2', quotedMedia }))
    const post = t.tm8.posts.at(-1)!
    assert.match(post.body, /\[quoted attachment, from the quoted message ACF2: voice note 0:03 · audio\/ogg; codecs=opus/)
    assert.match(post.body, /\[transcript of the quoted voice note 0:03 \(auto, en\): hello hello\]/)
    assert.equal(t.store.getMessage('ACF2')!.text, '[voice note 0:03] transcript: hello hello')
    assert.equal(t.store.getMedia('ACF2')!.ref_json, 'ref-x', 'existing reference kept')
  })

  test('a failed transcription is retried when the voice note is quoted', async () => {
    const stt = new StubStt()
    stt.result = new Error('whisper-cli exited 1')
    const t = await withMain({ transcriber: stt })
    const vn = voiceIn(t)
    await t.bridge.onInbound(vn)
    await t.bridge.transcribe(vn.id)
    assert.equal(t.store.getMedia(vn.id)!.transcript_status, 'failed')
    stt.result = { text: 'second try', lang: 'en', durationSec: 12 }
    await t.bridge.onInbound(inbound({ text: '@tm8 again', quotedId: vn.id }))
    assert.equal(stt.calls.length, 2)
    assert.match(t.tm8.posts.at(-1)!.body, /\[transcript of the quoted voice note 0:12 \(auto, en\): second try\]/)
  })

  test('the inject hook takes an audio fixture with duration and ptt', async () => {
    const t = await withMain({ transcriber: new StubStt() })
    const q = await bridgeMsg(t)
    const r = await t.bridge.injectTest({ text: '', quoted_wa_msg_id: q, media: { kind: 'audio', mime: 'audio/ogg; codecs=opus', duration_sec: 7, ptt: true, data_base64: OGG.toString('base64') } })
    assert.deepEqual(r.routes, [{ target: 'self-main', status: 'posted' }])
    assert.match(t.tm8.posts.at(-1)!.body, /\[attachment: voice note 0:07 · audio\/ogg; codecs=opus/)
  })
})

describe('LocalWhisper (with stand-in ffmpeg/whisper-cli scripts)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wab-stt-'))
  const model = path.join(dir, 'model.bin')
  fs.writeFileSync(model, 'x')
  const audio = path.join(dir, 'in.ogg')
  fs.writeFileSync(audio, OGG)
  /** ffmpeg stand-in: writes a WAV of `seconds` (16 kHz mono s16) to its last argument. */
  const ffmpeg = (seconds: number) => script(`ffmpeg-${seconds}`, `head -c ${44 + seconds * 32000} /dev/zero > "\${@: -1}"`)
  /** whisper-cli stand-in: writes <-of>.json after `sleep` seconds. */
  const whisper = (sleep: number, json = '{"result":{"language":"hi"},"transcription":[{"text":" namaste"},{"text":"  bhai "}]}') =>
    script(`whisper-${sleep}`, `out=""; while [ $# -gt 0 ]; do [ "$1" = "-of" ] && out="$2"; shift; done; sleep ${sleep}; echo '${json}' > "$out.json"`)
  function script(name: string, body: string) {
    const p = path.join(dir, name)
    fs.writeFileSync(p, `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 })
    return p
  }
  const lw = (ffmpegBin: string, whisperBin: string, modelPath = model) => new LocalWhisper({ modelPath, whisperBin, ffmpegBin, threads: 2, language: 'auto', tmpDir: dir })

  test('decodes, runs whisper, joins segments and reads the language', async () => {
    const r = await lw(ffmpeg(2), whisper(0)).transcribe(audio, { timeoutMs: 10_000, maxDurationSec: 600 })
    assert.deepEqual(r, { text: 'namaste bhai', lang: 'hi', durationSec: 2 })
    assert.deepEqual(fs.readdirSync(dir).filter((f) => f.startsWith('wa-stt-')), [], 'temp dir cleaned up')
  })

  test('times out (kills whisper) after timeoutMs', async () => {
    const t0 = Date.now()
    await assert.rejects(lw(ffmpeg(1), whisper(5)).transcribe(audio, { timeoutMs: 300, maxDurationSec: 600 }), (e) => e instanceof TimeoutError)
    assert.ok(Date.now() - t0 < 3000)
  })

  test('refuses audio longer than maxDurationSec, and a missing model', async () => {
    await assert.rejects(lw(ffmpeg(4), whisper(0)).transcribe(audio, { timeoutMs: 10_000, maxDurationSec: 3 }), (e) => e instanceof TooLongError)
    const missing = lw(ffmpeg(1), whisper(0), path.join(dir, 'nope.bin'))
    assert.match(missing.problem()!, /not found \(run scripts\/fetch-model.sh\)/)
    await assert.rejects(missing.transcribe(audio, { timeoutMs: 1000, maxDurationSec: 60 }), /not found/)
  })

  test('a failing decoder is reported with its exit code', async () => {
    await assert.rejects(lw(script('ffmpeg-bad', 'echo "Invalid data found" >&2; exit 1'), whisper(0)).transcribe(audio, { timeoutMs: 5000, maxDurationSec: 60 }), /ffmpeg-bad exited 1: Invalid data found/)
  })
})
