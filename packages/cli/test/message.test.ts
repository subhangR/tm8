/**
 * `tm8 message …` — the seven message rows this slot owns.
 *
 * These are UNIT tests: they drive the real kernel (parse → context → dispatch
 * → output → exit funnel) against a STUB HTTP server, so every assertion here
 * is about what THIS CLI does with an answer, never about what the tm8 Server
 * would answer. The real Server is exercised in `test/integration/message.test.ts`.
 *
 * WHY A STUB SERVER RATHER THAN A MOCKED CLIENT. `Tm8Client` is reached through
 * `clientFor(ctx)`, which builds it from resolved context — there is no seam to
 * inject a fake through, and adding one would mean these tests measured a seam
 * that does not exist in the shipped path. A loopback `node:http` server costs
 * a few lines and exercises the ACTUAL bindPath → fetch → envelope → taxonomy →
 * exit-code chain.
 *
 * WHAT THE EXIT-11 TEST HERE IS AND IS NOT. It proves the CLI maps an observed
 * non-delivered settled outcome onto exit 11 and still writes the stored batch
 * to stdout. It is NOT obligation O1: O1 requires the REAL Server to store a
 * message and leave a delivery unsettled, and `messages.post` is an
 * unconditional 501 stub on this node. Nothing in this file may be read as
 * discharging O1.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { bindPath } from '@tm8/contract';

import { parseInvocation, splitCommandPath } from '../src/args.js';
import { loadLocalConfig, resolveContext, sessionContextFromEnv } from '../src/context.js';
import { errorLines, exitCodeFor } from '../src/errors.js';
import type { ExitCode } from '../src/exit.js';
import { createOutput } from '../src/output.js';
import type { CommandModule } from '../src/run.js';
import { isCommandPath } from '../src/discovery/operations.js';
import { MESSAGE_COMMANDS } from '../src/commands/message.js';

// ---------------------------------------------------------------------------
// Dispatch — the real kernel, minus the one line the coordinator owns.
// ---------------------------------------------------------------------------

interface DispatchResult {
  code: ExitCode;
  stdout: string;
  stderr: string;
}

/**
 * Dispatch exactly as `run()` will once `MESSAGE_COMMANDS` is spread into
 * `commands/registry.ts`. `registry.ts` and `run.ts` are coordinator-owned, so
 * this slot cannot yet reach its commands through `run()` — it would correctly
 * answer exit 8. Everything that DECIDES behaviour is the real kernel; only the
 * registry lookup is substituted, which is the exact line being waited on.
 */
async function dispatch(argv: readonly string[]): Promise<DispatchResult> {
  const out: string[] = [];
  const err: string[] = [];
  const streams = {
    stdout: (chunk: string | Uint8Array) => void out.push(String(chunk)),
    stderr: (chunk: string) => void err.push(chunk),
  };
  let output = createOutput({ format: 'human', streams });
  try {
    const invocation = parseInvocation(argv);
    output = createOutput({
      format: invocation.globals.format,
      color: invocation.globals.color,
      quiet: invocation.globals.quiet,
      streams,
    });
    const registered = new Map(MESSAGE_COMMANDS.map((m) => [m.path.join(' '), m]));
    const match = splitCommandPath(invocation.positionals, (p) => registered.has(p.join(' ')));
    if (!match) throw new Error(`no message command matched: ${invocation.positionals.join(' ')}`);
    const command = registered.get(match.path.join(' ')) as CommandModule;
    const ctx = resolveContext({
      globals: invocation.globals,
      session: sessionContextFromEnv(),
      config: loadLocalConfig(),
    });
    const code = await command.run({
      path: match.path,
      args: match.args,
      options: invocation.options,
      passthrough: invocation.passthrough,
      ctx,
      out: output,
    });
    return { code, stdout: out.join(''), stderr: err.join('') };
  } catch (error) {
    output.error(errorLines(error));
    return { code: exitCodeFor(error), stdout: out.join(''), stderr: err.join('') };
  }
}

// ---------------------------------------------------------------------------
// The stub Server.
// ---------------------------------------------------------------------------

interface Seen {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
}

type Reply = { status: number; json: unknown };
type StubHandler = (seen: Seen) => Reply;

let server: Server;
let seen: Seen[] = [];
let reply: StubHandler = () => ({ status: 200, json: { data: {}, requestId: 'req_stub' } });

function envelope(data: unknown): Reply {
  return { status: 200, json: { data, requestId: 'req_stub' } };
}

function wireError(status: number, code: string, message: string, retryable = false): Reply {
  return { status, json: { error: { code, message, requestId: 'req_stub', retryable } } };
}

const ANCHOR = '018f0000-0000-7000-8000-000000000001';
const ANCHOR_2 = '018f0000-0000-7000-8000-000000000002';
const MESSAGE = '018f0000-0000-7000-8000-0000000000aa';
const FILE = '018f0000-0000-7000-8000-0000000000bb';

/**
 * A delivery row as the frozen wire actually carries it.
 *
 * `MessageDeliveryRecord.settledAt` is `string | null` (`contract.ts`) and the
 * settle loop keys settlement on it, so a double that OMITS it is not a smaller
 * version of the real answer — it is a shape the Server never sends. These
 * doubles did omit it, which is one reason the `failed_retryable` defect below
 * stayed invisible to a suite that otherwise covered this loop well: every
 * fixture was silently in the "node did not say" state.
 *
 * The stamp is a CONSTANT, never `new Date()`: a settled row's value comes from
 * the Server, and a fixture that regenerated it each run would be asserting
 * something about the test's own clock.
 */
const SETTLED_AT = '2026-07-27T07:15:43.619023Z';

function delivery(status: string, settledAt: string | null): Record<string, unknown> {
  return { deliveryId: 'd1', messageId: MESSAGE, targetWorkSessionId: ANCHOR, status, settledAt };
}

let savedEnv: NodeJS.ProcessEnv;

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const record: Seen = {
        method: req.method ?? '',
        path: url.pathname,
        query: url.searchParams,
        body: raw ? (JSON.parse(raw) as unknown) : undefined,
      };
      seen.push(record);
      const answer = reply(record);
      res.writeHead(answer.status, { 'content-type': 'application/json', 'x-tm8-request-id': 'req_stub' });
      res.end(JSON.stringify(answer.json));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  savedEnv = { ...process.env };
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  // A config file on the developer's own machine must not decide what these
  // tests resolve, so point XDG at an empty directory. TM8_CONFIG_PATH is NOT
  // used for this: an explicitly-named unreadable config is a hard error by
  // design, which is the opposite of what a test isolate wants.
  process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), 'tm8-g5-cfg-'));
  process.env.TM8_BASE_URL = `http://127.0.0.1:${port}`;
  delete process.env.TM8_SPACE_ID;
  delete process.env.TM8_ACTOR_ID;
  delete process.env.TM8_SESSION_ID;
  delete process.env.TM8_AGENT_TOKEN;
  seen = [];
  reply = () => envelope({});
});

afterEach(() => {
  process.env = savedEnv;
});

// ---------------------------------------------------------------------------
// Registration and agreement with the frozen projection.
// ---------------------------------------------------------------------------

describe('the module registers exactly its own rows', () => {
  it('registers the seven message paths this slot owns', () => {
    expect(MESSAGE_COMMANDS.map((c) => c.path.join(' ')).sort()).toEqual([
      'message attachment add',
      'message attachment remove',
      'message delete',
      'message delivery',
      'message list',
      'message send',
      'message update',
    ]);
  });

  /**
   * SEAM RULING S2. `readMarks.upsert` → `message mark-read` sits under this
   * noun but belongs to the per-member read-state group. `registry.ts` throws at
   * IMPORT on a duplicate path, so a double registration would not fail one
   * test — it would collapse every suite in this package at once.
   */
  it('does NOT register `message mark-read` (seam ruling S2)', () => {
    expect(MESSAGE_COMMANDS.some((c) => c.path.join(' ') === 'message mark-read')).toBe(false);
  });

  it('every registered path is documented in the frozen discovery projection', () => {
    expect(MESSAGE_COMMANDS.length).toBeGreaterThan(0);
    for (const c of MESSAGE_COMMANDS) {
      expect(isCommandPath(c.path), `\`${c.path.join(' ')}\` is wired but absent from the projection`)
        .toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Reads.
// ---------------------------------------------------------------------------

describe('message list', () => {
  it('binds the anchor into the catalog path and never a hand-written URL', async () => {
    reply = () => envelope({ items: [], nextCursor: null });
    const r = await dispatch(['message', 'list', ANCHOR, '--format', 'json']);
    expect(r.code).toBe(0);
    expect(seen[0]?.path).toBe(bindPath('messages.list', { anchorId: ANCHOR }));
    expect(seen[0]?.method).toBe('GET');
  });

  it('carries --root, --limit and --cursor as the catalog query', async () => {
    reply = () => envelope({ items: [], nextCursor: null });
    await dispatch([
      'message', 'list', ANCHOR,
      '--root', MESSAGE, '--limit', '5', '--cursor', 'c1', '--order', 'oldest',
    ]);
    expect(seen[0]?.query.get('rootMessageId')).toBe(MESSAGE);
    expect(seen[0]?.query.get('limit')).toBe('5');
    expect(seen[0]?.query.get('cursor')).toBe('c1');
    expect(seen[0]?.query.get('order')).toBe('oldest');
  });

  it('refuses --mutation-id: a read is not a mutation', async () => {
    const r = await dispatch(['message', 'list', ANCHOR, '--mutation-id', 'x']);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/read/);
    expect(seen).toHaveLength(0);
  });

  it('requires the anchor argument', async () => {
    const r = await dispatch(['message', 'list']);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/anchor/i);
    expect(seen).toHaveLength(0);
  });

  it('closes --order to the two documented values', async () => {
    const r = await dispatch(['message', 'list', ANCHOR, '--order', 'sideways']);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/oldest\|newest/);
    expect(seen).toHaveLength(0);
  });

  it('keeps ids in the human view that a follow-up command needs', async () => {
    reply = () => envelope({
      items: [{ id: MESSAGE, content: { kind: 'message', body: 'hello' }, replyCount: 2 }],
      nextCursor: null,
    });
    const r = await dispatch(['message', 'list', ANCHOR]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(MESSAGE);
  });
});

describe('message delivery', () => {
  it('binds the message id and refuses a mutation id', async () => {
    reply = () => envelope({ message: { id: MESSAGE }, deliveries: [] });
    const ok = await dispatch(['message', 'delivery', MESSAGE, '--format', 'json']);
    expect(ok.code).toBe(0);
    expect(seen[0]?.path).toBe(bindPath('messages.delivery.get', { messageId: MESSAGE }));

    seen = [];
    const bad = await dispatch(['message', 'delivery', MESSAGE, '--mutation-id', 'x']);
    expect(bad.code).toBe(2);
    expect(seen).toHaveLength(0);
  });

  /**
   * Storage and delivery are different facts. A human view that rendered only
   * "pending" without saying the message is stored invites a resend of a
   * message that was never lost.
   */
  it('never renders a pending delivery as a lost message', async () => {
    reply = () => envelope({
      message: { id: MESSAGE },
      deliveries: [{ deliveryId: 'd1', messageId: MESSAGE, targetWorkSessionId: ANCHOR, status: 'pending' }],
    });
    const r = await dispatch(['message', 'delivery', MESSAGE]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('pending');
    expect(r.stdout).toMatch(/stored/i);
    expect(r.stdout).not.toMatch(/\blost\b|\bfailed to send\b/i);
  });
});

// ---------------------------------------------------------------------------
// message send — the O1 row.
// ---------------------------------------------------------------------------

describe('message send', () => {
  const batch = (ids: readonly string[]): unknown => ({
    messageBatchId: 'mut-1',
    messages: ids.map((id) => ({ id, content: { kind: 'message', body: 'hi' } })),
  });

  it('requires at least one --to', async () => {
    const r = await dispatch(['message', 'send', 'hello']);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/--to/);
    expect(seen).toHaveLength(0);
  });

  /**
   * The TTY branch is asserted by CONTROLLING the condition it is about: under
   * vitest `process.stdin` is not a terminal, so without this the command would
   * correctly go looking for a piped body and the test would measure the
   * runner's stdio rather than the rule.
   */
  it('requires a body on a TTY, and says so rather than opening anything', async () => {
    const original = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    try {
      const r = await dispatch(['message', 'send', '--to', ANCHOR]);
      expect(r.code).toBe(2);
      expect(r.stderr).toMatch(/body/i);
      expect(seen).toHaveLength(0);
    } finally {
      if (original) Object.defineProperty(process.stdin, 'isTTY', original);
      else Reflect.deleteProperty(process.stdin, 'isTTY');
    }
  });

  it('refuses a positional body AND --body together', async () => {
    const r = await dispatch(['message', 'send', '--to', ANCHOR, 'inline', '--body', 'other']);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/--body/);
    expect(seen).toHaveLength(0);
  });

  it('sends anchorIds, body, mentions and attachments in the frozen shape', async () => {
    reply = () => envelope(batch([MESSAGE]));
    const r = await dispatch([
      'message', 'send', '--to', ANCHOR, 'hello', '--mention', ANCHOR_2, '--attach', FILE,
      '--mutation-id', 'mut-1',
    ]);
    expect(r.code).toBe(0);
    expect(seen[0]?.path).toBe(bindPath('messages.post', {}));
    expect(seen[0]?.body).toEqual({
      anchorIds: [ANCHOR],
      body: 'hello',
      mentionIds: [ANCHOR_2],
      attachmentIds: [FILE],
      clientMutationId: 'mut-1',
    });
  });

  it('collapses duplicate anchors preserving first-occurrence order', async () => {
    reply = () => envelope(batch([MESSAGE]));
    await dispatch([
      'message', 'send', '--to', ANCHOR_2, '--to', ANCHOR, '--to', ANCHOR_2, 'hi', '--mutation-id', 'm',
    ]);
    expect((seen[0]?.body as { anchorIds: string[] }).anchorIds).toEqual([ANCHOR_2, ANCHOR]);
  });

  /**
   * §7.4. A silently regenerated id turns a safe retry into a duplicate write.
   * The id is a CORRELATION identifier — `messageBatchId` equals it by design —
   * and is published in read DTOs; it is never a capability or a secret.
   */
  it('passes --mutation-id through verbatim and never regenerates it', async () => {
    reply = () => envelope(batch([MESSAGE]));
    await dispatch(['message', 'send', '--to', ANCHOR, 'hi', '--mutation-id', 'NOT-a-uuid-at-all']);
    expect((seen[0]?.body as { clientMutationId: string }).clientMutationId).toBe('NOT-a-uuid-at-all');
  });

  it('generates a UUIDv7 when none is supplied', async () => {
    reply = () => envelope(batch([MESSAGE]));
    await dispatch(['message', 'send', '--to', ANCHOR, 'hi']);
    expect((seen[0]?.body as { clientMutationId: string }).clientMutationId)
      .toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('keeps the batch id and every message id in the human view', async () => {
    reply = () => envelope(batch([MESSAGE]));
    const r = await dispatch(['message', 'send', '--to', ANCHOR, 'hi', '--mutation-id', 'mut-1']);
    expect(r.stdout).toContain('mut-1');
    expect(r.stdout).toContain(MESSAGE);
  });

  it('maps an honest 501 onto exit 8, never a transport failure', async () => {
    reply = () => wireError(501, 'not_implemented', 'messages.post is not composed on this node');
    const r = await dispatch(['message', 'send', '--to', ANCHOR, 'hi']);
    expect(r.code).toBe(8);
    expect(r.stderr).toMatch(/not_implemented/);
  });

  it('closes --wait to the two documented values', async () => {
    const r = await dispatch(['message', 'send', '--to', ANCHOR, 'hi', '--wait', 'forever']);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/stored\|settled/);
    expect(seen).toHaveLength(0);
  });

  it('default --wait stored never reads the delivery row', async () => {
    reply = () => envelope(batch([MESSAGE]));
    const r = await dispatch(['message', 'send', '--to', ANCHOR, 'hi']);
    expect(r.code).toBe(0);
    expect(seen.map((s) => s.path)).toEqual([bindPath('messages.post', {})]);
  });

  /**
   * The exit-11 MAPPING at the kernel boundary. NOT obligation O1 — see the file
   * header. What this proves: given an observed settled-but-not-delivered
   * outcome, the CLI exits 11, still writes the stored batch to stdout, and says
   * on stderr that the message IS stored.
   */
  it('exits 11 when --wait settled observes a stored batch whose delivery did not deliver', async () => {
    reply = (s) =>
      s.method === 'POST'
        ? envelope(batch([MESSAGE]))
        : envelope({
            message: { id: MESSAGE },
            deliveries: [delivery('failed_permanent', SETTLED_AT)],
          });
    const r = await dispatch(['message', 'send', '--to', ANCHOR, 'hi', '--wait', 'settled', '--timeout', '2']);
    expect(r.code).toBe(11);
    // Persistence SUCCEEDED: the batch is still the command's data.
    expect(r.stdout).toContain(MESSAGE);
    expect(r.stderr).toMatch(/stored/i);
    expect(r.stderr).toMatch(/do not resend/i);
    expect(r.stderr).toContain('failed_permanent');
  });

  /**
   * ⚠ THE `failed_retryable` DEFECT, AT THE ONE SEAM THAT CAN SHOW IT.
   *
   * `failed_retryable` is SETTLED. The authority is the CHECK constraint
   * `session_message_deliveries_state_shape` (`015_w1_foundations.sql`), which
   * places it in the `settled_at IS NOT NULL` partition — "retryable" describes
   * the MESSAGE, not this row, because a retry is a NEW `delivery_id` with
   * `attempt_no + 1`. The settle loop previously used a status allowlist that
   * excluded it, so it POLLED AN ALREADY-SETTLED ROW to the end of the budget
   * and then reported that the budget "expired before they settled" — an exit
   * code that was right sitting on a diagnostic that was FALSE, and in a PTY
   * that sentence lands in an agent's context.
   *
   * THE REQUEST COUNT IS THE ASSERTION, not the wall clock: settled-on-first-
   * observation is exactly one GET, while the defect issues one every 250ms for
   * the whole budget. That is deterministic where a timing bound would flake.
   *
   * LABELLED HONESTLY: this is a UNIT-LEVEL DOUBLE, not the node. A real
   * `failed_retryable` row cannot be minted through the settle path on this
   * node — delivery reservation is unwired, which is O1's blocker and is
   * MEASURED in the integration suite — so the loop cannot be driven against a
   * real one. What the real Server IS made to prove there is the half that
   * matters for this fix: that a genuine settled row carries `settledAt` on the
   * wire with a real value.
   */
  it('settles at once on failed_retryable rather than polling a settled row to the budget', async () => {
    reply = (s) =>
      s.method === 'POST'
        ? envelope(batch([MESSAGE]))
        : envelope({
            message: { id: MESSAGE },
            deliveries: [delivery('failed_retryable', SETTLED_AT)],
          });
    const r = await dispatch(['message', 'send', '--to', ANCHOR, 'hi', '--wait', 'settled', '--timeout', '2']);

    // Non-delivered is the FIRST disjunct of exit 11 — the code was never wrong.
    expect(r.code).toBe(11);
    expect(r.stderr).toContain('failed_retryable');
    // Exactly one delivery read: the outcome was available immediately.
    expect(seen.map((s) => s.method)).toEqual(['POST', 'GET']);
    // THE DIAGNOSTIC: no timeout happened, so none may be claimed.
    expect(r.stderr).not.toMatch(/budget expired/);
  });

  /**
   * `unknown` fell out of the old allowlist for the identical reason, and it is
   * settled by the same CHECK constraint. Asserted separately so a fix that
   * happened to special-case one status cannot pass for the other.
   */
  it('settles at once on a settled `unknown` outcome too', async () => {
    reply = (s) =>
      s.method === 'POST'
        ? envelope(batch([MESSAGE]))
        : envelope({
            message: { id: MESSAGE },
            deliveries: [delivery('unknown', SETTLED_AT)],
          });
    const r = await dispatch(['message', 'send', '--to', ANCHOR, 'hi', '--wait', 'settled', '--timeout', '2']);
    expect(r.code).toBe(11);
    expect(seen.map((s) => s.method)).toEqual(['POST', 'GET']);
    expect(r.stderr).not.toMatch(/budget expired/);
  });

  it('exits 0 when --wait settled observes every delivery delivered', async () => {
    reply = (s) =>
      s.method === 'POST'
        ? envelope(batch([MESSAGE]))
        : envelope({
            message: { id: MESSAGE },
            deliveries: [delivery('delivered', SETTLED_AT)],
          });
    const r = await dispatch(['message', 'send', '--to', ANCHOR, 'hi', '--wait', 'settled', '--timeout', '2']);
    expect(r.code).toBe(0);
    expect(seen.map((s) => s.method)).toEqual(['POST', 'GET']);
  });

  it('exits 11 when --wait settled runs out of --timeout <seconds> with a delivery still unsettled', async () => {
    reply = (s) =>
      s.method === 'POST'
        ? envelope(batch([MESSAGE]))
        : envelope({
            message: { id: MESSAGE },
            // `pending` is the one half of the partition with a NULL stamp.
            deliveries: [delivery('pending', null)],
          });
    const r = await dispatch(['message', 'send', '--to', ANCHOR, 'hi', '--wait', 'settled', '--timeout', '1']);
    expect(r.code).toBe(11);
    expect(r.stdout).toContain(MESSAGE);
    // The dimension is NAMED wherever it is rendered (O3).
    expect(r.stderr).toMatch(/--timeout <seconds>/);
  });

  it('a batch with no reserved delivery has nothing to settle and exits 0', async () => {
    reply = (s) =>
      s.method === 'POST'
        ? envelope(batch([MESSAGE]))
        : envelope({ message: { id: MESSAGE }, deliveries: [] });
    const r = await dispatch(['message', 'send', '--to', ANCHOR, 'hi', '--wait', 'settled', '--timeout', '2']);
    expect(r.code).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Versioned mutations.
// ---------------------------------------------------------------------------

describe('message update', () => {
  it('requires --expect-version and sends the frozen patch shape', async () => {
    const missing = await dispatch(['message', 'update', MESSAGE, 'new body']);
    expect(missing.code).toBe(2);
    expect(missing.stderr).toMatch(/--expect-version/);
    expect(seen).toHaveLength(0);

    reply = () => envelope({ id: MESSAGE });
    const r = await dispatch([
      'message', 'update', MESSAGE, 'new body', '--expect-version', '3', '--mutation-id', 'm',
    ]);
    expect(r.code).toBe(0);
    expect(seen[0]?.method).toBe('PATCH');
    expect(seen[0]?.path).toBe(bindPath('messages.edit', { id: MESSAGE }));
    expect(seen[0]?.body).toEqual({ body: 'new body', expectedVersion: 3, clientMutationId: 'm' });
  });

  /**
   * `PatchMessageInputSchema.mentions` is `Mention[]` — `{entityId, kind,
   * display}` — and `kind`/`display` are Server-derived facts. `--mention` gives
   * this CLI an id and nothing else, so honouring the flag would mean
   * FABRICATING two fields the Server owns. Refusing names the conflict; it is
   * an open amendment item, not a local design choice.
   */
  it('refuses --mention rather than fabricating the Mention fields the Server owns', async () => {
    const r = await dispatch([
      'message', 'update', MESSAGE, 'b', '--expect-version', '1', '--mention', ANCHOR_2,
    ]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/--mention/);
    expect(seen).toHaveLength(0);
  });
});

describe('message delete', () => {
  it('requires --yes', async () => {
    const r = await dispatch(['message', 'delete', MESSAGE, '--expect-version', '2']);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/--yes/);
    expect(seen).toHaveLength(0);
  });

  it('requires --expect-version and sends the frozen delete shape', async () => {
    reply = () => envelope({ id: MESSAGE, redactedAt: '2026-07-27T00:00:00.000Z' });
    const r = await dispatch([
      'message', 'delete', MESSAGE, '--expect-version', '2', '--yes', '--mutation-id', 'm',
    ]);
    expect(r.code).toBe(0);
    expect(seen[0]?.method).toBe('DELETE');
    expect(seen[0]?.path).toBe(bindPath('messages.delete', { id: MESSAGE }));
    expect(seen[0]?.body).toEqual({ expectedVersion: 2, clientMutationId: 'm' });
  });

  /**
   * OBLIGATION O5. This is a REDACTION: the body becomes `[redacted]`, mentions
   * and attachments are cleared, `redacted_at` is set, and THREAD HISTORY
   * SURVIVES. Telling an operator the history is gone invites a destructive
   * recovery against data that was never lost.
   */
  it('renders the transition as a redaction and never claims history is gone', async () => {
    reply = () => envelope({ id: MESSAGE, redactedAt: '2026-07-27T00:00:00.000Z' });
    const r = await dispatch([
      'message', 'delete', MESSAGE, '--expect-version', '2', '--yes',
    ]);
    const surface = `${r.stdout}\n${r.stderr}`;
    expect(surface).toMatch(/redact/i);
    expect(surface).not.toMatch(/\bdeleted\b|\bremoved from the thread\b|\bhistory (is )?(gone|lost)\b/i);
    expect(r.stdout).toContain(MESSAGE);
  });
});

describe('message attachment add|remove', () => {
  it('requires at least one file entity id and --expect-version', async () => {
    const noFile = await dispatch(['message', 'attachment', 'add', MESSAGE, '--expect-version', '1']);
    expect(noFile.code).toBe(2);
    expect(noFile.stderr).toMatch(/file/i);

    const noVersion = await dispatch(['message', 'attachment', 'add', MESSAGE, FILE]);
    expect(noVersion.code).toBe(2);
    expect(noVersion.stderr).toMatch(/--expect-version/);
    expect(seen).toHaveLength(0);
  });

  /**
   * `AddMessageAttachmentsInputSchema` is `.strict()` and — unlike the other
   * message inputs — does NOT spread `commandContextShape`. Sending `actorId`
   * would be an unknown key and a guaranteed `invalid_input`.
   */
  it('sends exactly the three frozen fields, with no actorId', async () => {
    reply = () => envelope({ id: MESSAGE });
    const r = await dispatch([
      'message', 'attachment', 'add', MESSAGE, FILE, '--expect-version', '4', '--mutation-id', 'm',
      '--as', ANCHOR_2,
    ]);
    expect(r.code).toBe(0);
    expect(seen[0]?.method).toBe('POST');
    expect(seen[0]?.path).toBe(bindPath('messages.attachments.add', { messageId: MESSAGE }));
    expect(seen[0]?.body).toEqual({ fileEntityIds: [FILE], expectedVersion: 4, clientMutationId: 'm' });
  });

  it('remove binds the DELETE row and de-duplicates the file ids', async () => {
    reply = () => envelope({ id: MESSAGE });
    const r = await dispatch([
      'message', 'attachment', 'remove', MESSAGE, FILE, FILE, '--expect-version', '4', '--mutation-id', 'm',
    ]);
    expect(r.code).toBe(0);
    expect(seen[0]?.method).toBe('DELETE');
    expect(seen[0]?.path).toBe(bindPath('messages.attachments.remove', { messageId: MESSAGE }));
    expect(seen[0]?.body).toEqual({ fileEntityIds: [FILE], expectedVersion: 4, clientMutationId: 'm' });
  });
});

// ---------------------------------------------------------------------------
// Program-wide laws, asserted against this slot's own surfaces.
// ---------------------------------------------------------------------------

describe('program-wide laws bound to this slot', () => {
  const sources = ['../src/commands/message.js', '../src/commands/handoff.js'].map((rel) =>
    readFileSync(new URL(rel.replace('.js', '.ts'), import.meta.url), 'utf8'),
  );

  /**
   * OBLIGATION O4. `clientMutationId` is PUBLISHED by design —
   * `messageBatchId == clientMutationId`, `handoffId == clientMutationId`. It is
   * a CORRELATION identifier, never a capability. No text of this slot's may
   * describe one as secret, private, sensitive, or usable to authenticate.
   */
  it('never describes a mutation id as a secret or a capability', () => {
    for (const src of sources) {
      const claims = src.match(/[^.\n]*mutation[ -]?id[^.\n]*/gi) ?? [];
      expect(claims.length).toBeGreaterThan(0); // the sweep must not pass vacuously
      for (const claim of claims) {
        expect(claim).not.toMatch(/\bsecret\b|\bprivate\b|\bsensitive\b|\bauthenticat|\bcredential\b|\bunguessab/i);
      }
    }
  });

  /** Every path is bound through `bindPath`; a URL literal here is the defect. */
  it('contains no hand-written /v2/ URL literal', () => {
    for (const src of sources) {
      expect(src).not.toMatch(/['"`]\/v2\//);
    }
  });

  /** §7.6 codes are frozen literals owned by the kernel, not re-declared here. */
  it('imports its exit codes from the frozen kernel', () => {
    for (const src of sources) {
      expect(src).toMatch(/from '\.\.\/exit\.js'/);
    }
  });
});
