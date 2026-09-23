import type { LaunchSuggestInput, LaunchSuggestResult } from '@tm8/contract';

/**
 * THE JEV PORT — `launch.suggest`, the launch UI's one door to Jev (design
 * 01a0cb80 §5.1, §7.5). Same shape as `SkillPort`: the seam names it, the real
 * ops call the catalog row, the fixture scripts answers.
 *
 * Jev only ADVISES. Nothing this port returns takes effect until a person
 * clicks Apply or ticks a box, and it is never called at spawn.
 */
export interface JevPort {
  suggest(spaceId: string, input: LaunchSuggestInput): Promise<LaunchSuggestResult>;
}
