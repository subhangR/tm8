/**
 * ONE STEP CLASSIFIER — what a tool call IS, in human words, and whether it is
 * still happening.
 *
 * Two surfaces narrate the agent's work and must never disagree about it: the
 * transcript's step list (`TurnSteps.tsx`), which keeps the history, and the
 * live status row under the conversation, which says what is happening NOW.
 * Two labelers that agree today drift tomorrow — `write-classifier.ts` tells
 * that story — so both import this module, and neither owns a copy.
 *
 * TOOL NAMES NEVER REACH THE SURFACE (graph-seeds R8). A name is read here for
 * classification only. Chat's graph tools are GROUP tools whose names carry no
 * verb (`tm8_act`), so `args.operation` is asked FIRST and the tool name only
 * when a call has no operation at all. An unrecognised tool is "a tool", never
 * its name.
 *
 * NO NEW SOURCE OF TRUTH. Everything is read from the call's own args and
 * result, which the transcript already holds.
 */
import { kindWord } from './ledger';
import { walkPayload } from './payload-walk';
import type { ProjectedTurnPart } from './turn-model';
import type { ChatTurnPart } from './types';
import { bareToolName, isWriteCall, operationOf } from './write-classifier';

export type ToolStepPart = Extract<ProjectedTurnPart, { kind: 'tool' }>;

/**
 * A step's state as the READER must see it — which is not always the state
 * the last stored record carries:
 *
 * - `completed` / `error`: settled, by the terminal record OR by the result.
 *   The Claude runtime appends the result and THEN a second `tool_call` record
 *   carrying the terminal state; a result is proof the call ended even when
 *   that record is late or never arrives.
 * - `running`: no result and no terminal record, in a turn still going.
 * - `stopped`: the same, in a turn that has ENDED. An interrupted or failed
 *   turn never writes a terminal record for the calls it abandoned (measured
 *   on the live node: 2 of 3 long turns held a call at `running` forever), and
 *   a pulse on a call that will never finish is a lie about liveness.
 */
export type ToolStepState = 'running' | 'completed' | 'error' | 'stopped';

export function toolStepState(
  part: Pick<ToolStepPart, 'state' | 'result' | 'resultIsError'>,
  settled: boolean,
): ToolStepState {
  if (part.state === 'error' || part.resultIsError === true) return 'error';
  if (part.state === 'completed' || part.result !== undefined) return 'completed';
  return settled ? 'stopped' : 'running';
}

/**
 * The seq of the LAST terminal record (`done` or `error`) in a turn's parts,
 * or -1. A call that began before it can no longer be running.
 *
 * NOT "does the turn contain a done": a continued turn appends to the SAME
 * message after its first `done` (seen live: `…C C E D x C R C …`), so a done
 * ends only what came before it.
 */
export function turnEndSeq(parts: readonly ChatTurnPart[]): number {
  let end = -1;
  for (const part of parts) {
    if ((part.kind === 'done' || part.kind === 'error') && part.seq > end) end = part.seq;
  }
  return end;
}

export interface ToolStepWords {
  /** Consecutive settled steps sharing a category fold into one counted
   *  line. A stable machine key (`command`, `graph-read`, `create:task`),
   *  never rendered. */
  category: string;
  /** A live step, without the ellipsis: `Running a command`. */
  active: string;
  /** One settled step: `Ran a command`. */
  done: string;
  /** `n` settled steps of this category: `Ran 3 commands`. */
  counted: (n: number) => string;
  /**
   * May consecutive settled steps of this category fold into one counted
   * line? Only READS and shell commands (design D15): every write — a create,
   * an edit, a move, a spawn, a post — stays its own line, so the step list
   * matches the outcomes drawn above it one to one.
   */
  merges: boolean;
  /** One short human fact about THIS call — a file's basename, the agent's
   *  own description of a command, a created title. Never a payload dump. */
  detail: string | null;
  /** Distinct entities a graph read returned, so a group of reads can say
   *  `Read 3 tasks, 1 doc` instead of counting calls. */
  entities?: readonly { id: string; kind: string }[];
}

interface Phrase {
  category: string;
  active: string;
  done: string;
  counted: (n: number) => string;
  merges: boolean;
}

const phrase = (
  category: string,
  active: string,
  done: string,
  counted: (n: number) => string,
): Phrase => ({ category, active, done, counted, merges: MERGING.has(category) });

/** D15: the read-class categories, plus shell commands. Nothing that writes. */
const MERGING: ReadonlySet<string> = new Set([
  'graph-read', 'file-read', 'code-search', 'command', 'web-fetch', 'web-search',
  'memory-search', 'session-read', 'message-read', 'overview', 'guide', 'git',
]);

const FILE_READ = phrase('file-read', 'Reading a file', 'Read a file', (n) => `Read ${n} files`);
const CODE_SEARCH = phrase('code-search', 'Searching the code', 'Searched the code', (n) => `Searched the code ${n} times`);
const COMMAND = phrase('command', 'Running a shell command', 'Ran a shell command', (n) => `Ran ${n} commands`);
const FILE_EDIT = phrase('file-edit', 'Editing a file', 'Edited a file', (n) => `Edited ${n} files`);
const WEB_FETCH = phrase('web-fetch', 'Opening a web page', 'Opened a web page', (n) => `Opened ${n} web pages`);
const WEB_SEARCH = phrase('web-search', 'Searching the web', 'Searched the web', (n) => `Searched the web ${n} times`);
const PLAN = phrase('plan', 'Updating the to-do list', 'Updated the to-do list', (n) => `Updated the to-do list ${n} times`);
const SKILL = phrase('skill', 'Loading a skill', 'Loaded a skill', (n) => `Loaded ${n} skills`);
const MEMORY_WRITE = phrase('memory-write', 'Saving a memory', 'Saved a memory', (n) => `Saved ${n} memories`);
const MEMORY_SEARCH = phrase('memory-search', 'Searching memories', 'Searched memories', (n) => `Searched memories ${n} times`);
const SESSION_READ = phrase('session-read', 'Reading a session', 'Read a session', (n) => `Read ${n} sessions`);
const SESSION_MESSAGE = phrase('session-message', 'Messaging a session', 'Messaged a session', (n) => `Messaged ${n} sessions`);
const SESSION_STOP = phrase('session-stop', 'Stopping a session', 'Stopped a session', (n) => `Stopped ${n} sessions`);
const GIT = phrase('git', 'Checking git', 'Checked git', (n) => `Checked git ${n} times`);
const GIT_PR = phrase('git-pr', 'Opening a pull request', 'Opened a pull request', (n) => `Opened ${n} pull requests`);
const CONTAINER = phrase('container', 'Working in a container', 'Worked in a container', (n) => `Took ${n} container steps`);
const FORM = phrase('form', 'Creating a form', 'Created a form', (n) => `Created ${n} forms`);
const PRESENTATION = phrase('present', 'Preparing a presentation', 'Prepared a presentation', (n) => `Prepared ${n} presentations`);
const OVERVIEW = phrase('overview', 'Reading the space overview', 'Read the space overview', (n) => `Read the space overview ${n} times`);
const GUIDE = phrase('guide', 'Looking up what tm8 can do', 'Looked up what tm8 can do', (n) => `Looked up what tm8 can do ${n} times`);
/** D6: anything unclassified. Never the tool's name. */
const OTHER = phrase('other', 'Working', 'Did a step', (n) => `Did ${n} steps`);

/** Direct tools, by BARE name (`mcp__tm8__` stripped). Provider built-ins and
 *  the tm8 direct set both land here; their names do carry their verb. */
const TOOL_PHRASES: Readonly<Record<string, Phrase>> = {
  Read: FILE_READ,
  repo_read_file: FILE_READ,
  Glob: CODE_SEARCH,
  Grep: CODE_SEARCH,
  repo_glob: CODE_SEARCH,
  repo_grep: CODE_SEARCH,
  Bash: COMMAND,
  repo_bash: COMMAND,
  Edit: FILE_EDIT,
  Write: FILE_EDIT,
  MultiEdit: FILE_EDIT,
  NotebookEdit: FILE_EDIT,
  repo_write: FILE_EDIT,
  repo_edit: FILE_EDIT,
  repo_multi_edit: FILE_EDIT,
  WebFetch: WEB_FETCH,
  web_fetch: WEB_FETCH,
  WebSearch: WEB_SEARCH,
  web_search: WEB_SEARCH,
  TodoWrite: PLAN,
  Skill: SKILL,
  memory_write: MEMORY_WRITE,
  memory_search: MEMORY_SEARCH,
  session_transcript: SESSION_READ,
  session_tail: SESSION_READ,
  session_followup: SESSION_MESSAGE,
  session_stop: SESSION_STOP,
  git_status: GIT,
  git_diff: GIT,
  git_branch: GIT,
  git_pr: GIT_PR,
  container_run: CONTAINER,
  container_computer: CONTAINER,
  container_screenshot: CONTAINER,
  form_create: FORM,
  explain_diagram: PRESENTATION,
  explain_graph: PRESENTATION,
  explain_code: PRESENTATION,
  explain_asset: PRESENTATION,
  tm8_overview: OVERVIEW,
};

/** The graph GROUP tools: a call with no operation is a directory lookup. */
const GROUP_TOOLS = new Set(['tm8_read', 'tm8_act', 'tm8_delegate', 'tm8_messages']);

/**
 * Titles and kinds this thread already knows, by entity id — the ledger's
 * `labels`. Optional: without it a write names its kind or "an entity", never
 * an id (D6: omit an unknown title rather than show an id).
 */
export type StepLabels = ReadonlyMap<string, { kind?: string; title?: string }>;

/**
 * Describe one tool call. `result` is optional: a live call has none yet, and
 * the words for it must already be right (the live row renders them).
 */
export function describeToolStep(
  name: string,
  args: unknown,
  result?: unknown,
  labels?: StepLabels,
): ToolStepWords {
  const operation = operationOf(args);
  if (operation !== null) return graphWords(operation, args, result, labels);
  const bare = bareToolName(name);
  if (GROUP_TOOLS.has(bare)) return { ...GUIDE, detail: null };
  const a = record(args);
  if (bare === 'doc_create' || bare === 'artifact_create') {
    // D17: a created doc or artifact reads as a create like any other.
    return createWords(bare === 'doc_create' ? 'doc' : 'artifact', str(a?.title) ?? str(a?.name) ?? titleIn(result));
  }
  if (bare === 'doc_update') {
    const id = str(a?.docId);
    return editWords(str(a?.title) ?? (id ? labels?.get(id)?.title : undefined) ?? titleIn(result) ?? null, 'doc');
  }
  const known = TOOL_PHRASES[bare];
  if (known === FILE_READ || known === FILE_EDIT) {
    // D6: the basename rides in the settled words — `Read TurnParts.tsx`.
    const file = basename(str(a?.file_path) ?? str(a?.path) ?? str(a?.notebook_path));
    const verb = known === FILE_READ ? 'Read' : 'Edited';
    return { ...known, done: file ? `${verb} ${file}` : known.done, detail: null };
  }
  if (known) return { ...known, detail: directDetail(known, args) };
  return { ...OTHER, detail: null };
}

/**
 * The first line of a failed call's result, for a ✕ step: `Exit code 1`,
 * `version conflict`. A reason, not a dump — one line, capped.
 */
export function toolStepError(result: unknown): string | null {
  const raw = firstText(result, 0);
  if (!raw) return null;
  const line = raw
    .replace(/<\/?tool_use_error>/g, '')
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  return line ? clip(line, 120) : null;
}

/**
 * The words for N consecutive settled steps of ONE category — the counted
 * line. Graph reads count what came BACK, deduped across the group (`Read 3
 * tasks, 1 doc`), not how many calls asked; every other category counts calls
 * through its own `counted`. One step is just its own `done`.
 */
export function groupDone(steps: readonly ToolStepWords[]): string {
  const first = steps[0];
  if (!first) return '';
  if (steps.length === 1) return first.done;
  if (first.category === 'graph-read') {
    const seen = new Set<string>();
    const entities: { id: string; kind: string }[] = [];
    for (const step of steps) {
      for (const entity of step.entities ?? []) {
        if (seen.has(entity.id)) continue;
        seen.add(entity.id);
        entities.push(entity);
      }
    }
    if (entities.length > 0) return `Read ${entitySentence(entities)}`;
  }
  return first.counted(steps.length);
}

/* ── graph operations ─────────────────────────────────────────────────── */

/** The only two operations that change a status — the same two the ledger
 *  folds as transitions, so a `Moved` step always has its outcome above it.
 *  `tick` checks off acceptance criteria and `pull` pins a version; neither
 *  moves anything. */
const STATUS_OPS = new Set(['entities.commands.work', 'entities.commands.complete']);
const EDIT_OPS = new Set(['entities.patch', 'entities.header.set', 'entities.header.clear']);
const MOVE_OPS = new Set(['entities.move', 'placements.apply']);

function graphWords(
  operation: string,
  args: unknown,
  result: unknown,
  labels: StepLabels | undefined,
): ToolStepWords {
  const b = record(record(args)?.body);
  const targetId = str(record(record(args)?.params)?.id);
  const target = targetId ? labels?.get(targetId) : undefined;
  const targetTitle = target?.title ?? (targetId ? titleIn(result, targetId) : null);
  if (operation === 'entities.create') {
    return createWords(str(b?.kind) ?? 'entity', str(b?.title) ?? titleIn(result));
  }
  if (operation === 'execution.spawn') {
    const title = titleIn(result);
    return {
      ...phrase('spawn', 'Spawning a session', 'Spawned a session', (n) => `Spawned ${n} sessions`),
      ...(title ? { done: `Spawned session ${quote(title)}` } : {}),
      detail: null,
    };
  }
  if (operation === 'execution.dispatch') {
    return { ...phrase('dispatch', 'Dispatching work', 'Dispatched work', (n) => `Dispatched work ${n} times`), detail: null };
  }
  if (operation === 'execution.terminate') return { ...SESSION_STOP, detail: null };
  if (operation === 'execution.resume') {
    return { ...phrase('resume', 'Resuming a session', 'Resumed a session', (n) => `Resumed ${n} sessions`), detail: null };
  }
  if (STATUS_OPS.has(operation)) {
    // D6: `Moving “Title” to done` / `Moved “Title” to done`.
    const to = operation === 'entities.commands.complete' ? 'done' : str(b?.status);
    const subject = targetTitle
      ? quote(targetTitle)
      : article(kindWord(target?.kind ?? 'entity', 1));
    const tail = to ? ` to ${to}` : '';
    return {
      ...phrase('status', `Moving ${subject}${tail}`, `Moved ${subject}${tail}`, (n) => `Moved ${n} entities`),
      detail: null,
    };
  }
  if (operation === 'entities.commands.tick') {
    const subject = targetTitle ? quote(targetTitle) : article(kindWord(target?.kind ?? 'entity', 1));
    return {
      ...phrase('tick', `Ticking criteria on ${subject}`, `Ticked criteria on ${subject}`, (n) => `Ticked criteria ${n} times`),
      detail: null,
    };
  }
  if (operation === 'messages.post') {
    return { ...phrase('message', 'Posting a message', 'Posted a message', (n) => `Posted ${n} messages`), detail: null };
  }
  if (EDIT_OPS.has(operation)) return editWords(targetTitle, target?.kind ?? null);
  if (MOVE_OPS.has(operation)) {
    return { ...phrase('entity-move', 'Moving an entity', 'Moved an entity', (n) => `Moved ${n} entities`), detail: null };
  }
  if (operation === 'entities.delete') {
    return { ...phrase('entity-delete', 'Deleting an entity', 'Deleted an entity', (n) => `Deleted ${n} entities`), detail: null };
  }
  if (operation.startsWith('edges.')) {
    return { ...phrase('link', 'Linking entities', 'Linked entities', (n) => `Changed ${n} links`), detail: null };
  }
  if (isWriteCall('', args)) {
    return { ...phrase('graph-write', 'Updating the graph', 'Updated the graph', (n) => `Made ${n} graph changes`), detail: null };
  }
  if (operation.startsWith('messages.')) {
    return { ...phrase('message-read', 'Reading messages', 'Read messages', (n) => `Read messages ${n} times`), detail: null };
  }
  return graphRead(operation, args, result);
}

/** D6 create words: `Creating task “X”` / `Created task “X”`; no title yet ⇒
 *  `Creating a task`, never an id. Writes never merge (D15). */
function createWords(kind: string, title: string | null): ToolStepWords {
  const one = kindWord(kind, 1);
  const subject = title ? `${one} ${quote(title)}` : article(one);
  return {
    category: `create:${kind}`,
    merges: false,
    active: `Creating ${subject}`,
    done: `Created ${subject}`,
    counted: (n) => `Created ${n} ${kindWord(kind, n)}`,
    detail: null,
  };
}

/** D6 edit words: `Editing “Title”` / `Edited “Title”`. */
function editWords(title: string | null, kind: string | null): ToolStepWords {
  const subject = title ? quote(title) : article(kindWord(kind ?? 'entity', 1));
  return {
    ...phrase('entity-edit', `Editing ${subject}`, `Edited ${subject}`, (n) => `Edited ${n} entities`),
    detail: null,
  };
}

function graphRead(operation: string, args: unknown, result: unknown): ToolStepWords {
  const searching = /search|query/i.test(operation);
  const hint = kindHint(args);
  // D6: `Reading tasks` before the result, `Read 3 tasks, 2 docs` after.
  const active = hint
    ? `Reading ${kindWord(hint, 2)}`
    : searching
      ? 'Searching the graph'
      : 'Reading the graph';
  const entities = result === undefined ? [] : entitiesIn(result);
  const counted = (n: number) => `Looked up the graph ${n} times`;
  const base = { category: 'graph-read', merges: true, active, counted, detail: null };
  if (entities.length === 0) {
    return { ...base, done: searching ? 'Searched the graph' : 'Read the graph', entities };
  }
  const first = entities[0]!;
  return {
    ...base,
    done: entities.length === 1 && first.title
      ? `Read ${kindWord(first.kind, 1)} ${quote(first.title)}`
      : `Read ${entitySentence(entities)}`,
    entities: entities.map(({ id, kind }) => ({ id, kind })),
  };
}

/** `3 tasks, 1 doc` — largest bucket first, the unknown-kind bucket last, the
 *  same order the transcript's read line uses. */
export function entitySentence(entities: readonly { id: string; kind: string }[]): string {
  if (entities.length === 1) return article(kindWord(entities[0]!.kind, 1));
  const byKind = new Map<string, number>();
  for (const { kind } of entities) byKind.set(kind, (byKind.get(kind) ?? 0) + 1);
  return [...byKind.entries()]
    .sort(([ak, an], [bk, bn]) => {
      if ((ak === 'entity') !== (bk === 'entity')) return ak === 'entity' ? 1 : -1;
      return bn - an || ak.localeCompare(bk);
    })
    .map(([kind, n]) => `${n} ${kindWord(kind, n)}`)
    .join(', ');
}

/**
 * Distinct entities in a result, cached on the result's identity: a streaming
 * turn re-renders on every delta, and re-walking every settled read each time
 * is work for nothing. The stored content object survives re-projection.
 */
const ENTITY_CACHE = new WeakMap<object, readonly { id: string; kind: string; title: string | null }[]>();

function entitiesIn(result: unknown): readonly { id: string; kind: string; title: string | null }[] {
  const key = typeof result === 'object' && result !== null ? result : null;
  const cached = key ? ENTITY_CACHE.get(key) : undefined;
  if (cached) return cached;
  const seen = new Set<string>();
  const out: { id: string; kind: string; title: string | null }[] = [];
  walkPayload(
    result,
    {
      onEntityObject: (id, fields) => {
        if (seen.has(id)) return;
        seen.add(id);
        out.push({ id, kind: fields.kind ?? 'entity', title: fields.title ?? null });
      },
    },
    { maxNodes: 20000, maxDepth: 8 },
  );
  if (key) ENTITY_CACHE.set(key, out);
  return out;
}

function kindHint(args: unknown): string | null {
  const a = record(args);
  for (const bag of [record(a?.query), record(a?.params), record(a?.body)]) {
    const kind = str(bag?.kind);
    if (kind) return kind;
  }
  return null;
}

/* ── direct tools ─────────────────────────────────────────────────────── */

function directDetail(known: Phrase, args: unknown): string | null {
  const a = record(args);
  if (!a) return null;
  switch (known) {
    case CODE_SEARCH:
      return quoted(clipOrNull(str(a.pattern) ?? str(a.query), 48));
    case COMMAND:
      // The agent's OWN one-line description of the command. Never the
      // command itself: a shell line can carry a token, and it is a payload.
      return clipOrNull(str(a.description), 80);
    case WEB_FETCH:
      return host(str(a.url));
    case WEB_SEARCH:
      return quoted(clipOrNull(str(a.query), 60));
    case SKILL:
      return clipOrNull(str(a.skill) ?? str(a.name), 48);
    default:
      return null;
  }
}

/* ── small readers ────────────────────────────────────────────────────── */

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function article(word: string): string {
  return /^[aeiou]/i.test(word) ? `an ${word}` : `a ${word}`;
}

function quoted(value: string | null): string | null {
  return value ? quote(value) : null;
}

/** D14: curly quotes, titles cut at 60 with `…`. */
function quote(title: string): string {
  return `“${clip(title, 60)}”`;
}

/** The title of the entity a result carries — the one named `id` when given,
 *  else the first. Null when the result names none. */
function titleIn(result: unknown, id?: string): string | null {
  if (result === undefined) return null;
  const entities = entitiesIn(result);
  const hit = id ? entities.find((e) => e.id === id) : entities[0];
  return hit?.title ?? null;
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function clipOrNull(value: string | null, max: number): string | null {
  return value ? clip(value, max) : null;
}

function basename(path: string | null): string | null {
  if (!path) return null;
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length > 0 ? clip(parts[parts.length - 1]!, 60) : null;
}

function host(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).host || null;
  } catch {
    return null;
  }
}

/** The first human-readable text in a result: a string, a `{type:'text'}`
 *  block, a JSON error envelope's message. Bounded depth; never throws. */
function firstText(value: unknown, depth: number): string | null {
  if (depth > 4) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.startsWith('{')) {
      try {
        const parsed = firstText(JSON.parse(trimmed) as unknown, depth + 1);
        if (parsed) return parsed;
      } catch {
        /* not JSON — the string is the message */
      }
    }
    return trimmed.length > 0 ? trimmed : null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const text = firstText(item, depth + 1);
      if (text) return text;
    }
    return null;
  }
  const r = record(value);
  if (!r) return null;
  const error = r.error;
  if (typeof error === 'string' && error.trim()) return error.trim();
  const nested = record(error);
  if (nested && typeof nested.message === 'string' && nested.message.trim()) return nested.message.trim();
  for (const key of ['message', 'text'] as const) {
    const v = r[key];
    if (typeof v === 'string' && v.trim()) return firstText(v, depth + 1);
  }
  return null;
}
