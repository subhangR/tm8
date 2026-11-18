// Text both ways. Outbound: tm8 markdown to Slack mrkdwn (https://api.slack.com/reference/surfaces/formatting), split
// into messages Slack takes whole. Inbound: Slack's escaped text with <@U…>/<#C…>/<url|label> tokens to readable text,
// plus the user ids it mentions.

/** A message part's ceiling. Slack truncates `text` past 40,000 chars and renders long blocks badly; 3,500 reads well. */
export const SPLIT_AT = 3500

const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** tm8 markdown → Slack mrkdwn: bold, italics, strike, links, code, lists, headings, quotes. */
export function toMrkdwn(md: string): string {
  const out: string[] = []
  // Fenced code blocks pass through untouched but escaped; Slack ignores a language after the fence, so drop it.
  const parts = md.replace(/\r\n/g, '\n').split(/(^```[^\n]*\n[\s\S]*?^```[ \t]*$)/m)
  for (const part of parts) {
    const fence = /^```[^\n]*\n([\s\S]*?)```[ \t]*$/.exec(part)
    if (fence) out.push('```\n' + escape(fence[1]!.replace(/\n$/, '')) + '\n```')
    else out.push(inline(part))
  }
  return out.join('')
}

function inline(text: string): string {
  const held: string[] = []
  const hold = (s: string) => `\u0000${held.push(s) - 1}\u0000`
  let s = text
  // Inline code first: nothing inside it is formatting.
  s = s.replace(/`([^`\n]+)`/g, (_, c: string) => hold('`' + escape(c) + '`'))
  // Links and images: <url|label>. A label keeps its own formatting out (Slack would show it raw).
  s = s.replace(/!?\[([^\]\n]*)\]\(\s*<?([^\s)>]+)>?(?:\s+"[^"]*")?\s*\)/g, (_, label: string, url: string) => {
    const l = label.replace(/[*_~`]/g, '').trim()
    return hold(l && l !== url ? `<${url.replace(/[|>]/g, encodeURIComponent)}|${escape(l)}>` : `<${url.replace(/[|>]/g, encodeURIComponent)}>`)
  })
  // Bare autolinks <https://…>.
  s = s.replace(/<(https?:\/\/[^\s>]+)>/g, (_, url: string) => hold(`<${url}>`))
  s = escape(s)
  const lines = s.split('\n').map((line) => {
    // Headings: Slack has none; a bold line reads as one.
    const h = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(line)
    if (h) return `\u0001${h[1]!.replace(/\*\*|__/g, '')}\u0001`
    // Bullets: Slack renders "• " but not "- ".
    const b = /^(\s*)[-*+]\s+(.*)$/.exec(line)
    if (b && !/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) return `${b[1]}• ${b[2]}`
    return line
  })
  s = lines.join('\n')
  s = s.replace(/^(\s*)• \[( |x|X)\]\s+/gm, (_, ind: string, x: string) => `${ind}${x === ' ' ? '☐' : '☑'} `)
  // Bold (** or __) → a placeholder, so the single-star italics below don't eat it.
  s = s.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '\u0001$1\u0001')
  s = s.replace(/(^|[^\w])__(?=\S)([\s\S]*?\S)__(?=[^\w]|$)/g, '$1\u0001$2\u0001')
  // Italics: *x* → _x_ (_x_ is already Slack's).
  s = s.replace(/(^|[^\w*])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?=[^\w*]|$)/g, '$1_$2_')
  // Strike: ~~x~~ → ~x~.
  s = s.replace(/~~(?=\S)([^\n]*?\S)~~/g, '~$1~')
  s = s.replace(/\u0001/g, '*')
  return s.replace(/\u0000(\d+)\u0000/g, (_, i: string) => held[Number(i)]!)
}

/**
 * Splits mrkdwn into parts of at most `max` chars: at a blank line, else a line break, else a space, else hard. A part
 * that cuts a code block closes it, and the next part reopens it.
 */
export function splitMessage(text: string, max = SPLIT_AT): string[] {
  if (text.length <= max) return [text]
  const parts: string[] = []
  let rest = text
  let reopen = false
  while (rest.length) {
    const head = reopen ? '```\n' : ''
    const budget = max - head.length - 4 // room to close a code block
    if (head.length + rest.length <= max) {
      parts.push(head + rest)
      break
    }
    let cut = rest.lastIndexOf('\n\n', budget)
    if (cut < budget / 2) cut = rest.lastIndexOf('\n', budget)
    if (cut < budget / 2) cut = rest.lastIndexOf(' ', budget)
    if (cut < budget / 2) cut = budget
    let piece = rest.slice(0, cut)
    rest = rest.slice(cut).replace(/^\s+/, '')
    const fences: number = (piece.match(/^```/gm) ?? []).length + (reopen ? 1 : 0)
    const open: boolean = fences % 2 === 1
    piece = head + piece.replace(/\s+$/, '')
    if (open) piece += '\n```'
    parts.push(piece)
    reopen = open
  }
  return parts.filter((p) => p.trim().length)
}

/** Slack text → readable text and the user ids it mentions. `nameOf` answers a user id's display name, if known. */
export function fromSlackText(text: string, nameOf: (userId: string) => string | null = () => null): { body: string; mentions: string[] } {
  const mentions: string[] = []
  const body = (text ?? '').replace(/<([^<>]+)>/g, (_, inner: string) => {
    const [target, label] = splitOnce(inner, '|')
    if (target.startsWith('@')) {
      const id = target.slice(1)
      if (/^[UW][A-Z0-9]+$/.test(id) && !mentions.includes(id)) mentions.push(id)
      return `@${label ?? nameOf(id) ?? id}`
    }
    if (target.startsWith('#')) return `#${label ?? target.slice(1)}`
    if (target.startsWith('!subteam^')) return label ?? '@group'
    if (target.startsWith('!date^')) return label ?? ''
    if (target.startsWith('!')) return `@${target.slice(1)}`
    if (target.startsWith('mailto:')) return label ?? target.slice(7)
    return label && label !== target ? `${label} (${target})` : target
  })
  return { body: body.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'), mentions }
}

function splitOnce(s: string, sep: string): [string, string | undefined] {
  const i = s.indexOf(sep)
  return i < 0 ? [s, undefined] : [s.slice(0, i), s.slice(i + 1)]
}
