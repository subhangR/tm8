/**
 * The live PTY transport — one WebSocket per session, with offset resume.
 *
 * Ported from maestro's `webTerminal` (maestro-ui/src/platform/terminal.ts).
 * Its resume accounting, replay hydration, bounded pending-send queue, wake
 * reconnect staggering and stream-identity handling intentionally stay aligned
 * with Maestro. tm8 differs in exactly two server-integration seams:
 *  - Maestro attaches at `/pty`; tm8 attaches at `/v2/ws?sessionId=<id>` (the
 *    URL represented by `execution.streams.attach`).
 *  - Maestro can bootstrap a plain PTY through `/pty/spawn`; tm8 does not,
 *    because `execution.spawn` creates the PTY before this transport attaches.
 *
 * This REPLACES the 500ms `GET /pty/output` poll. The poll was the terminal lag:
 * it repainted on a fixed tick regardless of output, so a fast agent arrived in
 * visible bursts and an idle one still cost a request every half-second per
 * session. This is push, coalesced server-side into 16ms frames.
 *
 * WHAT MAKES IT CORRECT — offsets are RAW byte counts end to end:
 *  - the client sends `?offset=<rawBytesSeen>` on every (re)connect;
 *  - the server answers with ONE `attached{base,gap,next,hasReplay,epoch}` text
 *    frame, then (iff hasReplay) exactly ONE binary replay frame, then live
 *    binary frames;
 *  - the client SNAPS its counter to `attached.next` and never computes
 *    `base + replay.byteLength` — the replay slice is sanitized (device queries
 *    stripped) and so is SHORTER than the raw span it stands for. Deriving the
 *    offset from its length silently skips bytes on the next reconnect;
 *  - the replay frame is DISPLAY-ONLY and is not counted, because `next` already
 *    accounts for it.
 *
 * The terminal is reset (and `onReattach` fires) on exactly three conditions:
 * a changed `epoch` (an authoritative respawn), `gap > 0` (the ring evicted
 * bytes, an honest bounded loss), or — only when no epoch is present — the
 * legacy `base < prevReceived` rewind heuristic. On an ordinary resume none
 * holds, so the streaming UTF-8 decoder PERSISTS: a multi-byte glyph split
 * across the disconnect boundary is completed by the replay delta rather than
 * being emitted as a replacement char.
 */

import {
  PTY_GRANT_PROTOCOL_PREFIX,
  PTY_WS_PROTOCOL,
  type StreamAttachGrant,
} from '@tm8/contract';

import { parseControlFrame } from './ptyProtocol.js';

export interface ReplayInfo {
  kind: 'delta' | 'snapshot';
}

type OutputHandler = (id: string, data: string) => void;
type ReplayHandler = (id: string, data: string, info: ReplayInfo) => void;
type ExitHandler = (id: string, exitCode?: number | null) => void;
type SizeHandler = (id: string, size: { cols: number; rows: number; live?: boolean }) => void;
type ReattachHandler = (id: string) => void;
export type PtyGrantProvider = (id: string) => Promise<StreamAttachGrant>;

const _sockets = new Map<string, WebSocket>();
/** Same-origin route prefix for the tm8 node that owns each session's PTY. */
const _serverBaseUrls = new Map<string, string>();
/**
 * Per-session bearer reader retained only for authenticated HTTP support
 * routes such as clipboard upload. WebSockets never read it and never put a
 * long-lived credential in a URL; PTY connects use `_grantProviders` below.
 */
const _authTokenReaders = new Map<string, () => string | null>();
/** Fresh, one-shot capability minter. Called for every connect and reconnect. */
const _grantProviders = new Map<string, PtyGrantProvider>();
/** The server-authorized mode of the current/future connection. */
const _attachModes = new Map<string, 'view' | 'drive'>();
/** Async grant requests in flight; prevents reconnect/wake stampedes. */
const _connecting = new Set<string>();
/** Invalidates a late grant response after close/reopen of the same id. */
const _connectGenerations = new Map<string, number>();
const _pendingSends = new Map<string, { frames: Array<string | Uint8Array>; bytes: number }>();
/** Fail-closed after queue overflow until a socket successfully opens. */
const _overflowLatched = new Set<string>();
const _outputHandlers: OutputHandler[] = [];
const _replayHandlers: ReplayHandler[] = [];
const _exitHandlers: ExitHandler[] = [];
const _sizeHandlers: SizeHandler[] = [];
const _reattachHandlers: ReattachHandler[] = [];

/**
 * Session ids the app currently wants attached. ONLY these auto-reconnect after
 * a transport drop — a socket that closes for a session we have since detached
 * from must not come back to life.
 */
const _activeSessions = new Set<string>();
/**
 * Ids intentionally SUSPENDED because their terminal is offscreen. A suspended
 * id stays in `_activeSessions` (the app still wants it, and resume() must
 * reopen it) but its socket is deliberately closed, so `onclose` must NOT
 * auto-reconnect it or tear down its resume state while this flag is set. The
 * server-side PTY keeps running and buffering into its ring, so resume() reopens
 * at the preserved offset and the server replays only the delta.
 */
const _suspended = new Set<string>();
/**
 * Ids for which a real `{type:'exit'}` frame already fired `onExit`, so the
 * close that follows it (the server closes subscriber sockets right after that
 * frame) is not mistaken for a transport drop worth reconnecting.
 */
const _exitedSessions = new Set<string>();
const _reconnectAttempts = new Map<string, number>();
const _reconnectTimers = new Map<string, number>();
/** Sessions whose reconnect timer is a wake-stagger slot, not backoff. */
const _wakeStaggered = new Set<string>();

const MAX_PENDING_BYTES = 256 * 1024;
const MAX_PENDING_ENTRIES = 1024;
const STAGGER_STEP_MS = 250;
const MAX_STAGGER_MS = 2000;

/**
 * One streaming decoder per session. PTY output arrives as raw bytes split on
 * arbitrary frame boundaries, so a multi-byte UTF-8 glyph (box-drawing, emoji,
 * the symbols agent TUIs print) can straddle two frames. A streaming decoder
 * holds the incomplete tail instead of emitting `�`. Per-session so
 * interleaved streams cannot bleed partial bytes into each other.
 */
const _decoders = new Map<string, TextDecoder>();
/** Per-session RAW byte offset authoritatively consumed; sent as `?offset=`. */
const _received = new Map<string, number>();
/** Sessions whose NEXT binary frame is the single display-only replay frame. */
const _pendingReplay = new Map<string, ReplayInfo['kind']>();
/** Last `epoch` seen per session. Compared by EQUALITY ONLY. */
const _epochs = new Map<string, string>();

function _decodeFor(id: string, bytes: Uint8Array): string {
  let dec = _decoders.get(id);
  if (!dec) {
    dec = new TextDecoder();
    _decoders.set(id, dec);
  }
  return dec.decode(bytes, { stream: true });
}

interface AttachedFrame {
  base: number;
  gap: number;
  next: number;
  hasReplay: boolean;
  replayKind?: ReplayInfo['kind'];
  epoch?: string;
}

/** Apply an `attached` ack — the heart of offset resume and stream identity. */
function _handleAttached(id: string, frame: AttachedFrame): void {
  const prevReceived = _received.get(id) ?? 0;

  // GAP resets regardless of stream identity: evicted bytes leave a hole, so
  // what is on screen can no longer be a clean prefix of the incoming stream.
  let reset = frame.gap > 0;

  if (frame.epoch !== undefined) {
    // EPOCH is authoritative: a changed epoch resets; the same (or a first-seen)
    // epoch resumes and SUPERSEDES the legacy base-rewind heuristic, because a
    // fresh stream can emit at least as many bytes as the old one.
    const prevEpoch = _epochs.get(id);
    if (prevEpoch !== undefined && prevEpoch !== frame.epoch) reset = true;
    _epochs.set(id, frame.epoch);
  } else if (frame.base < prevReceived) {
    // LEGACY rewind: no epoch to compare, so fall back to the byte-count proxy.
    reset = true;
  }

  if (reset) {
    _decoders.delete(id);
    for (const h of _reattachHandlers) h(id);
  }
  // Snap to the server's authoritative RAW offset — never base + replay length.
  _received.set(id, frame.next);
  // Replay expectation is fully (re)determined by THIS ack: a stale flag from a
  // prior attached whose replay frame never arrived must not cause this
  // connect's first LIVE frame to be skip-counted.
  if (frame.hasReplay) _pendingReplay.set(id, frame.replayKind ?? 'delta');
  else _pendingReplay.delete(id);
}

function _clearReconnectTimer(id: string): void {
  const timer = _reconnectTimers.get(id);
  if (timer !== undefined) {
    window.clearTimeout(timer);
    _reconnectTimers.delete(id);
  }
  _wakeStaggered.delete(id);
}

/** Exponential backoff + jitter. */
function _scheduleReconnect(id: string): void {
  if (!_activeSessions.has(id)) return;
  _clearReconnectTimer(id);
  const attempts = _reconnectAttempts.get(id) ?? 0;
  const baseDelay = Math.min(1000 * Math.pow(2, attempts), 30000);
  const delay = baseDelay + Math.random() * baseDelay * 0.5;
  _reconnectAttempts.set(id, attempts + 1);
  const timer = window.setTimeout(() => {
    _reconnectTimers.delete(id);
    if (!_activeSessions.has(id)) return;
    _ensureSocket(id);
  }, delay);
  _reconnectTimers.set(id, timer);
}

/**
 * The PTY socket URL. Same origin as the page (the vite dev server proxies `/v2`
 * with `ws: true`), so this works identically in dev and against the built
 * bundle the server serves itself.
 */
function _ptyUrl(id: string, offset: number, grantedUrl?: string): string {
  const serverBaseUrl = _serverBaseUrls.get(id) ?? '';
  const localPath = grantedUrl ?? `/v2/ws?sessionId=${encodeURIComponent(id)}`;
  const absolute = /^https?:\/\//i.test(localPath) || /^wss?:\/\//i.test(localPath);
  const pageOrigin = window.location.origin
    || `${window.location.protocol}//${window.location.host}`;
  const raw = absolute
    ? localPath
    : `${pageOrigin}${serverBaseUrl}${localPath.startsWith('/') ? localPath : `/${localPath}`}`;
  const url = new URL(raw);
  if (url.protocol === 'http:') url.protocol = 'ws:';
  else if (url.protocol === 'https:') url.protocol = 'wss:';
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    throw new Error('PTY grant URL must use http(s) or ws(s)');
  }
  // A grant-bearing URL is a server defect and must not be dialled. Deleting
  // it would hide the leak in logs/history; refusal makes the invariant loud.
  if (url.searchParams.has('token') || url.href.includes('tm8g_') || url.href.includes('tm8s_')) {
    throw new Error('PTY grant URL contains credential material');
  }
  url.searchParams.set('offset', String(offset));
  return url.href;
}

function _openSocket(id: string, grant?: StreamAttachGrant): WebSocket {
  const offset = _received.get(id) ?? 0;
  let ws: WebSocket;
  if (grant) {
    if (
      grant.workSessionId !== id ||
      (grant.mode !== 'view' && grant.mode !== 'drive') ||
      typeof grant.token !== 'string' ||
      grant.token.length === 0 ||
      Date.parse(grant.expiresAt) <= Date.now()
    ) {
      throw new Error('invalid or expired PTY attach grant');
    }
    _attachModes.set(id, grant.mode);
    if (grant.mode === 'view') {
      // Nothing typed while a drive request was awaiting its answer may be
      // replayed after the server narrowed the result to view.
      _pendingSends.delete(id);
    }
    ws = new WebSocket(_ptyUrl(id, offset, grant.url), [
      PTY_WS_PROTOCOL,
      `${PTY_GRANT_PROTOCOL_PREFIX}${grant.token}`,
    ]);
  } else {
    // Loopback/dev compatibility. Production wires a grant provider.
    ws = new WebSocket(_ptyUrl(id, offset));
  }
  ws.binaryType = 'arraybuffer';

  _wireSocket(id, ws, grant !== undefined);
  _sockets.set(id, ws);
  return ws;
}

function _ensureSocket(id: string): WebSocket | undefined {
  const existing = _sockets.get(id);
  if (
    existing &&
    existing.readyState !== WebSocket.CLOSED &&
    existing.readyState !== WebSocket.CLOSING
  ) {
    return existing;
  }

  const provider = _grantProviders.get(id);
  if (!provider) return _openSocket(id);
  if (_connecting.has(id)) return undefined;

  _connecting.add(id);
  const generation = _connectGenerations.get(id) ?? 0;
  void provider(id)
    .then((grant) => {
      _connecting.delete(id);
      if (
        !_activeSessions.has(id) ||
        _suspended.has(id) ||
        (_connectGenerations.get(id) ?? 0) !== generation
      ) return;
      _openSocket(id, grant);
    })
    .catch(() => {
      _connecting.delete(id);
      if (_activeSessions.has(id) && !_suspended.has(id)) _scheduleReconnect(id);
    });
  return undefined;
}

function _wireSocket(id: string, ws: WebSocket, requirePublicProtocol: boolean): void {

  ws.onopen = () => {
    if (requirePublicProtocol && ws.protocol !== PTY_WS_PROTOCOL) {
      ws.close(1002, 'unexpected PTY subprotocol');
      return;
    }
    _reconnectAttempts.set(id, 0);
    // A successful open is the only thing that clears the fail-closed latch.
    // The overflowing queue itself was already discarded; this just permits
    // input produced after the reconnect to flow again.
    _overflowLatched.delete(id);
    const pending = _pendingSends.get(id);
    if (pending && _attachModes.get(id) === 'drive') {
      for (const frame of pending.frames) ws.send(frame);
      _pendingSends.delete(id);
    }
  };

  ws.onmessage = (ev) => {
    if (typeof ev.data === 'string') {
      const frame = parseControlFrame(ev.data);
      if (frame) {
        if (frame.type === 'exit') {
          // A real process exit: mark it so the close that follows is recognized
          // as a logical end rather than a transport drop to reconnect.
          _exitedSessions.add(id);
          _activeSessions.delete(id);
          for (const h of _exitHandlers) h(id, frame.exitCode);
          return;
        }
        if (frame.type === 'size') {
          for (const h of _sizeHandlers) {
            h(id, { cols: frame.cols, rows: frame.rows, live: frame.live });
          }
          return;
        }
        if (frame.type === 'attached') {
          _handleAttached(id, frame);
          return;
        }
      }
      // Not a control frame — ordinary output that happens to be a text frame.
      for (const h of _outputHandlers) h(id, ev.data);
      return;
    }

    const buf = new Uint8Array(ev.data as ArrayBuffer);
    const replayKind = _pendingReplay.get(id);
    // A SNAPSHOT is a full-state repaint, not a continuation, so it must NOT run
    // through the streaming decoder's partial-glyph tail — decode it standalone.
    // A DELTA continues the live stream and uses the persistent decoder.
    const text =
      replayKind === 'snapshot' ? new TextDecoder().decode(buf) : _decodeFor(id, buf);
    if (replayKind) {
      // The single display-only replay frame following an `attached` ack:
      // delivered through the hydration channel and NOT counted — `attached.next`
      // already accounts for the raw stream it represents.
      _pendingReplay.delete(id);
      if (_replayHandlers.length > 0) {
        for (const h of _replayHandlers) h(id, text, { kind: replayKind });
      } else {
        for (const h of _outputHandlers) h(id, text);
      }
      return;
    }
    for (const h of _outputHandlers) h(id, text);
    // A LIVE frame — advance the offset by its RAW byte length.
    _received.set(id, (_received.get(id) ?? 0) + buf.byteLength);
  };

  ws.onclose = (ev) => {
    if (_sockets.get(id) === ws) _sockets.delete(id);

    // INTENTIONAL SUSPEND: triggered by suspend() for an offscreen terminal. Do
    // NOT reconnect and do NOT tear down resume state — resume() reopens at the
    // preserved offset and the server replays the delta.
    if (_suspended.has(id)) {
      _clearReconnectTimer(id);
      return;
    }

    // NOTE: the streaming decoder is deliberately NOT dropped here. Under offset
    // resume it must persist across a transport drop so a multi-byte glyph split
    // across the disconnect boundary is completed by the reconnect's replay
    // delta. It is reset only on a gap/rewind/epoch change, or a logical end.
    _clearReconnectTimer(id);

    const alreadyExited = _exitedSessions.has(id);
    _exitedSessions.delete(id);

    // LOGICAL END: 1011 means the server has no live PTY for this session, and
    // alreadyExited means a real process exit already arrived. Either way the
    // session is over — tear down all per-session offset state.
    if (ev.code === 1011 || alreadyExited) {
      _activeSessions.delete(id);
      _suspended.delete(id);
      _reconnectAttempts.delete(id);
      _decoders.delete(id);
      _received.delete(id);
      _pendingReplay.delete(id);
      _epochs.delete(id);
      _pendingSends.delete(id);
      _overflowLatched.delete(id);
      _serverBaseUrls.delete(id);
      _grantProviders.delete(id);
      _attachModes.delete(id);
      _connecting.delete(id);
      if (!alreadyExited) {
        for (const h of _exitHandlers) h(id, null);
      }
      return;
    }

    // TRANSPORT DROP: reload, tab switch, network blip, laptop sleep. The
    // server-hosted PTY is still alive, so reconnect with backoff as long as the
    // app still wants this session — keeping the decoder and offset so the
    // reconnect resumes exactly where we left off.
    if (_activeSessions.has(id)) {
      _scheduleReconnect(id);
    } else {
      _reconnectAttempts.delete(id);
      _decoders.delete(id);
      _received.delete(id);
      _pendingReplay.delete(id);
      _epochs.delete(id);
      _overflowLatched.delete(id);
    }
  };

}

let _wakeListenersRegistered = false;

/** Reattach active sockets after wake/network recovery without a stampede. */
function _reattachActiveSockets(): void {
  let immediateUsed = false;
  let staggerCount = 0;
  for (const id of _activeSessions) {
    if (_suspended.has(id)) continue;
    const ws = _sockets.get(id);
    if (
      ws &&
      ws.readyState !== WebSocket.CLOSED &&
      ws.readyState !== WebSocket.CLOSING
    ) {
      continue;
    }
    if (_wakeStaggered.has(id)) continue;

    _clearReconnectTimer(id);
    _reconnectAttempts.set(id, 0);

    if (!immediateUsed) {
      immediateUsed = true;
      _ensureSocket(id);
      continue;
    }

    staggerCount += 1;
    const delay =
      Math.min(staggerCount * STAGGER_STEP_MS, MAX_STAGGER_MS) +
      Math.random() * STAGGER_STEP_MS;
    _wakeStaggered.add(id);
    const timer = window.setTimeout(() => {
      _reconnectTimers.delete(id);
      _wakeStaggered.delete(id);
      if (!_activeSessions.has(id)) return;
      const current = _sockets.get(id);
      if (
        current &&
        current.readyState !== WebSocket.CLOSED &&
        current.readyState !== WebSocket.CLOSING
      ) {
        return;
      }
      _ensureSocket(id);
    }, delay);
    _reconnectTimers.set(id, timer);
  }
}

function _registerWakeListeners(): void {
  if (_wakeListenersRegistered) return;
  if (typeof document === 'undefined' || typeof window === 'undefined') return;
  _wakeListenersRegistered = true;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') _reattachActiveSockets();
  });
  window.addEventListener('online', _reattachActiveSockets);
}

function _frameSize(frame: string | Uint8Array): number {
  return typeof frame === 'string' ? frame.length : frame.byteLength;
}

/**
 * Queue a disconnected input/resize frame with Maestro's deterministic bounds.
 * Overflow discards the entire queue and latches the session until a real open;
 * retaining a tail could execute a partial paste after reconnect.
 */
function _enqueuePending(id: string, frame: string | Uint8Array): void {
  if (_overflowLatched.has(id)) return;

  const entry = _pendingSends.get(id) ?? { frames: [], bytes: 0 };
  entry.frames.push(frame);
  entry.bytes += _frameSize(frame);

  if (entry.bytes > MAX_PENDING_BYTES || entry.frames.length > MAX_PENDING_ENTRIES) {
    _pendingSends.delete(id);
    _overflowLatched.add(id);
    console.warn(
      `[ptyTransport] pending input overflow for ${id}: queued input exceeded ` +
        `${MAX_PENDING_BYTES}B / ${MAX_PENDING_ENTRIES} entries — dropping ALL queued ` +
        'input until reconnect (fail-closed; no partial paste is replayed)',
    );
    return;
  }
  _pendingSends.set(id, entry);
}

function _sendFrame(id: string, frame: string | Uint8Array): void {
  // Server enforcement is authoritative; this client-side gate keeps a
  // view-only tab from even queuing input/resize while disconnected.
  if (_attachModes.get(id) === 'view') return;
  const ws = _sockets.get(id);
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(frame);
    return;
  }
  _enqueuePending(id, frame);
}

export const ptyTransport = {
  /** Attach to a session's live stream. Idempotent. */
  openSession(
    id: string,
    serverBaseUrl = '',
    getAuthToken?: () => string | null,
    getGrant?: PtyGrantProvider,
    requestedMode: 'view' | 'drive' = 'drive',
  ): void {
    _registerWakeListeners();
    // The selected server is represented by a same-origin route prefix. Keep
    // it with the session so reconnect, wake, suspend/resume, and full replay
    // all return to the node that actually owns the PTY.
    _serverBaseUrls.set(id, serverBaseUrl.replace(/\/$/, ''));
    if (getAuthToken) _authTokenReaders.set(id, getAuthToken);
    else _authTokenReaders.delete(id);
    if (getGrant) _grantProviders.set(id, getGrant);
    else _grantProviders.delete(id);
    _attachModes.set(id, requestedMode);
    _connectGenerations.set(id, (_connectGenerations.get(id) ?? 0) + 1);
    _connecting.delete(id);
    _activeSessions.add(id);
    // A fresh attach is never born suspended (a prior use of this id may have
    // left the flag set), and starts its offset accounting at 0.
    _suspended.delete(id);
    _received.delete(id);
    _pendingReplay.delete(id);
    _epochs.delete(id);
    _exitedSessions.delete(id);
    _decoders.delete(id);
    // A newly attached PTY must never inherit queued input from a prior logical
    // use of the same id.
    _pendingSends.delete(id);
    _ensureSocket(id);
  },

  /** Detach permanently and drop every trace of the session. */
  closeSession(id: string): void {
    // Remove from the active set FIRST: ws.close() can synchronously fire
    // onclose, and that handler must see this id as no-longer-active so it does
    // not schedule a reconnect.
    _activeSessions.delete(id);
    _suspended.delete(id);
    _clearReconnectTimer(id);
    _reconnectAttempts.delete(id);
    _exitedSessions.delete(id);
    _decoders.delete(id);
    _received.delete(id);
    _pendingReplay.delete(id);
    _epochs.delete(id);
    _pendingSends.delete(id);
    _overflowLatched.delete(id);
    _serverBaseUrls.delete(id);
    _authTokenReaders.delete(id);
    _grantProviders.delete(id);
    _attachModes.delete(id);
    _connecting.delete(id);
    _connectGenerations.set(id, (_connectGenerations.get(id) ?? 0) + 1);
    const ws = _sockets.get(id);
    if (ws) {
      _sockets.delete(id);
      try {
        ws.close();
      } catch {
        /* already closing */
      }
    }
  },

  /**
   * Send keystrokes to the PTY as a BINARY frame.
   *
   * Binary, not text: a text frame is a JSON control message on this protocol,
   * so routing input through it would make a user typing `{"type":"resize"...}`
   * a control-frame injection. Raw bytes cannot be confused for control.
   *
   * While the socket is down, Maestro's bounded fail-closed queue preserves the
   * whole input sequence. Overflow discards the entire queue and latches further
   * writes until a successful open, so a partial paste can never execute later.
   */
  write(id: string, data: string): void {
    _sendFrame(id, new TextEncoder().encode(data));
  },

  /**
   * The node that owns this session's PTY, and the pass to reach it with.
   *
   * Anything that has to make an HTTP call ON BEHALF of a live session — the
   * clipboard image handoff is the first — must reach the SAME node, because a
   * path minted on one node means nothing to a PTY running on another. That
   * binding already exists here; exposing it is what keeps a second, drifting
   * copy of it from being invented at the call site.
   */
  endpointFor(id: string): { baseUrl: string; authToken: string | null } | null {
    const baseUrl = _serverBaseUrls.get(id);
    if (baseUrl === undefined) return null;
    return { baseUrl, authToken: _authTokenReaders.get(id)?.() ?? null };
  },

  /**
   * Tell the server the grid size (a JSON text control frame).
   *
   * `force` asks the server to drive a SIGWINCH even when the geometry it
   * already has matches — the one signal that makes a full-screen agent TUI
   * repaint over a freshly rendered replay. Send it at most ONCE per attach:
   * the server's equality check exists to terminate echo loops, and `force` is
   * a deliberate hole in it.
   */
  resize(id: string, cols: number, rows: number, force = false): void {
    _sendFrame(
      id,
      JSON.stringify({ type: 'resize', cols, rows, ...(force ? { force: true } : {}) }),
    );
  },

  /**
   * SUSPEND an offscreen session's live stream: close its socket so the server
   * stops sending and the client stops VT-parsing, WITHOUT killing the
   * server-side PTY (it keeps running and buffering into its ring) and WITHOUT
   * tearing down the resume offset. This is what turns the cost of N streaming
   * agents from O(running) into O(visible).
   *
   * CALLER CONTRACT: flush any buffered output into xterm BEFORE calling this.
   * `_received` advances as frames ARRIVE, which is ahead of what the write
   * scheduler has handed to xterm; suspending without flushing first would
   * resume at an offset past bytes the terminal never rendered — a silent hole
   * with no gap marker, because the server's accounting stays perfectly correct
   * and the loss is entirely client-side. The visibility driver honors this.
   */
  suspend(id: string): void {
    if (!_activeSessions.has(id) || _suspended.has(id)) return;
    _suspended.add(id);
    // Cancel any in-flight reconnect so nothing races the close and reopens the
    // socket behind resume()'s back.
    _clearReconnectTimer(id);
    _reconnectAttempts.set(id, 0);
    const ws = _sockets.get(id);
    if (ws) {
      _sockets.delete(id);
      try {
        ws.close();
      } catch {
        /* already closing */
      }
    }
  },

  /** RESUME a suspended session — reopen at the preserved offset. */
  resume(id: string): void {
    if (!_suspended.has(id)) return;
    _suspended.delete(id);
    if (_activeSessions.has(id)) _ensureSocket(id);
  },

  onOutput(handler: OutputHandler): () => void {
    _outputHandlers.push(handler);
    return () => {
      const i = _outputHandlers.indexOf(handler);
      if (i >= 0) _outputHandlers.splice(i, 1);
    };
  },

  onReplay(handler: ReplayHandler): () => void {
    _replayHandlers.push(handler);
    return () => {
      const i = _replayHandlers.indexOf(handler);
      if (i >= 0) _replayHandlers.splice(i, 1);
    };
  },

  onExit(handler: ExitHandler): () => void {
    _exitHandlers.push(handler);
    return () => {
      const i = _exitHandlers.indexOf(handler);
      if (i >= 0) _exitHandlers.splice(i, 1);
    };
  },

  onSize(handler: SizeHandler): () => void {
    _sizeHandlers.push(handler);
    return () => {
      const i = _sizeHandlers.indexOf(handler);
      if (i >= 0) _sizeHandlers.splice(i, 1);
    };
  },

  /**
   * A fresh xterm is remounting for an already-active PTY. Reset the resume
   * offset and force a new attach so the server hydrates the full retained ring
   * into the empty screen rather than returning only a delta.
   */
  requestFullReplay(id: string): void {
    if (!_activeSessions.has(id)) return;
    _clearReconnectTimer(id);
    _reconnectAttempts.set(id, 0);
    _received.set(id, 0);
    _decoders.delete(id);
    _pendingReplay.delete(id);
    _epochs.delete(id);
    _suspended.delete(id);
    const old = _sockets.get(id);
    if (old) {
      _sockets.delete(id);
      try {
        old.close();
      } catch {
        /* already closing */
      }
    }
    _ensureSocket(id);
  },

  /** Fires when the stream identity changed and the terminal must be cleared. */
  onReattach(handler: ReattachHandler): () => void {
    _reattachHandlers.push(handler);
    return () => {
      const i = _reattachHandlers.indexOf(handler);
      if (i >= 0) _reattachHandlers.splice(i, 1);
    };
  },

  /** Test-only: is this id currently suspended? */
  __isSuspended(id: string): boolean {
    return _suspended.has(id);
  },

  /** Test-only: the raw offset the client has consumed. */
  __received(id: string): number {
    return _received.get(id) ?? 0;
  },
};
