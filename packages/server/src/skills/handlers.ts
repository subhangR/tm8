import { z } from 'zod';
import { CollabError, decodeCursor, encodeCursor } from '@tm8/contract';
import type { FacadeDeps } from '../facade/deps.js';
import type { HandlerRegistry } from '../facade/registry.js';
import { claimsFor, commandEnvelope, limitOf, requireUuidParam } from '../facade/context.js';
import { assembleSummaries, ENTITY_COLUMNS, ENTITY_FROM, type EntityRow } from '../facade/entity-read.js';
import { W2EntitiesCommandsTrackingService } from '../facade/services/w2/entities-commands-tracking.js';
import { scanSpaceSkills } from './service.js';
export const SkillScanInputSchema = z.object({ root: z.string().uuid().optional(), all: z.boolean().optional(), clientMutationId: z.string().optional(), actorId: z.string().uuid().optional() }).strict().refine(value => !(value.root && value.all), { message: 'root and all are mutually exclusive' });
export function registerSkillHandlers(registry: HandlerRegistry, deps: FacadeDeps): void {
  registry.register('skills.scan', async ctx => {
    const input = SkillScanInputSchema.parse(ctx.body);
    const owner = await deps.owner();
    return scanSpaceSkills(deps.db, claimsFor(owner, ctx, commandEnvelope(ctx)), requireUuidParam(ctx, 'spaceId'), { ...(input.root ? { root: input.root } : {}), force: true });
  });
  registry.register('skills.list', async ctx => {
    const owner = await deps.owner();
    const spaceId = requireUuidParam(ctx, 'spaceId');
    const limit = limitOf(ctx.query.get('limit'));
    const cursor = ctx.query.get('cursor');
    let after: string | null = null;
    if (cursor) { const { k } = decodeCursor(cursor); if (k.length !== 2 || k[0] !== spaceId || typeof k[1] !== 'string') throw new CollabError('invalid_cursor', 'invalid skill cursor'); after = k[1]; }
    return deps.db.tx(claimsFor(owner, ctx), async q => {
      const rows = await q.query<EntityRow>(`select ${ENTITY_COLUMNS} ${ENTITY_FROM}
        where e.space_id = $1 and e.kind = 'skill' and e.deleted_at is null
          and ($2::uuid is null or e.id > $2::uuid)
          and ($3::text is null or exists(select 1 from public.skills sr where sr.entity_id = e.id and sr.root_ref = $3))
        order by e.id limit $4`, [spaceId, after, ctx.query.get('root'), limit + 1]);
      const page = rows.slice(0, limit);
      return { items: await assembleSummaries(q, page, owner.identityId), nextCursor: rows.length > limit ? encodeCursor([spaceId, page[page.length - 1]!.id]) : null };
    });
  });
  const entities = new W2EntitiesCommandsTrackingService(deps);
  registry.register('skills.show', async ctx => {
    const detail = await entities.getEntity(ctx);
    if (detail.kind !== 'skill') throw new CollabError('not_found', 'entity is not a skill');
    return detail;
  });
}
