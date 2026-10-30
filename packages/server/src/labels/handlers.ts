/**
 * `labels.*` (migration 397; BRIDGE-ENTITY-DESIGN §3.8, D27).
 *
 * Thin doors over 397's RPCs. The read is one query over `public.labels`
 * joined to its envelope, under the caller's RLS; an archived label leaves the
 * list unless `includeArchived` asks for it. An entity's labels are written by
 * `entities.patch` (`labels: {add, remove}`), not here.
 */
import {
  CollabError, LabelArchiveInputSchema, LabelCreateInputSchema, LabelUpdateInputSchema, LabelsListInputSchema,
  type LabelView,
} from '@tm8/contract';
import type { FacadeDeps } from '../facade/deps.js';
import type { HandlerRegistry } from '../facade/registry.js';
import { claimsFor, commandEnvelope, requireUuidParam } from '../facade/context.js';
import type { Querier } from '../db/types.js';
import type { RequestContext } from '../http/types.js';

interface LabelRow {
  id: string; space_id: string; version: number;
  name: string; colour: string; description: string; archived_at: Date | string | null;
}

const LABEL_SELECT = `
  select e.id, e.space_id, e.version, l.name, l.colour, l.description, l.archived_at
    from public.entities e join public.labels l on l.entity_id = e.id
   where e.deleted_at is null and internal.entity_readable(e.id)`;

const viewOf = (row: LabelRow): LabelView => ({
  id: row.id, spaceId: row.space_id, version: Number(row.version),
  name: row.name, colour: row.colour, description: row.description,
  archivedAt: row.archived_at === null ? null : new Date(row.archived_at).toISOString(),
});

export async function loadLabelView(q: Querier, labelId: string): Promise<LabelView> {
  const [row] = await q.query<LabelRow>(`${LABEL_SELECT} and e.id = $1`, [labelId]);
  if (!row) throw new CollabError('not_found', 'Label is unavailable');
  return viewOf(row);
}

/** A space's labels by name; archived ones only when asked. */
export async function listLabelViews(q: Querier, spaceId: string, includeArchived: boolean): Promise<LabelView[]> {
  const rows = await q.query<LabelRow>(
    `${LABEL_SELECT} and e.space_id = $1 and ($2::boolean or l.archived_at is null)
      order by lower(l.name), e.id`,
    [spaceId, includeArchived]);
  return rows.map(viewOf);
}

/** The route names the target; a repeated body ID must agree with it. */
function labelRouteId(ctx: RequestContext, field: 'spaceId' | 'labelId'): string {
  const id = requireUuidParam(ctx, field);
  const bodyId = (ctx.body as Record<string, unknown> | undefined)?.[field];
  if (bodyId !== undefined && bodyId !== id) {
    throw new CollabError('invalid_input', `body ${field} does not match route`);
  }
  return id;
}

export function registerLabelHandlers(registry: HandlerRegistry, deps: FacadeDeps): void {
  const command = async <T>(ctx: RequestContext, work: (q: Querier) => Promise<T>) =>
    deps.db.tx(claimsFor(await deps.owner(), ctx, commandEnvelope(ctx)), work);
  const read = async <T>(ctx: RequestContext, work: (q: Querier) => Promise<T>) =>
    deps.db.tx(claimsFor(await deps.owner(), ctx), work);

  registry.registerAll({
    'labels.list': async ctx => {
      const spaceId = requireUuidParam(ctx, 'spaceId');
      const input = LabelsListInputSchema.parse({
        ...(ctx.query.get('includeArchived') === null ? {} : { includeArchived: ctx.query.get('includeArchived') }),
      });
      const includeArchived = input.includeArchived === true || input.includeArchived === 'true';
      return read(ctx, async q => {
        const [row] = await q.query<{ member: string | null }>('select internal.current_member_id($1::uuid) as member', [spaceId]);
        if (!row?.member) throw new CollabError('forbidden', 'Only a member of this Space can list its labels');
        return { items: await listLabelViews(q, spaceId, includeArchived), nextCursor: null };
      });
    },
    'labels.create': async ctx => {
      const input = LabelCreateInputSchema.parse(ctx.body);
      const spaceId = labelRouteId(ctx, 'spaceId');
      return command(ctx, async q => {
        const result = await q.rpc<{ entity: { id: string } }>('create_label', [
          spaceId, input.name, input.colour ?? null, input.description ?? '',
          input.actorId ?? null, input.clientMutationId,
        ]);
        return loadLabelView(q, result.entity.id);
      });
    },
    'labels.update': async ctx => {
      const input = LabelUpdateInputSchema.parse(ctx.body);
      const labelId = labelRouteId(ctx, 'labelId');
      return command(ctx, async q => {
        await q.rpc('update_label', [
          labelId, input.expectedVersion, input.actorId ?? null,
          input.name ?? null, input.colour ?? null, input.description ?? null,
          input.archived ?? null, input.clientMutationId,
        ]);
        return loadLabelView(q, labelId);
      });
    },
    'labels.archive': async ctx => {
      const input = LabelArchiveInputSchema.parse(ctx.body);
      const labelId = labelRouteId(ctx, 'labelId');
      return command(ctx, async q => {
        await q.rpc('archive_label', [labelId, input.expectedVersion, input.actorId ?? null, input.clientMutationId]);
        return loadLabelView(q, labelId);
      });
    },
  });
}
