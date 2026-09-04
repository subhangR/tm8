/**
 * The join journey — link → parked code → preview → redeem → membership.
 *
 * Closes the gap `docs/identity/MEMBER-ROLES-AND-INVITES.md` §6 left open:
 * everything under this had shipped (migration 118, both catalog ops, the seam
 * verbs, the CLI), and no route mounted any of it, so the only documented way
 * to accept an invite in a browser was to stop and use a terminal.
 */
export {
  PENDING_JOIN_KEY,
  capturePendingJoin,
  clearPendingJoin,
  maskCode,
  newJoinMutationId,
  peekPendingJoin,
  readJoinCode,
} from './pendingJoin';
export { JoinScreen, DEAD_WORD, refusalOf, type JoinScreenProps } from './JoinScreen';
export { JoinBanner, type JoinBannerProps } from './JoinBanner';
