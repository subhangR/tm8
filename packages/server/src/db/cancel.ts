/**
 * The Postgres CANCEL CHANNEL — how a statement is stopped from outside.
 *
 * WHY THIS IS NOT `select pg_cancel_backend(...)`. A `Querier` is one pooled
 * client and cannot run two statements at once, so the cancel cannot be issued
 * on the connection being cancelled. Borrowing a SECOND pooled client to run
 * `pg_cancel_backend` would work right up until it mattered: the moment worth
 * cancelling is the moment the pool is saturated, and a cancel that needs a
 * free client to run is unavailable exactly then. It would also deadlock a
 * `max: 1` pool against itself.
 *
 * The protocol has a purpose-built answer. A CancelRequest is sent on its OWN,
 * BRAND-NEW connection, is 16 bytes long, is not part of any session, gets no
 * reply, and is closed by the server the instant it is read. It costs no pool
 * slot, needs no authentication, and cannot be blocked by the very saturation
 * that made cancelling worthwhile. See Postgres protocol §55.2.8.
 *
 * The wire message, in full:
 *
 *     Int32(16)          length, including itself
 *     Int32(80877102)    the cancel request code, 1234 << 16 | 5678
 *     Int32(processID)   the target backend's pid
 *     Int32(secretKey)   the secret the target got in its own handshake
 *
 * AUTHORIZATION IS THE SECRET KEY, and that is the whole security model: the
 * server cancels only if both halves match a live backend, so a caller must
 * already have been told them — which happens exactly once, to the client that
 * owns the connection, during startup. Postgres deliberately sends NO response
 * either way, so a cancel is never an oracle for guessing.
 *
 * WHAT THIS FILE DELIBERATELY DOES NOT DO: it never reports success. A cancel
 * is advisory — the statement may have finished a microsecond earlier, the pid
 * may already be gone — and a caller that branched on "did it work?" would be
 * branching on a race. The only honest signal is the one the cancelled query
 * itself raises: SQLSTATE 57014.
 */
import net from 'node:net';

/** 1234 << 16 | 5678 — the constant the protocol assigns to CancelRequest. */
const CANCEL_REQUEST_CODE = 80877102;

/**
 * How long the cancel socket may take to connect before we give up on it.
 *
 * Short on purpose. This socket exists to save the node work; a cancel that
 * lingers is spending the resource it was sent to reclaim, and the statement it
 * failed to stop is still bounded by `statement_timeout` regardless.
 */
const CANCEL_SOCKET_TIMEOUT_MS = 2_000;

/**
 * The connection whose backend should be cancelled — in practice a
 * `pg.PoolClient`.
 *
 * `processID` and `secretKey` are the two numbers Postgres hands a client
 * during startup and the only two a CancelRequest needs. They are on the
 * runtime object — pg 8.22's own `Client.prototype.cancel` reads exactly these
 * two to build exactly this message — but `@types/pg` declares NEITHER, which
 * is why this is `object` and not `{ processID?: number }`: a structural type
 * whose members are all optional is a WEAK TYPE, and TypeScript rejects
 * `PoolClient` against one for having no properties in common with it.
 *
 * So the type says only "some connection" and `cancel()` below establishes both
 * fields at runtime, with a `typeof` check on each. That keeps the typings gap
 * in ONE place, named and commented, instead of an `as any` at the call site.
 */
export type CancellableBackend = object;

export interface CancelChannel {
  /**
   * Ask Postgres to cancel whatever `backend` is currently running.
   *
   * Fire-and-forget by design (see the file header): it resolves when the
   * socket is done, never rejects, and never says whether anything was
   * actually cancelled.
   *
   * `stillWanted` IS NOT AN OPTIMISATION. A CancelRequest names a BACKEND, not
   * a statement — "cancel whatever pid 1234 is doing right now" — and a pooled
   * client keeps the same backend across checkouts. Opening a socket takes
   * time, so between deciding to cancel and the bytes landing, the statement
   * can finish, the transaction can commit, the client can be released, and the
   * pool can hand that same backend to an unrelated caller who has started an
   * unrelated query. Cancelling THAT would be a bug the victim could never
   * diagnose. The predicate is re-checked immediately before the write, on the
   * connect callback, so the window between the last check and the send is a
   * single tick with no `await` in it.
   */
  cancel(backend: CancellableBackend, stillWanted?: () => boolean): Promise<void>;
  /** True when this channel can actually reach the server. */
  readonly available: boolean;
}

/** A channel that answers `available: false` and does nothing. */
const NOOP_CHANNEL: CancelChannel = {
  available: false,
  cancel: () => Promise.resolve(),
};

interface CancelTarget {
  readonly host: string;
  readonly port: number;
}

/**
 * Where to aim the cancel socket, or `null` when we cannot aim it honestly.
 *
 * Two shapes are refused rather than guessed at, because guessing would mean
 * opening a socket to the wrong place and silently never cancelling anything:
 *
 * - **TLS** (`sslmode` anything but `disable`). A CancelRequest on a TLS
 *   listener must be preceded by an SSLRequest and the whole handshake; sending
 *   the plaintext 16 bytes instead gets it dropped. tm8 nodes talk to a
 *   loopback Postgres, so this arm has no production caller today; building an
 *   untested TLS path for it would be worse than saying so.
 * - **Unix domain sockets** (`host=/var/run/...`). Reachable in principle, but
 *   the same "no caller today" applies and the path spelling has its own
 *   traps.
 *
 * Either way the fallback is not a failure: `statement_timeout` still bounds
 * the statement, exactly as it did before this file existed.
 */
function cancelTargetFor(databaseUrl: string): CancelTarget | null {
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    return null;
  }
  const sslmode = url.searchParams.get('sslmode');
  if (url.searchParams.get('ssl') === 'true') return null;
  if (sslmode !== null && sslmode !== 'disable') return null;

  const host = decodeURIComponent(url.hostname);
  // A `host=` query parameter is how libpq spells a unix socket directory, and
  // a hostname that begins with `/` is how a URL smuggles one through.
  if (host === '' || host.startsWith('/') || host.startsWith('%2f')) return null;
  const hostParam = url.searchParams.get('host');
  if (hostParam !== null && hostParam.startsWith('/')) return null;

  const port = url.port === '' ? 5432 : Number.parseInt(url.port, 10);
  if (!Number.isInteger(port) || port <= 0) return null;
  return { host, port };
}

/**
 * Build the channel for a database URL.
 *
 * The target is resolved ONCE, at construction, so the per-cancel path is a
 * socket and nothing else — a cancel is issued while a request is already going
 * badly and is not the place to be parsing a URL.
 */
export function createCancelChannel(databaseUrl: string): CancelChannel {
  const target = cancelTargetFor(databaseUrl);
  if (!target) {
    console.warn(
      '[db] query cancellation is OFF: the database URL is not a plain TCP target ' +
        '(TLS or a unix socket). Abandoned statements will run to statement_timeout.',
    );
    return NOOP_CHANNEL;
  }

  return {
    available: true,
    cancel(backend: CancellableBackend, stillWanted?: () => boolean): Promise<void> {
      // The one place the `@types/pg` gap is crossed — see `CancellableBackend`.
      const { processID, secretKey } = backend as {
        processID?: unknown;
        secretKey?: unknown;
      };
      // A client that has not finished its handshake has neither. Nothing to
      // aim at is not an error — there is also nothing running to cancel.
      if (typeof processID !== 'number' || typeof secretKey !== 'number') {
        return Promise.resolve();
      }

      const message = Buffer.alloc(16);
      message.writeInt32BE(16, 0);
      message.writeInt32BE(CANCEL_REQUEST_CODE, 4);
      message.writeInt32BE(processID, 8);
      message.writeInt32BE(secretKey, 12);

      return new Promise<void>((resolve) => {
        let settled = false;
        const finish = (): void => {
          if (settled) return;
          settled = true;
          resolve();
        };
        const socket = net.connect({ host: target.host, port: target.port });
        socket.setTimeout(CANCEL_SOCKET_TIMEOUT_MS);
        // Every arm resolves. A cancel that cannot be delivered leaves the
        // statement bounded by `statement_timeout`, which is the behaviour this
        // whole mechanism is an improvement ON — so failing to improve it is
        // never a reason to fail a request that has already been abandoned.
        socket.on('error', () => {
          socket.destroy();
          finish();
        });
        socket.on('timeout', () => {
          socket.destroy();
          finish();
        });
        socket.on('close', finish);
        socket.on('connect', () => {
          // The last possible moment, and deliberately the ONLY one that
          // matters: see `stillWanted` on the interface. Between here and the
          // write there is no await, so nothing can recycle the backend under
          // us.
          if (stillWanted !== undefined && !stillWanted()) {
            socket.destroy();
            finish();
            return;
          }
          // `end` writes the message and sends FIN in one go. Postgres reads
          // the 16 bytes, acts, and closes without replying — the FIN is what
          // tells it there is nothing more coming.
          socket.end(message);
        });
      });
    },
  };
}
