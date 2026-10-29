/**
 * Deterministic local intent retrieval over the operation projection (§7.4).
 *
 * Deterministic, not clever. Two properties matter more than ranking quality:
 *
 *  - REACHABILITY MUST NOT DEPEND ON RANKING. Ranking may improve over time;
 *    an operation that a bad ranking buries is still reachable by exact
 *    `--operation` lookup and by its noun shard, both of which are total. So
 *    this file is allowed to be simple.
 *  - IT NEVER INVENTS AN OPERATION (conformance D5). Every candidate comes from
 *    the projection; there is no fuzzy generation step and no fallback that
 *    manufactures a plausible-looking command.
 *
 * The one judgement encoded here: an operation the caller CANNOT invoke must
 * not outrank one they can. Internal and reserved rows are scored down rather
 * than excluded — hiding them would make `execution.prompt` and `search.query`
 * undiscoverable, which is the failure this whole surface exists to prevent —
 * but recommending them first would be answering a question with a dead end.
 */
import type { CommandDiscovery, OperationDiscovery } from './operations.js';

/**
 * Words that carry no intent. Without this list, "what can I do with all of
 * this" matches on `all` and `this` and returns noise ranked above the answer.
 */
const STOPWORDS: ReadonlySet<string> = new Set([
  'a', 'all', 'am', 'an', 'and', 'any', 'are', 'as', 'at', 'be', 'by', 'can', 'do', 'does',
  'for', 'from', 'how', 'i', 'in', 'into', 'is', 'it', 'me', 'my', 'of', 'on', 'or', 'out',
  'please', 'should', 'so', 'that', 'the', 'their', 'them', 'then', 'there', 'these', 'this',
  'to', 'up', 'want', 'was', 'we', 'what', 'when', 'where', 'which', 'who', 'will', 'with',
  'would', 'you', 'your',
]);

/**
 * Spellings an agent reaches for that the catalog files under another word.
 * Each token ADDS its expansions (the original stays), so a synonym can only
 * widen a match, never lose one. Cross-space work is the case that motivated
 * it: the capability is a global flag (`--space <alias>`) plus the `link`
 * noun, and neither word is what a caller types when they mean "the other
 * Space".
 */
const SYNONYMS: Readonly<Record<string, readonly string[]>> = {
  'create-task': ['create', 'task'],
  'new-task': ['create', 'task'],
  teammates: ['teammate'],
  'team-member': ['teammate'],
  'team-members': ['teammate'],
  'cross-space': ['link'],
  'other-space': ['cross-space', 'link'],
  'another-space': ['cross-space', 'link'],
  'linked-space': ['cross-space', 'link'],
  'space-link': ['cross-space', 'link'],
  'space-links': ['cross-space', 'link'],
  links: ['link'],
  linked: ['link'],
};

/** "other space", "cross space", "linked spaces" → one hyphenated token. */
const SPACE_PHRASE = /\b(other|another|cross|linked)[\s_]+spaces?\b/g;

/** The query's words in order, stopwords KEPT: an `only` route reads every word, not just the intent ones. */
export function queryWords(query: string): string[] {
  return query
    .toLowerCase()
    .replace(SPACE_PHRASE, (_m, w: string) => `${w}-space`)
    .split(/[^a-z0-9-]+/)
    .filter((t) => t.length > 1);
}

export function tokenize(query: string): string[] {
  const base = queryWords(query).filter((t) => !STOPWORDS.has(t));
  return [...new Set(base.flatMap((t) => [t, ...(SYNONYMS[t] ?? [])]))];
}

const EXACT_TAG = 40;
const PREFIX_TAG = 12;
const SUMMARY_WORD = 8;
/**
 * Notes carry facts the summary has no room for (bounds, caps, flag ownership),
 * so they are indexed — at half a summary word, because a note mentions many
 * things in passing. `syn` and `examples` stay UNINDEXED: syn is flag soup and
 * examples restate syn.
 */
const NOTE_WORD = 4;
/** Internal and reserved rows stay discoverable but must never be the answer. */
const UNINVOCABLE_FACTOR = 0.25;

export interface Scored {
  row: OperationDiscovery;
  score: number;
  /** The tokens that actually matched — rendered as the match `reason`. */
  hits: string[];
}
/** An alias command scored by its own words: `rankCommands`. */
export interface ScoredCommand {
  row: CommandDiscovery;
  score: number;
  hits: string[];
}
/** What the scorer reads: an operation row, or an alias command with its tags. */
export interface Searchable {
  intentTags: readonly string[];
  summary: string;
  notes: readonly string[];
  exposure: OperationDiscovery['exposure'];
}

function summaryWords(row: Searchable): Set<string> {
  return new Set(row.summary.toLowerCase().split(/[^a-z0-9-]+/).filter(Boolean));
}

function noteWords(row: Searchable): Set<string> {
  return new Set(
    row.notes.flatMap((n) => n.toLowerCase().split(/[^a-z0-9-]+/)).filter(Boolean),
  );
}

export function score(tokens: readonly string[], row: OperationDiscovery): Scored {
  return { row, ...scoreText(tokens, row) };
}

export function scoreText(tokens: readonly string[], row: Searchable): { score: number; hits: string[] } {
  const tags = new Set(row.intentTags);
  const words = summaryWords(row);
  const notes = noteWords(row);
  let total = 0;
  const hits: string[] = [];

  for (const token of tokens) {
    if (tags.has(token)) {
      total += EXACT_TAG;
      hits.push(token);
      continue;
    }
    // A prefix match is worth having ("attach" → "attachment") but only for
    // tokens long enough that the prefix means something.
    if (token.length >= 4 && [...tags].some((t) => t.startsWith(token) || token.startsWith(t))) {
      total += PREFIX_TAG;
      hits.push(token);
      continue;
    }
    if (token.length >= 4 && words.has(token)) {
      total += SUMMARY_WORD;
      hits.push(token);
      continue;
    }
    if (token.length >= 4 && notes.has(token)) {
      total += NOTE_WORD;
      hits.push(token);
    }
  }

  if (row.exposure === 'internal' || row.exposure === 'reserved') total *= UNINVOCABLE_FACTOR;
  return { score: total, hits };
}

/**
 * Alias commands (`tool versions`, `task axis`, `message reply`) have no operation row of their
 * own, so `rank` never sees their summary or notes. Score them by the same weights, with their
 * path words and tags as intent tags; ties keep the catalog's command order.
 */
export function rankCommands(
  query: string,
  rows: readonly { command: CommandDiscovery; intentTags: readonly string[] }[],
  limit: number,
): ScoredCommand[] {
  const tokens = tokenize(query);
  if (tokens.length === 0) return [];
  return rows
    .map(({ command, intentTags }) => ({ row: command, ...scoreText(tokens, { intentTags, summary: command.summary, notes: command.notes, exposure: command.exposure }) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/**
 * Rank and cut. Ties break on catalog order, which is stable across runs and
 * across machines — a ranking that reordered itself between two invocations
 * would make every cached help shard a lie.
 */
export function rank(
  query: string,
  rows: readonly OperationDiscovery[],
  limit: number,
): Scored[] {
  const tokens = tokenize(query);
  if (tokens.length === 0) return [];
  const order = new Map(rows.map((r, i) => [r.operation, i]));
  const scored = rows
    .map((row) => score(tokens, row))
    .filter((s) => s.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        (order.get(a.row.operation) as number) - (order.get(b.row.operation) as number),
    );
  return keepRankedLast(scored, (s) => rankedLast(tokens, s.row.operation)).slice(0, limit);
}

/**
 * Operations the ranker never answers FIRST for this query: they rank after every other match
 * and, when nothing else matched, are dropped rather than lead. ONE predicate for `rank()` and
 * for `rankAll()`'s combined operation + alias ranking, so neither can undo the other. `tools.run`
 * STARTS a run, so a query that stops, prevents or negates one ("abort the run", "skip the run
 * now", "don't run it now") never gets it first (task 01a187ed); "run the url-check tool" does.
 */
export function rankedLast(tokens: readonly string[], operation: string): boolean {
  return operation === 'tools.run' && tokens.some((t) => NOT_RUN_WORDS.has(t));
}

/** Stable: the entries `last` names go after every other one and never lead; alone, they are dropped. */
function keepRankedLast<T>(items: readonly T[], last: (item: T) => boolean): T[] {
  const lead = items.filter((item) => !last(item));
  return lead.length === 0 ? [] : [...lead, ...items.filter(last)];
}

/** One entry of `rankAll()`: an operation row or an alias command, with its score. */
export type RankedEntry =
  | { kind: 'operation'; score: number; entry: Scored }
  | { kind: 'alias'; score: number; entry: ScoredCommand };

/**
 * Operation rows and alias commands in one ranking, as `tm8 help --query` answers. The sort is
 * stable, so an alias never displaces an operation it ties with and catalog order holds. The
 * ranked-last rule applies to the combined list as well: re-sorting by score alone would put a
 * `rankedLast` operation first again whenever it outscores the rest.
 */
export function rankAll(
  query: string,
  operations: readonly OperationDiscovery[],
  aliases: readonly { command: CommandDiscovery; intentTags: readonly string[] }[],
  limit: number,
): RankedEntry[] {
  const tokens = tokenize(query);
  const combined: RankedEntry[] = [
    ...rank(query, operations, limit).map((s) => ({ kind: 'operation' as const, score: s.score, entry: s })),
    ...rankCommands(query, aliases, limit).map((s) => ({ kind: 'alias' as const, score: s.score, entry: s })),
  ].sort((a, b) => b.score - a.score);
  return keepRankedLast(combined, (e) =>
    rankedLast(tokens, e.kind === 'operation' ? e.entry.row.operation : (e.entry.row.operations[0] ?? '')));
}

/** Why this row surfaced, in one clause a reader can act on. */
export function matchReason(scored: Scored | ScoredCommand): string {
  const hits = [...new Set(scored.hits)].slice(0, 4);
  return hits.length > 0
    ? `matches ${hits.join(', ')} — ${scored.row.summary.toLowerCase()}`
    : scored.row.summary.toLowerCase();
}

/**
 * Closeout intents — the five questions every worker asks at the end of a
 * task, answered with the exact command FIRST and a one-line example.
 *
 * Why a table and not better tags: measured in live runs, "tick acceptance
 * criterion" ranked `space invite redeem` first (on `acceptance`), and workers
 * spent 7-13 help calls and then a 30 KB `entity get` to learn the write
 * shape. These five are the hot path, so they are routed, not scored.
 *
 * Each route lists candidate command paths in preference order; the first one
 * that EXISTS in the projection wins, so a route never names a command this
 * CLI does not have (D5). `task tick` is preferred when it has landed, and the
 * `entity update` fallback carries the one fact that bites: a patch REPLACES
 * the whole `acceptanceCriteria` array (verified against a live task), so every
 * criterion must be resent with its text.
 */
export interface IntentRoute {
  intent: string;
  /** Every group must share at least one token with the query. */
  all: readonly (readonly string[])[];
  /** Any shared token vetoes the route. */
  none?: readonly string[];
  /**
   * An allowlist over the query's WORDS, stopwords included: each must be in
   * `all`, here, or a plain request word ("how do I", "the", "my"), or the route
   * does not match. An answer that ends something live uses it, because a
   * denylist of what a human might name can never be complete ("cancel the
   * session invite" is not a stop).
   */
  only?: readonly string[];
  candidates: readonly { path: readonly string[]; example: string }[];
}

const CRITERIA_WORDS = ['criteria', 'criterion', 'acceptance', 'checklist', 'checkbox', 'checkboxes'];

/** Stopping something live. */
const STOP_WORDS = ['stop', 'stopping', 'cancel', 'cancelling', 'canceling', 'kill', 'killing', 'abort', 'aborting', 'halt', 'halting', 'terminate', 'terminating', 'interrupt'];
/** What a stop may name for `session terminate`: a run, the tool running, or its session. */
const RUN_WORDS = ['run', 'runs', 'running', 'tool', 'tools', 'session', 'sessions'];
/**
 * A query with any of these does not ask to START a run: the ranker never answers `tool run` first.
 * `rankedLast` reads tokenize()'s tokens, so these must stay OUT of STOPWORDS ("don't" is `don`).
 */
const NOT_RUN_WORDS: ReadonlySet<string> = new Set([
  ...STOP_WORDS, 'end', 'quit', 'cease', 'block', 'blocking', 'skip', 'skipping', 'prevent', 'preventing', 'avoid',
  'avoiding', 'pause', 'disable', 'suppress', 'don', 'dont', 'not', 'never',
]);
/** The plain words a request carries that name nothing: an `only` route always allows them. */
const PLAIN_WORDS: ReadonlySet<string> = new Set([
  'the', 'an', 'my', 'our', 'your', 'this', 'that', 'these', 'those', 'all', 'please', 'we', 'you', 'can', 'could',
  'would', 'should', 'will', 'how', 'do', 'does', 'want', 'need', 'to', 'and', 'is', 'are', 'am', 'just', 'let', 'go', 'ahead',
]);

export const INTENT_ROUTES: readonly IntentRoute[] = [
  {
    intent: 'tick acceptance criteria',
    all: [['tick', 'untick', 'check', 'mark', 'done', 'complete', 'satisfy', 'satisfied', 'met', 'update', 'set'], CRITERIA_WORDS],
    candidates: [
      { path: ['task', 'tick'], example: 'tm8 task tick <task-id> c1 c2 --expect-version <n>' },
      {
        path: ['entity', 'update'],
        example:
          'tm8 entity update <task-id> --expect-version <n> --content \'{"acceptanceCriteria":[{"id":"c1","text":"<same text>","done":true}]}\'  (the array is REPLACED: resend every criterion with its text; ids and texts are in `tm8 entity context <task-id>`)',
      },
    ],
  },
  {
    intent: 'complete a task',
    all: [['complete', 'completed', 'completing', 'finish', 'finished', 'done', 'closeout']],
    // A story is not completed; its status is set (the route below).
    none: [...CRITERIA_WORDS, 'story', 'stories', 'chapter'],
    candidates: [{ path: ['task', 'complete'], example: 'tm8 task complete <task-id> --expect-version <n> --by <actor-id>' }],
  },
  {
    intent: 'reply to a message',
    // A reply to a MESSAGE threads under it; "reply to the coordinator" is a
    // post to their session and falls through to the route below.
    all: [['reply', 'replies', 'respond', 'answer'], ['message', 'messages', 'thread', 'comment', 'dm']],
    candidates: [{ path: ['message', 'reply'], example: 'tm8 message reply <message-id> "<body>"' }],
  },
  {
    intent: 'update entity content or description',
    all: [
      ['update', 'edit', 'change', 'set', 'patch', 'rewrite', 'modify', 'replace'],
      ['content', 'description', 'title', 'body', 'text', 'task', 'doc'],
    ],
    none: ['message', 'messages', 'comment', 'status', 'state', ...CRITERIA_WORDS],
    candidates: [
      {
        path: ['entity', 'update'],
        example: 'tm8 entity update <entity-id> --expect-version <n> --content \'{"description":"<text>"}\'  (top-level content keys merge; --title <title> renames)',
      },
    ],
  },
  {
    intent: 'set the status of a story',
    all: [
      ['set', 'change', 'update', 'move', 'mark', 'transition', 'close', 'reopen', 'start'],
      ['story', 'stories', 'chapter'],
      ['status', 'state', 'done', 'cancelled', 'progress', 'started', 'finished'],
    ],
    candidates: [
      {
        path: ['entity', 'update'],
        example: 'tm8 entity update <story-id> --expect-version <n> --status in_progress  (to_do|in_progress|done|cancelled or a workflow state name; manual, never derived from the story\'s contents)',
      },
    ],
  },
  {
    intent: 'post a result or blocker',
    all: [
      ['post', 'report', 'send', 'share', 'tell', 'notify', 'message', 'reply', 'respond', 'answer'],
      ['result', 'results', 'outcome', 'milestone', 'blocker', 'blocked', 'progress', 'status', 'coordinator', 'lead', 'session', 'summary', 'finding', 'findings'],
    ],
    candidates: [{ path: ['message', 'send'], example: 'tm8 message send --to <anchor-or-session-id> "<body>"' }],
  },
  {
    intent: 'create a task',
    all: [['create', 'new', 'add', 'make', 'open', 'file'], ['task', 'tasks', 'subtask', 'subtasks']],
    none: ['issue', 'github', ...CRITERIA_WORDS],
    candidates: [
      { path: ['task', 'create'], example: 'tm8 task create "<title>" --parent <task-id>' },
      { path: ['entity', 'create'], example: 'tm8 entity create task "<title>" --parent <task-id>' },
    ],
  },
  {
    intent: 'list teammates',
    all: [['teammate', 'agents', 'personas']],
    none: ['chat', 'skill', 'skills', 'equip', 'profile', 'interaction-profile', 'spawn', 'launch'],
    candidates: [{ path: ['teammate', 'list'], example: 'tm8 teammate list' }],
  },
  {
    intent: 'act in another Space through a space link',
    all: [['cross-space', 'link']],
    // `link` is also a PR, a commit, an edge and a project: those keep their own answers.
    none: ['pr', 'pull', 'commit', 'commits', 'edge', 'edges', 'relate', 'project', 'folder', 'url'],
    candidates: [
      { path: ['link', 'list'], example: 'tm8 link list   then   tm8 --space <alias> entity query --kind task' },
    ],
  },
  {
    intent: 'stop a running tool or session',
    // Scored, "abort the run" answered `tool run` first: `run` is one of its tags and nothing
    // tags the stop verbs (task 01a187ed). A run is a work session, so stopping one is
    // `session terminate`. That ends a live session, so the query may say nothing else: a stop
    // verb, what runs, plain request words, and when ("cancel the session invite" falls through).
    all: [STOP_WORDS, RUN_WORDS],
    none: ['loop', 'loops', 'chat', 'chats', 'turn', 'turns'],
    only: ['now', 'immediately', 'current', 'stuck', 'runaway'],
    candidates: [
      {
        path: ['session', 'terminate'],
        example: 'tm8 session terminate <session-id> --yes  (a tool run is a work session: `tm8 tool runs <tool>` lists its id; --stop --note <why> records why)',
      },
    ],
  },
];

/** The first route whose token groups all match the query, or undefined. */
export function matchIntent(query: string): IntentRoute | undefined {
  const tokens = new Set(tokenize(query));
  if (tokens.size === 0) return undefined;
  const words = queryWords(query);
  return INTENT_ROUTES.find(
    (r) =>
      r.all.every((group) => group.some((t) => tokens.has(t))) &&
      !(r.none ?? []).some((t) => tokens.has(t)) &&
      (r.only === undefined ||
        words.every((w) => PLAIN_WORDS.has(w) || r.only!.includes(w) || r.all.some((group) => group.includes(w)))),
  );
}

function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        (prev[j] as number) + 1,
        (cur[j - 1] as number) + 1,
        (prev[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[b.length] as number;
}

/**
 * The closest rows to an UNKNOWN help topic, for the "did you mean" hint —
 * never an answer, only pointers to rows that exist (D5).
 *
 * Three signals, strongest first: an operation id within a small edit distance
 * of the topic (`entities.commands.completee`); a topic word that IS an
 * operation-name segment (`entity patch` names `entities.patch`); then the
 * ordinary intent ranking over the same words.
 */
export function closest(
  topic: string,
  rows: readonly OperationDiscovery[],
  limit: number,
): OperationDiscovery[] {
  const raw = topic.trim().toLowerCase();
  const words = raw.split(/[^a-z0-9]+/).filter((w) => w.length >= 3);
  const scoreOf = (row: OperationDiscovery): number => {
    const name = row.operation.toLowerCase();
    let s = 0;
    const d = editDistance(raw, name);
    if (raw.includes('.') && d <= Math.max(2, Math.floor(name.length / 6))) s += 100 - d;
    const segments = name.split('.');
    for (const w of words) {
      if (segments.includes(w)) s += 10;
      if (row.command?.includes(w)) s += 10;
      if (row.noun === w) s += 5;
    }
    // Only a row that matched on a NAME signal counts; the rest is noise.
    return s;
  };
  const order = new Map(rows.map((r, i) => [r.operation, i]));
  const named = rows
    .map((row) => ({ row, s: scoreOf(row) * (row.exposure === 'internal' || row.exposure === 'reserved' ? UNINVOCABLE_FACTOR : 1) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || (order.get(a.row.operation) as number) - (order.get(b.row.operation) as number))
    .map((x) => x.row);
  const out: OperationDiscovery[] = [];
  for (const row of [...named, ...rank(raw, rows, limit).map((s) => s.row)]) {
    if (out.length >= limit) break;
    if (!out.includes(row)) out.push(row);
  }
  return out;
}
