/**
 * `tm8 handoff send|list|withdraw` — entity projection into a work session.
 *
 * A handoff is NOT a message attachment: it keeps its own noun, its own state
 * machine (`deliveryStatus` × `recordStatus`), and its own 32,768-byte envelope
 * cap. These are unit tests against a stub HTTP server, driving the real kernel;
 * `handoffs.*` answers an honest 501 on this node, which is measured in
 * `test/integration/message.test.ts`, never asserted here.
 *
 * TWO FROZEN-CONTRACT CONFLICTS ARE PINNED HERE, deliberately, as tests:
 *
 *   `SendHandoffInputSchema` is `.strict()` and holds exactly
 *   `{clientMutationId, sourceEntityId}` — there is NO field for the
 *   `--expect-source-version <n>` the CLI syntax offers.
 *
 *   `WithdrawHandoffInputSchema` REQUIRES `expectedRecordVersion`, and no CLI
 *   syntax authority spells a flag for it.
 *
 * Both are reported for arbitration. Neither is normalised away here: the tests
 * assert what this CLI does about a gap it cannot close, so that closing it
 * upstream fails these tests loudly rather than silently.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { bindPath } from '@tm8/contract';

import { parseInvocation, splitCommandPath } from '../src/args.js';
import { loadLocalConfig, resolveContext, sessionContextFromEnv } from '../src/context.js';
import { errorLines, exitCodeFor } from '../src/errors.js';
import type { ExitCode } from '../src/exit.js';
import { createOutput } from '../src/output.js';
import type { CommandModule } from '../src/run.js';
import { isCommandPath } from '../src/discovery/operations.js';
import { HANDOFF_COMMANDS } from '../src/commands/handoff.js';

interface DispatchResult {
  code: ExitCode;
  stdout: string;
  stderr: string;
}

/** The real kernel, with only the coordinator-owned registry lookup swapped. */
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
    const registered = new Map(HANDOFF_COMMANDS.map((m) => [m.path.join(' '), m]));
    const match = splitCommandPath(invocation.positionals, (p) => registered.has(p.join(' ')));
    if (!match) throw new Error(`no handoff command matched: ${invocation.positionals.join(' ')}`);
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

interface Seen {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
}
type Reply = { status: number; json: unknown };

let server: Server;
let seen: Seen[] = [];
let reply: (s: Seen) => Reply = () => ({ status: 200, json: { data: {}, requestId: 'req_stub' } });

function envelope(data: unknown): Reply {
  return { status: 200, json: { data, requestId: 'req_stub' } };
}
function wireError(status: number, code: string, message: string): Reply {
  return { status, json: { error: { code, message, requestId: 'req_stub', retryable: false } } };
}

const SESSION = '018f0000-0000-7000-8000-000000000010';
const ENTITY = '018f0000-0000-7000-8000-000000000011';
const HANDOFF = '018f0000-0000-7000-8000-000000000012';

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

describe('the module registers exactly its own rows', () => {
  it('registers the three handoff paths', () => {
    expect(HANDOFF_COMMANDS.map((c) => c.path.join(' ')).sort()).toEqual([
      'handoff list',
      'handoff send',
      'handoff withdraw',
    ]);
  });

  it('every registered path is documented in the frozen discovery projection', () => {
    expect(HANDOFF_COMMANDS.length).toBeGreaterThan(0);
    for (const c of HANDOFF_COMMANDS) {
      expect(isCommandPath(c.path), `\`${c.path.join(' ')}\` is wired but absent from the projection`)
        .toBe(true);
    }
  });
});

describe('handoff send', () => {
  it('requires --entity', async () => {
    const r = await dispatch(['handoff', 'send', SESSION]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/--entity/);
    expect(seen).toHaveLength(0);
  });

  it('requires the work-session argument', async () => {
    const r = await dispatch(['handoff', 'send', '--entity', ENTITY]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/work-session/i);
    expect(seen).toHaveLength(0);
  });

  /**
   * `handoffId == clientMutationId` EXACTLY, by design. That makes the mutation
   * id a published correlation identifier — it is read back out of `HandoffView`
   * — and never a capability or a secret.
   */
  it('sends exactly the two frozen fields and binds the catalog path', async () => {
    reply = () => envelope({ handoffId: HANDOFF, sourceEntityId: ENTITY, targetWorkSessionId: SESSION });
    const r = await dispatch([
      'handoff', 'send', SESSION, '--entity', ENTITY, '--mutation-id', HANDOFF,
    ]);
    expect(r.code).toBe(0);
    expect(seen[0]?.method).toBe('POST');
    expect(seen[0]?.path).toBe(bindPath('handoffs.send', { workSessionId: SESSION }));
    expect(seen[0]?.body).toEqual({ clientMutationId: HANDOFF, sourceEntityId: ENTITY });
  });

  /**
   * CONFLICT 1. The syntax offers `--expect-source-version <n>`; the frozen
   * `SendHandoffInputSchema` is strict and has no field for it. Sending it is a
   * guaranteed `invalid_input`; DROPPING it silently would leave a caller
   * believing they hold a guard against a moved target that they do not hold.
   * So the CLI refuses locally and names the conflict.
   */
  it('refuses --expect-source-version rather than silently dropping a guard the caller asked for', async () => {
    const r = await dispatch([
      'handoff', 'send', SESSION, '--entity', ENTITY, '--expect-source-version', '3',
    ]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/--expect-source-version/);
    expect(r.stderr).toMatch(/SendHandoffInput/);
    expect(seen).toHaveLength(0);
  });

  it('keeps the handoff id in the human view', async () => {
    reply = () => envelope({ handoffId: HANDOFF, deliveryStatus: 'prepared', recordStatus: 'pending' });
    const r = await dispatch(['handoff', 'send', SESSION, '--entity', ENTITY, '--mutation-id', HANDOFF]);
    expect(r.stdout).toContain(HANDOFF);
  });

  it('maps this node’s honest 501 onto exit 8', async () => {
    reply = () => wireError(501, 'not_implemented', 'handoffs.send is not composed on this node');
    const r = await dispatch(['handoff', 'send', SESSION, '--entity', ENTITY]);
    expect(r.code).toBe(8);
    expect(r.stderr).toMatch(/not_implemented/);
  });
});

describe('handoff list', () => {
  it('binds the work session and carries --limit and --cursor', async () => {
    reply = () => envelope({ items: [], nextCursor: null });
    const r = await dispatch(['handoff', 'list', SESSION, '--limit', '7', '--cursor', 'c1']);
    expect(r.code).toBe(0);
    expect(seen[0]?.method).toBe('GET');
    expect(seen[0]?.path).toBe(bindPath('handoffs.list', { workSessionId: SESSION }));
    expect(seen[0]?.query.get('limit')).toBe('7');
    expect(seen[0]?.query.get('cursor')).toBe('c1');
  });

  it('refuses --mutation-id: a read is not a mutation', async () => {
    const r = await dispatch(['handoff', 'list', SESSION, '--mutation-id', 'x']);
    expect(r.code).toBe(2);
    expect(seen).toHaveLength(0);
  });

  it('keeps both status axes in the human view', async () => {
    reply = () => envelope({
      items: [{ handoffId: HANDOFF, deliveryStatus: 'delivered', recordStatus: 'recorded' }],
      nextCursor: null,
    });
    const r = await dispatch(['handoff', 'list', SESSION]);
    expect(r.stdout).toContain(HANDOFF);
    expect(r.stdout).toContain('delivered');
    expect(r.stdout).toContain('recorded');
  });
});

describe('handoff withdraw', () => {
  it('requires --yes', async () => {
    const r = await dispatch(['handoff', 'withdraw', HANDOFF]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/--yes/);
    expect(seen).toHaveLength(0);
  });

  it('binds the handoff id and carries an optional --reason text source', async () => {
    reply = () => envelope({ handoffId: HANDOFF, recordStatus: 'withdrawn', deliveryStatus: 'prepared' });
    const r = await dispatch([
      'handoff', 'withdraw', HANDOFF, '--yes', '--expect-record-version', '4',
      '--reason', 'superseded', '--mutation-id', 'm',
    ]);
    expect(r.code).toBe(0);
    expect(seen[0]?.method).toBe('POST');
    expect(seen[0]?.path).toBe(bindPath('handoffs.withdraw', { handoffId: HANDOFF }));
    expect(seen[0]?.body).toEqual({
      clientMutationId: 'm',
      expectedRecordVersion: 4,
      reason: 'superseded',
    });
  });

  /**
   * CONFLICT 2, RESOLVED BY RULING — and resolved the OPPOSITE way from conflict 1.
   *
   * `WithdrawHandoffInputSchema` is strict and requires
   * `expectedRecordVersion: z.number().int().positive()` — verified by reading
   * `packages/contract/src/schemas.ts` directly, not taken from a table. A
   * REQUIRED field is not optional to send: omit it and every call 400s, so the
   * operation is dead. The guard therefore exists and is frozen; the only thing
   * genuinely unspecified was the FLAG NAME, and the CLI flag surface is this
   * wave's own. It is derived mechanically by kebab-casing the frozen field and
   * dropping nothing: `expectedRecordVersion` → `--expect-record-version`.
   *
   * Required in the schema means required as a flag.
   */
  it('requires --expect-record-version, because the frozen input marks it required', async () => {
    const r = await dispatch(['handoff', 'withdraw', HANDOFF, '--yes']);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/--expect-record-version/);
    expect(seen).toHaveLength(0);
  });

  it('rejects a non-integer record version locally rather than on the wire', async () => {
    const r = await dispatch([
      'handoff', 'withdraw', HANDOFF, '--yes', '--expect-record-version', 'latest',
    ]);
    expect(r.code).toBe(2);
    expect(seen).toHaveLength(0);
  });
});
