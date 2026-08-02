/**
 * `tm8 entity …` — the universal entity surface (§4.3, §4.4).
 *
 * SEVENTEEN commands over seventeen catalog rows: the twelve `entities.*` rows
 * plus `attentionRequests.create`,
 * the two W0 additive reads (`entities.feed`, `entities.context`),
 * `entities.commands.pull` — which is a kind-command wearing an `entity`
 * command path — and `collections.query`, which is a `collections` row whose
 * public invocation is `tm8 entity query`. The command path, not the operation
 * family, decides which module owns a row.
 *
 * WHAT THIS MODULE DELIBERATELY DOES NOT OWN. `entities.connections` answers
 * `Page<EdgeView>` and is edge-shaped, so it belongs to the edge module.
 * `commands/registry.ts` throws at IMPORT on a duplicate path, so registering
 * it in two places would not fail one test — it would take down every suite in
 * this package at once. The absence is asserted in `test/entity.test.ts`.
 *
 * ── THE OPTION ALLOWLIST, AND WHY IT IS NOT FUSSINESS ──────────────────────
 *
 * Every command here declares the exact set of options its frozen syntax
 * names, and an option outside that set is a usage error (exit 2) rather than
 * a value read by nobody. The kernel's parser is generic: it collects
 * `--anything value` into the bag and hands it over, so a command that simply
 * ignores what it does not recognize turns `--assigne <id>` into an unfiltered
 * query and `--sort position` into a silently unsorted page. Both LOOK like
 * success. Refusing is the only outcome an agent can act on.
 *
 * The refusal quotes `commandDiscovery(path).syntax` — the frozen projection's
 * OWN string — so the message can never drift from the help surface that
 * renders the same field.
 *
 * ── A DISCLOSED AUTHORITY CONFLICT: FLAGS WITH NO WIRE DESTINATION ─────────
 *
 * Five flags in this slot's frozen CLI syntax have NO field in the frozen
 * contract to carry them. Verified against `packages/contract/src/`, not
 * against a design doc:
 *
 *   `entity context --depth --messages --children --edge-type`
 *       `EntityContextQuery` is `.strict()` over exactly
 *       {sections, totalBytes, sectionBytes}. The other four names appear ZERO
 *       times in it, and the Server validates the WHOLE query string against
 *       that schema — so binding them sends a request guaranteed to answer
 *       `400 invalid_input`.
 *   `entity hierarchy --depth`
 *       there is no hierarchy query type in the contract AT ALL — zero
 *       occurrences of any `HierarchyQuery` — so the flag has nowhere to land
 *       and is silently ignored end to end.
 *
 * A FLAG WITH NO WIRE DESTINATION IS A PROMISE THE CLI CANNOT KEEP. An agent
 * that sees `--depth` reasonably concludes the read is depth-bounded, plans a
 * context budget around it, and is wrong — and nothing anywhere goes red. The
 * two failure shapes differ (a hard 400 versus a silent no-op) but the defect
 * is one defect, so both get one treatment: the command ships its
 * CONTRACT-LEGAL surface and refuses the unbacked flags locally, NAMING the
 * conflict rather than calling them unknown options — the frozen syntax does
 * name them, so "unknown option" would itself be misleading.
 *
 * Inventing `--sections` in their place would be inventing a flag outside the
 * authorities, so that is not done either. The conflict is REPORTED for
 * amendment; `src/discovery/operations.ts` has one owner and is not edited
 * here.
 */
import { readJsonSource } from '../args.js';
import { requireSpace } from '../context.js';
import { ApiError } from '../errors.js';
import { CliError, EXIT_OK, EXIT_USAGE, type ExitCode } from '../exit.js';
import { refuseMutationId, resolveMutationId } from '../mutation.js';
import { clientFor, observedInvoke } from '../discovery/observe.js';
import { commandDiscovery } from '../discovery/operations.js';
import type { CommandContext, CommandModule } from '../run.js';

// ── shared local validation, used by every module in this slot ─────────────

/**
 * Reject an option this command's frozen syntax does not name.
 *
 * The six global options never reach here: `parseInvocation` takes them out of
 * the bag before a command sees it, so what is left is command grammar only.
 */
export function assertKnownOptions(cmd: CommandContext, allowed: readonly string[]): void {
  const known = new Set(allowed);
  for (const name of cmd.options.names()) {
    if (known.has(name)) continue;
    const syntax = commandDiscovery(cmd.path)?.syntax;
    throw new CliError(`\`tm8 ${cmd.path.join(' ')}\` has no --${name}`, EXIT_USAGE, {
      hint: syntax
        ? `syntax: ${syntax}`
        : `run \`tm8 help ${cmd.path.join(' ')}\` for this command's contract`,
    });
  }
}

/**
 * Refuse a flag the frozen CLI syntax ADVERTISES but the frozen CONTRACT does
 * not define — see the module header for the five in this slot.
 *
 * Deliberately NOT the generic unknown-option message: the projected syntax
 * really does name these, so telling a caller the flag is unknown would be a
 * second wrong answer on top of the first. The refusal names the contract
 * shape that has no room for it, and says the gap is held for amendment, so
 * the caller can tell "you typoed" from "this grammar is ahead of its wire".
 */
export function refuseUnbackedOptions(
  cmd: CommandContext,
  names: readonly string[],
  contractNote: string,
): void {
  for (const name of names) {
    if (!cmd.options.has(name)) continue;
    throw new CliError(
      `\`tm8 ${cmd.path.join(' ')}\` cannot bind --${name}: ${contractNote}`,
      EXIT_USAGE,
      {
        hint:
          'the frozen CLI syntax names this flag but the frozen contract defines no field to carry it; ' +
          'the conflict is reported and held for amendment rather than sent as a request the wire cannot answer',
      },
    );
  }
}

/** A required positional, named the way the frozen syntax names it. */
export function requireArg(cmd: CommandContext, index: number, name: string): string {
  const value = cmd.args[index];
  if (value === undefined || value === '') {
    const syntax = commandDiscovery(cmd.path)?.syntax;
    throw new CliError(`\`tm8 ${cmd.path.join(' ')}\` requires ${name}`, EXIT_USAGE, {
      hint: syntax
        ? `syntax: ${syntax}`
        : `run \`tm8 help ${cmd.path.join(' ')}\` for this command's contract`,
    });
  }
  return value;
}

/** A positional constrained to a closed set — a typo must not reach the wire. */
export function requireEnumArg(
  cmd: CommandContext,
  index: number,
  name: string,
  allowed: readonly string[],
): string {
  const raw = requireArg(cmd, index, name);
  if (!allowed.includes(raw)) {
    throw new CliError(
      `${JSON.stringify(raw)} is not a valid ${name.replace(/[<>]/g, '')}`,
      EXIT_USAGE,
      { hint: `one of: ${allowed.join('|')}` },
    );
  }
  return raw;
}

/** An option constrained to a closed set. */
export function enumOption(
  cmd: CommandContext,
  name: string,
  allowed: readonly string[],
): string | undefined {
  const raw = cmd.options.value(name);
  if (raw === undefined) return undefined;
  if (!allowed.includes(raw)) {
    throw new CliError(`--${name} expects ${allowed.join('|')}, got ${JSON.stringify(raw)}`, EXIT_USAGE);
  }
  return raw;
}

/**
 * The `<value|none>` idiom (§4): the literal `none` is an explicit NULL, and
 * `undefined` is "do not send this field at all". Collapsing the two would
 * make "clear the parent" indistinguishable from "leave the parent alone".
 */
export function nullableOption(cmd: CommandContext, name: string): string | null | undefined {
  const raw = cmd.options.value(name);
  if (raw === undefined) return undefined;
  return raw === 'none' ? null : raw;
}

/** A finite number option — positions are not necessarily integers. */
export function numberOption(cmd: CommandContext, name: string): number | undefined {
  const raw = cmd.options.value(name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new CliError(`--${name} expects a number, got ${JSON.stringify(raw)}`, EXIT_USAGE);
  }
  return value;
}

/** A finite-number positional (`<amount>`). */
export function numberArg(cmd: CommandContext, index: number, name: string): number {
  const raw = requireArg(cmd, index, name);
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new CliError(`${name} expects a number, got ${JSON.stringify(raw)}`, EXIT_USAGE);
  }
  return value;
}

/** `--limit <count>` / `--cursor <cursor>`, as QUERY parameters. A read has no body. */
export function pageQuery(cmd: CommandContext): Record<string, string | undefined> {
  const limit = cmd.options.integer('limit');
  const cursor = cmd.options.value('cursor');
  return {
    ...(limit === undefined ? {} : { limit: String(limit) }),
    ...(cursor === undefined ? {} : { cursor }),
  };
}

/** The acting actor, when one is in context. Reads have no actor channel. */
export function withActor(cmd: CommandContext, body: Record<string, unknown>): Record<string, unknown> {
  if (cmd.ctx.actor) body.actorId = cmd.ctx.actor.value;
  return body;
}

// ── human rendering ────────────────────────────────────────────────────────

interface SummaryLike {
  id?: unknown;
  kind?: unknown;
  title?: unknown;
  version?: unknown;
}

/**
 * One entity as a line. The ID is ALWAYS first and never omitted: it is the
 * argument every follow-up command in this grammar takes, and a human view
 * that drops it forces a second call in `--format json` to recover it.
 */
export function summaryLine(row: SummaryLike | undefined): string {
  if (row === undefined || row === null) return '';
  const parts: string[] = [String(row.id ?? '')];
  if (row.kind !== undefined) parts.push(String(row.kind));
  if (row.title !== undefined) parts.push(String(row.title));
  if (row.version !== undefined) parts.push(`v${String(row.version)}`);
  return parts.filter((p) => p !== '').join('  ');
}

/** `Page<T>` — items plus the cursor a follow-up `--cursor` needs. */
export function renderPage(dto: unknown): string {
  const page = dto as { items?: unknown; nextCursor?: unknown } | undefined;
  const items = Array.isArray(page?.items) ? (page.items as SummaryLike[]) : [];
  const lines = items.map((i) => summaryLine(i));
  if (typeof page?.nextCursor === 'string' && page.nextCursor.length > 0) {
    lines.push(`next-cursor: ${page.nextCursor}`);
  }
  return lines.length > 0 ? lines.join('\n') : 'no results';
}

/**
 * `CommandResult`. The undo TOKEN is rendered; the server's `label` is not.
 * The token is the id `tm8 undo apply` takes, and the label is server prose
 * whose vocabulary this CLI does not control — `--format json` carries the
 * whole DTO for anything that wants it.
 */
export function renderCommandResult(dto: unknown): string {
  const r = dto as
    | { entity?: SummaryLike; edge?: { id?: unknown }; patches?: unknown; undo?: { token?: unknown } }
    | undefined;
  const lines: string[] = [];
  if (r?.entity) lines.push(summaryLine(r.entity));
  else if (Array.isArray(r?.patches)) {
    for (const p of r.patches as SummaryLike[]) lines.push(summaryLine(p));
  }
  if (r?.edge && r.edge.id !== undefined) lines.push(`edge  ${String(r.edge.id)}`);
  if (r?.undo && typeof r.undo.token === 'string') lines.push(`undo-token: ${r.undo.token}`);
  const rendered = lines.filter((l) => l !== '');
  return rendered.length > 0 ? rendered.join('\n') : 'ok';
}

function renderAttentionMutation(dto: unknown): string {
  const result = dto as {
    request?: { id?: unknown; status?: unknown; points?: unknown; reason?: unknown } | null;
    entity?: SummaryLike;
    affectedCount?: unknown;
  };
  const lines: string[] = [];
  if (result.request?.id) {
    lines.push(
      `attention  ${String(result.request.id)}  ${String(result.request.status ?? '')}  `
      + `${String(result.request.points ?? '')}pt  ${String(result.request.reason ?? '')}`,
    );
  }
  if (result.entity) lines.push(summaryLine(result.entity));
  lines.push(`affected: ${String(result.affectedCount ?? 0)}`);
  return lines.join('\n');
}

function renderEntity(dto: unknown): string {
  const line = summaryLine(dto as SummaryLike);
  return line === '' ? JSON.stringify(dto) : line;
}

function renderHierarchy(dto: unknown): string {
  const h = dto as { parent?: SummaryLike | null; children?: unknown; path?: unknown } | undefined;
  const lines: string[] = [];
  for (const step of Array.isArray(h?.path) ? (h.path as SummaryLike[]) : []) {
    lines.push(`path      ${summaryLine(step)}`);
  }
  if (h?.parent) lines.push(`parent    ${summaryLine(h.parent)}`);
  const children = h?.children as { items?: unknown; nextCursor?: unknown } | undefined;
  for (const child of Array.isArray(children?.items) ? (children.items as SummaryLike[]) : []) {
    lines.push(`child     ${summaryLine(child)}`);
  }
  if (typeof children?.nextCursor === 'string' && children.nextCursor.length > 0) {
    lines.push(`next-cursor: ${children.nextCursor}`);
  }
  return lines.length > 0 ? lines.join('\n') : 'no hierarchy';
}

function renderCollection(dto: unknown): string {
  const result = dto as { page?: unknown } | undefined;
  return renderPage(result?.page ?? dto);
}

function renderFeed(dto: unknown): string {
  const page = dto as { items?: unknown; nextCursor?: unknown; resolvedScope?: unknown } | undefined;
  const items = Array.isArray(page?.items) ? (page.items as Array<Record<string, unknown>>) : [];
  const lines = items.map((item) => {
    const id = String(item.itemId ?? '');
    const at = String(item.createdAt ?? '');
    return `${id}  ${String(item.itemKind ?? '')}  ${at}`.trim();
  });
  if (typeof page?.nextCursor === 'string' && page.nextCursor.length > 0) {
    lines.push(`next-cursor: ${page.nextCursor}`);
  }
  if (typeof page?.resolvedScope === 'string') lines.unshift(`scope: ${page.resolvedScope}`);
  return lines.length > 0 ? lines.join('\n') : 'no feed items';
}

function renderContext(dto: unknown): string {
  const view = dto as
    | { root?: SummaryLike; parents?: unknown; children?: unknown; edges?: unknown; messages?: unknown; truncated?: unknown }
    | undefined;
  const count = (v: unknown): number => (Array.isArray(v) ? v.length : 0);
  const lines = [summaryLine(view?.root)];
  lines.push(
    `parents ${count(view?.parents)}  children ${count(view?.children)}  ` +
      `edges ${count(view?.edges)}  messages ${count(view?.messages)}` +
      (view?.truncated === true ? '  (truncated)' : ''),
  );
  return lines.filter((l) => l !== '').join('\n');
}

// ── reads ──────────────────────────────────────────────────────────────────

async function entityGet(cmd: CommandContext): Promise<ExitCode> {
  refuseMutationId('entity get', cmd.options.value('mutation-id'));
  assertKnownOptions(cmd, []);
  const id = requireArg(cmd, 0, '<entity-id>');
  const data = await observedInvoke<unknown>(clientFor(cmd.ctx), 'entities.get', { params: { id } });
  cmd.out.data(data, renderEntity);
  return EXIT_OK;
}

async function entityChildren(cmd: CommandContext): Promise<ExitCode> {
  refuseMutationId('entity children', cmd.options.value('mutation-id'));
  assertKnownOptions(cmd, ['limit', 'cursor']);
  const id = requireArg(cmd, 0, '<entity-id>');
  const data = await observedInvoke<unknown>(clientFor(cmd.ctx), 'entities.children', {
    params: { id },
    query: pageQuery(cmd),
  });
  cmd.out.data(data, renderPage);
  return EXIT_OK;
}

/**
 * `--depth <n>` is advertised by the frozen syntax and backed by NOTHING in
 * the contract — see the module header. Sending it would be a query parameter
 * with no schema to receive it, silently ignored, which is the worst of the
 * three options: the caller believes the read is bounded and it is not.
 */
async function entityHierarchy(cmd: CommandContext): Promise<ExitCode> {
  refuseMutationId('entity hierarchy', cmd.options.value('mutation-id'));
  refuseUnbackedOptions(cmd, ['depth'], 'the contract defines no hierarchy query type at all');
  assertKnownOptions(cmd, []);
  const id = requireArg(cmd, 0, '<entity-id>');
  const data = await observedInvoke<unknown>(clientFor(cmd.ctx), 'entities.hierarchy', {
    params: { id },
  });
  cmd.out.data(data, renderHierarchy);
  return EXIT_OK;
}

async function entityVersions(cmd: CommandContext): Promise<ExitCode> {
  refuseMutationId('entity versions', cmd.options.value('mutation-id'));
  assertKnownOptions(cmd, ['limit', 'cursor']);
  const id = requireArg(cmd, 0, '<entity-id>');
  const data = await observedInvoke<unknown>(clientFor(cmd.ctx), 'entities.versions', {
    params: { id },
    query: pageQuery(cmd),
  });
  cmd.out.data(data, renderPage);
  return EXIT_OK;
}

async function entityActivity(cmd: CommandContext): Promise<ExitCode> {
  refuseMutationId('entity activity', cmd.options.value('mutation-id'));
  assertKnownOptions(cmd, ['limit', 'cursor']);
  const id = requireArg(cmd, 0, '<entity-id>');
  const data = await observedInvoke<unknown>(clientFor(cmd.ctx), 'entities.activity', {
    params: { id },
    query: pageQuery(cmd),
  });
  cmd.out.data(data, renderPage);
  return EXIT_OK;
}

async function entityFeed(cmd: CommandContext): Promise<ExitCode> {
  refuseMutationId('entity feed', cmd.options.value('mutation-id'));
  assertKnownOptions(cmd, ['scope', 'order', 'around', 'limit', 'cursor']);
  const id = requireArg(cmd, 0, '<entity-id>');
  const scope = enumOption(cmd, 'scope', ['direct_v1', 'session_chat_v1']);
  const order = enumOption(cmd, 'order', ['newest', 'oldest']);
  const around = cmd.options.value('around');
  const data = await observedInvoke<unknown>(clientFor(cmd.ctx), 'entities.feed', {
    params: { id },
    query: {
      ...(scope === undefined ? {} : { scope }),
      ...(order === undefined ? {} : { order }),
      ...(around === undefined ? {} : { around }),
      ...pageQuery(cmd),
    },
  });
  cmd.out.data(data, renderFeed);
  return EXIT_OK;
}

/** See the module header: four projected flags the frozen query schema cannot accept. */
const CONTEXT_UNBACKED = ['depth', 'messages', 'children', 'edge-type'] as const;

async function entityContext(cmd: CommandContext): Promise<ExitCode> {
  refuseMutationId('entity context', cmd.options.value('mutation-id'));
  refuseUnbackedOptions(
    cmd,
    CONTEXT_UNBACKED,
    'EntityContextQuery is strict over {sections, totalBytes, sectionBytes} and has no such parameter',
  );
  assertKnownOptions(cmd, []);
  const id = requireArg(cmd, 0, '<entity-id>');
  const data = await observedInvoke<unknown>(clientFor(cmd.ctx), 'entities.context', { params: { id } });
  cmd.out.data(data, renderContext);
  return EXIT_OK;
}

// ── entity query (collections.query) ───────────────────────────────────────

/**
 * `CollectionQuery` is `.strict()`, so an empty `filters` object is a key the
 * caller never asked for and a shape the Server must then decide about. The
 * body carries exactly the fields the caller named, and nothing else.
 */
async function entityQuery(cmd: CommandContext): Promise<ExitCode> {
  refuseMutationId('entity query', cmd.options.value('mutation-id'));
  assertKnownOptions(cmd, ['kind', 'subtree', 'work-status', 'assignee', 'ready', 'limit', 'cursor']);

  const kinds = cmd.options.values('kind');
  const subtreeOf = cmd.options.value('subtree');
  const workStatus = cmd.options.values('work-status');
  const assigneeIds = cmd.options.values('assignee');
  const ready = cmd.options.bool('ready');
  const limit = cmd.options.integer('limit');
  const cursor = cmd.options.value('cursor');

  const filters: Record<string, unknown> = {};
  if (workStatus.length > 0) filters.workStatus = workStatus;
  if (assigneeIds.length > 0) filters.assigneeIds = assigneeIds;
  if (ready) filters.readyToPull = true;

  const body: Record<string, unknown> = { spaceId: requireSpace(cmd.ctx) };
  if (kinds.length > 0) body.kinds = kinds;
  if (subtreeOf !== undefined) body.subtreeOf = subtreeOf;
  if (Object.keys(filters).length > 0) body.filters = filters;
  if (limit !== undefined) body.limit = limit;
  if (cursor !== undefined) body.cursor = cursor;

  const data = await observedInvoke<unknown>(clientFor(cmd.ctx), 'collections.query', { body });
  cmd.out.data(data, renderCollection);
  return EXIT_OK;
}

// ── mutations ──────────────────────────────────────────────────────────────

/**
 * `--attach-to` and `--relate-to` are shorthands for `--connect
 * attached_to=<id>` and `--connect relates_to=<id>` (§4.3), so all three fold
 * into ONE `connections` array. Duplicate `(type,target)` tuples collapse
 * idempotently — the grammar says so, and sending a duplicate would ask the
 * Server to decide something the caller already decided.
 */
function initialConnections(cmd: CommandContext): Array<{ type: string; targetId: string }> {
  const tuples: Array<{ type: string; targetId: string }> = [];
  for (const target of cmd.options.values('attach-to')) tuples.push({ type: 'attached_to', targetId: target });
  for (const target of cmd.options.values('relate-to')) tuples.push({ type: 'relates_to', targetId: target });
  for (const raw of cmd.options.values('connect')) {
    const eq = raw.indexOf('=');
    if (eq <= 0 || eq === raw.length - 1) {
      throw new CliError(
        `--connect expects <edge-type>=<target-entity-id>, got ${JSON.stringify(raw)}`,
        EXIT_USAGE,
      );
    }
    tuples.push({ type: raw.slice(0, eq), targetId: raw.slice(eq + 1) });
  }

  // A session's own output is the thing its connection surface most obviously
  // ought to show, and it did not: measured on prod before migration 066, 59
  // docs existed, exactly ONE was linked to any session, and 45 had no edges at
  // all. Sessions produce docs all day and the graph could not answer "what did
  // this session make?" for any kind. So when this process IS a work session,
  // everything it creates claims that session as its birthplace.
  //
  // THIS IS A CLAIM, NOT A FACT. Nothing verifies that the caller really is the
  // session it names, which is why `created_in` stamps `props.origin =
  // 'client_claim'` instead of the usual 'user' (066 §1) — a later reader must
  // not mistake an assertion for something the Server recorded. The verified
  // form is `authored_from`, and it needs the Server to DERIVE the session from
  // a session-scoped token rather than be told; that is why it cannot be written
  // from here. Until that lands this is the honest approximation.
  //
  // Skipped when the caller named `created_in` themselves: one entity has one
  // birth session (`edges_created_in_source_idx`), so a second claim at a
  // different target is refused by the database rather than silently preferred.
  // An explicit flag beats an inferred one, and `--no-session-link` opts out
  // entirely for an entity that should not be attributed to this session.
  //
  // NOTE: the automatic `created_in` link is deliberately NOT added here — see
  // `linkCreatedInSession` below for why it cannot ride inside the create
  // request. An EXPLICIT `--connect created_in=<id>` still travels here, which is
  // why that function stands down when the caller named one.
  const seen = new Set<string>();
  return tuples.filter((t) => {
    const key = `${t.type} ${t.targetId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Claim this session as the birthplace of a just-created entity — BEST EFFORT,
 * as a SEPARATE request, and never fatal.
 *
 * WHY IT CANNOT RIDE INSIDE THE CREATE. It was written that way first, and it is
 * wrong: a connection in the create body is validated with the create, so an
 * unresolvable session does not degrade to a missing edge, it fails the WHOLE
 * CREATE. That broke 22 CLI integration tests with `not_found: entity <session>
 * not found` — the suites boot their own Server and database, `cli()` passes
 * `{...process.env}`, so `TM8_SESSION_ID` and `TM8_SPACE_ID` leak in from
 * whatever agent is running the suite while the target database has never heard
 * of that session. Guarding on `ctx.space.source === 'session'` did NOT fix it,
 * because the leaked value arrives as env and therefore reads as 'session' too.
 *
 * The same failure has a worse shape in production: `tm8 --server staging entity
 * create` run from a prod session is the Staging Steward's entire job, and its
 * session exists only on prod.
 *
 * So the rule the 065/066 database triggers already follow applies to the client
 * too: A DERIVED EDGE MUST NEVER TAKE DOWN THE OPERATION THAT CAUSED IT. The
 * entity is created first and committed; the claim is attempted after and its
 * failure is reported on stderr, not raised. A create that succeeded must not
 * report failure because a nicety did not land.
 *
 * The failure is WARNED rather than swallowed on purpose — silent absence is the
 * failure mode this whole change exists to remove, so trading a broken create
 * for an invisible one would be no progress at all.
 */
async function linkCreatedInSession(
  cmd: CommandContext,
  created: unknown,
  explicitConnections: ReadonlyArray<{ type: string; targetId: string }>,
): Promise<void> {
  const sessionId = cmd.ctx.sessionId;
  if (sessionId === undefined) return;
  if (cmd.options.bool('no-session-link')) return;
  // One entity has one birth session (`edges_created_in_source_idx`), so an
  // explicit claim wins outright rather than racing the inferred one.
  if (explicitConnections.some((c) => c.type === 'created_in')) return;

  const entityId = (created as { entity?: { id?: unknown } } | null)?.entity?.id;
  if (typeof entityId !== 'string' || entityId === '') return;
  if (entityId === sessionId) return; // nothing is born in itself

  // A session id that is not a UUID can never be the benign cross-database
  // answer the catch below swallows — it is a misconfigured TM8_SESSION_ID.
  // The server reports it with the same not_found the benign case returns
  // (22P02 maps to 404), so without this check the misconfiguration is
  // indistinguishable from the harness leak and stays invisible forever.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId)) {
    cmd.out.warn(
      `note: TM8_SESSION_ID ${JSON.stringify(sessionId)} is not a UUID, so the ` +
        'created_in session link was not attempted. The entity was created.',
    );
    return;
  }

  try {
    await clientFor(cmd.ctx).invoke('edges.create', {
      body: {
        srcId: entityId,
        dstId: sessionId,
        type: 'created_in',
        clientMutationId: resolveMutationId(undefined),
      },
    });
  } catch (err) {
    // `not_found` on the session is not a failure — it is the answer to a
    // question we were right to ask. It means this invocation is not operating
    // in its own session's world: the Space belongs to another database (the
    // integration harness leaks TM8_SESSION_ID into suites that boot their own
    // Server), or `--server` sent us to a node where the session does not exist.
    // In that case NO edge is the correct outcome and there is nothing to report,
    // which is also why a suite asserting `stderr: ''` on a clean create stays
    // green.
    //
    // Anything else — forbidden, invalid_input, a transport failure, a 500 — is a
    // claim we SHOULD have been able to record and could not, so it is surfaced.
    // Silent absence is the exact failure mode this change exists to remove.
    if (err instanceof ApiError && err.code === 'not_found') return;
    cmd.out.warn(
      `note: could not record this entity as created in session ${sessionId} ` +
        `(${err instanceof Error ? err.message : String(err)}). The entity was created.`,
    );
  }
}

/** `--content <json-source>` is `Record<string, unknown>` — an array is a misread flag. */
async function readContent(raw: string): Promise<Record<string, unknown>> {
  const parsed = await readJsonSource(raw);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new CliError('--content expects a JSON OBJECT of kind-specific content', EXIT_USAGE, {
      hint: '--content \'{"description":"…"}\' or --content @content.json',
    });
  }
  return parsed as Record<string, unknown>;
}

async function entityCreate(cmd: CommandContext): Promise<ExitCode> {
  assertKnownOptions(cmd, [
    'parent', 'position', 'content', 'attach-to', 'relate-to', 'connect', 'mutation-id',
    'no-session-link',
  ]);
  const kind = requireArg(cmd, 0, '<kind>');
  const title = requireArg(cmd, 1, '<title>');

  const body: Record<string, unknown> = {
    clientMutationId: resolveMutationId(cmd.options.value('mutation-id')),
    spaceId: requireSpace(cmd.ctx),
    kind,
    title,
  };
  const parentId = nullableOption(cmd, 'parent');
  if (parentId !== undefined) body.parentId = parentId;
  const position = numberOption(cmd, 'position');
  if (position !== undefined) body.position = position;
  const content = cmd.options.value('content');
  if (content !== undefined) body.content = await readContent(content);
  const connections = initialConnections(cmd);
  if (connections.length > 0) body.connections = connections;

  const data = await observedInvoke<unknown>(clientFor(cmd.ctx), 'entities.create', {
    body: withActor(cmd, body),
  });
  // After the create has landed, never before it — see linkCreatedInSession.
  await linkCreatedInSession(cmd, data, connections);
  cmd.out.data(data, renderCommandResult);
  return EXIT_OK;
}

async function entityUpdate(cmd: CommandContext): Promise<ExitCode> {
  assertKnownOptions(cmd, ['expect-version', 'title', 'content', 'mutation-id']);
  const id = requireArg(cmd, 0, '<entity-id>');
  const expectedVersion = cmd.options.integer('expect-version');
  if (expectedVersion === undefined) {
    throw new CliError('`tm8 entity update` requires --expect-version <n>', EXIT_USAGE, {
      hint: 'read the current version with `tm8 entity get <entity-id>`',
    });
  }

  const body: Record<string, unknown> = {
    clientMutationId: resolveMutationId(cmd.options.value('mutation-id')),
    expectedVersion,
  };
  const title = cmd.options.value('title');
  if (title !== undefined) body.title = title;
  const content = cmd.options.value('content');
  if (content !== undefined) body.content = await readContent(content);

  if (title === undefined && content === undefined) {
    throw new CliError('`tm8 entity update` needs something to change', EXIT_USAGE, {
      hint: 'pass --title or --content',
    });
  }

  const data = await observedInvoke<unknown>(clientFor(cmd.ctx), 'entities.patch', {
    params: { id },
    body: withActor(cmd, body),
  });
  cmd.out.data(data, renderCommandResult);
  return EXIT_OK;
}

async function entityAttention(cmd: CommandContext): Promise<ExitCode> {
  assertKnownOptions(cmd, ['reason', 'points', 'mutation-id']);
  const id = requireArg(cmd, 0, '<entity-id>');
  const reason = cmd.options.value('reason');
  const points = cmd.options.integer('points');
  if (!reason?.trim()) throw new CliError('`tm8 entity attention` requires --reason <text>', EXIT_USAGE);
  if (points === undefined || points < 1 || points > 100) {
    throw new CliError('`tm8 entity attention` requires --points <1-100>', EXIT_USAGE);
  }
  const data = await observedInvoke<unknown>(clientFor(cmd.ctx), 'attentionRequests.create', {
    params: { entityId: id },
    body: withActor(cmd, {
      clientMutationId: resolveMutationId(cmd.options.value('mutation-id')),
      reason: reason.trim(),
      points,
    }),
  });
  cmd.out.data(data, renderAttentionMutation);
  return EXIT_OK;
}

async function entityMove(cmd: CommandContext): Promise<ExitCode> {
  assertKnownOptions(cmd, ['parent', 'position', 'expect-version', 'mutation-id']);
  const id = requireArg(cmd, 0, '<entity-id>');
  const parentId = nullableOption(cmd, 'parent');
  if (parentId === undefined) {
    throw new CliError('`tm8 entity move` requires --parent <entity-id|none>', EXIT_USAGE);
  }
  const position = numberOption(cmd, 'position');
  if (position === undefined) {
    throw new CliError('`tm8 entity move` requires --position <n>', EXIT_USAGE);
  }
  const expectedVersion = cmd.options.integer('expect-version');
  if (expectedVersion === undefined) {
    throw new CliError('`tm8 entity move` requires --expect-version <n>', EXIT_USAGE);
  }

  const data = await observedInvoke<unknown>(clientFor(cmd.ctx), 'entities.move', {
    params: { id },
    body: withActor(cmd, {
      clientMutationId: resolveMutationId(cmd.options.value('mutation-id')),
      parentId,
      position,
      expectedVersion,
    }),
  });
  cmd.out.data(data, renderCommandResult);
  return EXIT_OK;
}

async function entityDelete(cmd: CommandContext): Promise<ExitCode> {
  assertKnownOptions(cmd, ['yes', 'mutation-id']);
  const id = requireArg(cmd, 0, '<entity-id>');
  if (!cmd.options.bool('yes')) {
    throw new CliError('`tm8 entity delete` is destructive and requires --yes (§7.5)', EXIT_USAGE, {
      hint: '`tm8 entity restore <entity-id>` is its inverse, but confirm the delete first',
    });
  }
  const data = await observedInvoke<unknown>(clientFor(cmd.ctx), 'entities.delete', {
    params: { id },
    body: withActor(cmd, { clientMutationId: resolveMutationId(cmd.options.value('mutation-id')) }),
  });
  cmd.out.data(data, renderCommandResult);
  return EXIT_OK;
}

async function entityRestore(cmd: CommandContext): Promise<ExitCode> {
  assertKnownOptions(cmd, ['mutation-id']);
  const id = requireArg(cmd, 0, '<entity-id>');
  const data = await observedInvoke<unknown>(clientFor(cmd.ctx), 'entities.restore', {
    params: { id },
    body: withActor(cmd, { clientMutationId: resolveMutationId(cmd.options.value('mutation-id')) }),
  });
  cmd.out.data(data, renderCommandResult);
  return EXIT_OK;
}

async function entityReact(cmd: CommandContext): Promise<ExitCode> {
  assertKnownOptions(cmd, ['off', 'mutation-id']);
  const id = requireArg(cmd, 0, '<entity-id>');
  const reaction = requireEnumArg(cmd, 1, '<reaction>', ['like', 'dislike', 'star']);
  const data = await observedInvoke<unknown>(clientFor(cmd.ctx), 'entities.react', {
    params: { id },
    body: withActor(cmd, {
      clientMutationId: resolveMutationId(cmd.options.value('mutation-id')),
      reaction,
      enabled: !cmd.options.bool('off'),
    }),
  });
  cmd.out.data(data, renderCommandResult);
  return EXIT_OK;
}

async function entityPointGrant(cmd: CommandContext): Promise<ExitCode> {
  assertKnownOptions(cmd, ['reason', 'reference', 'mutation-id']);
  const id = requireArg(cmd, 0, '<entity-id>');
  const amount = numberArg(cmd, 1, '<amount>');
  const reason = enumOption(cmd, 'reason', ['grant', 'award', 'seed']);
  if (reason === undefined) {
    throw new CliError('`tm8 entity point grant` requires --reason grant|award|seed', EXIT_USAGE);
  }
  const body: Record<string, unknown> = {
    clientMutationId: resolveMutationId(cmd.options.value('mutation-id')),
    amount,
    reason,
  };
  const referenceId = cmd.options.value('reference');
  if (referenceId !== undefined) body.referenceId = referenceId;

  const data = await observedInvoke<unknown>(clientFor(cmd.ctx), 'entities.points.add', {
    params: { id },
    body: withActor(cmd, body),
  });
  cmd.out.data(data, renderCommandResult);
  return EXIT_OK;
}

async function entityPull(cmd: CommandContext): Promise<ExitCode> {
  assertKnownOptions(cmd, ['pinned-version', 'local-id', 'mutation-id']);
  const id = requireArg(cmd, 0, '<entity-id>');
  const pinnedVersion = cmd.options.integer('pinned-version');
  if (pinnedVersion === undefined) {
    throw new CliError('`tm8 entity pull` requires --pinned-version <n>', EXIT_USAGE, {
      hint: 'read the current version with `tm8 entity get <entity-id>`',
    });
  }
  const body: Record<string, unknown> = {
    clientMutationId: resolveMutationId(cmd.options.value('mutation-id')),
    pinnedVersion,
  };
  const localId = nullableOption(cmd, 'local-id');
  if (localId !== undefined) body.localId = localId;

  const data = await observedInvoke<unknown>(clientFor(cmd.ctx), 'entities.commands.pull', {
    params: { id },
    body: withActor(cmd, body),
  });
  cmd.out.data(data, renderCommandResult);
  return EXIT_OK;
}

/**
 * The module's registration. `commands/registry.ts` is coordinator-owned: this
 * slot exports the array and the coordinator adds one import and one spread.
 */
export const ENTITY_COMMANDS: CommandModule[] = [
  { path: ['entity', 'get'], run: entityGet },
  { path: ['entity', 'create'], run: entityCreate },
  { path: ['entity', 'update'], run: entityUpdate },
  { path: ['entity', 'attention'], run: entityAttention },
  { path: ['entity', 'move'], run: entityMove },
  { path: ['entity', 'delete'], run: entityDelete },
  { path: ['entity', 'restore'], run: entityRestore },
  { path: ['entity', 'children'], run: entityChildren },
  { path: ['entity', 'hierarchy'], run: entityHierarchy },
  { path: ['entity', 'versions'], run: entityVersions },
  { path: ['entity', 'activity'], run: entityActivity },
  { path: ['entity', 'react'], run: entityReact },
  { path: ['entity', 'point', 'grant'], run: entityPointGrant },
  { path: ['entity', 'feed'], run: entityFeed },
  { path: ['entity', 'context'], run: entityContext },
  { path: ['entity', 'pull'], run: entityPull },
  { path: ['entity', 'query'], run: entityQuery },
];
