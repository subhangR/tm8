import { z } from 'zod';

export const GAME_MAP_TYPES = ['hub', 'taskland', 'office', 'library', 'factory', 'town'] as const;
export const GameMapTypeSchema = z.enum(GAME_MAP_TYPES);
export const GameMapScopeSchema = z.object({ kind: z.enum(['space', 'story']), id: z.string().uuid() }).strict();
export const GameMapSelectionSchema = z.object({ type: GameMapTypeSchema, scope: GameMapScopeSchema }).strict();
export type GameMapSelection = z.infer<typeof GameMapSelectionSchema>;
export function gameMapKey(map: GameMapSelection): string { return JSON.stringify([map.scope.kind, map.scope.id, map.type]); }
const coordinate = z.number().finite().min(-1_000_000).max(1_000_000);
export const GameMapMemorySchema = z.object({
  position: z.object({ x: coordinate, z: coordinate }).strict().optional(),
  camera: z.object({ zoom: z.number().finite().min(0.1).max(1000),
    position: z.tuple([coordinate, coordinate, coordinate]), target: z.tuple([coordinate, coordinate, coordinate]),
  }).strict().optional(),
}).strict();
/** Phase 1 save shape; map keys are canonical JSON tuples, never entity titles. */
export const GameNavigationSaveSchema = z.object({
  version: z.literal(1), spaceId: z.string().uuid(), memberId: z.string().uuid(),
  current: GameMapSelectionSchema, stack: z.array(GameMapSelectionSchema).max(64),
  maps: z.record(GameMapMemorySchema),
}).strict().superRefine((save, ctx) => {
  const route = [...save.stack, save.current];
  const root = { type: 'hub' as const, scope: { kind: 'space' as const, id: save.spaceId } };
  if (gameMapKey(route[0]!) !== gameMapKey(root)) ctx.addIssue({ code: 'custom', message: 'navigation must start at the space hub' });
  for (let i = 0; i < route.length; i++) {
    const map = route[i]!;
    if (map.scope.kind === 'space' && map.scope.id !== save.spaceId) ctx.addIssue({ code: 'custom', message: 'scope belongs to another space' });
    const parent = route[i - 1];
    if (parent && (parent.type !== 'hub' || (map.type !== 'hub' && gameMapKey({ ...map, type: 'hub' }) !== gameMapKey(parent))
      || (map.type === 'hub' && (map.scope.kind !== 'story' || map.scope.id === parent.scope.id))))
      ctx.addIssue({ code: 'custom', message: 'invalid return stack' });
  }
  if (Object.keys(save.maps).length > 128) ctx.addIssue({ code: 'custom', message: 'at most 128 map memories' });
  for (const key of Object.keys(save.maps)) {
    let map: GameMapSelection | undefined;
    try { const parts = JSON.parse(key); map = GameMapSelectionSchema.parse({ scope: { kind: parts[0], id: parts[1] }, type: parts[2] }); } catch { /* invalid key */ }
    if (!map || gameMapKey(map) !== key || (map.scope.kind === 'space' && map.scope.id !== save.spaceId))
      ctx.addIssue({ code: 'custom', message: 'invalid map memory key' });
  }
});
export type GameNavigationSave = z.infer<typeof GameNavigationSaveSchema>;
export interface GameNavigationView { spaceId: string; memberId: string; save: GameNavigationSave | null; revision: number }
export interface GameMapIdentity extends GameMapSelection { id: string; spaceId: string; title: string }

const command = { clientMutationId: z.string().min(1).max(200), actorId: z.string().uuid().optional(), workSessionId: z.string().uuid().optional() };
export const MapsOpenInputSchema = GameMapSelectionSchema.extend(command);
export const MapsNavigationSaveInputSchema = z.object({ ...command, save: GameNavigationSaveSchema, expectedRevision: z.number().int().nonnegative() }).strict();
export const MapPlacementSpecSchema = z.object({ asset: z.string().min(1).max(100).optional(), text: z.string().max(500).optional(), targetMapId: z.string().uuid().optional() }).strict();
export const MapsPlaceInputSchema = z.object({ ...command, itemId: z.string().uuid(), entityId: z.string().uuid().optional(),
  kind: z.enum(['ref', 'decor', 'path', 'portal', 'landmark']), x: coordinate, z: coordinate,
  rotation: z.number().finite().min(-360).max(360).default(0), spec: MapPlacementSpecSchema.default({}),
  expectedVersion: z.number().int().nonnegative(), ttlSeconds: z.number().int().min(1).max(86400).optional(),
}).strict().superRefine((p, ctx) => {
  if (p.kind === 'ref' && !p.entityId) ctx.addIssue({ code: 'custom', message: 'a building requires a real entityId' });
  if (p.kind !== 'ref' && p.entityId) ctx.addIssue({ code: 'custom', message: 'entityId is only valid on a ref' });
  if (p.kind === 'portal' && !p.spec.targetMapId) ctx.addIssue({ code: 'custom', message: 'a portal requires targetMapId' });
});
export const MapsMoveInputSchema = z.object({ ...command, x: coordinate, z: coordinate, expectedVersion: z.number().int().positive() }).strict();
export const MapsRemoveInputSchema = z.object({ ...command, expectedVersion: z.number().int().positive() }).strict();
export const MapsPaintInputSchema = z.object({ ...command, chunkX: z.number().int().min(-10000).max(10000), chunkZ: z.number().int().min(-10000).max(10000),
  tiles: z.array(z.number().int().min(0).max(65535)).max(4096), expectedVersion: z.number().int().nonnegative() }).strict();
export const MapsUndoInputSchema = z.object({ ...command, editSeq: z.number().int().positive().safe() }).strict();
export const MapsRevertInputSchema = z.object({ ...command, byActor: z.string().uuid(), since: z.string().datetime() }).strict();
export const MapsActivityInputSchema = z.object({ ...command, kind: z.enum(['marker', 'narration', 'celebration', 'spotlight']),
  targetEntityId: z.string().uuid().optional(), text: z.string().max(1000), audience: z.string().uuid().optional(), ttlSeconds: z.number().int().min(1).max(86400).optional(),
}).strict().superRefine((p, ctx) => {
  if (p.kind !== 'narration' && !p.targetEntityId) ctx.addIssue({ code: 'custom', message: 'activity requires a real target' });
  if (p.kind === 'narration' && p.audience) ctx.addIssue({ code: 'custom', message: 'narration is shared with everyone' });
});
export interface GameMapPlacement {
  itemId: string; entityId: string | null; kind: 'ref' | 'decor' | 'path' | 'portal' | 'landmark';
  x: number; z: number; rotation: number; spec: z.infer<typeof MapPlacementSpecSchema>;
  layer: 'human' | 'agent'; byActor: string; version: number; expiresAt: string | null;
}
export interface GameMapContext {
  map: GameMapIdentity; placements: GameMapPlacement[]; nextCursor: string | null;
  terrain: { chunkX: number; chunkZ: number; tiles: number[]; version: number }[]; terrainTruncated: boolean;
}
