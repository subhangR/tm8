/**
 * PLACE → ASSET (story map W7). The one place a laid-out `Place` becomes a
 * kit asset: which type stands there, in which state, holding what count,
 * and where its DOM count badges go. Pure — no three.js, no React — so the
 * scenery, the badge layer and the tests all read the same answer.
 *
 * Semantics stay in the registry (`assets/registry.ts`): this file only
 * translates W1's `Place` fields into the registry's subjects. No kind
 * literal appears here; roles come from the layout (hub, portal, landmark
 * ids) and everything else is the registry's `ASSET_OF_KIND`.
 */
import type { StatusCategory } from '@tm8/contract';
import { assetMetrics } from './assets/prototypes';
import { assetStateOf, assetTypeOf, stateFor, type AssetRole, type AssetState, type AssetType, type StateSubject } from './assets/registry';
import { LANDMARK_OF_VIEW, type Place, type PlaceShape, type World } from './world';

/**
 * OWNER DECISION PENDING (plan doc 01a1090e: "half-built vs to-do district").
 * While it is open the half-built variant stays OFF: a task or story the
 * registry calls `planned` draws its built form in the `working` state, the
 * off-switch the asset lane documented. Flip to true once the owner confirms.
 */
export const HALF_BUILT_ENABLED = false;
/** The types whose `planned` cue is scaffolding — the ones the switch governs. */
const HALF_BUILT_TYPES: ReadonlySet<AssetType> = new Set<AssetType>(['task-workshop', 'story-keep']);

/** Roots stand a little larger than the places on their land, as before the kit. */
export const ROOT_SCALE = 1.1;

/** The container role a landmark shape plays. Landmarks are identified by id, never by shape alone. */
const LANDMARK_ROLE: Readonly<Partial<Record<PlaceShape, AssetRole>>> = { library: 'library', factory: 'codeFactory' };

export interface PlaceAsset {
  type: AssetType;
  state: AssetState;
  role: AssetRole;
  /** Members for containers, one run for a stele, else 0. */
  count: number;
  progress: number | null;
  scale: number;
}

/** The layout role of a place: the hub, a portal, one of the story's landmarks, or an ordinary node. */
export function roleOf(place: Place, world: Pick<World, 'hubId' | 'storyId'>): AssetRole {
  if (place.id === world.hubId) return 'hub';
  if (place.portal) return 'portal';
  for (const spec of Object.values(LANDMARK_OF_VIEW)) {
    if (place.id === `${world.storyId}:${spec.suffix}`) return LANDMARK_ROLE[spec.shape] ?? 'node';
  }
  return 'node';
}

/**
 * The registry's state subject for a place. `Place` carries a tone, not a
 * category, so the category is read back from the tone: W1 drops cancelled
 * work to a null tone, which is why a null tone with a status is `cancelled`
 * while a null tone without one (landmarks, portals without status) is
 * simply unknown. `waiting` is pending attention; nothing is guessed from a
 * status name.
 */
export function stateSubjectOf(place: Pick<Place, 'tone' | 'status' | 'pendingAttention' | 'hasWorker' | 'live'>): StateSubject {
  const statusCategory: StatusCategory | null =
    place.tone === 'done' ? 'done'
      : place.tone === 'working' ? 'in_progress'
        : place.tone === 'todo' || place.tone === 'blocked' ? 'to_do'
          : place.status !== null ? 'cancelled' : null;
  return {
    statusCategory,
    blocked: place.tone === 'blocked',
    waiting: (place.pendingAttention ?? 0) > 0,
    hasWorker: place.hasWorker || place.live,
  };
}

/** The state a type draws for a place, with the half-built switch applied. */
export function placeState(type: AssetType, subject: StateSubject): AssetState {
  const state = assetStateOf(subject);
  if (state === 'planned' && !HALF_BUILT_ENABLED && HALF_BUILT_TYPES.has(type)) return stateFor(type, 'working');
  return stateFor(type, state);
}

/**
 * A landmark (Library, Code factory) exists only while it holds members and
 * carries no status of its own: it stands built, `working` while any member
 * is live, else `done`. Everything else goes through the registry's subject.
 */
export function placeAsset(place: Place, world: Pick<World, 'hubId' | 'storyId'>): PlaceAsset {
  const role = roleOf(place, world);
  const type = assetTypeOf({ kind: place.kind, live: place.live, role });
  const landmark = role === 'library' || role === 'codeFactory';
  const state = landmark ? stateFor(type, place.live ? 'working' : 'done') : placeState(type, stateSubjectOf(place));
  const count = type === 'story-library' || type === 'story-code-factory' ? place.members.length : type === 'session-stele' ? 1 : 0;
  return { type, state, role, count, progress: place.progress, scale: place.root && place.ring > 0 ? ROOT_SCALE : 1 };
}

/* ------------------------------------------------------------------------- */
/* COUNT BADGES — numerals are DOM; geometry carries only pips.              */
/* ------------------------------------------------------------------------- */
export type BadgeKind = 'members' | 'library' | 'mailbox' | 'attention';

export interface PlaceBadge {
  id: string;
  placeId: string;
  /** The place's ring, so the overview can keep the same "roots only" rule as the name labels. */
  ring: number;
  kind: BadgeKind;
  /** World position of the label's centre. */
  x: number;
  y: number;
  z: number;
  count: number;
  /** The count came from a bounded window, not a server tally: shown as ≈. */
  approx: boolean;
}

/** Badge text: `≈` marks a bounded-window count. */
export const badgeText = (b: Pick<PlaceBadge, 'count' | 'approx'>): string => `${b.approx ? '≈' : ''}${b.count}`;

/**
 * Every count badge in the world, at the asset-provided anchors:
 *  - a container's member count at its own badge anchor;
 *  - a task's Library and Mailbox counts at the annex / mailbox badge anchors
 *    (the attachment socket plus that attachment's own anchor);
 *  - pending attention at the place's badge anchor (above the asset when it has none).
 * Nothing is invented: a count the page does not carry yields no badge.
 */
export function badgesOf(world: World): PlaceBadge[] {
  const out: PlaceBadge[] = [];
  for (const place of world.places) {
    const asset = placeAsset(place, world), metrics = assetMetrics(asset.type), s = asset.scale;
    const at = (kind: BadgeKind, x: number, y: number, z: number, count: number, approx = false) =>
      out.push({ id: `${place.id}/${kind}`, placeId: place.id, ring: place.ring, kind, x: place.x + x * s, y: y * s, z: place.z + z * s, count, approx });
    const own = metrics.badgeAnchor ?? { x: 0, y: metrics.height + .3, z: 0 };
    if (asset.count > 0 && (asset.type === 'story-library' || asset.type === 'story-code-factory')) at('members', own.x, own.y, own.z, asset.count);
    if (place.attachments && asset.type === 'task-workshop') {
      const { library, mailbox } = place.attachments;
      const left = metrics.attachments.taskLibrary, right = metrics.attachments.mailbox;
      const shelf = assetMetrics('task-library').badgeAnchor, box = assetMetrics('task-mailbox').badgeAnchor;
      if (library.count > 0 && left && shelf) at('library', left.x + shelf.x, shelf.y, left.z + shelf.z, library.count);
      if (mailbox.count > 0 && right && box) at('mailbox', right.x + box.x, box.y, right.z + box.z, mailbox.count, mailbox.approx);
    }
    if ((place.pendingAttention ?? 0) > 0) at('attention', own.x, own.y + (asset.count > 0 ? .45 : 0), own.z, place.pendingAttention!);
  }
  return out;
}
