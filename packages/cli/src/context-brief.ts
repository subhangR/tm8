/**
 * The text brief for `tm8 entity context` under `tm8.entity-context.v2`
 * (c761 §4 "Text brief", §8).
 *
 * THE RULE (c761 Q20): the brief is LOSSLESS ON MARKERS. Everything JSON uses
 * to say "this is not the whole story" prints here as visibly as it does there:
 *   - `assignment.complete:false`, with the whole body's bytes and its expand;
 *   - every `omitted[]` entry (`more`, `kept`, `reason`) with its expand;
 *   - every `notLoaded[]` entry with its expand;
 *   - `errors[]` — and `errors: none` when there are none, so an absent line
 *     can never be mistaken for an empty list;
 *   - `unreadable`, `deleted`, `titleTruncated`, `truncated`, `redacted`.
 * Expands print VERBATIM: they are commands the reader copies, never prose.
 *
 * The body prints whole (what arrived of it). Text mode printing no body was
 * defect 1 of c761 §1, the reason an agent re-read with `entity get`.
 *
 * Fields the brief does not know yet are printed as `key: value` rather than
 * dropped, so a DTO addition is never silently invisible in text.
 */

import { escapeXml } from '@tm8/prompt';

type Row = Record<string, unknown>;

const isRow = (v: unknown): v is Row => typeof v === 'object' && v !== null && !Array.isArray(v);
const rows = (v: unknown): Row[] => (Array.isArray(v) ? v.filter(isRow) : []);
const str = (v: unknown): string => (v === null || v === undefined ? '-' : String(v));

/** `2026-09-23T16:27:44.016Z` → `2026-09-23T16:27Z`. Anything else unchanged. */
function minute(at: unknown): string {
  const s = str(at);
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?Z$/.exec(s);
  return m ? `${m[1]}Z` : s;
}

const bytesOf = (n: unknown): string => (typeof n === 'number' ? `${n.toLocaleString('en-US')} B` : `${str(n)} B`);

/** A ref row: `<id> <kind> [<status>] <title>` plus its markers. */
function refLine(ref: unknown): string {
  if (!isRow(ref)) return str(ref);
  if (ref['unreadable'] === true) return `${str(ref['id'])} (unreadable)`;
  const parts = [str(ref['id'])];
  if (ref['kind'] !== undefined) parts.push(str(ref['kind']));
  if (ref['status'] !== undefined) parts.push(`[${str(ref['status'])}]`);
  if (ref['title'] !== undefined) parts.push(str(ref['title']) + (ref['titleTruncated'] === true ? ' [title truncated]' : ''));
  if (ref['deleted'] === true) parts.push('(deleted)');
  if (ref['resolved'] === false) parts.push('(unresolved)');
  return parts.join(' ');
}

function messageLine(m: Row): string {
  const from = str(m['from']) + (m['fromTruncated'] === true ? ' [from truncated]' : '');
  const head = `${minute(m['at'])} ${str(m['id'])} ${from}`
    + (m['replyTo'] !== undefined ? ` ↩${str(m['replyTo'])}` : '')
    + (m['toMe'] === true ? ' (to you)' : '');
  if (m['redacted'] === true) return `${head}: [redacted]`;
  return `${head}: ${str(m['text'])}${m['truncated'] === true ? ' [truncated]' : ''}`;
}

function gateText(gate: unknown): string[] {
  if (gate === undefined) return [];
  if (!isRow(gate)) return [`gate ${str(gate)}`];
  const prs = rows(gate['prs']);
  return [
    `gate ${str(gate['kind'])} (${prs.length} PR${prs.length === 1 ? '' : 's'}${gate['more'] === true ? ', more' : ''})`,
    ...prs.map((pr) => (pr['unreadable'] === true
      ? `  ${str(pr['id'])} (unreadable)`
      : `  ${str(pr['url'])} [${str(pr['state'])}] ci ${str(pr['ci'])}`)),
  ];
}

/**
 * A header as text. Its text is graph content, so it prints inside an
 * `untrusted_data` block, never as bare lines a reader could take as
 * instructions; the control fields (source, version, stale) print outside.
 */
export function renderHeaderLines(header: Record<string, unknown>): string[] {
  const version = Number(header['version'] ?? 0);
  const keywords = Array.isArray(header['keywords']) ? header['keywords'].map(String) : [];
  return [
    `header: ${String(header['source'] ?? '-')}`
      + (version > 0 ? ` v${version}` : ' (none authored: --expect-version 0)')
      + (header['stale'] === true ? ` · stale (written for v${String(header['pinnedVersion'])})` : '')
      + (header['bytes'] == null ? '' : ` · body ${String(header['bytes'])} B`),
    // Escaped as the prompt escapes it (@tm8/prompt escape.ts), or authored
    // text reading `</untrusted_data>` would end the block it is in.
    '<untrusted_data type="entry-header" encoding="escaped-utf8">',
    ...(header['whenToUse'] == null ? [] : [`when to use: ${escapeXml(String(header['whenToUse']))}`]),
    ...(header['summary'] == null ? [] : [`summary: ${escapeXml(String(header['summary']))}`]),
    ...(keywords.length === 0 ? [] : [`keywords: ${keywords.map(escapeXml).join(', ')}`]),
    '</untrusted_data>',
  ];
}

/** Keys rendered by name below; anything else falls through to `key: value`. */
const KNOWN = new Set([
  'schemaVersion', 'id', 'kind', 'title', 'version', 'status', 'asOfSeq', 'priority', 'gate', 'assignees',
  'header', 'parent', 'assignment', 'acceptance', 'acceptanceWrite', 'blockers', 'children', 'outline', 'outlineTruncated', 'tasks',
  'anchor', 'parentMessage', 'attachments', 'connections', 'messages', 'omitted', 'notLoaded', 'errors', 'budget',
]);

export function renderContextBrief(view: Row): string {
  const out: string[] = [];
  const gate = gateText(view['gate']);
  out.push([
    `${str(view['kind'])} ${str(view['id'])} v${str(view['version'])}`,
    str(view['status']),
    ...(view['priority'] !== undefined ? [`priority ${str(view['priority'])}`] : []),
    ...(gate.length > 0 ? [gate[0]!] : []),
  ].join(' · '));
  out.push(...gate.slice(1));
  out.push(`title: ${str(view['title'])}`);

  // Per-kind scalars (session, chat, project…): printed, never dropped.
  for (const [key, value] of Object.entries(view)) {
    if (KNOWN.has(key) || isRow(value) || Array.isArray(value)) continue;
    out.push(`${key}: ${str(value)}`);
  }

  for (const a of rows(view['assignees'])) {
    out.push(`assignee: ${str(a['name'])}${a['you'] === true ? ' (you)' : ''} ${str(a['id'])}`
      + (a['by'] !== undefined ? ` · by ${str(a['by'])}` : '')
      + (a['at'] !== undefined ? ` ${minute(a['at'])}` : ''));
  }
  if (isRow(view['header'])) out.push(...renderHeaderLines(view['header']));
  if ('parent' in view) out.push(`parent: ${view['parent'] === null ? 'none' : refLine(view['parent'])}`);
  if (view['anchor'] !== undefined) out.push(`anchor: ${refLine(view['anchor'])}`);
  if ('parentMessage' in view) out.push(`reply to: ${view['parentMessage'] === null ? 'none' : refLine(view['parentMessage'])}`);

  const blockers = rows(view['blockers']);
  if (view['blockers'] !== undefined) {
    out.push(`blockers: ${blockers.length === 0 ? 'none' : String(blockers.length)} · seq ${str(view['asOfSeq'])}`);
    for (const b of blockers) out.push(`  ${refLine(b)}`);
  } else {
    out.push(`seq ${str(view['asOfSeq'])}`);
  }

  if (view['acceptance'] !== undefined) {
    const criteria = rows(view['acceptance']);
    out.push(`acceptance ${criteria.filter((c) => c['done'] === true).length}/${criteria.length}:`);
    for (const c of criteria) out.push(`  [${c['done'] === true ? 'x' : ' '}] ${str(c['id'])} ${str(c['text'])}`);
    const write = view['acceptanceWrite'];
    if (isRow(write)) out.push(`  tick: ${str(write['write'])}`);
  }
  for (const [key, label] of [['tasks', 'tasks'], ['children', 'children']] as const) {
    if (view[key] === undefined) continue;
    const list = rows(view[key]);
    out.push(`${label} (${list.length}):`);
    for (const r of list) out.push(`  ${refLine(r)}`);
  }
  if (view['connections'] !== undefined) {
    const list = rows(view['connections']);
    out.push(`connections (${list.length}):`);
    for (const c of list) {
      out.push(`  ${str(c['type'])} ${c['dir'] === 'in' ? '←' : '→'} ${refLine(c['other'])}`
        + (c['resolved'] === undefined ? '' : ` (resolved: ${str(c['resolved'])})`));
    }
  }
  if (view['attachments'] !== undefined) {
    const list = rows(view['attachments']);
    out.push(`attachments (${list.length}):`);
    for (const f of list) out.push(`  ${str(f['id'])} ${str(f['name'])} ${f['bytes'] === null ? '? B' : bytesOf(f['bytes'])}`);
  }
  if (view['messages'] !== undefined) {
    const list = rows(view['messages']);
    const more = rows(view['omitted']).some((o) => o['section'] === 'messages' && o['more'] === true);
    out.push(`messages (${list.length}${more ? ' of more' : ''}; oldest first):`);
    for (const m of list) out.push(`  ${messageLine(m)}`);
  }
  if (view['outline'] !== undefined) {
    const list = rows(view['outline']);
    out.push(`outline (${list.length}${view['outlineTruncated'] === true ? ', truncated' : ''}):`);
    for (const h of list) out.push(`  ${'#'.repeat(Number(h['level']) || 1)} ${str(h['text'])} @${str(h['offset'])}`);
  }

  const assignment = view['assignment'];
  if (isRow(assignment)) {
    const complete = assignment['complete'] === true;
    const offset = assignment['offset'] !== undefined ? ` · from offset ${str(assignment['offset'])}` : '';
    out.push(`--- assignment (${bytesOf(assignment['bytes'])}, ${complete ? 'complete' : 'complete:false, cut'}${offset}) ---`);
    out.push(str(assignment['text']).replace(/\n$/, ''));
    out.push(complete ? '---' : `--- continue: ${str(assignment['expand'])}`);
  }

  const more = rows(view['omitted']).map((o) => {
    const detail = [`kept ${str(o['kept'])}`, ...(o['more'] === true ? ['more'] : []),
      ...(o['totalAtLeast'] !== undefined ? [`≥${str(o['totalAtLeast'])}`] : []), str(o['reason'])].join(', ');
    return `${str(o['section'])} (${detail}) → ${o['expand'] === undefined ? '(no expand)' : str(o['expand'])}`;
  });
  const notLoaded = rows(view['notLoaded']).map((n) =>
    `${str(n['section'])} → ${n['expand'] === undefined ? '(no expand)' : str(n['expand'])}`);
  const block = (label: string, lines: string[]): void => {
    if (lines.length === 0) return;
    const pad = ' '.repeat(label.length + 2);
    out.push(`${label}: ${lines[0]!}`, ...lines.slice(1).map((l) => `${pad}${l}`));
  };
  block('more', more);
  block('not loaded', notLoaded);
  const errors = rows(view['errors']);
  if (errors.length === 0) out.push('errors: none');
  else block('errors', errors.map((e) => `${str(e['section'])} ${str(e['code'])}${e['retry'] === true ? ' (retry)' : ''}`));
  if (isRow(view['budget'])) {
    out.push(`budget: ${bytesOf(view['budget']['used'])} of ${bytesOf(view['budget']['requested'])}`);
  }
  return out.join('\n');
}
