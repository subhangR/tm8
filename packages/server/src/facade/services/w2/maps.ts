import {
  CollabError, MapsOpenInputSchema, MapsNavigationSaveInputSchema, MapsPlaceInputSchema,
  MapsMoveInputSchema, MapsRemoveInputSchema, MapsPaintInputSchema, MapsUndoInputSchema,
  MapsRevertInputSchema, MapsActivityInputSchema, type GameMapContext, type GameMapIdentity,
  type GameMapPlacement, type GameNavigationView,
} from '@tm8/contract';
import type { z } from 'zod';
import type { RequestContext } from '../../../http/types.js';
import type { FacadeDeps } from '../../deps.js';
import { claimsFor, commandEnvelope, requireUuidParam } from '../../context.js';

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new CollabError('invalid_input', parsed.error.issues[0]?.message ?? 'invalid map input');
  return parsed.data;
}
function limitOf(ctx: RequestContext): number {
  const raw = ctx.query.get('limit');
  const limit = raw === null ? 100 : Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new CollabError('invalid_input', 'limit must be 1..200');
  return limit;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createMapsService(deps: FacadeDeps) {
  const tx = async <T>(ctx: RequestContext, fn: Parameters<FacadeDeps['db']['tx']>[1]): Promise<T> =>
    deps.db.tx(claimsFor(await deps.owner(), ctx, commandEnvelope(ctx)), fn) as Promise<T>;
  const schemas = {
    place: MapsPlaceInputSchema, move: MapsMoveInputSchema, remove: MapsRemoveInputSchema,
    paint: MapsPaintInputSchema, undo: MapsUndoInputSchema, revert: MapsRevertInputSchema,
    'activity.append': MapsActivityInputSchema,
  };
  return {
    open(ctx: RequestContext): Promise<GameMapIdentity> {
      const body = parse(MapsOpenInputSchema, ctx.body);
      return tx(ctx, q => q.rpc('game_map_open', [requireUuidParam(ctx, 'spaceId'),
        JSON.stringify({ type: body.type, scope: body.scope }), body.clientMutationId]));
    },
    navigationGet(ctx: RequestContext): Promise<GameNavigationView> {
      return tx(ctx, q => q.rpc('game_navigation_get', [requireUuidParam(ctx, 'spaceId')]));
    },
    navigationSave(ctx: RequestContext): Promise<GameNavigationView> {
      const body = parse(MapsNavigationSaveInputSchema, ctx.body);
      if (Buffer.byteLength(JSON.stringify(body.save)) > 65536) throw new CollabError('payload_too_large', 'navigation save exceeds 64 KiB');
      return tx(ctx, q => q.rpc('game_navigation_save', [requireUuidParam(ctx, 'spaceId'),
        JSON.stringify(body.save), body.expectedRevision, body.clientMutationId]));
    },
    async write(ctx: RequestContext, op: keyof typeof schemas): Promise<unknown> {
      const body = parse(schemas[op] as z.ZodType<Record<string, unknown>>, ctx.body);
      const input = { ...body, ...(ctx.params.itemId ? { itemId: requireUuidParam(ctx, 'itemId') } : {}) };
      return tx(ctx, q => q.rpc('game_map_write', [requireUuidParam(ctx, 'mapId'), op, JSON.stringify(input), body.clientMutationId]));
    },
    context(ctx: RequestContext): Promise<GameMapContext> {
      const mapId = requireUuidParam(ctx, 'mapId'), limit = limitOf(ctx), cursor = ctx.query.get('cursor');
      if (cursor && !uuid.test(cursor)) throw new CollabError('invalid_input', 'invalid placement cursor');
      return tx(ctx, async q => {
        const [row] = await q.query<{ identity: GameMapIdentity }>('select map.identity($1) as identity', [mapId]);
        const placements = await q.query<GameMapPlacement>(`select item_id as "itemId", entity_id as "entityId", kind, x, z,
          rotation, spec, layer, by_actor as "byActor", version, expires_at as "expiresAt"
          from map.placements where map_id=$1 and deleted_at is null and (expires_at is null or expires_at>clock_timestamp())
          and ($2::uuid is null or item_id>$2) and (entity_id is null or map.ref_readable(map_id,entity_id))
          order by item_id limit $3`, [mapId, cursor, limit + 1]);
        const terrain = await q.query<GameMapContext['terrain'][number]>(`select chunk_x as "chunkX", chunk_z as "chunkZ", tiles, version
          from map.terrain_chunks where map_id=$1 and deleted_at is null order by chunk_x,chunk_z limit 65`, [mapId]);
        return { map: row!.identity, placements: placements.slice(0, limit),
          nextCursor: placements.length > limit ? placements[limit - 1]!.itemId : null,
          terrain: terrain.slice(0, 64), terrainTruncated: terrain.length > 64 };
      });
    },
    activityList(ctx: RequestContext): Promise<unknown> {
      const mapId = requireUuidParam(ctx, 'mapId'), limit = limitOf(ctx), since = Number(ctx.query.get('since') ?? 0);
      if (!Number.isSafeInteger(since) || since < 0) throw new CollabError('invalid_input', 'since must be a nonnegative sequence');
      return tx(ctx, async q => {
        await q.query('select map.identity($1)', [mapId]);
        const rows = await q.query<{ seq: string }>(`select seq::text, actor_id as "byActor", kind,
          target_entity_id as "targetEntityId", text, audience, created_at as "createdAt", expires_at as "expiresAt"
          from map.activity where map_id=$1 and seq>$2 and expires_at>clock_timestamp()
          and (target_entity_id is null or map.ref_readable(map_id,target_entity_id)) order by seq limit $3`, [mapId, since, limit + 1]);
        const items = rows.slice(0, limit).map(r => ({ ...r, seq: Number(r.seq) }));
        return { items, nextSince: rows.length > limit ? items[limit - 1]!.seq : null };
      });
    },
  };
}
