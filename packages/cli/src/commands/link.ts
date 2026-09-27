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
import { getOperation, isOperationName, type SpaceLinkAuditEntry, type SpaceLinkView } from '@tm8/contract';
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
 * Token shapes, judged against a whole RUN of the base64url alphabet: a tm8
 * prefix (`tm8s_`, `tm8c_`, …) anywhere in it, a long hex stretch, or a run of
 * 40+ that is not a name. The whole run is redacted, never a part: a random
 * secret with `tm8x_` in its middle must not keep its head visible. A UUID
 * (hex groups of at most 12, hyphenated, 36 long) is none of them.
 */
const RUN = /[A-Za-z0-9_-]+/g;
const TM8_PREFIX = /tm8[a-z]{0,3}_[A-Za-z0-9_-]/;
const LONG_HEX = /[0-9a-fA-F]{32,}/;

/**
 * A long alias or name: lowercase words joined by `-` or `_`, none longer than
 * 20. A random base64url run of 40+ is never all-lowercase with short words,
 * so this keeps `my-research-space-for-the-quarterly-review` and still
 * redacts a secret (the hex and tm8-prefix shapes apply regardless).
 */
const NAME_SHAPE = /^[a-z0-9]{1,20}(?:[-_][a-z0-9]{1,20})+$/;

/**
 * A word no name has: 8+ hex (a UUID's first group, any hex id) or 4+ hex
 * mixing digits and a-f (`a1b2`). `2026`, `dead` and `release` stay words.
 * One such word and the run is ids or a secret, not a name: two UUIDs joined
 * are 73 long and every group is short.
 */
const HEX_WORD = /^[0-9a-f]{8,}$|^(?=[0-9a-f]*[0-9])(?=[0-9a-f]*[a-f])[0-9a-f]{4,}$/;

function nameShaped(run: string): boolean {
  return NAME_SHAPE.test(run) && !run.split(/[-_]/).some((word) => HEX_WORD.test(word));
}

function tokenShaped(run: string): boolean {
  if (TM8_PREFIX.test(run) || LONG_HEX.test(run)) return true;
  return run.length >= 40 && !nameShaped(run);
}

export function scrubText(text: string): string {
  return text.replace(RUN, (run) => (tokenShaped(run) ? REDACTED : run));
}

export function scrubSecrets<T>(value: T): T {
  if (typeof value === 'string') return scrubText(value) as T;
  if (Array.isArray(value)) return value.map((v) => scrubSecrets(v)) as T;
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrubSecrets(v)])) as T;
  }
  return value;
}

/**
 * The refused op's catalog `humanOnly` flag: the door's own declaration, not a
 * per-command guess. A `forbidden` from `spaceLinks.list` while resolving an
 * alias for `link login` is not a human-only refusal and gets no such hint.
 */
function refusedAsHumanOnly(err: ApiError): boolean {
  return err.code === 'forbidden' && err.operation !== undefined
    && isOperationName(err.operation) && getOperation(err.operation).humanOnly === true;
}

/** The same failure, with every message, hint and detail scrubbed. */
function scrubbedError(err: unknown): unknown {
  if (err instanceof ApiError) {
    const next = new ApiError(
      err.status, err.code, scrubText(err.message), err.requestId, err.retryable,
      scrubSecrets(err.details), err.operation,
    );
    if (err.hint !== undefined) next.hint = scrubText(err.hint);
    if (refusedAsHumanOnly(err)) {
      next.hint = 'space link writes are human-only: ask your human to run this `tm8 link` command';
    }
    return next;
  }
  if (err instanceof Error) err.message = scrubText(err.message);
  return err;
}

async function scrubbed(body: () => Promise<ExitCode>): Promise<ExitCode> {
  try {
    return await body();
  } catch (err) {
    throw scrubbedError(err);
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
  return scrubbed(async () => {
    const views = scrubSecrets(await listLinks(cmd));
    cmd.out.data(views, (dto) => (dto.length === 0 ? 'no space links in this Space' : dto.map(renderLink).join('\n')));
    return EXIT_OK;
  });
}

async function linkAdd(cmd: CommandContext): Promise<ExitCode> {
  assertKnownOptions(cmd, ['alias', 'mutation-id']);
  const targetSpaceId = requireArg(cmd.args[0], 'link add', 'the <target-space-id> to link');
  return scrubbed(async () => {
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
  return scrubbed(async () => {
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
  return scrubbed(async () => {
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
