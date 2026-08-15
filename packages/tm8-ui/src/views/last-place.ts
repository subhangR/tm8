/**
 * LAST PLACE — which space this browser was in on a given node, and which view
 * it was looking at inside that space.
 *
 * THE DEFECT THIS FIXES. `useGateData`'s boot read did `setSpaceId(list[0].id)`
 * unconditionally, and `GateApp`'s `activeTarget` was a plain `useState` seeded
 * to the workspace. Both are thrown away on every remount — and `App.tsx`
 * REMOUNTS GateApp by `key={activeServer.id}` on every server switch. So going
 * remote and back landed you on the node's first space, in the workspace view,
 * no matter where you were. A round trip through a Server was destructive to
 * your place.
 *
 * KEYED BY NODE, because a space id from one node means nothing on another, and
 * the whole point is that each node remembers its own place. The target is kept
 * per space inside that record, so switching space A→B→A restores A's view
 * rather than whatever B happened to be showing.
 *
 * A REMEMBERED PLACE IS A PREFERENCE, NEVER AN ASSERTION. Every read is
 * validated by the caller against what the node actually returned — a space
 * that no longer exists falls back to the first one, exactly as before.
 */
import type { MenuTarget } from '../shell';

/** Bumped when the stored shape changes; a miss means the old value is ignored. */
const KEY_PREFIX = 'tm8.last-place.v1';

interface LastPlace {
  spaceId: string | null;
  targets: Record<string, MenuTarget>;
}

const EMPTY: LastPlace = { spaceId: null, targets: {} };

/**
 * Storage is guarded on READ as well as write: a disabled-storage policy throws
 * on `getItem`, and boot must not die for a convenience.
 */
function storage(): Storage | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage;
  } catch {
    return null;
  }
}

function isTarget(value: unknown): value is MenuTarget {
  if (typeof value !== 'object' || value === null) return false;
  const { type, ref, kind } = value as Record<string, unknown>;
  if (typeof ref !== 'string') return false;
  if (type === 'view' || type === 'kind') return true;
  return type === 'entity' && typeof kind === 'string';
}

function read(nodeKey: string): LastPlace {
  const store = storage();
  if (!store) return EMPTY;
  try {
    const raw = store.getItem(`${KEY_PREFIX}.${nodeKey}`);
    if (!raw) return EMPTY;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return EMPTY;
    const { spaceId, targets } = parsed as Record<string, unknown>;
    const kept: Record<string, MenuTarget> = {};
    if (typeof targets === 'object' && targets !== null) {
      for (const [space, target] of Object.entries(targets)) {
        if (isTarget(target)) kept[space] = target;
      }
    }
    return { spaceId: typeof spaceId === 'string' ? spaceId : null, targets: kept };
  } catch {
    return EMPTY;
  }
}

function write(nodeKey: string, place: LastPlace): void {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(`${KEY_PREFIX}.${nodeKey}`, JSON.stringify(place));
  } catch {
    // Quota or private mode. The choice still holds for this session; losing
    // the memory is not worth losing the navigation.
  }
}

/** The space this browser last had open on `nodeKey`, or null. */
export function readLastSpace(nodeKey: string): string | null {
  return read(nodeKey).spaceId;
}

export function writeLastSpace(nodeKey: string, spaceId: string): void {
  write(nodeKey, { ...read(nodeKey), spaceId });
}

/** The view last open inside `spaceId` on `nodeKey`, or null. */
export function readLastTarget(nodeKey: string, spaceId: string): MenuTarget | null {
  return read(nodeKey).targets[spaceId] ?? null;
}

export function writeLastTarget(nodeKey: string, spaceId: string, target: MenuTarget): void {
  const place = read(nodeKey);
  write(nodeKey, { ...place, targets: { ...place.targets, [spaceId]: target } });
}

/**
 * FORGET THIS NODE'S PLACE — the sign-out half of the record above.
 *
 * A remembered place is a preference of the VIEWER, not of the browser, and
 * this module could not tell the difference: the record outlives the pass, so
 * the next person to sign in on this machine was restored into the last space
 * and onto the last target of the person before them — and a target is
 * `{type:'entity', ref:<entity id>}`, so that restore names a specific entity.
 * Same class as the module-level stores `auth/session-reset.ts` clears, and
 * WORSE in one respect: this one survives a reload too.
 *
 * Per-node, because sign-out is per-server: leaving one node must not erase
 * where you were on another.
 */
export function clearLastPlace(nodeKey: string): void {
  const store = storage();
  if (!store) return;
  try {
    store.removeItem(`${KEY_PREFIX}.${nodeKey}`);
  } catch {
    // Same policy as every other access here: a browser that refuses storage
    // has nothing to forget.
  }
}
