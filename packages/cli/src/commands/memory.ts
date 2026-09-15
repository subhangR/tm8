/**
 * `tm8 memory record|list|show|supersede|search` — the memory noun.
 *
 * WHY THIS NOUN EXISTS. Before it, an agent working in a work session had NO
 * door to save a memory: `tm8 help memory` answered "no help for memory", the
 * only grammar reference was `session spawn --memory <id>`, and the MCP
 * `memory_write` tool reaches chat teammates only. The spawn injector
 * (server `execution-handlers.ts`, `renderMemories` + the `memoryRows` query)
 * already CARRIES a teammate's own memories into its next session — by the
 * `created_by` column and by `remembers(work_session → memory)` through
 * `relates_to(work_session → team_member)` — so the missing half was purely the
 * write door. This module is that door.
 *
 * FIVE VERBS, FOUR OF THEM SUGAR. Every command here is registered in
 * `src/discovery/operations.ts` as a `COMMAND_ALIASES` entry, exactly the way
 * `chat list`, `worktree status` and `task import-issue` are, and four of the
 * five put only pre-existing operations on the wire:
 *
 *   memory record     entities.create (kind memory) [+ edges.create for --about]
 *   memory list       collections.query kinds:[memory] [+ filters.edge for --holder]
 *   memory show       entities.get
 *   memory supersede  entities.get (pre-flight) + entities.create + edges.create
 *   memory search     memories.search
 *
 * The memory design (docs/features/memory/MEMORY-DESIGN-FINAL.md §5.2, §6.5)
 * is explicit that the catalog gains nothing for the WRITE path: `create_memory`
 * joins the `entities.create` ledger label, and "no new read operation is
 * proposed and none is needed". A `memories.record` row would have opened the
 * catalog for a door that already exists, cost a contract registration, a
 * server handler this lane does not own, and a digest/count re-pin — for a
 * command whose only wire act is an ordinary entity create.
 *
 * `memories.search` is the one place that reasoning did not hold, and the
 * search lane says why in its own catalog note: §6.5 predates the measurement
 * that the substring search this command used to do saw about a ninth of an
 * average memory and none of its boundary. That operation carries NO command
 * of its own (`cmd: null` in the operations table) — `tm8 memory search` is
 * its only invocation, so one action never gets two names, and the two halves
 * meet in the `COMMAND_ALIASES` entry rather than colliding on a command key.
 *
 * SESSION PROVENANCE IS THE POINT. When this process IS a work session
 * (`TM8_SESSION_ID`, read into `ctx.sessionId`), `record` and `supersede`
 * send it as `content.workSessionId`. The server's `create_memory` (migration
 * 056, replaced verbatim-plus-one-insert by 090) validates that the acting
 * actor `participates_in` that session, then writes `authored_from(memory →
 * session)` under the recorder writer token AND `remembers(session → memory)`
 * (090 D10: "a session that AUTHORS a memory remembers it"). That second edge
 * is what the spawn injector's D10 carry reads, so a fact this session
 * establishes reaches the teammate's next session. Provenance is never drawn
 * client-side — the CLI only NAMES the session; the server decides.
 *
 * A session id that is not a UUID cannot name a session and would fail the
 * whole create on a type cast, so it is skipped WITH A WARNING rather than sent
 * (the same rule `entity create` applies to its `created_in` claim). A
 * well-formed id the server refuses (actor not a participant, session in
 * another database) fails the create — silently dropping provenance the
 * caller's environment asserted would recreate the exact bug this lane closes.
 *
 * MULTI-STEP WRITES REPORT PARTIAL SUCCESS LOUDLY. `record --about` and
 * `supersede` create the memory FIRST and draw edges AFTER, in separate
 * requests, because a connection carried inside the create body fails the
 * WHOLE create when its target cannot be resolved (see `entity create`'s
 * `linkCreatedInSession` for the measured history). When an edge then fails,
 * the memory already exists: the result on stdout names it, the diagnostic on
 * stderr names the exact `tm8 edge create` that finishes the job, and the
 * exit code is the edge failure's — never 0, because the caller asked for two
 * things and got one. Edge mutation ids are DERIVED from the create's id
 * (`deriveMutationId`), so a retry with the same `--mutation-id` replays the
 * create and completes only what is missing.
 */
import { requireSpace } from '../context.js';
import { ApiError } from '../errors.js';
import { CliError, EXIT_CONFLICT, EXIT_OK, EXIT_USAGE, type ExitCode } from '../exit.js';
import { UUID_PATTERN, deriveMutationId, refuseMutationId, resolveMutationId } from '../mutation.js';
import { clientFor, observedInvoke } from '../discovery/observe.js';
import { commandDiscovery } from '../discovery/operations.js';
import type { CommandContext, CommandModule } from '../run.js';
import { assertKnownOptions, requireArg, withActor } from './entity.js';

// ── the four parts of a memory ─────────────────────────────────────────────

/**
 * The four fields `create_memory` requires, in the order a reader meets them.
 * `label` is the plain-language name a refusal uses; `max` mirrors the
 * server's own btrim length bounds (056) so an over-long value is refused here
 * with a sentence instead of by the wire with an error code.
 */
const MEMORY_FIELDS = [
  { option: 'statement', key: 'statement', label: 'what is true', max: 4000 },
  { option: 'mechanism', key: 'mechanism', label: 'how you found out', max: 1000 },
  { option: 'scope', key: 'subjectScope', label: 'where it applies', max: 1000 },
  { option: 'does-not-establish', key: 'doesNotEstablish', label: 'what it does not prove', max: 1000 },
] as const;

const FIELD_OPTIONS: readonly string[] = MEMORY_FIELDS.map((f) => f.option);

interface MemoryFields {
  statement: string;
  mechanism: string;
  subjectScope: string;
  doesNotEstablish: string;
}

/**
 * Read all four parts, refusing ONCE with every missing one named. A refusal
 * that names only the first gap sends the caller round the loop four times.
 */
function readMemoryFields(cmd: CommandContext): MemoryFields {
  const values: Record<string, string> = {};
  const missing: string[] = [];
  for (const field of MEMORY_FIELDS) {
    const raw = cmd.options.value(field.option);
    const value = raw?.trim() ?? '';
    if (value.length === 0) {
      missing.push(`--${field.option} (${field.label})`);
      continue;
    }
    if (value.length > field.max) {
      throw new CliError(
        `--${field.option} can be at most ${field.max} characters; this one is ${value.length}`,
        EXIT_USAGE,
      );
    }
    values[field.key] = value;
  }
  if (missing.length > 0) {
    const syntax = commandDiscovery(cmd.path)?.syntax;
    throw new CliError(
      `\`tm8 ${cmd.path.join(' ')}\` needs every part of a memory; missing ${missing.join(', ')}`,
      EXIT_USAGE,
      {
        hint: syntax
          ? `syntax: ${syntax}`
          : 'a memory says what is true, how you found out, where it applies, and what it does not prove',
      },
    );
  }
  return values as unknown as MemoryFields;
}

/**
 * The title the create body must carry (`CreateEntityInput.title` is
 * required). The server DERIVES a memory's real title from the statement —
 * first 120 characters, whitespace collapsed (`entity-read.ts`) — and ignores
 * this one, so the same rule is applied here to send nothing misleading.
 */
function titleOf(statement: string): string {
  return statement.replace(/\s+/g, ' ').trim().slice(0, 120) || 'Memory';
}

/**
 * The session to claim as this memory's author, when this process is one.
 * See the module header for why a malformed id is skipped rather than sent.
 */
function authoringSession(cmd: CommandContext): string | undefined {
  const sessionId = cmd.ctx.sessionId;
  if (sessionId === undefined) return undefined;
  if (!UUID_PATTERN.test(sessionId)) {
    cmd.out.warn(
      'note: this process names a work session that cannot be a real one, so the memory ' +
        'is being saved without a record of which session learned it.',
    );
    return undefined;
  }
  return sessionId;
}

interface Created {
  entity?: { id?: unknown; title?: unknown; version?: unknown; kind?: unknown };
}

function idOf(result: unknown): string {
  const id = (result as Created | null)?.entity?.id;
  if (typeof id !== 'string' || id.length === 0) {
    throw new CliError('the Server saved the memory but did not say which one', EXIT_CONFLICT);
  }
  return id;
}

/** One `entities.create` of kind `memory`, with session provenance when present. */
async function createMemory(
  cmd: CommandContext,
  fields: MemoryFields,
  mutationId: string,
): Promise<unknown> {
  const sessionId = authoringSession(cmd);
  const content: Record<string, unknown> = { ...fields };
  if (sessionId !== undefined) content.workSessionId = sessionId;
  const body = withActor(cmd, {
    clientMutationId: mutationId,
    spaceId: requireSpace(cmd.ctx),
    kind: 'memory',
    title: titleOf(fields.statement),
    content,
  });
  try {
    return await observedInvoke<unknown>(clientFor(cmd.ctx), 'entities.create', { body });
  } catch (err) {
    // `create_memory` refuses (42501 → forbidden) when the acting actor does not
    // participate in the named session. The server's sentence names the
    // mechanism; this one says what to do about it.
    if (err instanceof ApiError && err.code === 'forbidden' && sessionId !== undefined) {
      err.hint =
        'this process says it is working inside a session that the teammate acting here is not part of, ' +
        'so the memory was not saved. Run the command from inside the session that is doing the work.';
    }
    throw err;
  }
}

interface EdgeResult {
  edge?: { id?: unknown };
}

/**
 * The failure of a follow-up edge, carrying the sentence that finishes the
 * job. `ApiError.hint` is assignable after the fact; `CliError.hint` is not,
 * so a local error is re-wrapped with its own message and exit code intact.
 */
function withHint(err: unknown, hint: string): Error {
  if (err instanceof ApiError) {
    err.hint = hint;
    return err;
  }
  if (err instanceof CliError) return new CliError(err.message, err.exitCode, { detail: err.detail, hint });
  return err instanceof Error ? err : new Error(String(err));
}

async function drawEdge(
  cmd: CommandContext,
  edge: { srcId: string; dstId: string; type: string; props?: Record<string, unknown>; clientMutationId: string },
): Promise<EdgeResult> {
  const body: Record<string, unknown> = {
    srcId: edge.srcId,
    dstId: edge.dstId,
    type: edge.type,
    clientMutationId: edge.clientMutationId,
  };
  // Omitted rather than `{}`: `about` declares NO properties and closes its
  // schema, so an empty object is a different request from an absent key.
  if (edge.props !== undefined) body.props = edge.props;
  return await observedInvoke<EdgeResult>(clientFor(cmd.ctx), 'edges.create', { body: withActor(cmd, body) });
}

// ── human rendering ────────────────────────────────────────────────────────

interface MemoryRow {
  id?: unknown;
  kind?: unknown;
  title?: unknown;
  excerpt?: unknown;
  version?: unknown;
  createdAt?: unknown;
  createdBy?: { displayName?: unknown } | null;
  content?: { statement?: unknown; mechanism?: unknown; subjectScope?: unknown; doesNotEstablish?: unknown; measuredAt?: unknown };
  state?: { kind?: unknown; mechanism?: unknown; subjectScope?: unknown; doesNotEstablish?: unknown; measuredAt?: unknown };
  badges?: {
    staleness?: {
      reasons?: unknown;
      superseded?: { byId?: unknown; headId?: unknown };
      disputed?: { openCount?: unknown };
      basisDeleted?: { count?: unknown };
      basisMoved?: { count?: unknown };
      verified?: { current?: unknown };
    };
  };
}

/**
 * The marks against a memory, in the server's own precedence order, as
 * words a reader can act on. Absence is rendered as absence: an unflagged
 * memory is NOT a verified one (the badge is omitted entirely when nothing is
 * wrong), so no positive word is ever invented from silence.
 */
function marksOf(row: MemoryRow): string[] {
  const staleness = row.badges?.staleness;
  const reasons = Array.isArray(staleness?.reasons) ? (staleness.reasons as string[]) : [];
  const marks: string[] = [];
  for (const reason of reasons) {
    switch (reason) {
      case 'superseded': {
        const by = staleness?.superseded?.headId ?? staleness?.superseded?.byId;
        marks.push(by ? `replaced by ${String(by)}` : 'replaced');
        break;
      }
      case 'disputed': {
        const open = Number(staleness?.disputed?.openCount ?? 0);
        marks.push(open > 1 ? `disputed (${open} open)` : 'disputed');
        break;
      }
      case 'basisDeleted':
        marks.push('rests on something since deleted');
        break;
      case 'basisMoved':
        marks.push('rests on something since changed');
        break;
      default:
        marks.push(String(reason));
    }
  }
  if (staleness?.verified?.current === true) marks.push('verified');
  return marks;
}

/** One memory as a line: id first (every follow-up command takes it), then the claim, version, marks. */
function memoryLine(row: MemoryRow): string {
  const parts = [String(row.id ?? ''), String(row.title ?? '')];
  if (row.version !== undefined) parts.push(`v${String(row.version)}`);
  const marks = marksOf(row);
  if (marks.length > 0) parts.push(`[${marks.join(', ')}]`);
  return parts.filter((p) => p !== '').join('  ');
}

function renderMemoryPage(dto: unknown): string {
  const result = (dto ?? {}) as { page?: { items?: MemoryRow[]; nextCursor?: unknown } };
  const items = result.page?.items ?? [];
  const lines = items.map(memoryLine);
  if (typeof result.page?.nextCursor === 'string' && result.page.nextCursor.length > 0) {
    lines.push(`next-cursor: ${result.page.nextCursor}`);
  }
  return lines.length > 0 ? lines.join('\n') : 'no memories';
}

const LABELS = {
  statement: 'What is true',
  mechanism: 'How it was found out',
  subjectScope: 'Where it applies',
  doesNotEstablish: 'What it does not prove',
} as const;

function pad(label: string): string {
  return `${label}:`.padEnd(25);
}

function renderMemoryDetail(dto: unknown): string {
  const row = (dto ?? {}) as MemoryRow;
  // The statement lives in `content` (details only); the scope fields ride
  // in `state` on every read. A detail carries both, but the content copy of
  // a scope field is preferred when present so the two never disagree on
  // screen.
  const field = (key: keyof typeof LABELS): string => {
    const fromContent = row.content?.[key];
    const fromState = key === 'statement' ? undefined : row.state?.[key];
    return String(fromContent ?? fromState ?? '');
  };
  const lines = [
    `memory ${String(row.id ?? '')}  v${String(row.version ?? '?')}`,
    `${pad(LABELS.statement)}${field('statement')}`,
    `${pad(LABELS.mechanism)}${field('mechanism')}`,
    `${pad(LABELS.subjectScope)}${field('subjectScope')}`,
    `${pad(LABELS.doesNotEstablish)}${field('doesNotEstablish')}`,
  ];
  const measuredAt = row.content?.measuredAt ?? row.state?.measuredAt;
  if (typeof measuredAt === 'string' && measuredAt.length > 0) lines.push(`${pad('Measured at')}${measuredAt}`);
  const who = row.createdBy?.displayName;
  const when = row.createdAt;
  if (typeof when === 'string' || typeof who === 'string') {
    lines.push(`${pad('Recorded')}${[when, who ? `by ${String(who)}` : undefined].filter(Boolean).join(' ')}`);
  }
  const marks = marksOf(row);
  lines.push(`${pad('Status')}${marks.length > 0 ? marks.join('; ') : 'nothing is marked against this memory'}`);
  return lines.join('\n');
}

interface AboutLink {
  entityId: string;
  edgeId?: string;
  error?: string;
}

function renderRecorded(dto: unknown): string {
  const result = (dto ?? {}) as Created & { about?: AboutLink[] };
  const lines = [memoryLine((result.entity ?? {}) as MemoryRow)];
  for (const link of result.about ?? []) {
    lines.push(
      link.error === undefined
        ? `about ${link.entityId}  (linked)`
        : `about ${link.entityId}  (NOT linked: ${link.error})`,
    );
  }
  return lines.filter((l) => l !== '').join('\n');
}

function renderSuperseded(dto: unknown): string {
  const result = (dto ?? {}) as Created & { supersedes?: { memoryId?: string; edgeId?: string | null } };
  const lines = [memoryLine((result.entity ?? {}) as MemoryRow)];
  const old = result.supersedes?.memoryId;
  if (old) {
    lines.push(
      result.supersedes?.edgeId
        ? `replaces ${old}`
        : `does NOT yet replace ${old} — the mark could not be written`,
    );
  }
  return lines.filter((l) => l !== '').join('\n');
}

// ── record ─────────────────────────────────────────────────────────────────

async function memoryRecord(cmd: CommandContext): Promise<ExitCode> {
  assertKnownOptions(cmd, [...FIELD_OPTIONS, 'about', 'mutation-id']);
  const fields = readMemoryFields(cmd);
  const about = [...new Set(cmd.options.values('about').map((v) => v.trim()).filter((v) => v.length > 0))];
  const mutationId = resolveMutationId(cmd.options.value('mutation-id'));

  const created = await createMemory(cmd, fields, mutationId);
  if (about.length === 0) {
    cmd.out.data(created, renderRecorded);
    return EXIT_OK;
  }

  // The memory exists from here on. Every requested link is attempted — one
  // bad target must not stop the others — and the first failure is what the
  // exit code reports, after the result has named the memory.
  const memoryId = idOf(created);
  const links: AboutLink[] = [];
  let failure: unknown;
  for (const target of about) {
    try {
      const result = await drawEdge(cmd, {
        srcId: memoryId,
        dstId: target,
        type: 'about',
        clientMutationId: deriveMutationId(mutationId, `about:${target}`),
      });
      const edgeId = result?.edge?.id;
      links.push({ entityId: target, ...(typeof edgeId === 'string' ? { edgeId } : {}) });
    } catch (err) {
      links.push({ entityId: target, error: err instanceof Error ? err.message : String(err) });
      failure ??= err;
    }
  }
  cmd.out.data({ ...(created as object), about: links }, renderRecorded);
  if (failure !== undefined) {
    const unlinked = links.filter((l) => l.error !== undefined).map((l) => l.entityId);
    const fix = unlinked.map((id) => `tm8 edge create ${memoryId} about ${id}`).join('; ');
    throw withHint(
      failure,
      `the memory was saved as ${memoryId}, but it could not be linked to ${unlinked.join(', ')}. Link it with: ${fix}`,
    );
  }
  return EXIT_OK;
}

// ── list ───────────────────────────────────────────────────────────────────

async function memoryList(cmd: CommandContext): Promise<ExitCode> {
  refuseMutationId('memory list', cmd.options.value('mutation-id'));
  assertKnownOptions(cmd, ['holder', 'limit', 'cursor']);

  const body: Record<string, unknown> = {
    spaceId: requireSpace(cmd.ctx),
    kinds: ['memory'],
    // Newest first, and the same sort every time: a page cursor is minted for
    // one sort and is meaningless under another.
    sort: 'createdAt_desc',
  };
  // A holder's working set is the memories it has an inbound `remembers`
  // edge to (056; any kind may hold one since 090 D9). Asked as a collection
  // filter rather than as an edge list so both forms of this command return
  // MEMORIES — with their marks — through one renderer.
  const holder = cmd.options.value('holder')?.trim();
  if (holder !== undefined && holder.length > 0) {
    body.filters = { edge: { type: 'remembers', direction: 'incoming', entityId: holder } };
  }
  const limit = cmd.options.integer('limit');
  if (limit !== undefined) {
    if (limit <= 0) throw new CliError(`--limit <count> expects a positive count, got ${limit}`, EXIT_USAGE);
    body.limit = limit;
  }
  const cursor = cmd.options.value('cursor');
  if (cursor !== undefined) body.cursor = cursor;

  const data = await observedInvoke<unknown>(clientFor(cmd.ctx), 'collections.query', { body });
  cmd.out.data(data, renderMemoryPage);
  return EXIT_OK;
}

// ── show ───────────────────────────────────────────────────────────────────

/** `entities.get`, refused by name when the id is not a memory's. */
async function readMemory(cmd: CommandContext, id: string): Promise<MemoryRow> {
  const data = await observedInvoke<MemoryRow>(clientFor(cmd.ctx), 'entities.get', { params: { id } });
  const kind = data?.kind;
  if (kind !== 'memory') {
    throw new CliError(
      `${id} is ${kind ? `a ${String(kind)}` : 'something else'}, not a memory`,
      EXIT_USAGE,
      { hint: 'read any entity with `tm8 entity get <entity-id>`; `tm8 memory list` shows the memories in this Space' },
    );
  }
  return data;
}

async function memoryShow(cmd: CommandContext): Promise<ExitCode> {
  refuseMutationId('memory show', cmd.options.value('mutation-id'));
  assertKnownOptions(cmd, []);
  const id = requireArg(cmd, 0, '<memory-id>');
  const data = await readMemory(cmd, id);
  cmd.out.data(data, renderMemoryDetail);
  return EXIT_OK;
}

// ── supersede ──────────────────────────────────────────────────────────────

async function memorySupersede(cmd: CommandContext): Promise<ExitCode> {
  assertKnownOptions(cmd, ['reason', ...FIELD_OPTIONS, 'mutation-id']);
  const oldId = requireArg(cmd, 0, '<memory-id>');
  const reason = cmd.options.value('reason')?.trim() ?? '';
  if (reason.length === 0) {
    throw new CliError('`tm8 memory supersede` needs --reason: why the old claim is wrong', EXIT_USAGE);
  }
  const fields = readMemoryFields(cmd);

  // PRE-FLIGHT, before any write: the old id must name a memory, or the
  // corrected claim would be saved and then fail to mark anything — an orphan
  // the caller has to find and clean up. One read is cheaper than that.
  const old = await readMemory(cmd, oldId);
  const alreadyBy = old.badges?.staleness?.superseded;
  if (alreadyBy !== undefined) {
    const head = alreadyBy.headId ?? alreadyBy.byId;
    throw new CliError(
      `${oldId} has already been replaced${head ? ` by ${String(head)}` : ''}`,
      EXIT_CONFLICT,
      { hint: head ? `supersede ${String(head)} instead, so the chain of corrections stays one line` : undefined },
    );
  }

  const mutationId = resolveMutationId(cmd.options.value('mutation-id'));
  const created = await createMemory(cmd, fields, mutationId);
  const newId = idOf(created);
  try {
    const result = await drawEdge(cmd, {
      srcId: newId,
      dstId: oldId,
      type: 'supersedes',
      props: { reason },
      clientMutationId: deriveMutationId(mutationId, 'supersedes'),
    });
    const edgeId = result?.edge?.id;
    cmd.out.data(
      { ...(created as object), supersedes: { memoryId: oldId, edgeId: typeof edgeId === 'string' ? edgeId : null } },
      renderSuperseded,
    );
    return EXIT_OK;
  } catch (err) {
    cmd.out.data({ ...(created as object), supersedes: { memoryId: oldId, edgeId: null } }, renderSuperseded);
    throw withHint(
      err,
      `the corrected memory was saved as ${newId}, but ${oldId} was not marked as replaced. ` +
        `Finish with: tm8 edge create ${newId} supersedes ${oldId} --props '${JSON.stringify({ reason })}'`,
    );
  }
}

// ── search ─────────────────────────────────────────────────────────────────

/**
 * THE SEARCH RUNS WHERE THE MEMORIES ARE. `memories.search` hands the words to
 * the Server, which matches them against every part of every memory in the
 * Space — what it claims, how that was established, what it applies to, and
 * what it does not prove — ranks the matches, answers a memory that has been
 * replaced as its latest version, and returns only what the caller is allowed
 * to read.
 *
 * WHAT THIS REPLACED, and why the help copy lost a sentence. Until the
 * operation existed, this command asked `collections.query` for the hundred
 * most recently updated memories and substring-scanned them in this process,
 * over a summary that carries the first 120 characters of the statement and
 * nothing of the other three fields. It therefore had to warn that older
 * memories were left unsearched, and it could not find a memory by the
 * boundary that is half the reason to record one. There is nothing left to
 * warn about: the search reaches every memory in the Space, so the pool size,
 * the local ranking and the caveat are all gone with it. Relevance is decided
 * once, where the rows are — a second opinion here would be the same split
 * this change closes.
 */
const SEARCH_DEFAULT_LIMIT = 10;
/** The most matches the Server will answer at once; asking for more is refused here, in a sentence. */
const SEARCH_MAX_LIMIT = 200;
/**
 * The longest query the Server accepts. Checked here for the same reason
 * `record` checks its four field lengths here: a bound the caller has crossed
 * should come back as a sentence about what they typed, not as a validation
 * error from the wire about a string.
 */
const SEARCH_MAX_QUERY = 1000;

/** One match, as the Server answers it. */
interface SearchHit {
  id?: unknown;
  statement?: unknown;
  marks?: unknown;
}

/**
 * The marks on a match, said the way the rest of this noun says them.
 *
 * `list` and `show` derive their marks from the badge block and spell each one
 * out for a reader; a match arrives with the same words already chosen, so
 * only the two that are shorthand are expanded. A word this table does not
 * know is shown as it came — a mark nobody has a phrase for is still a mark,
 * and silently dropping it would hide exactly what the reader needs.
 */
const MARK_WORDS: Record<string, string> = {
  superseded: 'replaced',
  'basis deleted': 'rests on something since deleted',
  'basis changed': 'rests on something since changed',
};

/** One match as a line: id first (every follow-up command takes it), then the claim, then any marks. */
function hitLine(hit: SearchHit): string {
  const marks = (Array.isArray(hit.marks) ? hit.marks : []).map((m) => MARK_WORDS[String(m)] ?? String(m));
  const parts = [String(hit.id ?? ''), String(hit.statement ?? '')];
  if (marks.length > 0) parts.push(`[${marks.join(', ')}]`);
  return parts.filter((p) => p !== '').join('  ');
}

function renderSearch(dto: unknown): string {
  const result = (dto ?? {}) as { query?: unknown; items?: SearchHit[] };
  const items = result.items ?? [];
  return items.length > 0
    ? items.map(hitLine).join('\n')
    : `no memories mention "${String(result.query ?? '')}"`;
}

async function memorySearch(cmd: CommandContext): Promise<ExitCode> {
  refuseMutationId('memory search', cmd.options.value('mutation-id'));
  assertKnownOptions(cmd, ['limit']);
  const query = cmd.args.join(' ').trim();
  if (query.length === 0) {
    throw new CliError('`tm8 memory search` needs at least one word to look for', EXIT_USAGE, {
      hint: 'syntax: tm8 memory search <query> [--limit <count>]',
    });
  }
  if (query.length > SEARCH_MAX_QUERY) {
    throw new CliError(
      `that is too much to search for at once — ${SEARCH_MAX_QUERY} characters is the most, and this is ${query.length}`,
      EXIT_USAGE,
      { hint: 'search for the words that matter; `tm8 memory list` pages through every memory in this Space' },
    );
  }
  const limit = cmd.options.integer('limit') ?? SEARCH_DEFAULT_LIMIT;
  if (limit <= 0) throw new CliError(`--limit <count> expects a positive count, got ${limit}`, EXIT_USAGE);
  if (limit > SEARCH_MAX_LIMIT) {
    throw new CliError(
      `--limit <count> can ask for at most ${SEARCH_MAX_LIMIT} matches at a time, not ${limit}`,
      EXIT_USAGE,
    );
  }

  const data = await observedInvoke<{ items?: SearchHit[] }>(clientFor(cmd.ctx), 'memories.search', {
    body: { spaceId: requireSpace(cmd.ctx), query, limit },
  });
  cmd.out.data({ query, items: data?.items ?? [] }, renderSearch);
  return EXIT_OK;
}

/**
 * The module's registration. `commands/registry.ts` is the one composition
 * point: this file exports the array and the registry adds one import and one
 * spread.
 */
export const MEMORY_COMMANDS: CommandModule[] = [
  { path: ['memory', 'record'], run: memoryRecord },
  { path: ['memory', 'list'], run: memoryList },
  { path: ['memory', 'show'], run: memoryShow },
  { path: ['memory', 'supersede'], run: memorySupersede },
  { path: ['memory', 'search'], run: memorySearch },
];
