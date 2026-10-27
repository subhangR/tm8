/**
 * `tm8 entity ref add|list|remove` — cross-space references (279, lane L3).
 *
 *   entity ref add <entity-id> <target-entity-id> --link <alias|link-id|space-id>
 *                                       entities.refs.add
 *   entity ref list <entity-id>         entities.refs.list
 *   entity ref remove <entity-id> <ref-id>
 *                                       entities.refs.remove
 *
 * An edge never crosses spaces; a reference is the cross-space pointer. It is
 * made through one of YOUR human's signed-in space links: `--link` names it
 * (alias, link id or the target Space id, as `tm8 link list` shows them). The
 * global `--space` would run the whole command inside the linked Space, so it
 * is refused for `entity ref add` (space-link-route.ts) with this hint.
 */
import type { CrossSpaceRef, CrossSpaceRefRemoved, SpaceLinkView } from '@tm8/contract';
import { clientFor, observedInvoke } from '../discovery/observe.js';
import { CliError, EXIT_OK, EXIT_USAGE, type ExitCode } from '../exit.js';
import { resolveMutationId } from '../mutation.js';
import type { CommandContext, CommandModule } from '../run.js';
import { matchLink } from '../space-link-route.js';
import { assertKnownOptions, requireArg, withActor } from './entity.js';

/** `--link`: an alias, link id or target Space id among this Space's links → what the Server resolves. */
async function linkRef(cmd: CommandContext, ref: string): Promise<string> {
  const space = cmd.ctx.space?.value;
  if (!space) return ref;
  const views = await observedInvoke<SpaceLinkView[]>(clientFor(cmd.ctx), 'spaceLinks.list', {
    params: { spaceId: space },
  });
  return matchLink(views ?? [], ref)?.id ?? ref;
}

export function renderRef(ref: CrossSpaceRef): string {
  const shown = ref.live ?? { kind: ref.kind, title: ref.titleSnapshot };
  const state = ref.live ? 'live' : 'snapshot';
  return `${ref.id}  ${shown.kind} "${shown.title}" → ${ref.targetEntityId} in space ${ref.targetSpaceId} (${state})`;
}

async function refAdd(cmd: CommandContext): Promise<ExitCode> {
  assertKnownOptions(cmd, ['link', 'mutation-id']);
  const id = requireArg(cmd, 0, '<entity-id>');
  const target = requireArg(cmd, 1, '<target-entity-id>');
  const link = cmd.options.value('link');
  if (link === undefined || link.trim() === '') {
    throw new CliError('`tm8 entity ref add` requires --link <alias|link-id|space-id>', EXIT_USAGE, {
      hint: 'list this Space\'s links with `tm8 link list`; a human adds one with `tm8 link add`',
    });
  }
  const data = await observedInvoke<CrossSpaceRef>(clientFor(cmd.ctx), 'entities.refs.add', {
    params: { id },
    body: withActor(cmd, {
      link: await linkRef(cmd, link.trim()),
      targetEntityId: target,
      clientMutationId: resolveMutationId(cmd.options.value('mutation-id')),
    }),
  });
  cmd.out.data(data, (dto) => `referenced: ${renderRef(dto)}`);
  return EXIT_OK;
}

async function refList(cmd: CommandContext): Promise<ExitCode> {
  assertKnownOptions(cmd, []);
  const id = requireArg(cmd, 0, '<entity-id>');
  const data = await observedInvoke<CrossSpaceRef[]>(clientFor(cmd.ctx), 'entities.refs.list', { params: { id } });
  cmd.out.data(data ?? [], (dto) => (dto.length === 0 ? 'no cross-space references' : dto.map(renderRef).join('\n')));
  return EXIT_OK;
}

async function refRemove(cmd: CommandContext): Promise<ExitCode> {
  assertKnownOptions(cmd, ['mutation-id']);
  const id = requireArg(cmd, 0, '<entity-id>');
  const refId = requireArg(cmd, 1, '<ref-id>');
  const data = await observedInvoke<CrossSpaceRefRemoved>(clientFor(cmd.ctx), 'entities.refs.remove', {
    params: { id, refId },
    body: withActor(cmd, { clientMutationId: resolveMutationId(cmd.options.value('mutation-id')) }),
  });
  cmd.out.data(data, (dto) => `removed reference ${dto.id}`);
  return EXIT_OK;
}

export const ENTITY_REF_COMMANDS: CommandModule[] = [
  { path: ['entity', 'ref', 'add'], run: refAdd },
  { path: ['entity', 'ref', 'list'], run: refList },
  { path: ['entity', 'ref', 'remove'], run: refRemove },
];
