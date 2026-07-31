/**
 * Mock transports for the `src/data/real` suite.
 *
 * THE POINT OF THIS FILE IS WHAT IT CANNOT DO. It contains no `fetch`, no
 * `WebSocket`, no URL that resolves to anything: a test that reached the node
 * would have to import the real transport explicitly, and `createRealSeam`
 * REQUIRES both to be passed in. So "zero network, zero node contact" is a
 * property the type system enforces, not a convention this suite observes.
 *
 * Nothing here imports vitest — this is a plain module, so the package
 * typecheck covers it alongside the code it fakes.
 */
import type { FetchLike } from './http';
import type { Timers } from './connection';
import type { WebSocketFactory, WebSocketLike, WebSocketMessage } from './socket';

// ---------------------------------------------------------------------------
// Clock
// ---------------------------------------------------------------------------

interface Scheduled {
  id: number;
  due: number;
  fn: () => void;
}

/**
 * A manual clock. `advance` fires due callbacks in due-time order and keeps
 * going while callbacks schedule more work inside the same window — which the
 * poll loop and the accelerate loop both do, so a single-pass implementation
 * would silently under-run them.
 */
export class FakeClock {
  private t = Date.parse('2026-07-28T12:00:00.000Z');
  private seq = 0;
  private queue: Scheduled[] = [];

  readonly timers: Timers = {
    setTimeout: (fn: () => void, ms: number) => {
      this.seq += 1;
      const entry: Scheduled = { id: this.seq, due: this.t + Math.max(0, ms), fn };
      this.queue.push(entry);
      return entry.id;
    },
    clearTimeout: (handle: unknown) => {
      this.queue = this.queue.filter((e) => e.id !== handle);
    },
  };

  now = (): number => this.t;

  /** Deterministic "jitter": always the midpoint, so backoff maths is exact. */
  random = (): number => 0.5;

  pending(): number {
    return this.queue.length;
  }

  advance(ms: number): void {
    const target = this.t + ms;
    for (;;) {
      const next = this.queue
        .filter((e) => e.due <= target)
        .sort((a, b) => (a.due - b.due) || (a.id - b.id))[0];
      if (next === undefined) break;
      this.queue = this.queue.filter((e) => e.id !== next.id);
      this.t = next.due;
      next.fn();
    }
    this.t = target;
  }
}

/**
 * Drain the microtask queue by yielding to the real macrotask queue. Not a
 * network operation and not a fake timer — the suite's own promise chains need
 * somewhere to settle.
 */
export function flush(): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

// ---------------------------------------------------------------------------
// Socket
// ---------------------------------------------------------------------------

export class FakeSocket implements WebSocketLike {
  readyState = 0;
  readonly sent: string[] = [];
  closeCalls = 0;

  onopen: (() => void) | null = null;
  onmessage: ((ev: WebSocketMessage) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;

  send(data: string): void {
    // A positive control: production code guards on readyState, so this throw
    // must never fire. If it ever does, the guard regressed.
    if (this.readyState !== 1) throw new Error('FakeSocket.send() on a socket that is not OPEN');
    this.sent.push(data);
  }

  close(): void {
    this.closeCalls += 1;
    this.readyState = 3;
  }

  // -- drivers --------------------------------------------------------------

  /** Transition to OPEN and fire onopen, as a real socket does. */
  openIt(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  /** Deliver a server→client frame as JSON text. */
  deliver(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  /** Deliver arbitrary bytes (for the malformed-frame path). */
  deliverRaw(data: unknown): void {
    this.onmessage?.({ data });
  }

  /** The socket died. */
  drop(): void {
    this.readyState = 3;
    this.onclose?.();
  }

  /** Every control frame this socket was sent, parsed. */
  frames(): Array<Record<string, unknown>> {
    return this.sent.map((s) => JSON.parse(s) as Record<string, unknown>);
  }
}

export interface FakeSocketPool {
  factory: WebSocketFactory;
  sockets: FakeSocket[];
  urls: string[];
  last(): FakeSocket;
}

export function fakeSocketPool(): FakeSocketPool {
  const sockets: FakeSocket[] = [];
  const urls: string[] = [];
  return {
    sockets,
    urls,
    factory: (url: string) => {
      urls.push(url);
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    last() {
      const s = sockets[sockets.length - 1];
      if (s === undefined) throw new Error('no socket has been created');
      return s;
    },
  };
}

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

export interface FakeCall {
  url: string;
  method: string;
  body: unknown;
  rawBody?: BodyInit | null;
  headers?: HeadersInit;
}

/** What a route hands back. Exactly one of these shapes. */
export type FakeReply =
  /** Wrapped in the `{data, requestId}` envelope with a 200. */
  | { data: unknown }
  /** A wire error body at the mapped status. */
  | { status: number; error: Record<string, unknown> }
  /** Verbatim body text at a chosen status — for the non-JSON path. */
  | { status: number; raw: string }
  /** `fetch` itself rejects — the node is unreachable. */
  | { networkError: string };

export interface FakeFetch {
  fetch: FetchLike;
  calls: FakeCall[];
  last(): FakeCall;
}

export function fakeFetch(route: (call: FakeCall) => FakeReply): FakeFetch {
  const calls: FakeCall[] = [];
  return {
    calls,
    last() {
      const c = calls[calls.length - 1];
      if (c === undefined) throw new Error('fetch was never called');
      return c;
    },
    fetch: async (url, init) => {
      const rawBody = init?.body;
      const call: FakeCall = {
        url,
        method: init?.method ?? 'GET',
        body: typeof rawBody === 'string' ? JSON.parse(rawBody) : undefined,
        rawBody,
        headers: init?.headers,
      };
      calls.push(call);
      const reply = route(call);

      if ('networkError' in reply) throw new TypeError(reply.networkError);

      const { status, text } = 'data' in reply
        ? { status: 200, text: JSON.stringify({ data: reply.data, requestId: 'req_server_1' }) }
        : 'raw' in reply
          ? { status: reply.status, text: reply.raw }
          : { status: reply.status, text: JSON.stringify({ error: reply.error }) };

      return {
        ok: status >= 200 && status < 300,
        status,
        text: async () => text,
      } as unknown as Response;
    },
  };
}
