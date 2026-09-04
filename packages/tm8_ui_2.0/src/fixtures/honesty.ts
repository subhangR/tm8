import type { ActorSummary, EntityId, EntitySummary, Page } from '@tm8/contract';
import {
  channelDesign,
  commitFoundation,
  docLayoutSpec,
  messageAgentNullProvenance,
  messageInThread,
  prTransplant,
  sessionLive,
  taskGuideLines,
  taskUuidTitle,
} from './entities';

/**
 * DECISIONS.md D7 — three MEASURED backend gaps are day-one honesty states.
 * These fixtures carry the honest data shape (never an invented contract
 * field); the reason strings are the disabled-with-reason / hollow-value
 * copy source per the T1-4 honesty vocabulary. Status stays color + word.
 */

/**
 * D7.1 — Home activity, "load earlier" DISABLED-WITH-REASON.
 * The honest shape: `total` says more history exists, but there is no
 * cursor to fetch it — the spaces.home next-page token is defective and
 * the bridge models paging as capability-gated. UI renders the control
 * disabled with the reason, never hides it (charter R7 discipline).
 */
export const homeActivityPage: Page<EntitySummary> = {
  items: [messageInThread, taskUuidTitle, sessionLive],
  nextCursor: null,
  total: 57,
};

export const homeActivityLoadEarlierReason =
  'Earlier activity exists (57 events) but cannot be paged: the spaces.home next-page token is defective on this node — paging is capability-gated until the backend fix lands.';

/**
 * D7.2 — Presence is MEASURED-EMPTY on every node (dormant per charter R8).
 * The viewers footer and every presence affordance render hollow-value:
 * the shape is drawn, the value is honestly empty. Keys exist so the UI
 * has something to look up — the emptiness is the fixture.
 */
export const presenceViewersByEntity: Record<EntityId, ActorSummary[]> = {
  [channelDesign.id]: [],
  [taskUuidTitle.id]: [],
  [taskGuideLines.id]: [],
  [docLayoutSpec.id]: [],
};

export const presenceHollowReason =
  'Presence is dormant in this program: every node measures empty (charter R8). The affordance is real; the value is honestly none.';

/**
 * D7.3 — "from this session" provenance chips render HOLLOW.
 * authored_from is null through all public writes until backend step S2
 * lands (declared gap G2). Entities that will one day carry session
 * provenance map to null — the chip is drawn hollow with this reason.
 */
export const authoredFromSessionByEntity: Record<EntityId, EntityId | null> = {
  // the C-5 null-provenance flagship: agent-authored, chip expected, value null
  [messageAgentNullProvenance.id]: null,
  [messageInThread.id]: null,
  [commitFoundation.id]: null,
  [prTransplant.id]: null,
  [docLayoutSpec.id]: null,
};

export const authoredFromHollowReason =
  'Session provenance is not recorded yet: authored_from is null until backend S2 lands (gap G2).';
