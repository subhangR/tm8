/**
 * The voice-channel participant roster — who is actually connected to the SFU.
 *
 * EPHEMERAL BY CONSTRUCTION, and the contract says so out loud: the roster
 * count is "a live read from the ephemeral voice-participants store, never
 * stored" (contract.ts, the `voice_channel` EntityState arm). There is no
 * table, no migration and no recovery. A crash empties it, which is CORRECT —
 * a crash also dropped every WebRTC session it was describing, so a roster
 * that survived would be a confident lie about who is in the room.
 *
 * THE OWNER OF TRUTH IS LIVEKIT, not this process. Entries arrive from
 * `participant_joined` / `participant_left` webhooks; nothing here infers
 * presence from a tm8 WebSocket. That distinction is the whole reason this is
 * a separate store from `InMemoryPresenceStore`: presence is a claim a browser
 * makes about itself, whereas voice membership is a fact the SFU observes.
 * Sharing one store would let a tab claim it was in a call it never joined.
 *
 * Modeled on `events/presence.ts` — same in-memory shape, same "the map IS the
 * state" simplicity — but keyed on LiveKit participant identity rather than a
 * tm8 connection id, because the lifetime being tracked is the media session's,
 * not the socket's.
 */

import type { EntityId, SpaceId, VoiceParticipant } from '@tm8/contract';

export interface VoiceRosterEntry {
  /** The caller's member entity id — LiveKit's `identity` for this participant. */
  readonly memberId: EntityId;
  readonly name: string;
  readonly muted?: boolean;
}

export interface VoiceRoom {
  readonly spaceId: SpaceId;
  readonly voiceChannelId: EntityId;
  readonly participants: readonly VoiceParticipant[];
}

export interface VoiceRosterStore {
  /** Record a join (or refresh an existing participant's row). Idempotent. */
  join(spaceId: SpaceId, voiceChannelId: EntityId, entry: VoiceRosterEntry): VoiceRoom;
  leave(spaceId: SpaceId, voiceChannelId: EntityId, memberId: EntityId): VoiceRoom;
  /** Everyone currently in one channel. Empty for an unknown channel. */
  at(spaceId: SpaceId, voiceChannelId: EntityId): readonly VoiceParticipant[];
  /** Live participant count, for the `voice_channel` entity state arm. */
  countAt(spaceId: SpaceId, voiceChannelId: EntityId): number;
  /** Every non-empty room, for a client that connects mid-call and needs a snapshot. */
  rooms(spaceId: SpaceId): readonly VoiceRoom[];
}

/** ` ` cannot appear in an id, so the composite key is unambiguous. */
function keyOf(spaceId: string, voiceChannelId: string): string {
  return `${spaceId} ${voiceChannelId}`;
}

export class InMemoryVoiceRosterStore implements VoiceRosterStore {
  /** `${spaceId} ${voiceChannelId}` → memberId → entry. */
  private readonly byChannel = new Map<string, Map<string, VoiceRosterEntry>>();

  join(spaceId: SpaceId, voiceChannelId: EntityId, entry: VoiceRosterEntry): VoiceRoom {
    const key = keyOf(spaceId, voiceChannelId);
    let members = this.byChannel.get(key);
    if (members === undefined) {
      members = new Map();
      this.byChannel.set(key, members);
    }
    // Keyed by member id, not by an SFU-side connection id: reconnecting after
    // a network blip is the SAME person rejoining, and a per-connection key
    // would show them twice until the stale row timed out.
    members.set(entry.memberId, entry);
    return this.roomOf(spaceId, voiceChannelId);
  }

  leave(spaceId: SpaceId, voiceChannelId: EntityId, memberId: EntityId): VoiceRoom {
    const key = keyOf(spaceId, voiceChannelId);
    const members = this.byChannel.get(key);
    members?.delete(memberId);
    // An empty room is DELETED, not kept as an empty map. `rooms()` is a
    // snapshot of who is talking, and an empty entry would advertise a call
    // that nobody is on.
    if (members !== undefined && members.size === 0) this.byChannel.delete(key);
    return this.roomOf(spaceId, voiceChannelId);
  }

  at(spaceId: SpaceId, voiceChannelId: EntityId): readonly VoiceParticipant[] {
    const members = this.byChannel.get(keyOf(spaceId, voiceChannelId));
    if (members === undefined) return [];
    return [...members.values()].map((entry) => ({
      memberId: entry.memberId,
      name: entry.name,
      ...(entry.muted === undefined ? {} : { muted: entry.muted }),
    }));
  }

  countAt(spaceId: SpaceId, voiceChannelId: EntityId): number {
    return this.byChannel.get(keyOf(spaceId, voiceChannelId))?.size ?? 0;
  }

  rooms(spaceId: SpaceId): readonly VoiceRoom[] {
    const out: VoiceRoom[] = [];
    for (const key of this.byChannel.keys()) {
      const [keySpace, voiceChannelId] = key.split(' ');
      if (keySpace !== spaceId || voiceChannelId === undefined) continue;
      out.push(this.roomOf(spaceId, voiceChannelId));
    }
    return out;
  }

  private roomOf(spaceId: SpaceId, voiceChannelId: EntityId): VoiceRoom {
    return { spaceId, voiceChannelId, participants: this.at(spaceId, voiceChannelId) };
  }
}
