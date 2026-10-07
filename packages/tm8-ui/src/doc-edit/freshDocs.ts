/**
 * DOCS CREATED BY "NEW DOC" IN THIS WINDOW (New doc UX, 2026-10-06).
 *
 * New doc creates the record at once — "Untitled", no body — so the person
 * lands in an editor rather than a form. Two things follow from that, and
 * both are this registry's:
 *
 *  1. ARRIVAL. The first time the doc's surface mounts it opens in the
 *     editor with the caret in the title. `isFreshArrival` answers that
 *     once, so reopening the doc later reads it like any other.
 *  2. ABANDONMENT (Subhang, form round 2: "auto-delete it silently"). A doc
 *     that is still untitled and empty when its tab closes was never really
 *     made, and leaving it behind would litter every list with "Untitled".
 *     The editor reports emptiness as it changes (`noteFreshDocEmpty`); the
 *     workspace sweep deletes a doc that is still empty once no tab holds it.
 *
 * In memory on purpose: only a doc made in this window, by this person, is
 * ever a candidate. A reload forgets the set, and a doc nobody here created
 * is never deleted on anyone's behalf.
 */

export const FRESH_DOC_TITLE = 'Untitled';

interface FreshDoc {
  arrived: boolean;
  empty: boolean;
  /** The placeholder it was created with: still wearing it is still untitled. */
  title: string;
}

const fresh = new Map<string, FreshDoc>();

export function markFreshDoc(id: string, title: string = FRESH_DOC_TITLE): void {
  fresh.set(id, { arrived: false, empty: true, title });
}

/** The placeholder a fresh doc was created with (New doc's, or add-child's). */
export function freshDocTitle(id: string): string {
  return fresh.get(id)?.title ?? FRESH_DOC_TITLE;
}

/**
 * True until the fresh doc's surface has mounted once. A pure read, so a
 * render (or StrictMode's second render) can ask it; `noteFreshArrived` is
 * the effect that spends it.
 */
export function isFreshArrival(id: string): boolean {
  const doc = fresh.get(id);
  return doc !== undefined && !doc.arrived;
}

export function noteFreshArrived(id: string): void {
  const doc = fresh.get(id);
  if (doc) doc.arrived = true;
}

export function isFreshDoc(id: string): boolean {
  return fresh.has(id);
}

/** The editor's report: is the doc still an untitled, empty page? */
export function noteFreshDocEmpty(id: string, empty: boolean): void {
  const doc = fresh.get(id);
  if (doc) doc.empty = empty;
}

export function isEmptyDoc(title: string, body: string, createdTitle: string = FRESH_DOC_TITLE): boolean {
  const t = title.trim();
  return (t === '' || t === createdTitle) && body.trim() === '';
}

/** Fresh docs that are still empty — the sweep's candidates. */
export function emptyFreshDocIds(): string[] {
  return [...fresh].filter(([, doc]) => doc.empty).map(([id]) => id);
}

export function forgetFreshDoc(id: string): void {
  fresh.delete(id);
}
