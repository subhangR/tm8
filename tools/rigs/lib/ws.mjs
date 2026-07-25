/**
 * WebSocket frame recording, dependency-free (node's global `WebSocket`).
 *
 * Everything the perf rig measures is derived from ONE primitive: a timestamped
 * log of every frame that crossed the socket. We record raw samples and compute
 * statistics afterwards rather than accumulating running averages, so a
 * disputed number can always be recomputed from the artifact.
 *
 * Timing note: `performance.now()` is a monotonic high-resolution clock —
 * immune to NTP steps mid-measurement, which `Date.now()` is not. Every
 * `tMs` below is relative to the recorder's `origin`.
 */

/** Node 22+ ships a spec-compliant global WebSocket; no `ws` dependency needed. */
export function assertWebSocketAvailable() {
  if (typeof WebSocket === 'undefined') {
    throw new Error(
      'No global WebSocket. These rigs need Node >= 22 (this repo runs Node 25); ' +
        'run them with `node`, not an older runtime.',
    );
  }
}

export class FrameRecorder {
  constructor(label) {
    this.label = label;
    this.origin = performance.now();
    /** @type {Array<{tMs:number, kind:'text'|'binary', bytes:number, text?:string}>} */
    this.frames = [];
    this.events = [];
  }

  mark(name, extra = {}) {
    this.events.push({ name, tMs: performance.now() - this.origin, ...extra });
  }

  record(data) {
    const tMs = performance.now() - this.origin;
    if (typeof data === 'string') {
      this.frames.push({ tMs, kind: 'text', bytes: Buffer.byteLength(data, 'utf8'), text: data });
    } else {
      const bytes = data instanceof ArrayBuffer ? data.byteLength : (data?.byteLength ?? 0);
      this.frames.push({ tMs, kind: 'binary', bytes });
    }
  }

  get binaryFrames() {
    return this.frames.filter((f) => f.kind === 'binary');
  }

  /** Gaps between consecutive BINARY frames — the PTY output cadence. */
  interArrivalMs(fromIndex = 0) {
    const bins = this.binaryFrames.slice(fromIndex);
    const gaps = [];
    for (let i = 1; i < bins.length; i++) gaps.push(bins[i].tMs - bins[i - 1].tMs);
    return gaps;
  }

  totalBytes(kind = 'binary') {
    return this.frames.filter((f) => f.kind === kind).reduce((a, f) => a + f.bytes, 0);
  }

  eventAt(name) {
    return this.events.find((e) => e.name === name) ?? null;
  }
}

/**
 * Open a socket and record every frame until `stop()`.
 *
 * The returned handle never throws on close — a perf run that dies because the
 * target restarted must still emit whatever it captured, since a partial
 * baseline beats no baseline.
 */
export function openRecordedSocket(url, { label = url, binaryType = 'arraybuffer', onFrame } = {}) {
  assertWebSocketAvailable();
  const rec = new FrameRecorder(label);
  const ws = new WebSocket(url);
  ws.binaryType = binaryType;

  let resolveOpen;
  let rejectOpen;
  const opened = new Promise((resolve, reject) => {
    resolveOpen = resolve;
    rejectOpen = reject;
  });
  let resolveClosed;
  const closed = new Promise((resolve) => {
    resolveClosed = resolve;
  });

  ws.addEventListener('open', () => {
    rec.mark('open');
    resolveOpen(rec);
  });
  ws.addEventListener('message', (ev) => {
    rec.record(ev.data);
    onFrame?.(ev.data, rec);
  });
  ws.addEventListener('error', () => {
    rec.mark('error');
    rejectOpen(new Error(`websocket error: ${url}`));
  });
  ws.addEventListener('close', (ev) => {
    rec.mark('close', { code: ev.code, reason: ev.reason });
    rejectOpen(new Error(`websocket closed before open: ${ev.code} ${ev.reason}`));
    resolveClosed({ code: ev.code, reason: ev.reason });
  });

  return {
    ws,
    recorder: rec,
    opened,
    closed,
    send(data) {
      rec.mark('sent', { bytes: typeof data === 'string' ? Buffer.byteLength(data) : data.byteLength });
      ws.send(data);
    },
    stop() {
      try {
        ws.close();
      } catch {
        /* best effort */
      }
      return closed;
    },
  };
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Resolve when `predicate(recorder)` holds, or reject at `timeoutMs`. */
export async function waitFor(recorder, predicate, timeoutMs, description = 'condition') {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (predicate(recorder)) return true;
    await sleep(5);
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${description}`);
}
