/**
 * `tm8 interaction-profile propose|update|validate|preview|activate|retire` —
 * the Interaction Profile lifecycle (A13–A18).
 *
 * A profile is POLICY: prompt policy, tool discovery, feed shape, composer
 * behaviour. Nothing here decides any of it — the whole file is a projection of
 * six frozen DTOs onto six catalog rows, and the lifecycle order (propose →
 * update → validate → activate, with retire as the deletion analogue) is the
 * Server's, enforced by the Server.
 *
 * FOUR RULES THIS FILE EXISTS TO KEEP:
 *
 *  1. ACTIVATION SELECTS AN ARTIFACT, NOT A DRAFT. `--validated-version` names
 *     the exact recorded validated artifact and `--validation-hash` names its
 *     hash; together they are NOT an optimistic guard on the latest draft.
 *     Treating them as one would let a draft edited after validation be
 *     activated under a hash that describes different bytes, which is precisely
 *     what `profile_not_validated` exists to refuse.
 *  2. PREVIEW IS A READ. It carries a `profileVersion` and nothing else — no
 *     `clientMutationId`, because a read that reserved a mutation id would
 *     invite a caller to believe it was retryable in a way it is not.
 *  3. A17/A18 REQUIRE A HUMAN MEMBER OWNER/ADMIN PRINCIPAL, and this CLI cannot
 *     transmit any other. `ActivateInteractionProfileInput` and
 *     `RetireInteractionProfileInput` are `.strict()` and declare NO `actorId`,
 *     so an explicit `--as` cannot reach the Server to be refused there. The
 *     only alternatives are to DROP the caller's chosen author in silence —
 *     writing under an identity they did not select — or to refuse. This
 *     refuses, with the contract's own closed reason `profile_principal_required`
 *     and its own code (`forbidden`, exit 4). The same applies to a present
 *     agent token. This is a CLIENT-SIDE application of a CLOSED contract rule,
 *     not a CLI-invented authorization decision, and the asymmetry with
 *     `execution.spawn` is deliberate: spawn's DTO DOES carry `actorId`, so its
 *     `--interaction-profile` override is transmitted and adjudicated by the
 *     Server, exactly where an authorization decision belongs.
 *  4. THE GUARD FLAG IS DERIVED, NOT INVENTED. `RetireInteractionProfileInput`
 *     declares `expectedVersion`, and runtime introspection of the frozen zod
 *     schema confirms it is REQUIRED. So the capability is already frozen and
 *     omitting it was never an option — a body without it 400s every time and
 *     the operation is dead. What no authority fixes is the FLAG SPELLING, and
 *     the CLI flag surface belongs to this wave, so the flag is the kebab-case
 *     of the frozen field: `expectedVersion` -> `--expect-version`. Required in
 *     the schema means required here, refused locally rather than sent short —
 *     fabricating a version would lie to the very concurrency check the field
 *     exists for, and a hidden read-before-write would defeat it silently.
 *     `src/commands/teammate.ts` derives A19 and A20 the same way.
 */
import { readJsonSource } from '../args.js';
import { requireSpace } from '../context.js';
import { CliError, EXIT_FORBIDDEN, EXIT_OK, EXIT_USAGE, type ExitCode } from '../exit.js';
import { refuseMutationId, resolveMutationId } from '../mutation.js';
import { clientFor, observedInvoke } from '../discovery/observe.js';
import type { CommandContext, CommandModule } from '../run.js';

/**
 * The A17–A20 principal gate.
 *
 * Exported because `teammate.ts` carries the other half of the same rule and
 * one sentence about who may set a profile default must not exist twice.
 *
 * `--as` is checked as a FLAG only. A session-injected actor is the host saying
 * who this process is, not the caller selecting an author, and refusing it
 * would break every legitimate invocation inside a session.
 *
 * The diagnostic states a FACT and never an instruction: in a PTY, stderr and
 * stdout land in the same agent context, so a line written as a directive
 * becomes one. The token is never echoed.
 */
export function requireHumanPrincipal(command: string, cmd: CommandContext): void {
  const viaFlag = cmd.ctx.actor?.source === 'flag';
  if (!viaFlag && cmd.ctx.token === undefined) return;
  throw new CliError(
    `\`tm8 ${command}\` requires an authenticated human Member owner/admin principal: ` +
      `profile_principal_required (${viaFlag ? '--as selects a different author' : 'an agent token is present'})`,
    EXIT_FORBIDDEN,
    {
      hint: 'the frozen input DTO for this operation declares no author field, so the selection cannot be carried to the Server',
    },
  );
}

/**
 * A body for a DTO that declares no `actorId`. An explicit `--as` is refused
 * rather than dropped: silently discarding an author selection writes under an
 * identity the caller did not choose.
 */
function authorlessBody(command: string, cmd: CommandContext): Record<string, unknown> {
  if (cmd.ctx.actor?.source === 'flag') {
    throw new CliError(
      `\`tm8 ${command}\` takes no --as: its frozen DTO declares no author field`,
      EXIT_USAGE,
      { hint: 'the Server attributes this change to the calling identity' },
    );
  }
  return { clientMutationId: resolveMutationId(cmd.options.value('mutation-id')) };
}

function requireProfileId(command: string, raw: string | undefined): string {
  if (raw === undefined || raw.length === 0) {
    throw new CliError(`tm8 ${command} requires an <id>`, EXIT_USAGE, {
      hint: 'the Interaction Profile id `tm8 interaction-profile propose` printed',
    });
  }
  return raw;
}

/** A required integer option, named so the diagnostic quotes the caller's flag. */
function requireInteger(cmd: CommandContext, flag: string): number {
  const value = cmd.options.integer(flag);
  if (value === undefined) {
    throw new CliError(`--${flag} <n> is required`, EXIT_USAGE);
  }
  return value;
}

/** §7.5: a destructive or irreversible step is never inferred. */
function requireConfirmation(command: string, cmd: CommandContext): void {
  if (!cmd.options.bool('yes')) {
    throw new CliError(`tm8 ${command} requires --yes`, EXIT_USAGE);
  }
}

/** `--data <json-source>` carries the DRAFT, which is an object. */
async function readDraft(cmd: CommandContext): Promise<Record<string, unknown>> {
  const source = cmd.options.value('data');
  if (source === undefined) {
    throw new CliError('--data <json-source> is required', EXIT_USAGE, {
      hint: '--data @profile.json, --data - to read stdin, or inline JSON',
    });
  }
  const parsed = await readJsonSource(source);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new CliError('--data expects a JSON object describing the profile draft', EXIT_USAGE);
  }
  return parsed as Record<string, unknown>;
}

// ── A13 propose ─────────────────────────────────────────────────────────────

async function profilePropose(cmd: CommandContext): Promise<ExitCode> {
  const spaceId = requireSpace(cmd.ctx);
  const body = authorlessBody('interaction-profile propose', cmd);
  body.spaceId = spaceId;
  body.draft = await readDraft(cmd);

  const data = await observedInvoke<unknown>(clientFor(cmd.ctx), 'interactionProfiles.propose', {
    params: { spaceId },
    body,
  });
  cmd.out.data(data, renderProfile);
  return EXIT_OK;
}

// ── A14 update draft ────────────────────────────────────────────────────────

async function profileUpdate(cmd: CommandContext): Promise<ExitCode> {
  const profileId = requireProfileId('interaction-profile update', cmd.args[0]);
  const body = authorlessBody('interaction-profile update', cmd);
  body.expectedVersion = requireInteger(cmd, 'expect-version');
  body.draft = await readDraft(cmd);

  const data = await observedInvoke<unknown>(clientFor(cmd.ctx), 'interactionProfiles.updateDraft', {
    params: { profileId },
    body,
  });
  cmd.out.data(data, renderProfile);
  return EXIT_OK;
}

// ── A15 validate ────────────────────────────────────────────────────────────

async function profileValidate(cmd: CommandContext): Promise<ExitCode> {
  const profileId = requireProfileId('interaction-profile validate', cmd.args[0]);
  const body = authorlessBody('interaction-profile validate', cmd);
  body.expectedVersion = requireInteger(cmd, 'expect-version');

  const data = await observedInvoke<unknown>(clientFor(cmd.ctx), 'interactionProfiles.validate', {
    params: { profileId },
    body,
  });
  cmd.out.data(data, renderValidation);
  return EXIT_OK;
}

// ── A16 preview — a READ that happens to POST ──────────────────────────────

/**
 * `--version <n>` WAS UNREACHABLE HERE, AND NO LONGER IS. Recorded because the
 * history explains the shape of this command.
 *
 * `version` sat on the global boolean allowlist, so `parseInvocation` stripped
 * it into `globals.version` in EVERY position and `run()` checks that first.
 * The published A16 invocation `tm8 interaction-profile preview <id> --version
 * <n>` therefore printed the CLI VERSION and exited 0 having previewed
 * nothing — a confident wrong answer with a success code, which is the one
 * failure downstream cannot detect. Measured on the built binary at the time:
 * `kind list --version 3` -> `0.1.0`, exit 0.
 *
 * The kernel slot that owns `src/args.ts` has since fixed it with a positional
 * rule — a name that is both a global and a per-command flag is the GLOBAL only
 * before the first command token and belongs to the COMMAND from there on — so
 * this command now receives its guard normally. Nothing here worked around it
 * while it was broken and nothing here needs to now; the only thing this file
 * ever did was refuse to invent a second spelling and say so.
 */
async function profilePreview(cmd: CommandContext): Promise<ExitCode> {
  refuseMutationId('interaction-profile preview', cmd.options.value('mutation-id'));
  const profileId = requireProfileId('interaction-profile preview', cmd.args[0]);
  const profileVersion = cmd.options.integer('version');
  if (profileVersion === undefined) {
    throw new CliError('tm8 interaction-profile preview requires --version <n>', EXIT_USAGE, {
      hint: 'the profile version to preview; `--version` before the command is the CLI version instead',
    });
  }

  const data = await observedInvoke<unknown>(clientFor(cmd.ctx), 'interactionProfiles.preview', {
    params: { profileId },
    body: { profileVersion },
  });
  cmd.out.data(data, renderPreview);
  return EXIT_OK;
}

// ── A17 activate ────────────────────────────────────────────────────────────

async function profileActivate(cmd: CommandContext): Promise<ExitCode> {
  const profileId = requireProfileId('interaction-profile activate', cmd.args[0]);
  requireHumanPrincipal('interaction-profile activate', cmd);
  const validatedVersion = requireInteger(cmd, 'validated-version');
  const validatedHash = cmd.options.value('validation-hash');
  if (validatedHash === undefined) {
    throw new CliError('--validation-hash <hash> is required', EXIT_USAGE, {
      hint: '`tm8 interaction-profile validate` recorded the hash this must match',
    });
  }
  requireConfirmation('interaction-profile activate', cmd);

  const body = authorlessBody('interaction-profile activate', cmd);
  // Version AND hash together select one immutable validated artifact. Neither
  // is an optimistic guard on the current draft.
  body.validatedVersion = validatedVersion;
  body.validatedHash = validatedHash;
  body.confirm = true;

  const data = await observedInvoke<unknown>(clientFor(cmd.ctx), 'interactionProfiles.activate', {
    params: { profileId },
    body,
  });
  cmd.out.data(data, renderProfile);
  return EXIT_OK;
}

// ── A18 retire ──────────────────────────────────────────────────────────────

async function profileRetire(cmd: CommandContext): Promise<ExitCode> {
  const profileId = requireProfileId('interaction-profile retire', cmd.args[0]);
  requireHumanPrincipal('interaction-profile retire', cmd);
  requireConfirmation('interaction-profile retire', cmd);

  const body = authorlessBody('interaction-profile retire', cmd);
  // See rule 4 in the file header. `expectedVersion` is REQUIRED by the frozen
  // schema, so it is required here; the flag spelling is the kebab-case of the
  // field itself.
  body.expectedVersion = requireInteger(cmd, 'expect-version');
  body.confirm = true;

  const data = await observedInvoke<unknown>(clientFor(cmd.ctx), 'interactionProfiles.retire', {
    params: { profileId },
    body,
  });
  cmd.out.data(data, renderProfile);
  return EXIT_OK;
}

// ── human renderings — the SAME DTO `--format json` emits ───────────────────

function field(dto: unknown, key: string): string | undefined {
  if (dto === null || typeof dto !== 'object') return undefined;
  const value = (dto as Record<string, unknown>)[key];
  return value === undefined || value === null ? undefined : String(value);
}

/** The profile id is what every follow-up command needs; it is never dropped. */
function renderProfile(dto: unknown): string {
  const id = field(dto, 'profileId');
  if (id === undefined) return JSON.stringify(dto);
  const parts = [id, field(dto, 'status') ?? ''];
  const draft = field(dto, 'currentDraftVersion');
  const active = field(dto, 'activeVersion');
  if (draft !== undefined) parts.push(`draft v${draft}`);
  if (active !== undefined) parts.push(`active v${active}`);
  return parts.filter(Boolean).join('  ');
}

function renderValidation(dto: unknown): string {
  const id = field(dto, 'profileId');
  if (id === undefined) return JSON.stringify(dto);
  const issues = (dto as { issues?: unknown }).issues;
  const count = Array.isArray(issues) ? issues.length : 0;
  // The hash is what `interaction-profile activate` must be given, so it stays.
  return [
    id,
    `v${field(dto, 'profileVersion') ?? '?'}`,
    field(dto, 'status') ?? '',
    field(dto, 'validatedHash') ?? '',
    `${count} issue${count === 1 ? '' : 's'}`,
  ].filter(Boolean).join('  ');
}

function renderPreview(dto: unknown): string {
  const id = field(dto, 'profileId');
  if (id === undefined) return JSON.stringify(dto);
  return [
    id,
    `v${field(dto, 'profileVersion') ?? '?'}`,
    field(dto, 'name') ?? '',
    `${field(dto, 'templateKey') ?? ''}@${field(dto, 'templateVersion') ?? '?'}`,
  ].filter(Boolean).join('  ');
}

export const INTERACTION_PROFILE_COMMANDS: CommandModule[] = [
  { path: ['interaction-profile', 'propose'], run: profilePropose },
  { path: ['interaction-profile', 'update'], run: profileUpdate },
  { path: ['interaction-profile', 'validate'], run: profileValidate },
  { path: ['interaction-profile', 'preview'], run: profilePreview },
  { path: ['interaction-profile', 'activate'], run: profileActivate },
  { path: ['interaction-profile', 'retire'], run: profileRetire },
];
