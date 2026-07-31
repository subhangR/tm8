/** Generic attention queue commands; creation stays on `entity attention`. */
import { CliError, EXIT_OK, EXIT_USAGE, type ExitCode } from '../exit.js';
import { resolveMutationId } from '../mutation.js';
import { clientFor, observedInvoke } from '../discovery/observe.js';
import type { CommandContext, CommandModule } from '../run.js';
import { assertKnownOptions, pageQuery, requireArg, summaryLine, withActor } from './entity.js';

const STATUSES = ['open', 'acknowledged', 'resolved', 'dismissed'] as const;

function renderAttentionPage(dto: unknown): string {
  const page = dto as { items?: unknown[]; nextCursor?: string | null };
  const lines = (page?.items ?? []).map((value) => {
    const row = value as { id?: unknown; entityId?: unknown; points?: unknown; status?: unknown; reason?: unknown };
    return `${String(row.id ?? '')}  ${String(row.status ?? '')}  ${String(row.points ?? '')}pt  ${String(row.entityId ?? '')}  ${String(row.reason ?? '')}`;
  });
  if (page?.nextCursor) lines.push(`next-cursor: ${page.nextCursor}`);
  return lines.length > 0 ? lines.join('\n') : 'no attention requests';
}

function renderMutation(dto: unknown): string {
  const result = dto as { request?: { id?: unknown; status?: unknown }; entity?: Parameters<typeof summaryLine>[0]; affectedCount?: unknown };
  const lines = [];
  if (result.request?.id) lines.push(`attention  ${String(result.request.id)}  ${String(result.request.status ?? '')}`);
  if (result.entity) lines.push(summaryLine(result.entity));
  lines.push(`affected: ${String(result.affectedCount ?? 0)}`);
  return lines.join('\n');
}

async function attentionList(cmd: CommandContext): Promise<ExitCode> {
  assertKnownOptions(cmd, ['entity', 'status', 'min-points', 'limit', 'cursor']);
  const status = cmd.options.value('status');
  if (status && !(STATUSES as readonly string[]).includes(status)) {
    throw new CliError(`invalid attention status: ${status}`, EXIT_USAGE);
  }
  const minPoints = cmd.options.integer('min-points');
  if (minPoints !== undefined && (minPoints < 1 || minPoints > 100)) {
    throw new CliError('--min-points expects an integer from 1 to 100', EXIT_USAGE);
  }
  const data = await observedInvoke<unknown>(clientFor(cmd.ctx), 'attentionRequests.list', {
    query: {
      spaceId: cmd.ctx.space?.value,
      entityId: cmd.options.value('entity'),
      status,
      ...(minPoints === undefined ? {} : { minPoints: String(minPoints) }),
      ...pageQuery(cmd),
    },
  });
  cmd.out.data(data, renderAttentionPage);
  return EXIT_OK;
}

async function attentionUpdate(cmd: CommandContext): Promise<ExitCode> {
  assertKnownOptions(cmd, ['expect-version', 'reason', 'points', 'status', 'note', 'mutation-id']);
  const requestId = requireArg(cmd, 0, '<attention-request-id>');
  const expectedVersion = cmd.options.integer('expect-version');
  if (expectedVersion === undefined) throw new CliError('attention update requires --expect-version <n>', EXIT_USAGE);
  const status = cmd.options.value('status');
  if (status && !(STATUSES as readonly string[]).includes(status)) {
    throw new CliError(`invalid attention status: ${status}`, EXIT_USAGE);
  }
  const points = cmd.options.integer('points');
  if (points !== undefined && (points < 1 || points > 100)) {
    throw new CliError('--points expects an integer from 1 to 100', EXIT_USAGE);
  }
  const body: Record<string, unknown> = {
    clientMutationId: resolveMutationId(cmd.options.value('mutation-id')),
    expectedVersion,
  };
  for (const [field, option] of [['reason', 'reason'], ['status', 'status'], ['resolutionNote', 'note']] as const) {
    const value = cmd.options.value(option);
    if (value !== undefined) body[field] = value;
  }
  if (points !== undefined) body.points = points;
  if (Object.keys(body).length === 2) throw new CliError('attention update needs a field to change', EXIT_USAGE);
  const data = await observedInvoke<unknown>(clientFor(cmd.ctx), 'attentionRequests.update', {
    params: { requestId }, body: withActor(cmd, body),
  });
  cmd.out.data(data, renderMutation);
  return EXIT_OK;
}

async function attentionResolveEntity(cmd: CommandContext): Promise<ExitCode> {
  assertKnownOptions(cmd, ['note', 'mutation-id']);
  const entityId = requireArg(cmd, 0, '<entity-id>');
  const body: Record<string, unknown> = { clientMutationId: resolveMutationId(cmd.options.value('mutation-id')) };
  const note = cmd.options.value('note');
  if (note !== undefined) body.resolutionNote = note;
  const data = await observedInvoke<unknown>(clientFor(cmd.ctx), 'attentionRequests.resolveEntity', {
    params: { entityId }, body: withActor(cmd, body),
  });
  cmd.out.data(data, renderMutation);
  return EXIT_OK;
}

export const ATTENTION_COMMANDS: CommandModule[] = [
  { path: ['attention', 'list'], run: attentionList },
  { path: ['attention', 'update'], run: attentionUpdate },
  { path: ['attention', 'resolve-entity'], run: attentionResolveEntity },
];
