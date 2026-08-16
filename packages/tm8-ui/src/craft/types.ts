/**
 * The shell bundle Craft's region C needs — the same four values every other
 * three-region screen takes (`HomeViewProps`, `ChannelViewProps`).
 *
 * OPTIONAL AS A GROUP, and that is the point. `CraftScreen` mounts without it
 * in the vitest suite and in the pixel harness, and a screen that demanded
 * `GateData` to render its chat and canvas would make those mounts impossible.
 * Absent the bundle, chips still press — they just have nowhere in Craft to
 * open, and the screen says so by rendering no column rather than an empty one.
 */
import type { GateData } from '../views/useGateData';
import type { DetailReasons } from '../panels';

export interface CraftPanelHostProps {
  data: GateData & { pull?: (id: string) => void };
  reasons: DetailReasons;
  serverBaseUrl?: string | undefined;
  viewerMemberId?: string | null | undefined;
  onNotice?: ((text: string) => void) | undefined;
}
