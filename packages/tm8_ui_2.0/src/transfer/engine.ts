/**
 * THE TRANSFER ENGINE — client-mediated entity copy between tm8 Servers.
 *
 * Phase-2's binding boundary (docs/remote/PHASE-2-REMOTE-SERVER-INTEGRATION.md)
 * forbids sync, cross-Server edges and multi-master replication — and permits
 * exactly this: an EXPLICIT copy, read from one Server's ordinary catalog and
 * re-created through another's, stamped with provenance, owned thereafter by
 * the destination. Both hops are the VIEWER's own credentials (the per-server
 * pass store); no server ever holds a credential for another server, and this
 * module never talks to two servers with one token.
 *
 * TWO PHASES, SEPARATED ON PURPOSE. `collectPlan` only READS (source Server);
 * `executeTransfer` only WRITES (destination Server). The plan carries every
 * clientMutationId it will ever spend, minted once at plan time — so a re-run
 * of a partially failed execute REPLAYS the same creates against the
 * destination's idempotency ledger instead of minting duplicates.
 *
 * WHAT A COPY CANNOT CARRY, and why that is not a defect:
 *  - Authorship. `created_by` ids are Server-local; the copy is authored by
 *    the viewer's destination account and the original authorship travels as
 *    provenance DATA (the message posted on the copy), never as a mapped id.
 *  - Counters, reactions, read marks, activity, version history — derived or
 *    per-node; the destination recomputes its own.
 *  - Edges whose far end is not in the transferred set — the destination's
 *    edge validator requires both endpoints in-space, so a boundary-crossing
 *    edge has nothing legal to point at.
 */
import type {
  CommandResult,
  EntityDetail,
  EntitySummary,
  MessageView,
  Page,
} from '@tm8/contract';
import type { HttpClient } from '../data/real/http';

/**
 * Mirrors the server's `SUPPORTED_CREATE_KINDS` (facade/handlers/entities.ts)
 * minus `team_member`: a persona is an identity root on its home Server, not
 * content — copying one would mint a can_act_as root nobody asked for.
 * Everything else is refused honestly in the dialog, not silently dropped.
 */
export const TRANSFERABLE_KINDS: ReadonlySet<string> = new Set(['task', 'doc', 'channel']);

/** A plan that would exceed this is a migration, not a panel action. */
export const MAX_PLAN_ENTITIES = 200;
/** First page of discussion per entity; more is an archive job, not a share. */
export const MAX_MESSAGES_PER_ENTITY = 50;

/**
 * Reaction edges are counter feedstock, not content; `contains` is collection
 * membership and collections are not creatable here. Everything else survives
 * or dies by the both-endpoints-in-plan rule alone.
 */
const EXCLUDED_EDGE_TYPES = new Set(['likes', 'dislikes', 'stars', 'contains']);

export interface PlanEntity {
  sourceId: string;
  kind: string;
  title: string;
  /** Source id of the parent when the parent is in the plan; else null. */
  parentSourceId: string | null;
  /** Create-shaped content, already projected for `entities.create`. */
  content: Record<string, unknown>;
  role: 'root' | 'child' | 'connected';
  sourceVersion: number;
  mutationId: string;
}

export interface PlanEdge {
  type: string;
  srcSourceId: string;
  dstSourceId: string;
  props: Record<string, unknown>;
  mutationId: string;
}

export interface PlanMessage {
  anchorSourceId: string;
  author: string;
  at: string;
  body: string;
  mutationId: string;
}

export interface TransferPlan {
  sourceServerId: string;
  sourceLabel: string;
  root: { id: string; title: string; kind: string; spaceId: string; version: number; author: string };
  /** Parent-first order; the root is always element 0. */
  entities: PlanEntity[];
  edges: PlanEdge[];
  messages: PlanMessage[];
  skipped: { id: string; title: string; reason: string }[];
}

export interface CollectOptions {
  includeChildren: boolean;
  /** Source ids of connected entities the viewer ticked. */
  connectedIds: readonly string[];
  includeMessages: boolean;
}

export interface TransferProgress {
  phase: 'reading' | 'entities' | 'edges' | 'messages' | 'provenance';
  done: number;
  total: number;
  label: string;
}

export interface TransferResult {
  destRootId: string | null;
  created: { sourceId: string; destId: string; title: string }[];
  failedEntities: { sourceId: string; title: string; reason: string }[];
  edgesCreated: number;
  edgesFailed: { type: string; reason: string }[];
  messagesPosted: number;
  messagesFailed: number;
}

const newMutationId = (): string =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `tr_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;

function reasonOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * EntityDetail → the content bag `entities.create` accepts for that kind.
 * Server-validated per kind; this projects only the members the create RPCs
 * actually read (create_task / create_document / create_channel), so nothing
 * here can smuggle a field the destination would refuse the whole create for.
 */
export function createContentFor(detail: EntityDetail): Record<string, unknown> {
  const content = detail.content as Record<string, unknown> & { kind: string };
  const state = detail.state as Record<string, unknown> & { kind: string };
  if (content.kind === 'task') {
    const criteria = Array.isArray(content.acceptanceCriteria) ? content.acceptanceCriteria : [];
    return {
      description: typeof content.description === 'string' ? content.description : '',
      // doneBy/doneAt name source-Server actors; the fact `done` survives,
      // the dangling attribution does not.
      acceptanceCriteria: criteria.map((c) => {
        const item = (typeof c === 'object' && c !== null ? c : {}) as Record<string, unknown>;
        return {
          id: typeof item.id === 'string' ? item.id : undefined,
          text: typeof item.text === 'string' ? item.text : '',
          done: item.done === true,
        };
      }),
      ...(typeof content.pointsEstimate === 'number' ? { pointsEstimate: content.pointsEstimate } : {}),
      ...(typeof state.priority === 'string' ? { priority: state.priority } : {}),
      ...(typeof state.startDate === 'string' ? { startDate: state.startDate } : {}),
      ...(typeof state.dueDate === 'string' ? { dueDate: state.dueDate } : {}),
      // Axes are deliberately NOT carried: they reference the source Space's
      // own axis registry, and an unknown axis fails the whole create.
    };
  }
  if (content.kind === 'doc') {
    return {
      body: typeof content.body === 'string' ? content.body : '',
      format: typeof content.format === 'string' ? content.format : 'markdown',
    };
  }
  if (content.kind === 'channel') {
    return { topic: typeof content.topic === 'string' ? content.topic : '' };
  }
  // Unreachable while the dialog gates on TRANSFERABLE_KINDS; kept honest for
  // a caller that does not.
  return {};
}

async function readAllChildren(client: HttpClient, id: string): Promise<EntitySummary[]> {
  const all: EntitySummary[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.call<Page<EntitySummary>>('entities.children', {
      params: { id },
      query: { limit: 100, cursor },
    });
    all.push(...page.items);
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined && all.length <= MAX_PLAN_ENTITIES);
  return all;
}

/** Every edge on `detail` whose type survives the exclusion list. */
function edgesOf(detail: EntityDetail): { id: string; type: string; srcId: string; dstId: string; props: Record<string, unknown> }[] {
  const groups = [...(detail.connections?.outgoing ?? []), ...(detail.connections?.incoming ?? [])];
  return groups.flatMap((group) =>
    EXCLUDED_EDGE_TYPES.has(group.type)
      ? []
      : group.edges.map((edge) => ({
          id: edge.id,
          type: edge.type,
          srcId: edge.source.id,
          dstId: edge.target.id,
          props: edge.props ?? {},
        })),
  );
}

/**
 * READ phase. Walks the subtree (children are the root's own kind by the
 * hierarchy invariant, so a transferable root implies transferable children),
 * fetches each ticked connected entity, and keeps exactly the edges whose two
 * endpoints both made it into the plan.
 */
export async function collectPlan(
  source: { client: HttpClient; serverId: string; label: string },
  root: EntityDetail,
  opts: CollectOptions,
  onProgress?: (progress: TransferProgress) => void,
): Promise<TransferPlan> {
  if (!TRANSFERABLE_KINDS.has(root.kind)) {
    throw new Error(`entities of kind '${root.kind}' cannot be transferred yet`);
  }

  const skipped: TransferPlan['skipped'] = [];
  const details = new Map<string, EntityDetail>([[root.id, root]]);
  const roles = new Map<string, PlanEntity['role']>([[root.id, 'root']]);
  const parents = new Map<string, string | null>([[root.id, null]]);
  /** Parent-first ordering falls out of the BFS walk order. */
  const order: string[] = [root.id];

  if (opts.includeChildren) {
    const queue = [root.id];
    while (queue.length > 0) {
      const parentId = queue.shift() as string;
      const children = await readAllChildren(source.client, parentId);
      for (const child of children) {
        if (details.has(child.id)) continue;
        if (order.length >= MAX_PLAN_ENTITIES) {
          throw new Error(
            `the subtree exceeds ${MAX_PLAN_ENTITIES} entities — transfer a smaller branch`,
          );
        }
        onProgress?.({ phase: 'reading', done: order.length, total: order.length + queue.length + 1, label: child.title });
        const detail = await source.client.call<EntityDetail>('entities.get', { params: { id: child.id } });
        details.set(child.id, detail);
        roles.set(child.id, 'child');
        parents.set(child.id, parentId);
        order.push(child.id);
        queue.push(child.id);
      }
    }
  }

  for (const connectedId of opts.connectedIds) {
    if (details.has(connectedId)) continue;
    onProgress?.({ phase: 'reading', done: order.length, total: order.length + 1, label: connectedId });
    let detail: EntityDetail;
    try {
      detail = await source.client.call<EntityDetail>('entities.get', { params: { id: connectedId } });
    } catch (cause) {
      skipped.push({ id: connectedId, title: connectedId, reason: reasonOf(cause) });
      continue;
    }
    if (!TRANSFERABLE_KINDS.has(detail.kind)) {
      skipped.push({ id: connectedId, title: detail.title, reason: `kind '${detail.kind}' cannot be transferred yet` });
      continue;
    }
    if (order.length >= MAX_PLAN_ENTITIES) {
      skipped.push({ id: connectedId, title: detail.title, reason: `plan already holds ${MAX_PLAN_ENTITIES} entities` });
      continue;
    }
    details.set(connectedId, detail);
    roles.set(connectedId, 'connected');
    parents.set(connectedId, null);
    order.push(connectedId);
  }

  const entities: PlanEntity[] = order.map((id) => {
    const detail = details.get(id) as EntityDetail;
    return {
      sourceId: id,
      kind: detail.kind,
      title: detail.title,
      parentSourceId: parents.get(id) ?? null,
      content: createContentFor(detail),
      role: roles.get(id) ?? 'child',
      sourceVersion: detail.version,
      mutationId: newMutationId(),
    };
  });

  const seenEdges = new Set<string>();
  const edges: PlanEdge[] = [];
  for (const id of order) {
    for (const edge of edgesOf(details.get(id) as EntityDetail)) {
      if (seenEdges.has(edge.id)) continue;
      seenEdges.add(edge.id);
      if (!details.has(edge.srcId) || !details.has(edge.dstId)) continue;
      edges.push({
        type: edge.type,
        srcSourceId: edge.srcId,
        dstSourceId: edge.dstId,
        props: edge.props,
        mutationId: newMutationId(),
      });
    }
  }

  const messages: PlanMessage[] = [];
  if (opts.includeMessages) {
    for (const id of order) {
      const page = await source.client.call<Page<MessageView>>('messages.list', {
        params: { anchorId: id },
        query: { limit: MAX_MESSAGES_PER_ENTITY },
      });
      // Oldest first, so the copied discussion reads in the order it happened.
      const items = [...page.items].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      for (const message of items) {
        const body = (message.content as { body?: unknown }).body;
        if (typeof body !== 'string' || body.length === 0) continue;
        messages.push({
          anchorSourceId: id,
          author: message.createdBy.displayName,
          at: message.createdAt,
          body,
          mutationId: newMutationId(),
        });
      }
    }
  }

  return {
    sourceServerId: source.serverId,
    sourceLabel: source.label,
    root: {
      id: root.id,
      title: root.title,
      kind: root.kind,
      spaceId: root.spaceId,
      version: root.version,
      author: root.createdBy.displayName,
    },
    entities,
    edges,
    messages,
    skipped,
  };
}

/**
 * The provenance receipt, posted on the copy's root. Plain DATA fields — the
 * Phase-2 design's ruling verbatim: provenance is never a foreign key, and a
 * copy is a build product that does not stay in sync with its source.
 */
export function provenanceBody(plan: TransferPlan, counts: { entities: number; edges: number; messages: number }): string {
  return [
    `📥 Transferred from server "${plan.sourceLabel}"`,
    `Source: space ${plan.root.spaceId} · entity ${plan.root.id} · v${plan.root.version} — "${plan.root.title}"`,
    `Original author: ${plan.root.author} · transferred ${new Date().toISOString()}`,
    `Carried: ${counts.entities} ${counts.entities === 1 ? 'entity' : 'entities'}, ${counts.edges} ${counts.edges === 1 ? 'edge' : 'edges'}, ${counts.messages} ${counts.messages === 1 ? 'message' : 'messages'}.`,
    'This copy is a build product of its source and does not stay in sync with it.',
  ].join('\n');
}

/**
 * WRITE phase. Creates parent-first so every child can name its mapped
 * parent; a failed create fails its own descendants (recorded, not retried)
 * but never the siblings. A failed ROOT aborts — a transfer whose headline
 * entity did not arrive has nothing to hang edges, messages or provenance on.
 */
export async function executeTransfer(
  plan: TransferPlan,
  dest: { client: HttpClient; spaceId: string },
  onProgress?: (progress: TransferProgress) => void,
): Promise<TransferResult> {
  const idMap = new Map<string, string>();
  const created: TransferResult['created'] = [];
  const failedEntities: TransferResult['failedEntities'] = [];
  const failedSources = new Set<string>();

  const total = plan.entities.length;
  for (let i = 0; i < plan.entities.length; i += 1) {
    const item = plan.entities[i] as PlanEntity;
    onProgress?.({ phase: 'entities', done: i, total, label: item.title });
    if (item.parentSourceId !== null && failedSources.has(item.parentSourceId)) {
      failedSources.add(item.sourceId);
      failedEntities.push({ sourceId: item.sourceId, title: item.title, reason: 'its parent failed to transfer' });
      continue;
    }
    const parentId = item.parentSourceId === null ? null : idMap.get(item.parentSourceId) ?? null;
    try {
      const result = await dest.client.call<CommandResult>('entities.create', {
        body: {
          clientMutationId: item.mutationId,
          spaceId: dest.spaceId,
          kind: item.kind,
          title: item.title,
          parentId,
          content: item.content,
        },
      });
      const destId = result.entity?.id;
      if (typeof destId !== 'string') throw new Error('the destination returned no entity id');
      idMap.set(item.sourceId, destId);
      created.push({ sourceId: item.sourceId, destId, title: item.title });
    } catch (cause) {
      failedSources.add(item.sourceId);
      failedEntities.push({ sourceId: item.sourceId, title: item.title, reason: reasonOf(cause) });
      if (item.role === 'root') {
        return {
          destRootId: null,
          created,
          failedEntities,
          edgesCreated: 0,
          edgesFailed: [],
          messagesPosted: 0,
          messagesFailed: 0,
        };
      }
    }
  }

  let edgesCreated = 0;
  const edgesFailed: TransferResult['edgesFailed'] = [];
  for (let i = 0; i < plan.edges.length; i += 1) {
    const edge = plan.edges[i] as PlanEdge;
    const srcId = idMap.get(edge.srcSourceId);
    const dstId = idMap.get(edge.dstSourceId);
    if (srcId === undefined || dstId === undefined) continue;
    onProgress?.({ phase: 'edges', done: i, total: plan.edges.length, label: edge.type });
    try {
      await dest.client.call<CommandResult>('edges.create', {
        body: { clientMutationId: edge.mutationId, srcId, dstId, type: edge.type, props: edge.props },
      });
      edgesCreated += 1;
    } catch (cause) {
      edgesFailed.push({ type: edge.type, reason: reasonOf(cause) });
    }
  }

  let messagesPosted = 0;
  let messagesFailed = 0;
  for (let i = 0; i < plan.messages.length; i += 1) {
    const message = plan.messages[i] as PlanMessage;
    const anchorId = idMap.get(message.anchorSourceId);
    if (anchorId === undefined) continue;
    onProgress?.({ phase: 'messages', done: i, total: plan.messages.length, label: message.author });
    try {
      await dest.client.call<CommandResult>('messages.post', {
        body: {
          clientMutationId: message.mutationId,
          anchorIds: [anchorId],
          // Authorship cannot cross Servers; the original author becomes the
          // first line of the copied body, as data.
          body: `**${message.author}** · ${message.at}\n\n${message.body}`.slice(0, 10_000),
        },
      });
      messagesPosted += 1;
    } catch {
      messagesFailed += 1;
    }
  }

  const destRootId = idMap.get(plan.root.id) ?? null;
  if (destRootId !== null) {
    onProgress?.({ phase: 'provenance', done: 0, total: 1, label: 'provenance' });
    try {
      await dest.client.call<CommandResult>('messages.post', {
        body: {
          clientMutationId: `${plan.entities[0]?.mutationId ?? newMutationId()}-provenance`,
          anchorIds: [destRootId],
          body: provenanceBody(plan, {
            entities: created.length,
            edges: edgesCreated,
            messages: messagesPosted,
          }),
        },
      });
    } catch {
      // The copy exists; a lost receipt is reported through the result panel,
      // not by failing the transfer after the fact.
      messagesFailed += 1;
    }
  }

  return { destRootId, created, failedEntities, edgesCreated, edgesFailed, messagesPosted, messagesFailed };
}
