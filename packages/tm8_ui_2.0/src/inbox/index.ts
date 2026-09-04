/**
 * `src/inbox/` — T3-7, the personal inbox behind the `inbox` rail row (menu
 * ref `inbox`, route `#/s/{space}/inbox`, chord `g i`).
 *
 * MOUNTABLE, NOT MOUNTED. Nothing here is wired into a screen: the coordinator
 * holds the wiring seat, and `HANDOVER.md` in this directory carries the exact
 * props and the exact call site (one branch in `GateApp`, beside the `graph`
 * and `dashboard` ones). Following `kit/`, `panels/`, `authoring/` and `home/`,
 * the stylesheet is imported by the barrel — a host that imports one symbol
 * cannot end up with a half-styled screen.
 */
import './inbox.css';

export { InboxScreen, type InboxScreenProps } from './InboxScreen';
export { useInboxData, type InboxData, type InboxSeamPort } from './useInboxData';
export {
  CLICK_THROUGH_CAPTION,
  INBOX_GROUP_LABEL,
  INBOX_GROUP_ORDER,
  NO_FILTERS,
  ROW_NOT_WIRED_REASON,
  SEND_AGAIN_REASON,
  TEAMMATE_AUDIENCE_REASON,
  applyFilters,
  buildGroups,
  emptyGroupsNote,
  filtersActive,
  groupOf,
  headlineOf,
  inboxEmptyNote,
  inboxRowOf,
  kindsPresent,
  recencyOf,
  unreadCount,
  type InboxFilters,
  type InboxGroup,
  type InboxGroupKey,
  type InboxRow,
} from './inbox-model';
