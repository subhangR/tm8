/**
 * `tm8 link add|login|list|audit` — space links from the HOME Space (W6/W7).
 *
 *   link list                      spaceLinks.list  (every Member, agents too)
 *   link add <target-space-id>     spaceLinks.add   (human sessions only)
 *   link login <alias|link-id>     spaceLinks.login (human sessions only)
 *   link audit <alias|link-id>     spaceLinks.audit (own rows; every row for a home admin)
 *
 * The writes are refused to agents by the Server (the handler guard and the
 * SQL gate); this file adds no check and no bypass, and renders the refusal
 * with the one thing an agent can do about it: ask its human.
 *
 * NO SECRET EVER REACHES STDOUT OR STDERR. The Server never returns the stored
 * link session, and the CLI journal samples stdout verbatim, so every value
 * this file prints — success and failure — first passes `scrubSecrets`: a
 * token-shaped string is replaced, never shortened into a longer hint.
 */
import type { SpaceLinkAuditEntry, SpaceLinkView } from '@tm8/contract';
import { requireSpace } from '../context.js';
import { clientFor, observedInvoke } from '../discovery/observe.js';
import { ApiError } from '../errors.js';
import { CliError, EXIT_OK, EXIT_USAGE, type ExitCode } from '../exit.js';
import { resolveMutationId } from '../mutation.js';
import type { CommandContext, CommandModule } from '../run.js';
import { matchLink } from '../space-link-route.js';
import { assertKnownOptions } from './entity.js';

export const REDACTED = '[redacted]';

/**
 * Token shapes: a tm8 prefix (`tm8s_`, `tm8c_`, …), a long base64url run, or a
 * long hex run. A UUID (hex groups of at most 12, hyphenated) is none of them.
 */
const TOKEN_SHAPES: readonly RegExp[] = [
  /tm8[a-z]{0,3}_[A-Za-z0-9_-]+/g,
  /[A-Za-z0-9_-]{40,}/g,
  /[0-9a-fA-F]{32,}/g,
];

export function scrubText(text: string): string {
  return TOKEN_SHAPES.reduce((acc, shape) => acc.replace(shape, REDACTED), text);
}

export function scrubSecrets<T>(value: T): T {
  if (typeof value === 'string') return scrubText(value) as T;
  if (Array.isArray(value)) return value.map((v) => scrubSecrets(v)) as T;
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrubSecrets(v)])) as T;
  }
  return value;
}

/** The same failure, with every message, hint and detail scrubbed. */
function scrubbedError(err: unknown, humanOnlyHint: boolean): unknown {
  if (err instanceof ApiError) {
    const next = new ApiError(
      err.status, err.code, scrubText(err.message), err.requestId, err.retryable,
      scrubSecrets(err.details), err.operation,
    );
    if (err.hint !== undefined) next.hint = scrubText(err.hint);
    if (humanOnlyHint && err.code === 'forbidden') {
      next.hint = 'space link writes are human-only: ask your human to run this `tm8 link` command';
    }
    return next;
  }
  if (err instanceof Error) err.message = scrubText(err.message);
  return err;
}

async function scrubbed(humanOnly: boolean, body: () => Promise<ExitCode>): Promise<ExitCode> {
  try {
    return await body();
  } catch (err) {
    throw scrubbedError(err, humanOnly);
  }
}

function requireArg(raw: string | undefined, command: string, placeholder: string): string {
  if (raw === undefined || raw.trim() === '') {
    throw new CliError(`\`tm8 ${command}\` requires ${placeholder}`, EXIT_USAGE, {
      hint: 'list this Space\'s links with `tm8 link list`',
    });
  }
  return raw.trim();
}

async function listLinks(cmd: CommandContext): Promise<SpaceLinkView[]> {
  return (
    (await observedInvoke<SpaceLinkView[]>(clientFor(cmd.ctx), 'spaceLinks.list', {
      params: { spaceId: requireSpace(cmd.ctx) },
    })) ?? []
  );
}

/** An alias, link id or target Space id on this Space's links → the link id. */
async function linkIdFor(cmd: CommandContext, ref: string): Promise<string> {
  const view = matchLink(await listLinks(cmd), ref);
  if (view) return view.id;
  throw new CliError(`no space link ${JSON.stringify(ref)} in this Space`, EXIT_USAGE, {
    hint: 'list this Space\'s links with `tm8 link list`; a human adds one with `tm8 link add`',
  });
}

function renderLink(v: SpaceLinkView): string {
  const mine = v.mine;
  const name = mine?.alias ? `${mine.alias} ` : '';
  const target = v.targetSpaceName ? `${v.targetSpaceName} (${v.targetSpaceId})` : v.targetSpaceId;
  const status = mine
    ? `${mine.status}${mine.expiresAt ? ` until ${mine.expiresAt}` : ''}; spawn ${mine.allowSpawn ? `on, budget ${mine.spawnBudget}` : 'off'}`
    : 'not signed in';
  return `${name}${v.id} → ${target}: ${status}`;
}

function renderAudit(rows: SpaceLinkAuditEntry[]): string {
  if (rows.length === 0) return 'no calls through this link';
  return rows
    .map((r) => `${r.createdAt}  ${r.result.padEnd(7)} ${r.op}${r.reason ? ` (${r.reason})` : ''}`)
    .join('\n');
}

async function linkList(cmd: CommandContext): Promise<ExitCode> {
  assertKnownOptions(cmd, []);
  return scrubbed(false, async () => {
    const views = scrubSecrets(await listLinks(cmd));
    cmd.out.data(views, (dto) => (dto.length === 0 ? 'no space links in this Space' : dto.map(renderLink).join('\n')));
    return EXIT_OK;
  });
}

async function linkAdd(cmd: CommandContext): Promise<ExitCode> {
  assertKnownOptions(cmd, ['alias', 'mutation-id']);
  const targetSpaceId = requireArg(cmd.args[0], 'link add', 'the <target-space-id> to link');
  return scrubbed(true, async () => {
    const alias = cmd.options.value('alias');
    const view = await observedInvoke<SpaceLinkView>(clientFor(cmd.ctx), 'spaceLinks.add', {
      params: { spaceId: requireSpace(cmd.ctx) },
      body: {
        targetSpaceId,
        ...(alias === undefined ? {} : { alias }),
        clientMutationId: resolveMutationId(cmd.options.value('mutation-id')),
      },
    });
    cmd.out.data(scrubSecrets(view), (dto) => `linked: ${renderLink(dto)}\nsign in with \`tm8 link login ${dto.mine?.alias ?? dto.id}\``);
    return EXIT_OK;
  });
}

async function linkLogin(cmd: CommandContext): Promise<ExitCode> {
  assertKnownOptions(cmd, ['mutation-id']);
  const ref = requireArg(cmd.args[0], 'link login', 'the <alias|link-id> to sign in to');
  return scrubbed(true, async () => {
    const view = await observedInvoke<SpaceLinkView>(clientFor(cmd.ctx), 'spaceLinks.login', {
      params: { linkId: await linkIdFor(cmd, ref) },
      body: { clientMutationId: resolveMutationId(cmd.options.value('mutation-id')) },
    });
    cmd.out.data(scrubSecrets(view), (dto) => `signed in: ${renderLink(dto)}`);
    return EXIT_OK;
  });
}

async function linkAudit(cmd: CommandContext): Promise<ExitCode> {
  assertKnownOptions(cmd, ['limit', 'before']);
  const ref = requireArg(cmd.args[0], 'link audit', 'the <alias|link-id> whose calls to read');
  return scrubbed(false, async () => {
    const limit = cmd.options.integer('limit');
    const before = cmd.options.value('before');
    const rows = await observedInvoke<SpaceLinkAuditEntry[]>(clientFor(cmd.ctx), 'spaceLinks.audit', {
      params: { linkId: await linkIdFor(cmd, ref) },
      query: {
        ...(limit === undefined ? {} : { limit: String(limit) }),
        ...(before === undefined ? {} : { before }),
      },
    });
    cmd.out.data(scrubSecrets(rows ?? []), renderAudit);
    return EXIT_OK;
  });
}

export const LINK_COMMANDS: CommandModule[] = [
  { path: ['link', 'list'], run: linkList },
  { path: ['link', 'add'], run: linkAdd },
  { path: ['link', 'login'], run: linkLogin },
  { path: ['link', 'audit'], run: linkAudit },
];
