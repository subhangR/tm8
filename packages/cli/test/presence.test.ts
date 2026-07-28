/**
 * `tm8 presence get` — group 8's third row, and the slot's clearest honesty
 * surface.
 *
 * `presence.get` is CONDITIONALLY MOUNTED: a node with a presence source answers
 * a real `PresenceSnapshot`, a node without one answers an honest
 * `501 not_implemented`. BOTH are CORRECT, EXPECTED, and NOT A DEFECT — never a
 * bug to file against another wave, and never something the CLI may hide.
 *
 * SO THIS FILE ASSERTS THE MAPPING, NOT THE BRANCH. Every test below drives the
 * stub Server to a chosen answer and checks what the command does with it; not
 * one of them claims to know which answer THIS node gives. That is deliberate:
 * a unit test that pinned the branch would go red when a node gained a presence
 * source, which is another wave's legitimate progress rather than this slot's
 * defect. Which branch this node is actually on is measured — once, against a
 * real Server — in `test/integration/event.test.ts`, where it can be re-measured
 * rather than remembered.
 *
 * Faithful render, zero retention: the Server's own words go to stderr verbatim
 * (a client that sanitises a server-side disclosure hides it from the gate that
 * has to see it), and nothing is cached, persisted, or re-displayed afterwards.
 *
 * On `drive()`: see the same note in `event.test.ts`. `src/run.ts` and
 * `src/commands/registry.ts` are coordinator-owned, so this file reproduces
 * `run()`'s funnel with only the registry lookup substituted, and duplicates
 * those twelve lines rather than adding a shared helper file outside this
 * slot's assigned set.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bindPath } from '@tm8/contract';
import { parseInvocation, splitCommandPath } from '../src/args.js';
import { loadLocalConfig, resolveContext, sessionContextFromEnv } from '../src/context.js';
import { errorLines, exitCodeFor } from '../src/errors.js';
import { CliError, EXIT_USAGE } from '../src/exit.js';
import { createOutput } from '../src/output.js';
import { ledger, resolveAvailability } from '../src/discovery/availability.js';
import { commandDiscovery, discoveryFor, isCommandPath } from '../src/discovery/operations.js';
import type { CommandModule } from '../src/run.js';

/** Imported lazily so a missing module fails each TEST, not only the FILE. */
async function presenceCommands(): Promise<CommandModule[]> {
  return (await import('../src/commands/presence.js')).PRESENCE_COMMANDS;
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

const SPACE = '55555555-5555-7555-8555-555555555555';
const ENTITY = '77777777-7777-7777-8777-777777777777';
const VIEWER = '88888888-8888-7888-8888-888888888888';

beforeEach(() => {
  seen = [];
  reply = { status: 200, body: { data: { viewers: [], typingActorIds: [], updatedAt: 'now' }, requestId: 'r' } };
  ledger.clear();
  scratchHome ??= mkdtempSync(join(tmpdir(), 'tm8-w4-g8-presence-home-'));
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
  const modules = await presenceCommands();
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

const HONEST_501 = {
  status: 501,
  body: {
    error: {
      code: 'not_implemented',
      message: 'operation presence.get is not implemented on this node',
      requestId: 'r501',
      retryable: false,
    },
  },
};

describe('the module is the projection, not a second answer', () => {
  it('registers exactly the one command path the projection names', async () => {
    const modules = await presenceCommands();
    expect(modules.map((m) => m.path.join(' '))).toEqual(['presence get']);
    expect(modules.length).toBe(1);
    for (const m of modules) expect(isCommandPath(m.path)).toBe(true);
  });

  it('binds the operation the projection binds', () => {
    expect(discoveryFor('presence.get').command).toEqual(['presence', 'get']);
    expect(commandDiscovery(['presence', 'get'])?.operations).toEqual(['presence.get']);
  });
});

describe('tm8 presence get — the request it makes', () => {
  it('GETs exactly the path bindPath produces — no hand-written URL', async () => {
    const r = await drive(['presence', 'get', ENTITY]);
    expect(r.code).toBe(0);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.method).toBe('GET');
    expect(seen[0]?.pathname).toBe(bindPath('presence.get', { id: ENTITY }));
  });

  it('carries no request body and no query — the row takes neither', async () => {
    await drive(['presence', 'get', ENTITY]);
    expect(seen[0]?.body).toBeUndefined();
    expect(seen[0]?.query).toBe('');
  });

  it('requires the entity id, locally, before any network', async () => {
    const r = await drive(['presence', 'get']);
    expect(r.code).toBe(EXIT_USAGE);
    expect(seen).toHaveLength(0);
    expect(r.stderr).toMatch(/entity-id/);
  });

  it('is a read: --mutation-id is refused', async () => {
    const r = await drive(['presence', 'get', ENTITY, '--mutation-id', 'x']);
    expect(r.code).toBe(EXIT_USAGE);
    expect(seen).toHaveLength(0);
    expect(r.stderr).toMatch(/mutation/i);
  });
});

describe('tm8 presence get — output law', () => {
  const SNAPSHOT = {
    viewers: [{ id: VIEWER, kind: 'member', displayName: 'Ada' }],
    typingActorIds: [VIEWER],
    updatedAt: '2026-01-01T00:00:00Z',
  };

  it('--format json emits the contract PresenceSnapshot verbatim', async () => {
    reply = { status: 200, body: { data: SNAPSHOT, requestId: 'r' } };
    const r = await drive(['presence', 'get', ENTITY, '--format', 'json']);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual(SNAPSHOT);
  });

  it('human renders the SAME DTO and keeps the actor ids a follow-up needs', async () => {
    reply = { status: 200, body: { data: SNAPSHOT, requestId: 'r' } };
    const r = await drive(['presence', 'get', ENTITY]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(VIEWER);
    expect(r.stdout).toContain('Ada');
    expect(r.stdout).toMatch(/typing/i);
  });

  it('an empty snapshot says so rather than printing nothing', async () => {
    reply = {
      status: 200,
      body: { data: { viewers: [], typingActorIds: [], updatedAt: '2026-01-01T00:00:00Z' }, requestId: 'r' },
    };
    const r = await drive(['presence', 'get', ENTITY]);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).not.toBe('');
    expect(r.stdout).toMatch(/no one|nobody|0 viewers/i);
  });
});

describe('presence.get is a G10 residual — the honest 501 is the expected answer', () => {
  it('reports the refusal verbatim, exits 8, and puts nothing on stdout', async () => {
    reply = HONEST_501;
    const r = await drive(['presence', 'get', ENTITY]);
    expect(r.code).toBe(8);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('operation presence.get is not implemented on this node');
  });

  it('derives availability `unavailable` from the observation, per M-3', async () => {
    reply = HONEST_501;
    await drive(['presence', 'get', ENTITY]);
    expect(resolveAvailability('presence.get', 'v1')).toEqual({
      availability: 'unavailable',
      availabilityReason: 'not_implemented_on_node',
      availabilitySource: 'observed',
    });
    expect(discoveryFor('presence.get').availability).toBe('unavailable');
  });

  it('defaults to unknown, never optimistically available, before observing', () => {
    expect(discoveryFor('presence.get').availability).toBe('unknown');
  });

  it('a 200 records available — the positive control for the probe above', async () => {
    const r = await drive(['presence', 'get', ENTITY]);
    expect(r.code).toBe(0);
    expect(resolveAvailability('presence.get', 'v1').availability).toBe('available');
  });

  it('does not retry, and reserves no mutation id — a 501 is PRE-VALIDATION', async () => {
    reply = HONEST_501;
    await drive(['presence', 'get', ENTITY]);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.body).toBeUndefined();
  });

  it('retains nothing: neither the refusal nor the snapshot is written to disk', async () => {
    const before = readdirSync(scratchHome).sort();

    reply = HONEST_501;
    await drive(['presence', 'get', ENTITY]);
    reply = { status: 200, body: { data: SNAPSHOT_FIXTURE, requestId: 'r' } };
    await drive(['presence', 'get', ENTITY]);
    expect(readdirSync(scratchHome).sort()).toEqual(before);

    // PROBE-RED for the retention check: an assertion that "nothing was
    // written" is worthless unless it can SEE a write. Prove it can.
    const canary = join(scratchHome, 'canary');
    writeFileSync(canary, 'x');
    expect(readdirSync(scratchHome).sort()).not.toEqual(before);
    rmSync(canary, { force: true });
  });
});

const SNAPSHOT_FIXTURE = {
  viewers: [{ id: VIEWER, kind: 'member', displayName: 'Ada' }],
  typingActorIds: [],
  updatedAt: '2026-01-01T00:00:00Z',
};
