/** Pure map contract: no Three, DOM, React, or server mutations. Distances use x/z. */
export type MapType = 'hub' | 'taskland' | 'office' | 'library' | 'factory' | 'town';
export type MapScope = { kind: 'space' | 'story'; id: string };
export interface Point { x: number; z: number }
export interface Bounds { minX: number; minZ: number; maxX: number; maxZ: number }
export type ConstructionStage = 'lot' | 'foundation' | 'scaffolding' | 'walls' | 'topped-out' | 'complete' | 'rubble' | 'shipped-marker';
export interface MapEntity {
  id: string; kind: string; title: string; parentId?: string | null;
  version?: number; updatedAt?: string | null;
  status?: string | null; statusCategory?: string | null; createdAt?: string | null;
  /** Authoritative weighted fraction, 0..1. Null means unknown, not zero. */
  progress?: number | null; pointsEstimate?: number | null; subtreeWeight?: number | null;
  /** Summary counts or detail criteria, normalized at the projection boundary. */
  acceptance?: { total: number; completed: number };
  ownProgress?: number | null; estimateTent?: boolean;
  /** Authoritative cancellation transition time, never entity updatedAt or load time. */
  cancelledAt?: string | null;
  /** Proven upper bound from the status writer's updatedAt, never a cancellation date. */
  cancelledNotAfter?: string | null;
  /** Event evidence for cold-load terminal-lot placement; never inferred from timestamps. */
  terminalFromStatus?: string | null;
  pendingAttention?: number; mailbox?: { count: number; approx?: boolean; basis?: 'messages' | 'unread' };
  processState?: string | null; outcome?: string | null; endedKind?: string | null; live?: boolean;
  storyIds?: readonly string[]; spaceId?: string;
}
export interface MapEdge {
  id: string; type: string; fromId: string; toId: string;
  endedAt?: string | null; status?: string | null;
  updatedAt?: string | null;
}
export interface MapInput {
  entities: readonly MapEntity[]; edges: readonly MapEdge[];
  /** A pre-filtered snapshot must identify its scope. Otherwise memberships filter it. */
  scope?: MapScope;
  warnings?: readonly string[];
  /** True only when the primary read completed the admitted task hierarchy. */
  taskHierarchyComplete?: boolean;
  /** Authoritative persisted town locations; storage/UI own expiry and permission filtering. */
  townPlacements?: readonly TownPlacement[];
}
export interface TownPlacement extends Point { entityId: string; actorId?: string; layer?: string }
export interface PlaceEnrichment {
  assetKey: string; label: string; badges: string[];
  mailbox: { count: number; approx?: boolean; basis?: 'messages' | 'unread' } | null;
  attention: number;
}
export type KindAdapter = (entity: Readonly<MapEntity>, context: { type: MapType; isRoot: boolean }) => Partial<PlaceEnrichment>;
export interface MapPlace extends Point, PlaceEnrichment {
  id: string; entityId: string; kind: string; title: string;
  parentId: string | null; depth: number; groupId: string;
  /** Building radius and diagnostic root-centred bounding-circle radius. Collision uses compoundBounds. */
  radius: number; footprint: number; compoundBounds: Bounds;
  status: string | null; progress: number | null; constructionStage: ConstructionStage;
  subtreeWeight?: number | null; sizeBucket?: number; estimateMissing?: boolean;
  cancelledAt?: string | null; rubbleExpiresAt?: number | null;
  /** Conservative removal deadline when the exact cancellation instant is unknown. */
  rubbleRemovalNotAfter?: number | null;
  workStatus: string | null; processState?: string | null; outcome?: string | null; endedKind?: string | null; role: 'entity' | 'shipped-marker';
}
export interface MapGroup {
  id: string; key: string; label: string; parentId: string | null; depth: number;
  bounds: Bounds; placeIds: string[]; proposed?: boolean;
}
export interface MapRoad {
  id: string; edgeId: string; type: 'depends_on'; fromId: string; toId: string;
  points: Point[];
}
export interface MapPath { id: string; points: Point[]; role: 'decorative-path' }
export interface MapRobot extends Point {
  id: string; claimId: string; sessionId: string; taskId: string;
  label: string; assetKey: string;
  pose: 'working' | 'waiting' | 'blocked' | 'idle' | 'attention';
}
export interface MapDecor extends Point {
  id: string; assetKey: string; label?: string; radius: number; role: 'decor';
}
export interface MapPortal extends Point {
  id: string; label: string; target: { type: MapType; scope: MapScope };
  entityId?: string; radius: number; assetKey: string;
}
export interface LayoutSlot extends Point { id: string; group: string; radius: number }
export interface LayoutContainerCache {
  /** Common hex pitch and cached shelf width; bounds reserve local status movement. */
  unit: number; columns: number; groupKeys: string[]; bounds?: Bounds;
  slots: Record<string, LayoutSlot>; vacant: LayoutSlot[]; next: Record<string, number>;
}
export interface LayoutCache { containers: Record<string, LayoutContainerCache> }
export interface MapModel {
  id: string; type: MapType; scope: MapScope;
  places: MapPlace[]; groups: MapGroup[]; roads: MapRoad[]; paths: MapPath[];
  robots: MapRobot[]; decor: MapDecor[]; portals: MapPortal[];
  bounds: Bounds; layout: LayoutCache; warnings: string[];
  /** Earliest authoritative rubble expiry. Event owner schedules a rebuild at this epoch-ms. */
  nextLifecycleAt?: number | null;
  /** Stable Town gate anchor and the single source of truth for waiting shipped entities. */
  shippingYard?: { position: Point; waitingIds: readonly string[] };
}
export interface BuildMapOptions {
  type: MapType; scope: MapScope; previous?: MapModel;
  adapters?: Readonly<Record<string, KindAdapter>>;
  /** Epoch-ms sampled once per build. Inject a clock value for replay and expiry tests. */
  now?: number;
}
/** React implementations can satisfy MapRenderer<ReactNode> without coupling the model to React. */
export interface MapRendererProps {
  model: MapModel; selectedEntityId?: string | null;
  onSelectEntity?: (entityId: string) => void;
  onEnterPortal?: (portal: MapPortal) => void;
}
export type MapRenderer<Result = unknown, Props extends MapRendererProps = MapRendererProps> = (props: Props) => Result;
