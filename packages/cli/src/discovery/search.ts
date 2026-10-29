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
import type { OperationDiscovery } from './operations.js';

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
/** "set up" is one verb; split, "up" is a stopword and "set" alone reads as editing (review of #1405). */
const SET_UP_PHRASE = /\bset[\s_-]+up\b/g;
/** "get rid of" is one verb, removing: neither "get" nor "of" rides along into what is removed. */
const GET_RID_PHRASE = /\bget[\s_-]+rid(?:[\s_-]+of)?\b/g;

/** The query's words in order, stopwords KEPT: "remove me from the loop" is not "remove the loop". */
export function queryWords(query: string): string[] {
  return query
    .toLowerCase()
    .replace(SPACE_PHRASE, (_m, w: string) => `${w}-space`)
    .replace(SET_UP_PHRASE, 'setup')
    .replace(GET_RID_PHRASE, 'rid')
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

function summaryWords(row: OperationDiscovery): Set<string> {
  return new Set(row.summary.toLowerCase().split(/[^a-z0-9-]+/).filter(Boolean));
}

function noteWords(row: OperationDiscovery): Set<string> {
  return new Set(
    row.notes.flatMap((n) => n.toLowerCase().split(/[^a-z0-9-]+/)).filter(Boolean),
  );
}

export function score(tokens: readonly string[], row: OperationDiscovery): Scored {
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
  return { row, score: total, hits };
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
  return rows
    .map((row) => score(tokens, row))
    .filter((s) => s.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        (order.get(a.row.operation) as number) - (order.get(b.row.operation) as number),
    )
    .slice(0, limit);
}

/** Why this row surfaced, in one clause a reader can act on. */
export function matchReason(scored: Scored): string {
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
   * does not match. The answers that delete or fire use it, because a denylist
   * of what a human might name can never be complete, and "remove me FROM the
   * loop" differs from "remove the loop" only in its stopwords (#1405, round 5).
   */
  only?: readonly string[];
  /** Positive evidence over the query's words, for an answer a word list cannot decide alone. */
  when?: (words: readonly string[]) => boolean;
  candidates: readonly { path: readonly string[]; example: string }[];
}

const CRITERIA_WORDS = ['criteria', 'criterion', 'acceptance', 'checklist', 'checkbox', 'checkboxes'];

/** A loop's fields, as a human names them: with an editing verb they are `loop edit`, never a delete. */
const LOOP_ATTRIBUTE_WORDS = [
  'schedule', 'timezone', 'time', 'cadence', 'prompt', 'instructions', 'title', 'name', 'teammate', 'runner',
  'tool', 'inputs', 'model', 'retry', 'retries', 'runtime', 'concurrency', 'subject', 'memory', 'memories',
  'config', 'workdir', 'project', 'profile', 'credential',
];

/** Removing a whole thing. With a loop and nothing else named, the loop's delete; otherwise an edit. */
const LOOP_REMOVAL_WORDS = ['delete', 'remove', 'archive', 'destroy', 'trash', 'drop', 'erase', 'purge', 'wipe', 'rid'];
/** Words that say WHICH loop, never WHAT of it: the only words a loop's delete may carry besides the verb. */
const WHICH_LOOP_WORDS = ['nightly', 'daily', 'weekly', 'hourly', 'monthly', 'old', 'stale', 'unused', 'test', 'broken', 'obsolete'];

/** "Run it now" — the run-now route's words. */
const LOOP_RUN_NOW_WORDS = ['run', 'fire', 'trigger', 'now', 'immediately', 'again', 'once'];
/** Stopping a live run. */
const LOOP_STOP_WORDS = ['stop', 'cancel', 'kill', 'abort', 'end', 'terminate', 'halt'];

/** The plain words a request carries that name nothing: an `only` route always allows them. */
const PLAIN_WORDS: ReadonlySet<string> = new Set([
  'the', 'an', 'my', 'our', 'your', 'this', 'that', 'these', 'those', 'all', 'please', 'we', 'you', 'can', 'could',
  'would', 'should', 'will', 'how', 'do', 'does', 'want', 'need', 'to', 'and', 'is', 'are', 'am', 'just', 'let', 'go', 'ahead',
]);
/** Words a request may open with before its verb: "how do I…", "can you…", "I want to…". */
const REQUEST_WORDS: ReadonlySet<string> = new Set([
  'how', 'do', 'does', 'can', 'could', 'would', 'will', 'please', 'we', 'you', 'want', 'need', 'like', 'to', 'let',
  'lets', 'help', 'me', 'us', 'just', 'go', 'ahead', 'and',
]);
/** An object that already exists: after make/add/schedule it is steered, not set up ("make the loop run hourly"). */
const DEFINITE_WORDS: ReadonlySet<string> = new Set(['the', 'my', 'our', 'your', 'this', 'that', 'these', 'those', 'its', 'their']);
/** Between a verb and "loop", these make the verb's object something else ("add a task TO the loop"). */
const PREPOSITIONS: ReadonlySet<string> = new Set([
  'to', 'for', 'of', 'from', 'with', 'in', 'on', 'into', 'onto', 'at', 'by', 'about', 'off', 'out', 'over', 'via',
]);
/** Verbs that set up something new. make/add/schedule also steer what exists, so those need a new object. */
const LOOP_CREATE_VERBS = ['create', 'setup', 'build', 'automate', 'make', 'add', 'schedule'];
const CREATE_VERBS_IF_NEW = ['make', 'add', 'schedule'];
/** Setting up recurring work with no loop named (the first of these opens the request). */
const SET_UP_VERBS = ['schedule', 'create', 'set', 'setup', 'make', 'add', 'new', 'run', 'start', 'automate', 'repeat'];
/** …but "run/start THE nightly report" runs one that exists ("schedule the report nightly" still sets one up). */
const SET_UP_VERBS_IF_NEW = ['run', 'start'];

/** The index of the request's verb: past "how do I", "can you", "I want to". */
function verbAt(words: readonly string[]): number {
  let i = 0;
  while (i < words.length && REQUEST_WORDS.has(words[i]!)) i++;
  return i;
}

/**
 * Does the query ask to CREATE a loop? Positive evidence, as for delete and
 * run-now: its verb opens the request, a make/add/schedule is not followed by
 * "the"/"my" (that steers a loop that exists: "make the loop run hourly", "add
 * the loop to a story"), and only adjectives stand between the verb and "loop"
 * ("add a task TO the loop" adds a task). Or "new … loop" not after "the"
 * ("start a new loop"), or the CLI's own order ("loop create").
 */
function asksForANewLoop(words: readonly string[]): boolean {
  const reachesLoop = (from: number): boolean => {
    for (let j = from; j < Math.min(words.length, from + 4); j++) {
      if (words[j] === 'loop' || words[j] === 'loops') return true;
      if (PREPOSITIONS.has(words[j]!)) return false;
    }
    return false;
  };
  const i = verbAt(words), verb = words[i] ?? '';
  if (LOOP_CREATE_VERBS.includes(verb) && !(CREATE_VERBS_IF_NEW.includes(verb) && DEFINITE_WORDS.has(words[i + 1] ?? ''))
    && reachesLoop(i + 1)) return true;
  if (verb === 'loop' && ['create', 'setup', 'new'].includes(words[i + 1] ?? '')) return true;
  return words.some((word, k) => word === 'new' && !DEFINITE_WORDS.has(words[k - 1] ?? '') && reachesLoop(k + 1));
}

/** Does the query open with setting up recurring work ("schedule a teammate"), not reading it ("view the schedule")? */
function leadsWithSetUp(words: readonly string[]): boolean {
  const i = verbAt(words), verb = words[i] ?? '';
  return SET_UP_VERBS.includes(verb) && !(SET_UP_VERBS_IF_NEW.includes(verb) && DEFINITE_WORDS.has(words[i + 1] ?? ''));
}

/** "end/lift/remove THE pause": a pause named as a thing (after the/its/loop), not "…and pause it". */
function namesAPause(words: readonly string[]): boolean {
  return words.some((word, k) => word === 'pause' && ['the', 'its', 'this', 'that', 'loop'].includes(words[k - 1] ?? ''));
}

/** Words that steer or read a loop that exists; any one keeps a query off `loop create`. */
const LOOP_STEERING_WORDS = [
  'pause', 'resume', 'stop', 'disable', 'enable', 'delete', 'remove', 'list', 'show', 'preview', 'edit', 'change',
  'runs', 'history', 'cancel', 'archive', 'loops', 'schedules', 'status',
  'now', 'fire', 'trigger', 'again', 'once', 'immediately',
];

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
  /*
   * LOOPS, steering before setting up. A query that names a loop with a
   * steering verb is that verb's command (run-now, enable, edit) — never
   * `loop create`, which would arm a second loop that keeps firing (review of
   * #1405). These come first because the set-up routes below match on words
   * a steering query also has ("run", "set", "schedule").
   */
  {
    // First: ending a pause is resuming, whichever verb says it ("remove the pause from the loop").
    intent: "end a loop's pause (resume it)",
    all: [['loop', 'loops'], ['pause'], [...LOOP_STOP_WORDS, ...LOOP_REMOVAL_WORDS, 'lift', 'clear', 'unset', 'undo']],
    when: namesAPause,
    candidates: [{ path: ['loop', 'resume'], example: 'tm8 loop resume <id|title> --expect-version <n>' }],
  },
  {
    intent: 'change a loop (its schedule, timezone, instructions or runner)',
    all: [
      ['loop'],
      // Clearing a field is an edit too ("remove the subject from the loop"): never the whole loop's delete.
      ['set', 'change', 'edit', 'update', 'retime', 'reschedule', 'add', 'remove', 'clear', 'drop', 'unset', 'delete'],
      LOOP_ATTRIBUTE_WORDS,
    ],
    // "add a teammate to the loop" edits it; "add a new loop" makes one.
    none: ['new', 'create', 'make', 'another'],
    candidates: [{ path: ['loop', 'edit'], example: "tm8 loop edit <id|title> --schedule '<expr>' --expect-version <n>" }],
  },
  {
    // Before run-now: stopping a run must never be answered with firing another one.
    intent: 'stop a loop run',
    all: [['loop', 'loops'], LOOP_STOP_WORDS, ['run', 'running', 'runs']],
    none: ['pause', 'disable', 'delete', 'remove', 'new', 'create'],
    candidates: [{ path: ['loop', 'stop'], example: 'tm8 loop stop <run-id>   (the run ids: tm8 loop runs <id|title>)' }],
  },
  {
    // A run is kept with its loop and cannot be deleted on its own: deleting "the loop run" must never
    // delete the loop. The non-destructive answer is the run list (a live run ends with loop stop).
    intent: "delete a loop's run (not possible: read them)",
    all: [['loop', 'loops'], [...LOOP_REMOVAL_WORDS, 'clear'], ['run', 'runs', 'running']],
    candidates: [{ path: ['loop', 'runs'], example: 'tm8 loop runs <id|title>   (a run stays with its loop; tm8 loop stop <run-id> ends a live one)' }],
  },
  {
    // Removing a loop is the ordinary entity delete (its runs go with it; its tasks and sessions stay).
    // DESTRUCTIVE, so it answers only a phrasing that names nothing but the loop: a removal verb,
    // loop/loops, which loop (`only`) and plain request words. Any other word, stopwords included
    // ("remove me FROM the loop"), is the next route's: a change, never a delete.
    intent: 'delete a loop',
    all: [['loop', 'loops'], LOOP_REMOVAL_WORDS],
    only: WHICH_LOOP_WORDS,
    candidates: [{ path: ['entity', 'delete'], example: 'tm8 entity delete <loop-id>' }],
  },
  {
    // Removing something FROM a loop (a pause, its cron, its header, me): a change, not a delete.
    intent: 'remove something from a loop',
    all: [['loop', 'loops'], LOOP_REMOVAL_WORDS],
    candidates: [{ path: ['loop', 'edit'], example: 'tm8 loop edit <id|title> --expect-version <n>   (the loop itself: tm8 entity delete <loop-id>)' }],
  },
  {
    // Stopping the LOOP itself (no run named): nothing more fires. Never run-now.
    intent: 'stop a loop firing (disable it)',
    all: [['loop', 'loops'], LOOP_STOP_WORDS],
    none: ['run', 'running', 'runs', 'new', 'create'],
    candidates: [{ path: ['loop', 'disable'], example: 'tm8 loop disable <id|title> --expect-version <n>   (a live run: tm8 loop stop <run-id>)' }],
  },
  {
    // FIRES A RUN, so the delete route's allowlist: "run/fire/trigger the (nightly) loop (now|again|once)"
    // and nothing else. "suspend the loop now", "clear the loop's trigger" and "start the loop now" are
    // the routes' below; whatever no route claims ends at the last loop route, never the ranker.
    intent: 'run a loop now',
    all: [['loop', 'loops'], LOOP_RUN_NOW_WORDS],
    only: WHICH_LOOP_WORDS,
    candidates: [{ path: ['loop', 'run-now'], example: 'tm8 loop run-now <id|title>' }],
  },
  {
    intent: 'start (enable) a loop',
    all: [['loop', 'loops'], ['start', 'enable', 'arm', 'activate']],
    none: ['new', 'create', 'make', 'add', 'schedule'],
    candidates: [{ path: ['loop', 'enable'], example: 'tm8 loop enable <id|title> --expect-version <n>' }],
  },
  {
    // Steering words answer their own verb as routes, not through the ranker, whose 'now'/'again'
    // tags lean on run-now.
    intent: 'pause a loop',
    all: [['loop', 'loops'], ['pause', 'suspend', 'freeze', 'hold']],
    // Clearing a pause is not pausing.
    none: ['clear', 'unset', 'lift'],
    candidates: [{ path: ['loop', 'pause'], example: 'tm8 loop pause <id|title> --until <iso|+<n>{m|h|d}> --expect-version <n>' }],
  },
  {
    intent: 'resume a paused loop',
    all: [['loop', 'loops'], ['resume', 'unpause', 'unfreeze']],
    candidates: [{ path: ['loop', 'resume'], example: 'tm8 loop resume <id|title> --expect-version <n>' }],
  },
  {
    intent: 'disable a loop',
    all: [['loop', 'loops'], ['disable', 'deactivate']],
    candidates: [{ path: ['loop', 'disable'], example: 'tm8 loop disable <id|title> --expect-version <n>   (a live run: tm8 loop stop <run-id>)' }],
  },
  {
    // Before `list teammates`: "schedule a teammate" is a loop, not a roster read.
    // Only SETTING UP recurring work routes here: a cadence word AND a set-up
    // verb ("schedule" is both). A query that names a loop is the routes'
    // above and below: with a loop, run/start/set steer it. Steering or
    // reading words veto; a one-off "send a daily report" has no set-up verb.
    intent: 'schedule recurring work (a loop)',
    all: [
      ['schedule', 'scheduled', 'recurring', 'recur', 'cron', 'periodically', 'nightly', 'hourly', 'daily', 'weekly'],
      ['schedule', 'create', 'set', 'setup', 'make', 'add', 'new', 'run', 'start', 'automate', 'repeat'],
    ],
    none: [...LOOP_STEERING_WORDS, 'loop'],
    // …and the set-up verb opens the request: "view the schedule" reads one.
    when: leadsWithSetUp,
    candidates: [
      { path: ['loop', 'create'], example: 'tm8 loop create <title> --schedule <expr> --teammate <name|id> --prompt <text>' },
    ],
  },
  {
    // Reading schedules with no loop named ("view the schedule", "what is my schedule"): the loops are
    // the only schedules tm8 has. Without this the ranker's 'schedule' tag answers `loop create`.
    intent: 'read the schedules (loops)',
    all: [['schedule', 'schedules', 'scheduled', 'cron', 'crons']],
    none: ['preview', 'loop', 'loops'],
    candidates: [{ path: ['loop', 'list'], example: 'tm8 loop list   (each loop with its schedule and next run)' }],
  },
  {
    // A loop named with a creating verb whose object is a NEW loop (asksForANewLoop). run, start
    // and set are not creating verbs here: with a loop they steer one (the routes above).
    intent: 'create a loop',
    all: [['loop'], [...LOOP_CREATE_VERBS, 'new']],
    // "make a loop that runs every day" is a create: "runs" reads a loop's history only without a creating verb.
    none: LOOP_STEERING_WORDS.filter(word => word !== 'runs'),
    when: asksForANewLoop,
    candidates: [
      { path: ['loop', 'create'], example: 'tm8 loop create <title> --schedule <expr> --teammate <name|id> --prompt <text>' },
    ],
  },
  {
    // An editing verb with no field named ("edit the loop", "clear the loop's trigger").
    intent: 'edit a loop',
    all: [['loop'], ['edit', 'change', 'update', 'modify', 'rename', 'retitle', 'reconfigure', 'adjust', 'tweak', 'set', 'unset', 'clear']],
    candidates: [{ path: ['loop', 'edit'], example: 'tm8 loop edit <id|title> --expect-version <n>' }],
  },
  {
    intent: 'preview a loop schedule',
    all: [['loop', 'loops'], ['preview']],
    candidates: [{ path: ['loop', 'preview'], example: "tm8 loop preview --schedule '<expr>' --timezone <zone>" }],
  },
  {
    intent: "read a loop's runs",
    all: [['loop', 'loops'], ['runs', 'history', 'log', 'logs']],
    candidates: [{ path: ['loop', 'runs'], example: 'tm8 loop runs <id|title>' }],
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
    // THE LAST LOOP ROUTES. Whatever else names a loop is read: never created, fired or deleted.
    // Without them the 13 loop rows tie on the 'loop' tag and catalog order answers `loop create`.
    intent: 'a loop (show it)',
    all: [['loop']],
    candidates: [{ path: ['loop', 'show'], example: 'tm8 loop show <id|title>' }],
  },
  {
    intent: 'loops (list them)',
    all: [['loops']],
    candidates: [{ path: ['loop', 'list'], example: 'tm8 loop list' }],
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
        words.every((w) => PLAIN_WORDS.has(w) || r.only!.includes(w) || r.all.some((group) => group.includes(w)))) &&
      (r.when === undefined || r.when(words)),
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
