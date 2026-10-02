/**
 * Text for a story (migration 283, task 01a0fbf9) — the two places a story is
 * read from the CLI:
 *
 *   - `tm8 entity context <story>`: the server's v2 `story` section, a bounded
 *     projection of the page (state, roots, counts by kind, blocked rows,
 *     sessions with call signs, team by mode, child stories). The description
 *     is the `assignment` body and prints there.
 *   - `tm8 entity get <story>`: the detail, whose `content.page` is the whole
 *     computed page. Human text is a summary plus the page's COUNTS, never the
 *     page itself; `--format json` has it.
 *
 * Both read only what the server computed. Nothing here re-derives progress:
 * the figures are `StoryState` / `StoryProgress` as sent (packages/contract
 * src/story.ts), with `taskProgress` as the headline (the lead's ruling) and
 * `rollup` beside it once child stories exist.
 */

type Row = Record<string, unknown>;

const isRow = (v: unknown): v is Row => typeof v === 'object' && v !== null && !Array.isArray(v);
const rows = (v: unknown): Row[] => (Array.isArray(v) ? v.filter(isRow) : []);
const str = (v: unknown): string => (v === null || v === undefined ? '-' : String(v));
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const len = (v: unknown): number => (Array.isArray(v) ? v.length : 0);

/** Any ISO instant (a `Z` or a `+05:30` offset) → `2026-10-02T12:10Z`. Anything else unchanged. */
function minute(at: unknown): string {
  const s = str(at);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s)) return s;
  const ms = Date.parse(s);
  return Number.isNaN(ms) ? s : `${new Date(ms).toISOString().slice(0, 16)}Z`;
}

/** `7 of 18 done · 5 in progress · 6 to do · 3 blocked` (zero buckets dropped). */
export function progressText(p: unknown, noun = ''): string {
  if (!isRow(p)) return '-';
  const of = `${num(p['done'])} of ${num(p['work'])}${noun === '' ? '' : ` ${noun}`} done`;
  const rest = [
    ['inProgress', 'in progress'], ['toDo', 'to do'], ['blocked', 'blocked'], ['cancelled', 'cancelled'],
  ].filter(([key]) => num(p[key!]) > 0).map(([key, label]) => `${num(p[key!])} ${label}`);
  return [of, ...rest].join(' · ');
}

/** `[working]`, or `[working/in_progress]` when the category says more than the key. */
function statusTag(status: unknown, category: unknown): string {
  if (status == null && category == null) return '';
  if (status == null) return ` [${str(category)}]`;
  return category == null || category === status ? ` [${str(status)}]` : ` [${str(status)}/${str(category)}]`;
}

/** The state's headline lines: progress, rollup, trail size, liveness. */
export function storyStateLines(state: unknown): string[] {
  if (!isRow(state)) return [];
  const out = [`progress: ${progressText(state['taskProgress'], 'tasks')}`];
  if (num(state['childStoryCount']) > 0) {
    out.push(`with child stories (${num(state['childStoryCount'])}): ${progressText(state['rollup'], 'tasks')}`);
  }
  out.push(`trail: ${num(state['itemCount'])} things from ${num(state['rootCount'])} roots`
    + ` · every kind ${progressText(state['progress'])}`
    + (state['truncated'] === true ? ' · TRUNCATED at the follow limit' : ''));
  out.push(`live sessions ${num(state['liveSessionCount'])}`
    + ` · pending attention ${num(state['pendingAttentionCount'])}`
    + ` · last activity ${state['lastActivityAt'] == null ? 'none' : minute(state['lastActivityAt'])}`);
  return out;
}

function rootLine(r: Row, index: number): string {
  const tp = r['taskProgress'];
  const tasks = isRow(tp) && num(tp['work']) > 0 ? ` · ${num(tp['done'])}/${num(tp['work'])} tasks` : '';
  const all = isRow(r['progress']) ? ` · ${num(r['progress']['done'])}/${num(r['progress']['work'])} all` : '';
  const children = r['childCount'] !== undefined ? num(r['childCount']) : len(r['childIds']);
  const trail = r['trailCount'] !== undefined ? num(r['trailCount']) : len(r['trail']);
  return `  ${index + 1}. ${str(r['id'])} ${str(r['kind'])}${statusTag(r['status'], r['statusCategory'])} ${str(r['title'])}`
    + (r['blocked'] === true ? ' (blocked)' : '')
    + `${tasks}${all} · ${children} under · ${trail} followed`;
}

function byKindText(byKind: unknown): string {
  if (!isRow(byKind)) return '-';
  const entries = Object.entries(byKind).filter(([, n]) => num(n) > 0).sort((a, b) => num(b[1]) - num(a[1]));
  return entries.length === 0 ? 'nothing yet' : entries.map(([k, n]) => `${k} ${num(n)}`).join(' · ');
}

/**
 * The v2 context `story` section as lines. Lists print whole (the server
 * capped them and says so in `omitted[]`, which the brief prints).
 */
export function storyContextLines(story: unknown): string[] {
  if (!isRow(story)) return [];
  const out = storyStateLines(story['state']);
  if (story['truncated'] === true && !(isRow(story['state']) && story['state']['truncated'] === true)) {
    out.push('trail: TRUNCATED at the follow limit');
  }
  out.push(`by kind: ${byKindText(story['byKind'])}`);

  const roots = rows(story['roots']);
  out.push(`roots (${roots.length}):`);
  roots.forEach((r, i) => out.push(rootLine(r, i)));

  const blocked = rows(story['blocked']);
  out.push(`blocked (${blocked.length})${blocked.length === 0 ? ': none' : ':'}`);
  for (const b of blocked) out.push(`  ${str(b['id'])} ${str(b['kind'])}${statusTag(b['status'], b['statusCategory'])} ${str(b['title'])}`);

  const sessions = rows(story['sessions']);
  out.push(`sessions (${sessions.length}):`);
  for (const s of sessions) {
    const tasks = Array.isArray(s['taskIds']) ? s['taskIds'].map(String) : [];
    out.push(`  ${str(s['callSign'])} ${str(s['id'])} ${s['live'] === true ? 'live' : 'idle'}`
      + (s['mode'] != null ? ` · ${str(s['mode'])}` : '')
      + ` · ${str(s['title'])}`
      + (tasks.length > 0 ? ` · on ${tasks.join(', ')}` : ''));
  }

  const team = rows(story['team']);
  out.push(`team (${team.length}):`);
  const modes = new Map<string, Row[]>();
  for (const t of team) {
    // Space members (humans) carry no mode: they group as `members`.
    const mode = t['mode'] != null ? String(t['mode']) : t['kind'] === 'member' ? 'members' : 'no mode';
    modes.set(mode, [...(modes.get(mode) ?? []), t]);
  }
  for (const [mode, members] of modes) {
    out.push(`  ${mode}:`);
    for (const t of members) {
      out.push(`    ${str(t['id'])} ${str(t['name'])}${t['live'] === true ? ' (live)' : ''}`
        + (t['kind'] === 'member' ? '' : ` · ${len(t['sessionIds'])} session${len(t['sessionIds']) === 1 ? '' : 's'}`)
        + (len(t['runs']) > 0 ? ` · runs ${len(t['runs'])}` : '')
        + (len(t['assigned']) > 0 ? ` · assigned ${len(t['assigned'])}` : '')
        + (t['parentId'] != null ? ` · under ${str(t['parentId'])}` : ''));
    }
  }

  const children = rows(story['childStories']);
  out.push(`child stories (${children.length})${children.length === 0 ? ': none' : ':'}`);
  for (const c of children) {
    out.push(`  ${str(c['id'])}${statusTag(c['status'], c['statusCategory'])} ${str(c['title'])}`
      + ` · ${progressText(c['rollup'] ?? c['taskProgress'], 'tasks')}`
      + (num(c['liveSessionCount']) > 0 ? ` · ${num(c['liveSessionCount'])} live` : ''));
  }
  return out;
}

/** The first line of a description, cut at `max` characters. */
function lede(text: unknown, max = 200): string {
  const s = typeof text === 'string' ? text.trim() : '';
  if (s === '') return '(none)';
  const first = s.split('\n')[0]!;
  const more = first.length > max || s.includes('\n');
  return `${first.slice(0, max)}${more ? '…' : ''}`;
}

/** Counts of everything `content.page` holds, plus the trail's kinds. */
export function storyPageCounts(page: unknown): Row | null {
  if (!isRow(page)) return null;
  const byKind: Record<string, number> = {};
  for (const n of rows(page['nodes'])) {
    if (num(n['depth']) < 0) continue;
    const kind = String(n['kind'] ?? '?');
    byKind[kind] = (byKind[kind] ?? 0) + 1;
  }
  const follow = isRow(page['follow']) ? page['follow'] : {};
  return {
    roots: len(page['roots']),
    nodes: len(page['nodes']),
    edges: len(page['edges']),
    sessions: len(page['sessions']),
    team: len(page['team']),
    childStories: len(page['childStories']),
    activity: len(page['activity']),
    recentMessages: len(page['recentMessages']),
    feedAnchors: len(page['feedAnchorIds']),
    truncated: follow['truncated'] === true,
    byKind,
  };
}

/** `tm8 entity get <story>` as text: summary, progress, roots, page counts. */
export function renderStoryDetail(detail: Row, head: string): string {
  const content = isRow(detail['content']) ? detail['content'] : {};
  const page = isRow(content['page']) ? content['page'] : null;
  const out = [head];
  const parent = page && isRow(page['parent']) ? page['parent'] : null;
  out.push(`status: ${str(detail['status'] ?? detail['category'])}`
    + (parent ? ` · parent story ${str(parent['id'])} ${str(parent['title'])}` : ''));
  out.push(`description: ${lede(content['description'])}`);
  out.push(...storyStateLines(detail['state']));
  if (page) {
    const counts = storyPageCounts(page)!;
    out.push(`by kind: ${byKindText(counts['byKind'])}`);
    const roots = rows(page['roots']);
    out.push(`roots (${roots.length}):`);
    roots.forEach((r, i) => out.push(rootLine(r, i)));
    out.push(`page: ${counts['nodes']} nodes · ${counts['edges']} edges · ${counts['sessions']} sessions`
      + ` · ${counts['team']} teammates · ${counts['childStories']} child stories`
      + ` · ${counts['activity']} activity · ${counts['recentMessages']} messages as of ${minute(page['asOf'])}`);
  } else {
    out.push('page: not hydrated on this read');
  }
  const id = str(detail['id']);
  out.push(`next: tm8 entity context ${id} (roots, sessions, team, blocked, child stories) · tm8 entity get ${id} --full --format json (the whole page)`);
  return out.join('\n');
}
