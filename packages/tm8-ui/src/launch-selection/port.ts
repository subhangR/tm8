import type { LaunchDefaultsInput, LaunchDefaultsResult } from '@tm8/contract';

/**
 * `launch.defaults` — what a launch loads per selection group when nothing is
 * selected (design 01a0d348 §5.1, I9). The seam names it, the real ops call the
 * catalog row, the fixture answers from its own graph.
 */
export interface LaunchDefaultsPort {
  defaults(spaceId: string, input: LaunchDefaultsInput): Promise<LaunchDefaultsResult>;
}
