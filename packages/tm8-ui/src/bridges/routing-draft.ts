import type { BridgePolicy, BridgeView, BridgeWake } from '@tm8/contract';
import { BRIDGE_PURPOSE_MAX, BRIDGE_STYLE_MAX } from '@tm8/contract';
import type { BridgePatch } from './api';

/*
 * The Routing tab's form, as data: a draft read off a view, and the patch that
 * turns the view into the draft. Pure, so the "what does Save send" question
 * is tested without a DOM, and Undo is the same function run the other way.
 */

export interface RoutingDraft {
  policy: Omit<BridgePolicy, 'style'>;
  style: string;
  purpose: string;
  quiet: { on: boolean; start: string; end: string };
  retention: { forever: boolean; days: number };
  workerPosting: boolean;
  workerWake: BridgeWake;
}

/** v1 Q2: DM bridges default to 90 days when retention is first set. */
const DEFAULT_RETENTION_DAYS = 90;

export function draftOf(view: BridgeView): RoutingDraft {
  const { style, ...policy } = view.policy;
  return {
    policy,
    style: style ?? '',
    purpose: view.purpose ?? '',
    quiet: { on: view.quietHours !== null, start: view.quietHours?.start ?? '22:00', end: view.quietHours?.end ?? '08:00' },
    retention: { forever: view.retentionDays === null, days: view.retentionDays ?? DEFAULT_RETENTION_DAYS },
    workerPosting: view.workerPosting,
    workerWake: view.workers.wake,
  };
}

const lineOrNull = (text: string) => (text.trim() === '' ? null : text.trim());

/** Why the draft cannot be saved, or null. The server re-checks every one. */
export function draftProblem(draft: RoutingDraft): string | null {
  if (draft.style.length > BRIDGE_STYLE_MAX) return `Style is at most ${BRIDGE_STYLE_MAX} characters.`;
  if (draft.purpose.length > BRIDGE_PURPOSE_MAX) return `Purpose is at most ${BRIDGE_PURPOSE_MAX} characters.`;
  if (/[\r\n]/.test(draft.style) || /[\r\n]/.test(draft.purpose)) return 'Style and purpose are one line each.';
  if (draft.quiet.on && draft.quiet.start === draft.quiet.end) return 'Quiet hours must start and end at different times.';
  if (!draft.retention.forever && (!Number.isInteger(draft.retention.days) || draft.retention.days < 1 || draft.retention.days > 3650)) {
    return 'Keep messages for 1 to 3650 days.';
  }
  return null;
}

/** The `bridges.update` patch from `view` to `draft`; null when nothing changed. */
export function patchOf(view: BridgeView, draft: RoutingDraft): BridgePatch | null {
  const patch: BridgePatch = {};
  const policy: Partial<BridgePolicy> = {};
  for (const key of Object.keys(draft.policy) as (keyof RoutingDraft['policy'])[]) {
    if (draft.policy[key] !== view.policy[key]) (policy as Record<string, unknown>)[key] = draft.policy[key];
  }
  const style = lineOrNull(draft.style);
  if (style !== view.policy.style) policy.style = style;
  if (Object.keys(policy).length > 0) patch.policy = policy;

  const purpose = lineOrNull(draft.purpose);
  if (purpose !== view.purpose) patch.purpose = purpose;

  const quiet = draft.quiet.on ? { start: draft.quiet.start, end: draft.quiet.end } : null;
  if (JSON.stringify(quiet) !== JSON.stringify(view.quietHours)) patch.quietHours = quiet;

  const retention = draft.retention.forever ? null : draft.retention.days;
  if (retention !== view.retentionDays) patch.retentionDays = retention;

  if (draft.workerPosting !== view.workerPosting) patch.workerPosting = draft.workerPosting;
  if (draft.workerWake !== view.workers.wake) patch.workerWake = draft.workerWake;

  return Object.keys(patch).length > 0 ? patch : null;
}
