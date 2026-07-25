/**
 * The refresh channel.
 *
 * There is NO live WebSocket push on this node (HOW-TO-TEST §6: "Live
 * WebSocket push is not wired — events.poll is the delivery mechanism"), so
 * this is a poller, and it is named one. It deliberately does not pretend to
 * be a subscription that happens to be slow: `subscribe()` on the facade hands
 * back an unsubscribe exactly as the seam requires, but the transport
 * underneath is `GET /v2/spaces/:id/events?since=<seq>` on an interval.
 *
 * THE ENVELOPE DIVERGENCE (the one adaptation this lane is allowed to make).
 * tm8's contract §1 carries an amendment flagged for the UI team: the UI
 * snapshot's `eventId: string` is replaced by a mandatory envelope
 * `{spaceId, seq, occurredAt, schemaVersion}`, with `(spaceId, seq)` as the
 * dedupe and ordering key. Rather than edit the snapshot's types — which
 * Atlas's team owns — the adaptation lives HERE, in the mapping layer:
 * `eventId` is synthesised as `<spaceId>:<seq>`, which preserves the snapshot's
 * shape while keeping tm8's stronger uniqueness guarantee. Every payload field
 * beyond the envelope is already identical between the two unions, so nothing
 * else is touched.
 */
import type {
  SpaceId,
  Unsubscribe,
  WorkspaceEvent,
} from '../collab-v2/types/contract';
import type { TmClient } from './TmClient';

/** tm8's on-the-wire event: the UI's payload plus the AM-2 §3 envelope. */
type Tm8Event = {
  spaceId: SpaceId;
  seq: number;
  occurredAt: string;
  schemaVersion: number;
  type: string;
  [key: string]: unknown;
};

interface PollPage {
  items?: Tm8Event[];
  /** A seq rendered decimal. The server sends it as a STRING; see `toCursor`. */
  nextCursor?: number | string | null;
}

/**
 * `nextCursor` → a usable `since`, or null when there is none.
 *
 * The server sends this as a STRING (server/src/events/poll.ts) — it is a seq
 * rendered decimal, not a DEV-5 keyset token. A `typeof next === 'number'` test
 * therefore never matched and the server's cursor was discarded on EVERY poll,
 * which the `highWater` fallback hid in the common case.
 *
 * Coercion is explicit rather than a bare `Number()` because `Number('')`,
 * `Number(null)` and `Number([])` are all 0, and a cursor that quietly became 0
 * would replay the entire event log from the beginning. Anything that is not a
 * finite number is treated as "no cursor" so the caller falls back instead.
 */
function toCursor(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * Envelope → `eventId`. The seq is per-space monotonic, so scoping it by
 * spaceId yields a key that is unique across the whole client, which is what
 * the graph store's dedupe assumes of `eventId`.
 */
export function toWorkspaceEvent(raw: Tm8Event): WorkspaceEvent {
  const { spaceId, seq, occurredAt, schemaVersion, ...payload } = raw;
  void occurredAt;
  void schemaVersion;
  return { ...payload, eventId: `${spaceId}:${seq}` } as unknown as WorkspaceEvent;
}

/** Presence and typing are client-synthesized (DEV-4) and never durable. */
function isDurable(e: WorkspaceEvent): boolean {
  return e.type !== 'presence.changed' && e.type !== 'typing.changed';
}

const DEFAULT_INTERVAL_MS = 1500;

/**
 * Polls one space and fans durable events out to its listeners.
 *
 * Cursor discipline: `seq` is authoritative, so the high-water mark is the max
 * seq actually observed rather than the count of events — gaps are allowed by
 * the contract and must not shift the cursor. `nextCursor` is reusable as the
 * next `since`, and is preferred when present.
 */
export class EventPoller {
  private readonly listeners = new Set<(e: WorkspaceEvent) => void>();
  private since = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private inFlight = false;

  constructor(
    private readonly client: TmClient,
    private readonly spaceId: SpaceId,
    private readonly intervalMs: number = DEFAULT_INTERVAL_MS,
  ) {}

  subscribe(cb: (e: WorkspaceEvent) => void): Unsubscribe {
    this.listeners.add(cb);
    this.start();
    return () => {
      this.listeners.delete(cb);
      if (this.listeners.size === 0) this.stop();
    };
  }

  private start(): void {
    if (this.running) return;
    this.running = true;
    // Prime immediately so the first paint is not one interval stale, then
    // settle into the cadence.
    void this.tick();
  }

  private stop(): void {
    this.running = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private schedule(): void {
    if (!this.running) return;
    this.timer = setTimeout(() => void this.tick(), this.intervalMs);
  }

  private async tick(): Promise<void> {
    if (!this.running || this.inFlight) return;
    this.inFlight = true;
    try {
      const page = await this.client.get<PollPage>(
        `/v2/spaces/${this.spaceId}/events?since=${this.since}`,
      );
      const items = page?.items ?? [];

      let highWater = this.since;
      for (const raw of items) {
        if (typeof raw.seq === 'number' && raw.seq > highWater) highWater = raw.seq;
        const event = toWorkspaceEvent(raw);
        if (!isDurable(event)) continue;
        for (const cb of this.listeners) {
          // One bad listener must not stall the stream for the others, and
          // must not stall the cursor either.
          try { cb(event); } catch (err) { console.error('[tm8] event listener threw', err); }
        }
      }

      // The server's cursor wins when there is one, because it advances past
      // rows the server EXAMINED but did not return (filtered, skipped, or
      // non-durable) and `highWater` cannot see those — it only knows the seqs
      // that arrived. That gap is the wedge: on a page whose rows are all
      // filtered out, highWater stays equal to `this.since`, the next poll asks
      // the same question, and the stream never moves again. Preferring the
      // server's cursor is precisely what that cursor exists for.
      //
      // `Math.max` guards monotonicity. The cursor is a high-water mark, so it
      // must never rewind — a backwards cursor would re-deliver events the
      // listeners have already handled.
      const next = toCursor(page?.nextCursor);
      this.since = Math.max(next ?? highWater, this.since);
    } catch (err) {
      // A failed poll is not fatal: the client has already flipped the
      // connection flag, the banner reflects it, and the next tick retries
      // from the SAME cursor so nothing is skipped.
      console.warn('[tm8] event poll failed; retrying from seq', this.since, err);
    } finally {
      this.inFlight = false;
      this.schedule();
    }
  }
}
