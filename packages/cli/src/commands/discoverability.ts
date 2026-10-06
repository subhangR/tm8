/**
 * Lane L1 — the spellings agents reach for when they work across Spaces.
 *
 * Measured in live sessions: an agent that needed to act in another Space typed
 * `space-link`, `task create`, `teammate list` and `whoami`, got "unknown
 * command" or a retirement notice for each, and concluded the capability did
 * not exist. It does — as `link`, `entity create task`, `entity query --kind
 * team_member`, `identity get` and the global `--space <alias>` — so each of
 * these is SUGAR over a command that already exists. None adds a catalog
 * operation (the projection rows live in `discovery/operations.ts`
 * COMMAND_ALIASES), and every one delegates to the existing handler rather
 * than restating it, so the two spellings cannot drift.
 *
 * `whoami` was retired once in favour of `identity get`. It is back because
 * `identity get` answers "which account", and an agent asking `whoami` wants
 * "which session, which Space, as whom, with what access" — facts only the
 * CLI's own session context holds.
 */
import { requireSpace } from '../context.js';
import { CliError, EXIT_OK, EXIT_USAGE, type ExitCode } from '../exit.js';
import { readManifest, type Tm8Manifest } from '../manifest.js';
import { refuseMutationId } from '../mutation.js';
import { clientFor, observedInvoke } from '../discovery/observe.js';
import type { CommandContext, CommandModule } from '../run.js';
import { ENTITY_COMMANDS, assertKnownOptions, renderPage } from './entity.js';
import { LINK_COMMANDS } from './link.js';

/** The registered handler for `path`, found by path so the alias never forks it. */
function handlerOf(modules: readonly CommandModule[], path: readonly string[]): CommandModule['run'] {
  const found = modules.find((m) => m.path.join(' ') === path.join(' '));
  /* c8 ignore next — a missing target is a wiring bug, caught at import. */
  if (!found) throw new Error(`alias target not registered: ${path.join(' ')}`);
  return found.run;
}

const SPACE_LINK_COMMANDS: CommandModule[] = (['list', 'add', 'login', 'audit'] as const).map((verb) => ({
  path: ['space-link', verb],
  run: handlerOf(LINK_COMMANDS, ['link', verb]),
}));

const entityCreate = handlerOf(ENTITY_COMMANDS, ['entity', 'create']);

/** `tm8 task create <title> …` is `tm8 entity create task <title> …`, verbatim. */
function taskCreate(cmd: CommandContext): ReturnType<CommandModule['run']> {
  return entityCreate({ ...cmd, args: ['task', ...cmd.args] });
}

async function teammateList(cmd: CommandContext): Promise<ExitCode> {
  refuseMutationId('teammate list', cmd.options.value('mutation-id'));
  assertKnownOptions(cmd, ['limit', 'cursor']);
  if (cmd.args.length > 0) {
    throw new CliError('tm8 teammate list takes no positional arguments', EXIT_USAGE);
  }
  const body: Record<string, unknown> = { spaceId: requireSpace(cmd.ctx), kinds: ['team_member'] };
  const limit = cmd.options.integer('limit');
  if (limit !== undefined) body.limit = limit;
  const cursor = cmd.options.value('cursor');
  if (cursor !== undefined) body.cursor = cursor;
  const data = await observedInvoke<unknown>(clientFor(cmd.ctx), 'collections.query', { body });
  cmd.out.data(data, (dto) => {
    const page = (dto as { page?: unknown } | undefined)?.page;
    const text = renderPage(page);
    return text === 'no results' ? 'no teammates' : text;
  });
  return EXIT_OK;
}

interface WhoamiDto {
  sessionId: string | null;
  spaceId: string | null;
  actorId: string | null;
  teamMemberId: string | null;
  mode: string | null;
  accessMode: string | null;
  identity: unknown;
  /** How to act in another Space — the fact this command exists to surface. */
  crossSpace: string;
}

/** The manifest is a convenience here: a missing or broken one leaves fields null. */
function sessionManifest(env: NodeJS.ProcessEnv): Tm8Manifest | undefined {
  const path = env.TM8_MANIFEST_PATH?.trim();
  if (!path) return undefined;
  try {
    return readManifest(path);
  } catch {
    return undefined;
  }
}

const CROSS_SPACE_HINT =
  'act in a linked Space with `tm8 --space <alias> <command>`; `tm8 link list` names the aliases; ' +
  'an edge never crosses spaces: point from this Space at a linked entity with `tm8 entity ref add <entity-id> <target-entity-id> --link <alias>`';

function renderWhoami(dto: WhoamiDto): string {
  const id = (dto.identity ?? {}) as { username?: unknown; identityId?: unknown; actingAs?: unknown };
  const lines = [
    `session      ${dto.sessionId ?? '(none — not a tm8 session)'}`,
    `space        ${dto.spaceId ?? '(none)'}`,
    `actor        ${dto.actorId ?? (id.actingAs === undefined || id.actingAs === null ? '(none)' : String(id.actingAs))}`,
  ];
  if (dto.teamMemberId !== null && dto.teamMemberId !== dto.actorId) lines.push(`teammate     ${dto.teamMemberId}`);
  lines.push(`mode         ${dto.mode ?? '(none)'}`);
  lines.push(`access mode  ${dto.accessMode ?? '(unknown)'}`);
  if (id.identityId !== undefined) lines.push(`identity     ${String(id.username ?? '')}  ${String(id.identityId)}`.replace(/ {2,}/g, '  '));
  lines.push(dto.crossSpace);
  return lines.join('\n');
}

async function whoami(cmd: CommandContext, env: NodeJS.ProcessEnv = process.env): Promise<ExitCode> {
  refuseMutationId('whoami', cmd.options.value('mutation-id'));
  if (cmd.args.length > 0) throw new CliError('tm8 whoami takes no positional arguments', EXIT_USAGE);
  const manifest = sessionManifest(env);
  const identity = await observedInvoke<unknown>(clientFor(cmd.ctx), 'identity.get');
  const dto: WhoamiDto = {
    sessionId: cmd.ctx.sessionId ?? manifest?.sessionId ?? null,
    spaceId: cmd.ctx.space?.value ?? manifest?.spaceId ?? null,
    actorId: cmd.ctx.actor?.value ?? null,
    teamMemberId: env.TM8_TEAM_MEMBER_ID?.trim() || manifest?.agent?.teamMemberId || null,
    mode: env.TM8_MODE?.trim() || manifest?.mode || null,
    accessMode: manifest?.launch?.accessMode ?? null,
    identity,
    crossSpace: CROSS_SPACE_HINT,
  };
  cmd.out.data(dto, renderWhoami);
  return EXIT_OK;
}

export const DISCOVERABILITY_COMMANDS: CommandModule[] = [
  ...SPACE_LINK_COMMANDS,
  { path: ['task', 'create'], run: taskCreate },
  { path: ['teammate', 'list'], run: teammateList },
  { path: ['whoami'], run: (cmd) => whoami(cmd) },
];

/** For tests: `whoami` against an explicit environment. */
export const whoamiWithEnv = whoami;
