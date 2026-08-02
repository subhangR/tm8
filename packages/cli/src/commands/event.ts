/**
 * `tm8 event list` and `tm8 event watch` — the events family (§4), projecting
 * `events.poll` and `events.subscribe`.
 *
 * TWO ROWS, AND THEY ARE NOT THE SAME KIND OF THING.
 *
 *   `events.poll`      GET /v2/spaces/:spaceId/events — a durable read that
 *                      works. Registered and composed on this node, but it
 *                      carries no independent W3 verdict, so it is COMPOSED,
 *                      NOT INDEPENDENTLY GATED, and this file claims nothing
 *                      more for it than that.
 *   `events.subscribe` WS /v2/ws — the catalog's ONLY WebSocket row, and now a
 *                      real subscription rather than a bare upgrade. See
 *                      `wsControlProtocol` for what changed and what this file
 *                      is careful NOT to claim about it.
 *
 * A NOTE ON THIS FILE'S OWN HISTORY, because it is the reason for the discipline
 * below rather than a decoration on it. An earlier version of `event watch`
 * shipped the sentence "that contract defines the server→client WorkspaceEvent
 * and no client→server control message". That was true when written, was
 * carefully scoped to the build that printed it, and BECAME FALSE the moment
 * `@tm8/contract` grew `WorkspaceControlFrame` — at which point it was a lie the
 * CLI told, in present tense, on stderr. In a PTY stderr and stdout land in the
 * same agent context, so it was a lie told directly into a reader's context
 * window. The lesson taken here is NOT "predict the contract better". It is that
 * a diagnostic must assert only what is checkable against the build that printed
 * it, and that a claim about the contract belongs where it can be re-derived
 * from the contract rather than restated from memory.
 *
 * THE CURSOR HERE IS A SEQ, NOT AN OPAQUE CURSOR. `events.poll` pages by the
 * per-space `seq` from the AM-2 §3 envelope: the caller replays from the last
 * seq it durably applied, and the page's `nextCursor` is reusable verbatim as
 * the next `--after`. That is why `--cursor` is REFUSED rather than ignored —
 * a caller carrying the `--cursor` habit from every other list command would
 * otherwise be silently dropped and read the resulting page as "you have missed
 * nothing", which is a data loss wearing a green badge.
 *
 * WHY THE PAGE IS EMITTED WHOLE UNDER EVERY FORMAT. `--format json` and
 * `--format jsonl` both emit `{items, nextCursor}` — the contract page — rather
 * than one event per line. One-event-per-line would drop `nextCursor`, and
 * `nextCursor` is exactly the value the follow-up poll needs; §7.2's rule is
 * that a paged mode preserves contract pages rather than fabricating an
 * aggregate, and the human view renders that same DTO. `event watch` is the
 * opposite case and takes the opposite rule: it has no page and no cursor to
 * preserve, so it emits one event per line and refuses `--format json`.
 */
import {
  bindPath,
  WorkspaceControlAckSchema,
  WorkspaceControlFrameSchema,
  type WorkspaceControlAck,
  type WorkspaceControlFrame,
} from '@tm8/contract';
import { requireSpace, type CliContext } from '../context.js';
import {
  CliError,
  EXIT_FORBIDDEN,
  EXIT_INTERRUPTED,
  EXIT_MATCHED_VIA_POLL,
  EXIT_OK,
  EXIT_PROTOCOL,
  EXIT_RETRYABLE,
  EXIT_USAGE,
  EXIT_WAIT_TIMEOUT,
  type ExitCode,
} from '../exit.js';
import { refuseMutationId } from '../mutation.js';
import type { Output } from '../output.js';
import type { OptionBag } from '../args.js';
import { clientFor, observedInvoke } from '../discovery/observe.js';
import type { CommandContext, CommandModule } from '../run.js';

/**
 * `--after <space-seq>`. A seq is a non-negative integer and nothing else;
 * `Number('abc')` is `NaN` and `seq > NaN` is false for every row, so a coerced
 * typo would return an empty page that reads as "fully caught up".
 */
function afterSeq(options: OptionBag): string | undefined {
  const raw = options.value('after');
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw)) {
    throw new CliError(
      `--after expects a non-negative <space-seq>, got ${JSON.stringify(raw)}`,
      EXIT_USAGE,
      { hint: 'the seq to resume from is the `nextCursor` of the previous `tm8 event list`' },
    );
  }
  return raw;
}

function limitCount(cmd: CommandContext): string | undefined {
  const raw = cmd.options.value('limit');
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw) || Number(raw) < 1) {
    throw new CliError(
      `--limit expects a positive <count>, got ${JSON.stringify(raw)}`,
      EXIT_USAGE,
    );
  }
  return raw;
}

async function eventList(cmd: CommandContext): Promise<ExitCode> {
  refuseMutationId('event list', cmd.options.value('mutation-id'));
  if (cmd.options.has('cursor')) {
    throw new CliError(
      '`tm8 event list` does not page by opaque cursor: this feed resumes from a per-space seq',
      EXIT_USAGE,
      { hint: 'pass --after <space-seq>, using the `nextCursor` the previous page returned' },
    );
  }

  const spaceId = requireSpace(cmd.ctx);
  const since = afterSeq(cmd.options);
  const limit = limitCount(cmd);

  // `events.poll` is `input: none` — no REQUEST PAYLOAD. Query params are a
  // different thing entirely and never meet a body schema, which is why a GET
  // read legitimately carries its dimensions here.
  const query: Record<string, string> = {};
  if (since !== undefined) query['since'] = since;
  if (limit !== undefined) query['limit'] = limit;

  const page = await observedInvoke<unknown>(clientFor(cmd.ctx), 'events.poll', {
    params: { spaceId },
    ...(Object.keys(query).length > 0 ? { query } : {}),
  });

  cmd.out.data(page, renderPage);
  return EXIT_OK;
}

// ── the client→server control protocol ─────────────────────────────────────

/**
 * What `tm8 event watch` asks for, assembled from the flags the caller passed.
 *
 * `spaceId` is REQUIRED, and that is a contract fact rather than a preference:
 * a `subscribe` frame carries `spaceIds: SpaceId[]` with a minimum of one, so
 * there is no "subscribe to everything" frame to send. Watching the whole
 * workspace is therefore inexpressible today, and refusing with `--space` named
 * is better than silently watching one Space the caller did not choose.
 */
export interface WatchRequest {
  spaceId: string;
  /** `--after <space-seq>`: resume from a durably-applied per-space seq. */
  afterSeq: string | undefined;
  eventTypes: readonly string[];
  entityIds: readonly string[];
  presence: boolean;
}

/** How a server→client text frame was understood. */
export type ServerFrame =
  | {
      kind: 'ack';
      /** Present when the frame is a control message this build RECOGNISES. */
      ack: WorkspaceControlAck | undefined;
      raw: Record<string, unknown>;
    }
  | { kind: 'event'; event: Record<string, unknown> }
  | { kind: 'unintelligible'; text: string; why: string };

export interface WsControlProtocol {
  /** The ordered frames a watch sends once the socket is open. */
  frames(request: WatchRequest): WorkspaceControlFrame[];
  /** Validate against the contract, then serialise. Never serialises blind. */
  encode(frame: WorkspaceControlFrame): string;
  /** Discriminate one inbound text frame. */
  classify(text: string): ServerFrame;
}

/**
 * The client→server control protocol seam — NOW RESOLVED.
 *
 * This function used to return `null`, meaning "the contract carries no
 * client→server message, so there is no legal frame to send and this slot must
 * not invent one". That refusal was correct while it held, and it is what made
 * this a small change rather than a retraction when the contract moved.
 *
 * `@tm8/contract` now defines `WorkspaceControlFrame` and `WorkspaceControlAck`,
 * so the frames below are the CONTRACT'S frames — every one is validated by
 * `WorkspaceControlFrameSchema` before it reaches the socket, and nothing here
 * is hand-shaped. Three properties of that schema drive this code and none of
 * them is assumed:
 *
 *   IT IS `.strict()`. An unknown key is a REJECTED frame, not a tolerated one.
 *   That is why `--type` and `--entity` cannot be sent — the contract has no
 *   filter field, so smuggling one on would have the node reject the whole
 *   subscribe. Those filters are applied locally instead, and `event watch`
 *   SAYS SO, because a caller who believes the node is filtering for them
 *   believes something false about where their data has been.
 *
 *   `subscribe` AND `resume` ARE SEPARATE FRAMES. The contract is explicit that
 *   subscribe is membership and resume is replay, and that merging them would
 *   make every re-subscribe implicitly re-replay. So `--after` produces a second
 *   frame; it is never a cursor smuggled onto the first.
 *
 *   `spaceIds` IS BOUNDED AT `MAX_CONTROL_FRAME_SPACES`. One socket carries the
 *   whole workspace stream, but a frame may not name an unbounded set.
 *
 * DELIBERATELY NOT BOUND HERE: `unsubscribe` and `presence.set`. Both are real
 * contract frames, and neither has a caller in this command's authorized
 * grammar — `event watch` holds one subscription for its whole life, and
 * `presence.set` is a WRITE while this row is `side: 'none'` in the projection
 * this file must agree with. An encoder with no call site is a comment
 * pretending to be code, so they are reported as unbound rather than written
 * speculatively.
 */
export function wsControlProtocol(): WsControlProtocol {
  return {
    frames(request: WatchRequest): WorkspaceControlFrame[] {
      const frames: WorkspaceControlFrame[] = [
        { type: 'subscribe', spaceIds: [request.spaceId] },
      ];
      if (request.afterSeq !== undefined) {
        // Safe by construction: `watchRequestFrom` refuses a seq that cannot
        // survive the conversion. See the guard there for why that matters.
        frames.push({ type: 'resume', spaceId: request.spaceId, since: Number(request.afterSeq) });
      }
      // The toggle only ever turns the channel ON. There is no watch that asks
      // for presence and then declines it, and sending `{on:false}` for the
      // default would be a frame the caller never asked for.
      if (request.presence) frames.push({ type: 'presence', on: true });
      return frames;
    },

    encode(frame: WorkspaceControlFrame): string {
      const parsed = WorkspaceControlFrameSchema.safeParse(frame);
      if (!parsed.success) {
        // Reaching here means THIS CLI built an illegal frame, not that the
        // caller mistyped: every caller-supplied dimension is validated before
        // a frame is assembled. So it is a protocol failure on this side (10),
        // and it is refused rather than sent — an off-contract frame on the
        // socket is exactly the second source of truth the closed catalog
        // exists to prevent.
        throw new CliError(
          `\`tm8 event watch\` refused to send a frame the contract rejects: ${parsed.error.issues
            .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
            .join('; ')}`,
          EXIT_PROTOCOL,
        );
      }
      return JSON.stringify(parsed.data);
    },

    classify(text: string): ServerFrame {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        return { kind: 'unintelligible', text, why: 'not JSON' };
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { kind: 'unintelligible', text, why: 'not a JSON object' };
      }
      const raw = parsed as Record<string, unknown>;
      const type = raw['type'];
      if (typeof type !== 'string') {
        return { kind: 'unintelligible', text, why: 'no string `type` to discriminate on' };
      }
      // THE DISCRIMINATION, and it is a PREFIX test on purpose. `control.refused`
      // is the only control message today, but matching that one literal would
      // render any future `control.*` message as though it were a WorkspaceEvent
      // — which is precisely the collision the `control.` namespace was
      // introduced to make impossible. No WorkspaceEvent variant begins with
      // `control.`; the test asserts that over the contract's own enumerated
      // variant set rather than trusting this comment.
      if (type.startsWith(CONTROL_PREFIX)) {
        const ack = WorkspaceControlAckSchema.safeParse(raw);
        return { kind: 'ack', ack: ack.success ? ack.data : undefined, raw };
      }
      return { kind: 'event', event: raw };
    },
  };
}

/** The namespace that tells an ACK from an event. Contract-defined. */
const CONTROL_PREFIX = 'control.';

/**
 * Build the watch request, validating every caller-supplied dimension BEFORE a
 * socket is opened. A malformed invocation is a local usage error and must never
 * cost a connection.
 */
export function watchRequestFrom(input: { options: OptionBag; ctx: CliContext }): WatchRequest {
  const { options, ctx } = input;
  const after = afterSeq(options);
  if (after !== undefined && !Number.isSafeInteger(Number(after))) {
    // `resume.since` is a NUMBER in the contract, but `workspace_events.seq` is
    // a bigint that this CLI otherwise carries as a STRING end to end precisely
    // so it is never rounded. `Number('9007199254740993')` is ...992, and a
    // cursor rounded UP SKIPS rows silently — no duplicate, no loop, no error.
    // Zod's `.safe()` cannot catch it either, because by the time the schema
    // sees the value it is already the rounded one. So the guard lives here and
    // refuses, which is the only direction that cannot lose an event.
    throw new CliError(
      `--after ${after} exceeds the largest seq a \`resume\` frame can carry without rounding ` +
        `(${Number.MAX_SAFE_INTEGER}); it is refused rather than rounded, because a cursor rounded ` +
        'UP skips events silently',
      EXIT_USAGE,
      { hint: '`tm8 event list --after <space-seq>` reads the durable log without this limit' },
    );
  }
  return {
    spaceId: requireSpace(ctx),
    afterSeq: after,
    eventTypes: options.values('type'),
    entityIds: options.values('entity'),
    presence: options.bool('presence'),
  };
}

// ── the socket ─────────────────────────────────────────────────────────────

/**
 * The transport `runWatch` drives.
 *
 * Injected for the same reason the frozen kernel injects `fetchImpl` into
 * `Tm8Client`: the protocol logic above the socket must be testable without a
 * live peer. This is that established pattern, not a new seam.
 *
 * There is deliberately no `onError`. A transport error and a close are the same
 * event to this command — the stream stopped — and giving them two paths invites
 * one of them to be handled and the other forgotten.
 */
export interface WatchSocket {
  open(): Promise<void>;
  send(text: string): void;
  close(): void;
  onMessage(fn: (text: string) => void): void;
  onClose(fn: (code: number, reason: string) => void): void;
}

/** Close codes RFC 6455 defines as an orderly end rather than a failure. */
const CLEAN_CLOSE: ReadonlySet<number> = new Set([1000, 1001]);

/**
 * A `WatchSocket` over the runtime's own WebSocket.
 *
 * The URL is `bindPath('events.subscribe', {})` with the scheme swapped — the
 * catalog is the only source of the path, and there is no `/v2/ws` literal in
 * this package.
 *
 * `ctx.token` is NOT carried. That is a limitation stated rather than hidden:
 * the standard `WebSocket` constructor accepts no request headers, so the
 * Phase-2 bearer seam cannot travel this way. It costs nothing today because
 * Phase-1 identity is a DB-resolved loopback auto-owner and there is no bearer
 * authentication to carry.
 */
function runtimeSocket(ctx: CliContext): WatchSocket {
  const Ctor = (globalThis as { WebSocket?: new (url: string) => WebSocketLike }).WebSocket;
  if (Ctor === undefined) {
    throw new CliError(
      `\`tm8 event watch\` needs a WebSocket in the runtime and this one (node ${process.version}) ` +
        'has none',
      EXIT_PROTOCOL,
      { hint: 'durable Space events are read with `tm8 event list` (events.poll) over HTTP' },
    );
  }
  const url = new URL(bindPath('events.subscribe', {}), ctx.baseUrl.value);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new Ctor(url.href);

  return {
    async open(): Promise<void> {
      await new Promise<void>((resolve, reject) => {
        ws.addEventListener('open', () => resolve(), { once: true });
        ws.addEventListener(
          'error',
          () =>
            reject(
              new CliError(
                `\`tm8 event watch\` could not open the event socket at ${url.href} ` +
                  `(is tm8-server running at ${ctx.baseUrl.value}?)`,
                EXIT_RETRYABLE,
              ),
            ),
          { once: true },
        );
      });
    },
    send: (text) => ws.send(text),
    close: () => ws.close(),
    onMessage: (fn) => {
      ws.addEventListener('message', (e) => {
        fn(typeof e.data === 'string' ? e.data : String(e.data));
      });
    },
    onClose: (fn) => {
      ws.addEventListener('close', (e) => fn(e.code ?? 1006, e.reason ?? ''));
      // An error AFTER the handshake never produces a clean close, so it is
      // reported through the same path rather than silently ending the stream.
      ws.addEventListener('error', () => fn(1006, 'socket error'));
    },
  };
}

interface WebSocketLike {
  send(data: string): void;
  close(): void;
  addEventListener(
    type: 'open' | 'error',
    fn: () => void,
    opts?: { once: boolean },
  ): void;
  addEventListener(type: 'message', fn: (e: { data: unknown }) => void): void;
  addEventListener(type: 'close', fn: (e: { code?: number; reason?: string }) => void): void;
}

// ── the watch loop ─────────────────────────────────────────────────────────

/**
 * A stream has no page to preserve, so `--format json` has nothing to mean here
 * and the kernel's own `Output.line` refuses it. Refusing UP FRONT is the whole
 * point: the alternative is opening a socket, subscribing, and only failing when
 * the first event arrives — which could be minutes later, on a Space the caller
 * was then no longer watching.
 */
function assertStreamFormat(out: Output): void {
  if (out.format === 'json') {
    throw new CliError(
      '`tm8 event watch` emits a stream, not a page: use --format jsonl (or human)',
      EXIT_USAGE,
      { hint: '`tm8 event list --format json` is the paged read, and preserves `nextCursor`' },
    );
  }
}

/** One `events.poll` page, exactly as `invoke('events.poll')` unwraps it. */
export interface EventPollPage {
  items?: unknown;
  nextCursor?: unknown;
}

/** The fallback's transport seam — injected so the loop is testable dry. */
export type EventPoller = (sinceSeq: string) => Promise<EventPollPage>;

/**
 * How often the poll fallback re-asks. 1.5s: fast enough that a wait feels
 * event-driven, slow enough that a 300s worst case is 200 polls, not 3,000.
 */
const FALLBACK_POLL_INTERVAL_MS = 1_500;

/**
 * Drive one subscription to its end and return the exit code it earned.
 *
 * EXIT CODES, and each is a distinct sentence:
 *   0   the stream ended cleanly, or `--timeout` expired — or, with
 *       `--until-match`, a matching event arrived ON THE STREAM.
 *   4   the node REFUSED the subscribe (`control.refused`, `forbidden`).
 *   7   the socket dropped uncleanly — retryable, the caller lost their place.
 *       With `--until-match`: the fallback could not run either (no resume
 *       point, or the node never answered a poll), so nothing was learned.
 *   10  the node called one of OUR frames malformed. That is this CLI's defect,
 *       not the caller's, so it is never reported as a usage error.
 *   13  `--until-match` only: `--timeout` expired and no matching event exists
 *       past the resume point. A real answer — "it has not happened yet".
 *   14  `--until-match` only: MATCHED, but via the `events.poll` fallback after
 *       the socket was lost. The event is printed exactly as 0 would print it;
 *       the code differs so a script knows its live subscription did not
 *       survive, without parsing stderr.
 *   130 interrupted.
 */
export async function runWatch(opts: {
  request: WatchRequest;
  socket: WatchSocket;
  out: Output;
  timeoutMs: number | undefined;
  /** `--until-match`: settle on the FIRST matching event instead of streaming. */
  untilMatch?: boolean;
  /** The socket-down repair path. Required for the fallback to exist at all. */
  poll?: EventPoller;
  /** Test seam. Defaults to FALLBACK_POLL_INTERVAL_MS. */
  pollIntervalMs?: number;
}): Promise<ExitCode> {
  const { request, socket, out, timeoutMs } = opts;
  const untilMatch = opts.untilMatch ?? false;
  assertStreamFormat(out);
  const protocol = wsControlProtocol();

  /** The wait's absolute end. Shared by the timer and the poll fallback. */
  const deadline = timeoutMs === undefined ? undefined : Date.now() + timeoutMs;

  /**
   * The highest seq THIS process has durably seen — every stream event counts,
   * matching or not, because it is the fallback's resume point. Seeded from
   * `--after` so a resumed watch can degrade even if the socket dies at once.
   */
  let lastSeq: string | undefined = request.afterSeq;
  let interrupted = false;

  /** Set by whatever ENDED the stream; a plain close does not set it. */
  let verdict: ExitCode | undefined;
  let ended = false;
  let settle!: (code: ExitCode) => void;
  const finished = new Promise<ExitCode>((resolve) => {
    settle = resolve;
  });

  const stop = (): void => {
    try {
      socket.close();
    } catch {
      // Already gone. Closing a closed socket is not a failure worth reporting.
    }
  };

  /**
   * The documented socket-down repair path (`events.poll --after`), run when a
   * `--until-match` wait loses its socket before matching. Resumes from the
   * last seq the stream durably showed us; REFUSES to run with no resume point
   * rather than replaying a Space's history from 0 — a poll from nothing would
   * happily "match" an event that happened last week, and a wait that answers
   * from the past is worse than one that admits it lost its place.
   */
  const runPollFallback = async (): Promise<ExitCode> => {
    if (opts.poll === undefined || deadline === undefined) return EXIT_RETRYABLE;
    if (lastSeq === undefined) {
      out.warn(
        '`tm8 event watch`: the socket was lost before any event (and no --after was given), so ' +
          'the events.poll fallback has no seq to resume from and is refused — a poll from 0 could ' +
          'match history, not arrival. Re-run with --after <space-seq> to make the wait resumable.',
      );
      return EXIT_RETRYABLE;
    }
    out.warn(
      `\`tm8 event watch\`: the socket was lost — continuing this wait over events.poll from seq ${lastSeq}`,
    );
    let anyPollAnswered = false;
    const interval = opts.pollIntervalMs ?? FALLBACK_POLL_INTERVAL_MS;
    for (;;) {
      if (interrupted) return EXIT_INTERRUPTED;
      try {
        const page = await opts.poll(lastSeq);
        anyPollAnswered = true;
        const items = Array.isArray(page.items) ? page.items : [];
        for (const raw of items) {
          const event = (raw ?? {}) as Record<string, unknown>;
          const seq = event['seq'];
          if (typeof seq === 'number' || typeof seq === 'string') lastSeq = String(seq);
          if (matches(event, request)) {
            out.line(event, renderEvent);
            return EXIT_MATCHED_VIA_POLL;
          }
        }
        // The cursor covers rows the mapper skipped, so progress never stalls.
        if (typeof page.nextCursor === 'string' || typeof page.nextCursor === 'number') {
          lastSeq = String(page.nextCursor);
        }
      } catch {
        // The node is (still) unreachable. The deadline decides, not this poll.
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        // Timeout with answers is "it has not happened"; timeout where every
        // poll ALSO failed is "nothing was learned" — those are different
        // sentences and must be different codes.
        return anyPollAnswered ? EXIT_WAIT_TIMEOUT : EXIT_RETRYABLE;
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(interval, remaining)));
    }
  };

  socket.onClose((code) => {
    if (ended) return;
    ended = true;
    if (untilMatch && verdict === undefined) {
      // The wait is not over because the socket is: degrade to polling.
      void runPollFallback().then(settle);
      return;
    }
    settle(verdict ?? (CLEAN_CLOSE.has(code) ? EXIT_OK : EXIT_RETRYABLE));
  });

  socket.onMessage((text) => {
    // A frame can race the close (ours or the peer's). Once the wait settled,
    // nothing may reach stdout — a second "first match" is a contradiction.
    if (ended || verdict !== undefined) return;
    const frame = protocol.classify(text);

    if (frame.kind === 'unintelligible') {
      // Rendered faithfully to STDERR and never to stdout. Sanitising it would
      // hide a server-side drift from the gate that has to see it; printing it
      // as data would put a non-event into a caller's event stream.
      out.warn(`\`tm8 event watch\` could not read a frame (${frame.why}): ${frame.text.slice(0, 400)}`);
      return;
    }

    if (frame.kind === 'ack') {
      if (frame.ack === undefined) {
        // A `control.*` message this build does not recognise. It is NOT an
        // event, so it must not reach stdout — but it is also not a reason to
        // tear down a working subscription, so the stream continues.
        out.warn(
          '`tm8 event watch` received a control message this build does not recognise, and ' +
            `ignored it: ${JSON.stringify(frame.raw).slice(0, 400)}`,
        );
        return;
      }
      out.warn(renderAck(frame.ack));
      verdict = frame.ack.reason === 'forbidden' ? EXIT_FORBIDDEN : EXIT_PROTOCOL;
      stop();
      return;
    }

    // EVERY event advances the resume point, matching or not — the fallback
    // must never replay what this stream already showed.
    const seq = frame.event['seq'];
    if (typeof seq === 'number' || typeof seq === 'string') lastSeq = String(seq);

    if (!matches(frame.event, request)) return;
    // Faithful render: the event is emitted as it ARRIVED, not as a shape this
    // client re-derived. A node that adds a field must not be able to make the
    // CLI go silent, so nothing here validates before printing.
    out.line(frame.event, renderEvent);
    if (untilMatch) {
      verdict = EXIT_OK;
      stop();
    }
  });

  const timer =
    timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          verdict = untilMatch ? EXIT_WAIT_TIMEOUT : EXIT_OK;
          stop();
        }, timeoutMs);

  const onInterrupt = (): void => {
    interrupted = true;
    verdict = EXIT_INTERRUPTED;
    stop();
  };
  process.once('SIGINT', onInterrupt);

  try {
    try {
      await socket.open();
    } catch (err) {
      // With `--until-match`, a socket that never opened is the same repair
      // path as one that dropped: the wait continues over events.poll.
      if (!untilMatch || ended) throw err;
      ended = true;
      return await runPollFallback();
    }
    for (const frame of protocol.frames(request)) socket.send(protocol.encode(frame));
    if (request.eventTypes.length > 0 || request.entityIds.length > 0) {
      // DISCLOSED, not silently done. The contract's control frames carry no
      // filter field, so every event still crosses the wire and the narrowing
      // happens here. A caller who believed the node was filtering would
      // believe something false about where their data has travelled.
      out.note(
        '`tm8 event watch`: --type/--entity are applied LOCALLY — the contract\'s control frames ' +
          'carry no filter field, so the node still sends every event for this Space',
      );
    }
    return await finished;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    process.off('SIGINT', onInterrupt);
  }
}

/**
 * `tm8 event watch` — a live subscription to one Space's event stream.
 *
 * WHAT IS CLAIMED, and it is checkable against this build: the contract defines
 * client→server control frames, this command sends the contract's own
 * `subscribe` (and `resume`, and `presence`) frames, and it renders what comes
 * back. Nothing here says how long that will remain true, and nothing here
 * predicts what lands next — a diagnostic that shipped a roadmap would become a
 * lie the moment the roadmap moved, which is the failure this file has already
 * lived through once.
 *
 * WHAT A REFUSAL NOW LOOKS LIKE, and it is the point of the ack. Before the
 * control protocol, an unauthorized subscribe was SILENCE, indistinguishable
 * from a Space that was simply quiet: the caller waited forever on events they
 * would never be sent. `control.refused` is the only side of the authorizer a
 * client can see, and this command surfaces it as a refusal with an exit code
 * rather than as an empty stream.
 *
 * WHAT IT STILL DOES NOT CLAIM ABOUT THIS NODE. A socket that fails to open
 * teaches nothing about whether `events.subscribe` exists on the far side, so
 * this never renders `operation events.subscribe is not implemented on this
 * node` and never writes an observation into the availability ledger from a
 * transport failure.
 *
 * `--timeout <seconds>` BOUNDS THE WATCH. The global is documented as a
 * per-request timeout and a stream has no single request, so it is read as the
 * lifetime of the subscription — the nearest honest meaning, and the only way an
 * agent can ask for a bounded watch without this slot inventing a flag. Without
 * it the watch runs until the peer closes it or the caller interrupts (130).
 *
 * `--until-match` (F7) turns the watch into a BLOCKING WAIT: the first event
 * matching the local predicate is printed and the process exits — 0 from the
 * stream, 14 via the poll fallback, 13 if `--timeout` expires first. A wait
 * holds a process and a socket, so `--timeout` is REQUIRED with it and capped:
 * waits longer than 300 seconds belong to a scheduler that re-invokes this
 * command, not to a shell hanging on one process.
 */
const MAX_WAIT_SECONDS = 300;

async function eventWatch(cmd: CommandContext): Promise<ExitCode> {
  refuseMutationId('event watch', cmd.options.value('mutation-id'));
  assertStreamFormat(cmd.out);

  // Validated BEFORE a socket exists: a malformed invocation must not cost a
  // connection, and `--space` must be resolved before a frame can name it.
  const request = watchRequestFrom({ options: cmd.options, ctx: cmd.ctx });
  const untilMatch = cmd.options.bool('until-match');

  if (untilMatch) {
    if (cmd.ctx.timeoutMs === undefined) {
      throw new CliError(
        '`--until-match` is a blocking wait and must be bounded: pass --timeout <seconds>',
        EXIT_USAGE,
        { hint: `the cap is ${MAX_WAIT_SECONDS}s — longer waits belong to a scheduler re-invoking this command` },
      );
    }
    if (cmd.ctx.timeoutMs > MAX_WAIT_SECONDS * 1_000) {
      throw new CliError(
        `--timeout ${Math.round(cmd.ctx.timeoutMs / 1_000)}s exceeds the ${MAX_WAIT_SECONDS}s cap for ` +
          '`--until-match`: a longer wait holds a process and a socket that a scheduler should own',
        EXIT_USAGE,
        { hint: 'chain bounded waits (each resuming from the last seq) or schedule the re-check' },
      );
    }
  }

  // The fallback poller reuses the client seam rather than opening a second
  // one. `events.poll` is exempt from the read-cache by construction, so a
  // revalidation-style loop can never be served its own cached answer.
  const client = clientFor(cmd.ctx);
  const poll: EventPoller = async (sinceSeq) =>
    await client.invoke<EventPollPage>('events.poll', {
      params: { spaceId: request.spaceId },
      query: { since: sinceSeq },
    });

  return await runWatch({
    request,
    socket: runtimeSocket(cmd.ctx),
    out: cmd.out,
    timeoutMs: cmd.ctx.timeoutMs,
    untilMatch,
    ...(untilMatch ? { poll } : {}),
  });
}

/** Local narrowing. Empty filters match everything — never nothing. */
function matches(event: Record<string, unknown>, request: WatchRequest): boolean {
  if (request.eventTypes.length > 0) {
    const type = event['type'];
    if (typeof type !== 'string' || !request.eventTypes.includes(type)) return false;
  }
  if (request.entityIds.length > 0) {
    const subject = subjectId(event);
    if (subject === undefined || !request.entityIds.includes(subject)) return false;
  }
  return true;
}

function renderAck(ack: WorkspaceControlAck): string {
  const scope = ack.spaceId === undefined ? '' : ` for Space ${ack.spaceId}`;
  const because =
    ack.reason === 'forbidden'
      ? 'the node refused it: this caller may not read that Space'
      : 'the node called the frame malformed, which is a defect in this CLI rather than in the request';
  return (
    `\`tm8 event watch\`: the \`${ack.frame}\` frame was REFUSED${scope} — ${because}. ` +
    'No events will arrive on this subscription.'
  );
}

// ── rendering ──────────────────────────────────────────────────────────────

interface Page {
  items?: unknown;
  nextCursor?: unknown;
}

/**
 * The id a follow-up command would need, read off whichever payload variant an
 * event carries. Every `WorkspaceEvent` carries its full typed payload, so
 * there is always something addressable; this names it rather than making the
 * reader re-fetch the JSON to find out which entity an event was about.
 */
function subjectId(event: Record<string, unknown>): string | undefined {
  for (const key of ['entityId', 'anchorId', 'channelId']) {
    const v = event[key];
    if (typeof v === 'string') return v;
  }
  for (const key of ['entity', 'edge', 'message', 'activity', 'notification', 'handoff', 'delivery', 'profile']) {
    const nested = event[key];
    if (nested !== null && typeof nested === 'object') {
      const id = (nested as { id?: unknown }).id;
      if (typeof id === 'string') return id;
    }
  }
  return undefined;
}

/**
 * ONE event, ONE line — and the SAME line whether it arrived from `event list`'s
 * page or `event watch`'s socket. Two renderers would be two shapes, and a
 * caller who piped one into a habit built on the other would be silently reading
 * a different thing.
 */
function renderEvent(raw: unknown): string {
  const event = (raw ?? {}) as Record<string, unknown>;
  const parts = [
    String(event['seq'] ?? '?'),
    String(event['type'] ?? '?'),
    String(event['occurredAt'] ?? ''),
  ];
  const subject = subjectId(event);
  if (subject !== undefined) parts.push(subject);
  // A clientMutationId is a CORRELATION identifier, published in read DTOs by
  // design — it is not a secret and not a capability. Rendering it is how a
  // caller reconciles an event with the mutation it issued.
  const cmid = event['clientMutationId'];
  if (typeof cmid === 'string') parts.push(`cmid=${cmid}`);
  return parts.filter((p) => p !== '').join('  ');
}

/**
 * Human is a rendering of the SAME DTO json emits, never a second shape and
 * never a subset that drops an id. `nextCursor` is printed as the literal flag
 * the next invocation takes, because that is the one value a caller must not
 * have to reconstruct.
 */
function renderPage(dto: unknown): string {
  const page = (dto ?? {}) as Page;
  const items = Array.isArray(page.items) ? page.items : [];
  const lines = items.map((raw) => renderEvent(raw));

  if (lines.length === 0) lines.push('no events');
  lines.push(
    typeof page.nextCursor === 'string' || typeof page.nextCursor === 'number'
      ? `next: tm8 event list --after ${String(page.nextCursor)}`
      : 'next: the Server returned no cursor',
  );
  return lines.join('\n');
}

export const EVENT_COMMANDS: CommandModule[] = [
  { path: ['event', 'list'], run: eventList },
  { path: ['event', 'watch'], run: eventWatch },
];
