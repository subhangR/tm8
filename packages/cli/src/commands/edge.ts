/**
 * `tm8 edge list|create|update|delete`, `tm8 edge type list`, and
 * `tm8 entity connections` — the relationship seam (grammar §4.6, §4.4).
 *
 * WHY `entity connections` LIVES HERE AND NOT IN THE ENTITY MODULE. Its DTO is
 * `Page<EdgeView>`: it is an edge read that happens to be addressed by one
 * endpoint. A noun is not an ownership unit in this package — a MODULE is — and
 * splitting the two edge pagers across two files would put the same rendering,
 * the same closed direction vocabulary, and the same cursor discipline in two
 * places with two owners. `registry.ts` throws at IMPORT on a duplicate path,
 * so this claim is exclusive by construction rather than by convention.
 *
 * THREE DECISIONS THAT ARE NOT OBVIOUS FROM THE FLAG LIST:
 *
 *  - `--target` IS NOT THE WIRE NAME. `edges.list` filters on `destination`.
 *    The flag keeps the caller's vocabulary and the binding keeps the Server's;
 *    the mapping lives in one place so it cannot drift into a silent no-op
 *    filter that returns *every* edge and looks like a correct answer.
 *  - `props.origin` IS NOT REFUSED LOCALLY. It is Server-owned, and the Server
 *    answers `forbidden` for it. Pre-empting that here would be this CLI
 *    inventing an authorization decision the Server owns (see `context.ts`) and
 *    would report exit 2 where the node actually returns exit 4. The CLI sends
 *    what the caller wrote and renders the refusal faithfully.
 *  - THE AMENDMENT-DEPENDENT CONNECTION FILTERS FAIL BY NAME. `--sort`,
 *    `--order`, `--peer-kind`, `--created-by`, `--created-after` and
 *    `--created-before` appear in the grammar redesign §4.4 under a PROPOSED
 *    banner and are bound by NEITHER the frozen discovery projection nor this
 *    module. Accepting-and-ignoring one would answer with an order the caller
 *    did not ask for, or without a filter they believe applied — indistinguish-
 *    able from a correct answer. They are refused, named, before the network.
 *
 * The two `--direction` vocabularies are DIFFERENT and deliberately so:
 * `edge list` is `incoming|outgoing` (the Server rejects anything else),
 * `entity connections` is `incoming|outgoing|both`. One shared constant would
 * have quietly widened the first.
 */
import { readJsonSource } from '../args.js';
import { CliError, EXIT_OK, EXIT_USAGE, type ExitCode } from '../exit.js';
import { refuseMutationId, resolveMutationId } from '../mutation.js';
import { clientFor, observedInvoke } from '../discovery/observe.js';
import type { CommandContext, CommandModule } from '../run.js';

/** `edges.list` — the Server refuses anything else on this row. */
const LIST_DIRECTIONS = ['incoming', 'outgoing'] as const;
/** `entities.connections` — a strictly wider set, and only on this row. */
export const CONNECTION_DIRECTIONS = ['incoming', 'outgoing', 'both'] as const;

/**
 * Flags the grammar redesign §4.4 lists for `entity connections` under its
 * PROPOSED-extension banner, which the frozen projection does not bind. Each
 * maps to a query parameter this node happens to implement already — which is
 * exactly why accepting them silently would be so convincing and so wrong.
 */
const AMENDMENT_DEPENDENT_CONNECTION_FLAGS = [
  'sort', 'order', 'peer-kind', 'created-by', 'created-after', 'created-before',
] as const;

/**
 * A required positional. `shape` names the FULL positional form when there is
 * more than one: a caller who dropped the middle of three arguments is told
 * which one is missing AND what the whole shape is, because "requires
 * <target-entity-id>" alone does not say where in the line it belongs.
 */
function requireArg(
  raw: string | undefined,
  command: string,
  placeholder: string,
  shape?: string,
): string {
  if (raw === undefined || raw.length === 0) {
    throw new CliError(
      shape === undefined
        ? `tm8 ${command} requires ${placeholder}`
        : `tm8 ${command} ${shape} — missing ${placeholder}`,
      EXIT_USAGE,
    );
  }
  return raw;
}

const EDGE_CREATE_SHAPE = '<source-entity-id> <edge-type> <target-entity-id>';

/** A closed positional/flag vocabulary, refused locally with the set named. */
function requireOneOf(
  raw: string | undefined,
  allowed: readonly string[],
  flag: string,
): string | undefined {
  if (raw === undefined) return undefined;
  if (!allowed.includes(raw)) {
    throw new CliError(
      `${flag} expects ${allowed.join('|')}, got ${JSON.stringify(raw)}`,
      EXIT_USAGE,
    );
  }
  return raw;
}

/**
 * `--limit <count>`. The dimension is named in the diagnostic because a bare
 * `<n>` at any surface — help, completion, or an error — is a gate item (O3).
 */
function limitOf(cmd: CommandContext): string | undefined {
  const limit = cmd.options.integer('limit');
  if (limit === undefined) return undefined;
  if (limit <= 0) {
    throw new CliError(`--limit <count> expects a positive count, got ${limit}`, EXIT_USAGE);
  }
  return String(limit);
}

/**
 * Refuse a flag this row does not bind, rather than dropping it. Descriptive,
 * never imperative: in a PTY this line lands in the same context an agent
 * reads, so it states what is true and asks the reader to do nothing.
 */
function refuseUnbound(cmd: CommandContext, command: string, flags: readonly string[]): void {
  for (const flag of flags) {
    if (!cmd.options.has(flag)) continue;
    throw new CliError(
      `--${flag} is not bound by \`tm8 ${command}\`: it is amendment-dependent and the frozen grammar does not carry it`,
      EXIT_USAGE,
      { hint: `read the bound flags with \`tm8 help ${command}\`` },
    );
  }
}

/**
 * `--props <json-source>`. `CreateEdgeInput.props` and `PatchEdgeInput.props`
 * are both `Record<string, unknown>`, so an array or a scalar is a caller who
 * has misread the flag — and finding that out locally beats a 400 naming a
 * field they did not know existed.
 */
async function readProps(raw: string, flagOwner: string): Promise<Record<string, unknown>> {
  const parsed = await readJsonSource(raw);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new CliError(
      `${flagOwner} --props expects a JSON object of edge properties`,
      EXIT_USAGE,
      { hint: '--props \'{"hard":false}\'' },
    );
  }
  return parsed as Record<string, unknown>;
}

/** The command envelope every mutation on this module carries. */
function envelope(cmd: CommandContext): Record<string, unknown> {
  const out: Record<string, unknown> = {
    clientMutationId: resolveMutationId(cmd.options.value('mutation-id')),
  };
  if (cmd.ctx.actor) out.actorId = cmd.ctx.actor.value;
  return out;
}

// ── reads ───────────────────────────────────────────────────────────────────

async function edgeList(cmd: CommandContext): Promise<ExitCode> {
  refuseMutationId('edge list', cmd.options.value('mutation-id'));
  const query: Record<string, string | undefined> = {
    source: cmd.options.value('source'),
    // The flag is `--target`; the wire filter is `destination`.
    destination: cmd.options.value('target'),
    type: cmd.options.value('type'),
    direction: requireOneOf(cmd.options.value('direction'), LIST_DIRECTIONS, '--direction'),
    limit: limitOf(cmd),
    cursor: cmd.options.value('cursor'),
  };
  const data = await observedInvoke<unknown>(clientFor(cmd.ctx), 'edges.list', { query });
  cmd.out.data(data, renderEdgePage);
  return EXIT_OK;
}

async function edgeTypeList(cmd: CommandContext): Promise<ExitCode> {
  refuseMutationId('edge type list', cmd.options.value('mutation-id'));
  const data = await observedInvoke<unknown>(clientFor(cmd.ctx), 'edgeTypes.list', {});
  cmd.out.data(data, renderEdgeTypes);
  return EXIT_OK;
}

async function entityConnections(cmd: CommandContext): Promise<ExitCode> {
  refuseMutationId('entity connections', cmd.options.value('mutation-id'));
  refuseUnbound(cmd, 'entity connections', AMENDMENT_DEPENDENT_CONNECTION_FLAGS);
  const id = requireArg(cmd.args[0], 'entity connections', '<entity-id>');
  const query: Record<string, string | readonly string[] | undefined> = {
    // Repeated keys, never comma-joined: the Server reads `getAll('type')`.
    type: cmd.options.values('type'),
    peerId: cmd.options.values('peer'),
    direction: requireOneOf(cmd.options.value('direction'), CONNECTION_DIRECTIONS, '--direction'),
    limit: limitOf(cmd),
    cursor: cmd.options.value('cursor'),
  };
  const data = await observedInvoke<unknown>(clientFor(cmd.ctx), 'entities.connections', {
    params: { id },
    query,
  });
  cmd.out.data(data, renderEdgePage);
  return EXIT_OK;
}

// ── mutations ───────────────────────────────────────────────────────────────

async function edgeCreate(cmd: CommandContext): Promise<ExitCode> {
  const srcId = requireArg(cmd.args[0], 'edge create', '<source-entity-id>', EDGE_CREATE_SHAPE);
  const type = requireArg(cmd.args[1], 'edge create', '<edge-type>', EDGE_CREATE_SHAPE);
  const dstId = requireArg(cmd.args[2], 'edge create', '<target-entity-id>', EDGE_CREATE_SHAPE);
  const body: Record<string, unknown> = { srcId, dstId, type, ...envelope(cmd) };
  const props = cmd.options.value('props');
  // Omitted rather than defaulted to `{}`: `CreateEdgeInput` is strict and an
  // absent key and an empty object are not the same request.
  if (props !== undefined) body.props = await readProps(props, 'tm8 edge create');

  const data = await observedInvoke<unknown>(clientFor(cmd.ctx), 'edges.create', { body });
  cmd.out.data(data, renderCommandResult);
  return EXIT_OK;
}

async function edgeUpdate(cmd: CommandContext): Promise<ExitCode> {
  const edgeId = requireArg(cmd.args[0], 'edge update', '<edge-id>');
  const props = cmd.options.value('props');
  if (props === undefined) {
    throw new CliError('tm8 edge update requires --props <json-source>', EXIT_USAGE, {
      hint: 'properties are the only thing this row changes; endpoints and type are immutable',
    });
  }
  const body: Record<string, unknown> = {
    props: await readProps(props, 'tm8 edge update'),
    ...envelope(cmd),
  };
  const data = await observedInvoke<unknown>(clientFor(cmd.ctx), 'edges.patch', {
    params: { edgeId },
    body,
  });
  cmd.out.data(data, renderCommandResult);
  return EXIT_OK;
}

async function edgeDelete(cmd: CommandContext): Promise<ExitCode> {
  const edgeId = requireArg(cmd.args[0], 'edge delete', '<edge-id>');
  if (!cmd.options.bool('yes')) {
    throw new CliError('tm8 edge delete is destructive and requires --yes', EXIT_USAGE, {
      hint: `\`tm8 edge delete ${edgeId} --yes\``,
    });
  }
  const data = await observedInvoke<unknown>(clientFor(cmd.ctx), 'edges.delete', {
    params: { edgeId },
    body: envelope(cmd),
  });
  cmd.out.data(data, renderCommandResult);
  return EXIT_OK;
}

// ── human renderings — a function of the SAME DTO `--format json` emits ──────

interface EndpointLike {
  id?: unknown;
  title?: unknown;
}

interface EdgeLike {
  id?: unknown;
  type?: unknown;
  source?: EndpointLike;
  target?: EndpointLike;
  resolved?: unknown;
  hard?: unknown;
}

/** `src --type--> dst`, the notation the design docs already use for edges. */
function edgeLine(edge: EdgeLike): string {
  const source = String(edge.source?.id ?? '?');
  const target = String(edge.target?.id ?? '?');
  const flags = [
    edge.hard === false ? 'soft' : undefined,
    edge.resolved === true ? 'resolved' : edge.resolved === false ? 'unresolved' : undefined,
  ].filter(Boolean);
  const suffix = flags.length > 0 ? `  [${flags.join(' ')}]` : '';
  return `${String(edge.id ?? '?')}  ${source} --${String(edge.type ?? '?')}--> ${target}${suffix}`;
}

/**
 * `Page<EdgeView>` — shared by `edge list` and `entity connections`, because
 * both rows answer with exactly that DTO.
 *
 * `nextCursor` is ALWAYS printed when present. It is an id a follow-up command
 * needs, and §7 forbids dropping one from the human view; a paged read whose
 * human mode silently ends at page one is the same defect as a truncated list.
 */
export function renderEdgePage(dto: unknown): string {
  const page = dto as { items?: unknown; nextCursor?: unknown } | null;
  const items = Array.isArray(page?.items) ? (page.items as EdgeLike[]) : undefined;
  if (items === undefined) return JSON.stringify(dto);
  const lines = items.length === 0 ? ['no edges'] : items.map(edgeLine);
  if (typeof page?.nextCursor === 'string' && page.nextCursor.length > 0) {
    lines.push(`nextCursor: ${page.nextCursor}`);
  }
  return lines.join('\n');
}

interface EdgeTypeLike {
  type?: unknown;
  sourceKinds?: unknown;
  destinationKinds?: unknown;
  acyclic?: unknown;
}

/** `edgeTypes.list` answers a bare array — the endpoint rule IS the payload. */
export function renderEdgeTypes(dto: unknown): string {
  if (!Array.isArray(dto)) return JSON.stringify(dto);
  const rows = dto as EdgeTypeLike[];
  if (rows.length === 0) return 'no edge types';
  const kinds = (v: unknown): string => (Array.isArray(v) ? v.join(',') : '?');
  return rows
    .map((r) =>
      `${String(r.type ?? '?')}  ${kinds(r.sourceKinds)} --> ${kinds(r.destinationKinds)}` +
      (r.acyclic === true ? '  [acyclic]' : ''))
    .join('\n');
}

/**
 * `CommandResult` — the shape every mutation on this module returns.
 *
 * THE UNDO LINE IS DELIBERATELY WORDLESS ABOUT WHAT UNDO DOES. Redeeming a
 * token is not uniformly a reversal: for a `messages.delete` token it is a
 * REDACTION reversal — the body was replaced with `[redacted]`, the row never
 * left the thread, and history SURVIVED. Any wording here that said "delete" or
 * "restore the deleted …" would tell an operator history is gone when it is
 * not, and invite a destructive recovery against data that was never lost. So
 * this prints the token, and the Server's own label VERBATIM, and nothing else:
 * the Server is the only party that knows what its token reverses.
 */
export function renderCommandResult(dto: unknown): string {
  const result = dto as {
    edge?: EdgeLike;
    entity?: { id?: unknown };
    patches?: unknown;
    undo?: { token?: unknown; label?: unknown; expiresAt?: unknown };
  } | null;
  if (result === null || typeof result !== 'object') return JSON.stringify(dto);

  const lines: string[] = [];
  if (result.edge) lines.push(edgeLine(result.edge));
  if (result.entity?.id !== undefined) lines.push(`entity: ${String(result.entity.id)}`);
  const patches = Array.isArray(result.patches) ? (result.patches as EndpointLike[]) : [];
  if (patches.length > 0) {
    lines.push(`patched: ${patches.map((p) => String(p.id ?? '?')).join(' ')}`);
  }
  if (result.undo?.token !== undefined) {
    const label = result.undo.label === undefined ? '' : ` · ${String(result.undo.label)}`;
    const expires = result.undo.expiresAt === undefined
      ? ''
      : ` · expires ${String(result.undo.expiresAt)}`;
    lines.push(`undo token: ${String(result.undo.token)}${label}${expires}`);
  }
  return lines.length === 0 ? 'ok' : lines.join('\n');
}

export const EDGE_COMMANDS: CommandModule[] = [
  { path: ['edge', 'list'], run: edgeList },
  { path: ['edge', 'create'], run: edgeCreate },
  { path: ['edge', 'update'], run: edgeUpdate },
  { path: ['edge', 'delete'], run: edgeDelete },
  { path: ['edge', 'type', 'list'], run: edgeTypeList },
  // Seam ruling S1: the path sits under the `entity` noun, but the DTO is
  // `Page<EdgeView>` and the module is the ownership unit.
  { path: ['entity', 'connections'], run: entityConnections },
];
