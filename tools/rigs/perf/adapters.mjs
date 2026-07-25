/**
 * Target adapters for the perf-parity rig.
 *
 * The G3 bar (T-D21 / 09 §7) is "terminal perf at parity with old maestro **on
 * the same machine**, measured explicitly, never assumed". A parity claim is
 * only meaningful if the SAME measurement code runs against both systems, so
 * everything system-specific — how you find a live session, how you open its
 * PTY stream, how you know hydration finished — is isolated here, and
 * `pty-latency.mjs` knows nothing about either system.
 *
 * Two adapters:
 *   `legacy` — old maestro (the baseline). Live today.
 *   `tm8`    — tm8-server. The seam is written; it goes live at M3 when
 *              `execution.streams.attach` lands. Until then it fails LOUDLY
 *              rather than measuring nothing (a silently-empty parity run is
 *              how a regression ships).
 */

/**
 * Old maestro's dedicated PTY socket. Protocol (verified against
 * maestro-server/src/infrastructure/websocket/PtyWebSocketServer.ts, commit
 * 07d504d, 2026-07-25):
 *
 *   connect  ws://<host>/pty?sessionId=<id>&offset=<rawBytes>
 *   s→c text {"type":"size","cols":n,"rows":n}                     (if size known)
 *   s→c text {"type":"attached","base":n,"gap":n,"next":n,
 *             "hasReplay":bool,"replayKind"?:...,"epoch"?:"..."}    (resume handshake)
 *   s→c bin  sanitized scrollback replay (once, iff hasReplay), then live output
 *   s→c text {"type":"exit","exitCode":n|null}
 *   c→s bin  keystroke bytes   |   c→s text {"type":"resize",...}
 *
 * Server-side output is coalesced into 16ms frames (PtyHostService
 * SEND_COALESCE_MS = 16, flushed early at 64 KiB) — that constant is the thing
 * the coalescing-conformance metric checks, and the thing tm8 must inherit.
 */
export const legacyAdapter = {
  name: 'legacy-maestro',
  /** Frame-coalescing window the server promises. Cadence is judged against it. */
  coalesceMs: 16,

  defaults: {
    baseUrl: process.env.MAESTRO_BASE_URL || 'http://localhost:4570',
  },

  ptyUrl(baseUrl, sessionId, offset = 0) {
    const ws = baseUrl.replace(/^http/, 'ws').replace(/\/$/, '');
    return `${ws}/pty?sessionId=${encodeURIComponent(sessionId)}&offset=${offset}`;
  },

  async listSessions(baseUrl) {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/sessions`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`GET /api/sessions → ${res.status}`);
    const body = await res.json();
    const rows = Array.isArray(body) ? body : (body.data ?? body.sessions ?? []);
    return rows
      .filter((s) => ['running', 'active', 'idle', 'working'].includes(s.status))
      .map((s) => ({
        id: s.id,
        status: s.status,
        name: s.teamMemberSnapshot?.name ?? null,
        projectId: s.projectId ?? null,
      }));
  },

  /**
   * Classify a server→client text frame. The rig only needs to know when the
   * handshake landed and whether a replay frame is still coming.
   */
  parseControl(text) {
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      return { type: 'unknown' };
    }
    if (msg.type === 'attached') {
      return {
        type: 'attached',
        hasReplay: Boolean(msg.hasReplay),
        base: msg.base,
        gap: msg.gap,
        next: msg.next,
        epoch: msg.epoch ?? null,
        replayKind: msg.replayKind ?? 'delta',
      };
    }
    if (msg.type === 'size') return { type: 'size', cols: msg.cols, rows: msg.rows };
    if (msg.type === 'exit') return { type: 'exit', exitCode: msg.exitCode ?? null };
    return { type: 'unknown', raw: msg };
  },

  /** Keystroke injection = raw binary frame. Only used by the CONTROLLED echo mode. */
  encodeInput(text) {
    return Buffer.from(text, 'utf8');
  },
};

/**
 * tm8-server. Per AM-1/T-D21 the server-side PTY host is the ONLY spawn path.
 * Reaching a stream is a TWO-STEP dance, unlike legacy's single URL — the graph
 * announces and authorizes, then bytes flow (T-L10, 04 §3):
 *
 *   1. POST /v2/entities/:id/commands/streams-attach  { mode: 'view' }
 *        → StreamAttachGrant { workSessionId, url, protocol:'ws', mode,
 *                              token?, expiresAt }
 *   2. connect to `grant.url` (+ `token` if the grant carries one)
 *
 * `prepare()` below performs step 1 and caches the grant, so the measurement
 * code stays identical across targets: it still just asks for a URL.
 *
 * Two things remain genuinely unknown until Orion lands the M3 stream plumbing,
 * and they are marked rather than guessed:
 *   (a) whether resume takes an `?offset=` (legacy's raw-byte resume) or a
 *       different cursor — the contract does not say;
 *   (b) the control-frame vocabulary on the stream socket. `parseControl`
 *       therefore accepts legacy-shaped frames and reports anything else as
 *       `unknown`, which the rig surfaces as a handshake timeout — a loud
 *       failure, not a silent zero.
 * When those land, ONLY this object changes; no measurement code moves.
 */
export const tm8Adapter = {
  name: 'tm8',
  coalesceMs: 16, // inherited requirement, not an aspiration (04 §4 lessons)

  defaults: {
    baseUrl: process.env.TM8_BASE_URL || 'http://localhost:4610',
  },

  /** workSessionId → StreamAttachGrant, filled by `prepare()`. */
  _grants: new Map(),

  /**
   * Step 1: exchange a work_session id for a stream grant. Called by the rig
   * before `ptyUrl()` for targets that declare `needsPrepare`.
   */
  needsPrepare: true,
  async prepare(baseUrl, workSessionId, { mode = 'view', headers = {} } = {}) {
    const url = `${baseUrl.replace(/\/$/, '')}/v2/entities/${encodeURIComponent(workSessionId)}/commands/streams-attach`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ mode }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      throw new Error(
        `execution.streams.attach → ${res.status} ${body?.error?.code ?? ''} ${body?.error?.message ?? ''}`.trim(),
      );
    }
    // Envelope rule (04 §1): the grant is inside `data`.
    const grant = body?.data ?? body;
    if (!grant?.url) throw new Error('execution.streams.attach returned no `url` in the grant (contract: StreamAttachGrant)');
    this._grants.set(workSessionId, grant);
    return grant;
  },

  ptyUrl(baseUrl, workSessionId, offset = 0) {
    const grant = this._grants.get(workSessionId);
    if (!grant) {
      throw new Error(
        `tm8 adapter: no stream grant for ${workSessionId} — call prepare() first ` +
          '(the rig does this automatically; a bare ptyUrl() call is a bug).',
      );
    }
    // Grants may be server-relative (04 §3: "server-relative or absolute").
    const absolute = /^wss?:/.test(grant.url)
      ? grant.url
      : baseUrl.replace(/^http/, 'ws').replace(/\/$/, '') + (grant.url.startsWith('/') ? '' : '/') + grant.url;
    const url = new URL(absolute);
    if (grant.token) url.searchParams.set('token', grant.token);
    // TODO(M3, Orion): confirm the resume parameter. Legacy resumes on a raw
    // byte offset; if tm8 uses a different cursor this line is the one to fix.
    if (offset) url.searchParams.set('offset', String(offset));
    return url.toString();
  },

  /** work_sessions that are live enough to attach to (collections.query, M1+). */
  async listSessions(baseUrl, { spaceId = process.env.TM8_SPACE_ID, headers = {} } = {}) {
    if (!spaceId) {
      throw new Error('tm8 adapter: set TM8_SPACE_ID (or pass --session) — work_session discovery is space-scoped.');
    }
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/v2/collections/query`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ spaceId, kinds: ['work_session'], sort: 'activityAt_desc', limit: 50 }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`collections.query(work_session) → ${res.status}`);
    const body = await res.json();
    const items = body?.data?.page?.items ?? [];
    return items
      .filter((e) => ['running', 'idle'].includes(e.state?.status))
      .map((e) => ({ id: e.id, status: e.state?.status, name: e.title, projectId: e.spaceId }));
  },

  parseControl(text) {
    // Until the M3 vocabulary is fixed, accept the legacy shapes (the PTY host
    // is a lift, so identical control frames are the likely outcome) and treat
    // anything else as unknown rather than inventing a meaning for it.
    return legacyAdapter.parseControl(text);
  },

  encodeInput(text) {
    return Buffer.from(text, 'utf8');
  },
};

export const ADAPTERS = { legacy: legacyAdapter, tm8: tm8Adapter };

export function getAdapter(name) {
  const adapter = ADAPTERS[name];
  if (!adapter) {
    throw new Error(`unknown target '${name}' — expected one of: ${Object.keys(ADAPTERS).join(', ')}`);
  }
  return adapter;
}
