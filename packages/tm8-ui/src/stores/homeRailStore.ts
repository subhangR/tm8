/**
 * homeRailStore — the Home icon rail's two remembered preferences (task
 * 01a0fb09 "Icon Rail Collapse").
 *
 * PINS are per SPACE: they name kinds, and a space can carry custom kinds
 * another space does not. The stored list REPLACES `DEFAULT_HOME_RAIL_PINS`
 * entirely — an empty list is a choice ("pin nothing"), not a missing value.
 *
 * GROUP OPEN STATE is per BROWSER: group ids are the spine's, the same in
 * every space. Only an explicit toggle is stored; a group with no entry
 * follows the ruled default (closed, unless it holds the list being viewed).
 *
 * Both round-trip localStorage the way `homeRegionStore` does: storage that
 * is absent, refused or holding junk reads as "no preference".
 */
import { DEFAULT_HOME_RAIL_PINS } from '../domain';

const pinsKey = (spaceId: string) => `tm8.home.rail-pins:${spaceId}`;
const OPEN_KEY = 'tm8.home.rail-open';

export function loadRailPins(spaceId: string): readonly string[] {
  try {
    const raw = window.localStorage.getItem(pinsKey(spaceId));
    if (raw === null) return DEFAULT_HOME_RAIL_PINS;
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.every((kind) => typeof kind === 'string')
      ? parsed
      : DEFAULT_HOME_RAIL_PINS;
  } catch {
    return DEFAULT_HOME_RAIL_PINS;
  }
}

export function rememberRailPins(spaceId: string, pins: readonly string[]): void {
  try {
    window.localStorage.setItem(pinsKey(spaceId), JSON.stringify(pins));
  } catch {
    // No storage ⇒ the pins last as long as the page. Still honoured.
  }
}

export type RailGroupOpenState = Readonly<Record<string, boolean>>;

export function loadRailGroupsOpen(): RailGroupOpenState {
  try {
    const raw = window.localStorage.getItem(OPEN_KEY);
    if (raw === null) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, boolean] => typeof entry[1] === 'boolean'),
    );
  } catch {
    return {};
  }
}

export function rememberRailGroupsOpen(state: RailGroupOpenState): void {
  try {
    window.localStorage.setItem(OPEN_KEY, JSON.stringify(state));
  } catch {
    // As above: unstored, still honoured for this page.
  }
}
