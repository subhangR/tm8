/**
 * `tm8 identity get` — the row that replaced the prototype's `whoami`.
 *
 * One catalog row, and three properties that are easy to get wrong:
 *   it is a READ, so it refuses `--mutation-id`;
 *   it is authorized against the SERVER, not a Space, so it must work with no
 *     Space in context at all — an `identity get` that demanded `--space` would
 *     be unusable in exactly the situation a caller reaches for it, namely "I do
 *     not know where I am";
 *   its human view must keep the ids a follow-up needs (`--as` takes a member
 *     id, and the memberships are where those ids come from).
 *
 * `run.ts` already turns a typed `whoami` into a RetiredCommandError pointing
 * here; that is the router's test, not this file's.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bindPath } from '@tm8/contract';
import { parseInvocation, splitCommandPath } from '../src/args.js';
import { loadLocalConfig, resolveContext, sessionContextFromEnv } from '../src/context.js';
import { errorLines, exitCodeFor } from '../src/errors.js';
import { CliError, EXIT_USAGE } from '../src/exit.js';
import { createOutput } from '../src/output.js';
import { isCommandPath } from '../src/discovery/operations.js';
import { ledger, resolveAvailability } from '../src/discovery/availability.js';
import type { CommandModule } from '../src/run.js';

async function identityCommands(): Promise<CommandModule[]> {
  return (await import('../src/commands/identity.js')).IDENTITY_COMMANDS;
}

interface Seen {
  method: string;
  pathname: string;
  body: unknown;
}

let server: Server;
let baseUrl: string;
let seen: Seen[] = [];
let reply: { status: number; body: unknown } = { status: 200, body: { data: {}, requestId: 'r' } };
let scratchHome: string;

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      seen.push({
        method: req.method ?? '',
        pathname: new URL(req.url ?? '/', 'http://x').pathname,
        body: raw ? (JSON.parse(raw) as unknown) : undefined,
      });
      res.setHeader('content-type', 'application/json');
      res.statusCode = reply.status;
      res.end(JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('no address');
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  rmSync(scratchHome, { recursive: true, force: true });
});

beforeEach(() => {
  seen = [];
  reply = { status: 200, body: { data: {}, requestId: 'r' } };
  ledger.clear();
  scratchHome ??= mkdtempSync(join(tmpdir(), 'tm8-w4-g2-id-'));
  process.env.TM8_BASE_URL = baseUrl;
  process.env.XDG_CONFIG_HOME = scratchHome;
  delete process.env.TM8_SPACE_ID;
  delete process.env.TM8_CONFIG_PATH;
  delete process.env.TM8_ACTOR_ID;
});

interface Ran {
  code: number;
  stdout: string;
  stderr: string;
}

async function drive(argv: readonly string[]): Promise<Ran> {
  const modules = await identityCommands();
  let stdout = '';
  let stderr = '';
  const streams = {
    stdout: (c: string | Uint8Array) => {
      stdout += typeof c === 'string' ? c : Buffer.from(c).toString('utf8');
    },
    stderr: (c: string) => {
      stderr += c;
    },
  };
  let out = createOutput({ format: 'human', streams });
  try {
    const inv = parseInvocation(argv);
    out = createOutput({
      format: inv.globals.format,
      color: inv.globals.color,
      quiet: inv.globals.quiet,
      streams,
    });
    const known = new Set(modules.map((m) => m.path.join(' ')));
    const match = splitCommandPath(inv.positionals, (p) => known.has(p.join(' ')));
    if (!match) throw new CliError(`unknown command: ${inv.positionals.join(' ')}`, EXIT_USAGE);
    const mod = modules.find((m) => m.path.join(' ') === match.path.join(' '));
    if (!mod) throw new CliError('no module', EXIT_USAGE);
    const ctx = resolveContext({
      globals: inv.globals,
      session: sessionContextFromEnv(),
      config: loadLocalConfig(),
    });
    const code = await mod.run({
      path: match.path,
      args: match.args,
      options: inv.options,
      passthrough: inv.passthrough,
      ctx,
      out,
    });
    return { code, stdout, stderr };
  } catch (err) {
    out.error(errorLines(err));
    return { code: exitCodeFor(err), stdout, stderr };
  }
}

const IDENTITY = {
  identityId: '77777777-7777-7777-8777-777777777777',
  accountId: '88888888-8888-7888-8888-888888888888',
  username: 'owner',
  displayName: 'Local Owner',
  avatar: null,
  email: null,
  isNodeAdmin: true,
  isOwner: true,
  status: 'active',
  actingAs: null,
  memberships: [
    {
      spaceId: '11111111-1111-7111-8111-111111111111',
      memberId: '99999999-9999-7999-8999-999999999999',
      role: 'owner',
    },
  ],
};

describe('the registered command set', () => {
  it('registers exactly `identity get`, and the projection documents it', async () => {
    const paths = (await identityCommands()).map((c) => c.path.join(' '));
    expect(paths).toEqual(['identity get']);
    expect(isCommandPath(['identity', 'get'])).toBe(true);
  });
});

describe('tm8 identity get', () => {
  it('binds `identity.get` from the catalog — GET /v2/identity, no body', async () => {
    reply = { status: 200, body: { data: IDENTITY, requestId: 'r' } };
    const r = await drive(['identity', 'get', '--format', 'json']);
    expect(r.code, r.stderr).toBe(0);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.method).toBe('GET');
    expect(seen[0]?.pathname).toBe(bindPath('identity.get'));
    expect(seen[0]?.body).toBeUndefined();
  });

  it('works with NO Space in context — it is authorized against the server', async () => {
    reply = { status: 200, body: { data: IDENTITY, requestId: 'r' } };
    expect(process.env.TM8_SPACE_ID).toBeUndefined();
    const r = await drive(['identity', 'get']);
    expect(r.code, r.stderr).toBe(0);
  });

  it('is a READ: --mutation-id is refused before the network', async () => {
    const r = await drive(['identity', 'get', '--mutation-id', 'x']);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/--mutation-id applies only to mutations/);
    expect(seen).toHaveLength(0);
  });

  it('--format json emits the exact DTO, no CLI envelope', async () => {
    reply = { status: 200, body: { data: IDENTITY, requestId: 'r' } };
    const r = await drive(['identity', 'get', '--format', 'json']);
    expect(JSON.parse(r.stdout)).toEqual(IDENTITY);
  });

  it('human output keeps the member ids `--as` needs', async () => {
    reply = { status: 200, body: { data: IDENTITY, requestId: 'r' } };
    const r = await drive(['identity', 'get']);
    expect(r.stdout).toContain('owner');
    expect(r.stdout).toContain(IDENTITY.identityId);
    expect(r.stdout).toContain(IDENTITY.memberships[0]!.memberId);
    expect(r.stdout).toContain(IDENTITY.memberships[0]!.spaceId);
    expect(r.stderr).toBe('');
  });

  it('does not describe an identity or a mutation id as a secret', async () => {
    // `clientMutationId` is a CORRELATION IDENTIFIER and is PUBLISHED in read
    // DTOs by design. No CLI text may call it secret, and no authorization may
    // be described as depending on its secrecy.
    reply = { status: 200, body: { data: IDENTITY, requestId: 'r' } };
    const r = await drive(['identity', 'get']);
    expect(`${r.stdout}${r.stderr}`).not.toMatch(/secret|private key|token/i);
  });

  it('an unauthenticated answer is exit 3 with nothing on stdout', async () => {
    reply = {
      status: 401,
      body: { error: { code: 'unauthenticated', message: 'who?', requestId: 'r', retryable: false } },
    };
    const r = await drive(['identity', 'get']);
    expect(r.code).toBe(3);
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(/unauthenticated/);
  });

  it('teaches the availability ledger from the call the caller already made', async () => {
    reply = { status: 200, body: { data: IDENTITY, requestId: 'r' } };
    await drive(['identity', 'get']);
    expect(resolveAvailability('identity.get', 'v1')).toEqual({
      availability: 'available',
      availabilityReason: 'observed_ok',
      availabilitySource: 'observed',
    });
  });

  it('an honest 501 is exit 8 and records unavailable, not a transport failure', async () => {
    reply = {
      status: 501,
      body: {
        error: {
          code: 'not_implemented',
          message: 'operation identity.get is not implemented on this node',
          requestId: 'r',
          retryable: false,
        },
      },
    };
    const r = await drive(['identity', 'get']);
    expect(r.code).toBe(8);
    expect(resolveAvailability('identity.get', 'v1').availability).toBe('unavailable');
  });
});
