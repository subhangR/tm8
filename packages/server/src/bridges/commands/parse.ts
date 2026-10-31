/**
 * Bridges B1b-4: the command parser (BRIDGES-V2-DESIGN §4.2). Strict about
 * meaning, tolerant about form.
 *
 * - A command is a message whose FIRST token is `/word` or `!word` (some
 *   keyboards autocorrect `/`). A slash mid-sentence, or a path such as
 *   `/home/x`, is not a command.
 * - Case, surrounding whitespace, a trailing `?`/`.`/`!` and polite tails
 *   (`please`, `pls`, `thanks`) are ignored.
 * - Aliases map to one verb.
 * - A word we do not know is never routed: it is answered with a did-you-mean.
 * - A multi-line body belongs to the command on the first line.
 *
 * Pure: no I/O, so the inbound door's `detect` and the table-driven test share
 * it.
 */

/** The verbs this slice executes (v2 §8, B1b). */
export const BRIDGE_VERBS = [
  'work', 'task', 'help', 'whoami', 'workers', 'stop', 'status', 'tasks', 'docs', 'link',
  'who', 'bridge', 'mute', 'unmute', 'new',
  'start', 'retry', 'result', 'tell',
  // Bridges R (409, D29): a proposal, accepted only in tm8.
  'remember',
] as const;
export type BridgeVerb = (typeof BRIDGE_VERBS)[number];

/**
 * Verbs of the full set (v2 §4.4) that later slices build. They parse, so a
 * sender gets "not available yet" rather than a did-you-mean to something else.
 */
export const BRIDGE_PLANNED_VERBS = [
  'memories', 'forget', 'remind', 'loop', 'loops', 'queue',
] as const;
export type BridgePlannedVerb = (typeof BRIDGE_PLANNED_VERBS)[number];

const ALIASES: Readonly<Record<string, BridgeVerb>> = {
  w: 'workers', jobs: 'workers',
  cancel: 'stop',
  s: 'status',
  '?': 'help', commands: 'help',
};

/** Options inline on a `/work` line (§4.3). `x<n>` is recognised and refused (Q5). */
export const WORK_OPTION_KEYS = ['teammate', 'project', 'effort'] as const;
export type WorkOptionKey = (typeof WORK_OPTION_KEYS)[number];
export const WORK_EFFORTS = ['low', 'high', 'max'] as const;
export type WorkEffort = (typeof WORK_EFFORTS)[number];

export interface WorkOptions { teammate?: string; project?: string; effort?: WorkEffort }

export interface WorkItem { text: string; options: WorkOptions }

export type ParsedBridgeCommand =
  | { kind: 'none' }
  | { kind: 'command'; verb: BridgeVerb; word: string; args: string; body: string[] }
  | { kind: 'planned'; verb: BridgePlannedVerb; word: string }
  | { kind: 'unknown'; word: string; suggestion: string | null; args: string };

/** The bridge's own invisible echo mark (Phase-1 `BRIDGE_MARK`, text.ts). A notice is never a command. */
export const BRIDGE_MARK = '⁣⁤⁣';

const COMMAND_HEAD = /^[/!]([a-z][a-z0-9_-]{0,23}|\?)(?=$|\s|[?.!,]+(?:\s|$))/i;
const TRAILING_PUNCT = /[\s?.!]+$/;
const POLITE_TAIL = /(?:\s+|^)(?:please|pls|plz|thanks|thank you|thx|ty)[\s?.!]*$/i;

/** Strip a trailing `?`/`.`/`!` and any polite tail, repeatedly. */
export function stripTail(text: string): string {
  let out = text.trim();
  for (;;) {
    const next = out.replace(POLITE_TAIL, '').replace(TRAILING_PUNCT, '').trim();
    if (next === out) return out;
    out = next;
  }
}

function levenshtein(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cur = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
  }
  return row[b.length]!;
}

/** The closest known word (verb, planned verb or alias) within edit distance 2, else null. */
export function suggestVerb(word: string): string | null {
  const w = word.toLowerCase();
  const candidates = [...BRIDGE_VERBS, ...BRIDGE_PLANNED_VERBS, ...Object.keys(ALIASES).filter(a => a.length > 2)];
  let best: string | null = null;
  let bestDistance = Infinity;
  for (const candidate of candidates) {
    const distance = levenshtein(w, candidate);
    // A prefix of a long verb ("/work" for "/workers") is not a typo of it.
    if (distance < bestDistance) { best = candidate; bestDistance = distance; }
  }
  const limit = w.length <= 3 ? 1 : 2;
  if (best === null || bestDistance > limit) return null;
  return ALIASES[best] ?? best;
}

/** True when the body is a command for the executor (the door's `detect`). */
export function isBridgeCommandText(text: string): boolean {
  return parseBridgeCommand(text).kind !== 'none';
}

export function parseBridgeCommand(text: string): ParsedBridgeCommand {
  if (typeof text !== 'string' || text.includes(BRIDGE_MARK)) return { kind: 'none' };
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const firstIndex = lines.findIndex(line => line.trim() !== '');
  if (firstIndex < 0) return { kind: 'none' };
  const first = lines[firstIndex]!.trim();
  const head = COMMAND_HEAD.exec(first);
  if (!head) return { kind: 'none' };
  const word = head[1]!.toLowerCase();
  const rest = first.slice(head[0].length);
  const args = stripTail(rest);
  const body = lines.slice(firstIndex + 1).map(line => line.trim()).filter(line => line !== '');

  const verb = (BRIDGE_VERBS as readonly string[]).includes(word) ? word as BridgeVerb : ALIASES[word];
  if (verb) return { kind: 'command', verb, word, args, body };
  if ((BRIDGE_PLANNED_VERBS as readonly string[]).includes(word)) {
    return { kind: 'planned', verb: word as BridgePlannedVerb, word };
  }
  return { kind: 'unknown', word, suggestion: suggestVerb(word), args };
}

const BULLET = /^(?:[-*•·]|\d{1,2}[.)])\s+/;
const OPTION_TOKEN = /^([a-z]+):(\S+)$/i;
const RACE_TOKEN = /^x(\d{1,2})$/i;

export type WorkParse =
  | { ok: true; items: WorkItem[]; options: WorkOptions }
  | { ok: false; reason: 'empty' | 'unknown_option' | 'bad_effort' | 'race_not_available'; detail?: string };

/**
 * Pull `key:value` options off a line. On the command line (`strictUnknown`)
 * an unknown `key:value` token is refused (§4.3: unknown options are answered,
 * not ignored); on an item line only known keys are options, so text such as
 * "re:login" stays text.
 */
function takeOptions(line: string, strictUnknown: boolean):
  { ok: true; text: string; options: WorkOptions } | { ok: false; reason: 'unknown_option' | 'bad_effort' | 'race_not_available'; detail: string } {
  const options: WorkOptions = {};
  const kept: string[] = [];
  for (const token of line.split(/\s+/).filter(Boolean)) {
    if (RACE_TOKEN.test(token) && Number(RACE_TOKEN.exec(token)![1]) >= 2) {
      return { ok: false, reason: 'race_not_available', detail: token };
    }
    const match = OPTION_TOKEN.exec(token);
    if (match && !/^https?$/i.test(match[1]!)) {
      const key = match[1]!.toLowerCase();
      const value = match[2]!;
      if ((WORK_OPTION_KEYS as readonly string[]).includes(key)) {
        if (key === 'effort') {
          const effort = value.toLowerCase();
          if (!(WORK_EFFORTS as readonly string[]).includes(effort)) return { ok: false, reason: 'bad_effort', detail: value };
          options.effort = effort as WorkEffort;
        } else {
          options[key as 'teammate' | 'project'] = value;
        }
        continue;
      }
      if (strictUnknown) return { ok: false, reason: 'unknown_option', detail: key };
    }
    kept.push(token);
  }
  return { ok: true, text: kept.join(' '), options };
}

/**
 * The items of a `/work` (§4.3): one per following line, or on the command
 * line split on `;`. Bullets and numbering are dropped. Options on the command
 * line apply to every item; options on a line apply to that item and win.
 */
export function parseWorkItems(args: string, body: readonly string[]): WorkParse {
  const head = takeOptions(args, body.length > 0);
  if (!head.ok) return head;
  const raw: string[] = [];
  if (body.length > 0) {
    if (head.text !== '') raw.push(head.text);
    raw.push(...body);
  } else {
    raw.push(...head.text.split(';'));
  }
  const items: WorkItem[] = [];
  for (const line of raw) {
    const cleaned = stripTail(line.replace(BULLET, '').trim());
    if (cleaned === '') continue;
    const parsed = takeOptions(cleaned, false);
    if (!parsed.ok) return parsed;
    if (parsed.text.trim() === '') continue;
    items.push({ text: parsed.text.trim(), options: { ...head.options, ...parsed.options } });
  }
  if (items.length === 0) return { ok: false, reason: 'empty' };
  return { ok: true, items, options: head.options };
}

/** A worker reference (§4.2): a handle, a `#n` from the last list, a title prefix, `all` or `mine`. */
export type WorkerRef =
  | { kind: 'all' }
  | { kind: 'mine' }
  | { kind: 'index'; index: number }
  | { kind: 'handle'; handle: string; prefix: string };

export function parseWorkerRef(args: string): WorkerRef | null {
  const text = stripTail(args).trim();
  if (text === '') return null;
  const lower = text.toLowerCase();
  if (lower === 'all') return { kind: 'all' };
  if (lower === 'mine') return { kind: 'mine' };
  const index = /^#?(\d{1,3})$/.exec(lower);
  if (index) return { kind: 'index', index: Number(index[1]) };
  const words = lower.replace(/^@/, '').split(/\s+/);
  // 'keen-otter', '@keen-otter', 'keen otter' all name the handle; the
  // original text is also a title prefix when no handle matches.
  return { kind: 'handle', handle: words.join('-'), prefix: text };
}

/** The one line a /work item becomes: a short title, the full line kept in the body. */
export function titleOf(text: string, max = 80): string {
  const line = text.replace(/\s+/g, ' ').trim();
  const capped = line.length <= max ? line : `${line.slice(0, max - 1).trimEnd()}…`;
  return capped.charAt(0).toUpperCase() + capped.slice(1);
}

/** §4.6: the bodies that confirm, when they quote an open confirm notice of the same sender. */
export function isConfirmText(text: string): boolean {
  return /^(yes|y|ok|okay)$/i.test(stripTail(text));
}

/** `/mute 1h`, `30m`, `2d`, `1h30m` → milliseconds; null when unreadable. At most a week. */
export function parseDuration(text: string): number | null {
  const t = stripTail(text).toLowerCase().replace(/\s+/g, '');
  if (!/^(\d+(m|min|mins|h|hr|hrs|d|day|days))+$/.test(t)) return null;
  let ms = 0;
  for (const [, n, unit] of t.matchAll(/(\d+)(m|min|mins|h|hr|hrs|d|day|days)/g)) {
    const u = unit!.startsWith('d') ? 86_400_000 : unit!.startsWith('h') ? 3_600_000 : 60_000;
    ms += Number(n) * u;
  }
  return ms > 0 && ms <= 7 * 86_400_000 ? ms : null;
}
