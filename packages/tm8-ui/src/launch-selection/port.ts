import type { LaunchDefaultsInput, LaunchDefaultsResult } from '@tm8/contract';

/**
 * `launch.defaults` — what a launch loads per selection group when nothing is
 * selected (design 01a0d348 §5.1, I9). The seam names it, the real ops call the
 * catalog row, the fixture answers from its own graph.
 */
export interface LaunchDefaultsPort {
  defaults(spaceId: string, input: LaunchDefaultsInput): Promise<LaunchDefaultsResult>;
}

/**
 * `launch.defaults` bound to one space — what a launch surface reads its
 * defaults through. Calling it asks the node and resolves with the node's
 * answer. `peek`, where the host caches answers per browser
 * (`data/launch-defaults-cache.ts`), returns the last answer for the same
 * input without I/O, so the card can draw it on its first frame while the
 * call confirms it. Absent: the surface has no cache and starts from loading.
 */
export type LoadLaunchDefaults = ((input: LaunchDefaultsInput) => Promise<LaunchDefaultsResult>) & {
  readonly peek?: (input: LaunchDefaultsInput) => LaunchDefaultsResult | null;
};
