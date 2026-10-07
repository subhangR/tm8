/**
 * RECORDS CREATED AT ONCE IN THIS WINDOW (New doc UX, 2026-10-06; every
 * `createInstant` kind since 2026-10-07). Named for the doc, where it began.
 *
 * New creates the record at once under its placeholder title, so the person
 * lands on it rather than on a form. Two things follow from that, and both
 * are this registry's:
 *
 *  1. ARRIVAL. The first time the record's surface mounts it opens ready to
 *     write: a doc in the editor with the caret in the title, any other kind
 *     with its title selected. `isFreshArrival` answers that once, so
 *     reopening it later reads it like any other.
 *  2. ABANDONMENT (Subhang, form round 2: "auto-delete it silently"). One
 *     still untitled and untouched when its tab closes was never really made,
 *     and leaving it behind would litter every list with "Untitled". The
 *     surface reports emptiness as it changes (`noteFreshDocEmpty`); the
 *     workspace sweep deletes one that is still empty once no tab holds it.
 *
 * In memory on purpose: only a record made in this window, by this person, is
 * ever a candidate. A reload forgets the set, and one nobody here created is
 * never deleted on anyone's behalf.
 */

export const FRESH_DOC_TITLE = 'Untitled';

interface FreshDoc {
  arrived: boolean;
  /**
   * The record's version when it arrived, for a surface that cannot report
   * every edit (a task's description, a story's roots). The sweep keeps any
   * record whose version has moved since. Null ⇒ the surface reports all of
   * its content through `noteFreshDocEmpty` (the doc editor).
   */
  version: number | null;
  empty: boolean;
  /** The placeholder it was created with: still wearing it is still untitled. */
  title: string;
}

const fresh = new Map<string, FreshDoc>();

export function markFreshDoc(id: string, title: string = FRESH_DOC_TITLE): void {
  fresh.set(id, { arrived: false, version: null, empty: true, title });
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

export function noteFreshArrived(id: string, version: number | null = null): void {
  const doc = fresh.get(id);
  if (doc && !doc.arrived) {
    doc.arrived = true;
    doc.version = version;
  }
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

/** Arrived records that are still empty — the sweep's candidates. */
export function emptyFreshDocs(): { id: string; version: number | null }[] {
  return [...fresh].filter(([, doc]) => doc.arrived && doc.empty).map(([id, doc]) => ({ id, version: doc.version }));
}

/** Still empty right now (false once forgotten, or once written in). */
export function isStillEmptyFreshDoc(id: string): boolean {
  return fresh.get(id)?.empty ?? false;
}

export function forgetFreshDoc(id: string): void {
  fresh.delete(id);
}
