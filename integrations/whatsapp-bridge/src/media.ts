// Media helpers: kinds, placeholders, mime sniffing, safe file names, the on-disk media directory.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export type MediaKind = 'image' | 'document' | 'video' | 'audio' | 'sticker'

/** What an inbound media message carries before its bytes are downloaded. */
export type InboundMedia = {
  kind: MediaKind
  mime: string | null
  fileName: string | null
  caption: string | null
  /** Size WhatsApp declares (fileLength), if any. */
  size: number | null
  /** Opaque download reference for the WhatsApp adapter (serialized message); null when `data` is given. */
  ref: string | null
  /** Bytes already in hand (the admin inject fixture); skips the download. */
  data?: Buffer
  /** Audio: length WhatsApp declares (audioMessage.seconds), if any. */
  durationSec?: number | null
  /** Audio: a push-to-talk voice note (audioMessage.ptt) rather than an audio file. */
  ptt?: boolean
}

/** Thrown when media is bigger than the configured cap. */
export class TooLargeError extends Error {
  constructor(public size: number, public max: number) {
    super(`media is ${size} bytes, over the ${max} byte limit`)
  }
}

/** Images WhatsApp shows inline; everything else goes out as a document. */
export const IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp'])
/** WhatsApp's own limit for image messages. */
export const MAX_IMAGE_BYTES = 16 * 1024 * 1024

/**
 * The text a media message has in the log and FTS, and what the WhatsApp echo of our own send looks like (the loop guard
 * hashes this): `[image] caption`, `[document] name caption`, `[voice note 0:12]`, `[audio name]`, `[sticker]`.
 */
export function mediaPlaceholder(
  kind: MediaKind,
  caption: string | null | undefined,
  fileName?: string | null,
  audio?: { durationSec?: number | null; ptt?: boolean },
): string {
  if (kind === 'audio') return `[${audioLabel({ fileName, durationSec: audio?.durationSec, ptt: audio?.ptt })}]`
  const parts = [`[${kind}]`]
  if (kind === 'document' && fileName) parts.push(fileName)
  if (caption && kind !== 'sticker') parts.push(caption)
  return parts.join(' ')
}

/** `voice note 0:12`, `audio name.mp3`, `audio 1:05`, or just `voice note` / `audio` when nothing is known. */
export function audioLabel(a: { fileName?: string | null; durationSec?: number | null; ptt?: boolean | null }): string {
  const dur = durationLabel(a.durationSec)
  if (a.ptt) return dur ? `voice note ${dur}` : 'voice note'
  if (a.fileName) return `audio ${a.fileName}`
  return dur ? `audio ${dur}` : 'audio'
}

/** Seconds as m:ss (or h:mm:ss); null for unknown, negative or non-finite. */
export function durationLabel(sec: number | null | undefined): string | null {
  if (sec === null || sec === undefined || !Number.isFinite(sec) || sec < 0) return null
  const t = Math.round(sec)
  const h = Math.floor(t / 3600)
  const m = Math.floor((t % 3600) / 60)
  const s = String(t % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`
}

/** True for media worth transcribing: audio messages, and documents that are audio files. */
export function isAudio(kind: string, mime: string | null | undefined): boolean {
  return kind === 'audio' || (kind === 'document' && /^audio\//i.test(mime ?? ''))
}

const EXT: Record<string, string> = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/heic': 'heic',
  'video/mp4': 'mp4', 'video/3gpp': '3gp', 'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/aac': 'aac',
  'audio/amr': 'amr', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/webm': 'weba', 'audio/opus': 'opus', 'audio/flac': 'flac',
  'application/pdf': 'pdf', 'text/plain': 'txt', 'text/csv': 'csv', 'application/json': 'json', 'application/zip': 'zip',
  'application/msword': 'doc', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-powerpoint': 'ppt', 'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
}
const MIME_BY_EXT = Object.fromEntries(Object.entries(EXT).map(([m, e]) => [e, m]))
MIME_BY_EXT.jpeg = 'image/jpeg'
MIME_BY_EXT.md = 'text/markdown'

export function extFor(mime: string | null | undefined, fileName?: string | null): string {
  const base = (mime ?? '').split(';')[0].trim().toLowerCase()
  if (EXT[base]) return EXT[base]
  const fromName = /\.([A-Za-z0-9]{1,8})$/.exec(fileName ?? '')?.[1]?.toLowerCase()
  return fromName ?? 'bin'
}

export function mimeFromName(fileName: string | null | undefined): string | null {
  const e = /\.([A-Za-z0-9]{1,8})$/.exec(fileName ?? '')?.[1]?.toLowerCase()
  return e ? (MIME_BY_EXT[e] ?? null) : null
}

/** Mime from magic bytes, for the formats where it matters (images, PDF). */
export function sniffMime(b: Buffer): string | null {
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'image/webp'
  if (b.length >= 6 && /^GIF8[79]a$/.test(b.toString('latin1', 0, 6))) return 'image/gif'
  if (b.length >= 5 && b.toString('latin1', 0, 5) === '%PDF-') return 'application/pdf'
  if (b.length >= 4 && b.toString('latin1', 0, 4) === 'OggS') return 'audio/ogg'
  return null
}

export const MIME_RE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,127}$/

/** A file name that is safe to show and to send: no paths, no control characters, ≤100 chars. */
export function safeFileName(raw: string | null | undefined, fallback: string): string {
  const base = (raw ?? '').split(/[\\/]/).pop() ?? ''
  const t = base.replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028\u2029"<>|*?:]/g, '').replace(/\s+/g, ' ').trim().replace(/^\.+/, '')
  if (!t) return fallback
  if (t.length <= 100) return t
  const ext = /\.[A-Za-z0-9]{1,8}$/.exec(t)?.[0] ?? ''
  return t.slice(0, 100 - ext.length) + ext
}

/** On-disk store under data/media: `<wa_msg_id>.<ext>` for logged media, `out-<uuid>.<ext>` for queued sends. */
export class MediaDir {
  constructor(public dir: string) {}
  private ensure() {
    fs.mkdirSync(this.dir, { recursive: true })
  }
  /** File name (relative to the dir) for a WhatsApp message id. */
  nameFor(waId: string, ext: string): string {
    return `${waId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80)}.${ext.replace(/[^a-z0-9]/gi, '').slice(0, 8) || 'bin'}`
  }
  write(rel: string, data: Buffer): string {
    this.ensure()
    const abs = this.abs(rel)
    const tmp = `${abs}.tmp-${crypto.randomBytes(4).toString('hex')}`
    fs.writeFileSync(tmp, data, { mode: 0o640 })
    fs.renameSync(tmp, abs)
    return rel
  }
  /** A fresh path for a file the tm8 CLI downloads into. */
  tmpPath(ext: string): string {
    this.ensure()
    return this.abs(`tmp-${crypto.randomUUID()}.${ext}`)
  }
  abs(rel: string): string {
    const abs = path.resolve(this.dir, rel)
    if (path.dirname(abs) !== path.resolve(this.dir)) throw new Error(`bad media path ${rel}`)
    return abs
  }
  read(rel: string): Buffer {
    return fs.readFileSync(this.abs(rel))
  }
  exists(rel: string): boolean {
    return fs.existsSync(this.abs(rel))
  }
  rename(from: string, to: string) {
    fs.renameSync(this.abs(from), this.abs(to))
  }
}

/** A stable UUID-shaped mutation id from a string, so a retried upload replays instead of duplicating. */
export function stableUuid(s: string): string {
  const h = crypto.createHash('sha256').update(s).digest('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${((parseInt(h[16], 16) & 3) | 8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`
}

export function humanSize(n: number | null | undefined): string {
  if (n === null || n === undefined) return '? bytes'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}
