/**
 * `tm8 graph query` — traversal outward from a focus entity (§4.8).
 *
 * A READ THAT TRAVELS BY POST. `graph.query` is `kind: 'read'` in the catalog;
 * it uses POST only because its query is a structured DTO too large for a
 * query string. That makes `--mutation-id` a usage error here exactly as it is
 * on a GET: a caller who passes one believes their traversal is idempotently
 * retryable in a way it is not, or has typed the wrong command.
 *
 * `GraphQuery` extends the collection query shape and is `.strict()`, so
 * `spaceId` is required and any key the schema does not name is
 * `invalid_input`. The body therefore carries exactly the fields the caller
 * asked for — no empty `filters` object, no defaulted `hops`. Defaulting
 * `hops` here would also be wrong for a second reason: the Server refuses
 * `hops` without `focusId`, and inventing one would turn a caller's
 * Space-wide query into a focused one they did not request.
 */
import { requireSpace } from '../context.js';
import { EXIT_OK, type ExitCode } from '../exit.js';
import { refuseMutationId } from '../mutation.js';
import { clientFor, observedInvoke } from '../discovery/observe.js';
import { assertKnownOptions, enumOption, summaryLine } from './entity.js';
import type { CommandContext, CommandModule } from '../run.js';

/**
 * `GraphResult` is `{nodes, edges, clusters}`. The human view keeps every node
 * id and every edge's endpoints: those are the ids the follow-up commands in
 * this grammar take, and a topology summary without them cannot be acted on.
 */
function renderGraph(dto: unknown): string {
  const g = dto as { nodes?: unknown; edges?: unknown; clusters?: unknown } | undefined;
  const nodes = Array.isArray(g?.nodes) ? (g.nodes as Array<Record<string, unknown>>) : [];
  const edges = Array.isArray(g?.edges) ? (g.edges as Array<Record<string, unknown>>) : [];
  const lines: string[] = [];
  for (const node of nodes) lines.push(`node  ${summaryLine(node)}`);
  for (const edge of edges) {
    // `graph.query` sends endpoint IDS. The `source`/`target` fallbacks read a
    // node that predates that change — this renderer is the human view of a
    // remote DTO and has no reason to go blank against an older server.
    const source = edge.sourceId ?? (edge.source as { id?: unknown } | undefined)?.id;
    const target = edge.targetId ?? (edge.target as { id?: unknown } | undefined)?.id;
    lines.push(`edge  ${String(edge.id ?? '')}  ${String(source ?? '')} -${String(edge.type ?? '')}-> ${String(target ?? '')}`);
  }
  return lines.length > 0 ? lines.join('\n') : 'no nodes';
}

async function graphQuery(cmd: CommandContext): Promise<ExitCode> {
  refuseMutationId('graph query', cmd.options.value('mutation-id'));
  assertKnownOptions(cmd, ['focus', 'hops', 'edge-type', 'mode', 'limit', 'cursor']);

  const body: Record<string, unknown> = { spaceId: requireSpace(cmd.ctx) };
  const focusId = cmd.options.value('focus');
  if (focusId !== undefined) body.focusId = focusId;
  const hops = cmd.options.integer('hops');
  if (hops !== undefined) body.hops = hops;
  const edgeTypes = cmd.options.values('edge-type');
  if (edgeTypes.length > 0) body.edgeTypes = edgeTypes;
  const mode = enumOption(cmd, 'mode', ['free', 'dependency']);
  if (mode !== undefined) body.mode = mode;
  const limit = cmd.options.integer('limit');
  if (limit !== undefined) body.limit = limit;
  const cursor = cmd.options.value('cursor');
  if (cursor !== undefined) body.cursor = cursor;

  const data = await observedInvoke<unknown>(clientFor(cmd.ctx), 'graph.query', { body });
  cmd.out.data(data, renderGraph);
  return EXIT_OK;
}

export const GRAPH_COMMANDS: CommandModule[] = [
  { path: ['graph', 'query'], run: graphQuery },
];
