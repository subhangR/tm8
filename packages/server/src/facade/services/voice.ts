/**
 * `voice.token.create` — mint a LiveKit room-join grant for one voice channel.
 *
 * THE AUTHORIZATION IS THE QUERY. There is no hand-written permission check
 * here, and that is the design: the server selects the target row through the
 * CALLER'S OWN claims with `set local role tm8_app`, so RLS decides. A row that
 * comes back IS the proof that this identity may see this voice channel in this
 * space; a row that does not come back is indistinguishable, to this code, from
 * a channel that does not exist — which is the correct thing to tell a
 * non-member anyway (an existence oracle is a leak).
 *
 * Writing the check by hand would mean a second, weaker copy of a policy that
 * already exists in the database, and the two would drift.
 *
 * `set local role tm8_app` is load-bearing and easy to omit. `PgDb` binds
 * claims but never sets a role, and the deployment user is a superuser that
 * BYPASSES RLS — so without this line the query returns the row for everyone
 * and the authorization silently evaporates while every test that only checks
 * the happy path still passes. Same repair as `events/control.ts:99`,
 * `events/poll.ts:126` and `services/w2/execution.ts:394`.
 *
 * The identity bound into the token is the caller's MEMBER entity id in that
 * space, not their account or identity id: it is the id the rest of tm8 uses
 * for "a person in this space", so LiveKit's roster needs no translation table
 * and the roster events can name members directly.
 */

import { CollabError, type CreateVoiceTokenInput, type VoiceTokenGrant } from '@tm8/contract';

import type { LiveKitConfig } from '../../http/config.js';
import type { RequestContext } from '../../http/types.js';
import { claimsFor, commandEnvelope } from '../context.js';
import type { FacadeDeps } from '../deps.js';
import { mintAccessToken } from '../../voice/livekit-token.js';

interface VoiceChannelRow {
  readonly entity_id: string;
  readonly space_id: string;
  readonly name: string;
  readonly member_id: string | null;
  readonly display_name: string | null;
}

/**
 * One statement, because the two facts must be true of the SAME caller at the
 * SAME instant: the channel is readable, and the caller has a member row in
 * that channel's space. Two round trips could interleave with a membership
 * change and mint a token for someone who had just been removed.
 */
const RESOLVE_SQL = `
  select v.entity_id,
         v.space_id,
         v.name,
         m.entity_id as member_id,
         coalesce(m.display_name, u.display_name) as display_name
    from public.voice_channels v
    join public.members m
      on m.space_id = v.space_id
     and m.identity_id = internal.identity_id()
    left join public.user_profiles u on u.identity_id = m.identity_id
   where v.entity_id = $1
`;

export class VoiceService {
  constructor(
    private readonly deps: FacadeDeps,
    private readonly livekit: LiveKitConfig | undefined,
  ) {}

  readonly createToken = async (ctx: RequestContext): Promise<VoiceTokenGrant> => {
    // Refuse BEFORE touching the database. An unconfigured node has nothing to
    // authorize against and should say so plainly rather than fail later inside
    // the browser's WebRTC handshake, where the user sees no reason at all.
    const livekit = this.livekit;
    if (livekit === undefined) {
      throw new CollabError(
        'not_implemented',
        'voice is not configured on this node — set TM8_LIVEKIT_URL, TM8_LIVEKIT_API_KEY ' +
          'and TM8_LIVEKIT_API_SECRET to enable voice channels',
      );
    }

    const voiceChannelId = ctx.params['id'];
    if (typeof voiceChannelId !== 'string' || voiceChannelId === '') {
      throw new CollabError('invalid_input', 'voice.token.create requires a voice channel entity id');
    }

    const owner = await this.deps.owner();
    const envelope = commandEnvelope(ctx);

    const row = await this.deps.db.tx(claimsFor(owner, ctx, envelope), async (q) => {
      // See the header: without this the superuser bypasses every policy below.
      await q.query('set local role tm8_app');
      const rows = await q.query<VoiceChannelRow>(RESOLVE_SQL, [voiceChannelId]);
      return Array.isArray(rows) ? rows[0] : undefined;
    });

    if (row === undefined || row.member_id === null) {
      // Deliberately not_found rather than forbidden, and deliberately the same
      // answer for "no such channel" and "not your space" — see the header.
      throw new CollabError('not_found', `no readable voice channel ${voiceChannelId}`);
    }

    const minted = mintAccessToken({
      apiKey: livekit.apiKey,
      apiSecret: livekit.apiSecret,
      // Room name IS the entity id: the SFU and the graph agree on one
      // namespace, so nothing has to map between them.
      room: row.entity_id,
      identity: row.member_id,
      name: row.display_name ?? row.name,
    });

    return {
      voiceChannelId: row.entity_id,
      url: livekit.url,
      token: minted.token,
      roomName: row.entity_id,
      identity: row.member_id,
      expiresAt: minted.expiresAt,
    };
  };
}
