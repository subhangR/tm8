/**
 * `tm8 inbox list`, `tm8 inbox mark-read`, `tm8 message mark-read` — group 7,
 * G08 per-member read state.
 *
 * THE DISTINCTION THIS FILE EXISTS TO KEEP. Two commands in this module both
 * say "mark read" and they are NOT the same operation over the same state:
 *
 *   tm8 inbox mark-read <notification-id>   -> inbox.markRead   -> PUT /v2/inbox/:id/read
 *   tm8 message mark-read <anchor-id>       -> readMarks.upsert -> PUT /v2/read-marks/:id
 *
 * The first owns NOTIFICATION state — one row in a feed, marked seen. The
 * second owns an ANCHOR'S READ CURSOR — "I have caught up on this thread". A
 * caller who confuses them either leaves a notification lit forever or believes
 * they have caught up on a conversation they have not opened. They are asserted
 * here as distinct paths carrying distinct bodies, because "both are mark-read"
 * is exactly the reading that blurs them.
 *
 * `message mark-read` lives in THIS module rather than the `message` module by
 * seam ruling S2: it is G08 per-member read state, composed and W3-PASSED,
 * while the rest of the `message` noun is uncomposed. A noun is not an
 * ownership unit here; a module is. `registry.ts` throws at IMPORT on a
 * duplicate path, so exactly one module may carry it.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { run } from '../src/run.js';
import { isRegisteredPath } from '../src/commands/registry.js';
import { ledger } from '../src/discovery/availability.js';

/**
 * Drive the REAL kernel router — `run()` — including the registry lookup this
 * slot does not own. Group 7's modules are wired into `commands/registry.ts`
 * now, so nothing about dispatch is substituted here: this is the same path the
 * shipped binary takes, minus the process-exiting entry wrapper.
 */
async function tm8(argv: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const o = vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => {
    out.push(String(c));
    return true;
  });
  const e = vi.spyOn(process.stderr, 'write').mockImplementation((c: unknown) => {
    err.push(String(c));
    return true;
  });
  try {
    const code = await run(argv);
    return { code, stdout: out.join(''), stderr: err.join('') };
  } finally {
    o.mockRestore();
    e.mockRestore();
  }
}

interface Recorded {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
}

let server: Server;
let baseUrl: string;
let recorded: Recorded[] = [];
let reply: { status: number; body: unknown } = {
  status: 200,
  body: { data: { items: [], nextCursor: null }, requestId: 'req_test' },
};

const SPACE = '11111111-1111-7111-8111-111111111111';
const NOTIFICATION = '22222222-2222-7222-8222-222222222222';
const ANCHOR = '33333333-3333-7333-8333-333333333333';
const TEAMMATE = '44444444-4444-7444-8444-444444444444';

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      recorded.push({
        method: req.method ?? '',
        path: url.pathname,
        query: url.searchParams,
        body: raw ? (JSON.parse(raw) as unknown) : undefined,
      });
      res.setHeader('content-type', 'application/json');
      res.statusCode = reply.status;
      res.end(JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (typeof addr === 'string' || addr === null) throw new Error('no address');
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
});

beforeEach(() => {
  recorded = [];
  reply = { status: 200, body: { data: { items: [], nextCursor: null }, requestId: 'req_test' } };
  process.env.TM8_BASE_URL = baseUrl;
  delete process.env.TM8_SPACE_ID;
  delete process.env.TM8_ACTOR_ID;
  delete process.env.TM8_CONFIG_PATH;
  ledger.clear();
});

afterEach(() => {
  ledger.clear();
});

describe('tm8 inbox list — inbox.list', () => {
  it('binds GET /v2/inbox from the catalog, not a hand-written literal', async () => {
    const r = await tm8(['inbox', 'list', '--format', 'json']);
    expect(r.code).toBe(0);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.method).toBe('GET');
    expect(recorded[0]?.path).toBe('/v2/inbox');
  });

  it('sends --space as the spaceId query field', async () => {
    await tm8(['inbox', 'list', '--space', SPACE]);
    expect(recorded[0]?.query.get('spaceId')).toBe(SPACE);
  });

  it('sends unread=true only when --unread is given, and omits the key otherwise', async () => {
    await tm8(['inbox', 'list', '--unread']);
    expect(recorded[0]?.query.get('unread')).toBe('true');

    recorded = [];
    await tm8(['inbox', 'list']);
    // NOT `unread=false`. The Server filters only on `unread === true`, so a
    // false is a no-op that reads like a filter — and `inbox.list` rejects any
    // query key outside its closed set, so an unnecessary key is pure risk.
    expect(recorded[0]?.query.has('unread')).toBe(false);
  });

  it('encodes --for as the discriminated team_member recipient the operation expects', async () => {
    await tm8(['inbox', 'list', '--for', TEAMMATE]);
    const raw = recorded[0]?.query.get('recipient');
    expect(raw).toBeDefined();
    expect(JSON.parse(raw!)).toEqual({ type: 'team_member', teamMemberId: TEAMMATE });
  });

  it('passes --limit and --cursor through as query parameters', async () => {
    await tm8(['inbox', 'list', '--limit', '25', '--cursor', 'cur_abc']);
    expect(recorded[0]?.query.get('limit')).toBe('25');
    expect(recorded[0]?.query.get('cursor')).toBe('cur_abc');
  });

  it('refuses a non-positive --limit locally, without reaching the network', async () => {
    const r = await tm8(['inbox', 'list', '--limit', '0']);
    expect(r.code).toBe(2);
    expect(recorded).toHaveLength(0);
  });

  it('refuses --mutation-id: a read is not idempotently retryable', async () => {
    const r = await tm8(['inbox', 'list', '--mutation-id', 'x']);
    expect(r.code).toBe(2);
    expect(recorded).toHaveLength(0);
    expect(r.stderr).toContain('--mutation-id');
  });

  it('keeps the notification id in human output — `inbox mark-read` needs it', async () => {
    reply = {
      status: 200,
      body: {
        data: {
          items: [{
            id: NOTIFICATION,
            spaceId: SPACE,
            kind: 'mention',
            recipient: { id: 'mem_1', name: 'Ada' },
            readAt: null,
            createdAt: '2026-07-27T00:00:00.000Z',
          }],
          nextCursor: null,
        },
        requestId: 'req_test',
      },
    };
    const r = await tm8(['inbox', 'list']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(NOTIFICATION);
  });

  it('writes data to stdout and nothing diagnostic to it', async () => {
    const r = await tm8(['inbox', 'list', '--format', 'json']);
    expect(r.stdout.trimEnd()).toBe(JSON.stringify({ items: [], nextCursor: null }, null, 2));
    expect(r.stderr).toBe('');
  });
});

describe('tm8 inbox mark-read — inbox.markRead', () => {
  beforeEach(() => {
    reply = {
      status: 200,
      body: {
        data: {
          id: NOTIFICATION, spaceId: SPACE, kind: 'mention',
          recipient: { id: 'mem_1', name: 'Ada' },
          readAt: '2026-07-27T00:00:01.000Z', createdAt: '2026-07-27T00:00:00.000Z',
        },
        requestId: 'req_test',
      },
    };
  });

  it('binds PUT /v2/inbox/:notificationId/read', async () => {
    const r = await tm8(['inbox', 'mark-read', NOTIFICATION]);
    expect(r.code).toBe(0);
    expect(recorded[0]?.method).toBe('PUT');
    expect(recorded[0]?.path).toBe(`/v2/inbox/${NOTIFICATION}/read`);
  });

  it('requires the notification id', async () => {
    const r = await tm8(['inbox', 'mark-read']);
    expect(r.code).toBe(2);
    expect(recorded).toHaveLength(0);
  });

  it('generates a clientMutationId when none is given', async () => {
    await tm8(['inbox', 'mark-read', NOTIFICATION]);
    const body = recorded[0]?.body as { clientMutationId?: string };
    expect(body?.clientMutationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('passes a supplied --mutation-id through VERBATIM', async () => {
    await tm8(['inbox', 'mark-read', NOTIFICATION, '--mutation-id', 'NotAUuid-1']);
    expect((recorded[0]?.body as { clientMutationId?: string })?.clientMutationId).toBe('NotAUuid-1');
  });

  /**
   * `InboxMarkReadInputSchema` (contract schemas.ts:1561) is `.strict()` and its
   * only fields are `clientMutationId` and `recipient`. It has NO `actorId` —
   * unlike `RequiredCommandContextSchema`, which every other command in this
   * module uses. Sending one would be a hard `invalid_input`, so `--as` must
   * NOT be projected into this body even though it is a global option.
   */
  it('never sends actorId — this operation\'s strict input has no such field', async () => {
    await tm8(['inbox', 'mark-read', NOTIFICATION, '--as', TEAMMATE]);
    expect(recorded[0]?.body).not.toHaveProperty('actorId');
    expect(Object.keys(recorded[0]?.body as object)).toEqual(['clientMutationId']);
  });
});

describe('tm8 message mark-read — readMarks.upsert (seam ruling S2)', () => {
  beforeEach(() => {
    reply = {
      status: 200,
      body: {
        data: { anchorId: ANCHOR, lastReadAt: '2026-07-27T00:00:01.000Z', patches: [] },
        requestId: 'req_test',
      },
    };
  });

  it('binds PUT /v2/read-marks/:anchorId — a DIFFERENT path from inbox mark-read', async () => {
    const r = await tm8(['message', 'mark-read', ANCHOR]);
    expect(r.code).toBe(0);
    expect(recorded[0]?.method).toBe('PUT');
    expect(recorded[0]?.path).toBe(`/v2/read-marks/${ANCHOR}`);
    expect(recorded[0]?.path).not.toContain('/inbox/');
  });

  it('carries actorId when --as is given — its input DOES have that field', async () => {
    await tm8(['message', 'mark-read', ANCHOR, '--as', TEAMMATE]);
    expect((recorded[0]?.body as { actorId?: string })?.actorId).toBe(TEAMMATE);
  });

  it('requires the anchor entity id', async () => {
    const r = await tm8(['message', 'mark-read']);
    expect(r.code).toBe(2);
    expect(recorded).toHaveLength(0);
  });

  /**
   * `--through <message-id>` is an AMENDMENT-DEPENDENT flag, not a frozen one:
   * grammar §8's own extension table and §9.2 item 26 both list it as requiring
   * an amendment, and `operations.ts` marks this row `input: 'unbound'` —
   * payload with no frozen schema binding. The wire today is
   * `RequiredCommandContextSchema` (`{actorId?, clientMutationId}`, `.strict()`)
   * and `mark_read(p_anchor_id, p_client_mutation_id)` takes no message id at
   * all: it marks read AS OF NOW.
   *
   * So there are exactly two dishonest options and this refuses both. Dropping
   * `--through` silently tells the caller they set a cursor position they did
   * not set; sending it produces a guaranteed `invalid_input` against a strict
   * schema. Refusing locally costs no round trip and names the amendment.
   */
  it('refuses --through locally and sends nothing: it has no wire destination yet', async () => {
    const r = await tm8(['message', 'mark-read', ANCHOR, '--through', 'msg_1']);
    expect(r.code).toBe(2);
    expect(recorded).toHaveLength(0);
    expect(r.stderr).toContain('--through');
  });

  it('marks read as of now, and says so rather than implying a message cursor', async () => {
    const r = await tm8(['message', 'mark-read', ANCHOR]);
    expect(r.stdout).toContain('2026-07-27T00:00:01.000Z');
  });
});

describe('the two mark-read commands are distinct operations over distinct state', () => {
  /**
   * Asserted against the REAL registry rather than against this module's own
   * exported array. Asking the array whether it contains a path only proves the
   * array is what it is; asking the registry proves the coordinator's wiring
   * actually took, which is the thing that could be wrong.
   */
  it('registers both paths in the real command registry', () => {
    expect(isRegisteredPath(['inbox', 'mark-read'])).toBe(true);
    expect(isRegisteredPath(['message', 'mark-read'])).toBe(true);
  });

  it('registers all three group 7 inbox paths', () => {
    expect(isRegisteredPath(['inbox', 'list'])).toBe(true);
    expect(isRegisteredPath(['inbox', 'mark-read'])).toBe(true);
    expect(isRegisteredPath(['message', 'mark-read'])).toBe(true);
  });

  /**
   * Guards the assertion above against passing vacuously: `isRegisteredPath`
   * must be capable of answering false, or "everything is registered" would be
   * indistinguishable from "this function always says true".
   */
  it('answers false for a path nobody registers, so the check discriminates', () => {
    expect(isRegisteredPath(['inbox', 'mark-unread'])).toBe(false);
    expect(isRegisteredPath(['message', 'mark-read', 'twice'])).toBe(false);
  });
});
