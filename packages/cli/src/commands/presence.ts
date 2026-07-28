/**
 * `tm8 presence get` — `presence.get`, `GET /v2/entities/:id/presence`.
 *
 * THIS ROW IS PER-NODE, AND THAT IS A DESIGNED PROPERTY RATHER THAN A GAP.
 * `presence.get` is CONDITIONALLY MOUNTED: a node with a presence source
 * answers a real `PresenceSnapshot`, and a node without one answers an honest
 * `501 not_implemented` in its own words — `operation presence.get is not
 * implemented on this node`. BOTH answers are correct, and which one a given
 * node gives is a MEASUREMENT, never something this file may assume.
 *
 * That distinction is the whole reason the 501 branch exists upstream: without
 * it, a client could not tell "nobody is viewing" from "we do not track
 * viewing". This command's duty is the same on both branches — render what the
 * node said faithfully, let the availability ledger learn from it, and hide
 * nothing. A CLI that smoothed a 501 into an empty snapshot would tell an
 * operator "nobody is here" when the truth is "this node cannot answer that",
 * and those are not the same sentence.
 *
 * NOTHING HERE PINS A BRANCH. An earlier version of this header stated flatly
 * that the node answers 501, which was true when written and stopped being
 * node-independent the moment the row became conditional. A verdict phrased
 * "presence.get answers 501" is unbound; a verdict phrased "this node answered
 * X, measured at time T" is not. Only the second kind is written down.
 *
 * A 501 IS PRE-VALIDATION. It is decided before any handler runs, so it
 * reserves no `clientMutationId` and applies nothing — which is exactly why
 * learning from it is free, and why there is no retry logic here that assumes
 * an id was consumed.
 *
 * PRESENCE IS EPHEMERAL AND NEVER DURABLE. `presence.changed` / `typing.changed`
 * are client-synthesized (DEV-4): they never ride the durable stream, are never
 * returned by `events.poll`, and their channel-local seq is NOT a durable
 * cursor. Nothing here caches a snapshot, and nothing here should: a stored
 * "who was present" is stale the instant it is written.
 */
import { CliError, EXIT_OK, EXIT_USAGE, type ExitCode } from '../exit.js';
import { refuseMutationId } from '../mutation.js';
import { clientFor, observedInvoke } from '../discovery/observe.js';
import type { CommandContext, CommandModule } from '../run.js';

async function presenceGet(cmd: CommandContext): Promise<ExitCode> {
  refuseMutationId('presence get', cmd.options.value('mutation-id'));

  const id = cmd.args[0];
  if (id === undefined || id === '') {
    throw new CliError('tm8 presence get requires an <entity-id>', EXIT_USAGE, {
      hint: 'tm8 presence get <entity-id>',
    });
  }

  const snapshot = await observedInvoke<unknown>(clientFor(cmd.ctx), 'presence.get', {
    params: { id },
  });

  cmd.out.data(snapshot, renderSnapshot);
  return EXIT_OK;
}

interface Viewer {
  id?: unknown;
  displayName?: unknown;
  kind?: unknown;
}

/**
 * Human renders the SAME `PresenceSnapshot` json emits. Actor IDs are kept, not
 * traded for display names: the id is what a follow-up command addresses, and a
 * display name is not unique.
 */
function renderSnapshot(dto: unknown): string {
  const snapshot = (dto ?? {}) as {
    viewers?: unknown;
    typingActorIds?: unknown;
    updatedAt?: unknown;
  };
  const viewers = Array.isArray(snapshot.viewers) ? (snapshot.viewers as Viewer[]) : [];
  const typing = Array.isArray(snapshot.typingActorIds)
    ? (snapshot.typingActorIds as unknown[]).map(String)
    : [];

  const lines: string[] = [];
  if (viewers.length === 0) {
    lines.push('viewers: no one is present');
  } else {
    lines.push(`viewers (${viewers.length}):`);
    for (const v of viewers) {
      lines.push(`  ${String(v.id ?? '?')}  ${String(v.displayName ?? '')}  ${String(v.kind ?? '')}`.trimEnd());
    }
  }
  lines.push(typing.length === 0 ? 'typing: no one' : `typing: ${typing.join(' ')}`);
  if (typeof snapshot.updatedAt === 'string') lines.push(`updatedAt: ${snapshot.updatedAt}`);
  return lines.join('\n');
}

export const PRESENCE_COMMANDS: CommandModule[] = [
  { path: ['presence', 'get'], run: presenceGet },
];
