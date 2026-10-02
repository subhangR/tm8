/**
 * `tm8 request …` — op requests (lane L5, owner decision D5, migration 280).
 * An agent ASKS a human for an operation it may not do itself; the human
 * approves (the Server runs it as them) or denies.
 *
 *   request create <op> --justification <text> [--params <json>] [--input <json>]
 *                                         opRequests.create (any Member, agents too)
 *   request list [--status <s>] [--limit <n>]   opRequests.list
 *   request get <request-id>              opRequests.get
 *   request approve <request-id> [--note <text>]  opRequests.approve (human sessions only)
 *   request deny <request-id> [--note <text>]     opRequests.deny    (human sessions only)
 *
 * `<op>` must be on the contract's allow-list (OP_REQUESTABLE). This file
 * checks that locally so a typo exits 2 with the list, and the Server checks
 * it again. `--params` are the op's path params (`{"linkId": "…"}`); a
 * missing `spaceId` is this Space. `--input` is the op's own body without
 * `clientMutationId`, because the Server sets that to one value per request.
 */
import {
  OP_REQUEST_STATUSES,
  OP_REQUESTABLE,
  opRequestable,
  type OpRequestStatus,
  type OpRequestView,
} from '@tm8/contract';
import { readJsonSource } from '../args.js';
import { requireSpace } from '../context.js';
import { clientFor, observedInvoke } from '../discovery/observe.js';
import { ApiError } from '../errors.js';
import { CliError, EXIT_OK, EXIT_USAGE, type ExitCode } from '../exit.js';
import { resolveMutationId } from '../mutation.js';
import type { CommandContext, CommandModule } from '../run.js';
import { assertKnownOptions } from './entity.js';

interface OpRequestDecisionView {
  request: OpRequestView;
  notified: boolean;
  notifyError?: { code: string; message: string };
}

const REQUESTABLE_HINT = `requestable ops: ${OP_REQUESTABLE.map((e) => `${e.op} (${e.label})`).join(', ')}`;

function requireArg(raw: string | undefined, command: string, placeholder: string): string {
  if (raw === undefined || raw.trim() === '') {
    throw new CliError(`\`tm8 ${command}\` requires ${placeholder}`, EXIT_USAGE, {
      hint: 'list this Space\'s requests with `tm8 request list`',
    });
  }
  return raw.trim();
}

async function jsonObject(cmd: CommandContext, flag: string): Promise<Record<string, unknown> | undefined> {
  const raw = cmd.options.value(flag);
  if (raw === undefined) return undefined;
  const value = await readJsonSource(raw);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new CliError(`--${flag} must be a JSON object`, EXIT_USAGE);
  }
  return value as Record<string, unknown>;
}

function stringParams(params: Record<string, unknown> | undefined): Record<string, string> | undefined {
  if (params === undefined) return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(params)) {
    if (typeof value !== 'string') throw new CliError(`--params.${key} must be a string`, EXIT_USAGE);
    out[key] = value;
  }
  return out;
}

export function renderRequest(r: OpRequestView): string {
  const lines = [
    `${r.id}  ${r.status.toUpperCase()}  ${r.title}`,
    `  op: ${r.op}${Object.keys(r.params).length ? `  params: ${JSON.stringify(r.params)}` : ''}`,
    `  input: ${JSON.stringify(r.input)}`,
    `  why: ${r.justification}`,
    `  approver: ${r.approver === 'requester' ? 'the human this was filed for' : 'any human Member'}${r.canDecide ? ' (you can decide it)' : ''}`,
  ];
  if (r.decidedAt) lines.push(`  decided ${r.decidedAt}${r.decisionNote ? `: ${r.decisionNote}` : ''}`);
  if (r.error) lines.push(`  error: ${r.error.code}: ${r.error.message}`);
  if (r.status === 'succeeded' && r.result !== null && r.result !== undefined) lines.push(`  result: ${JSON.stringify(r.result)}`);
  return lines.join('\n');
}

function renderDecision(d: OpRequestDecisionView): string {
  const told = d.notified
    ? 'the requesting session was messaged'
    : d.notifyError
      ? `the requesting session was NOT messaged: ${d.notifyError.code}: ${d.notifyError.message}`
      : 'no session to message';
  return `${renderRequest(d.request)}\n${told}`;
}

/** A human-only refusal carries the one thing an agent can do: ask. */
function decisionHint(err: unknown): unknown {
  if (err instanceof ApiError && err.code === 'forbidden'
      && (err.details as { reason?: string } | undefined)?.reason === 'op_requests_human_only') {
    err.hint = 'only a human approves or denies: your human sees the request in their attention list';
  }
  return err;
}

async function requestCreate(cmd: CommandContext): Promise<ExitCode> {
  assertKnownOptions(cmd, ['justification', 'params', 'input', 'mutation-id']);
  const op = requireArg(cmd.args[0], 'request create', 'the <op> to request');
  if (!opRequestable(op)) {
    throw new CliError(`${op} cannot be requested`, EXIT_USAGE, { hint: REQUESTABLE_HINT });
  }
  const justification = cmd.options.value('justification');
  if (justification === undefined || justification.trim() === '') {
    throw new CliError('`tm8 request create` requires --justification <text>: say why you need it', EXIT_USAGE);
  }
  const params = stringParams(await jsonObject(cmd, 'params'));
  const input = await jsonObject(cmd, 'input');
  const view = await observedInvoke<OpRequestView>(clientFor(cmd.ctx), 'opRequests.create', {
    params: { spaceId: requireSpace(cmd.ctx) },
    body: {
      op,
      justification,
      ...(params ? { params } : {}),
      ...(input ? { input } : {}),
      clientMutationId: resolveMutationId(cmd.options.value('mutation-id')),
    },
  });
  cmd.out.data(view, (dto) =>
    `${renderRequest(dto)}\nfiled: a human approves or denies it; the outcome is messaged to this session`);
  return EXIT_OK;
}

async function requestList(cmd: CommandContext): Promise<ExitCode> {
  assertKnownOptions(cmd, ['status', 'limit']);
  const status = cmd.options.value('status');
  if (status !== undefined && !OP_REQUEST_STATUSES.includes(status as OpRequestStatus)) {
    throw new CliError(`--status must be one of ${OP_REQUEST_STATUSES.join(', ')}`, EXIT_USAGE);
  }
  const limit = cmd.options.integer('limit');
  const rows = await observedInvoke<OpRequestView[]>(clientFor(cmd.ctx), 'opRequests.list', {
    params: { spaceId: requireSpace(cmd.ctx) },
    query: {
      ...(status === undefined ? {} : { status }),
      ...(limit === undefined ? {} : { limit: String(limit) }),
    },
  });
  cmd.out.data(rows ?? [], (dto) => (dto.length === 0 ? 'no op requests in this Space' : dto.map(renderRequest).join('\n')));
  return EXIT_OK;
}

async function requestGet(cmd: CommandContext): Promise<ExitCode> {
  assertKnownOptions(cmd, []);
  const id = requireArg(cmd.args[0], 'request get', 'the <request-id>');
  const view = await observedInvoke<OpRequestView>(clientFor(cmd.ctx), 'opRequests.get', { params: { requestId: id } });
  cmd.out.data(view, renderRequest);
  return EXIT_OK;
}

function decide(verb: 'approve' | 'deny'): (cmd: CommandContext) => Promise<ExitCode> {
  return async (cmd) => {
    assertKnownOptions(cmd, ['note', 'mutation-id']);
    const id = requireArg(cmd.args[0], `request ${verb}`, 'the <request-id>');
    const note = cmd.options.value('note');
    try {
      const decision = await observedInvoke<OpRequestDecisionView>(
        clientFor(cmd.ctx), verb === 'approve' ? 'opRequests.approve' : 'opRequests.deny', {
          params: { requestId: id },
          body: {
            ...(note === undefined ? {} : { note }),
            clientMutationId: resolveMutationId(cmd.options.value('mutation-id')),
          },
        });
      cmd.out.data(decision, renderDecision);
      return EXIT_OK;
    } catch (err) {
      throw decisionHint(err);
    }
  };
}

export const REQUEST_COMMANDS: CommandModule[] = [
  { path: ['request', 'create'], run: requestCreate },
  { path: ['request', 'list'], run: requestList },
  { path: ['request', 'get'], run: requestGet },
  { path: ['request', 'approve'], run: decide('approve') },
  { path: ['request', 'deny'], run: decide('deny') },
];
