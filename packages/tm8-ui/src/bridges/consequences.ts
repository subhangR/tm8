import { bridgeProviderLabel } from './bridge-marks';
import type { BridgeView } from '@tm8/contract';
import type { BridgePatch } from './api';
import { TARGET_WORD } from './format';

/*
 * BRIDGES-V2-DESIGN §1.5: a change that WIDENS who can do what, or deletes
 * data, shows its consequence in numbers and needs a second click. Narrowing
 * changes apply at once (with Undo). This module decides which is which and
 * writes the words; it never decides whether the server will accept the change.
 *
 * D45: computed from the facts `bridges.get` already answers, until the
 * server's dry run (`bridges.update --dry-run` → `consequences[]`) exists.
 */

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The consequences of `patch` on `view`, one sentence each. Empty means it narrows or is neutral: no confirm. */
export function consequencesOf(view: BridgeView, patch: BridgePatch): string[] {
  const out: string[] = [];
  const provider = bridgeProviderLabel(view.provider);
  const policy = patch.policy ?? {};
  const group = view.title;
  if (policy.whoMayTrigger === 'anyone' && view.policy.whoMayTrigger !== 'anyone') {
    const unlinked = Math.max(view.people.participants - view.people.linked, 0);
    out.push(
      `${plural(view.people.participants, 'person', 'people')} in ${group}, ${unlinked} of them not linked, will be able to `
      + 'start agents that run as this bridge\'s teammate and spend from the space\'s credits.',
    );
  }
  if (policy.trigger === 'every' && view.policy.trigger !== 'every') {
    out.push(`Every message in ${group} would start a turn on ${view.target.title}.`);
  }
  if (policy.outbound === 'all' && view.policy.outbound !== 'all') {
    out.push(`Everything posted in ${view.target.title} — including agents' working notes — will appear in ${provider}.`);
  }
  if (policy.direction === 'out' && view.policy.direction !== 'out') {
    out.push(`Nothing from ${group} will reach tm8; you won't see replies.`);
  }
  if (patch.workerWake === 'all' && view.workers.wake !== 'all') {
    out.push(`Workers listening on ${group} may wake on every message, not only the ones addressed to them.`);
  }
  if (patch.retentionDays !== undefined && patch.retentionDays !== null
      && (view.retentionDays === null || patch.retentionDays < view.retentionDays)) {
    out.push(
      `This deletes messages older than ${plural(patch.retentionDays, 'day', 'days')} from tm8. `
      + `Search and agents will no longer see them. ${provider} keeps its own copy.`,
    );
  }
  return out;
}

/** Moving the bridge (§1.5's *Move to another target*). Always confirmed. */
export function retargetConsequences(view: BridgeView, next: { title: string; kind: string }): string[] {
  return [
    `${view.target.title} (${TARGET_WORD[view.target.kind]}) stops getting ${view.title}.`,
    `${next.title} (${TARGET_WORD[next.kind as keyof typeof TARGET_WORD] ?? next.kind}) gets it from now on. Loops and memories move with the bridge.`,
    'Live workers keep their handles.',
  ];
}
