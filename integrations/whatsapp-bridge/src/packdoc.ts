// A tm8 doc as one self-contained HTML file for WhatsApp (POST /pack): it opens in any phone's browser, needs no app, and
// reads right-to-left for Arabic. Covers the markdown a pack uses: headings, paragraphs, lists, task boxes, tables,
// quotes, code, rules, bold/italic/code spans and links. Everything the doc says is escaped; only http(s) links are kept.
import type { Lang } from './store.js'

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** Inline markdown on already-escaped text. */
function inline(raw: string): string {
  const codes: string[] = []
  let s = esc(raw).replace(/`([^`]+)`/g, (_, c) => `\u0000${codes.push(c) - 1}\u0000`)
  s = s
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, t, u) => `<a href="${u}">${t}</a>`)
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (_, pre, u) => `${pre}<a href="${u}">${u}</a>`)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*([^*\s][^*]*)\*(?!\w)/g, '$1<em>$2</em>')
    .replace(/(^|[^_\w])_([^_\s][^_]*)_(?!\w)/g, '$1<em>$2</em>')
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[Number(i)]}</code>`)
}

const cells = (line: string) => line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim())

export function markdownToHtml(md: string): string {
  const lines = md.replace(/\r\n?/g, '\n').split('\n')
  const out: string[] = []
  let para: string[] = []
  let list: 'ul' | 'ol' | null = null
  const flushPara = () => {
    if (para.length) out.push(`<p>${para.map(inline).join('<br>')}</p>`)
    para = []
  }
  const closeList = () => {
    if (list) out.push(`</${list}>`)
    list = null
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (/^\s*```/.test(line)) {
      flushPara()
      closeList()
      const code: string[] = []
      while (++i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i])
      out.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`)
      continue
    }
    if (!line.trim()) {
      flushPara()
      closeList()
      continue
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line)
    if (h) {
      flushPara()
      closeList()
      out.push(`<h${h[1].length}>${inline(h[2].replace(/\s*#+\s*$/, ''))}</h${h[1].length}>`)
      continue
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flushPara()
      closeList()
      out.push('<hr>')
      continue
    }
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
      flushPara()
      closeList()
      const head = cells(line)
      i++
      const rows: string[][] = []
      while (i + 1 < lines.length && /^\s*\|.*\|\s*$/.test(lines[i + 1])) rows.push(cells(lines[++i]))
      out.push(
        `<div class="t"><table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>` +
          rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('') +
          '</tbody></table></div>',
      )
      continue
    }
    const q = /^\s*>\s?(.*)$/.exec(line)
    if (q) {
      flushPara()
      closeList()
      out.push(`<blockquote>${inline(q[1])}</blockquote>`)
      continue
    }
    const li = /^\s*(?:([-*+])|(\d+)[.)])\s+(.*)$/.exec(line)
    if (li) {
      flushPara()
      const kind = li[1] ? 'ul' : 'ol'
      if (list !== kind) {
        closeList()
        out.push(`<${kind}>`)
        list = kind
      }
      const box = /^\[([ xX])\]\s+(.*)$/.exec(li[3])
      out.push(box ? `<li class="task">${box[1] === ' ' ? '☐' : '☑'} ${inline(box[2])}</li>` : `<li>${inline(li[3])}</li>`)
      continue
    }
    closeList()
    para.push(line.trim())
  }
  flushPara()
  closeList()
  return out.join('\n')
}

/** The whole file: the doc's title and body, right-to-left when the case is Arabic. */
export function packHtml(o: { title: string; body: string; format: string; lang: Lang }): string {
  const rtl = o.lang === 'ar'
  const body = o.format === 'markdown' || o.format === 'md' ? markdownToHtml(o.body) : `<pre>${esc(o.body)}</pre>`
  // A doc that already starts with its own title doesn't get it twice.
  const title = /^\s*#\s/.test(o.body) ? '' : `<h1>${esc(o.title)}</h1>\n`
  return `<!doctype html>
<html lang="${o.lang}" dir="${rtl ? 'rtl' : 'ltr'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(o.title)}</title>
<style>
body{font:16px/1.55 -apple-system,"Segoe UI",Roboto,"Noto Sans","Noto Sans Arabic",Tahoma,sans-serif;color:#1b1b1b;max-width:760px;margin:0 auto;padding:20px 16px 48px}
h1{font-size:1.5em;margin:.2em 0 .6em}h2{font-size:1.25em;margin:1.4em 0 .4em;border-bottom:1px solid #e3e3e3;padding-bottom:.2em}h3{font-size:1.08em;margin:1.1em 0 .3em}
ul,ol{padding-inline-start:1.4em}li{margin:.25em 0}li.task{list-style:none;margin-inline-start:-1.2em}
.t{overflow-x:auto}table{border-collapse:collapse;width:100%;margin:.6em 0;font-size:.95em}th,td{border:1px solid #d6d6d6;padding:6px 8px;text-align:start;vertical-align:top}th{background:#f4f4f4}
blockquote{margin:.6em 0;padding:.3em .9em;border-inline-start:4px solid #c9a227;background:#fbf7e9}
code{background:#f1f1f1;padding:0 .25em;border-radius:3px;font-size:.92em}pre{background:#f6f6f6;padding:10px;overflow-x:auto;direction:ltr;text-align:left}
a{color:#0b62c4;word-break:break-word}hr{border:0;border-top:1px solid #ddd;margin:1.4em 0}
</style>
</head>
<body>
${title}${body}
</body>
</html>
`
}
