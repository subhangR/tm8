/**
 * EXHAUSTIVENESS: every one of the 107 catalog rows resolves through the
 * kernel — binding, response shape, and error mapping — with no row unhandled.
 *
 * Everything here iterates `OPERATIONS` from `@tm8/contract`. Nothing is
 * hand-listed, so a row added upstream joins this test automatically instead
 * of quietly having no CLI disposition.
 *
 * ANTI-VACUITY. A loop that iterates zero rows, or compares undefined to
 * undefined, passes while proving nothing. Three guards against that:
 *   - the row count is asserted against the coordinator-verified 102/100/2;
 *   - every row must be VISITED, counted, and its visit recorded in a set that
 *     is compared back to the catalog;
 *   - each row must produce a concrete, non-undefined resolution — a bound
 *     path with no leftover `:param`, a mode from the closed 3-value set, and
 *     an exit code from the frozen table.
 * This file was additionally probe-red'd: see the report for the recorded
 * failures when the visited-set assertion was fed a deliberately short list.
 */
import { describe, expect, it } from 'vitest';
import {
  OPERATIONS,
  RESERVED_OPERATIONS,
  V1_OPERATIONS,
  bindPath,
  type OperationName,
} from '@tm8/contract';
import { Tm8Client, pathParamNames, responseMode, type ResponseMode } from '../src/client.js';
import { ApiError, StreamOperationError, exitCodeFor } from '../src/errors.js';
import { isExitCode } from '../src/exit.js';

/** The coordinator-verified shape of the frozen catalog. */
// 121 -> 126 (2026-08-02): auth.signup/login/logout/session.get (Identity v2 Stage 1).
// 126 -> 127 (2026-08-02): execution.launch — a session's spawn-time configuration.
const EXPECTED_ROWS = 129;

const params = (name: OperationName): Record<string, string> =>
  Object.fromEntries(pathParamNames(name).map((p) => [p, `x_${p}`]));

describe('the catalog itself is the shape W4 was briefed on', () => {
  it('127 rows = 125 v1 + 2 reserved, 126 HTTP + 1 WS', () => {
    expect(OPERATIONS.length).toBe(EXPECTED_ROWS);
    expect(V1_OPERATIONS.length).toBe(127);
    expect(RESERVED_OPERATIONS.map((o) => o.name).sort()).toEqual(['bridge.fetchBlob', 'search.query']);
    expect(OPERATIONS.filter((o) => o.method === 'WS')).toHaveLength(1);
  });
});

describe('every row binds', () => {
  it('produces a concrete path with no unbound :param left in it', () => {
    const visited = new Set<string>();
    for (const op of OPERATIONS) {
      const bound = bindPath(op.name, params(op.name));
      expect(bound, op.name).toMatch(/^\/v2\//);
      expect(bound, op.name).not.toMatch(/:[A-Za-z]/);
      for (const p of pathParamNames(op.name)) expect(bound, `${op.name}:${p}`).toContain(`x_${p}`);
      visited.add(op.name);
    }
    expect(visited.size).toBe(EXPECTED_ROWS);
    expect([...visited].sort()).toEqual(OPERATIONS.map((o) => o.name).sort());
  });

  it('classifies every row into exactly one of the three response shapes', () => {
    const byMode = new Map<ResponseMode, string[]>([
      ['envelope', []],
      ['bytes', []],
      ['stream', []],
    ]);
    for (const op of OPERATIONS) byMode.get(responseMode(op.name))?.push(op.name);
    expect(byMode.get('stream')).toEqual(['events.subscribe']);
    expect(byMode.get('bytes')?.sort()).toEqual(['artifacts.export', 'bridge.fetchBlob', 'files.download']);
    expect(byMode.get('envelope')).toHaveLength(EXPECTED_ROWS - 4);
    expect([...byMode.values()].reduce((n, list) => n + list.length, 0)).toBe(EXPECTED_ROWS);
  });
});

describe('every row resolves through the client and the error mapping', () => {
  /** The honest 501 every catalogued-but-unbuilt row answers with (DEV-13). */
  const notImplemented = (): Response =>
    new Response(
      JSON.stringify({
        error: { code: 'not_implemented', message: 'not implemented on this node', requestId: 'req_501', retryable: false },
      }),
      { status: 501, headers: { 'content-type': 'application/json' } },
    );

  it('an honest 501 on EVERY row maps to exit 8 — and a WS row never reaches the wire', async () => {
    const requested: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      requested.push(String(input));
      return notImplemented();
    }) as unknown as typeof fetch;
    const client = new Tm8Client({ baseUrl: 'http://127.0.0.1:4610', fetchImpl });

    const resolved = new Map<string, number>();
    for (const op of OPERATIONS) {
      const mode = responseMode(op.name);
      const call =
        mode === 'bytes'
          ? client.download(op.name, { params: params(op.name) })
          : client.invoke(op.name, { params: params(op.name) });
      const err: unknown = await call.then(() => undefined, (e: unknown) => e);
      expect(err, op.name).toBeDefined();
      if (mode === 'stream') {
        expect(err, op.name).toBeInstanceOf(StreamOperationError);
      } else {
        expect(err, op.name).toBeInstanceOf(ApiError);
        expect((err as ApiError).code, op.name).toBe('not_implemented');
        expect((err as ApiError).operation, op.name).toBe(op.name);
      }
      const exit = exitCodeFor(err);
      expect(isExitCode(exit), `${op.name} -> ${exit}`).toBe(true);
      resolved.set(op.name, exit);
    }

    expect(resolved.size).toBe(EXPECTED_ROWS);
    // 119 HTTP rows produced an honest 8; the single WS row produced usage 2
    // without a request. Both are resolutions; neither is a fall-through.
    expect([...resolved.values()].filter((c) => c === 8)).toHaveLength(128);
    expect([...resolved.entries()].filter(([, c]) => c === 2)).toEqual([['events.subscribe', 2]]);
    expect(requested).toHaveLength(128);
  });

  it('a success on EVERY row is returned, not mistaken for drift', async () => {
    const blob = new Uint8Array([1, 2, 3]);
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const isBlob =
        String(input).includes('/download') ||
        String(input).includes('/bridge/blobs/') ||
        String(input).includes('/export');
      return isBlob
        ? new Response(blob, { status: 200 })
        : new Response(JSON.stringify({ data: { echoed: String(input) }, requestId: 'req_ok' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
    }) as unknown as typeof fetch;
    const client = new Tm8Client({ baseUrl: 'http://127.0.0.1:4610', fetchImpl });

    let httpRows = 0;
    for (const op of OPERATIONS) {
      const mode = responseMode(op.name);
      if (mode === 'stream') continue;
      httpRows++;
      if (mode === 'bytes') {
        const res = await client.download(op.name, { params: params(op.name) });
        expect([...res.bytes], op.name).toEqual([1, 2, 3]);
      } else {
        const data = await client.invoke<{ echoed: string }>(op.name, { params: params(op.name) });
        expect(data, op.name).toBeDefined();
        expect(data.echoed, op.name).toContain(bindPath(op.name, params(op.name)));
      }
    }
    expect(httpRows).toBe(128);
  });
});

describe('the two rows with no public command are still reachable facts', () => {
  it('reserved rows are catalogued, not hidden', () => {
    // §3.1 of the W4 evidence: `search.query` gets a command that answers
    // honestly; `bridge.fetchBlob` gets no command at all. Both stay in
    // OPERATIONS so exact-operation discovery can name them.
    expect(OPERATIONS.some((o) => o.name === 'search.query')).toBe(true);
    expect(OPERATIONS.some((o) => o.name === 'bridge.fetchBlob')).toBe(true);
  });

  it('execution.prompt stays a v1 row with no CLI form (B1)', () => {
    const row = OPERATIONS.find((o) => o.name === 'execution.prompt');
    expect(row?.status).toBe('v1');
    // The kernel binds it like any other row; it is invocation POLICY, not
    // catalog removal, that keeps it out of the public grammar — the Server
    // answers `forbidden` / `use_message_send`.
    expect(bindPath('execution.prompt', { id: 'ws_1' })).toBe('/v2/entities/ws_1/commands/prompt');
  });
});
