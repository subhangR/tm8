/**
 * `tm8 voice token <voice-channel-id>` — mint a room-join grant for a
 * voice_channel: a LiveKit access token, never audio bytes.
 *
 * Audio never flows through the tm8 Server or this CLI: the browser (or other
 * client) connects to the grant's `url` directly with the signed `token`. On a
 * node without LiveKit configured the Server answers `not_implemented` with
 * the exact env vars to set, and that refusal is rendered verbatim — the
 * honest state, not a fabricated grant.
 *
 * The grant is returned ONCE and expires; nothing here stores it. The human
 * rendering therefore prints everything a caller needs to join now, and names
 * the expiry so a stale grant is never mistaken for a dead room.
 */
import { CliError, EXIT_OK, EXIT_USAGE, type ExitCode } from '../exit.js';
import { resolveMutationId } from '../mutation.js';
import { clientFor, observedInvoke } from '../discovery/observe.js';
import { assertKnownOptions, withActor } from './entity.js';
import type { CommandContext, CommandModule } from '../run.js';

interface VoiceTokenGrantDto {
  voiceChannelId?: unknown;
  url?: unknown;
  token?: unknown;
  roomName?: unknown;
  identity?: unknown;
  expiresAt?: unknown;
}

function renderGrant(dto: unknown): string {
  const g = dto as VoiceTokenGrantDto;
  return [
    `voice grant for ${String(g.voiceChannelId ?? '?')}`,
    `  room:     ${String(g.roomName ?? '?')}`,
    `  identity: ${String(g.identity ?? '?')}`,
    `  url:      ${String(g.url ?? '?')}`,
    `  token:    ${String(g.token ?? '?')}`,
    `  expires:  ${String(g.expiresAt ?? '?')}`,
  ].join('\n');
}

async function voiceToken(cmd: CommandContext): Promise<ExitCode> {
  assertKnownOptions(cmd, ['mutation-id']);
  const voiceChannelId = cmd.args[0];
  if (voiceChannelId === undefined || voiceChannelId === '') {
    throw new CliError('`tm8 voice token` requires the <voice-channel-id> to join', EXIT_USAGE, {
      hint: 'find voice channels with `tm8 entity query --kinds voice_channel`',
    });
  }

  const data = await observedInvoke<unknown>(clientFor(cmd.ctx), 'voice.token.create', {
    params: { id: voiceChannelId },
    body: withActor(cmd, {
      clientMutationId: resolveMutationId(cmd.options.value('mutation-id')),
    }),
  });
  cmd.out.data(data, renderGrant);
  return EXIT_OK;
}

export const VOICE_COMMANDS: CommandModule[] = [
  { path: ['voice', 'token'], run: voiceToken },
];
