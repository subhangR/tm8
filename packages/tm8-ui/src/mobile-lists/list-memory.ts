/**
 * WHERE YOU WERE IN A PHONE LIST, kept across the push to an entity and back.
 *
 * On the phone the list UNMOUNTS while an entity is open (EntityView renders
 * one surface, and a hidden list would keep polling behind the screen being
 * read). So scroll position cannot live in the DOM or in component state: it
 * has to be state that survives an unmount, which is what CONTRACT §5 asks
 * for ("the pop path must restore it explicitly"). Module scope, keyed by
 * space and kind: a reload starts at the top, which is the honest answer for
 * a list that will be re-read anyway.
 */
export interface ListPlace {
  scrollTop: number;
  /** The row that pushed the open entity — focus returns here on pop. */
  openedId: string | null;
  query: string;
  expanded: readonly string[];
}

const places = new Map<string, ListPlace>();

export const placeKey = (spaceId: string, kind: string): string => `${spaceId}\u0000${kind}`;

export function readPlace(key: string): ListPlace | undefined {
  return places.get(key);
}

export function writePlace(key: string, place: ListPlace): void {
  places.set(key, place);
}

/**
 * Was this entity opened by a tap in its list? Only then does the entity
 * screen slide in from the right — a cold arrival from a pasted link has
 * nothing to slide in over.
 */
export function openedFromList(spaceId: string, kind: string, id: string): boolean {
  return places.get(placeKey(spaceId, kind))?.openedId === id;
}

/** Test seam. */
export function forgetPlaces(): void {
  places.clear();
}
