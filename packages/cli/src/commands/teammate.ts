/**
 * The two profile-DEFAULT commands — A19 `teammate interaction-profile
 * set-default` and A20 `space interaction-profile set-default`.
 *
 * WHY A20 LIVES HERE AND NOT IN THE `space` MODULE — SEAM RULING S3.
 * A20 sits under the `space` noun, which another slot owns. It is registered
 * here anyway, and that slot is barred from registering it. A noun is not the
 * ownership unit; a MODULE is. These two rows are one symmetric pair governed
 * by ONE principal rule, and splitting them across two modules is exactly the
 * drift module ownership exists to prevent — the two halves would answer
 * differently the first time either was touched. The failure mode is also
 * asymmetric: `registry.ts` throws on a duplicate path at IMPORT, so a double
 * registration does not fail one test, it collapses every slot's suite at once.
 * `test/interaction-profile.test.ts` asserts the row appears in exactly one of
 * the two exported arrays.
 *
 * A HUMAN MEMBER OWNER/ADMIN PRINCIPAL IS REQUIRED, AND THE CLI CANNOT
 * TRANSMIT ANY OTHER. `SetTeammateProfileDefaultInput` and
 * `SetSpaceProfileDefaultInput` are `.strict()` and declare NO `actorId`, so an
 * explicit `--as` cannot reach the Server to be refused there. Dropping the
 * selection silently would write under an author the caller did not choose, so
 * it is refused here with the contract's own closed reason —
 * `profile_principal_required`, code `forbidden`, exit 4. The rule is
 * implemented once, in `interaction-profile.ts`, and imported: one sentence
 * about who may set a profile default must not exist twice.
 *
 * THE GUARD FLAGS ARE DERIVED, NOT INVENTED. `SetTeammateProfileDefaultInput`
 * declares `expectedVersion` and `SetSpaceProfileDefaultInput` declares
 * `expectedSettingsRevision`; runtime introspection of the frozen zod schemas
 * confirms BOTH are REQUIRED, not optional. The capability is therefore already
 * frozen and adopted, and omitting it is not an option — a body without it
 * 400s every time and the operation is simply dead. What no authority fixes is
 * the FLAG SPELLING, and the CLI flag surface is this wave's own. So each flag
 * is the kebab-case of the frozen field, dropping nothing:
 *
 *     expectedVersion           ->  --expect-version
 *     expectedSettingsRevision  ->  --expect-settings-revision
 *
 * Deterministic and reviewable against the schema by anyone. Required in the
 * schema means required here.
 *
 * `--confirm-agent-generated` IS IMPLEMENTED, ON A20 ONLY, AND IT IS NOT `--yes`.
 *
 * An earlier version of this comment said the flag was deliberately unimplemented
 * "because the frozen parser's boolean allowlist does not contain it". THAT
 * PREMISE EXPIRED: `args.ts` carries the name on the boolean allowlist today, so
 * the flag parses and no longer swallows the following token. The reason was
 * left standing after the thing it described had changed, which is why the flag
 * reached the OptionBag and stopped there — parsed by the kernel, read by
 * nobody, and dropped with exit 0 on a command that then failed anyway.
 *
 * A20 ONLY, because that is where the field exists. `SetSpaceProfileDefaultInput`
 * declares `confirmAgentGenerated`; `SetTeammateProfileDefaultInput` does NOT,
 * and both are `.strict()` — so sending it on A19 would be a self-inflicted
 * `invalid_input` rather than a symmetry.
 *
 * IT IS A SECOND FLAG AND MUST STAY ONE. `--yes` is §7.5's destructive
 * confirmation and every caller of this command already passes it. Deriving
 * `confirmAgentGenerated` from it would assert generator provenance on behalf of
 * every caller who never made that assertion — which is not wiring the guard up,
 * it is deleting it while appearing to. The dossier requires the confirmation
 * for a profile carrying generator provenance specifically; the two flags say
 * different sentences and are sent from different inputs.
 *
 * SENT ONLY WHEN ASKED. The field is `z.literal(true).optional()`, so there is no
 * `false` to send: absent means the caller did not confirm, and a fabricated
 * `false` would be this CLI answering a question on the caller's behalf.
 *
 * There is deliberately no `tm8 teammate create|list|get` here: the catalog's
 * `teamMembers` family has exactly ONE row, this one.
 */
import { requireSpace } from '../context.js';
import { CliError, EXIT_OK, EXIT_USAGE, type ExitCode } from '../exit.js';
import { resolveMutationId } from '../mutation.js';
import { clientFor, observedInvoke } from '../discovery/observe.js';
import { requireHumanPrincipal } from './interaction-profile.js';
import type { CommandContext, CommandModule } from '../run.js';

function requireArg(command: string, raw: string | undefined, what: string): string {
  if (raw === undefined || raw.length === 0) {
    throw new CliError(`tm8 ${command} requires ${what}`, EXIT_USAGE);
  }
  return raw;
}

/**
 * §4's `|none` idiom: the literal `none` is the explicit "no default" state,
 * which is a REAL value here rather than an omission — clearing a default and
 * failing to set one are different outcomes and the DTO spells the first as
 * `null`.
 */
function targetProfile(raw: string): string | null {
  return raw === 'none' ? null : raw;
}

function requireConfirmation(command: string, cmd: CommandContext): void {
  if (!cmd.options.bool('yes')) {
    throw new CliError(`tm8 ${command} requires --yes`, EXIT_USAGE);
  }
}

/**
 * A guard the frozen schema marks REQUIRED, so the flag is required too.
 *
 * Refused LOCALLY rather than sent short: a body missing a required guard is a
 * guaranteed `invalid_input`, and the alternatives are worse than a usage
 * error. Fabricating a revision would lie to the very optimistic-concurrency
 * check the field exists for, and a hidden read-before-write would defeat it
 * silently — the caller would believe they had guarded a write they had not.
 */
function requireGuard(cmd: CommandContext, flag: string): number {
  const value = cmd.options.integer(flag);
  if (value === undefined) {
    throw new CliError(`--${flag} <n> is required`, EXIT_USAGE, {
      hint: 'the frozen input schema marks this guard required; read the current value first',
    });
  }
  return value;
}

// ── A19 — the Teammate default ──────────────────────────────────────────────

async function teammateSetDefault(cmd: CommandContext): Promise<ExitCode> {
  const command = 'teammate interaction-profile set-default';
  const teamMemberId = requireArg(command, cmd.args[0], 'a <team-member-id>');
  const target = requireArg(command, cmd.args[1], 'an <interaction-profile-id|none>');
  requireHumanPrincipal(command, cmd);
  requireConfirmation(command, cmd);

  const data = await observedInvoke<unknown>(
    clientFor(cmd.ctx),
    'teamMembers.interactionProfile.setDefault',
    {
      params: { teamMemberId },
      body: {
        clientMutationId: resolveMutationId(cmd.options.value('mutation-id')),
        expectedVersion: requireGuard(cmd, 'expect-version'),
        profileId: targetProfile(target),
      },
    },
  );
  cmd.out.data(data, renderTeammateDefault);
  return EXIT_OK;
}

// ── A20 — the Space default ─────────────────────────────────────────────────

async function spaceSetDefault(cmd: CommandContext): Promise<ExitCode> {
  const command = 'space interaction-profile set-default';
  const target = requireArg(command, cmd.args[0], 'an <interaction-profile-id|none>');
  const spaceId = requireSpace(cmd.ctx);
  requireHumanPrincipal(command, cmd);
  requireConfirmation(command, cmd);

  const data = await observedInvoke<unknown>(
    clientFor(cmd.ctx),
    'spaces.interactionProfile.setDefault',
    {
      params: { spaceId },
      body: {
        clientMutationId: resolveMutationId(cmd.options.value('mutation-id')),
        // Kebab-case of the frozen field `expectedSettingsRevision`. A Space
        // carries a settings REVISION, not an entity version, and the flag says
        // so rather than borrowing the other row's spelling.
        expectedSettingsRevision: requireGuard(cmd, 'expect-settings-revision'),
        profileId: targetProfile(target),
        // Read from its own flag, never from `--yes`. See the file header.
        ...(cmd.options.bool('confirm-agent-generated') ? { confirmAgentGenerated: true } : {}),
      },
    },
  );
  cmd.out.data(data, renderSpaceDefault);
  return EXIT_OK;
}

// ── human renderings — the SAME DTO `--format json` emits ───────────────────

function field(dto: unknown, key: string): string | undefined {
  if (dto === null || typeof dto !== 'object') return undefined;
  const value = (dto as Record<string, unknown>)[key];
  if (value === undefined) return undefined;
  // `null` is the explicit "no default" state and must RENDER, not vanish: a
  // blank line would read as "the command did nothing".
  return value === null ? 'none' : String(value);
}

function renderTeammateDefault(dto: unknown): string {
  const id = field(dto, 'teamMemberId');
  if (id === undefined) return JSON.stringify(dto);
  return `${id}  default ${field(dto, 'defaultInteractionProfileId') ?? 'none'}  v${
    field(dto, 'version') ?? '?'
  }`;
}

function renderSpaceDefault(dto: unknown): string {
  const id = field(dto, 'spaceId');
  if (id === undefined) return JSON.stringify(dto);
  return `${id}  default ${field(dto, 'defaultInteractionProfileId') ?? 'none'}  revision ${
    field(dto, 'settingsRevision') ?? '?'
  }`;
}

/**
 * The registry contribution — BOTH halves of the symmetric pair, per S3. The
 * `space` row is deliberately here and deliberately absent from the space
 * module.
 */
export const PROFILE_DEFAULT_COMMANDS: CommandModule[] = [
  { path: ['teammate', 'interaction-profile', 'set-default'], run: teammateSetDefault },
  { path: ['space', 'interaction-profile', 'set-default'], run: spaceSetDefault },
];
