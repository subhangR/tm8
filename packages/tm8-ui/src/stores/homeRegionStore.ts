/**
 * homeRegionStore — Home's remembered ROOT (task 01a006f8 D15, generalized
 * by task 01a00932; trimmed by its D1 ruling).
 *
 * ONE fact per space survives here: which population Home's left column
 * lists when the address does not say — `CHATS_ROOT` or a collection kind.
 * It round-trips localStorage because a root NAME cannot go stale, and it is
 * what keeps a bare `/home` link personal (R10: first visit opens on Chats,
 * remembered thereafter).
 *
 * EVERYTHING ELSE THIS STORE HELD MOVED TO THE ROUTE (D1, the LLD's central
 * reconciliation): region B's occupant is the centre trail (`p`, stack top
 * renders) and the drill-in is the right trail (`r`) — both `navStore`'s,
 * both in the URL, so a Home deep link reproduces the whole arrangement and
 * the back button walks it. The old `centers` map and the module-level
 * selection writes (GateApp's D11 spawn flip included) now go through
 * `navStore`; this module deliberately cannot express a selection at all.
 *
 * Legacy stored values from the tab era ('tasks', 'sessions') still resolve
 * to the kinds they meant.
 */
import {
  CHATS_ROOT,
  LEGACY_HOME_TAB_KINDS,
  isHomeRootKind,
  type HomeRoot,
} from '../domain';

export type { HomeRoot };

/** D15: the default root is Chats (R10 — land on the conversation surface). */
export const DEFAULT_HOME_ROOT: HomeRoot = CHATS_ROOT;

/* The key deliberately keeps the tab-era name: stored legacy values are
   readable and `normalizeHomeRoot` maps them forward. */
const storageKey = (spaceId: string) => `tm8.home.tab:${spaceId}`;

/** A stored or incoming root name → a root this build can list. */
export function normalizeHomeRoot(raw: string | null): HomeRoot {
  if (raw === CHATS_ROOT) return CHATS_ROOT;
  if (raw === null) return DEFAULT_HOME_ROOT;
  const mapped = LEGACY_HOME_TAB_KINDS[raw] ?? raw;
  return isHomeRootKind(mapped) ? mapped : DEFAULT_HOME_ROOT;
}

/** localStorage may be absent or refused (gate tests run without it). A read
 *  that throws or holds junk is the same as no preference: the default. */
export function loadHomeRoot(spaceId: string): HomeRoot {
  try {
    return normalizeHomeRoot(window.localStorage.getItem(storageKey(spaceId)));
  } catch {
    return DEFAULT_HOME_ROOT;
  }
}

export function rememberHomeRoot(spaceId: string, root: HomeRoot): void {
  try {
    window.localStorage.setItem(storageKey(spaceId), normalizeHomeRoot(root));
  } catch {
    // No storage ⇒ the choice lives in the address alone. Still a choice.
  }
}
