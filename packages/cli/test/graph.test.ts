/**
 * `tm8 graph query` — the graph traversal row (W4 group 3).
 *
 * ONE command over `graph.query`, which is a `read` in the catalog that
 * happens to travel by POST because its query is a structured DTO. Two
 * consequences the tests below pin:
 *
 *  - it is a READ, so `--mutation-id` is refused. A caller who passes one
 *    believes their traversal is idempotently retryable in a way it is not;
 *  - `GraphQuery` extends the collection query shape and is `.strict()`, so
 *    `spaceId` is REQUIRED and an unlisted key is `invalid_input`. The command
 *    therefore sends exactly the fields its frozen syntax names, and nothing
 *    else — an empty `filters` object would be a key the caller never asked for.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
import { commandDiscovery, isCommandPath } from '../src/discovery/operations.js';
import { ledger } from '../src/discovery/availability.js';
import type { CommandModule } from '../src/run.js';

/** Imported lazily so a missing module fails each TEST, not only the FILE. */
async function graphCommands(): Promise<CommandModule[]> {
  return (await import('../src/commands/graph.js')).GRAPH_COMMANDS;
}

interface Seen {
  method: string;
  pathname: string;
  query: string;
  body: unknown;
}

let server: Server;
let baseUrl: string;
let seen: Seen[] = [];
let reply: { status: number; body: unknown } = { status: 200, body: { data: {}, requestId: 'req_t' } };
let scratchHome: string;

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://x');
      const raw = Buffer.concat(chunks).toString('utf8');
      seen.push({
        method: req.method ?? '',
        pathname: url.pathname,
        query: url.search,
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
  if (scratchHome) rmSync(scratchHome, { recursive: true, force: true });
});

const SPACE = '11111111-1111-7111-8111-111111111111';
const FOCUS = '55555555-5555-7555-8555-555555555555';

beforeEach(() => {
  seen = [];
  reply = { status: 200, body: { data: { nodes: [], edges: [], clusters: [] }, requestId: 'req_t' } };
  ledger.clear();
  scratchHome ??= mkdtempSync(join(tmpdir(), 'tm8-w4-g3-graph-'));
  process.env.TM8_BASE_URL = baseUrl;
  process.env.TM8_SPACE_ID = SPACE;
  process.env.XDG_CONFIG_HOME = scratchHome;
  delete process.env.TM8_CONFIG_PATH;
  delete process.env.TM8_ACTOR_ID;
});

afterEach(() => {
  delete process.env.TM8_SPACE_ID;
  delete process.env.TM8_BASE_URL;
});

interface Ran {
  code: number;
  stdout: string;
  stderr: string;
}

async function drive(argv: readonly string[]): Promise<Ran> {
  const modules = await graphCommands();
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
    /* c8 ignore next */
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

describe('registration', () => {
  it('registers exactly `graph query`', async () => {
    const paths = (await graphCommands()).map((m) => m.path.join(' '));
    expect(paths).toEqual(['graph query']);
  });

  it('the registered path is in the frozen grammar projection', async () => {
    for (const m of await graphCommands()) expect(isCommandPath(m.path)).toBe(true);
  });
});

describe('graph query', () => {
  it('binds graph.query through bindPath, by POST', async () => {
    const r = await drive(['graph', 'query']);
    expect({ code: r.code, stderr: r.stderr }).toEqual({ code: 0, stderr: '' });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.method).toBe('POST');
    expect(seen[0]?.pathname).toBe(bindPath('graph.query', {}));
  });

  it('sends only the resolved spaceId when nothing else is asked for', async () => {
    await drive(['graph', 'query']);
    expect(seen[0]?.body).toEqual({ spaceId: SPACE });
  });

  it('folds the frozen flags into the strict GraphQuery shape', async () => {
    await drive([
      'graph', 'query',
      '--focus', FOCUS,
      '--hops', '2',
      '--edge-type', 'depends_on',
      '--edge-type', 'attached_to',
      '--mode', 'dependency',
      '--limit', '25',
      '--cursor', 'c1',
    ]);
    expect(seen[0]?.body).toEqual({
      spaceId: SPACE,
      focusId: FOCUS,
      hops: 2,
      edgeTypes: ['depends_on', 'attached_to'],
      mode: 'dependency',
      limit: 25,
      cursor: 'c1',
    });
  });

  it('refuses --mode outside free|dependency locally', async () => {
    const r = await drive(['graph', 'query', '--mode', 'sideways']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('free');
    expect(seen).toHaveLength(0);
  });

  it('refuses a non-integer --hops locally', async () => {
    expect((await drive(['graph', 'query', '--focus', FOCUS, '--hops', 'many'])).code).toBe(2);
    expect(seen).toHaveLength(0);
  });

  it('is a READ and refuses --mutation-id', async () => {
    const r = await drive(['graph', 'query', '--mutation-id', '018f0000-0000-7000-8000-000000000000']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('--mutation-id applies only to mutations');
    expect(seen).toHaveLength(0);
  });

  it('fails locally with no Space in context', async () => {
    delete process.env.TM8_SPACE_ID;
    const r = await drive(['graph', 'query']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('no Space in context');
    expect(seen).toHaveLength(0);
  });

  it('an option outside the frozen syntax is a usage error quoting that syntax', async () => {
    const r = await drive(['graph', 'query', '--depth', '2']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('--depth');
    expect(r.stderr).toContain(commandDiscovery(['graph', 'query'])?.syntax ?? '<<no syntax>>');
    expect(seen).toHaveLength(0);
  });
});

describe('output law', () => {
  it('--format json emits the GraphResult DTO verbatim', async () => {
    reply = {
      status: 200,
      body: { data: { nodes: [{ id: FOCUS }], edges: [], clusters: [] }, requestId: 'req_t' },
    };
    const r = await drive(['graph', 'query', '--format', 'json']);
    expect(JSON.parse(r.stdout)).toEqual({ nodes: [{ id: FOCUS }], edges: [], clusters: [] });
    expect(r.stderr).toBe('');
  });

  it('human output keeps the node ids a follow-up command needs', async () => {
    reply = {
      status: 200,
      body: {
        data: { nodes: [{ id: FOCUS, kind: 'task', title: 'Ship' }], edges: [], clusters: [] },
        requestId: 'req_t',
      },
    };
    const r = await drive(['graph', 'query']);
    expect(r.stdout).toContain(FOCUS);
  });

  it('an honest 501 exits 8 and says so', async () => {
    reply = {
      status: 501,
      body: { error: { code: 'not_implemented', message: 'nope', requestId: 'req_t', retryable: false } },
    };
    const r = await drive(['graph', 'query']);
    expect(r.code).toBe(8);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('not implemented on this node');
  });
});
