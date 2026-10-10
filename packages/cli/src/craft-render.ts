/**
 * Text for a craft (migration 304, renamed to craft by 322) — the two places a craft
 * is read from the CLI, both listing its PAGES in page order:
 *
 *   - `tm8 entity context <craft>`: the server's v2 `pages` field (id, kind,
 *     title, status, position), capped at 50 with an `omitted[]` entry past it.
 *     The description is the `assignment` body and prints there.
 *   - `tm8 entity get <craft>`: the detail's `content.pages` (each the page
 *     entity's summary plus `pagePosition`). Human text is the summary line
 *     plus the page list; the bounded json projection keeps one small row per
 *     page instead of every summary.
 */

type Row = Record<string, unknown>;

const isRow = (v: unknown): v is Row => typeof v === 'object' && v !== null && !Array.isArray(v);
const rows = (v: unknown): Row[] => (Array.isArray(v) ? v.filter(isRow) : []);
const str = (v: unknown): string => (v === null || v === undefined ? '-' : String(v));

function positionText(v: unknown): string {
  return typeof v === 'number' && Number.isFinite(v) ? `#${v}` : '#-';
}

/** One page line: position, kind, title, id. */
function pageLine(position: unknown, kind: unknown, title: unknown, id: unknown, tail = ''): string {
  return `  ${positionText(position)} ${str(kind)} ${str(title)} ${str(id)}${tail}`;
}

/** `tm8 entity context <craft>`: the v2 `pages` field. */
export function craftContextLines(pages: unknown): string[] {
  const list = rows(pages);
  const out = [`pages (${list.length}):`];
  for (const p of list) {
    out.push(p['unreadable'] === true
      ? pageLine(p['position'], '?', '(unreadable)', p['id'])
      : pageLine(p['position'], p['kind'], p['title'], p['id'],
        (p['titleTruncated'] === true ? ' [title truncated]' : '') + (p['deleted'] === true ? ' (deleted)' : '')));
  }
  if (list.length === 0) out.push('  (none — add one with `tm8 collection add <craft-id> <entity-id>`)');
  return out;
}

/** The bounded projection of `content.pages`: one small row per page. */
export function craftPageRows(pages: unknown): Row[] {
  return rows(pages).map((p) => ({
    position: typeof p['pagePosition'] === 'number' ? p['pagePosition'] : null,
    kind: p['kind'],
    title: p['title'],
    id: p['id'],
  }));
}

/** `tm8 entity get <craft>` in text: the summary line, then the page list. */
export function renderCraftDetail(dto: Row, summaryLine: string): string {
  const content = isRow(dto['content']) ? dto['content'] : {};
  if (!Array.isArray(content['pages'])) return summaryLine;
  return [summaryLine, ...craftContextLines(craftPageRows(content['pages']))].join('\n');
}
