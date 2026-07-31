/**
 * The LiveKit webhook receiver — `POST /v2/voice/webhook`.
 *
 * WHY THIS IS NOT A CATALOG OPERATION. The catalog describes what a tm8 CLIENT
 * can ask this node to do. This is the opposite direction: a server-to-server
 * callback from the SFU, authenticated by LiveKit's own signing key rather than
 * by a tm8 identity. Putting it in the catalog would hand every client a
 * discoverable "publish a roster event" verb, which is precisely what it must
 * not be. The catalog says so at its `voice.token.create` row.
 *
 * WHY IT READS RAW BYTES. LiveKit signs the request body and puts the digest in
 * the bearer token's `sha256` claim. A body that has been parsed and
 * re-serialized has a different digest even when semantically identical, so
 * this route MUST be dispatched before the shared JSON body reader — the same
 * placement, and for the same class of reason, as the raw file-upload PUT.
 *
 * WHAT IT PRODUCES. An EPHEMERAL `voice.participants.changed` event on the
 * presence channel. Never a durable event, never a ledger row: the roster is a
 * live fact about the SFU, and writing it to the durable stream would poison
 * subscribers' `seq` cursors (see events/subscriptions.ts on why the two
 * fan-outs are structurally separate) and leave stale "who is in the call"
 * rows behind after a crash.
 *
 * FAILURE POSTURE. Every refusal answers 401/400 and publishes NOTHING. An
 * unverified webhook is not a lesser-trusted webhook; a roster is only worth
 * anything if the SFU is the only thing that can write it.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

import type { EntityId, SpaceId } from '@tm8/contract';

import type { LiveKitConfig } from './config.js';
import { verifyWebhookRequest } from '../voice/livekit-token.js';
import type { VoiceRosterStore } from '../voice/roster.js';

export const VOICE_WEBHOOK_PATH = '/v2/voice/webhook';

/** What the route needs in order to say who is in which room. */
export interface VoiceWebhookOptions {
  readonly livekit: LiveKitConfig;
  readonly roster: VoiceRosterStore;
  /**
   * Resolve a room name (= voice_channel entity id) to its space, so the event
   * can be fanned out to that space's subscribers. Returns undefined for a room
   * this node does not recognise — a webhook for an unknown room is dropped,
   * not guessed at.
   */
  readonly spaceOf: (voiceChannelId: EntityId) => Promise<SpaceId | undefined>;
  /** Publish the ephemeral roster event. Errors here must not 500 the SFU. */
  readonly publish: (
    spaceId: SpaceId,
    voiceChannelId: EntityId,
    participants: readonly { memberId: EntityId; name: string; muted?: boolean }[],
  ) => Promise<void>;
  readonly log?: (message: string) => void;
}

/** Returns `true` when it handled the request, mirroring the upload route. */
export type VoiceWebhookRoute = (
  req: IncomingMessage,
  res: ServerResponse,
  context: { requestId: string },
) => Promise<boolean>;

interface LiveKitWebhookEvent {
  event?: unknown;
  room?: { name?: unknown } | undefined;
  participant?: { identity?: unknown; name?: unknown } | undefined;
}

function readRawBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('webhook body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function reply(res: ServerResponse, status: number, requestId: string, body: unknown): true {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'x-content-type-options': 'nosniff',
    'x-tm8-request-id': requestId,
  });
  res.end(payload);
  return true;
}

export function createVoiceWebhookRoute(options: VoiceWebhookOptions): VoiceWebhookRoute {
  return async (req, res, context) => {
    const pathname = new URL(req.url ?? '/', 'http://tm8.invalid').pathname;
    if ((req.method ?? 'GET') !== 'POST' || pathname !== VOICE_WEBHOOK_PATH) return false;

    let raw: Buffer;
    try {
      raw = await readRawBody(req, 256 * 1024);
    } catch {
      return reply(res, 400, context.requestId, { error: { code: 'invalid_input', message: 'unreadable body' } });
    }

    const verdict = verifyWebhookRequest(
      req.headers.authorization,
      raw,
      options.livekit.apiKey,
      options.livekit.apiSecret,
    );
    if (!verdict.ok) {
      options.log?.(`[voice] webhook rejected: ${verdict.reason}`);
      return reply(res, 401, context.requestId, {
        error: { code: 'unauthorized', message: `livekit webhook rejected: ${verdict.reason}` },
      });
    }

    let event: LiveKitWebhookEvent;
    try {
      event = JSON.parse(raw.toString('utf8')) as LiveKitWebhookEvent;
    } catch {
      return reply(res, 400, context.requestId, { error: { code: 'invalid_input', message: 'body is not JSON' } });
    }

    const type = typeof event.event === 'string' ? event.event : '';
    const roomName = typeof event.room?.name === 'string' ? event.room.name : '';
    const identity = typeof event.participant?.identity === 'string' ? event.participant.identity : '';

    // Every other LiveKit event type (track_published, room_started, egress…)
    // is acknowledged and ignored. Answering 200 matters: LiveKit retries a
    // non-2xx, so refusing events we simply do not model would turn an
    // uninteresting callback into a retry storm.
    if (type !== 'participant_joined' && type !== 'participant_left') {
      return reply(res, 200, context.requestId, { data: { ignored: type || 'unknown' } });
    }
    if (roomName === '' || identity === '') {
      return reply(res, 400, context.requestId, {
        error: { code: 'invalid_input', message: 'participant event has no room name or identity' },
      });
    }

    const spaceId = await options.spaceOf(roomName);
    if (spaceId === undefined) {
      options.log?.(`[voice] webhook for unknown room ${roomName}, dropped`);
      return reply(res, 200, context.requestId, { data: { ignored: 'unknown room' } });
    }

    const name = typeof event.participant?.name === 'string' && event.participant.name !== ''
      ? event.participant.name
      : identity;

    const room = type === 'participant_joined'
      ? options.roster.join(spaceId, roomName, { memberId: identity, name })
      : options.roster.leave(spaceId, roomName, identity);

    try {
      await options.publish(spaceId, roomName, room.participants);
    } catch (cause) {
      // The roster is already correct in memory; a fan-out failure must not
      // make LiveKit retry and double-apply the join.
      options.log?.(`[voice] roster published failed for ${roomName}: ${String(cause)}`);
    }

    return reply(res, 200, context.requestId, {
      data: { room: roomName, participants: room.participants.length },
    });
  };
}
