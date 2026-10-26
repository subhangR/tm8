// Pure text helpers: mention and command parsing, outbound mention escaping, names, tokens, rate limits.
import crypto from 'node:crypto'

/** What the main chat and the bridge's own notices start with in WhatsApp. */
export const MAIN_PREFIX = 'tm8:'
const ZWJ = '‍'

/** A mention found in message text: `@tm8`, `@tm8-<teammate>` or `@<handle>`. */
export type Mention = { kind: 'tm8'; teammate?: string } | { kind: 'handle'; handle: string }

// `@word` at the start or after whitespace/punctuation, so e-mail addresses don't count.
const MENTION_RE = /(^|[\s([{,;:!?"'“‘])@([A-Za-z0-9][A-Za-z0-9-]*)/g

export function parseMentions(text: string): Mention[] {
  const out: Mention[] = []
  const seen = new Set<string>()
  for (const m of text.matchAll(MENTION_RE)) {
    const word = m[2].toLowerCase().replace(/-+$/, '')
    // Bare numbers are WhatsApp's rendering of real @mentions of people; those come via mentionedJid.
    if (!word || /^\d+$/.test(word) || seen.has(word)) continue
    seen.add(word)
    if (word === 'tm8') out.push({ kind: 'tm8' })
    else if (word.startsWith('tm8-')) out.push({ kind: 'tm8', teammate: word.slice(4) })
    else out.push({ kind: 'handle', handle: word })
  }
  return out
}

export type Command =
  | { cmd: 'who' | 'help' | 'new' }
  | { cmd: 'status' | 'stop'; name: string }

/** Strict command parse: the whole message is one allow-listed command, nothing else. */
export function parseCommand(text: string): Command | null {
  const m = /^\/(who|status|stop|new|help)(?:\s+@?([a-z0-9][a-z0-9-]{0,40}))?$/i.exec(text.trim())
  if (!m) return null
  const cmd = m[1].toLowerCase() as Command['cmd']
  const arg = m[2]?.toLowerCase()
  if (cmd === 'status' || cmd === 'stop') return arg ? { cmd, name: arg } : null
  return arg ? null : { cmd }
}

/** Second loop guard: break every outbound `@word` with a zero-width joiner so it can't trigger us. */
export function escapeMentions(text: string): string {
  return text.replace(/@(?=[A-Za-z0-9])/g, '@' + ZWJ)
}

/**
 * The line people see in WhatsApp. Main chats, the bridge and operators speak as `tm8: <text>`; a session speaks as
 * `<title> (<handle>): <text>` (just `<handle>: <text>` until it has a title). Plain text, no emoji.
 */
export function speakerLine(speaker: { kind: 'main' } | { kind: 'session'; handle: string; title: string | null }, text: string): string {
  if (speaker.kind === 'main') return `${MAIN_PREFIX} ${escapeMentions(text)}`
  return escapeMentions(`${titled(speaker.title, speaker.handle)}: ${text}`)
}

/** `Title (handle)`, or the bare handle when there's no title. */
export function titled(title: string | null | undefined, handle: string): string {
  return title ? `${title} (${handle})` : handle
}

const TITLE_STOPWORDS = new Set(['a', 'an', 'and', 'the', 'of', 'for', 'to', 'in', 'on', 'with', 'or', 'by', 'at', 'from', 'via', 'into'])

/** A 3–4 word title from a task or session title: drop brackets and punctuation, keep ≤4 words, no dangling stopword. */
export function shortTitle(s: string | null | undefined, maxWords = 4): string | null {
  if (!s) return null
  const words = s
    .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
    .replace(/[^\p{L}\p{N}'’.+#-]+/gu, ' ')
    .split(/\s+/)
    .map((w) => w.replace(/^[-.']+|[-.']+$/g, ''))
    .filter(Boolean)
    .slice(0, maxWords)
  while (words.length > 1 && TITLE_STOPWORDS.has(words.at(-1)!.toLowerCase())) words.pop()
  if (words.length === 0) return null
  const t = words.join(' ').slice(0, 40).trim()
  return t.charAt(0).toUpperCase() + t.slice(1)
}

/** Validate a session's own `label`: 1–4 words, ≤40 chars, plain text. Returns the cleaned label or an error. */
export function cleanLabel(raw: unknown): { label: string } | { error: string } {
  if (typeof raw !== 'string') return { error: 'label must be a string' }
  const t = raw.replace(/[\u0000-\u001f\u200b-\u200f\u2028\u2029]/g, '').replace(/\s+/g, ' ').trim()
  if (!t) return { error: 'label must not be empty' }
  if (t.split(' ').length > 4 || t.length > 40) return { error: 'label is limited to 4 words and 40 characters' }
  if (/[@:()]/.test(t)) return { error: 'label must not contain @, : or parentheses' }
  return { label: t }
}

/** Hash of an exact message body (for matching our own echoes). */
export function bodyHash(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex')
}

export function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

/** Resolve `@tm8-<hint>` against teammate titles: exact slug, then prefix, then substring. */
export function matchTeammate<T extends { id: string; title: string }>(hint: string, teammates: T[]): T | null {
  const h = slug(hint)
  if (!h) return null
  const slugs = teammates.map((t) => ({ t, s: slug(t.title) }))
  return (
    slugs.find((x) => x.s === h)?.t ??
    slugs.find((x) => x.s.startsWith(h))?.t ??
    slugs.find((x) => x.s.split('-').includes(h))?.t ??
    slugs.find((x) => x.s.includes(h))?.t ??
    null
  )
}

export function newToken(): string {
  return 'wab_' + crypto.randomBytes(32).toString('base64url')
}

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex')
}

/** Extract the `tm8s_…` token from a file that may hold extra text. */
export function extractTm8Token(content: string): string | null {
  return /tm8s_[A-Za-z0-9_\-.]+/.exec(content)?.[0] ?? null
}

const ADJECTIVES = [
  'amber', 'azure', 'bold', 'brave', 'brisk', 'calm', 'clever', 'coral', 'cosmic', 'crimson',
  'curious', 'dapper', 'daring', 'deft', 'eager', 'early', 'ember', 'fancy', 'fleet', 'frosty',
  'gentle', 'gilded', 'glad', 'golden', 'grand', 'happy', 'hazel', 'humble', 'indigo', 'ivory',
  'jade', 'jolly', 'keen', 'kind', 'lively', 'lucky', 'lunar', 'mellow', 'merry', 'misty',
  'nimble', 'noble', 'olive', 'patient', 'plucky', 'polar', 'proud', 'quick', 'quiet', 'rapid',
  'rosy', 'ruby', 'rustic', 'sage', 'scarlet', 'shiny', 'silent', 'silver', 'smart', 'snowy',
  'solar', 'steady', 'sunny', 'swift', 'teal', 'tidy', 'topaz', 'velvet', 'vivid', 'witty',
]
const ANIMALS = [
  'badger', 'bat', 'bear', 'beaver', 'bison', 'bobcat', 'crane', 'crow', 'deer', 'dolphin',
  'eagle', 'egret', 'falcon', 'ferret', 'finch', 'fox', 'gecko', 'gibbon', 'goose', 'hare',
  'hawk', 'heron', 'ibis', 'jackal', 'jaguar', 'koala', 'lark', 'lemur', 'leopard', 'lynx',
  'magpie', 'marmot', 'marten', 'mole', 'moose', 'newt', 'ocelot', 'orca', 'osprey', 'otter',
  'owl', 'panda', 'panther', 'parrot', 'pelican', 'penguin', 'puffin', 'quail', 'rabbit', 'raven',
  'robin', 'salmon', 'seal', 'shrike', 'sparrow', 'stoat', 'swan', 'tapir', 'tiger', 'toucan',
  'turtle', 'viper', 'walrus', 'weasel', 'whale', 'wolf', 'wombat', 'wren', 'yak', 'zebra',
]

/** A fresh adjective-animal name not in `taken`; falls back to a numeric suffix once the grid fills. */
export function generateName(taken: (name: string) => boolean, rand: () => number = Math.random): string {
  const pick = <T>(a: T[]) => a[Math.floor(rand() * a.length)]
  for (let i = 0; i < 200; i++) {
    const n = `${pick(ADJECTIVES)}-${pick(ANIMALS)}`
    if (!taken(n) && !RESERVED.has(n)) return n
  }
  for (let i = 2; ; i++) {
    const n = `${pick(ADJECTIVES)}-${pick(ANIMALS)}-${i}`
    if (!taken(n)) return n
  }
}

/** Handles that can never be a name: they are triggers or commands. */
export const RESERVED = new Set(['tm8', 'bridge', 'operator', 'all', 'everyone', 'here', 'who', 'status', 'stop', 'new', 'help'])

/** Sliding-window limiter keyed by string. */
export class RateLimiter {
  private hits = new Map<string, number[]>()
  constructor(private limit: number, private windowMs: number, private now: () => number = Date.now) {}
  /** Returns 0 if allowed (and records the hit), else ms until a slot frees. */
  take(key: string): number {
    const t = this.now()
    const arr = (this.hits.get(key) ?? []).filter((x) => x > t - this.windowMs)
    if (arr.length >= this.limit) {
      this.hits.set(key, arr)
      return arr[0] + this.windowMs - t
    }
    arr.push(t)
    this.hits.set(key, arr)
    return 0
  }
}

/**
 * The text an agent ended its chat turn with: the text parts after its last tool call or result (what came before is
 * narration: "Checking…", "Sending now…"). Consecutive parts of one item are joined as is, separate items by a blank line.
 */
export function finalTurnText(parts: { seq: number; kind: string; payload: string }[]): string {
  const sorted = [...parts].sort((a, b) => a.seq - b.seq)
  let last = -1
  sorted.forEach((p, i) => {
    if (p.kind === 'tool_call' || p.kind === 'tool_result') last = i
  })
  let out = ''
  let item: string | null | undefined
  for (const p of sorted.slice(last + 1)) {
    if (p.kind !== 'text') continue
    let t: { text?: unknown; itemId?: unknown }
    try {
      t = JSON.parse(p.payload)
    } catch {
      continue
    }
    if (typeof t?.text !== 'string') continue
    const id = typeof t.itemId === 'string' ? t.itemId : null
    out += out && (id === null || id !== item) ? '\n\n' + t.text : t.text
    item = id
  }
  return out.trim()
}

/** Strings that look like credentials: never relayed to a group. */
const SECRET_PATTERNS = [
  /wab_[A-Za-z0-9_-]{16,}/, // bridge speaker tokens
  /tm8s_[A-Za-z0-9_.-]{12,}/, // tm8 tokens
  /sk-(ant-)?[A-Za-z0-9_-]{20,}/, // API keys
  /\bgh[pousr]_[A-Za-z0-9]{20,}/, /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bAKIA[0-9A-Z]{16}\b/, /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, // JWTs
]
export function looksSecret(text: string): boolean {
  return SECRET_PATTERNS.some((r) => r.test(text))
}

/** Markdown an agent writes, as WhatsApp shows it: **bold** → *bold*, "## Heading" → *Heading*. */
export function whatsappText(text: string): string {
  return text.replace(/\*\*([^*\n]+)\*\*/g, '*$1*').replace(/^#{1,6}\s+(.+)$/gm, '*$1*')
}

/** The wa_msg_id of a bridge envelope ("[whatsapp "<group>" · … · wa_msg_id <id>]"), or null for anything else. */
export function envelopeWaId(body: string): string | null {
  const first = body.split('\n', 1)[0]
  if (!first.startsWith('[whatsapp "')) return null
  return /· wa_msg_id (\S+)\]$/.exec(first)?.[1] ?? null
}

/** Arabic script letters (Arabic, Supplement, Extended-A, presentation forms). */
const ARABIC_RE = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/g
const LATIN_RE = /[A-Za-z]/g

/** The language a person wrote in: Arabic when Arabic letters are at least as many as Latin ones, else English. */
export function detectLang(text: string | null | undefined): 'ar' | 'en' {
  const t = text ?? ''
  const ar = t.match(ARABIC_RE)?.length ?? 0
  const lat = t.match(LATIN_RE)?.length ?? 0
  return ar > 0 && ar >= lat ? 'ar' : 'en'
}

/** Arabic-Indic and Eastern Arabic-Indic digits as ASCII, so an Arabic "3" counts as 3 in a numbered answer. */
export function asciiDigits(s: string): string {
  return s.replace(/[\u0660-\u0669\u06F0-\u06F9]/g, (d) => String(d.charCodeAt(0) & 0xf))
}
