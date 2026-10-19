// Bridge configuration (config.json). Channels are the only chats the bridge routes and may send to.
import fs from 'node:fs'
import path from 'node:path'

export type ChannelConfig = {
  /** Short stable id, used in names (`<id>-main`) and the envelope. */
  id: string
  /** The chat JID we send to: a group (`…@g.us`) or our own number for the self chat. */
  jid: string
  /** Other JIDs the same chat arrives under (the self chat also arrives as our LID). */
  altJids?: string[]
  title: string
  /** Teammate for the main chat (default: config.tm8.defaultTeammate). */
  teammate?: string
  model?: string
  /** Pre-set main chat; used instead of creating one. */
  mainChatId?: string | null
  /** WA JIDs allowed to trigger agents. `"owner"` expands to config.ownerJids. Default `["owner"]`. */
  allowedSenders?: string[]
  /**
   * This channel's tm8 space (default: the global tm8 block). With only `spaceId`, calls go with the global token and
   * `--space <spaceId>` (through a space link); `tokenFile` gives the channel its own token. tokenFile is absolute after load.
   */
  tm8?: ChannelTm8Override
}

export type ChannelTm8Override = { spaceId?: string; tokenFile?: string; defaultTeammate?: string; defaultModel?: string }
/** A channel's effective tm8 settings: its own `tm8` block over the global one. */
export type ChannelTm8 = { spaceId: string; tokenFile: string; defaultTeammate: string; defaultModel: string }

export type Config = {
  pairingPhone?: string
  ownerJids: string[]
  http: { host: string; port: number; publicUrl: string }
  tm8: {
    baseUrl: string
    spaceId: string
    cliPath: string
    tokenFile: string
    defaultTeammate: string
    defaultModel: string
    pollSeconds: number
  }
  watchdogMinutes: number
  maxRouteAgeMinutes: number
  rateLimits: { perTokenPerMinute: number; perChannelPerMinute: number }
  /**
   * Images, documents and audio, both directions. maxBytes caps downloads and uploads. `attach`: how a routed file reaches
   * tm8. "reference" (default) uploads it and puts the tm8 file id in the envelope; "attach" also passes it as
   * `message send --attach`, which tm8 chat turns currently fail on (runtime_lost), see OPERATIONS.md › Media.
   */
  media: { maxBytes: number; attach: 'reference' | 'attach' }
  /** Voice-note transcription. provider "local" = whisper.cpp in the container; "none" = off; "openai" is reserved. */
  transcription: TranscriptionConfig
  channels: ChannelConfig[]
}

export type TranscriptionConfig = {
  provider: 'local' | 'none' | 'openai'
  /** whisper.cpp model file under modelsDir (multilingual; scripts/fetch-model.sh downloads it). */
  model: string
  modelsDir: string
  whisperBin: string
  ffmpegBin: string
  threads: number
  /** whisper language: "auto" detects per note. */
  language: string
  /** Longer audio is not transcribed. */
  maxDurationSec: number
  /** How long routing waits for a transcript before posting without it (the transcript then follows as its own message). */
  waitSeconds: number
}

export const DEFAULTS: Omit<Config, 'channels' | 'ownerJids'> = {
  http: { host: '127.0.0.1', port: 8787, publicUrl: 'http://127.0.0.1:8787' },
  tm8: {
    baseUrl: 'http://127.0.0.1:17777',
    spaceId: '01a0fb3d-558e-7d92-b370-d0601112607a',
    cliPath: '/opt/tm8/prod/packages/cli/dist/tm8',
    tokenFile: 'secrets/tm8-token',
    defaultTeammate: '01a0fb41-3317-77f3-b2b5-2bba3e489f4d',
    defaultModel: 'claude-opus-5-5',
    pollSeconds: 10,
  },
  watchdogMinutes: 10,
  maxRouteAgeMinutes: 10,
  rateLimits: { perTokenPerMinute: 20, perChannelPerMinute: 30 },
  media: { maxBytes: 25 * 1024 * 1024, attach: 'reference' },
  transcription: {
    provider: 'local',
    model: 'ggml-small-q5_1.bin',
    modelsDir: 'data/models',
    whisperBin: 'whisper-cli',
    ffmpegBin: 'ffmpeg',
    threads: 4,
    language: 'auto',
    maxDurationSec: 600,
    waitSeconds: 20,
  },
}

const ID_RE = /^[a-z][a-z0-9-]{0,30}$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const CHANNEL_TM8_KEYS = ['spaceId', 'tokenFile', 'defaultTeammate', 'defaultModel']

function checkChannelTm8(ch: ChannelConfig, root: string) {
  if (ch.tm8 === undefined || ch.tm8 === null) return void delete ch.tm8
  const o = ch.tm8 as Record<string, unknown>
  if (typeof o !== 'object' || Array.isArray(o)) throw new Error(`channel ${ch.id}: tm8 must be an object`)
  for (const k of Object.keys(o)) {
    if (!CHANNEL_TM8_KEYS.includes(k)) throw new Error(`channel ${ch.id}: tm8.${k} can't be set per channel (allowed: ${CHANNEL_TM8_KEYS.join(', ')})`)
    if (typeof o[k] !== 'string' || !(o[k] as string).trim()) throw new Error(`channel ${ch.id}: tm8.${k} must be a non-empty string`)
  }
  if (o.spaceId !== undefined && !UUID_RE.test(o.spaceId as string)) throw new Error(`channel ${ch.id}: tm8.spaceId must be a tm8 space id`)
  if (o.tokenFile !== undefined) ch.tm8 = { ...ch.tm8, tokenFile: path.resolve(root, o.tokenFile as string) }
}

/** A channel's tm8 settings: each field from its `tm8` block, else the global tm8 block. */
export function channelTm8(cfg: Config, ch: ChannelConfig): ChannelTm8 {
  const o = ch.tm8 ?? {}
  return {
    spaceId: o.spaceId ?? cfg.tm8.spaceId,
    tokenFile: o.tokenFile ?? cfg.tm8.tokenFile,
    defaultTeammate: o.defaultTeammate ?? cfg.tm8.defaultTeammate,
    defaultModel: o.defaultModel ?? cfg.tm8.defaultModel,
  }
}

export function parseConfig(raw: any, root: string): Config {
  const cfg: Config = {
    ...DEFAULTS,
    ...raw,
    http: { ...DEFAULTS.http, ...raw?.http },
    tm8: { ...DEFAULTS.tm8, ...raw?.tm8 },
    rateLimits: { ...DEFAULTS.rateLimits, ...raw?.rateLimits },
    media: { ...DEFAULTS.media, ...raw?.media },
    transcription: { ...DEFAULTS.transcription, ...raw?.transcription },
    ownerJids: raw?.ownerJids ?? [],
    channels: raw?.channels ?? [],
  }
  if (!raw?.http?.publicUrl) cfg.http.publicUrl = `http://${cfg.http.host}:${cfg.http.port}`
  cfg.tm8.tokenFile = path.resolve(root, cfg.tm8.tokenFile)
  if (!['reference', 'attach'].includes(cfg.media.attach)) throw new Error('media.attach must be "reference" or "attach"')
  const t = cfg.transcription
  if (!['local', 'none', 'openai'].includes(t.provider)) throw new Error('transcription.provider must be "local", "none" or "openai"')
  if (!/^[\w.-]+$/.test(t.model)) throw new Error('transcription.model must be a file name under transcription.modelsDir')
  for (const k of ['threads', 'maxDurationSec', 'waitSeconds'] as const) {
    if (!Number.isFinite(t[k]) || t[k] < 0) throw new Error(`transcription.${k} must be a non-negative number`)
  }
  const seen = new Set<string>()
  for (const ch of cfg.channels) {
    if (!ID_RE.test(ch.id)) throw new Error(`channel id ${JSON.stringify(ch.id)} must match ${ID_RE}`)
    if (seen.has(ch.id)) throw new Error(`duplicate channel id ${ch.id}`)
    seen.add(ch.id)
    if (!/@(g\.us|s\.whatsapp\.net)$/.test(ch.jid)) throw new Error(`channel ${ch.id}: jid must be a group or a user JID`)
    if (!ch.jid.endsWith('@g.us') && !cfg.ownerJids.includes(ch.jid)) {
      throw new Error(`channel ${ch.id}: a non-group channel must be our own number (the self chat)`)
    }
    checkChannelTm8(ch, root)
  }
  return cfg
}

export function loadConfig(root: string): Config {
  const file = process.env.WA_BRIDGE_CONFIG ?? path.join(root, 'config.json')
  return parseConfig(JSON.parse(fs.readFileSync(file, 'utf8')), root)
}

/** JIDs allowed to trigger agents in a channel, with `owner` expanded. */
export function allowedSenders(cfg: Config, ch: ChannelConfig): Set<string> {
  const out = new Set<string>()
  for (const s of ch.allowedSenders ?? ['owner']) {
    if (s === 'owner') cfg.ownerJids.forEach((j) => out.add(j))
    else out.add(s)
  }
  return out
}
