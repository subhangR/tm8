/**
 * The client→server control channel — the seam that turns the WebSocket from a
 * live transport carrying nothing into `events.subscribe`.
 *
 * ## What this file is answering for
 *
 * Before it, `SubscriptionRegistry.subscribe` had no caller from the wire and
 * `SubscriptionAuthorizer.canSubscribe` had NO CALL SITE ANYWHERE — the
 * interface, an allow-all implementation whose own docstring says it "MUST NOT
 * ship past W2", and nothing else. A written authorizer that nothing invokes is
 * a comment, not a defence. It was inert only because no client could subscribe;
 * landing the control protocol is exactly what arms it, so the authorizer is
 * invoked here, on the same change that makes subscription possible.
 *
 * ## Authorization is a property of the whole path, not of the first check
 *
 * Every branch that can reach a Space's data authorizes first and returns on
 * refusal — including `resume`, which is the dangerous one. Replay is the
 * classic place for a shared read invoked BEFORE the caller's authorization,
 * because the log read looks like a lookup rather than a disclosure. Here the
 * log is not touched at all until `canSubscribe` has said yes; the test asserts
 * the log was never CALLED, not merely that the result was empty, because an
 * empty result would also be produced by a read that happened and found
 * nothing — and those two are not the same defence.
 *
 * ## A refused frame is answered, not swallowed
 *
 * Silence would make "you may not read this Space" indistinguishable from "this
 * Space is quiet", and a client would wait forever on events it will never be
 * sent. `WorkspaceControlAck` is the only server→client message here that is
 * not a `WorkspaceEvent`; its `control.*` type cannot collide with any event
 * variant.
 */
import {
  WorkspaceControlFrameSchema,
  type SpaceId,
  type WorkspaceControlAck,
  type WorkspaceControlFrame,
} from '@tm8/contract';

import type { Db, DbClaims } from '../db/types.js';
import type { RequestIdentity } from '../http/types.js';
import { MAX_POLL_LIMIT, type DurableEventLog } from './poll.js';
import type { PresenceStore } from './presence.js';
import type { SubscriptionRegistry } from './subscriptions.js';
import type { EventSink } from './ws-connection.js';

/**
 * SEAM: who may subscribe to a Space.
 *
 * Keyed on IDENTITY, not on connection id. "May this caller read this Space" is
 * a property of who they are; an authorizer handed only a connection handle
 * would have to look the identity up from state the caller influences, which is
 * how a check ends up authorizing the wrong subject.
 */
export interface SubscriptionAuthorizer {
  canSubscribe(identity: RequestIdentity, spaceId: string): Promise<boolean>;
}

/**
 * The real authorizer: a Space is subscribable exactly when the caller can read
 * its row.
 *
 * `select 1 from public.spaces where id = $1` under the caller's own claims is
 * not an approximation of the rule — `spaces_select` (008:69) is
 * `internal.is_space_member(id)`, the SAME predicate that guards `spaces.get`.
 * Deriving the answer from RLS rather than restating the membership test here
 * is what keeps subscription from becoming a side channel around read
 * authorization: if the two ever diverge, they diverge together.
 *
 * FAIL CLOSED. Any error — a malformed uuid raising 22P02, a dropped
 * connection — is a refusal, never an allow. An authorizer that opens on error
 * is an authorizer that an attacker only has to break rather than pass.
 */
export class DbSubscriptionAuthorizer implements SubscriptionAuthorizer {
  private readonly db: Pick<Db, 'query'>;
  private readonly claimsFor: (identity: RequestIdentity) => Promise<DbClaims>;
  private readonly onError: ((message: string) => void) | undefined;

  constructor(
    db: Pick<Db, 'query'>,
    claimsFor: (identity: RequestIdentity) => Promise<DbClaims>,
    opts: { onError?: (message: string) => void } = {},
  ) {
    this.db = db;
    this.claimsFor = claimsFor;
    this.onError = opts.onError;
  }

  async canSubscribe(identity: RequestIdentity, spaceId: string): Promise<boolean> {
    try {
      const rows = await this.db.query(
        await this.claimsFor(identity),
        'select 1 from public.spaces where id = $1',
        [spaceId],
      );
      return rows.length > 0;
    } catch (error) {
      this.onError?.(error instanceof Error ? error.message : String(error));
      return false;
    }
  }
}

/**
 * Where a connection's LIVE delivery starts, and the only way it is ever set.
 *
 * The pump refuses to deliver for a (connection, Space) with no cursor, so this
 * is what makes a subscription live. Two callers, both explicit: a successful
 * `subscribe` seeds at the current high-water mark (start from NOW), and a
 * `resume` seeds at the last seq it actually replayed (continue from THERE,
 * with no gap and no duplicate across the handover).
 */
export interface LiveCursor {
  seed(connId: string, spaceId: string, seq: number): void;
}

export interface ControlChannelDeps {
  readonly registry: SubscriptionRegistry;
  readonly authorizer: SubscriptionAuthorizer;
  /** Read-side of the durable log, for `resume`. */
  readonly log: DurableEventLog;
  readonly claimsFor: (identity: RequestIdentity) => Promise<DbClaims>;
  /** Ephemeral presence sink for `presence.set` (DEV-4). Absent = presence off. */
  readonly presence?: PresenceStore;
  /** Live-delivery cursors. Absent = no live push, poll/resume only. */
  readonly cursors?: LiveCursor;
  /**
   * The durable high-water mark for `spaceId`, read AS `identity`.
   *
   * `null` means the mark could not be established — and per seq.ts that is NOT
   * "zero". A subscribe that cannot establish a start point is left UNSEEDED so
   * the client must `resume` with its own cursor, because seeding at zero would
   * replay the entire retained log at it.
   */
  readonly highWaterMark?: (identity: RequestIdentity, spaceId: string) => Promise<number | null>;
  /** A control frame that failed for a reason the client cannot fix. */
  readonly onError?: (message: string) => void;
}

export interface ControlChannel {
  /** Handle one raw client→server text frame. Never throws. */
  handle(sink: EventSink, text: string): Promise<void>;
}

/** How many events one `resume` may replay before the client must ask again. */
export const MAX_RESUME_BATCH = MAX_POLL_LIMIT;

function refuse(sink: EventSink, ack: WorkspaceControlAck): void {
  try {
    sink.send(JSON.stringify(ack));
  } catch {
    // The connection's own close path evicts it; a failed refusal is not worth
    // taking down the handler for.
  }
}

export function createControlChannel(deps: ControlChannelDeps): ControlChannel {
  const { registry, authorizer, log, claimsFor } = deps;

  /** Authorize one Space, refusing on the socket when the answer is no. */
  async function authorized(
    sink: EventSink,
    frame: WorkspaceControlFrame['type'],
    spaceId: SpaceId,
  ): Promise<boolean> {
    const ok = await authorizer.canSubscribe(sink.identity, spaceId);
    if (!ok) refuse(sink, { type: 'control.refused', frame, spaceId, reason: 'forbidden' });
    return ok;
  }

  async function apply(sink: EventSink, frame: WorkspaceControlFrame): Promise<void> {
    switch (frame.type) {
      case 'subscribe': {
        // Per-Space, not all-or-nothing: one frame naming a readable and an
        // unreadable Space subscribes the readable one and refuses the other.
        // Failing the whole frame would let an unauthorized id deny the caller
        // Spaces it is genuinely entitled to.
        for (const spaceId of frame.spaceIds) {
          if (!(await authorized(sink, 'subscribe', spaceId))) continue;
          registry.subscribe(sink.id, spaceId);

          // Start live delivery at NOW, not at the beginning of the retained
          // log. The mark is read under the CALLER's identity, so this is the
          // same authorized read as everything else on this path — there is no
          // privileged or identity-less lookup anywhere in the reader.
          if (deps.cursors !== undefined && deps.highWaterMark !== undefined) {
            const mark = await deps.highWaterMark(sink.identity, spaceId);
            // null => leave UNSEEDED on purpose. The client gets no live push
            // for this Space until it sends `resume` with a cursor it owns.
            // Silence the client can fix beats replaying history it did not ask
            // for and cannot tell from new events.
            if (mark !== null) deps.cursors.seed(sink.id, spaceId, mark);
          }
        }
        return;
      }

      case 'unsubscribe': {
        // Deliberately unauthorized: giving up access you may or may not have
        // is always permitted, and requiring a check here would mean a caller
        // whose membership was revoked could not stop its own subscription.
        for (const spaceId of frame.spaceIds) registry.unsubscribe(sink.id, spaceId);
        return;
      }

      case 'presence': {
        // A per-connection flag over the Spaces already subscribed. It cannot
        // widen visibility, so there is nothing here to authorize.
        registry.subscribePresence(sink.id, frame.on);
        return;
      }

      case 'resume': {
        // AUTHORIZE FIRST. The log is not read on the refusal path at all.
        if (!(await authorized(sink, 'resume', frame.spaceId))) return;
        const page = await log.since(
          frame.spaceId,
          frame.since,
          MAX_RESUME_BATCH,
          await claimsFor(sink.identity),
        );
        // Replay goes to the REQUESTING sink only — it is a catch-up for one
        // client, not a broadcast. Fanning it out would redeliver events every
        // other subscriber has already applied.
        for (const event of page.items) {
          if (!sink.isOpen) return;
          sink.send(JSON.stringify(event));
        }

        // Hand the connection over to live delivery exactly where the replay
        // stopped. Without this a resumed client either never goes live, or
        // goes live from a different cursor and re-receives what it just got.
        const resumed = Number(page.nextCursor);
        if (Number.isSafeInteger(resumed)) deps.cursors?.seed(sink.id, frame.spaceId, resumed);
        return;
      }

      case 'presence.set': {
        if (deps.presence === undefined) return;
        // AUTHORIZE FIRST, then resolve — the store is not written on the
        // refusal path at all, exactly as `resume` does not read the log on it.
        if (!(await authorized(sink, 'presence.set', frame.spaceId))) return;

        // THE IDENTITY IS RESOLVED THROUGH `claimsFor`, WHICH IS THE ONLY
        // ANSWER TO "WHO IS THIS CONNECTION" THIS FILE MAY USE.
        //
        // Every other branch already does: `subscribe` and this frame's own
        // authorization go through `authorizer.canSubscribe`, which resolves at
        // `:90-93`; `resume` resolves at `:221`; `highWaterMark` is read AS the
        // identity. The composition root supplies no `authorize` callback
        // (`main.ts:213`), so `ws-server.ts:137` yields an auto-owner whose
        // `identityId` is absent, and `main.ts:167-170` exists precisely to
        // resolve that to the node owner. A write that skipped this resolver
        // recorded the connection as nobody WHILE THE LINE ABOVE HAD JUST
        // ADMITTED IT AS THE OWNER — the same frame authorized under one
        // identity and stored under another, which cannot both be right.
        //
        // `identityId` stays OPTIONAL through this call on purpose. When
        // resolution genuinely yields no identity, the store's own guard
        // declines to count the connection as a viewer, and that guard is load
        // bearing: it is what stops an unauthenticated connection appearing in
        // someone's presence list. Resolving here does not weaken it — it stops
        // this branch from tripping it for every caller on a normally-booted
        // node.
        const claims = await claimsFor(sink.identity);
        deps.presence.set({
          spaceId: frame.spaceId,
          entityId: frame.entityId,
          connId: sink.id,
          identityId: claims.identityId,
          viewing: frame.viewing,
          typing: frame.typing,
        });
        return;
      }
    }
  }

  return {
    async handle(sink: EventSink, text: string): Promise<void> {
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch {
        refuse(sink, { type: 'control.refused', frame: 'subscribe', reason: 'malformed' });
        return;
      }

      const parsed = WorkspaceControlFrameSchema.safeParse(raw);
      if (!parsed.success) {
        // `.strict()`, so an unknown key is not "a subscribe with an extra
        // field" — it is not a subscribe. Applying the recognised parts of an
        // unrecognised frame is how a client ends up believing it subscribed.
        const attempted = (raw as { type?: unknown } | null)?.type;
        refuse(sink, {
          type: 'control.refused',
          frame: typeof attempted === 'string' && isFrameType(attempted) ? attempted : 'subscribe',
          reason: 'malformed',
        });
        return;
      }

      try {
        await apply(sink, parsed.data);
      } catch (error) {
        // A failing control frame must not tear down a socket that is carrying
        // other Spaces' events perfectly well.
        deps.onError?.(error instanceof Error ? error.message : String(error));
      }
    },
  };
}

const FRAME_TYPES = new Set<string>(['subscribe', 'unsubscribe', 'presence', 'resume', 'presence.set']);

function isFrameType(value: string): value is WorkspaceControlFrame['type'] {
  return FRAME_TYPES.has(value);
}
